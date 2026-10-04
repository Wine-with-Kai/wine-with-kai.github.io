-- The first BYOB evening: the trial run at So Good Seafood.
-- Run once in the Supabase SQL Editor, after the main migration.
--
-- Three at the table (Kai, Alvin, Joshua). No deposit, so seats are
-- confirmed straight away and Stripe is not needed. Dinner is settled
-- separately: only the bottles are split, at the price each guest shares
-- theirs for.
-- Open to anyone with the link (invite_only false): Kai shares it with Alvin
-- and Joshua on WhatsApp, and the 3-seat limit keeps the table to three.

insert into public.events (
  slug, title, subtitle, description, format, starts_at, venue, seats,
  deposit_cents, refund_days, shared_costs_cents, shared_costs_note,
  price_min_cents, price_max_cents, price_note, bottle_lock_at,
  invite_only, status
) values (
  'so-good-seafood',
  'Bring Something You Love',
  null,
  'Our first bring-your-own-bottle evening. Bring a bottle you love and would like to share: any colour, any region.',
  'byob',
  '2026-10-12 19:00:00+08',
  'So Good Seafood, Singapore',
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
