// ============ テスト (node test/sim.test.js) ============
// 外部ライブラリなし。node:assert と node:test だけで回す。

import test from "node:test";
import assert from "node:assert/strict";

import { DT, FIELD, GOAL, PLAYER, BALL, BTN, MATCH, CORNER_R } from "../shared/constants.js";
import {
  createPlayer, createBall, emptyInput, stepPlayer, stepBall,
  collidePlayerBall, collidePlayers, canKick, applyKick,
} from "../shared/physics.js";
import { encodeInput, decodeInput, encodeSnapshot, decodeSnapshot } from "../shared/protocol.js";
import { Room, Rooms, PHASE } from "../server/room.js";

const HW = FIELD.w / 2;
const finite = (o, keys) => keys.every((k) => Number.isFinite(o[k]));

// ---------------------------------------------------------------- 物理

test("プレイヤーは終端速度で頭打ちになる", () => {
  const p = createPlayer(1, 0);
  p.x = -HW + PLAYER.r;                       // 壁にぶつかる前に測りたいので左端から
  const inp = { mx: 1, my: 0, btn: 0 };
  for (let i = 0; i < 60; i++) stepPlayer(p, inp, DT);
  const v = Math.hypot(p.vx, p.vy);
  assert.ok(v <= PLAYER.maxSpeed + 0.5, `速度 ${v} が上限 ${PLAYER.maxSpeed} を超えた`);
  assert.ok(v > PLAYER.maxSpeed * 0.9, `加速しきれていない (${v})`);
});

test("チャージ中は遅くなる", () => {
  const run = (btn) => {
    const p = createPlayer(1, 0);
    for (let i = 0; i < 240; i++) stepPlayer(p, { mx: 1, my: 0, btn }, DT);
    return Math.hypot(p.vx, p.vy);
  };
  assert.ok(run(BTN.KICK) < run(0) * 0.75);
});

test("ダッシュはスタミナを使い、速く走れる", () => {
  const p = createPlayer(1, 0);
  stepPlayer(p, { mx: 1, my: 0, btn: BTN.DASH }, DT);
  assert.equal(p.stam < PLAYER.stamMax, true);
  assert.ok(p.dash > 0);
  // スタミナが尽きたらダッシュできない
  p.stam = 0; p.dash = 0; p.dashCd = 0; p.prevDash = false;
  stepPlayer(p, { mx: 1, my: 0, btn: BTN.DASH }, DT);
  assert.equal(p.dash, 0);
});

test("キックはチャージ量で威力が変わる", () => {
  const kick = (hold) => {
    const p = createPlayer(1, 0);
    const b = createBall();
    p.x = -30; p.y = 0; b.x = 0; b.y = 0;
    const n = Math.round(hold / DT);
    for (let i = 0; i < n; i++) stepPlayer(p, { mx: 0, my: 0, btn: BTN.KICK }, DT);
    const rel = stepPlayer(p, { mx: 0, my: 0, btn: 0 }, DT);
    assert.ok(rel >= 0, "離したのに蹴りが返らない");
    assert.ok(canKick(p, b), "届く距離のはずが届いていない");
    return applyKick(p, b, rel);
  };
  const weak = kick(0.02);
  const strong = kick(PLAYER.kickCharge + 0.1);
  assert.ok(strong > weak * 1.5, `溜めても強くならない (${weak} → ${strong})`);
  assert.ok(strong <= PLAYER.kickMax + 1);
});

test("ゴールラインを割ると得点になる", () => {
  const b = createBall();
  b.x = HW - 30; b.y = 0; b.vx = 600;
  let scored = -1;
  for (let i = 0; i < 60 && scored < 0; i++) scored = stepBall(b, DT);
  assert.equal(scored, 0, "右ゴール = レッド(team0)の得点になるはず");
});

test("枠の外へ飛んだボールはピッチ内で跳ね返る", () => {
  const b = createBall();
  b.x = HW - 30; b.y = GOAL.w / 2 + 60; b.vx = 600;
  for (let i = 0; i < 60; i++) assert.equal(stepBall(b, DT), -1);
  assert.ok(b.x < HW, "壁を抜けた");
  assert.ok(b.vx < 0, "跳ね返っていない");
});

test("ポストに当たると弾かれる", () => {
  const b = createBall();
  b.x = HW - 40; b.y = GOAL.w / 2 - 2; b.vx = 420; b.vy = 0;
  let scored = -1;
  for (let i = 0; i < 40 && scored < 0; i++) scored = stepBall(b, DT);
  assert.equal(scored, -1, "ポストに当たったのに得点になった");
});

test("ボールは壁を突き抜けない (最高速でも)", () => {
  const b = createBall();
  b.vx = BALL.maxSpeed; b.vy = BALL.maxSpeed;
  for (let i = 0; i < 1200; i++) {
    stepBall(b, DT);
    if (Math.abs(b.y) > FIELD.h / 2 + 1) assert.fail(`縦に抜けた y=${b.y}`);
    if (b.x > HW + GOAL.depth + 40 || b.x < -HW - GOAL.depth - 40) assert.fail(`横に抜けた x=${b.x}`);
    if (Math.abs(b.x) > HW) { b.x = 0; b.y = 0; b.vx = -b.vx; }   // 得点したら中央へ
  }
});

