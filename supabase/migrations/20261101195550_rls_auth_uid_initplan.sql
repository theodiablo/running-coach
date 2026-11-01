-- Wrap auth.uid() in a scalar subquery so Postgres evaluates it once per
-- statement instead of once per row (advisor lint 0003 auth_rls_initplan).
-- Semantics are unchanged; ALTER POLICY keeps each policy's command and roles.

alter policy "agent_rounds read own" on public.agent_rounds
  using (exists (select 1 from public.agent_trajectories t
                 where t.id = agent_rounds.trajectory_id and t.user_id = (select auth.uid())));

alter policy "agent_trajectories read own" on public.agent_trajectories
  using ((select auth.uid()) = user_id);

alter policy "app_state insert own" on public.app_state
  with check ((select auth.uid()) = user_id);
alter policy "app_state read own" on public.app_state
  using ((select auth.uid()) = user_id);
alter policy "app_state update own" on public.app_state
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter policy "beta_feedback insert own" on public.beta_feedback
  with check ((select auth.uid()) = user_id);

alter policy "coach_feedback insert own" on public.coach_feedback
  with check ((select auth.uid()) = user_id
              and exists (select 1 from public.agent_trajectories t
                          where t.id = coach_feedback.trajectory_id and t.user_id = (select auth.uid())));

alter policy "live_runs delete own" on public.live_runs
  using ((select auth.uid()) = user_id);
alter policy "live_runs insert own" on public.live_runs
  with check ((select auth.uid()) = user_id);
alter policy "live_runs read own" on public.live_runs
  using ((select auth.uid()) = user_id);
alter policy "live_runs update own" on public.live_runs
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter policy "live_share_tokens claim own" on public.live_share_tokens
  with check ((select auth.uid()) = user_id
              and (select count(*) from public.live_share_tokens t
                   where t.user_id = (select auth.uid())) < 100);
alter policy "live_share_tokens read own" on public.live_share_tokens
  using ((select auth.uid()) = user_id);
alter policy "live_share_tokens retire own" on public.live_share_tokens
  using ((select auth.uid()) = user_id and revoked_at is null)
  with check ((select auth.uid()) = user_id and revoked_at is not null);

alter policy "profiles insert own" on public.profiles
  with check ((select auth.uid()) = id);
alter policy "profiles read own" on public.profiles
  using ((select auth.uid()) = id);
alter policy "profiles update own" on public.profiles
  using ((select auth.uid()) = id);

alter policy "race_editions delete own unverified" on public.race_editions
  using ((select auth.uid()) = created_by and not verified);
alter policy "race_editions update own unverified" on public.race_editions
  using ((select auth.uid()) = created_by and not verified)
  with check ((select auth.uid()) = created_by and not verified);

alter policy "race_reports insert own" on public.race_reports
  with check ((select auth.uid()) = reporter_id);

alter policy "races delete own unverified" on public.races
  using ((select auth.uid()) = created_by and not verified);
alter policy "races update own unverified" on public.races
  using ((select auth.uid()) = created_by and not verified)
  with check ((select auth.uid()) = created_by and not verified);

alter policy "run_routes delete own" on public.run_routes
  using ((select auth.uid()) = user_id);
alter policy "run_routes insert own" on public.run_routes
  with check ((select auth.uid()) = user_id);
alter policy "run_routes read own" on public.run_routes
  using ((select auth.uid()) = user_id);
alter policy "run_routes update own" on public.run_routes
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter policy "saved_routes delete own" on public.saved_routes
  using ((select auth.uid()) = user_id);
alter policy "saved_routes insert own" on public.saved_routes
  with check ((select auth.uid()) = user_id);
alter policy "saved_routes read own" on public.saved_routes
  using ((select auth.uid()) = user_id);
alter policy "saved_routes update own" on public.saved_routes
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

alter policy "shell_diagnostics delete own" on public.shell_diagnostics
  using ((select auth.uid()) = user_id);
alter policy "shell_diagnostics insert own" on public.shell_diagnostics
  with check ((select auth.uid()) = user_id);
alter policy "shell_diagnostics read own" on public.shell_diagnostics
  using ((select auth.uid()) = user_id);
