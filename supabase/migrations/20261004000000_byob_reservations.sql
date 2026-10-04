-- =========================================================
-- Wine with Kai: evenings, seat reservations with a deposit,
-- Bring Your Own Bottle line-ups and the shared cost split.
--
-- Money is stored in cents (SGD by default).
-- Guests sign in with an emailed magic link (Supabase Auth).
-- Seats are held and confirmed only by the edge functions,
-- which run with the service role; guests never write
-- reservations directly.
-- =========================================================

-- ---------- admins ----------
-- Add Kai with:  insert into public.admins (email) values ('you@example.com');
create table public.admins (
  email text primary key check (email = lower(email))
);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.admins
    where email = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;

-- ---------- events ----------
create table public.events (
  id                 uuid primary key default gen_random_uuid(),
  slug               text not null unique check (slug ~ '^[a-z0-9-]+$'),
  title              text not null,
  subtitle           text,
  description        text,
  format             text not null default 'byob' check (format in ('byob', 'curated')),
  starts_at          timestamptz not null,
  venue              text,
  seats              int  not null default 12 check (seats > 0),
  -- null while the deposit is still to be decided: guests can register
  -- interest, but seats cannot be reserved yet
  deposit_cents      int  check (deposit_cents is null or deposit_cents >= 0),
  currency           text not null default 'sgd',
  -- a full refund if the guest cancels at least this many days ahead
  refund_days        int  not null default 14 check (refund_days >= 0),
  -- venue, corkage, food: split evenly across the seated guests
  shared_costs_cents int  not null default 0 check (shared_costs_cents >= 0),
  shared_costs_note  text,
  -- suggested price range for each bottle, shown as a banner
  price_min_cents    int  check (price_min_cents is null or price_min_cents >= 0),
  price_max_cents    int  check (price_max_cents is null or price_max_cents >= 0),
  price_note         text,
  -- bottles can be added or changed until this moment
  bottle_lock_at     timestamptz,
  invite_only        boolean not null default false,
  status             text not null default 'draft'
                     check (status in ('draft', 'open', 'closed', 'settled')),
  created_at         timestamptz not null default now()
);

-- ---------- guest profiles ----------
create table public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  email      text not null,
  full_name  text not null check (length(trim(full_name)) > 0),
  phone      text,
  created_at timestamptz not null default now()
);

-- the profile email always mirrors the signed-in account
create or replace function public.profiles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.jwt() ->> 'email' is not null then
    new.email := lower(auth.jwt() ->> 'email');
  end if;
  new.full_name := trim(new.full_name);
  return new;
end;
$$;
create trigger profiles_guard before insert or update on public.profiles
  for each row execute function public.profiles_guard();

-- ---------- invitations (for invite-only evenings) ----------
create table public.invitations (
  event_id   uuid not null references public.events on delete cascade,
  email      text not null check (email = lower(email)),
  created_at timestamptz not null default now(),
  primary key (event_id, email)
);

-- ---------- reservations ----------
-- interested  registered interest, nothing paid
-- pending     seat held while the guest pays the deposit
-- reserved    deposit paid (or waived): the seat is theirs
-- waitlisted  the table was full when they tried to reserve
-- cancelled   kept as history; a guest can reserve again afterwards
create table public.reservations (
  id                    uuid primary key default gen_random_uuid(),
  event_id              uuid not null references public.events on delete cascade,
  user_id               uuid not null references public.profiles on delete cascade,
  status                text not null
                        check (status in ('interested', 'pending', 'reserved', 'waitlisted', 'cancelled')),
  hold_expires_at       timestamptz,
  waitlisted_at         timestamptz,
  stripe_session_id     text unique,
  stripe_payment_intent text,
  deposit_paid_cents    int not null default 0,
  paid_at               timestamptz,
  cancelled_at          timestamptz,
  refund_status         text check (refund_status in ('refunded', 'forfeited', 'none')),
  refunded_cents        int,
  settled               boolean not null default false,
  created_at            timestamptz not null default now()
);
-- one live reservation per guest per evening
create unique index reservations_one_live
  on public.reservations (event_id, user_id) where status <> 'cancelled';
create index reservations_event on public.reservations (event_id, status);

