// ============ サーバ (静的配信 + WebSocket + 権威シミュレーション) ============
//
// Render の Web Service ひとつで完結させる:
//   /            → public/ (ゲーム本体)
//   /shared/*    → サーバと共有している物理・定数・プロトコル
//   /ws          → WebSocket (試合)
//   /api/*       → 部屋一覧・ランキング (Supabase)
//   /healthz     → ヘルスチェック
//
// 依存は ws だけ。フレームワークもバンドラも使わない (起動が速く、コールドスタートに強い)。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { DT, MATCH, FIELD, GOAL, PLAYER, BALL, INPUT_HZ } from "../shared/constants.js";
import { decodeInput } from "../shared/protocol.js";
import { Rooms } from "./room.js";
import { createStore } from "./store.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PUBLIC = path.join(ROOT, "public");
const SHARED = path.join(ROOT, "shared");
const PORT = Number(process.env.PORT) || 8080;

const store = createStore();
const rooms = new Rooms(store);

// ---------------------------------------------------------------- HTTP

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function serveFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=300",
    });
    res.end(buf);
  });
}

/** ../ でルート外へ出られないように解決する */
function safeJoin(base, rel) {
  const p = path.normalize(path.join(base, decodeURIComponent(rel)));
  return p.startsWith(base) ? p : null;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = url.pathname;

  if (p === "/healthz") { res.writeHead(200); res.end("ok"); return; }

  if (p === "/api/rooms") return sendJson(res, 200, { rooms: rooms.list() });

  if (p === "/api/leaderboard") {
    try {
      const limit = Math.min(100, Number(url.searchParams.get("limit")) || 50);
      return sendJson(res, 200, { kind: store.kind, rows: await store.leaderboard(limit) });
    } catch (e) {
      return sendJson(res, 200, { kind: store.kind, rows: [], error: String(e.message || e) });
    }
  }

  if (p === "/api/config") {
    return sendJson(res, 200, {
      field: FIELD, goal: GOAL, player: PLAYER, ball: BALL,
      match: MATCH, inputHz: INPUT_HZ, store: store.kind,
    });
  }

  if (p.startsWith("/shared/")) {
    const f = safeJoin(SHARED, p.slice("/shared/".length));
    if (f) return serveFile(res, f);
  }

  const rel = p === "/" ? "index.html" : p.slice(1);
  const f = safeJoin(PUBLIC, rel);
  if (!f) { res.writeHead(403); res.end("no"); return; }
  fs.stat(f, (err, st) => {
    if (err || !st.isFile()) return serveFile(res, path.join(PUBLIC, "index.html"));
    serveFile(res, f);
  });
});

// ---------------------------------------------------------------- WebSocket

const wss = new WebSocketServer({ server, path: "/ws", maxPayload: 4096 });

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  let ent = null;
  let room = null;

  const url = new URL(req.url, "http://x");
  const wanted = (url.searchParams.get("room") || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8);

  ws.on("message", (data, isBinary) => {
    // --- 入力 (バイナリ) ---
    if (isBinary) {
      if (!ent) return;
      const inp = decodeInput(data);
      if (inp) room.applyInput(ent, inp);
      return;
    }

    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    if (msg.t === "hello") {
      if (ent) return;
      ws.pid = String(msg.pid || "").slice(0, 40) || null;
      room = wanted ? rooms.get(wanted) : rooms.quick();
      if (!room) { ws.close(1013, "full"); return; }
      if (!room.open) { ws.close(1013, "room full"); return; }
      ent = room.join(ws, msg.name);
      ws.send(JSON.stringify({
        t: "welcome",
        you: ent.id,
        room: room.id,
        team: ent.team,
        inputHz: INPUT_HZ,
        match: MATCH,
      }));
      room.pushHud();
      return;
    }

    if (!ent) return;

    if (msg.t === "ping") { ws.send(JSON.stringify({ t: "pong", ts: msg.ts })); return; }

    if (msg.t === "name") {
      ent.name = String(msg.name || "").slice(0, 10) || ent.name;
      room.pushRoster();
      return;
    }

    if (msg.t === "team") {
      const want = msg.team === 1 ? 1 : 0;
      if (want === ent.team) return;
      const humans = room.humans.filter((e) => e.team === want).length;
      if (humans >= MATCH.perTeam) return;
      // 移った先のBOTを1体どかし、抜けた側はBOTで埋める
      const bot = room.ents.find((e) => e.bot && e.team === want);
      if (bot) room.remove(bot.id);
      ent.team = want;
      ent.aimX = want === 0 ? 1 : -1; ent.aimY = 0;
      room.balance();
      room.placeOne(ent);
      room.pushRoster();
      return;
    }
  });

  const bye = () => {
    if (ent && room) room.leave(ent);
    ent = null; room = null;
  };
  ws.on("close", bye);
  ws.on("error", bye);
});

// 死んだ接続の掃除 (モバイルはバックグラウンドで黙って切れることがある)
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch { /* もう閉じている */ }
  }
}, 15000);

// ---------------------------------------------------------------- メインループ

let last = Date.now();
let acc = 0;
setInterval(() => {
  const now = Date.now();
  acc += (now - last) / 1000;
  last = now;
  let steps = 0;
  while (acc >= DT && steps < 8) { rooms.step(DT); acc -= DT; steps++; }
  if (acc > DT * 8) acc = 0;      // 大きく遅れたら追いつくのを諦める
}, 1000 / 120);

server.listen(PORT, () => {
  console.log(`[soccer] listening on :${PORT}  (store: ${store.kind})`);
});
