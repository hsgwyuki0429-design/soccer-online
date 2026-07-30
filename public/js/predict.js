// ============ 自機予測 + ボールの先出し ============
//
// ネットゲームでいちばん気持ち悪いのは「キーを押してから自分が動くまでの遅れ」。
// なので自分の丸だけはサーバを待たずに、サーバとまったく同じ物理 (shared/physics.js) で
// ローカルに動かす。サーバから正解が届いたら、その差ぶんを"見た目には出さずに"直して、
// あとからじわっと寄せる (誤差スムージング)。
//
// ボールは全員が触るので予測しきれない。代わりに
// 「自分が蹴った/触れた瞬間だけ、描画位置にオフセットを足して先に動かす」。
// 本物の軌道が 100〜200ms 後に追いついてきて、オフセットは消えていく。

import { createPlayer, stepPlayer } from "../shared/physics.js";
import { PLAYER, BALL } from "../shared/constants.js";

const SNAP_DIST = 150;     // これ以上ズレたら諦めてワープ
const VIS_MAX = 70;        // 見た目のズレの上限
const VIS_RATE = 11;       // 誤差を消す速さ (1/s)

export class SelfPredictor {
  constructor(id, team) {
    this.p = createPlayer(id, team);
    this.hist = [];                 // {t, x, y, vx, vy}
    this.vex = 0; this.vey = 0;     // 見た目のズレ
    this.ready = false;
  }

  hardSet(s) {
    Object.assign(this.p, {
      x: s.x, y: s.y, vx: s.vx, vy: s.vy, team: s.team,
      stam: s.stam ?? this.p.stam,
    });
    this.hist.length = 0;
    this.vex = 0; this.vey = 0;
    this.ready = true;
  }

  step(input, dt, nowSec) {
    const released = stepPlayer(this.p, input, dt);
    this.hist.push({ t: nowSec, x: this.p.x, y: this.p.y, vx: this.p.vx, vy: this.p.vy });
    if (this.hist.length > 200) this.hist.shift();

    const k = Math.exp(-VIS_RATE * dt);
    this.vex *= k; this.vey *= k;
    return released;
  }

  /** サーバの正解 (rtt ぶん過去の状態) と突き合わせる */
  reconcile(s, rtt, nowSec) {
    if (!this.ready) { this.hardSet(s); return; }
    const h = this.at(nowSec - Math.min(0.5, rtt));
    if (!h) return;

    const ex = s.x - h.x, ey = s.y - h.y;
    const d = Math.hypot(ex, ey);
    if (d > SNAP_DIST) { this.hardSet(s); return; }
    if (d < 0.05) return;

    // 状態は即座に直す。ただし同じぶんを"見た目のズレ"に足すので画面は飛ばない
    this.p.x += ex; this.p.y += ey;
    this.vex += ex; this.vey += ey;
    const vd = Math.hypot(this.vex, this.vey);
    if (vd > VIS_MAX) { this.vex *= VIS_MAX / vd; this.vey *= VIS_MAX / vd; }

    // 過去の記録もずらす (同じ誤差を何度も足し込まないため)
    for (const e of this.hist) { e.x += ex; e.y += ey; }

    // 速度は半分だけ寄せる (予測と喧嘩させない)
    this.p.vx += (s.vx - h.vx) * 0.5;
    this.p.vy += (s.vy - h.vy) * 0.5;
    if (typeof s.stam === "number") this.p.stam = this.p.stam * 0.5 + s.stam * 0.5;
    if (s.stunned && this.p.stun <= 0) this.p.stun = 0.15;
  }

  at(t) {
    const h = this.hist;
    if (h.length === 0) return null;
    if (t <= h[0].t) return h[0];
    if (t >= h[h.length - 1].t) return h[h.length - 1];
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].t <= t) {
        const a = h[i - 1], b = h[i];
        const k = (t - a.t) / Math.max(1e-6, b.t - a.t);
        return {
          x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k,
          vx: a.vx + (b.vx - a.vx) * k, vy: a.vy + (b.vy - a.vy) * k,
        };
      }
    }
    return h[0];
  }

  /** 描画に使う座標 (誤差を隠したもの) */
  view() {
    return { ...this.p, x: this.p.x - this.vex, y: this.p.y - this.vey };
  }
}

/**
 * ボールの「先出し」オフセット。
 * 描画位置 = 補間されたボール + offset。offset は自分の操作で生まれて、すぐ消える。
 */
export class BallLead {
  constructor() { this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; }

  /** 自分が蹴った瞬間: 目標の速度との差ぶんを一気に載せる */
  kick(dirX, dirY, speed, curVx, curVy) {
    this.vx += dirX * speed - curVx;
    this.vy += dirY * speed - curVy;
    const m = Math.hypot(this.vx, this.vy);
    if (m > BALL.maxSpeed) { this.vx *= BALL.maxSpeed / m; this.vy *= BALL.maxSpeed / m; }
  }

  step(dt) {
    this.x += this.vx * dt;
    this.y += this.vy * dt;
    this.vx *= Math.exp(-dt / 0.16);
    this.vy *= Math.exp(-dt / 0.16);
    this.x *= Math.exp(-dt / 0.26);
    this.y *= Math.exp(-dt / 0.26);
  }

  /** 体が触れている間は、描画上ボールが体にめり込まないよう押し出す */
  contact(px, py, bx, by) {
    const dx = bx - px, dy = by - py;
    const d = Math.hypot(dx, dy);
    const min = PLAYER.r + BALL.r;
    if (d >= min || d < 1e-4) return;
    const push = min - d;
    this.x += (dx / d) * push;
    this.y += (dy / d) * push;
  }
}
