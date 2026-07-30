// ============ 試合部屋 (サーバ権威シミュレーション) ============
//
// 1部屋 = 1試合。60Hz で物理を回し、20Hz でスナップショットを配る。
// クライアントの入力は「最後に届いたものを毎tick使う」方式。
// 取りこぼしても次のパケットで上書きされるだけなので、UDP 的に軽く扱える。

import { DT, SNAP_EVERY, PLAYER, MATCH } from "../shared/constants.js";
import {
  createPlayer, createBall, emptyInput, stepPlayer, stepBall,
  collidePlayerBall, collidePlayers, canKick, applyKick, kickoffSpot,
} from "../shared/physics.js";
import { encodeSnapshot } from "../shared/protocol.js";
import { botInput, newBrain } from "./bots.js";

export const PHASE = { WAIT: 0, KICKOFF: 1, PLAY: 2, GOAL: 3, RESULT: 4 };

export class Room {
  constructor(id, store) {
    this.id = id;
    this.store = store;
    this.ents = [];              // プレイヤー(人間+BOT)の実体
    this.ball = createBall();
    this.tick = 0;
    this.phase = PHASE.WAIT;
    this.timer = 0;
    this.clock = MATCH.duration;
    this.score = [0, 0];
    this.nextId = 1;
    this.idle = true;            // 人間がいない間は物理を止める (無料プランのCPU節約)
    this.hudAcc = 0;
    this.lastGoal = null;
    this.stall = { x: 0, y: 0, t: 0 };   // ボールが動かなくなったときの仕切り直し用
    this.resetPositions();
  }

  // ------------------------------------------------------------ 出入り

  get humans() { return this.ents.filter((e) => !e.bot); }
  get open() { return this.humans.length < MATCH.perTeam * 2; }

  allocId() {
    for (let i = 0; i < 255; i++) {
      const id = ((this.nextId + i - 1) % 255) + 1;
      if (!this.ents.some((e) => e.id === id)) { this.nextId = id + 1; return id; }
    }
    return 0;
  }

  join(conn, name) {
    const humans = this.humans;
    const c0 = humans.filter((e) => e.team === 0).length;
    const c1 = humans.filter((e) => e.team === 1).length;
    const team = c0 <= c1 ? 0 : 1;

    // まずBOTを1体どかして席を空ける
    const bot = this.ents.find((e) => e.bot && e.team === team);
    if (bot) this.remove(bot.id);

    const ent = this.spawn(team, false);
    ent.conn = conn;
    ent.name = String(name || "ぷれいやー").slice(0, 10) || "ぷれいやー";
    ent.pid = conn.pid || null;
    this.balance();
    this.idle = false;
    this.pushRoster();
    return ent;
  }

  spawn(team, bot) {
    const ent = createPlayer(this.allocId(), team);
    ent.bot = bot;
    ent.conn = null;
    ent.name = bot ? "BOT" : "?";
    ent.input = emptyInput();
    ent.lastSeq = 0;
    ent.goals = 0;
    ent.brain = bot ? newBrain() : null;
    this.ents.push(ent);
    this.placeOne(ent);
    return ent;
  }

  remove(id) {
    const i = this.ents.findIndex((e) => e.id === id);
    if (i >= 0) this.ents.splice(i, 1);
  }

  leave(ent) {
    this.remove(ent.id);
    this.balance();
    if (this.humans.length === 0) {
      this.idle = true;
      this.phase = PHASE.WAIT;
    }
    this.pushRoster();
  }

  /** 各チームを perTeam 人に揃える (足りなければ BOT、多すぎれば BOT を外す) */
  balance() {
    for (const team of [0, 1]) {
      const list = this.ents.filter((e) => e.team === team);
      let n = list.length;
      while (n < MATCH.perTeam) { this.spawn(team, true); n++; }
      while (n > MATCH.perTeam) {
        const b = this.ents.filter((e) => e.team === team && e.bot).pop();
        if (!b) break;
        this.remove(b.id); n--;
      }
    }
  }

  // ------------------------------------------------------------ 配置

  resetPositions(attackingTeam = -1) {
    this.ball.x = 0; this.ball.y = 0;
    this.ball.vx = 0; this.ball.vy = 0;
    this.ball.spin = 0;
    this.ball.lastTouch = -1; this.ball.lastTouchTeam = -1;
    this.attacking = attackingTeam;
    this.stall.x = 0; this.stall.y = 0; this.stall.t = 0;
    for (const t of [0, 1]) {
      this.ents.filter((e) => e.team === t).forEach((e, i) => this.placeOne(e, i));
    }
  }

