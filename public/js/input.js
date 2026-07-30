// ============ 入力 ============
//
// 出てくるのは画面基準の方向 (mx,my) とボタンだけ。
// 画面の向き (縦持ちだとピッチを 90 度回す) の補正は main.js 側でやる。

import { BTN } from "../shared/constants.js";

export class Input {
  constructor() {
    this.mx = 0; this.my = 0; this.btn = 0;
    this.keys = new Set();
    this.stick = { id: null, ox: 0, oy: 0, x: 0, y: 0 };
    this.touchKick = false;
    this.touchDash = false;
    this.el = {
      wrap: document.getElementById("touch"),
      stick: document.getElementById("stick"),
      knob: document.querySelector("#stick i"),
      kick: document.getElementById("btn-kick"),
      dash: document.getElementById("btn-dash"),
    };
    this.bind();
  }

  bind() {
    addEventListener("keydown", (e) => {
      if (e.repeat) return;
      if (e.code === "Space") e.preventDefault();
      this.keys.add(e.code);
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => { this.keys.clear(); this.stick.id = null; });

    // マウス: 左=キック / 右=ダッシュ
    const stage = document.getElementById("stage");
    stage.addEventListener("contextmenu", (e) => e.preventDefault());
    stage.addEventListener("mousedown", (e) => {
      if (e.button === 0) this.keys.add("MouseL");
      if (e.button === 2) this.keys.add("MouseR");
    });
    addEventListener("mouseup", (e) => {
      if (e.button === 0) this.keys.delete("MouseL");
      if (e.button === 2) this.keys.delete("MouseR");
    });

    // タッチ: 左半分がスティック
    const w = this.el.wrap;
    w.addEventListener("touchstart", (e) => {
      if (e.target.closest?.("button")) return;      // KICK/DASH の上ではスティックを出さない
      for (const t of e.changedTouches) {
        if (t.clientX > innerWidth * 0.55) continue;
        if (this.stick.id !== null) continue;
        this.stick.id = t.identifier;
        this.stick.ox = t.clientX; this.stick.oy = t.clientY;
        this.stick.x = 0; this.stick.y = 0;
        this.el.stick.style.left = `${t.clientX}px`;
        this.el.stick.style.top = `${t.clientY}px`;
        this.el.stick.classList.add("on");
        this.el.knob.style.transform = "translate(-50%,-50%)";
      }
      e.preventDefault();
    }, { passive: false });

    w.addEventListener("touchmove", (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this.stick.id) continue;
        const dx = t.clientX - this.stick.ox;
        const dy = t.clientY - this.stick.oy;
        const R = 52;
        const d = Math.hypot(dx, dy);
        const k = d > R ? R / d : 1;
        this.stick.x = Math.max(-1, Math.min(1, dx / R));
        this.stick.y = Math.max(-1, Math.min(1, dy / R));
        this.el.knob.style.transform = `translate(calc(-50% + ${dx * k}px), calc(-50% + ${dy * k}px))`;
      }
      e.preventDefault();
    }, { passive: false });

    const endTouch = (e) => {
      for (const t of e.changedTouches) {
        if (t.identifier !== this.stick.id) continue;
        this.stick.id = null; this.stick.x = 0; this.stick.y = 0;
        this.el.stick.classList.remove("on");
      }
    };
    w.addEventListener("touchend", endTouch);
    w.addEventListener("touchcancel", endTouch);

    hold(this.el.kick, (on) => { this.touchKick = on; this.el.kick.classList.toggle("on", on); });
    hold(this.el.dash, (on) => { this.touchDash = on; this.el.dash.classList.toggle("on", on); });
  }

  showTouch(on) { this.el.wrap.classList.toggle("hidden", !on); }

  /** 毎フレーム呼ぶ。画面基準の {mx,my,btn} を返す */
  read() {
    const k = this.keys;
    let x = 0, y = 0;
    if (k.has("KeyA") || k.has("ArrowLeft")) x -= 1;
    if (k.has("KeyD") || k.has("ArrowRight")) x += 1;
    if (k.has("KeyW") || k.has("ArrowUp")) y -= 1;
    if (k.has("KeyS") || k.has("ArrowDown")) y += 1;
    const m = Math.hypot(x, y);
    if (m > 1) { x /= m; y /= m; }

    if (this.stick.id !== null) {
      const sm = Math.hypot(this.stick.x, this.stick.y);
      if (sm > 0.14) { x = this.stick.x; y = this.stick.y; }
    }

    let btn = 0;
    if (k.has("Space") || k.has("KeyJ") || k.has("MouseL") || this.touchKick) btn |= BTN.KICK;
    if (k.has("ShiftLeft") || k.has("ShiftRight") || k.has("KeyK") || k.has("MouseR") || this.touchDash) btn |= BTN.DASH;

    this.mx = x; this.my = y; this.btn = btn;
    return this;
  }
}

function hold(el, cb) {
  const on = (e) => { e.preventDefault(); cb(true); el.setPointerCapture?.(e.pointerId); };
  const off = (e) => { e.preventDefault(); cb(false); };
  el.addEventListener("pointerdown", on);
  el.addEventListener("pointerup", off);
  el.addEventListener("pointercancel", off);
  el.addEventListener("lostpointercapture", () => cb(false));
}

// 「主に使うポインタが指かどうか」で判定する。
// maxTouchPoints で見ると、タッチ対応のノートPCでも操作ボタンが出てしまう。
export const isTouch = matchMedia("(pointer: coarse)").matches;
