// ============ 物理 (サーバ権威シミュレーション / クライアント予測 共用) ============
//
// ぜんぶ「丸」しかない。プレイヤーもボールも円で、当たり判定は距離だけ。
// グラフィックが無いぶん、手ざわりはここのパラメータでほぼ決まる。
//
// 重要: クライアントの自機予測は stepPlayer() を「まったく同じ dt」で呼ぶ。
// ここに乱数や時刻依存を持ち込むと予測がズレるので入れないこと。

import { FIELD, GOAL, PLAYER, BALL, BTN, CORNER_R } from "./constants.js";

const HW = FIELD.w / 2;
const HH = FIELD.h / 2;
const GH = GOAL.w / 2;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const len = (x, y) => Math.hypot(x, y);

// ---------------------------------------------------------------- 生成

export function createPlayer(id, team) {
  return {
    id, team,
    x: 0, y: 0, vx: 0, vy: 0,
    aimX: team === 0 ? 1 : -1, aimY: 0,   // 最後に向いていた方向 (止まっていても蹴れるように)
    charge: 0,         // キックの溜め (秒)
    charging: false,
    kickCd: 0,
    dash: 0,           // ダッシュの残り時間
    dashCd: 0,
    stam: PLAYER.stamMax,
    stun: 0,
    prevKick: false,   // 押しっぱなし検出用
    prevDash: false,
  };
}

export function createBall() {
  return { x: 0, y: 0, vx: 0, vy: 0, spin: 0, lastTouch: -1, lastTouchTeam: -1 };
}

export function emptyInput() {
  return { mx: 0, my: 0, btn: 0 };
}

// ---------------------------------------------------------------- プレイヤー

/**
 * プレイヤー 1 体を 1 ステップ進める。
 * 他プレイヤー / ボールとの衝突は含まない (クライアント予測を軽く保つため)。
 * 戻り値: このステップで「キックを離した」なら威力(0〜1)、でなければ -1。
 */
export function stepPlayer(p, input, dt) {
  const kickHeld = (input.btn & BTN.KICK) !== 0;
  const dashHeld = (input.btn & BTN.DASH) !== 0;

  if (p.stun > 0) p.stun = Math.max(0, p.stun - dt);
  if (p.kickCd > 0) p.kickCd = Math.max(0, p.kickCd - dt);
  if (p.dashCd > 0) p.dashCd = Math.max(0, p.dashCd - dt);
  if (p.dash > 0) p.dash = Math.max(0, p.dash - dt);

  const frozen = p.stun > 0;

  // --- ダッシュ (押した瞬間だけ) ---
  if (dashHeld && !p.prevDash && !frozen && p.dashCd <= 0 && p.stam >= PLAYER.dashCost) {
    p.dash = PLAYER.dashTime;
    p.dashCd = PLAYER.dashCooldown;
    p.stam -= PLAYER.dashCost;
  }
  p.prevDash = dashHeld;
  p.stam = Math.min(PLAYER.stamMax, p.stam + PLAYER.stamRegen * dt);

  // --- キックのチャージ ---
  let released = -1;
  if (frozen) {
    p.charging = false; p.charge = 0;
  } else if (kickHeld) {
    p.charging = true;
    p.charge = Math.min(PLAYER.kickCharge, p.charge + dt);
  } else if (p.prevKick && p.charging) {
    released = clamp(p.charge / PLAYER.kickCharge, 0, 1);
    p.charging = false;
    p.charge = 0;
  } else {
    p.charging = false;
    p.charge = 0;
  }
  p.prevKick = kickHeld;

  // --- 移動 ---
  const mlen = len(input.mx, input.my);
  let ax = 0, ay = 0;
  if (mlen > 0.05 && !frozen) {
    const nx = input.mx / mlen, ny = input.my / mlen;
    const scale = Math.min(1, mlen);           // アナログ入力 (スティックの倒し量)
    let accel = PLAYER.accel * scale;
    if (p.dash > 0) accel *= PLAYER.dashAccel;
    else if (p.charging) accel *= PLAYER.chargeSlow;
    ax = nx * accel; ay = ny * accel;
    p.aimX = nx; p.aimY = ny;
  }

  p.vx += ax * dt;
  p.vy += ay * dt;

  // 減衰は 60Hz 基準の係数を dt に合わせて補正する
  const d = Math.pow(PLAYER.damp, dt * 60);
  p.vx *= d; p.vy *= d;

  let maxV = PLAYER.maxSpeed;
  if (p.dash > 0) maxV *= PLAYER.dashMax;
  else if (p.charging) maxV *= PLAYER.chargeSlow;
  const sp = len(p.vx, p.vy);
  if (sp > maxV) { const k = maxV / sp; p.vx *= k; p.vy *= k; }

  p.x += p.vx * dt;
  p.y += p.vy * dt;

  // --- ピッチの外には出られない (ゴールの中にも入れない) ---
  const lim = PLAYER.r;
  if (p.x < -HW + lim) { p.x = -HW + lim; if (p.vx < 0) p.vx *= -0.2; }
  if (p.x > HW - lim) { p.x = HW - lim; if (p.vx > 0) p.vx *= -0.2; }
  if (p.y < -HH + lim) { p.y = -HH + lim; if (p.vy < 0) p.vy *= -0.2; }
  if (p.y > HH - lim) { p.y = HH - lim; if (p.vy > 0) p.vy *= -0.2; }
  cornerClamp(p, PLAYER.r, 0.2);

  return released;
}

