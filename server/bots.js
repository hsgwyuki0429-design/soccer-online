// ============ BOT ============
//
// 「誰もいなくても必ず試合が始まる」ようにするための埋め合わせ。
// 賢すぎると人間が触れないので、反応の遅さ・狙いのブレ・迷いを混ぜて弱くしてある。
// 出力は人間とまったく同じ入力 ({mx,my,btn}) なので、物理側は BOT を区別しない。

import { FIELD, GOAL, PLAYER, BALL, BTN, CORNER_R } from "../shared/constants.js";

const HW = FIELD.w / 2;
const HH = FIELD.h / 2;

export function newBrain() {
  return {
    t: 0,                                  // 次に考え直すまで
    skill: 0.5 + Math.random() * 0.4,      // 0.5(のろま) 〜 0.9(そこそこ)
    ox: 0, oy: 0,                          // 狙いのブレ
    kick: 0,                               // キックを押し続ける残り時間
    release: false,                        // 次のtickで離す
    dash: false,
    role: 1,
    tx: 0, ty: 0,
  };
}

export function botInput(room, me, dt) {
  const b = me.brain;
  const ball = room.ball;
  const sign = me.team === 0 ? -1 : 1;      // 自陣の向き
  const oppX = -sign * HW;                  // 攻めるゴール
  const ownX = sign * HW;

  b.t -= dt;
  if (b.t <= 0) {
    b.t = 0.18 - 0.1 * b.skill + Math.random() * 0.08;   // 反応の間隔
    const blur = 90 * (1 - b.skill);
    b.ox = (Math.random() * 2 - 1) * blur;
    b.oy = (Math.random() * 2 - 1) * blur;
    decide(room, me, b, ball, oppX, ownX);
  }

  // --- 目標地点へ向かう ---
  let dx = b.tx - me.x, dy = b.ty - me.y;
  const d = Math.hypot(dx, dy) || 1;
  let mx = dx / d, my = dy / d;
  if (d < 12) { mx *= d / 12; my *= d / 12; }   // 目標に着いたら止まる

  let btn = 0;

  // --- キック (押し込み → 離す) ---
  if (b.release) { b.release = false; b.kick = 0; }
  else if (b.kick > 0) {
    b.kick -= dt;
    if (b.kick <= 0) b.release = true;         // 次のtickで離す = 蹴る
    else btn |= BTN.KICK;
  }

  // --- ダッシュ ---
  if (b.dash) { btn |= BTN.DASH; b.dash = false; }

  return { mx, my, btn };
}