-- ---------- bottle assistant lookups ----------
-- Written only by the bottle-assist edge function (service role): what the
-- label reader saw, and what the research agent found (market price,
-- sources, background). Guests can read their own; a bottle links to the
-- research lookup it came from, so its market price cannot be typed in.
create table public.bottle_lookups (
  id         uuid primary key default gen_random_uuid(),
  event_id   uuid not null references public.events on delete cascade,
  user_id    uuid not null references public.profiles on delete cascade,
  kind       text not null check (kind in ('label', 'research')),
  query      jsonb not null,
  result     jsonb,
  created_at timestamptz not null default now()
);
create index bottle_lookups_user on public.bottle_lookups (user_id, created_at);

-- ---------- bottles ----------
create table public.bottles (
  id          uuid primary key default gen_random_uuid(),
  event_id    uuid not null references public.events on delete cascade,
  user_id     uuid not null references public.profiles on delete cascade,
  producer    text not null check (length(trim(producer)) > 0),
  wine        text not null check (length(trim(wine)) > 0),
  vintage     int  check (vintage is null or vintage between 1800 and 2100),
  region      text,
  price_cents int  not null check (price_cents >= 0),
  photo_path  text,
  note        text,
  -- proposed by the guest; Kai can approve, or decline an off-theme bottle
  status      text not null default 'proposed' check (status in ('proposed', 'approved', 'declined')),
  admin_note  text,
  -- from the research agent (copied from bottle_lookups, never typed by a guest)
  lookup_id         uuid references public.bottle_lookups on delete set null,
  market_cents      int,
  market_low_cents  int,
  market_high_cents int,
  market_note       text,
  market_sources    jsonb,
  background        text,
  created_at  timestamptz not null default now()
);
create index bottles_event on public.bottles (event_id);

-- guests cannot approve their own bottles or move them to another evening;
-- any edit by a guest sends the bottle back for review
create or replace function public.bottles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  res jsonb;
begin
  if public.is_admin() or auth.uid() is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    new.user_id    := old.user_id;
    new.event_id   := old.event_id;
    new.admin_note := old.admin_note;
  end if;
  new.status := 'proposed';

  -- market price and background only ever come from the guest's own lookup
  if tg_op = 'UPDATE' and new.lookup_id is not distinct from old.lookup_id then
    new.market_cents      := old.market_cents;
    new.market_low_cents  := old.market_low_cents;
    new.market_high_cents := old.market_high_cents;
    new.market_note       := old.market_note;
    new.market_sources    := old.market_sources;
    new.background        := old.background;
  else
    select l.result into res from public.bottle_lookups l
    where l.id = new.lookup_id and l.user_id = auth.uid() and l.kind = 'research';
    if res is null then
      new.lookup_id := null;
    end if;
    new.market_cents      := (res ->> 'market_cents')::int;
    new.market_low_cents  := (res ->> 'market_low_cents')::int;
    new.market_high_cents := (res ->> 'market_high_cents')::int;
    new.market_note       := res ->> 'market_note';
    new.market_sources    := res -> 'sources';
    new.background        := res ->> 'background';
  end if;
  return new;
end;
$$;
create trigger bottles_guard before insert or update on public.bottles
  for each row execute function public.bottles_guard();

-- true while the signed-in guest holds a seat and the line-up is still open
create or replace function public.can_edit_bottles(p_event uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.events e
    join public.reservations r on r.event_id = e.id
    where e.id = p_event
      and e.format = 'byob'
      and e.status = 'open'
      and now() < e.starts_at
      and (e.bottle_lock_at is null or now() < e.bottle_lock_at)
      and r.user_id = auth.uid()
      and r.status = 'reserved'
  );
$$;

-- =========================================================
-- Row level security
-- =========================================================
alter table public.admins       enable row level security;
alter table public.events       enable row level security;
alter table public.profiles     enable row level security;
alter table public.invitations  enable row level security;
alter table public.reservations enable row level security;
alter table public.bottles      enable row level security;
alter table public.bottle_lookups enable row level security;

create policy "admins: admin reads" on public.admins
  for select to authenticated using (public.is_admin());

create policy "events: public reads published" on public.events
  for select using (status <> 'draft' or public.is_admin());
