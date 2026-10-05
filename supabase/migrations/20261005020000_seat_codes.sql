-- A 4-digit code per evening (optional). Kai sends it with the invitation:
-- the evening page asks for it before opening, and reserving a seat or
-- registering interest checks it again on the server.
-- The code lives in its own table that only Kai can read, so it never
-- reaches a visitor's browser. Wrong codes are counted per visitor (signed-in
-- guest, or the visitor's network address before sign-in): 10 an hour per
-- evening, then that visitor waits an hour.

create table public.event_codes (
  event_id   uuid primary key references public.events on delete cascade,
  code       text not null check (code ~ '^[0-9]{4}$'),
  updated_at timestamptz not null default now()
);
alter table public.event_codes enable row level security;
create policy "event codes: admin" on public.event_codes
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
grant select, insert, update, delete on public.event_codes to authenticated;

create table public.code_attempts (
  id         bigserial primary key,
  event_id   uuid not null references public.events on delete cascade,
  who        text not null,
  created_at timestamptz not null default now()
);
create index code_attempts_recent on public.code_attempts (event_id, who, created_at);
-- no policies: only the functions below touch it
alter table public.code_attempts enable row level security;

-- does this evening ask for a seat code? (never reveals the code)
create or replace function public.event_needs_code(p_slug text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.event_codes c join public.events e on e.id = c.event_id
    where e.slug = p_slug
  );
$$;

-- the core check, keyed by who is trying: 'ok' when the evening has no code
-- or it matches, 'wrong' (counted) or 'locked' after too many wrong tries.
-- Returns rather than raises, so a wrong try is still recorded.
create or replace function public.seat_code_verdict(p_event uuid, p_who text, p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare
  want  text;
  fails int;
begin
  select code into want from public.event_codes where event_id = p_event;
  if want is null then return 'ok'; end if;
  select count(*) into fails from public.code_attempts
  where event_id = p_event and who = p_who and created_at > now() - interval '1 hour';
  if fails >= 10 then return 'locked'; end if;
  if coalesce(trim(p_code), '') = want then return 'ok'; end if;
  insert into public.code_attempts (event_id, who) values (p_event, p_who);
  return 'wrong';
end;
$$;

-- for the edge function that holds seats (service role): checked per guest
create or replace function public.check_seat_code(p_event uuid, p_user uuid, p_code text) returns text
language sql security definer set search_path = public as $$
  select public.seat_code_verdict(p_event, 'user:' || p_user::text, p_code);
$$;

-- for the evening page before sign-in: 'ok', 'wrong' or 'locked', counted
-- per network address (from the request headers the API passes through)
create or replace function public.unlock_event(p_slug text, p_code text) returns text
language plpgsql security definer set search_path = public as $$
declare
  ev_id uuid;
  hdr   json := coalesce(nullif(current_setting('request.headers', true), ''), '{}')::json;
  addr  text;
begin
  select id into ev_id from public.events where slug = p_slug and status <> 'draft';
  if ev_id is null then return 'wrong'; end if;
  addr := coalesce(hdr ->> 'cf-connecting-ip', split_part(hdr ->> 'x-forwarded-for', ',', 1), hdr ->> 'x-real-ip', 'unknown');
  return public.seat_code_verdict(ev_id, 'addr:' || trim(addr), p_code);
end;
$$;

-- register interest now takes the code too; returns the status, or
-- 'wrong_seat_code' / 'too_many_code_tries'
drop function if exists public.register_interest(text);
create or replace function public.register_interest(p_slug text, p_code text default null)
returns text
language plpgsql security definer set search_path = public as $$
declare
  ev public.events%rowtype;
  cur public.reservations%rowtype;
  verdict text;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid()) then
    raise exception 'no_profile';
  end if;
  select * into ev from public.events where slug = p_slug;
  if not found or ev.status <> 'open' then raise exception 'event_not_open'; end if;
  if ev.invite_only and not exists (
    select 1 from public.invitations
    where event_id = ev.id and email = lower(coalesce(auth.jwt() ->> 'email', ''))
  ) then
    raise exception 'not_invited';
  end if;

  select * into cur from public.reservations
  where event_id = ev.id and user_id = auth.uid() and status <> 'cancelled';
  if found then
    return cur.status;
  end if;

  verdict := public.seat_code_verdict(ev.id, 'user:' || auth.uid()::text, p_code);
  if verdict = 'wrong' then return 'wrong_seat_code'; end if;
  if verdict = 'locked' then return 'too_many_code_tries'; end if;

  insert into public.reservations (event_id, user_id, status)
  values (ev.id, auth.uid(), 'interested');
  return 'interested';
end;
$$;

revoke execute on function public.seat_code_verdict(uuid, text, text) from public, anon, authenticated;
revoke execute on function public.check_seat_code(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.check_seat_code(uuid, uuid, text) to service_role;
grant  execute on function public.event_needs_code(text) to anon, authenticated;
grant  execute on function public.unlock_event(text, text) to anon, authenticated;
grant  execute on function public.register_interest(text, text) to authenticated;
