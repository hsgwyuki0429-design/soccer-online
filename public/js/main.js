// ============ まるサッカー: 起動とゲームループ ============

import { DT, INPUT_HZ, PLAYER, MATCH, TEAM_NAME, TEAM_COLOR } from "../shared/constants.js";
import { canKick } from "../shared/physics.js";
import { Net } from "./net.js";
import { Input, isTouch } from "./input.js";
import { Renderer } from "./render.js";
import { SelfPredictor, BallLead } from "./predict.js";
import { sfx, unlockAudio } from "./audio.js";

const PHASE = { WAIT: 0, KICKOFF: 1, PLAY: 2, GOAL: 3, RESULT: 4 };

const $ = (id) => document.getElementById(id);
const el = {
  title: $("title"), help: $("help"), rank: $("rank"), result: $("result"),
  hud: $("hud"), score: $("score"), clock: $("clock"), ping: $("ping"),
  roomtag: $("roomtag"), toast: $("toast"), bigmsg: $("bigmsg"),
  stam: document.querySelector("#stamina i"),
  name0: $("name0"), name1: $("name1"),
  rooms: $("rooms"), ranklist: $("ranklist"), note: $("conn-note"),
};

const store = {
  get name() { return localStorage.getItem("marusoccer.name") || ""; },
  set name(v) { localStorage.setItem("marusoccer.name", v); },
  get pid() {
    let p = localStorage.getItem("marusoccer.pid");
    if (!p) { p = rid(); localStorage.setItem("marusoccer.pid", p); }
    return p;
  },
};
function rid() {
  return (crypto.randomUUID?.() || String(Math.random()).slice(2) + Date.now().toString(36)).slice(0, 36);
}

// ---------------------------------------------------------------- 接続先

const params = new URLSearchParams(location.search);
const SERVER = params.get("server") || "";       // 別ホストのサーバを使いたいとき
function wsUrl(room) {
  const base = SERVER
    ? SERVER.replace(/^http/, "ws").replace(/\/+$/, "")
    : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  return `${base}/ws${room ? `?room=${encodeURIComponent(room)}` : ""}`;
}
function apiUrl(p) {
  return SERVER ? `${SERVER.replace(/\/+$/, "")}${p}` : p;
}

// ---------------------------------------------------------------- 状態

const net = new Net();
const input = new Input();
const renderer = new Renderer($("stage"));
const lead = new BallLead();
let self = null;
let meta = new Map();
let hud = { phase: PHASE.WAIT, clock: MATCH.duration, score: [0, 0], timer: 0 };
let running = false;
let inputAcc = 0;
let acc = 0;
let lastT = performance.now();
let lastBallSpeed = 0;
let localKicks = 0;      // サーバを待たずに蹴った回数 (動作確認用)
let leadPeak = 0;        // 先出しのずれの最大値

// ---------------------------------------------------------------- 画面

function show(screen) {
  for (const s of [el.title, el.help, el.rank, el.result]) s.classList.add("hidden");
  if (screen) screen.classList.remove("hidden");
}

function toast(msg, ms = 1600) {
  el.toast.textContent = msg;
  el.toast.classList.add("on");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.toast.classList.remove("on"), ms);
}

function big(msg, color, ms = 1500) {
  el.bigmsg.textContent = msg;
  el.bigmsg.style.color = color || "#fff";
  el.bigmsg.classList.add("on");
  clearTimeout(big._t);
  big._t = setTimeout(() => el.bigmsg.classList.remove("on"), ms);
}

// ---------------------------------------------------------------- ネットのイベント

net.on.welcome = (m) => {
  self = new SelfPredictor(m.you, m.team);
  renderer.setTeam(m.team);
  meta = new Map();
  el.roomtag.textContent = m.room;
  el.hud.classList.remove("hidden");
  input.showTouch(isTouch);
  // スマホは画面下に操作ボタンが出るので、ピッチをその上へ寄せる
  // (完全には避けきれないが、ボタンは半透明なので少しの重なりは透けて見える)
  renderer.touchUI = isTouch;
  renderer.resize();
  show(null);
  running = true;
  lastT = performance.now();
  acc = 0;
  toast(`${TEAM_NAME[m.team]}チーム`, 1800);
};

