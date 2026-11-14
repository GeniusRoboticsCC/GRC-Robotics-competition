-- =====================================================================
-- GRC Resource Recovery Tournament · Supabase backend
-- ---------------------------------------------------------------------
-- Paste this whole file into Supabase → SQL Editor → New query → Run.
-- It is safe to run again later: it never wipes team names or scores.
--
-- Security model
--   • Anyone (the audience display) can READ teams, matches and state.
--   • Nobody can write to the tables directly.
--   • All changes go through the functions below, which only work for
--     signed-in users whose email is listed in public.staff.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

-- Who may enter scores / edit teams (lower-case emails of Supabase Auth users)
create table if not exists public.staff (
  email      text primary key check (email = lower(email)),
  added_at   timestamptz not null default now()
);

create table if not exists public.teams (
  id         smallint primary key check (id between 1 and 10),
  name       text not null check (char_length(name) between 1 and 80),
  updated_at timestamptz not null default now()
);

create table if not exists public.matches (
  id         smallint primary key check (id between 1 and 15),
  team_ids   smallint[] not null check (cardinality(team_ids) = 4),
  colors     smallint[] not null check (cardinality(colors) = 4),   -- 0 Red · 1 Blue · 2 Green · 3 Yellow
  scores     integer[]  check (
               scores is null or (
                 cardinality(scores) = 4
                 and array_position(scores, null) is null
                 and 0 <= all (scores)
                 and 9999 >= all (scores)
               )
             ),
  scored_at  timestamptz,
  updated_at timestamptz not null default now()
);

-- Single row: which match is on the audience display + the shared match clock
create table if not exists public.tournament_state (
  id                 boolean primary key default true check (id),
  current_match      smallint not null default 1 check (current_match between 1 and 15),
  clock_running      boolean  not null default false,
  clock_ends_at      timestamptz,
  clock_remaining_ms integer  not null default 180000 check (clock_remaining_ms between 0 and 3600000),
  clock_duration_ms  integer  not null default 180000 check (clock_duration_ms between 1000 and 3600000),
  updated_at         timestamptz not null default now()
);

-- Every score change is recorded here (who, when, before/after) for disputes
create table if not exists public.score_history (
  id          bigint generated always as identity primary key,
  match_id    smallint not null,
  old_scores  integer[],
  new_scores  integer[],
  changed_by  text,
  changed_at  timestamptz not null default now()
);

-- Touched by the keep-alive job so the free-tier project never goes idle
create table if not exists public.heartbeat (
  id         boolean primary key default true check (id),
  pinged_at  timestamptz not null default now(),
  source     text
);


-- ---------------------------------------------------------------------
-- 2. Seed data (only inserts rows that are missing)
-- ---------------------------------------------------------------------

insert into public.teams (id, name)
select g, 'Team ' || g from generate_series(1, 10) as g
on conflict (id) do nothing;

-- Official 15-match schedule: every team plays 6 times and meets every
-- other team exactly twice. Re-running refreshes the fixture, not scores.
insert into public.matches (id, team_ids, colors) values
  ( 1, '{1,4,8,9}',  '{0,2,3,1}'),
  ( 2, '{3,6,7,8}',  '{2,1,3,0}'),
  ( 3, '{1,4,5,7}',  '{1,0,3,2}'),
  ( 4, '{3,5,6,9}',  '{1,2,0,3}'),
  ( 5, '{2,3,4,8}',  '{3,0,1,2}'),
  ( 6, '{1,3,7,10}', '{2,3,1,0}'),
  ( 7, '{5,8,9,10}', '{1,3,0,2}'),
  ( 8, '{2,4,6,10}', '{2,3,1,0}'),
  ( 9, '{1,2,3,9}',  '{3,1,0,2}'),
  (10, '{2,5,7,8}',  '{2,3,0,1}'),
  (11, '{3,4,5,10}', '{1,2,0,3}'),
  (12, '{1,6,8,10}', '{0,3,2,1}'),
  (13, '{2,7,9,10}', '{0,2,1,3}'),
  (14, '{1,2,5,6}',  '{3,1,2,0}'),
  (15, '{4,6,7,9}',  '{1,2,3,0}')
on conflict (id) do update
  set team_ids = excluded.team_ids,
      colors   = excluded.colors;

insert into public.tournament_state (id) values (true) on conflict (id) do nothing;
insert into public.heartbeat (id)        values (true) on conflict (id) do nothing;


-- ---------------------------------------------------------------------
-- 3. Helper functions
-- ---------------------------------------------------------------------

create or replace function public.is_staff()
returns boolean
language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.staff
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

create or replace function public.assert_staff()
returns void
language plpgsql stable security definer
set search_path = public
as $$
begin
  if not public.is_staff() then
    raise exception 'Not authorised: sign in with a staff account'
      using errcode = '42501';
  end if;
end;
$$;

