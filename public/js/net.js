// ============ 通信 ============
//
// ・入力はバイナリで 30Hz 送信 (6 byte)
// ・スナップショットは 20Hz で届く → 100ms のバッファを置いて補間して描く
//   (パケットが 1〜2 個飛んでもカクつかない代わりに、他人は 100ms 過去を見ている)
// ・自分の丸だけは予測して即座に動かす (predict.js)

import { encodeInput, decodeSnapshot } from "../shared/protocol.js";
import { INTERP_DELAY } from "../shared/constants.js";

const BUF_MAX = 40;   // 2秒ぶん

export class Net {
  constructor() {
    this.ws = null;
    this.buf = [];             // {t(ローカル秒), tick, phase, ack, ball, players}
    this.seq = 1;
    this.you = 0;
    this.room = "";
    this.team = 0;
    this.rtt = 0.08;
    this.connected = false;
    this.on = {};              // welcome / hud / roster / ev / close
    this._pingTimer = null;
  }

  emit(k, v) { if (this.on[k]) this.on[k](v); }

  connect(url, hello) {
    return new Promise((resolve, reject) => {
      let ws;
      try { ws = new WebSocket(url); } catch (e) { reject(e); return; }
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      const fail = (e) => { this.connected = false; reject(e); };
      ws.onerror = fail;

      ws.onopen = () => {
        this.connected = true;
        ws.send(JSON.stringify({ t: "hello", ...hello }));
        this._pingTimer = setInterval(() => this.ping(), 2000);
        this.ping();
      };

      ws.onclose = (e) => {
        this.connected = false;
        clearInterval(this._pingTimer);
        this.emit("close", e);
        if (!this.you) reject(new Error(e.reason || "接続できませんでした"));
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data !== "string") { this.onSnapshot(ev.data); return; }
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        switch (m.t) {
          case "welcome":
            this.you = m.you; this.room = m.room; this.team = m.team;
            ws.onerror = null;
            this.emit("welcome", m);
            resolve(m);
            break;
          case "pong": {
            const r = (performance.now() - m.ts) / 1000;
            this.rtt = this.rtt * 0.7 + Math.min(1, r) * 0.3;   // なめらかに平均
            break;
          }
          default:
            this.emit(m.t, m);
        }
      };
    });
  }

  close() {
    clearInterval(this._pingTimer);
    if (this.ws) { this.ws.onclose = null; try { this.ws.close(); } catch { /* すでに閉じている */ } }
    this.ws = null; this.connected = false; this.you = 0; this.buf.length = 0;
  }

  ping() {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: "ping", ts: performance.now() }));
  }

  send(obj) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(obj));
  }

  sendInput(mx, my, btn) {
    if (this.ws?.readyState !== 1) return 0;
    const seq = this.seq;
    this.seq = (this.seq + 1) & 0xffff;
    this.ws.send(encodeInput(seq, mx, my, btn));
    return seq;
  }

  onSnapshot(data) {
    const s = decodeSnapshot(data);
    if (!s) return;
    s.t = performance.now() / 1000;
    this.buf.push(s);
    if (this.buf.length > BUF_MAX) this.buf.shift();
    this.emit("snapshot", s);
  }

  get latest() { return this.buf[this.buf.length - 1] || null; }

  /**
   * いま描くべき「100ms 過去の世界」を作る。
   * スナップショットが途切れたときは短時間だけ速度で外挿する。
   */
  sample(nowSec) {
    const n = this.buf.length;
    if (n === 0) return null;
    const target = nowSec - INTERP_DELAY;

    let a = null, b = null;
    for (let i = n - 1; i >= 0; i--) {
      if (this.buf[i].t <= target) { a = this.buf[i]; b = this.buf[i + 1] || null; break; }
    }
    if (!a) { a = this.buf[0]; b = this.buf[1] || null; }

    if (!b) {
      const dt = Math.min(0.15, Math.max(0, target - a.t));   // 外挿は 150ms まで
      return extrapolate(a, dt);
    }
    const span = b.t - a.t;
    const k = span > 1e-4 ? Math.min(1, Math.max(0, (target - a.t) / span)) : 0;
    return blend(a, b, k);
  }
}

function extrapolate(s, dt) {
  const ball = { ...s.ball, x: s.ball.x + s.ball.vx * dt, y: s.ball.y + s.ball.vy * dt };
  const players = s.players.map((p) => ({ ...p, x: p.x + p.vx * dt, y: p.y + p.vy * dt }));
  return { tick: s.tick, phase: s.phase, ball, players };
}

const lerp = (a, b, k) => a + (b - a) * k;

function blend(a, b, k) {
  const ball = {
    x: lerp(a.ball.x, b.ball.x, k), y: lerp(a.ball.y, b.ball.y, k),
    vx: lerp(a.ball.vx, b.ball.vx, k), vy: lerp(a.ball.vy, b.ball.vy, k),
    spin: a.ball.spin,
  };
  const map = new Map(b.players.map((p) => [p.id, p]));
  const players = [];
  for (const pa of a.players) {
    const pb = map.get(pa.id);
    if (!pb) { players.push({ ...pa }); continue; }
    players.push({
      ...pb,
      x: lerp(pa.x, pb.x, k), y: lerp(pa.y, pb.y, k),
      vx: lerp(pa.vx, pb.vx, k), vy: lerp(pa.vy, pb.vy, k),
      charge: lerp(pa.charge, pb.charge, k),
      stam: lerp(pa.stam, pb.stam, k),
    });
  }
  // b にしかいない (途中参加した) プレイヤーも出す
  for (const pb of b.players) if (!players.some((p) => p.id === pb.id)) players.push({ ...pb });
  return { tick: b.tick, phase: b.phase, ball, players };
}
