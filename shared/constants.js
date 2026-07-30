// ============ 共有定数 (サーバ / クライアントの両方が読む) ============
// このファイルは Node からも <script type="module"> からもそのまま import される。
// Node 専用 API は絶対に書かないこと。

// ---- ループ ----
export const TICK_HZ = 60;             // 物理ステップ (サーバ権威 / クライアント予測とも同じ)
export const DT = 1 / TICK_HZ;
export const SNAP_EVERY = 3;           // 3tick ごとにスナップショット送信 = 20Hz
export const INPUT_HZ = 30;            // 入力送信レート
export const INTERP_DELAY = 0.1;       // 他プレイヤー/ボールの補間遅延 (秒)

// ---- ピッチ ----
// 原点はセンターサークル。x: 左(-) ⇔ 右(+)、y: 上(-) ⇔ 下(+)
export const FIELD = { w: 1160, h: 640 };
export const GOAL = { w: 190, depth: 48, postR: 7 };

// 四隅は丸めてある。直角のままだと、隅に入ったボールを押し出す立ち位置が
// 「ピッチの外」にしか無くなって、永久に取り出せなくなるため
// (人でもBOTでも同じことが起きる)。曲面なら少し斜めに押すだけで転がり出る。
export const CORNER_R = 88;

// ---- プレイヤー (丸) ----
export const PLAYER = {
  r: 15,
  accel: 1200,          // u/s^2
  damp: 0.94,           // 1tick あたりの減衰 → 終端速度 ≒ accel*DT/(1-damp)
  maxSpeed: 335,        // u/s
  bounce: 0.4,          // プレイヤー同士の反発

  // キック (押しっぱなしでチャージ、離すと蹴る)
  kickRange: 13,        // 体の表面からこの距離までボールに届く
  kickMin: 320,         // タップ蹴り (パス)
  kickMax: 790,         // フルチャージ (シュート)
  kickCharge: 0.75,     // フルチャージまでの秒数
  kickCooldown: 0.22,
  kickInherit: 0.35,    // 走っている速度がどれだけ乗るか
  chargeSlow: 0.62,     // チャージ中の移動性能 (溜めるほど無防備)

  // ダッシュ (スタミナ消費) と体当たり
  dashCost: 30,
  dashTime: 0.3,
  dashAccel: 2.5,
  dashMax: 1.5,
  dashCooldown: 0.5,
  stamMax: 100,
  stamRegen: 22,        // /s
  tackleImpulse: 340,   // ダッシュ体当たりのノックバック
  stunTime: 0.4,        // 当てられた側が動けない時間
};

// ---- ボール ----
export const BALL = {
  r: 10,
  mass: 0.34,           // プレイヤーを 1 とした相対質量 (軽いほどよく飛ぶ)
  damp: 0.9885,
  wallBounce: 0.72,
  maxSpeed: 950,
  // 横方向に走りながら蹴るとスピンがかかって曲がる (マグヌス力)
  spinFromKick: 0.0032,
  spinMax: 1,
  spinDamp: 0.988,
  spinForce: 0.85,      // rad/s 相当 (spin=1 のとき毎秒 0.85rad ぶん進行方向が曲がる)
};

// ---- 試合 ----
export const MATCH = {
  duration: 180,        // 本編の秒数
  kickoffFreeze: 1.6,   // キックオフ前の静止時間
  goalCelebrate: 2.4,   // ゴール後の間
  resultTime: 9,        // 結果表示 → 次の試合まで
  perTeam: 3,           // 1チームの人数 (足りないぶんは BOT が埋める)
};

// ---- 入力ボタンのビット ----
export const BTN = { KICK: 1, DASH: 2 };

// ---- 状態フラグ (スナップショットの flags バイト) ----
export const FLAG = { TEAM: 1, CHARGING: 2, DASHING: 4, STUNNED: 8, BOT: 16 };

// ---- 通信 ----
export const MSG = { INPUT: 1, SNAPSHOT: 2 };
export const POS_SCALE = 8;   // 座標 / 速度を i16 に詰めるときの倍率

export const TEAM_NAME = ["レッド", "ブルー"];
export const TEAM_COLOR = ["#ff5a5f", "#4aa8ff"];