-- Server clock, so every phone and the projector count down in sync
create or replace function public.server_now()
returns timestamptz
language sql stable
as $$ select now(); $$;

-- Called by the keep-alive job (and harmless for anyone else to call)
create or replace function public.ping(p_source text default 'keep-alive')
returns timestamptz
language sql volatile security definer
set search_path = public
as $$
  update public.heartbeat
     set pinged_at = now(),
         source    = left(coalesce(p_source, 'unknown'), 40)
   where id
  returning pinged_at;
$$;


-- ---------------------------------------------------------------------
-- 4. Write operations (staff only)
-- ---------------------------------------------------------------------

-- Save (or clear, with p_scores = null) the four scores for one match
create or replace function public.save_scores(p_match int, p_scores int[])
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.assert_staff();

  -- any match that exists: the 15 qualifying matches plus extra matches (see extra_matches.sql)
  if p_match is null or not exists (select 1 from public.matches where id = p_match) then
    raise exception 'That match does not exist';
  end if;

  if p_scores is not null and (
       cardinality(p_scores) <> 4
       or array_position(p_scores, null) is not null
       or not (0 <= all (p_scores) and 9999 >= all (p_scores))
     ) then
    raise exception 'Scores must be four whole numbers from 0 to 9999';
  end if;

  update public.matches
     set scores     = p_scores,
         scored_at  = case when p_scores is null then null else now() end,
         updated_at = now()
   where id = p_match;
end;
$$;

-- Save all 10 team names at once (blank names fall back to "Team N")
create or replace function public.save_team_names(p_names text[])
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  i int;
  v text;
begin
  perform public.assert_staff();

  if p_names is null or cardinality(p_names) <> 10 then
    raise exception 'Provide exactly 10 team names';
  end if;

  for i in 1..10 loop
    v := left(btrim(coalesce(p_names[i], '')), 80);
    if v = '' then v := 'Team ' || i; end if;
    update public.teams
       set name = v, updated_at = now()
     where id = i and name is distinct from v;
  end loop;
end;
$$;

-- Choose which match the audience display shows (also resets the clock)
create or replace function public.set_current_match(p_match int)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.assert_staff();

  if p_match is null or not exists (select 1 from public.matches where id = p_match) then
    raise exception 'That match does not exist';
  end if;

  update public.tournament_state
     set current_match      = p_match,
         clock_running      = false,
         clock_ends_at      = null,
         clock_remaining_ms = clock_duration_ms,
         updated_at         = now()
   where id;
end;
$$;

-- Shared match clock: 'start' | 'pause' | 'reset'
create or replace function public.clock_control(p_action text)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  s           public.tournament_state%rowtype;
  v_remaining integer;
begin
  perform public.assert_staff();

  select * into s from public.tournament_state where id for update;

  v_remaining := case
    when s.clock_running and s.clock_ends_at is not null then
      greatest(0, least(s.clock_duration_ms,
        (extract(epoch from (s.clock_ends_at - now())) * 1000)::int))
    else s.clock_remaining_ms
  end;

  if p_action = 'start' then
    if s.clock_running and v_remaining > 0 then
      return;                                   -- already counting down
    end if;
    if v_remaining <= 0 then
      v_remaining := s.clock_duration_ms;       -- finished → start a fresh 3:00
    end if;
    update public.tournament_state
       set clock_running      = true,
           clock_ends_at      = now() + v_remaining * interval '1 millisecond',
           clock_remaining_ms = v_remaining,
           updated_at         = now()
     where id;

  elsif p_action = 'pause' then
    update public.tournament_state
       set clock_running      = false,
           clock_ends_at      = null,
           clock_remaining_ms = v_remaining,
           updated_at         = now()
     where id;

  elsif p_action = 'reset' then
    update public.tournament_state
       set clock_running      = false,
           clock_ends_at      = null,
           clock_remaining_ms = clock_duration_ms,
           updated_at         = now()
     where id;

  else
    raise exception 'Unknown clock action: %', p_action;
  end if;
end;
$$;

-- Wipe all scores and team names and remove extra matches (the "Reset entire tournament" button)
create or replace function public.reset_tournament()
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.assert_staff();

  delete from public.matches where id > 15;     -- extra matches added by judges

  update public.teams
     set name = 'Team ' || id, updated_at = now()
   where id between 1 and 10;

  update public.matches
     set scores = null, scored_at = null, updated_at = now()
   where id between 1 and 15;

  update public.tournament_state
     set current_match      = 1,
         clock_running      = false,
         clock_ends_at      = null,
         clock_remaining_ms = clock_duration_ms,
         updated_at         = now()
   where id;
end;
$$;

-- Restore a backup file in one step (all-or-nothing)
-- p_scores: JSON array of 15 items, each null or an array of 4 integers.
-- Extra matches are removed here; the website then re-adds the ones saved in the backup.
create or replace function public.restore_tournament(p_names text[], p_scores jsonb, p_current int default 1)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  i   int;
  r   jsonb;
  arr int[];
