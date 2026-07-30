// ============ 戦績の保存 (Supabase / 未設定ならメモリ) ============
//
// SDK は入れない。Supabase の PostgREST を fetch で直接叩くだけ (Node18+ の global fetch)。
// service_role キーはサーバだけが持ち、ブラウザには一切渡さない。
// ランキングの閲覧はサーバの /api/leaderboard 経由なので、クライアントに鍵は不要。

const URL_ = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const KEY = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || "";
const TABLE = process.env.SUPABASE_TABLE || "soccer_players";

export function createStore() {
  return URL_ && KEY ? new SupabaseStore() : new MemoryStore();
}

class MemoryStore {
  constructor() { this.map = new Map(); this.kind = "memory"; }

  async record({ pid, name, goals, result }) {
    const row = this.map.get(pid) || {
      pid, name, matches: 0, wins: 0, draws: 0, losses: 0, goals: 0,
    };
    row.name = name || row.name;
    row.matches++;
    row.goals += goals || 0;
    if (result === "win") row.wins++;
    else if (result === "draw") row.draws++;
    else row.losses++;
    this.map.set(pid, row);
    return row;
  }

  async leaderboard(limit = 50) {
    return [...this.map.values()]
      .map((r) => ({ ...r, points: r.wins * 3 + r.draws }))
      .sort((a, b) => b.points - a.points || b.goals - a.goals)
      .slice(0, limit);
  }
}

class SupabaseStore {
  constructor() { this.kind = "supabase"; this.warned = false; }

  headers(extra = {}) {
    return {
      "Content-Type": "application/json",
      apikey: KEY,
      Authorization: `Bearer ${KEY}`,
      ...extra,
    };
  }

  async record({ pid, name, goals, result }) {
    const res = await fetch(`${URL_}/rest/v1/rpc/soccer_record`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        p_pid: pid,
        p_name: String(name || "?").slice(0, 10),
        p_goals: Math.max(0, Math.min(99, goals | 0)),
        p_result: result,
      }),
    });
    if (!res.ok) throw new Error(`supabase record ${res.status}: ${await res.text()}`);
    return true;
  }

  async leaderboard(limit = 50) {
    const q = `select=pid,name,matches,wins,draws,losses,goals,points`
      + `&order=points.desc,goals.desc&limit=${Math.min(200, limit)}`;
    const res = await fetch(`${URL_}/rest/v1/${TABLE}?${q}`, { headers: this.headers() });
    if (!res.ok) {
      if (!this.warned) {
        this.warned = true;
        console.warn(`[store] leaderboard ${res.status}: ${await res.text()}`);
      }
      return [];
    }
    return res.json();
  }
}