  placeOne(ent, index = null) {
    const list = this.ents.filter((e) => e.team === ent.team);
    const i = index ?? Math.max(0, list.indexOf(ent));
    const s = kickoffSpot(ent.team, i, this.attacking === ent.team);
    ent.x = s.x; ent.y = s.y;
    ent.vx = 0; ent.vy = 0;
    ent.charge = 0; ent.charging = false;
    ent.dash = 0; ent.stun = 0; ent.stam = PLAYER.stamMax;
  }

  // ------------------------------------------------------------ 入力

  applyInput(ent, msg) {
    // seq は u16 でラップするので、進んだぶんだけ受け付ける
    const diff = (msg.seq - ent.lastSeq) & 0xffff;
    if (diff === 0 || diff > 32768) return;     // 古い/重複パケットは捨てる
    ent.lastSeq = msg.seq;
    ent.input.mx = msg.mx;
    ent.input.my = msg.my;
    ent.input.btn = msg.btn;
  }

  // ------------------------------------------------------------ ループ

  step(dt) {
    if (this.idle) return;
    this.tick = (this.tick + 1) & 0xffff;

    // --- フェーズ進行 ---
    this.timer -= dt;
    switch (this.phase) {
      case PHASE.WAIT:
        this.startMatch();
        break;
      case PHASE.KICKOFF:
        if (this.timer <= 0) { this.phase = PHASE.PLAY; this.event({ e: "whistle" }); }
        break;
      case PHASE.PLAY:
        this.clock -= dt;
        if (this.clock <= 0) { this.clock = 0; this.endMatch(); }
        break;
      case PHASE.GOAL:
        if (this.timer <= 0) {
          this.resetPositions(this.lastGoal ? 1 - this.lastGoal.team : -1);
          this.phase = PHASE.KICKOFF;
          this.timer = MATCH.kickoffFreeze;
        }
        break;
      case PHASE.RESULT:
        if (this.timer <= 0) this.startMatch();
        break;
    }

    const live = this.phase === PHASE.PLAY;
    const frozen = this.phase === PHASE.KICKOFF || this.phase === PHASE.RESULT;

    // --- プレイヤー ---
    for (const e of this.ents) {
      if (e.bot) e.input = botInput(this, e, dt);
      const input = frozen ? emptyInput() : e.input;
      const released = stepPlayer(e, input, dt);
      e.chargeRatio = e.charging ? e.charge / PLAYER.kickCharge : 0;
      if (released >= 0 && live && e.kickCd <= 0 && canKick(e, this.ball)) {
        const v = applyKick(e, this.ball, released);
        this.event({ e: "kick", id: e.id, p: Math.round(released * 100), v: Math.round(v) });
      }
    }

    // --- 当たり判定 ---
    for (let i = 0; i < this.ents.length; i++) {
      for (let j = i + 1; j < this.ents.length; j++) {
        const hit = collidePlayers(this.ents[i], this.ents[j]);
        if (hit && live) this.event({ e: "tackle", ...hit });
      }
    }
    if (live || this.phase === PHASE.KICKOFF) {
      for (const e of this.ents) collidePlayerBall(e, this.ball);
    }

    // --- ボール ---
    if (live) {
      const scored = stepBall(this.ball, dt);
      if (scored >= 0) this.onGoal(scored);
      else this.checkStall(dt);
    } else if (this.phase === PHASE.GOAL) {
      this.ball.vx *= 0.9; this.ball.vy *= 0.9;
      this.ball.x += this.ball.vx * dt; this.ball.y += this.ball.vy * dt;
    }

    // --- 配信 ---
    if (this.tick % SNAP_EVERY === 0) this.sendSnapshots();
    this.hudAcc += dt;
    if (this.hudAcc >= 0.25) { this.hudAcc = 0; this.pushHud(); }
  }

  /**
   * すみっこで団子になってボールが動かなくなることがある (人でもBOTでも起きる)。
   * 一定時間ボールがほとんど動かなければ、審判よろしくキックオフからやり直す。
   */
  checkStall(dt) {
    const moved = Math.hypot(this.ball.x - this.stall.x, this.ball.y - this.stall.y);
    if (moved > 70) {
      this.stall.x = this.ball.x; this.stall.y = this.ball.y; this.stall.t = 0;
      return;
    }
    this.stall.t += dt;
    if (this.stall.t < 6) return;
    const next = this.ball.lastTouchTeam >= 0 ? 1 - this.ball.lastTouchTeam : 0;
    this.resetPositions(next);
    this.phase = PHASE.KICKOFF;
    this.timer = MATCH.kickoffFreeze;
    this.event({ e: "stall" });
  }

  // ------------------------------------------------------------ 得点 / 試合