begin
  perform public.assert_staff();

  if p_scores is null or jsonb_typeof(p_scores) <> 'array' or jsonb_array_length(p_scores) <> 15 then
    raise exception 'Backup must contain exactly 15 matches';
  end if;

  perform public.save_team_names(p_names);

  -- the backup replaces everything, including extra matches (the website re-adds the backup's own)
  if (select current_match from public.tournament_state where id) > 15 then
    update public.tournament_state set current_match = 1 where id;
  end if;
  delete from public.matches where id > 15;

  for i in 1..15 loop
    r := p_scores -> (i - 1);
    if r is null or jsonb_typeof(r) = 'null' then
      arr := null;
    elsif jsonb_typeof(r) = 'array' and jsonb_array_length(r) = 4 then
      select array_agg(t.v::int order by t.ord)
        into arr
        from jsonb_array_elements_text(r) with ordinality as t(v, ord);
    else
      raise exception 'Match % in the backup is not valid', i;
    end if;
    perform public.save_scores(i, arr);
  end loop;

  perform public.set_current_match(greatest(1, least(15, coalesce(p_current, 1))));
end;
$$;


-- ---------------------------------------------------------------------
-- 5. Score history trigger
-- ---------------------------------------------------------------------

create or replace function public.log_score_change()
returns trigger
language plpgsql security definer
set search_path = public
as $$
begin
  if new.scores is distinct from old.scores then
    insert into public.score_history (match_id, old_scores, new_scores, changed_by)
    values (new.id, old.scores, new.scores, coalesce(lower(auth.jwt() ->> 'email'), 'sql-editor'));
  end if;
  return new;
end;
$$;

drop trigger if exists matches_score_history on public.matches;
create trigger matches_score_history
  after update on public.matches
  for each row execute function public.log_score_change();


-- ---------------------------------------------------------------------
-- 6. Row Level Security & privileges
-- ---------------------------------------------------------------------

alter table public.staff            enable row level security;
alter table public.teams            enable row level security;
alter table public.matches          enable row level security;
alter table public.tournament_state enable row level security;
alter table public.score_history    enable row level security;
alter table public.heartbeat        enable row level security;

grant usage on schema public to anon, authenticated;

-- Read-only for everyone; no direct inserts/updates/deletes from the API
revoke insert, update, delete, truncate on
  public.staff, public.teams, public.matches, public.tournament_state,
  public.score_history, public.heartbeat
from anon, authenticated;

revoke select on public.staff, public.heartbeat from anon, authenticated;
grant  select on public.teams, public.matches, public.tournament_state to anon, authenticated;
grant  select on public.score_history to authenticated;

drop policy if exists "Public can read teams"   on public.teams;
drop policy if exists "Public can read matches" on public.matches;
drop policy if exists "Public can read state"   on public.tournament_state;
drop policy if exists "Staff can read history"  on public.score_history;

create policy "Public can read teams"   on public.teams            for select to anon, authenticated using (true);
create policy "Public can read matches" on public.matches          for select to anon, authenticated using (true);
create policy "Public can read state"   on public.tournament_state for select to anon, authenticated using (true);
create policy "Staff can read history"  on public.score_history    for select to authenticated using (public.is_staff());

-- Function permissions
revoke execute on function public.assert_staff()     from public, anon, authenticated;
revoke execute on function public.log_score_change() from public, anon, authenticated;

revoke execute on function public.save_scores(int, int[])                   from public, anon;
revoke execute on function public.save_team_names(text[])                   from public, anon;
revoke execute on function public.set_current_match(int)                    from public, anon;
revoke execute on function public.clock_control(text)                       from public, anon;
revoke execute on function public.reset_tournament()                        from public, anon;
revoke execute on function public.restore_tournament(text[], jsonb, int)    from public, anon;

grant execute on function public.save_scores(int, int[])                    to authenticated;
grant execute on function public.save_team_names(text[])                    to authenticated;
grant execute on function public.set_current_match(int)                     to authenticated;
grant execute on function public.clock_control(text)                        to authenticated;
grant execute on function public.reset_tournament()                         to authenticated;
grant execute on function public.restore_tournament(text[], jsonb, int)     to authenticated;

grant execute on function public.is_staff()        to anon, authenticated;
grant execute on function public.server_now()      to anon, authenticated;
grant execute on function public.ping(text)        to anon, authenticated;


-- ---------------------------------------------------------------------
-- 7. Realtime: push every change to the display and all phones instantly
-- ---------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array['teams', 'matches', 'tournament_state'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;


-- ---------------------------------------------------------------------
-- 8. ADD YOUR STAFF ACCOUNTS
--    First create each user in Authentication → Users → Add user
--    (tick "Auto Confirm User"), then list their emails here and run:
-- ---------------------------------------------------------------------

-- insert into public.staff (email) values
--   ('you@example.com'),
--   ('judge1@example.com')
-- on conflict (email) do nothing;