create policy "events: admin writes" on public.events
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "profiles: own" on public.profiles
  for select to authenticated using (id = auth.uid() or public.is_admin());
create policy "profiles: create own" on public.profiles
  for insert to authenticated with check (id = auth.uid());
create policy "profiles: update own" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy "invitations: own or admin" on public.invitations
  for select to authenticated
  using (email = lower(coalesce(auth.jwt() ->> 'email', '')) or public.is_admin());
create policy "invitations: admin writes" on public.invitations
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "reservations: own or admin" on public.reservations
  for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy "reservations: admin writes" on public.reservations
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy "bottle lookups: own or admin" on public.bottle_lookups
  for select to authenticated using (user_id = auth.uid() or public.is_admin());

create policy "bottles: own or admin" on public.bottles
  for select to authenticated using (user_id = auth.uid() or public.is_admin());
create policy "bottles: guest adds" on public.bottles
  for insert to authenticated
  with check (user_id = auth.uid() and public.can_edit_bottles(event_id));
create policy "bottles: guest edits" on public.bottles
  for update to authenticated
  using (user_id = auth.uid() and public.can_edit_bottles(event_id))
  with check (user_id = auth.uid());
create policy "bottles: guest removes" on public.bottles
  for delete to authenticated
  using (user_id = auth.uid() and public.can_edit_bottles(event_id));
create policy "bottles: admin" on public.bottles
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

grant select on public.events to anon, authenticated;
grant insert, update, delete on public.events to authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, delete on public.invitations to authenticated;
grant select, insert, update on public.reservations to authenticated;
grant select, insert, update, delete on public.bottles to authenticated;
grant select on public.admins to authenticated;
grant select on public.bottle_lookups to authenticated;

-- =========================================================
-- Functions the pages call
-- =========================================================

-- seats taken, waitlist and interest counts for one evening
create or replace function public.event_counts(p_slug text)
returns table (seats_taken int, waitlisted int, interested int)
language sql stable security definer set search_path = public as $$
  select
    count(*) filter (where r.status = 'reserved'
                        or (r.status = 'pending' and r.hold_expires_at > now()))::int,
    count(*) filter (where r.status = 'waitlisted')::int,
    count(*) filter (where r.status = 'interested')::int
  from public.events e
  left join public.reservations r on r.event_id = e.id
  where e.slug = p_slug and (e.status <> 'draft' or public.is_admin());
$$;

-- the signed-in guest's place in the waitlist (1 = next), or null
create or replace function public.my_waitlist_position(p_slug text)
returns int
language sql stable security definer set search_path = public as $$
  select q.pos::int from (
    select r.user_id, row_number() over (order by r.waitlisted_at, r.created_at) as pos
    from public.reservations r join public.events e on e.id = r.event_id
    where e.slug = p_slug and r.status = 'waitlisted'
  ) q
  where q.user_id = auth.uid();
$$;

-- register interest without paying
create or replace function public.register_interest(p_slug text)
returns text
language plpgsql security definer set search_path = public as $$
declare
  ev public.events%rowtype;
  cur public.reservations%rowtype;
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
  insert into public.reservations (event_id, user_id, status)
  values (ev.id, auth.uid(), 'interested');
  return 'interested';
end;
$$;

-- withdraw interest or leave the waitlist (paid seats go through the
-- cancel-reservation edge function, which handles the refund)
create or replace function public.withdraw(p_slug text)
returns void
language sql security definer set search_path = public as $$
  update public.reservations r
  set status = 'cancelled', cancelled_at = now(), refund_status = 'none'
  from public.events e
  where e.id = r.event_id and e.slug = p_slug
    and r.user_id = auth.uid()
    and r.status in ('interested', 'waitlisted');
$$;

-- Hold a seat for a guest while they pay, or put them on the waitlist.
-- Called only by the create-deposit-checkout edge function (service role).
-- A seat that frees up goes to the waitlist in order before anyone new.
create or replace function public.hold_seat(p_event uuid, p_user uuid, p_email text,
                                            p_hold interval default interval '35 minutes')
returns table (reservation_id uuid, outcome text)
language plpgsql security definer set search_path = public as $$
declare
  ev        public.events%rowtype;
  cur       public.reservations%rowtype;
  free      int;
  queue_len int;
  my_pos    int;
