import test from "node:test";
import assert from "node:assert/strict";
import { CPU, normalizeCpuLevel, cpuProfile } from "../shared/cpu.js";
import { DT, BTN, PLAYER } from "../shared/constants.js";
import { createPlayer, createBall, stepPlayer, applyKick } from "../shared/physics.js";
import { newBrain, botInput } from "../server/bots.js";
import { Room, Rooms } from "../server/room.js";

const store = { record: async () => {} };

test("CPUレベル: 未指定・不正値は3、範囲外と小数は正規化する", () => {
  for (const value of [undefined, null, {}, [], true, "", " ", "bad", NaN, Infinity]) {
    assert.equal(normalizeCpuLevel(value), CPU.defaultLevel);
  }
  assert.equal(normalizeCpuLevel(-4), 1);
  assert.equal(normalizeCpuLevel(150), 100);
  assert.equal(normalizeCpuLevel("47"), 47);
  assert.equal(normalizeCpuLevel(51.7), 52);
});

test("Lv.3は従来の平均、1〜100で反応・精度・先読みが段階的に改善", () => {
  const baseline = cpuProfile(3);
  assert.equal(baseline.skill, 0.7);
  assert.equal(baseline.tactics, 0);
  assert.ok(Math.abs(baseline.reaction - (0.18 - 0.1 * 0.7)) < 1e-10);
  assert.equal(baseline.blur, 90 * (1 - 0.7));
  assert.equal(baseline.lead, 0.18 * 0.7);
  for (let level = 2; level <= 100; level++) {
    const prev = cpuProfile(level - 1), current = cpuProfile(level);
    assert.ok(current.reaction < prev.reaction);
    assert.ok(current.blur < prev.blur);
    assert.ok(current.lead > prev.lead);
  }
});

test("全100レベルで同じ入力なら移動・ダッシュ・スタミナ・キック威力が一致", () => {
  let expected;
  for (let level = 1; level <= 100; level++) {
    const p = createPlayer(1, 0);
    p.brain = newBrain(level);
    for (let tick = 0; tick < 40; tick++) {
      stepPlayer(p, { mx: 0.6, my: 0.8, btn: tick < 10 ? BTN.DASH : BTN.KICK }, DT);
    }
    const power = stepPlayer(p, { mx: 0, my: 0, btn: 0 }, DT);
    const ball = createBall();
    ball.x = p.x + PLAYER.r; ball.y = p.y;
    const kickSpeed = applyKick(p, ball, power);
    const state = { x: p.x, y: p.y, vx: p.vx, vy: p.vy, stam: p.stam, dashCd: p.dashCd, kickSpeed };
    if (!expected) expected = state;
    assert.deepEqual(state, expected, `Lv.${level}`);
  }
});

test("全100レベルのCPUが合法な入力で試合を進める", () => {
  for (let level = 1; level <= 100; level++) {
    const room = new Room("cpu", store, level);
    room.balance(); room.idle = false;
    for (let tick = 0; tick < 240; tick++) room.step(DT);
    for (const p of room.ents) {
      assert.equal(p.brain.level, level);
      const input = botInput(room, p, DT);
      assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
      assert.ok(Number.isFinite(input.mx) && Number.isFinite(input.my));
      assert.ok(Math.hypot(input.mx, input.my) <= 1.000001);
      assert.equal(input.btn & ~(BTN.KICK | BTN.DASH), 0);
    }
  }
});

test("クイックは同レベルだけ、合言葉は作成時のレベルを維持、補充CPUも同レベル", () => {
  const rooms = new Rooms(store);
  const easy = rooms.quick(1), hard = rooms.quick(100);
  assert.notEqual(easy, hard);
  assert.equal(rooms.quick(100), hard);
  assert.equal(rooms.get(hard.id, 1), hard);
  assert.equal(hard.cpuLevel, 100);
  const player = hard.join({ readyState: 1, send() {} }, "test");
  hard.leave(player);
  assert.ok(hard.ents.every((p) => p.brain.level === 100));
  assert.equal(hard.info().cpuLevel, 100);
  assert.equal(rooms.quick().cpuLevel, 3);
});

test("高レベルはゴール中央を塞ぐ相手を避けたシュート位置を選ぶ", (t) => {
  t.mock.method(Math, "random", () => 0.5);
  function target(level) {
    const me = createPlayer(1, 0);
    me.x = 200; me.brain = newBrain(level);
    const foe = createPlayer(2, 1); foe.x = 500;
    const ball = createBall(); ball.x = 300;
    botInput({ ents: [me, foe], ball }, me, DT);
    return me.brain.ty;
  }
  assert.equal(target(3), 0);
  assert.ok(Math.abs(target(100)) > 1);
});
