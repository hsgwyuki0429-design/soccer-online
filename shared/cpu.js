// CPU の能力差は判断だけ。移動・キック・スタミナの物理は全員共通。
export const CPU = Object.freeze({ min: 1, max: 100, defaultLevel: 3 });

export function normalizeCpuLevel(value) {
  if (typeof value !== "number" && typeof value !== "string") return CPU.defaultLevel;
  if (typeof value === "string" && !value.trim()) return CPU.defaultLevel;
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(CPU.min, Math.min(CPU.max, Math.round(n))) : CPU.defaultLevel;
}

export function cpuProfile(value) {
  const level = normalizeCpuLevel(value);
  const tactics = Math.max(0, (level - 3) / 97);
  // Lv.3 は従来の skill (0.5〜0.9) の平均 0.7 に合わせる。
  const skill = level < 3 ? 0.2 + (level - 1) * 0.25 : 0.7 + tactics * 0.29;
  return {
    level, skill, tactics,
    reaction: level < 3 ? 0.34 - (level - 1) * 0.12 : 0.11 - tactics * 0.085,
    jitter: 0.08 * (1 - tactics),
    blur: 90 * (1 - skill),
    lead: 0.18 * skill + tactics * 0.22,
  };
}
