-- The bottle assistant no longer searches the web or looks up a market price:
-- one call reads the label and writes the background note, stored as a
-- 'label' lookup. Bottles now take their background from either kind of
-- lookup (still only the guest's own), and carry no market price.
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

  -- the background only ever comes from the guest's own lookup
  if tg_op = 'UPDATE' and new.lookup_id is not distinct from old.lookup_id then
    new.market_cents      := old.market_cents;
    new.market_low_cents  := old.market_low_cents;
    new.market_high_cents := old.market_high_cents;
    new.market_note       := old.market_note;
    new.market_sources    := old.market_sources;
    new.background        := old.background;
  else
    select l.result into res from public.bottle_lookups l
    where l.id = new.lookup_id and l.user_id = auth.uid() and l.kind in ('label', 'research');
    if res is null then
      new.lookup_id := null;
    end if;
    new.market_cents      := (res ->> 'market_cents')::int;
    new.market_low_cents  := (res ->> 'market_low_cents')::int;
    new.market_high_cents := (res ->> 'market_high_cents')::int;
    new.market_note       := res ->> 'market_note';
    new.market_sources    := res -> 'sources';
    new.background        := nullif(res ->> 'background', '');
  end if;
  return new;
end;
$$;
