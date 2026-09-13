-- Running Coach — make rotate_share_link actually able to retire a token.
--
-- The standing-link migration granted `authenticated` select + insert(user_id,
-- token) and nothing else, on purpose: with no UPDATE privilege, "a tombstone
-- is forever" needed no policy to reason about. But `rotate_share_link` is
-- `security invoker`, so its own UPDATE runs with the CALLER's privileges —
-- which meant it raised 42501 and aborted, and Replace link could never work.
-- Nothing in CI could see it: the client test mocks the RPC, and there are no
-- database tests.
--
-- Fixed the way that keeps the function `security invoker` (the repo default —
-- reaching for `security definer` here would buy a second accepted lint-0029
-- exception for something a policy expresses perfectly well): grant the ONE
-- column, and let RLS make the transition one-way.

grant update (revoked_at) on public.live_share_tokens to authenticated;

-- The only legal write: your own ACTIVE row, and only into a retired state.
-- `using` keeps a tombstone out of reach for good; `with check` means an update
-- can only ever SET revoked_at, never clear it. Together with the column grant
-- (no `token`, no `user_id`, no `created_at`) that is the same immutability the
-- absent privilege gave, minus the part that broke rotation.
drop policy if exists "live_share_tokens retire own" on public.live_share_tokens;
create policy "live_share_tokens retire own"
  on public.live_share_tokens for update to authenticated
  using (auth.uid() = user_id and revoked_at is null)
  with check (auth.uid() = user_id and revoked_at is not null);

comment on function public.rotate_share_link(text) is
  'Retire the caller''s active share token and claim a new one, in one transaction. security invoker: exists for atomicity, not privilege — it needs the retire-own policy and the revoked_at column grant to run at all.';