net.on.roster = (m) => {
  meta = new Map(m.players.map((p) => [p.id, p]));
  const mine = meta.get(net.you);
  if (mine && self && mine.team !== self.p.team) {
    self.p.team = mine.team;
    renderer.setTeam(mine.team);
  }
  const c = [0, 0];
  for (const p of m.players) if (!p.bot) c[p.team]++;
  el.name0.innerHTML = `${TEAM_NAME[0]}${c[0] ? `<i>${c[0]}人</i>` : ""}`;
  el.name1.innerHTML = `${TEAM_NAME[1]}${c[1] ? `<i>${c[1]}人</i>` : ""}`;
};

net.on.hud = (m) => {
  hud = m;
  el.score.textContent = `${m.score[0]} - ${m.score[1]}`;
  el.clock.textContent = `${Math.floor(m.clock / 60)}:${String(m.clock % 60).padStart(2, "0")}`;
};

net.on.ev = (m) => {
  switch (m.e) {
    case "goal": {
      const mine = self && m.team === self.p.team;
      renderer.burst(TEAM_COLOR[m.team]);
      renderer.bump(2);
      big("GOAL!", TEAM_COLOR[m.team], 2200);
      if (mine) sfx.goal(); else sfx.conceded();
      if (m.by) toast(m.own ? `${m.by} のオウンゴール…` : `${m.by} のゴール!`, 2200);
      navigator.vibrate?.(mine ? [40, 60, 90] : 30);
      break;
    }
    case "tackle":
      if (self && m.to === self.p.id) { renderer.bump(1.1); navigator.vibrate?.(30); }
      sfx.tackle();
      break;
    case "whistle":
      sfx.whistle();
      break;
    case "start":
      big("KICK OFF", "#fff", 1200);
      break;
    case "stall":
      toast("ボールが止まったので、キックオフからやり直し", 2400);
      break;
    case "end": {
      sfx.end();
      const mine = self ? self.p.team : 0;
      const win = m.winner === -1 ? "引き分け" : (m.winner === mine ? "勝ち!" : "負け…");
      $("res-title").textContent = win;
      $("res-score").innerHTML =
        `<span style="color:${TEAM_COLOR[0]}">${m.score[0]}</span> - <span style="color:${TEAM_COLOR[1]}">${m.score[1]}</span>`;
      $("res-top").innerHTML = m.top?.length
        ? m.top.map((t) => `${esc(t.name)}${t.bot ? "(BOT)" : ""} … ${t.goals}`).join("<br>")
        : "得点なし";
      show(el.result);
      break;
    }
  }
};

net.on.snapshot = (s) => {
  if (!self) return;
  const mine = s.players.find((p) => p.id === net.you);
  if (mine) self.reconcile(mine, net.rtt, s.t);
};

net.on.close = () => {
  if (!running) return;
  running = false;
  el.hud.classList.add("hidden");
  input.showTouch(false);
  show(el.title);
  el.note.textContent = "接続が切れました。もう一度どうぞ。";
};

