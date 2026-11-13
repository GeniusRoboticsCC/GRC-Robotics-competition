-- =====================================================================
-- GRC Resource Recovery Tournament · Live stream (YouTube)
-- ---------------------------------------------------------------------
-- Run supabase/schema.sql first. Then paste this whole file into
-- Supabase → SQL Editor → New query → Run. It is safe to run again.
--
-- Adds two settings to the tournament state:
--   stream_source  – the YouTube video ID (11 characters) or channel ID (UC…)
--   stream_enabled – whether the website shows the stream
-- Everyone can read them (the audience display needs to), every screen
-- updates instantly through Realtime, and only signed-in staff can change
-- them, through set_live_stream().
-- =====================================================================

alter table public.tournament_state
  add column if not exists stream_source text
    check (stream_source is null or stream_source ~ '^([A-Za-z0-9_-]{11}|UC[A-Za-z0-9_-]{22})$'),
  add column if not exists stream_enabled boolean not null default false;


-- Staff: set the stream link and switch it on or off.
-- p_source: a YouTube video ID or channel ID (the website turns a pasted link into this).
create or replace function public.set_live_stream(p_source text, p_enabled boolean)
returns void
language plpgsql security definer
set search_path = public
as $$
declare
  v text := nullif(btrim(coalesce(p_source, '')), '');
begin
  perform public.assert_staff();

  if v is not null and v !~ '^([A-Za-z0-9_-]{11}|UC[A-Za-z0-9_-]{22})$' then
    raise exception 'That is not a valid YouTube video or channel ID';
  end if;

  update public.tournament_state
     set stream_source  = v,
         stream_enabled = coalesce(p_enabled, false) and v is not null,
         updated_at     = now()
   where id;
end;
$$;

revoke execute on function public.set_live_stream(text, boolean) from public, anon;
grant  execute on function public.set_live_stream(text, boolean) to authenticated;

-- Everyone can already read tournament_state; this just makes sure of it
grant select on public.tournament_state to anon, authenticated;

-- Tell the API about the new columns and function straight away
notify pgrst, 'reload schema';
