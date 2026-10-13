-- Invitations carry the guest's name, so an invited guest is not asked for
-- it again after signing in; Kai can correct a name (hence update).
alter table public.invitations add column if not exists name text;
grant update on public.invitations to authenticated;
