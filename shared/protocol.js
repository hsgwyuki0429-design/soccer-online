// ============ 通信フォーマット ============
//
// 毎フレーム流れるもの(入力とスナップショット)だけバイナリ、
// 参加/得点/チャットのような「たまにしか来ないもの」は JSON テキスト。
// WebSocket は同じ接続でテキストとバイナリを混ぜられるので、
// 受信側は typeof data === "string" で振り分ける。
//
//  入力     (C→S) : 6 byte      → 30Hz で 180 B/s
//  スナップ (S→C) : 16 + 12*人  → 6人 20Hz でも約 1.8 KB/s
//
// これくらいならモバイル回線でも余裕で、サーバ側の帯域もほぼ無料枠に収まる。

import { MSG, POS_SCALE, FLAG } from "./constants.js";

const HEAD = 7;          // type(1) + tick(2) + ack(2) + phase(1) + count(1)
const BALL_B = 9;        // x,y,vx,vy (i16*4) + spin (i8)
const PL_B = 12;         // id(1) + x,y,vx,vy(i16*4) + flags(1) + stam(1) + charge(1)

/** ArrayBuffer / Buffer / TypedArray → DataView */
function view(data) {
  if (data instanceof DataView) return data;
  if (data instanceof ArrayBuffer) return new DataView(data);
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

const q = (v) => Math.max(-32768, Math.min(32767, Math.round(v * POS_SCALE)));

// ---------------------------------------------------------------- 入力

export function encodeInput(seq, mx, my, btn) {
  const b = new ArrayBuffer(6);
  const d = new DataView(b);
  d.setUint8(0, MSG.INPUT);
  d.setUint16(1, seq & 0xffff);
  d.setInt8(3, Math.max(-100, Math.min(100, Math.round(mx * 100))));
  d.setInt8(4, Math.max(-100, Math.min(100, Math.round(my * 100))));
  d.setUint8(5, btn & 0xff);
  return b;
}

export function decodeInput(data) {
  const d = view(data);
  if (d.byteLength < 6 || d.getUint8(0) !== MSG.INPUT) return null;
  return {
    seq: d.getUint16(1),
    mx: d.getInt8(3) / 100,
    my: d.getInt8(4) / 100,
    btn: d.getUint8(5),
  };
}

// ---------------------------------------------------------------- スナップショット

/**
 * @param tick   サーバのティック番号 (u16 でラップ)
 * @param ack    その相手から最後に受け取った入力の seq
 * @param phase  試合フェーズ番号
 * @param ball   ボール
 * @param players プレイヤー配列
 */
export function encodeSnapshot(tick, ack, phase, ball, players) {
  const n = Math.min(players.length, 255);
  const buf = new ArrayBuffer(HEAD + BALL_B + PL_B * n);
  const d = new DataView(buf);
  d.setUint8(0, MSG.SNAPSHOT);
  d.setUint16(1, tick & 0xffff);
  d.setUint16(3, ack & 0xffff);
  d.setUint8(5, phase);
  d.setUint8(6, n);

  let o = HEAD;
  d.setInt16(o, q(ball.x)); d.setInt16(o + 2, q(ball.y));
  d.setInt16(o + 4, q(ball.vx)); d.setInt16(o + 6, q(ball.vy));
  d.setInt8(o + 8, Math.max(-127, Math.min(127, Math.round(ball.spin * 100))));
  o += BALL_B;

  for (let i = 0; i < n; i++) {
    const p = players[i];
    let f = 0;
    if (p.team === 1) f |= FLAG.TEAM;
    if (p.charging) f |= FLAG.CHARGING;
    if (p.dash > 0) f |= FLAG.DASHING;
    if (p.stun > 0) f |= FLAG.STUNNED;
    if (p.bot) f |= FLAG.BOT;
    d.setUint8(o, p.id & 0xff);
    d.setInt16(o + 1, q(p.x)); d.setInt16(o + 3, q(p.y));
    d.setInt16(o + 5, q(p.vx)); d.setInt16(o + 7, q(p.vy));
    d.setUint8(o + 9, f);
    d.setUint8(o + 10, Math.max(0, Math.min(255, Math.round(p.stam * 2.55))));
    d.setUint8(o + 11, Math.max(0, Math.min(255, Math.round((p.chargeRatio || 0) * 255))));
    o += PL_B;
  }
  return buf;
}

export function decodeSnapshot(data) {
  const d = view(data);
  if (d.byteLength < HEAD + BALL_B || d.getUint8(0) !== MSG.SNAPSHOT) return null;
  const tick = d.getUint16(1);
  const ack = d.getUint16(3);
  const phase = d.getUint8(5);
  const n = d.getUint8(6);

  let o = HEAD;
  const ball = {
    x: d.getInt16(o) / POS_SCALE, y: d.getInt16(o + 2) / POS_SCALE,
    vx: d.getInt16(o + 4) / POS_SCALE, vy: d.getInt16(o + 6) / POS_SCALE,
    spin: d.getInt8(o + 8) / 100,
  };
  o += BALL_B;

  const players = [];
  for (let i = 0; i < n && o + PL_B <= d.byteLength; i++) {
    const f = d.getUint8(o + 9);
    players.push({
      id: d.getUint8(o),
      x: d.getInt16(o + 1) / POS_SCALE, y: d.getInt16(o + 3) / POS_SCALE,
      vx: d.getInt16(o + 5) / POS_SCALE, vy: d.getInt16(o + 7) / POS_SCALE,
      team: (f & FLAG.TEAM) ? 1 : 0,
      charging: !!(f & FLAG.CHARGING),
      dashing: !!(f & FLAG.DASHING),
      stunned: !!(f & FLAG.STUNNED),
      bot: !!(f & FLAG.BOT),
      stam: d.getUint8(o + 10) / 2.55,
      charge: d.getUint8(o + 11) / 255,
    });
    o += PL_B;
  }
  return { tick, ack, phase, ball, players };
}