begin
  -- lock the evening so two guests cannot take the last seat at once
  select * into ev from public.events where id = p_event for update;
  if not found or ev.status <> 'open' then raise exception 'event_not_open'; end if;
  if ev.deposit_cents is null then raise exception 'deposit_not_set'; end if;
  if now() >= ev.starts_at then raise exception 'event_started'; end if;
  if ev.invite_only and not exists (
    select 1 from public.invitations where event_id = p_event and email = lower(p_email)
  ) then
    raise exception 'not_invited';
  end if;

  select * into cur from public.reservations
  where event_id = p_event and user_id = p_user and status <> 'cancelled';
  if cur.id is not null and cur.status = 'reserved' then
    return query select cur.id, 'already_reserved'::text;
    return;
  end if;
  -- a guest still inside their hold keeps the seat and simply retries payment
  if cur.id is not null and cur.status = 'pending' and cur.hold_expires_at > now() then
    update public.reservations set hold_expires_at = now() + p_hold where id = cur.id;
    return query select cur.id, 'hold'::text;
    return;
  end if;

  select ev.seats - count(*) into free
  from public.reservations r
  where r.event_id = p_event and r.user_id <> p_user
    and (r.status = 'reserved' or (r.status = 'pending' and r.hold_expires_at > now()));

  select count(*) into queue_len
  from public.reservations where event_id = p_event and status = 'waitlisted';

  select q.pos into my_pos from (
    select r.user_id, row_number() over (order by r.waitlisted_at, r.created_at) as pos
    from public.reservations r where r.event_id = p_event and r.status = 'waitlisted'
  ) q where q.user_id = p_user;

  if free > 0 and ((my_pos is not null and my_pos <= free)
                   or (my_pos is null and queue_len < free)) then
    if ev.deposit_cents = 0 then
      -- no deposit asked: the seat is confirmed straight away
      if cur.id is null then
        insert into public.reservations (event_id, user_id, status, paid_at)
        values (p_event, p_user, 'reserved', now()) returning id into cur.id;
      else
        update public.reservations
        set status = 'reserved', paid_at = now(), hold_expires_at = null
        where id = cur.id;
      end if;
      return query select cur.id, 'reserved'::text;
    else
      if cur.id is null then
        insert into public.reservations (event_id, user_id, status, hold_expires_at)
        values (p_event, p_user, 'pending', now() + p_hold) returning id into cur.id;
      else
        update public.reservations
        set status = 'pending', hold_expires_at = now() + p_hold
        where id = cur.id;
      end if;
      return query select cur.id, 'hold'::text;
    end if;
  else
    if cur.id is null then
      insert into public.reservations (event_id, user_id, status, waitlisted_at)
      values (p_event, p_user, 'waitlisted', now()) returning id into cur.id;
    elsif cur.status <> 'waitlisted' then
      update public.reservations
      set status = 'waitlisted', waitlisted_at = now(), hold_expires_at = null
      where id = cur.id;
    end if;
    return query select cur.id, 'waitlisted'::text;
  end if;
end;
$$;

-- The bottle line-up, oldest to youngest. Public, first names only.
create or replace function public.event_lineup(p_slug text)
returns table (bottle_id uuid, guest text, producer text, wine text, vintage int,
               region text, photo_path text, background text, status text, mine boolean)
language sql stable security definer set search_path = public as $$
  select b.id, split_part(p.full_name, ' ', 1), b.producer, b.wine, b.vintage,
         b.region, b.photo_path, b.background, b.status, coalesce(b.user_id = auth.uid(), false)
  from public.bottles b
  join public.events e on e.id = b.event_id
  join public.profiles p on p.id = b.user_id
  join public.reservations r
    on r.event_id = b.event_id and r.user_id = b.user_id and r.status = 'reserved'
  where e.slug = p_slug and (e.status <> 'draft' or public.is_admin())
    and b.status <> 'declined'
  order by b.vintage nulls last, b.created_at;
$$;

-- The shared cost split, for seated guests and Kai only.
--   total   = every bottle brought (not declined) + shared costs
--   share   = total / seated guests
--   balance = share - bottles brought - deposit paid
-- A positive balance is owed to Kai; a negative one is paid back to the guest.
create or replace function public.event_tally(p_slug text)
returns table (guest text, mine boolean, bottles int, bottles_cents int,
               deposit_cents int, share_cents int, balance_cents int, settled boolean,
               reservation_id uuid)