test("体で押すとボールが動く (ドリブル)", () => {
  const p = createPlayer(1, 0);
  const b = createBall();
  p.x = -20; p.y = 0; p.vx = 300;
  b.x = 0; b.y = 0;
  assert.equal(collidePlayerBall(p, b), true);
  assert.ok(b.vx > 0, "前に転がらない");
  assert.equal(b.lastTouch, 1);
});

test("ダッシュ体当たりでタックルが成立する", () => {
  const a = createPlayer(1, 0);
  const b = createPlayer(2, 1);
  a.x = -20; a.y = 0; a.vx = 400; a.dash = 0.2;
  b.x = 0; b.y = 0;
  const hit = collidePlayers(a, b);
  assert.ok(hit && hit.by === 1 && hit.to === 2);
  assert.ok(b.stun > 0);
  assert.equal(a.dash, 0, "当てたらダッシュは終わるはず");
  // 味方には効かない
  const c = createPlayer(3, 0); const d = createPlayer(4, 0);
  c.x = -20; c.vx = 400; c.dash = 0.2; d.x = 0;
  assert.equal(collidePlayers(c, d), null);
});

// ---------------------------------------------------------------- プロトコル

test("入力パケットは 6 byte で往復する", () => {
  const buf = encodeInput(65535, -0.5, 0.25, BTN.KICK | BTN.DASH);
  assert.equal(buf.byteLength, 6);
  const d = decodeInput(buf);
  assert.equal(d.seq, 65535);
  assert.ok(Math.abs(d.mx + 0.5) < 0.02);
  assert.ok(Math.abs(d.my - 0.25) < 0.02);
  assert.equal(d.btn, BTN.KICK | BTN.DASH);
});

test("スナップショットが往復し、6人でも 100 byte 未満", () => {
  const ball = createBall();
  ball.x = -123.5; ball.y = 44.25; ball.vx = 610; ball.spin = 0.5;
  const players = [];
  for (let i = 0; i < 6; i++) {
    const p = createPlayer(i + 1, i % 2);
    p.x = i * 50 - 100; p.y = -i * 30; p.vx = 120; p.stam = 60;
    p.charging = i === 0; p.chargeRatio = 0.5; p.bot = i > 3;
    players.push(p);
  }
  const buf = encodeSnapshot(70000, 300, PHASE.PLAY, ball, players);
  assert.ok(buf.byteLength < 100, `${buf.byteLength} byte は大きすぎる`);
  const s = decodeSnapshot(buf);
  assert.equal(s.tick, 70000 & 0xffff);
  assert.equal(s.ack, 300);
  assert.equal(s.phase, PHASE.PLAY);
  assert.ok(Math.abs(s.ball.x + 123.5) < 0.2);
  assert.equal(s.players.length, 6);
  assert.equal(s.players[0].charging, true);
  assert.equal(s.players[4].bot, true);
  assert.equal(s.players[1].team, 1);
});

// ---------------------------------------------------------------- 部屋 / BOT

const fakeStore = { kind: "test", async record() {}, async leaderboard() { return []; } };
const fakeConn = () => ({ readyState: 1, sent: [], send(m) { this.sent.push(m); } });

function runRoom(seconds, room) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) room.step(DT);
}

/** 条件を満たすまで進める (時計は PLAY 中しか減らないので、実時間は試合時間より長い) */
function runUntil(room, pred, maxSec) {
  const n = Math.round(maxSec / DT);
  for (let i = 0; i < n; i++) {
    room.step(DT);
    if (pred(room)) return true;
  }
  return false;
}

test("部屋は BOT で 3対3 に埋まり、人が入ると BOT が 1 体どく", () => {
  const room = new Room("t1", fakeStore);
  const conn = fakeConn();
  const me = room.join(conn, "わたし");
  assert.equal(room.ents.length, MATCH.perTeam * 2);
  assert.equal(room.humans.length, 1);
  assert.equal(room.ents.filter((e) => e.bot).length, MATCH.perTeam * 2 - 1);
  assert.equal(room.ents.filter((e) => e.team === me.team).length, MATCH.perTeam);
});

