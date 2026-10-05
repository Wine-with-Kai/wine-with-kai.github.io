-- The first BYOB evening: the trial run at So Good Seafood.
-- Run once in the Supabase SQL Editor, after the main migration.
--
-- Three at the table (Kai, Alvin, Joshua). No deposit, so seats are
-- confirmed straight away and Stripe is not needed. Dinner is settled
-- separately: only the bottles are split, at the price each guest shares
-- theirs for.
-- Not invite-only: the evening is guarded by a 4-digit seat code that Kai
-- sends with the invitation. Set it on the host page (it is stored in
-- event_codes, never in this public repository).

insert into public.events (
  slug, title, subtitle, description, format, starts_at, venue, seats,
  deposit_cents, refund_days, shared_costs_cents, shared_costs_note,
  price_min_cents, price_max_cents, price_note, bottle_lock_at,
  invite_only, status
) values (
  'so-good-seafood',
  'Something You Love',
  null,
  E'Our first bring-your-own-bottle evening.\nAny colour, any region, ready to drink.',
  'byob',
  '2026-10-12 19:00:00+08',
  'So Good Seafood, 391 Orchard Road, #05-13/14 Ngee Ann City, Podium Block, Singapore 238872',
  3,
  0,
  14,
  0,
  null,
  8000,
  12000,
  'Bring something you love.',
  '2026-10-09 19:00:00+08',
  false,
  'open'
);
