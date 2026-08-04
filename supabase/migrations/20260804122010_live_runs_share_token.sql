-- Running Coach — public share links for a live run (v2 of live sharing).
--
-- v1 broadcast a run to the runner's OWN other signed-in sessions only, and
-- `auth.uid() = user_id` was the entire authorization story. This adds the one
-- thing needed to share with someone else: a high-entropy token that IS the
-- capability. Whoever holds the link may watch; being signed in grants nothing
-- extra and is not required.
--
-- Deliberately NOT accompanied by an anon SELECT policy. The public read goes
-- through the `live-watch` edge function (service role), for three reasons:
--   * user_id is this table's primary key, so a direct anon read would hand
--     every viewer the runner's account UUID forever. The function returns the
--     trace and nothing that identifies the account.
--   * RLS cannot take a query parameter, so a token-scoped policy would mean
--     smuggling the token through a request header — more moving parts for a
--     weaker result.
--   * rate limiting and a UNIFORM "nothing live here" response (see the
--     function) belong in code, not in a policy.
--
-- The token is minted CLIENT-side (crypto.getRandomValues, 128 bits) and rides
-- the row's INSERT, so a runner can share the link before the run starts: the
-- function answers "nothing live" for a token with no row, which is both the
-- honest answer and the anti-probing one.

alter table public.live_runs add column if not exists share_token text;

comment on column public.live_runs.share_token is
  'Capability token for the public /watch/:token page. Null = same-account-only (v1 behaviour). Minted per run by the client and dropped with the row when the run ends, so the link dies with the broadcast.';

-- 128 bits of randomness is what makes crawling /watch/<guess> hopeless, so the
-- shape is enforced rather than trusted: a client that "simplifies" this to a
-- short or non-random token would silently make its own runs findable. The
-- charset is base64url, which is what the client mints and what survives a URL
-- path segment untouched.
alter table public.live_runs drop constraint if exists live_runs_share_token_shape;
alter table public.live_runs add constraint live_runs_share_token_shape
  check (share_token is null or share_token ~ '^[A-Za-z0-9_-]{22,64}$');

-- Uniqueness is what makes a token resolve to exactly one run. Partial, because
-- every not-shared broadcast leaves this null and those must not collide with
-- each other.
--
-- A consequence worth knowing: someone who was given a link can squat that
-- token on their own row and make the original runner's NEXT insert fail. The
-- publisher degrades by retrying without the token (the run still records and
-- still reaches the runner's own sessions; only the link goes dead), so the
-- worst case is a link that has to be re-shared — never a lost recording.
create unique index if not exists live_runs_share_token_key
  on public.live_runs (share_token) where share_token is not null;