// ---------------------------------------------------------------- ゲームループ

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (now - lastT) / 1000);
  lastT = now;
  const nowSec = now / 1000;

  if (!running || !self) { renderer.draw(null, null, null, dt); return; }

  // --- 入力 (画面基準 → 世界基準) ---
  const raw = input.read();
  const d = renderer.screenToWorldDir(raw.mx, raw.my);
  const cmd = { mx: d.x, my: d.y, btn: raw.btn };

  const phase = net.latest ? net.latest.phase : PHASE.WAIT;
  const frozen = phase === PHASE.KICKOFF || phase === PHASE.RESULT || phase === PHASE.WAIT;
  const simCmd = frozen ? { mx: 0, my: 0, btn: 0 } : cmd;

  // --- 補間された世界 ---
  const state = net.sample(nowSec);

  // --- 自分だけ即時に動かす (サーバと同じ 60Hz 固定ステップ) ---
  acc += dt;
  let steps = 0;
  while (acc >= DT && steps < 8) {
    const released = self.step(simCmd, DT, nowSec - (acc - DT));
    if (released >= 0 && state && phase === PHASE.PLAY) tryLocalKick(released, state);
    acc -= DT;
    steps++;
  }
  if (acc > DT * 8) acc = 0;

  // --- 入力送信 (30Hz) ---
  inputAcc += dt;
  if (inputAcc >= 1 / INPUT_HZ) {
    inputAcc = 0;
    net.sendInput(cmd.mx, cmd.my, cmd.btn);
  }

  // --- ボールの先出し ---
  const view = self.view();
  if (state) {
    lead.step(dt);
    lead.contact(view.x, view.y, state.ball.x + lead.x, state.ball.y + lead.y);
    leadPeak = Math.max(leadPeak, Math.hypot(lead.x, lead.y));
    state.ball.x += lead.x;
    state.ball.y += lead.y;

    // 誰かが強く蹴った音 (速度が跳ねたら鳴らす)
    const sp = Math.hypot(state.ball.vx, state.ball.vy);
    if (sp - lastBallSpeed > 190) sfx.kick(Math.min(1, sp / PLAYER.kickMax));
    lastBallSpeed = sp;

    // 自分の丸には予測した charge を反映する (リングを即座に出すため)
    const mine = state.players.find((p) => p.id === net.you);
    if (mine) {
      mine.charging = self.p.charging;
      mine.charge = self.p.charging ? self.p.charge / PLAYER.kickCharge : 0;
      mine.dashing = self.p.dash > 0;
    }
  }

  renderer.draw(state, { ...view, id: net.you }, meta, dt);

  el.stam.style.width = `${Math.max(0, Math.min(100, self.p.stam))}%`;
  el.ping.textContent = Math.round(net.rtt * 1000);

  // キックオフのカウントダウン
  if (phase === PHASE.KICKOFF && hud.timer > 0.1) {
    el.bigmsg.textContent = String(Math.ceil(hud.timer));
    el.bigmsg.style.color = "#fff";
    el.bigmsg.classList.add("on");
  } else if (phase === PHASE.KICKOFF) {
    el.bigmsg.classList.remove("on");
  }
}
requestAnimationFrame(frame);

/** 自分の蹴りをサーバの返事を待たずに見せる */
function tryLocalKick(power, state) {
  if (self.p.kickCd > 0) return;
  const b = { x: state.ball.x + lead.x, y: state.ball.y + lead.y };
  if (!canKick(self.p, b)) return;

  let dx = b.x - self.p.x, dy = b.y - self.p.y;
  let len = Math.hypot(dx, dy);
  if (len < 1e-4) { dx = self.p.aimX; dy = self.p.aimY; len = 1; }
  const nx = dx / len, ny = dy / len;
  const speed = PLAYER.kickMin + (PLAYER.kickMax - PLAYER.kickMin) * power;
  const inherit = Math.max(0, (self.p.vx * nx + self.p.vy * ny) * PLAYER.kickInherit);

  lead.kick(nx, ny, speed + inherit, state.ball.vx, state.ball.vy);
  localKicks++;
  self.p.kickCd = PLAYER.kickCooldown;
  sfx.kick(power);
  navigator.vibrate?.(power > 0.7 ? 22 : 10);
  renderer.bump(power * 0.5);
  lastBallSpeed = speed;
}

// ---------------------------------------------------------------- タイトル UI

$("in-name").value = store.name;

async function start(room) {
  const name = ($("in-name").value || "").trim().slice(0, 10);
  store.name = name;
  el.note.textContent = "接続中…";
  unlockAudio();
  try {
    net.close();
    await net.connect(wsUrl(room), { name: name || "ぷれいやー", pid: store.pid });
    el.note.textContent = "";
  } catch (e) {
    el.note.textContent = `つながりませんでした (${e.message || e})`;
  }
}

$("btn-quick").onclick = () => start("");
$("btn-room").onclick = () => {
  const r = ($("in-room").value || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);
  if (!r) { el.note.textContent = "合言葉を入れてください (英数字)"; return; }
  start(r);
};
$("btn-help").onclick = () => show(el.help);
$("btn-rank").onclick = () => { show(el.rank); loadRanks(); };
for (const b of document.querySelectorAll(".back")) b.onclick = () => show(el.title);
$("btn-res-close").onclick = () => show(null);

