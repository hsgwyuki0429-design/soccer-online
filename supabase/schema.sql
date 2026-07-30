-- ============ まるサッカー: Supabase スキーマ ============
-- Supabase の SQL Editor にそのまま貼って実行する。
--
-- 方針: ブラウザからは Supabase を直接触らない。
--       サーバ (Render) が service_role キーでだけ書き込み、
--       閲覧はサーバの /api/leaderboard 経由。鍵がクライアントに出ない。

create table if not exists public.soccer_players (
  pid         text primary key,               -- 端末に保存する匿名 ID
  name        text        not null default '?',
  matches     int         not null default 0,
  wins        int         not null default 0,
  draws       int         not null default 0,
  losses      int         not null default 0,
  goals       int         not null default 0,
  points      int generated always as (wins * 3 + draws) stored,
  updated_at  timestamptz not null default now()
);

create index if not exists soccer_players_rank_idx
  on public.soccer_players (points desc, goals desc);

-- RLS は有効のまま、ポリシーを作らない = anon / authenticated からは一切見えない。
-- service_role は RLS を迂回するのでサーバだけが読み書きできる。
alter table public.soccer_players enable row level security;

-- 1試合ぶんの結果を足し込む
create or replace function public.soccer_record(
  p_pid text, p_name text, p_goals int, p_result text
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.soccer_players (pid, name, matches, wins, draws, losses, goals, updated_at)
  values (
    p_pid,
    left(coalesce(nullif(trim(p_name), ''), '?'), 10),
    1,
    case when p_result = 'win'  then 1 else 0 end,
    case when p_result = 'draw' then 1 else 0 end,
    case when p_result = 'loss' then 1 else 0 end,
    greatest(0, coalesce(p_goals, 0)),
    now()
  )
  on conflict (pid) do update set
    name       = excluded.name,
    matches    = soccer_players.matches + 1,
    wins       = soccer_players.wins   + excluded.wins,
    draws      = soccer_players.draws  + excluded.draws,
    losses     = soccer_players.losses + excluded.losses,
    goals      = soccer_players.goals  + excluded.goals,
    updated_at = now();
end;
$$;

revoke all on function public.soccer_record(text, text, int, text) from public, anon, authenticated;
