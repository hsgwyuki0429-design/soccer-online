// ============ 効果音 (WebAudio の合成音・音声ファイルは持たない) ============

let ctx = null;

function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export function unlockAudio() { ac(); }

function blip({ f = 440, f2 = null, dur = 0.1, type = "sine", gain = 0.15, delay = 0 }) {
  const a = ac();
  if (!a) return;
  const t = a.currentTime + delay;
  const o = a.createOscillator();
  const g = a.createGain();
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + dur);
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(a.destination);
  o.start(t);
  o.stop(t + dur + 0.02);
}

function noise(dur = 0.09, gain = 0.12) {
  const a = ac();
  if (!a) return;
  const n = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, n, a.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
  const src = a.createBufferSource();
  const g = a.createGain();
  g.gain.value = gain;
  src.buffer = buf;
  src.connect(g).connect(a.destination);
  src.start();
}

export const sfx = {
  kick(power = 0.5) {
    blip({ f: 210 + power * 190, f2: 70, dur: 0.09 + power * 0.06, type: "triangle", gain: 0.1 + power * 0.13 });
    noise(0.05, 0.05 + power * 0.06);
  },
  touch() { blip({ f: 320, f2: 190, dur: 0.05, type: "sine", gain: 0.05 }); },
  wall() { blip({ f: 150, f2: 90, dur: 0.07, type: "square", gain: 0.05 }); },
  tackle() { noise(0.14, 0.16); blip({ f: 120, f2: 60, dur: 0.16, type: "sawtooth", gain: 0.1 }); },
  goal() {
    [523, 659, 784, 1047].forEach((f, i) => blip({ f, dur: 0.3, type: "triangle", gain: 0.13, delay: i * 0.08 }));
  },
  conceded() {
    [392, 330, 262].forEach((f, i) => blip({ f, dur: 0.28, type: "sine", gain: 0.1, delay: i * 0.1 }));
  },
  whistle() {
    blip({ f: 1750, f2: 1900, dur: 0.16, type: "square", gain: 0.06 });
    blip({ f: 1900, f2: 1700, dur: 0.14, type: "square", gain: 0.05, delay: 0.16 });
  },
  end() {
    [880, 880, 660].forEach((f, i) => blip({ f, dur: 0.26, type: "square", gain: 0.07, delay: i * 0.22 }));
  },
};
