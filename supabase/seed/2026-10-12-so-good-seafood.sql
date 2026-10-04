-- The first BYOB evening: the trial run at So Good Seafood.
-- Run once in the Supabase SQL Editor, after the main migration.
--
-- Three at the table (Kai, Alvin, Joshua). No deposit, so seats are
-- confirmed straight away and Stripe is not needed. Dinner is S$80++ a
-- head; with 10% service charge and 9% GST that is S$95.92, so S$287.76
-- for three, split evenly with the bottles. Corkage is free.
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
  'Ten courses at So Good Seafood',
  'Our first bring-your-own-bottle evening. Bring a bottle you love and would like to share: any colour, any region. Ten courses of seafood, with corkage on the house.',
  'byob',
  '2026-10-12 19:00:00+08',
  'So Good Seafood, Singapore',
  3,
  0,
  14,
  28776,
  'dinner, ten courses at S$80++ a head; corkage is free',
  8000,
  12000,
  'Bring something you love.',
  '2026-10-09 19:00:00+08',
  false,
  'open'
);
