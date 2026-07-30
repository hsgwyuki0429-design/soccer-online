// ============ サーバの通し確認 (node --test test/net.test.js) ============
// 実際に server/index.js を起動して、HTTP と WebSocket を本物で叩く。

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

import { encodeInput, decodeSnapshot } from "../shared/protocol.js";
import { BTN, MATCH } from "../shared/constants.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8971 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;

let child;

test.before(async () => {
  child = spawn(process.execPath, [path.join(ROOT, "server", "index.js")], {
    env: { ...process.env, PORT: String(PORT), SUPABASE_URL: "", SUPABASE_SERVICE_KEY: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((res, rej) => {
    const to = setTimeout(() => rej(new Error("サーバが起動しない")), 8000);
    child.stdout.on("data", (d) => {
      if (String(d).includes("listening")) { clearTimeout(to); res(); }
    });
  });
});

test.after(() => child?.kill());

// ---------------------------------------------------------------- HTTP

test("HTTP: 静的配信と API", async () => {
  assert.equal(await (await fetch(`${BASE}/healthz`)).text(), "ok");

  const html = await (await fetch(`${BASE}/`)).text();
  assert.match(html, /まるサッカー/);

  // shared/ はブラウザからも同じファイルを読む (物理を共有するため)
  const phys = await fetch(`${BASE}/shared/physics.js`);
  assert.equal(phys.status, 200);
  assert.match(phys.headers.get("content-type"), /javascript/);

  // ルート外へは出られない
  const bad = await fetch(`${BASE}/shared/..%2f..%2fpackage.json`);
  assert.notEqual(bad.status, 200);

  const lb = await (await fetch(`${BASE}/api/leaderboard`)).json();
  assert.equal(lb.kind, "memory");        // Supabase 未設定のときのフォールバック
  assert.ok(Array.isArray(lb.rows));

  const cfg = await (await fetch(`${BASE}/api/config`)).json();
  assert.equal(cfg.match.perTeam, MATCH.perTeam);
});

// ---------------------------------------------------------------- WebSocket

function connect(room, name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws${room ? `?room=${room}` : ""}`);
  ws.binaryType = "arraybuffer";
  const state = { ws, snaps: [], json: [], welcome: null };
  ws.on("message", (data, isBinary) => {
    if (isBinary) state.snaps.push(decodeSnapshot(data));
    else {
      const m = JSON.parse(data.toString());
      state.json.push(m);
      if (m.t === "welcome") state.welcome = m;
    }
  });
  return new Promise((res, rej) => {
    ws.on("error", rej);
    ws.on("open", () => {
      ws.send(JSON.stringify({ t: "hello", name, pid: `pid-${name}` }));
      const to = setTimeout(() => rej(new Error("welcome が来ない")), 5000);
      const check = setInterval(() => {
        if (state.welcome) { clearTimeout(to); clearInterval(check); res(state); }
      }, 20);
    });
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("WS: 参加すると welcome と 20Hz のスナップショットが届く", async () => {
  const a = await connect("aaa", "あ");
  assert.ok(a.welcome.you > 0);
  assert.equal(a.welcome.room, "aaa");

  await wait(1000);
  assert.ok(a.snaps.length >= 14, `1秒で ${a.snaps.length} 個 (20Hz のはず)`);
  const s = a.snaps.at(-1);
  assert.equal(s.players.length, MATCH.perTeam * 2);
  assert.ok(s.players.some((p) => p.id === a.welcome.you));
  assert.ok(s.players.filter((p) => p.bot).length === MATCH.perTeam * 2 - 1);

  // HUD も流れてくる
  assert.ok(a.json.some((m) => m.t === "hud"));
  assert.ok(a.json.some((m) => m.t === "roster"));
  a.ws.close();
});

test("WS: 送った入力でちゃんと動く (ack も返る)", async () => {
  const a = await connect("bbb", "うごく");
  await wait(2200);                                     // キックオフの静止が明けるまで
  const before = a.snaps.at(-1).players.find((p) => p.id === a.welcome.you);

  for (let i = 1; i <= 40; i++) {
    a.ws.send(encodeInput(i, 0, 1, 0));                 // 下へ走り続ける
    await wait(1000 / 30);
  }
  await wait(200);
  const after = a.snaps.at(-1).players.find((p) => p.id === a.welcome.you);
  assert.ok(after.y > before.y + 40, `動いていない (${before.y} → ${after.y})`);
  assert.ok(a.snaps.at(-1).ack > 0, "入力の ack が返っていない");
  a.ws.close();
});

test("WS: 2人が同じ合言葉の部屋に入り、別チームになる", async () => {
  const a = await connect("ccc", "ひとり");
  const b = await connect("ccc", "ふたり");
  assert.equal(a.welcome.room, b.welcome.room);
  assert.notEqual(a.welcome.team, b.welcome.team);

  await wait(400);
  const roster = b.json.filter((m) => m.t === "roster").at(-1);
  const humans = roster.players.filter((p) => !p.bot);
  assert.equal(humans.length, 2);
  assert.deepEqual(humans.map((p) => p.name).sort(), ["ひとり", "ふたり"]);
  assert.equal(roster.players.length, MATCH.perTeam * 2, "BOT を含めて 6 人のはず");

  // 抜けたら BOT が席を埋め直す
  a.ws.close();
  await wait(400);
  const after = b.json.filter((m) => m.t === "roster").at(-1);
  assert.equal(after.players.filter((p) => !p.bot).length, 1);
  assert.equal(after.players.length, MATCH.perTeam * 2);
  b.ws.close();
});

test("WS: 部屋一覧に出る / ping が返る", async () => {
  const a = await connect("ddd", "いちらん");
  await wait(300);
  const rooms = (await (await fetch(`${BASE}/api/rooms`)).json()).rooms;
  const mine = rooms.find((r) => r.id === "ddd");
  assert.ok(mine, "部屋一覧に出ない");
  assert.equal(mine.humans, 1);
  assert.equal(mine.cap, MATCH.perTeam * 2);

  a.ws.send(JSON.stringify({ t: "ping", ts: 12345 }));
  await wait(300);
  assert.ok(a.json.some((m) => m.t === "pong" && m.ts === 12345));
  a.ws.close();
});

test("WS: チームを変えられる", async () => {
  const a = await connect("eee", "いどう");
  const want = 1 - a.welcome.team;
  a.ws.send(JSON.stringify({ t: "team", team: want }));
  await wait(400);
  const roster = a.json.filter((m) => m.t === "roster").at(-1);
  const me = roster.players.find((p) => p.id === a.welcome.you);
  assert.equal(me.team, want);
  assert.equal(roster.players.filter((p) => p.team === 0).length, MATCH.perTeam);
  assert.equal(roster.players.filter((p) => p.team === 1).length, MATCH.perTeam);
  a.ws.close();
});

test("WS: 壊れたパケットや長すぎる名前で落ちない", async () => {
  const a = await connect("fff", "ふつう");
  a.ws.send(new Uint8Array([9, 9, 9]));                     // 知らない型のバイナリ
  a.ws.send("これは JSON ではない");
  a.ws.send(JSON.stringify({ t: "name", name: "あ".repeat(200) }));
  a.ws.send(JSON.stringify({ t: "team", team: 99 }));
  await wait(400);
  const roster = a.json.filter((m) => m.t === "roster").at(-1);
  assert.equal(roster.players.find((p) => p.id === a.welcome.you).name.length, 10);
  assert.equal(a.ws.readyState, WebSocket.OPEN, "切断されてしまった");
  a.ws.close();
});