function decide(room, me, b, ball, oppX, ownX) {
  const mates = room.ents.filter((e) => e.team === me.team);
  const foes = room.ents.filter((e) => e.team !== me.team);
  const dist = (e) => Math.hypot(ball.x - e.x, ball.y - e.y);

  const order = [...mates].sort((p, q) => dist(p) - dist(q));
  const rank = order.indexOf(me);
  const myDist = dist(me);

  // 「ボールが自陣に近いほど守りに寄る」ための重み
  const pressure = (ball.x * Math.sign(ownX) + HW) / (HW * 2);   // 0(敵陣) 〜 1(自陣)

  if (rank === 0) {
    // --- 一番近い = 追う ---
    b.role = 0;
    // ボールの少し先を読む (速いほど先回り)
    const lead = 0.18 * b.skill;
    const px = ball.x + ball.vx * lead;
    const py = ball.y + ball.vy * lead;

    // ゴールと反対側に回り込んで押し込む。
    // ただし隅にあるボールは「回り込む位置がピッチの外」になるので、
    // その場合は素直に体でぶつかりに行く (壁ぎわを押して転がす)。
    const back = PLAYER.r + BALL.r - 4;
    let spot = behind(px, py, oppX, 0, back);
    if (!inside(spot)) spot = behind(px, py, oppX * 0.35, py * 0.4, back);
    if (!inside(spot)) spot = { x: px, y: py };          // 直接ぶつかる
    b.tx = spot.x + b.ox * 0.35;
    b.ty = spot.y + b.oy * 0.35;

    // 届くならシュート / パス。自陣ゴールへ蹴り込まないよう向きを見る
    if (myDist < PLAYER.r + BALL.r + PLAYER.kickRange + 20 && b.kick <= 0 && !b.release) {
      const toGoal = Math.hypot(oppX - me.x, 0 - me.y);
      const aim = ((ball.x - me.x) * (oppX - ball.x) + (ball.y - me.y) * (0 - ball.y));
      const deep = Math.abs(ball.x - ownX) < FIELD.w * 0.28;    // 自陣深く = とにかくクリア
      if (aim > 0 || deep) {
        // 遠いほど強く溜める。近ければ流し込む
        const charge = toGoal > 520 ? 0.55 + Math.random() * 0.3
          : toGoal > 260 ? 0.3 + Math.random() * 0.3
            : 0.05 + Math.random() * 0.2;
        b.kick = charge * PLAYER.kickCharge * (0.6 + b.skill * 0.6);
      }
    }
    // 相手が持っていて自分が後ろから → 体当たり
    const holder = nearestHolder(foes, ball);
    if (holder && Math.hypot(holder.x - me.x, holder.y - me.y) < 70 && me.stam > 45) {
      b.dash = Math.random() < 0.35 + b.skill * 0.3;
    }
  } else if (rank === 1) {
    // --- 二番手 = ボールと自陣の間で待つ (こぼれ球を拾う) ---
    b.role = 1;
    const k = 0.35 + pressure * 0.25;
    b.tx = ball.x + (ownX - ball.x) * k + b.ox;
    b.ty = ball.y * 0.75 + b.oy;
  } else {
    // --- 最後尾 = ゴール前を守る ---
    b.role = 2;
    const keepX = ownX - Math.sign(ownX) * (110 + (1 - pressure) * 190);
    b.tx = keepX + b.ox * 0.4;
    b.ty = clamp(ball.y * 0.55, -GOAL.w * 0.75, GOAL.w * 0.75) + b.oy * 0.4;
    // 目の前まで来たらクリア
    if (Math.hypot(ball.x - me.x, ball.y - me.y) < PLAYER.r + BALL.r + PLAYER.kickRange + 20
      && b.kick <= 0 && !b.release) {
      b.kick = 0.7 * PLAYER.kickCharge;
    }
  }

  b.tx = clamp(b.tx, -HW + PLAYER.r, HW - PLAYER.r);
  b.ty = clamp(b.ty, -HH + PLAYER.r, HH - PLAYER.r);
}

/** 狙う先 (ax,ay) に向かって蹴れる立ち位置 = ボールの反対側 */
function behind(bx, by, ax, ay, back) {
  const gx = ax - bx, gy = ay - by;
  const gd = Math.hypot(gx, gy) || 1;
  return { x: bx - (gx / gd) * back, y: by - (gy / gd) * back };
}

/** そこにプレイヤーが立てるか (丸めた四隅の外は立てない) */
function inside(p) {
  if (Math.abs(p.x) >= HW - PLAYER.r || Math.abs(p.y) >= HH - PLAYER.r) return false;
  const cx = Math.sign(p.x) * (HW - CORNER_R), cy = Math.sign(p.y) * (HH - CORNER_R);
  if (Math.abs(p.x) > Math.abs(cx) && Math.abs(p.y) > Math.abs(cy)) {
    return Math.hypot(p.x - cx, p.y - cy) < CORNER_R - PLAYER.r;
  }
  return true;
}

function nearestHolder(foes, ball) {
  let best = null, bd = 1e9;
  for (const f of foes) {
    const d = Math.hypot(ball.x - f.x, ball.y - f.y);
    if (d < bd) { bd = d; best = f; }
  }
  return bd < PLAYER.r + BALL.r + 30 ? best : null;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
