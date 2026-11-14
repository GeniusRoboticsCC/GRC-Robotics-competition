-- =====================================================================
-- GRC Resource Recovery Tournament · Extra matches (judges pick the teams)
-- ---------------------------------------------------------------------
-- Run supabase/schema.sql first. Then paste this whole file into
-- Supabase → SQL Editor → New query → Run. It is safe to run again, and
-- it works whether or not live_scores.sql / live_stream.sql have been run.
--
-- How it works
--   • The 15 qualifying matches stay exactly as they are (numbers 1–15).
--   • Judges add extra matches (16, 17, …) on the staff page: a name such as
--     "Semi-final 1" or "Final", and which team drives each robot colour.
--   • Extra matches are scored like any other match, and their points COUNT
--     in the standings and awards.
--   • An extra match's teams can be changed until it has scores; it can be
--     deleted unless it's on the audience display.
--   • "Reset entire tournament" and "Restore from backup" remove extra matches
--     (a backup file brings back the extra matches it contains).
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Allow match numbers above 15, and give matches an optional name
-- ---------------------------------------------------------------------

do $$
declare
  c record;
begin
  -- drop the old "1 to 15" checks on matches.id and tournament_state.current_match
  for c in
    select con.conname, rel.relname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace n on n.oid = rel.relnamespace
     where n.nspname = 'public'
       and con.contype = 'c'
       and (
         (rel.relname = 'matches' and con.conkey = array[
            (select attnum from pg_attribute where attrelid = rel.oid and attname = 'id')])
         or
         (rel.relname = 'tournament_state' and con.conkey = array[
            (select attnum from pg_attribute where attrelid = rel.oid and attname = 'current_match')])
       )
  loop
    execute format('alter table public.%I drop constraint %I', c.relname, c.conname);
  end loop;
end;
$$;

alter table public.matches
  add constraint matches_id_check check (id between 1 and 99);
alter table public.tournament_state
  add constraint tournament_state_current_match_check check (current_match between 1 and 99);

alter table public.matches
  add column if not exists label text check (label is null or char_length(label) between 1 and 40);


-- ---------------------------------------------------------------------
-- 2. Judges: add / change / delete extra matches
-- ---------------------------------------------------------------------

-- Four different teams (1–10), and each robot colour (0 Red, 1 Blue, 2 Green, 3 Yellow) used once
create or replace function public.check_lineup(p_team_ids int[], p_colors int[])
returns void
language plpgsql immutable
as $$
begin
  if p_team_ids is null or cardinality(p_team_ids) <> 4
     or array_position(p_team_ids, null) is not null
     or not (1 <= all (p_team_ids) and 10 >= all (p_team_ids))
     or (select count(distinct t) from unnest(p_team_ids) as t) <> 4 then
    raise exception 'Pick four different teams';
  end if;
  if p_colors is null or cardinality(p_colors) <> 4
     or (select array_agg(c order by c) from unnest(p_colors) as c) <> array[0, 1, 2, 3] then
    raise exception 'Use each robot colour (red, blue, green, yellow) once';
  end if;
end;
$$;

-- Add an extra match; returns its number (16, 17, …)
create or replace function public.add_match(p_label text, p_team_ids int[], p_colors int[])
returns int
language plpgsql security definer
set search_path = public
as $$
declare
  v_id    int;
  v_label text := nullif(left(btrim(coalesce(p_label, '')), 40), '');
begin
  perform public.assert_staff();
  perform public.check_lineup(p_team_ids, p_colors);

  -- two judges adding at the same moment still get different numbers
  lock table public.matches in share row exclusive mode;
  select greatest(15, coalesce(max(id), 0)) + 1 into v_id from public.matches;
  if v_id > 99 then
    raise exception 'There are already too many matches';
  end if;

  insert into public.matches (id, team_ids, colors, label)
  values (v_id, p_team_ids, p_colors, v_label);

  return v_id;
end;
$$;

-- Change an extra match's name or teams (teams only while it has no scores)
create or replace function public.update_match(p_match int, p_label text, p_team_ids int[], p_colors int[])
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  m       public.matches%rowtype;
  v_label text := nullif(left(btrim(coalesce(p_label, '')), 40), '');