/**
 * 丸めた四隅の壁。角の内側 (半径 CORNER_R の円弧) から外へは出られない。
 * 円弧なので、少しでも斜めから押すとボールは角に沿って滑り出す。
 */
export function cornerClamp(o, r, bounce) {
  const max = CORNER_R - r;
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      const cx = sx * (HW - CORNER_R), cy = sy * (HH - CORNER_R);
      const dx = o.x - cx, dy = o.y - cy;
      if (sx * dx <= 0 || sy * dy <= 0) continue;      // その角のエリアにいない
      const d = len(dx, dy);
      if (d <= max || d < 1e-6) continue;
      const nx = dx / d, ny = dy / d;
      o.x = cx + nx * max;
      o.y = cy + ny * max;
      const dot = o.vx * nx + o.vy * ny;
      if (dot > 0) { o.vx -= (1 + bounce) * dot * nx; o.vy -= (1 + bounce) * dot * ny; }
    }
  }
}

/** 蹴れる距離にボールがあるか */
export function canKick(p, ball) {
  const d = len(ball.x - p.x, ball.y - p.y);
  return d <= PLAYER.r + BALL.r + PLAYER.kickRange;
}

/**
 * キックを実行する。power は 0(タップ) 〜 1(フルチャージ)。
 * 方向は「プレイヤー → ボール」。走っている勢いが少し乗り、
 * 横に走りながら蹴るとスピンがかかって曲がる。
 */
export function applyKick(p, ball, power) {
  let dx = ball.x - p.x, dy = ball.y - p.y;
  let d = len(dx, dy);
  if (d < 1e-4) { dx = p.aimX; dy = p.aimY; d = 1; }
  const nx = dx / d, ny = dy / d;

  const speed = PLAYER.kickMin + (PLAYER.kickMax - PLAYER.kickMin) * power;
  const inherit = (p.vx * nx + p.vy * ny) * PLAYER.kickInherit;   // 前向きの勢いだけ乗せる
  const v = speed + Math.max(0, inherit);

  ball.vx = nx * v;
  ball.vy = ny * v;

  // 蹴る向きに対して横に流れている速度 → スピン
  const cross = nx * p.vy - ny * p.vx;
  ball.spin = clamp(ball.spin + cross * BALL.spinFromKick, -BALL.spinMax, BALL.spinMax);

  ball.lastTouch = p.id;
  ball.lastTouchTeam = p.team;
  p.kickCd = PLAYER.kickCooldown;
  return v;
}

// ---------------------------------------------------------------- ボール

/** ボールを 1 ステップ。戻り値: 0/1 = そのチームの得点、-1 = 得点なし */
export function stepBall(ball, dt) {
  // スピンによる曲がり (速度ベクトルを少しずつ回す)
  if (Math.abs(ball.spin) > 1e-3) {
    const a = ball.spin * BALL.spinForce * dt;
    const c = Math.cos(a), s = Math.sin(a);
    const vx = ball.vx * c - ball.vy * s;
    const vy = ball.vx * s + ball.vy * c;
    ball.vx = vx; ball.vy = vy;
    ball.spin *= Math.pow(BALL.spinDamp, dt * 60);
  } else ball.spin = 0;

  const d = Math.pow(BALL.damp, dt * 60);
  ball.vx *= d; ball.vy *= d;

  const sp = len(ball.vx, ball.vy);
  if (sp > BALL.maxSpeed) { const k = BALL.maxSpeed / sp; ball.vx *= k; ball.vy *= k; }
  if (sp < 3) { ball.vx = 0; ball.vy = 0; }

  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;

  const r = BALL.r;

  // 上下のタッチライン (壁)
  if (ball.y < -HH + r) { ball.y = -HH + r; ball.vy = Math.abs(ball.vy) * BALL.wallBounce; }
  if (ball.y > HH - r) { ball.y = HH - r; ball.vy = -Math.abs(ball.vy) * BALL.wallBounce; }

  // ゴールポスト (静止した円) — 枠に当たると弾かれる
  for (const sx of [-1, 1]) {
    for (const sy of [-1, 1]) {
      bounceOffPost(ball, sx * HW, sy * GH);
    }
  }

  cornerClamp(ball, BALL.r, BALL.wallBounce);

  const inMouth = Math.abs(ball.y) < GH;
  if (!inMouth) {
    // ゴール枠の外 → 横の壁で跳ね返る
    if (ball.x < -HW + r) { ball.x = -HW + r; ball.vx = Math.abs(ball.vx) * BALL.wallBounce; }
    if (ball.x > HW - r) { ball.x = HW - r; ball.vx = -Math.abs(ball.vx) * BALL.wallBounce; }
  } else {
    // ゴールの中 → ラインを割ったら得点
    if (ball.x < -HW) return 1;   // 左ゴール = ブルーの得点
    if (ball.x > HW) return 0;    // 右ゴール = レッドの得点
  }
  return -1;
}

