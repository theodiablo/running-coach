-- Premium entitlement seam (the app's first paid-tier gate).
--
-- Two nullable columns on profiles, both service-role-writable ONLY:
--   premium_until  NULL = free tier; a FUTURE timestamptz = premium until then.
--   premium_since  when this user FIRST became premium. Set on the first grant,
--                  never cleared and never moved forward, so "supporter since
--                  <year>" survives lapses and re-subscribes.
--
-- Why premium_since exists now rather than later: the current-state column
-- alone keeps no history — every overwrite destroys what came before, and a
-- dashboard UPDATE leaves no queryable audit trail. Cumulative-months and
-- lapse/return history are deliberately deferred (the schema should be dictated
-- by what the payment provider's webhook actually sends, and adding a table
-- later is a cheap append-only migration), but "since" is the one datum such a
-- table could never backfill, so it is captured from day one.
--
-- Contract for the first automated writer (RevenueCat webhook, see
-- docs/monetization.md): it must dual-write an append-only entitlement-events
-- table alongside these columns, so fidelity/lapse history starts accruing from
-- the first webhook. Manual comps then go through the provider's granted
-- entitlements, keeping the webhook the single writer to these columns.
--
-- NEVER store timestamptz 'infinity' here. Postgres accepts it, but PostgREST
-- serialises it as the string "infinity", which Date.parse() turns into NaN in
-- both the SPA (src/premium.ts) and the edge functions -- silently demoting a
-- lifetime supporter to the free tier. A lifetime grant is a concrete
-- far-future date (e.g. 2099-01-01).
--
-- Security: NO grant statements are needed, by construction. 20260719120000
-- revoked the table-level insert/update on profiles from `authenticated` and
-- re-granted explicit COLUMN lists (insert: id, email, last_seen_at / update:
-- email, last_seen_at). Column-level grants do not extend to columns added
-- later, so these two are unwritable by any client (the handle_new_user
-- SECURITY DEFINER trigger only ever touches id/email, and a PostgREST upsert
-- needs the column privilege on both the insert and the update path). The
-- table-level SELECT grant DOES cover new columns, and the "profiles read own"
-- RLS policy scopes it to the owner -- which is exactly what the client needs
-- to render its own premium state. service_role has full CRUD (20260719170000).
alter table public.profiles
  add column if not exists premium_until timestamptz,
  add column if not exists premium_since timestamptz;

comment on column public.profiles.premium_until is
  'Premium entitlement expiry. NULL = free tier; a future timestamptz = premium. Service-role-writable only (the premium seam). Never use ''infinity'' -- use a concrete far-future date.';
comment on column public.profiles.premium_since is
  'When this user first became premium (fidelity/loyalty history). Set once on the first grant; never cleared, never moved forward. Service-role-writable only.';
