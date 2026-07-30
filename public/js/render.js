// ============ 描画 (Canvas 2D・丸と線だけ) ============
//
// 画像もフォントも読み込まない。全部その場で描くので、
// 初回ロードは HTML+CSS+JS の数十 KB だけで済む。
//
// 縦持ちのときはピッチを 90 度回して縦長に使う。さらに、
// 自分のチームがいつも「上(縦持ち) / 右(横持ち)」に攻めるように世界ごと回すので、
// どちらのチームでも操作の向きが変わらない。

import { FIELD, GOAL, PLAYER, BALL, TEAM_COLOR, CORNER_R } from "../shared/constants.js";

const HW = FIELD.w / 2, HH = FIELD.h / 2, GH = GOAL.w / 2;
const PAD = 46;

export class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.rot = 0;
    this.scale = 1;
    this.cam = { x: 0, y: 0 };
    this.zoom = 1;
    this.shake = 0;
    this.flash = 0;
    this.flashColor = "#fff";
    this.trail = [];
    this.dpr = 1;
    // 画面の上下に空けておく高さ (上: スコアボード / 下: スマホの操作ボタン)
    this.insetT = 52;
    this.insetB = 0;
    this.touchUI = false;   // true なら insetB を画面サイズから決め直す
    this.resize();
    addEventListener("resize", () => this.resize());
  }

  resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.dpr = dpr;
    this.w = innerWidth; this.h = innerHeight;
    this.cv.width = Math.round(this.w * dpr);
    this.cv.height = Math.round(this.h * dpr);
    this.cv.style.width = `${this.w}px`;
    this.cv.style.height = `${this.h}px`;
    this.portrait = this.h > this.w;
    // 画面を回しても操作ボタンぶんの余白を取り直す
    if (this.touchUI) this.insetB = Math.min(110, Math.round(this.h * 0.13));
  }

  /** ピッチを描ける高さと、その中心の画面 y (HUD とボタンを避けた範囲の真ん中) */
  get viewH() { return Math.max(200, this.h - this.insetT - this.insetB); }
  get originY() { return this.insetT + this.viewH / 2; }

  /** 自分のチームが常に前 (上/右) を向くように世界ごと回す */
  setTeam(team) {
    this.team = team;
    this.updateRot();
  }

  updateRot() {
    const flip = this.team === 1;
    this.rot = this.portrait
      ? (flip ? Math.PI / 2 : -Math.PI / 2)
      : (flip ? Math.PI : 0);
  }

  fit(ballX, ballY) {
    this.portrait = this.h > this.w;
    this.updateRot();
    // 回転後にどれだけの世界サイズが画面の横/縦に必要か
    const needX = (this.portrait ? FIELD.h : FIELD.w) + PAD * 2;
    const needY = (this.portrait ? FIELD.w : FIELD.h) + PAD * 2;
    const base = Math.min(this.w / needX, this.viewH / needY);
    this.scale = base * this.zoom;

    if (this.zoom <= 1.001) {
      this.cam.x = 0; this.cam.y = 0;
    } else {
      // 寄っているときはボールを追う (ピッチ外が見えすぎないよう制限)
      const halfW = this.w / this.scale / 2, halfH = this.viewH / this.scale / 2;
      const spanX = this.portrait ? halfH : halfW;
      const spanY = this.portrait ? halfW : halfH;
      const lx = Math.max(0, HW + PAD - spanX);
      const ly = Math.max(0, HH + PAD - spanY);
      this.cam.x += (clamp(ballX, -lx, lx) - this.cam.x) * 0.12;
      this.cam.y += (clamp(ballY, -ly, ly) - this.cam.y) * 0.12;
    }
  }

  toScreen(x, y) {
    const c = Math.cos(this.rot), s = Math.sin(this.rot);
    const dx = (x - this.cam.x) * this.scale, dy = (y - this.cam.y) * this.scale;
    return { x: this.w / 2 + c * dx - s * dy, y: this.originY + s * dx + c * dy };
  }

  /** 画面基準の方向 → 世界の方向 */
  screenToWorldDir(mx, my) {
    const c = Math.cos(-this.rot), s = Math.sin(-this.rot);
    return { x: c * mx - s * my, y: s * mx + c * my };
  }

  bump(power = 1) { this.shake = Math.min(20, this.shake + power * 9); }
  burst(color) { this.flash = 1; this.flashColor = color; }

  draw(state, self, meta, dt) {
    const ctx = this.ctx;
    const ball = state ? state.ball : { x: 0, y: 0 };
    this.fit(ball.x, ball.y);

    this.shake *= Math.exp(-dt * 6);
    this.flash *= Math.exp(-dt * 5);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#0b110e";
    ctx.fillRect(0, 0, this.w, this.h);

    const sx = (Math.random() - 0.5) * this.shake;
    const sy = (Math.random() - 0.5) * this.shake;

    ctx.save();
    ctx.translate(this.w / 2 + sx, this.originY + sy);
    ctx.rotate(this.rot);
    ctx.scale(this.scale, this.scale);
    ctx.translate(-this.cam.x, -this.cam.y);

    this.pitch(ctx);
    if (state) {
      this.ballTrail(ctx, ball, dt);
      for (const p of state.players) this.player(ctx, p, self, meta);
      this.ball(ctx, ball);
    }
    ctx.restore();

    if (state) this.labels(state, self, meta);

    if (this.flash > 0.01) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.globalAlpha = this.flash * 0.35;
      ctx.fillStyle = this.flashColor;
      ctx.fillRect(0, 0, this.w, this.h);
      ctx.globalAlpha = 1;
    }
  }

  // ------------------------------------------------------------ ピッチ

  pitch(ctx) {
    // 四隅は丸い (物理もそうなっている: 角にボールが詰まらないように)
    ctx.save();
    this.pitchPath(ctx);
    ctx.clip();
    ctx.fillStyle = "#12201a";
    ctx.fillRect(-HW, -HH, FIELD.w, FIELD.h);

    // 明るさのムラ (芝っぽさ) — 縞を数本だけ
    ctx.fillStyle = "rgba(255,255,255,.014)";
    const bands = 8, bw = FIELD.w / bands;
    for (let i = 0; i < bands; i += 2) ctx.fillRect(-HW + i * bw, -HH, bw, FIELD.h);
    ctx.restore();

    ctx.lineWidth = 2.5;
    ctx.strokeStyle = "rgba(255,255,255,.18)";
    this.pitchPath(ctx);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, -HH); ctx.lineTo(0, HH);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, 86, 0, Math.PI * 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, 5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,.18)";
    ctx.fill();

    // ペナルティエリア
    const paW = 150, paH = GOAL.w + 130;
    for (const s of [-1, 1]) {
      ctx.strokeRect(s === -1 ? -HW : HW - paW, -paH / 2, paW, paH);
    }

    // ゴール
    for (const s of [-1, 1]) {
      const team = s === -1 ? 0 : 1;         // 左を守るのがレッド
      ctx.strokeStyle = TEAM_COLOR[team];
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = TEAM_COLOR[team];
      ctx.fillRect(s === -1 ? -HW - GOAL.depth : HW, -GH, GOAL.depth, GOAL.w);
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 3;
      ctx.beginPath();
      const gx = s * HW;
      ctx.moveTo(gx, -GH);
      ctx.lineTo(gx + s * GOAL.depth, -GH);
      ctx.lineTo(gx + s * GOAL.depth, GH);
      ctx.lineTo(gx, GH);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // ポスト
      ctx.fillStyle = "#dfe9e4";
      for (const sy of [-1, 1]) {
        ctx.beginPath();
        ctx.arc(gx, sy * GH, GOAL.postR, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  pitchPath(ctx) {
    const r = CORNER_R;
    ctx.beginPath();
    ctx.moveTo(-HW + r, -HH);
    ctx.lineTo(HW - r, -HH);
    ctx.arcTo(HW, -HH, HW, -HH + r, r);
    ctx.lineTo(HW, HH - r);
    ctx.arcTo(HW, HH, HW - r, HH, r);
    ctx.lineTo(-HW + r, HH);
    ctx.arcTo(-HW, HH, -HW, HH - r, r);
    ctx.lineTo(-HW, -HH + r);
    ctx.arcTo(-HW, -HH, -HW + r, -HH, r);
    ctx.closePath();
  }

  // ------------------------------------------------------------ ボール

  ballTrail(ctx, ball, dt) {
    this.trail.push({ x: ball.x, y: ball.y, a: 1 });
    if (this.trail.length > 14) this.trail.shift();
    for (const t of this.trail) t.a -= dt * 3.4;
    ctx.fillStyle = "#fff";
    for (const t of this.trail) {
      if (t.a <= 0) continue;
      ctx.globalAlpha = t.a * 0.16;
      ctx.beginPath();
      ctx.arc(t.x, t.y, BALL.r * (0.35 + t.a * 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  ball(ctx, b) {
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL.r, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(0,0,0,.35)";
    ctx.stroke();
  }

  // ------------------------------------------------------------ プレイヤー

  player(ctx, p, self, meta) {
    const me = self && p.id === self.id;
    const x = me ? self.x : p.x;
    const y = me ? self.y : p.y;
    const col = TEAM_COLOR[p.team];

    // ダッシュ中は残像
    if (p.dashing) {
      ctx.globalAlpha = 0.25;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x - p.vx * 0.045, y - p.vy * 0.045, PLAYER.r * 0.95, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.beginPath();
    ctx.arc(x, y, PLAYER.r, 0, Math.PI * 2);
    ctx.fillStyle = p.stunned ? mix(col, "#20302a", 0.55) : col;
    ctx.globalAlpha = p.bot ? 0.72 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;

    ctx.lineWidth = me ? 3.5 : 2;
    ctx.strokeStyle = me ? "#ffffff" : "rgba(0,0,0,.35)";
    ctx.stroke();

    // チャージ (溜め) のリング
    if (p.charging && p.charge > 0.02) {
      ctx.beginPath();
      ctx.arc(x, y, PLAYER.r + 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p.charge);
      ctx.lineWidth = 3.5;
      ctx.strokeStyle = p.charge > 0.92 ? "#ffe066" : "#46e39b";
      ctx.stroke();
    }
    if (p.stunned) {
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = "rgba(255,255,255,.7)";
      const r = PLAYER.r * 0.5;
      ctx.beginPath();
      ctx.moveTo(x - r, y - r); ctx.lineTo(x + r, y + r);
      ctx.moveTo(x + r, y - r); ctx.lineTo(x - r, y + r);
      ctx.stroke();
    }
    // 自分は向きも見せる (止まっていてもどっちに蹴るか分かる)
    if (me) {
      const a = Math.hypot(self.aimX, self.aimY) || 1;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + (self.aimX / a) * (PLAYER.r + 9), y + (self.aimY / a) * (PLAYER.r + 9));
      ctx.lineWidth = 3;
      ctx.strokeStyle = "rgba(255,255,255,.5)";
      ctx.stroke();
    }
  }

  // ------------------------------------------------------------ 名前 (画面座標で描く)

  labels(state, self, meta) {
    if (this.scale < 0.42) return;             // 小さすぎるときは出さない
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = "600 11px -apple-system, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "bottom";
    for (const p of state.players) {
      const info = meta?.get(p.id);
      if (!info || info.bot) continue;
      const me = self && p.id === self.id;
      const w = this.toScreen(me ? self.x : p.x, me ? self.y : p.y);
      ctx.fillStyle = me ? "#ffffff" : "rgba(231,240,236,.72)";
      ctx.fillText(info.name, w.x, w.y - PLAYER.r * this.scale - 5);
    }
  }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

function mix(a, b, k) {
  const pa = hex(a), pb = hex(b);
  const c = pa.map((v, i) => Math.round(v + (pb[i] - v) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
function hex(h) {
  const v = h.replace("#", "");
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
}
