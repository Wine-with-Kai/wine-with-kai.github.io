-- A short tasting note beside each bottle's background, both written by the
-- bottle assistant from the details the guest confirmed.
-- Also fixes Kai's own bottles: the guard used to skip Kai entirely, so a
-- bottle Kai added on the evening page never picked up its notes.
alter table public.bottles add column tasting_note text;

create or replace function public.bottles_guard() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  res   jsonb;
  admin boolean := public.is_admin();
begin
  if auth.uid() is null then
    return new;
  end if;
  if not admin then
    if tg_op = 'UPDATE' then
      new.user_id    := old.user_id;
      new.event_id   := old.event_id;
      new.admin_note := old.admin_note;
    end if;
    new.status := 'proposed';
  end if;

  if tg_op = 'UPDATE' and new.lookup_id is not distinct from old.lookup_id then
    -- same lookup: guests keep the notes they had; Kai may edit them directly
    if not admin then
      new.market_cents      := old.market_cents;
      new.market_low_cents  := old.market_low_cents;
      new.market_high_cents := old.market_high_cents;
      new.market_note       := old.market_note;
      new.market_sources    := old.market_sources;
      new.background        := old.background;
      new.tasting_note      := old.tasting_note;
    end if;
  else
    -- a new lookup: the notes only ever come from the assistant's own result
    select l.result into res from public.bottle_lookups l
    where l.id = new.lookup_id and (l.user_id = auth.uid() or admin)
      and l.kind in ('label', 'research');
    if res is null and admin then
      return new;
    end if;
    if res is null then
      new.lookup_id := null;
    end if;
    new.market_cents      := (res ->> 'market_cents')::int;
    new.market_low_cents  := (res ->> 'market_low_cents')::int;
    new.market_high_cents := (res ->> 'market_high_cents')::int;
    new.market_note       := res ->> 'market_note';
    new.market_sources    := res -> 'sources';
    new.background        := nullif(res ->> 'background', '');
    new.tasting_note      := nullif(res ->> 'tasting_note', '');
  end if;
  return new;
end;
$$;

drop function if exists public.event_lineup(text);
create function public.event_lineup(p_slug text)
returns table (bottle_id uuid, guest text, producer text, wine text, vintage int,
               region text, photo_path text, background text, tasting_note text,
               status text, mine boolean)
language sql stable security definer set search_path = public as $$
  select b.id, split_part(p.full_name, ' ', 1), b.producer, b.wine, b.vintage,
         b.region, b.photo_path, b.background, b.tasting_note, b.status,
         coalesce(b.user_id = auth.uid(), false)
  from public.bottles b
  join public.events e on e.id = b.event_id
  join public.profiles p on p.id = b.user_id
  join public.reservations r
    on r.event_id = b.event_id and r.user_id = b.user_id and r.status = 'reserved'
  where e.slug = p_slug and (e.status <> 'draft' or public.is_admin())
    and b.status <> 'declined'
  order by b.vintage nulls last, b.created_at;
$$;
grant execute on function public.event_lineup(text) to anon, authenticated;