test("試合が進み、BOT だけでも得点が入る", () => {
  let goals = 0, stalls = 0;
  for (let m = 0; m < 3; m++) {
    const room = new Room(`t2-${m}`, fakeStore);
    room.join(fakeConn(), "みてるだけ");
    const ev = room.event.bind(room);
    room.event = (e) => { if (e.e === "stall") stalls++; ev(e); };

    runRoom(2, room);
    assert.equal(room.phase, PHASE.PLAY, "キックオフ後に PLAY にならない");

    // ゴールのたびに間が入るぶん、実時間は試合時間より長くなる
    const done = runUntil(room, (r) => r.phase === PHASE.RESULT, MATCH.duration * 2);
    assert.ok(done, "試合が終わらない");
    assert.equal(room.clock, 0);
    goals += room.score[0] + room.score[1];

    for (const e of room.ents) {
      assert.ok(finite(e, ["x", "y", "vx", "vy", "stam"]), `NaN が出た id=${e.id}`);
      assert.ok(Math.abs(e.x) <= FIELD.w / 2 + 1 && Math.abs(e.y) <= FIELD.h / 2 + 1, "場外に出た");
    }
    assert.ok(finite(room.ball, ["x", "y", "vx", "vy", "spin"]));
  }
  // 実測でだいたい 1試合 3点前後。3試合で 2点未満なら BOT が壊れている
  assert.ok(goals >= 2, `3試合で ${goals} 点しか入らない (BOT が弱すぎ)`);
  // 隅で団子になって試合が止まらないこと (丸めた四隅の回帰テスト)
  assert.ok(stalls <= 1, `試合が ${stalls} 回止まった`);
});

test("隅に入ったボールは自力で転がり出る (角の丸みが効いている)", () => {
  const room = new Room("t2c", fakeStore);
  room.join(fakeConn(), "みてるだけ");
  runRoom(2, room);
  const HH = FIELD.h / 2;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      room.ball.x = sx * (HW - BALL.r); room.ball.y = sy * (HH - BALL.r);
      room.ball.vx = 0; room.ball.vy = 0;
      // 隅にBOTを2体寄せて、押し込む状況を作る
      const near = room.ents.slice(0, 2);
      near[0].x = sx * (HW - 40); near[0].y = sy * (HH - 30);
      near[1].x = sx * (HW - 70); near[1].y = sy * (HH - 25);
      let out = false;
      for (let i = 0; i < 60 * 5 && !out; i++) {
        room.step(DT);
        const cx = sx * (HW - CORNER_R), cy = sy * (HH - CORNER_R);
        out = Math.hypot(room.ball.x - cx, room.ball.y - cy) < CORNER_R - BALL.r - 6
          || Math.abs(room.ball.x) < HW - CORNER_R || Math.abs(room.ball.y) < HH - CORNER_R;
      }
      assert.ok(out, `(${sx},${sy}) の隅から 5 秒で出られない`);
    }
  }
});

test("誰もいない部屋は動かない (無料プランのCPU節約)", () => {
  const room = new Room("t3", fakeStore);
  const before = room.tick;
  runRoom(3, room);
  assert.equal(room.tick, before, "無人なのに回っている");

  const conn = fakeConn();
  const ent = room.join(conn, "だれか");
  runRoom(0.2, room);
  assert.ok(room.tick > 0);
  room.leave(ent);
  const t = room.tick;
  runRoom(1, room);
  assert.equal(room.tick, t, "全員抜けたのに止まらない");
});

test("入力は古いパケットを捨て、u16 のラップをまたげる", () => {
  const room = new Room("t4", fakeStore);
  const ent = room.join(fakeConn(), "seq");
  ent.lastSeq = 65530;
  room.applyInput(ent, { seq: 65534, mx: 1, my: 0, btn: 0 });
  assert.equal(ent.lastSeq, 65534);
  room.applyInput(ent, { seq: 3, mx: 0, my: 1, btn: 0 });        // ラップして進んだ
  assert.equal(ent.lastSeq, 3);
  assert.equal(ent.input.my, 1);
  room.applyInput(ent, { seq: 65000, mx: -1, my: 0, btn: 0 });   // 明らかに古い
  assert.equal(ent.lastSeq, 3);
  assert.equal(ent.input.mx, 0);
});

test("スナップショットは接続中のプレイヤーにだけ送られる", () => {
  const room = new Room("t5", fakeStore);
  const conn = fakeConn();
  room.join(conn, "うける");
  runRoom(1, room);
  const bin = conn.sent.filter((m) => m instanceof ArrayBuffer);
  assert.ok(bin.length >= 15, `1秒で ${bin.length} 個しか届かない (20Hz のはず)`);
  const s = decodeSnapshot(bin[bin.length - 1]);
  assert.equal(s.players.length, MATCH.perTeam * 2);
});

test("クイックマッチは空いている部屋へ相乗りする", () => {
  const rooms = new Rooms(fakeStore);
  const a = rooms.quick();
  a.join(fakeConn(), "1人目");
  const b = rooms.quick();
  assert.equal(b.id, a.id, "空いているのに別部屋を作った");
  for (let i = 0; i < MATCH.perTeam * 2 - 1; i++) a.join(fakeConn(), `p${i}`);
  assert.equal(a.open, false);
  const c = rooms.quick();
  assert.notEqual(c.id, a.id, "満室なのに同じ部屋を返した");
});

test("合言葉の部屋は同じ名前なら同じ部屋になる", () => {
  const rooms = new Rooms(fakeStore);
  assert.equal(rooms.get("nakama"), rooms.get("nakama"));
  assert.notEqual(rooms.get("nakama"), rooms.get("betsu"));
});