$("btn-leave").onclick = () => {
  running = false;
  net.close();
  el.hud.classList.add("hidden");
  input.showTouch(false);
  show(el.title);
  loadRooms();
};
$("btn-zoom").onclick = () => {
  renderer.zoom = renderer.zoom > 1.001 ? 1 : 1.75;
  toast(renderer.zoom > 1 ? "ズーム: 寄り" : "ズーム: 全体", 900);
};

async function loadRooms() {
  try {
    const r = await fetch(apiUrl("/api/rooms")).then((x) => x.json());
    el.rooms.innerHTML = r.rooms.length
      ? r.rooms.map((x) => `<div class="r" data-id="${esc(x.id)}">
          <b>${esc(x.id)}</b> ${x.score[0]}-${x.score[1]}
          <span>${x.humans}/${x.cap}人</span></div>`).join("")
      : "";
    for (const d of el.rooms.querySelectorAll(".r")) d.onclick = () => start(d.dataset.id);
  } catch { el.rooms.innerHTML = ""; }
}

async function loadRanks() {
  el.ranklist.textContent = "よみこみ中…";
  try {
    const r = await fetch(apiUrl("/api/leaderboard?limit=50")).then((x) => x.json());
    if (!r.rows?.length) {
      el.ranklist.innerHTML = `<p class="note">まだ記録がありません。${r.kind === "memory" ? "(このサーバは Supabase 未設定なので、再起動で消えます)" : ""}</p>`;
      return;
    }
    el.ranklist.innerHTML = r.rows.map((row, i) => `<div class="r">
      <i>${i + 1}</i><b>${esc(row.name || "?")}</b>
      <s>${row.points ?? (row.wins * 3 + row.draws)}pt</s>
      <u>${row.goals}G</u></div>`).join("");
  } catch {
    el.ranklist.innerHTML = `<p class="note">ランキングを読めませんでした</p>`;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

loadRooms();
setInterval(() => { if (!running) loadRooms(); }, 5000);

// 動作確認用の覗き窓 (読み取り専用)。ブラウザの自動テストから状態を見るのに使う。
// 書き込みできることは何もないので、これで有利になることはない。
window.__dbg = {
  running: () => running,
  phase: () => (net.latest ? net.latest.phase : -1),
  self: () => (self ? { x: Math.round(self.p.x), y: Math.round(self.p.y), team: self.p.team } : null),
  ball: () => {
    const s = net.sample(performance.now() / 1000);
    return s ? { x: Math.round(s.ball.x), y: Math.round(s.ball.y) } : null;
  },
  ballSpeed: () => {
    const s = net.sample(performance.now() / 1000);
    return s ? Math.round(Math.hypot(s.ball.vx, s.ball.vy)) : 0;
  },
  /** 先出し (サーバの返事を待たずに動かしているぶん): 回数と、ずれの最大値 */
  localKicks: () => localKicks,
  leadPeak: () => Math.round(leadPeak),
  /** 自分の位置と速度を画面基準で見る (「D を押したら右に動くか」の確認用) */
  screenSelf: () => {
    if (!self) return null;
    const p = renderer.toScreen(self.p.x, self.p.y);
    const c = Math.cos(renderer.rot), s = Math.sin(renderer.rot);
    return { x: p.x, y: p.y, vx: c * self.p.vx - s * self.p.vy, vy: s * self.p.vx + c * self.p.vy };
  },
  /** 自分 → ボール の向き (画面基準)。テストがどのキーを押すか決めるのに使う */
  screenDelta: () => {
    const s = net.sample(performance.now() / 1000);
    if (!s || !self) return null;
    const a = renderer.toScreen(self.p.x, self.p.y);
    const b = renderer.toScreen(s.ball.x, s.ball.y);
    return { dx: b.x - a.x, dy: b.y - a.y, dist: Math.hypot(s.ball.x - self.p.x, s.ball.y - self.p.y) };
  },
  stats: () => ({
    snapshots: net.buf.length,
    rttMs: Math.round(net.rtt * 1000),
    players: net.latest ? net.latest.players.length : 0,
    scale: +renderer.scale.toFixed(3),
    portrait: renderer.portrait,
    rotDeg: Math.round((renderer.rot * 180) / Math.PI),
  }),
};

// 合言葉つき URL (?r=abcd) ならそのまま入る
const preset = params.get("r");
if (preset) { $("in-room").value = preset; start(preset.toLowerCase()); }
