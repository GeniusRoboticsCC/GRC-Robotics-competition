-- =====================================================================
-- GRC Resource Recovery Tournament · Live +/− scoring
-- ---------------------------------------------------------------------
-- Run supabase/schema.sql first. Then paste this whole file into
-- Supabase → SQL Editor → New query → Run. It is safe to run again.
--
-- How it works
--   • Tapping + or − on the staff page saves that robot's points straight
--     away into matches.live_scores (the running score). The audience
--     display and schedule show it instantly, marked "Live scoring".
--   • The standings, awards and "Match winner" only use matches.scores,
--     the FINAL result, which is still set by "Save scores" / "Update scores".
--   • Saving (or clearing / resetting) a match's final scores automatically
--     clears its running score, so the screens switch to "Final".
-- =====================================================================

alter table public.matches
  add column if not exists live_scores integer[]
    check (
      live_scores is null or (
        cardinality(live_scores) = 4
        and array_position(live_scores, null) is null
        and 0 <= all (live_scores)
        and 9999 >= all (live_scores)
      )
    );


-- Staff: set one robot's running score (p_slot 0–3 = the four robots in the match).
-- Returns the match's four running scores.
create or replace function public.set_live_score(p_match int, p_slot int, p_value int)
returns integer[]
language plpgsql security definer
set search_path = public
as $$
declare
  v integer[];
begin
  perform public.assert_staff();

  -- any match that exists: the 15 qualifying matches plus extra matches (see extra_matches.sql)
  if p_match is null or not exists (select 1 from public.matches where id = p_match) then
    raise exception 'That match does not exist';
  end if;
  if p_slot is null or p_slot not between 0 and 3 then
    raise exception 'Robot must be 0, 1, 2 or 3';
  end if;
  if p_value is null or p_value not between 0 and 9999 then
    raise exception 'Points must be a whole number from 0 to 9999';
  end if;

  -- Lock the row so two phones tapping at once never overwrite each other's robot
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
$$;

revoke execute on function public.set_live_score(int, int, int) from public, anon;
grant  execute on function public.set_live_score(int, int, int) to authenticated;


-- Whenever the final scores are written (save, update, clear, reset, restore),
-- drop the running score so every screen shows the final result.
create or replace function public.clear_live_scores()
returns trigger
language plpgsql
as $$
begin
  new.live_scores := null;
  return new;
end;
$$;

revoke execute on function public.clear_live_scores() from public, anon, authenticated;

drop trigger if exists matches_clear_live_scores on public.matches;
create trigger matches_clear_live_scores
  before update of scores on public.matches
  for each row execute function public.clear_live_scores();


-- Everyone can already read matches; this just makes sure of it
grant select on public.matches to anon, authenticated;

-- Tell the API about the new column and function straight away
notify pgrst, 'reload schema';