language plpgsql stable security definer set search_path = public as $$
declare
  ev    public.events%rowtype;
  n     int;
  total bigint;
  share int;
begin
  select * into ev from public.events where slug = p_slug;
  if not found then return; end if;
  if not (public.is_admin() or exists (
    select 1 from public.reservations
    where event_id = ev.id and user_id = auth.uid() and status = 'reserved'
  )) then
    raise exception 'not_a_guest';
  end if;

  select count(*) into n from public.reservations
  where event_id = ev.id and status = 'reserved';
  if n = 0 then return; end if;

  select coalesce(sum(b.price_cents), 0) into total
  from public.bottles b
  join public.reservations r
    on r.event_id = b.event_id and r.user_id = b.user_id and r.status = 'reserved'
  where b.event_id = ev.id and b.status <> 'declined';
  total := total + ev.shared_costs_cents;
  share := round(total::numeric / n);

  return query
  select
    case when public.is_admin() then p.full_name else split_part(p.full_name, ' ', 1) end,
    coalesce(r.user_id = auth.uid(), false),
    count(b.id)::int,
    coalesce(sum(b.price_cents), 0)::int,
    r.deposit_paid_cents,
    share,
    (share - coalesce(sum(b.price_cents), 0) - r.deposit_paid_cents)::int,
    r.settled,
    case when public.is_admin() then r.id end
  from public.reservations r
  join public.profiles p on p.id = r.user_id
  left join public.bottles b
    on b.event_id = r.event_id and b.user_id = r.user_id and b.status <> 'declined'
  where r.event_id = ev.id and r.status = 'reserved'
  group by r.id, p.full_name
  order by p.full_name;
end;
$$;

-- Every bottle's declared price beside the research agent's market estimate.
-- Shared with the seated guests and Kai, like the tally.
create or replace function public.event_bottle_prices(p_slug text)
returns table (bottle_id uuid, guest text, producer text, wine text, vintage int,
               price_cents int, market_cents int, market_low_cents int,
               market_high_cents int, market_note text, market_sources jsonb, mine boolean)
language plpgsql stable security definer set search_path = public as $$
declare
  ev public.events%rowtype;
begin
  select * into ev from public.events where slug = p_slug;
  if not found then return; end if;
  if not (public.is_admin() or exists (
    select 1 from public.reservations
    where event_id = ev.id and user_id = auth.uid() and status = 'reserved'
  )) then
    raise exception 'not_a_guest';
  end if;
  return query
  select b.id, split_part(p.full_name, ' ', 1), b.producer, b.wine, b.vintage,
         b.price_cents, b.market_cents, b.market_low_cents, b.market_high_cents,
         b.market_note, b.market_sources, coalesce(b.user_id = auth.uid(), false)
  from public.bottles b
  join public.profiles p on p.id = b.user_id
  join public.reservations r
    on r.event_id = b.event_id and r.user_id = b.user_id and r.status = 'reserved'
  where b.event_id = ev.id and b.status <> 'declined'
  order by b.vintage nulls last, b.created_at;
end;
$$;

revoke execute on function public.hold_seat(uuid, uuid, text, interval) from public, anon, authenticated;
grant  execute on function public.hold_seat(uuid, uuid, text, interval) to service_role;
grant execute on function public.event_counts(text), public.event_lineup(text) to anon, authenticated;
grant execute on function public.event_tally(text), public.event_bottle_prices(text),
                          public.register_interest(text),
                          public.withdraw(text), public.my_waitlist_position(text) to authenticated;

-- =========================================================
-- Label photos: a public bucket, each guest uploads into their own folder
-- =========================================================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('labels', 'labels', true, 5242880, array['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
on conflict (id) do nothing;

create policy "labels: guests upload to own folder" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'labels' and (storage.foldername(name))[1] = auth.uid()::text);
create policy "labels: guests remove own" on storage.objects
  for delete to authenticated
  using (bucket_id = 'labels' and (storage.foldername(name))[1] = auth.uid()::text);