  onGoal(team) {
    const scorerId = this.ball.lastTouch;
    const scorer = this.ents.find((e) => e.id === scorerId);
    const own = !!scorer && scorer.team !== team;
    this.score[team]++;
    if (scorer && !own) scorer.goals++;
    this.lastGoal = { team, by: scorer ? scorer.name : null, own };
    this.phase = PHASE.GOAL;
    this.timer = MATCH.goalCelebrate;
    this.ball.vx *= 0.35; this.ball.vy *= 0.35;
    this.event({ e: "goal", team, by: this.lastGoal.by, own, score: this.score });
    this.pushHud();
  }

  startMatch() {
    this.score = [0, 0];
    this.clock = MATCH.duration;
    this.lastGoal = null;
    for (const e of this.ents) e.goals = 0;
    this.balance();
    this.resetPositions(Math.random() < 0.5 ? 0 : 1);
    this.phase = PHASE.KICKOFF;
    this.timer = MATCH.kickoffFreeze;
    this.event({ e: "start" });
    this.pushRoster();
  }

  endMatch() {
    this.phase = PHASE.RESULT;
    this.timer = MATCH.resultTime;
    const [a, b] = this.score;
    const winner = a === b ? -1 : (a > b ? 0 : 1);
    this.event({
      e: "end", score: this.score, winner,
      top: this.ents.filter((x) => x.goals > 0)
        .sort((x, y) => y.goals - x.goals)
        .slice(0, 5).map((x) => ({ name: x.name, goals: x.goals, bot: x.bot })),
    });
    // 戦績を保存 (Supabase 未設定ならメモリ上のランキングに積まれるだけ)
    for (const e of this.humans) {
      if (!e.pid) continue;
      this.store.record({
        pid: e.pid, name: e.name, goals: e.goals,
        result: winner === -1 ? "draw" : (winner === e.team ? "win" : "loss"),
      }).catch(() => {});
    }
  }

  // ------------------------------------------------------------ 送信

  sendSnapshots() {
    for (const e of this.ents) {
      if (!e.conn || e.conn.readyState !== 1) continue;
      const buf = encodeSnapshot(this.tick, e.lastSeq, this.phase, this.ball, this.ents);
      try { e.conn.send(buf); } catch { /* 切断直後 */ }
    }
  }

  sendJson(obj) {
    const s = JSON.stringify(obj);
    for (const e of this.ents) {
      if (!e.conn || e.conn.readyState !== 1) continue;
      try { e.conn.send(s); } catch { /* 切断直後 */ }
    }
  }

  event(ev) { this.sendJson({ t: "ev", ...ev }); }

  pushHud() {
    this.sendJson({
      t: "hud",
      phase: this.phase,
      clock: Math.max(0, Math.ceil(this.clock)),
      score: this.score,
      timer: Math.max(0, this.timer),
    });
  }

  pushRoster() {
    this.sendJson({
      t: "roster",
      room: this.id,
      players: this.ents.map((e) => ({
        id: e.id, name: e.name, team: e.team, bot: !!e.bot, goals: e.goals,
      })),
    });
  }

  info() {
    return {
      id: this.id,
      humans: this.humans.length,
      cap: MATCH.perTeam * 2,
      phase: this.phase,
      score: this.score,
      clock: Math.max(0, Math.ceil(this.clock)),
    };
  }
}

/** 部屋の管理 (クイックマッチ + 合言葉での待ち合わせ) */
export class Rooms {
  constructor(store, max = 40) {
    this.store = store;
    this.max = max;
    this.map = new Map();
    this.last = Date.now();
  }

  get(id) {
    let r = this.map.get(id);
    if (!r) {
      if (this.map.size >= this.max) return null;
      r = new Room(id, this.store);
      this.map.set(id, r);
    }
    return r;
  }

  /** 空きのある部屋を探す。無ければ新しく作る */
  quick() {
    for (const r of this.map.values()) {
      if (r.open && r.humans.length > 0) return r;
    }
    for (const r of this.map.values()) if (r.open) return r;
    return this.get(code());
  }

  step(dt) {
    for (const r of this.map.values()) r.step(dt);
    // 誰もいない部屋は片付ける (合言葉部屋が増え続けないように)
    if (this.map.size > 4) {
      for (const [id, r] of this.map) {
        if (r.humans.length === 0 && this.map.size > 4) this.map.delete(id);
      }
    }
  }

  list() {
    return [...this.map.values()].filter((r) => r.humans.length > 0).map((r) => r.info());
  }
}

const ALPHA = "abcdefghjkmnpqrstuvwxyz23456789";
function code(n = 4) {
  let s = "";
  for (let i = 0; i < n; i++) s += ALPHA[(Math.random() * ALPHA.length) | 0];
  return s;
}