function bounceOffPost(ball, px, py) {
  const dx = ball.x - px, dy = ball.y - py;
  const d = len(dx, dy);
  const min = BALL.r + GOAL.postR;
  if (d >= min || d < 1e-6) return;
  const nx = dx / d, ny = dy / d;
  ball.x = px + nx * min;
  ball.y = py + ny * min;
  const dot = ball.vx * nx + ball.vy * ny;
  if (dot < 0) {
    ball.vx -= (1 + BALL.wallBounce) * dot * nx;
    ball.vy -= (1 + BALL.wallBounce) * dot * ny;
  }
}

// ---------------------------------------------------------------- 衝突

/** プレイヤーがボールを押す (触れているだけでドリブルになる) */
export function collidePlayerBall(p, ball) {
  const dx = ball.x - p.x, dy = ball.y - p.y;
  const d = len(dx, dy);
  const min = PLAYER.r + BALL.r;
  if (d >= min || d < 1e-6) return false;

  const nx = dx / d, ny = dy / d;
  // めり込みはボール側だけ押し出す (プレイヤーの操作感を壊さない)
  ball.x = p.x + nx * min;
  ball.y = p.y + ny * min;

  // プレイヤーは体当たりで減速しない (操作感優先) ので、
  // 「重い壁に当たったボール」として相対速度だけ反転させる。
  const rel = (ball.vx - p.vx) * nx + (ball.vy - p.vy) * ny;
  if (rel < 0) {
    const j = -(1 + 0.35) * rel;
    ball.vx += nx * j;
    ball.vy += ny * j;
    // 走り込んだぶんを上乗せ = 足元で前に転がる感じ (ドリブル)
    const push = Math.max(0, p.vx * nx + p.vy * ny);
    ball.vx += nx * push * 0.55;
    ball.vy += ny * push * 0.55;
  }
  ball.lastTouch = p.id;
  ball.lastTouchTeam = p.team;
  return true;
}

/**
 * プレイヤー同士。ダッシュ中に当てると相手を吹き飛ばしてスタンさせる (タックル)。
 * 戻り値: タックルが成立したら {by, to}、でなければ null
 */
export function collidePlayers(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = len(dx, dy);
  const min = PLAYER.r * 2;
  if (d >= min || d < 1e-6) return null;

  const nx = dx / d, ny = dy / d;
  const overlap = (min - d) / 2;
  a.x -= nx * overlap; a.y -= ny * overlap;
  b.x += nx * overlap; b.y += ny * overlap;

  const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
  if (rel < 0) {
    const j = -(1 + PLAYER.bounce) * rel / 2;
    a.vx -= nx * j; a.vy -= ny * j;
    b.vx += nx * j; b.vy += ny * j;
  }

  // タックル判定 (敵同士 & 片方がダッシュ中)
  if (a.team !== b.team) {
    const aDash = a.dash > 0, bDash = b.dash > 0;
    if (aDash && !bDash) return tackle(a, b, nx, ny);
    if (bDash && !aDash) return tackle(b, a, -nx, -ny);
  }
  return null;
}

function tackle(by, to, nx, ny) {
  to.vx += nx * PLAYER.tackleImpulse;
  to.vy += ny * PLAYER.tackleImpulse;
  to.stun = PLAYER.stunTime;
  to.charging = false; to.charge = 0;
  by.dash = 0;                       // 当てたらダッシュは終わり (連続タックル防止)
  by.vx *= 0.45; by.vy *= 0.45;
  return { by: by.id, to: to.id };
}

// ---------------------------------------------------------------- 配置

/** キックオフの立ち位置 (チーム内 index ごとに散らす) */
export function kickoffSpot(team, index, attacking) {
  const side = team === 0 ? -1 : 1;
  const rows = [0, -1, 1, -2, 2, -3, 3];
  const row = rows[index % rows.length];
  const depth = attacking ? 0.16 : 0.34;
  return {
    x: side * (HW * depth + (index === 0 ? 0 : HW * 0.14)),
    y: row * (HH * 0.34),
  };
}

export const BOUNDS = { HW, HH, GH };