begin
  perform public.assert_staff();

  if p_match is null or p_match <= 15 then
    raise exception 'Only extra matches can be changed here. The 15 qualifying matches are fixed.';
  end if;

  select * into m from public.matches where id = p_match for update;
  if not found then
    raise exception 'That match does not exist';
  end if;

  perform public.check_lineup(p_team_ids, p_colors);

  -- to_jsonb() so this works whether or not live_scores.sql has been run
  if (m.scores is not null or (to_jsonb(m) ->> 'live_scores') is not null)
     and (m.team_ids is distinct from p_team_ids::smallint[] or m.colors is distinct from p_colors::smallint[]) then
    raise exception 'This match already has scores. Clear its scores first, then change the teams.';
  end if;

  update public.matches
     set label      = v_label,
         team_ids   = p_team_ids,
         colors     = p_colors,
         updated_at = now()
   where id = p_match;
end;
$$;

-- Delete an extra match (and its scores)
create or replace function public.delete_match(p_match int)
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.assert_staff();

  if p_match is null or p_match <= 15 then
    raise exception 'The 15 qualifying matches cannot be deleted';
  end if;
  if (select current_match from public.tournament_state where id) = p_match then
    raise exception 'This match is on the audience display. Show another match first, then delete it.';
  end if;

  delete from public.matches where id = p_match;
  if not found then
    raise exception 'That match does not exist';
  end if;
end;
$$;


-- ---------------------------------------------------------------------
-- 3. Existing actions: work with extra matches too
--    (the same definitions are in schema.sql / live_scores.sql, so running
--    those files again later never undoes this)
-- ---------------------------------------------------------------------

create or replace function public.save_scores(p_match int, p_scores int[])
returns void
language plpgsql security definer
set search_path = public
as $$
begin
  perform public.assert_staff();

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

-- Live +/- scoring on extra matches (only if live_scores.sql has been run)
do $do$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'matches' and column_name = 'live_scores') then
    execute $fn$
      create or replace function public.set_live_score(p_match int, p_slot int, p_value int)
      returns integer[]
      language plpgsql security definer
      set search_path = public
      as $body$
      declare
        v integer[];
      begin
        perform public.assert_staff();

        if p_match is null or not exists (select 1 from public.matches where id = p_match) then
          raise exception 'That match does not exist';
        end if;
        if p_slot is null or p_slot not between 0 and 3 then
          raise exception 'Robot must be 0, 1, 2 or 3';
        end if;
        if p_value is null or p_value not between 0 and 9999 then
          raise exception 'Points must be a whole number from 0 to 9999';
        end if;

        select coalesce(live_scores, scores, array[0, 0, 0, 0])
          into v
          from public.matches
         where id = p_match
           for update;

        v[p_slot + 1] := p_value;

        update public.matches
           set live_scores = v,
               updated_at  = now()
         where id = p_match;

        return v;
      end;
      $body$;
    $fn$;
    revoke execute on function public.set_live_score(int, int, int) from public, anon;
    grant  execute on function public.set_live_score(int, int, int) to authenticated;
  end if;
end;
$do$;


-- ---------------------------------------------------------------------
-- 4. Privileges
-- ---------------------------------------------------------------------

revoke execute on function public.check_lineup(int[], int[])                  from public, anon, authenticated;

revoke execute on function public.add_match(text, int[], int[])               from public, anon;
revoke execute on function public.update_match(int, text, int[], int[])       from public, anon;
revoke execute on function public.delete_match(int)                           from public, anon;
grant  execute on function public.add_match(text, int[], int[])               to authenticated;
grant  execute on function public.update_match(int, text, int[], int[])       to authenticated;
grant  execute on function public.delete_match(int)                           to authenticated;

revoke execute on function public.save_scores(int, int[])                     from public, anon;
revoke execute on function public.set_current_match(int)                      from public, anon;
revoke execute on function public.reset_tournament()                          from public, anon;
revoke execute on function public.restore_tournament(text[], jsonb, int)      from public, anon;
grant  execute on function public.save_scores(int, int[])                     to authenticated;
grant  execute on function public.set_current_match(int)                      to authenticated;
grant  execute on function public.reset_tournament()                          to authenticated;
grant  execute on function public.restore_tournament(text[], jsonb, int)      to authenticated;

-- Everyone can already read matches; this just makes sure of it
grant select on public.matches to anon, authenticated;

-- Tell the API about the new column and functions straight away
notify pgrst, 'reload schema';
