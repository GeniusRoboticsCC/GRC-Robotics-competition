-- =====================================================================
-- GRC Resource Recovery Tournament · Ball release (ESP32 + servo)
-- ---------------------------------------------------------------------
-- Run supabase/schema.sql first. Then paste this whole file into
-- Supabase → SQL Editor → New query → Run. It is safe to run again.
--
-- How it works
--   • Staff press "Release balls" on the staff page → release_items()
--     adds a row to field_releases (only signed-in staff can do this).
--   • The ESP32 calls dropper_poll() about twice a second with its secret
--     device token. It sees the new row, opens the servo, then reports
--     back that it is done, so the staff page shows "Released ✓".
--
-- The LAST result of this script is the device token. Copy it into
-- esp32/ball_release/secrets.h (DEVICE_TOKEN). Never put it on the website.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

-- Every press of "Release balls"
create table if not exists public.field_releases (
  id            bigint generated always as identity primary key,
  match_id      smallint,
  requested_by  text,
  requested_at  timestamptz not null default now()
);

-- The ESP32 that moves the servo
create table if not exists public.field_devices (
  name       text primary key,
  token      text not null check (char_length(token) >= 16),
  last_seen  timestamptz,               -- last time the ESP32 checked in
  last_done  bigint not null default 0, -- newest release it carried out
  done_at    timestamptz,
  info       text                       -- e.g. Wi-Fi signal strength
);

insert into public.field_devices (name, token)
values ('dropper', replace(gen_random_uuid()::text, '-', ''))
on conflict (name) do nothing;


-- ---------------------------------------------------------------------
-- 2. Staff: release the balls (returns the new release number)
-- ---------------------------------------------------------------------

create or replace function public.release_items()
returns bigint
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_id    bigint;
  v_match smallint;
begin
  perform public.assert_staff();

  -- Two phones pressing at the same moment only count once
  if exists (select 1 from public.field_releases
             where requested_at > now() - interval '3 seconds') then
    raise exception 'The balls were released a moment ago. Wait 3 seconds before trying again.';
  end if;

  select current_match into v_match from public.tournament_state where id;

  insert into public.field_releases (match_id, requested_by)
  values (v_match, lower(auth.jwt() ->> 'email'))
  returning id into v_id;

  return v_id;
end;
$$;


-- ---------------------------------------------------------------------
-- 3. Staff: is the dropper online, and did the last release happen?
-- ---------------------------------------------------------------------

create or replace function public.dropper_status()
returns jsonb
language plpgsql stable security definer
set search_path = public
as $$
declare
  v_dev public.field_devices%rowtype;
  v_rel public.field_releases%rowtype;
begin
  perform public.assert_staff();

  select * into v_dev from public.field_devices where name = 'dropper';
  select * into v_rel from public.field_releases order by id desc limit 1;

  return jsonb_build_object(
    'online',    coalesce(v_dev.last_seen > now() - interval '10 seconds', false),
    'seen_ago',  floor(extract(epoch from now() - v_dev.last_seen))::bigint,
    'info',      v_dev.info,
    'last_done', coalesce(v_dev.last_done, 0),
    'done_ago',  floor(extract(epoch from now() - v_dev.done_at))::bigint,
    'latest',    case when v_rel.id is null then null else jsonb_build_object(
                   'id',    v_rel.id,
                   'match', v_rel.match_id,
                   'ago',   floor(extract(epoch from now() - v_rel.requested_at))::bigint
                 ) end
  );
end;
$$;


-- ---------------------------------------------------------------------
-- 4. ESP32: check in, report what it did, and get the newest release
--    Returns {"id": newest release number, "age": seconds ago, "match": n}
-- ---------------------------------------------------------------------

create or replace function public.dropper_poll(p_token text, p_done bigint default 0, p_info text default null)
returns jsonb
language plpgsql volatile security definer
set search_path = public
as $$
declare
  v_dev  public.field_devices%rowtype;
  v_rel  public.field_releases%rowtype;
  v_done bigint := greatest(coalesce(p_done, 0), 0);
begin
  select * into v_dev from public.field_devices where name = 'dropper';
  if not found or p_token is null or p_token <> v_dev.token then
    raise exception 'Wrong device token' using errcode = '42501';
  end if;

  -- Only write every few seconds (or when there is news) to keep the database quiet
  if v_dev.last_seen is null
     or v_dev.last_seen < now() - interval '3 seconds'
     or v_done > v_dev.last_done then
    update public.field_devices
       set last_seen = now(),
           done_at   = case when v_done > last_done then now() else done_at end,
           last_done = greatest(last_done, v_done),
           info      = coalesce(left(p_info, 60), info)
     where name = 'dropper';
  end if;

  select * into v_rel from public.field_releases order by id desc limit 1;

  return jsonb_build_object(
    'id',    coalesce(v_rel.id, 0),
    'age',   coalesce(floor(extract(epoch from now() - v_rel.requested_at))::bigint, 0),
    'match', coalesce(v_rel.match_id, 0)
  );
end;
$$;


-- ---------------------------------------------------------------------
-- 5. Privileges: no direct table access; everything goes through the
--    functions above
-- ---------------------------------------------------------------------

alter table public.field_releases enable row level security;
alter table public.field_devices  enable row level security;

revoke all on public.field_releases, public.field_devices from anon, authenticated;

revoke execute on function public.release_items()                   from public, anon;
revoke execute on function public.dropper_status()                  from public, anon;
revoke execute on function public.dropper_poll(text, bigint, text)  from public;

grant execute on function public.release_items()                    to authenticated;
grant execute on function public.dropper_status()                   to authenticated;
grant execute on function public.dropper_poll(text, bigint, text)   to anon, authenticated;


-- ---------------------------------------------------------------------
-- 6. Your device token: copy the value below into secrets.h
--    (To make a new one later, run:
--     update public.field_devices set token = replace(gen_random_uuid()::text, '-', '') where name = 'dropper';)
-- ---------------------------------------------------------------------

select token as "DEVICE_TOKEN (copy into secrets.h)" from public.field_devices where name = 'dropper';
