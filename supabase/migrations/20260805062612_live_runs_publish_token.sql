-- Running Coach — native screen-off uploads for a live run (v3 of live sharing).
--
-- On Android, a backgrounded WebView runs no JS at all, so the JS publisher
-- goes silent the moment the screen locks and a watcher sees the runner frozen
-- at the last screen-on position. The fix is a native uploader in the Android
-- foreground service — which cannot hold a user JWT (it would expire mid-run
-- and refreshing from Java is fragile). So, mirroring share_token, this adds a
-- second per-run capability: publish_token, the WRITE capability. Whoever
-- holds it may continue (never start) this one broadcast.
--
-- Unlike share_token it is never displayed, never in a URL, never handed to
-- anyone — it exists only in the runner's own localStorage and, mid-run, in
-- the native service's memory. Row deletion is the revocation, exactly like
-- the share link.
--
-- The premium model is preserved by construction: opening a broadcast is still
-- the RLS-gated client INSERT (with check is_premium()); the RPCs below only
-- UPDATE or DELETE an existing row, so "starting a broadcast is the privileged
-- act, continuing one never is" stays true on the native path too.

alter table public.live_runs add column if not exists publish_token text;

comment on column public.live_runs.publish_token is
  'Write capability for the live-publish edge function (native screen-off uploads). Minted per run by the client, carried on its writes, dies with the row. Never shown in any UI and never selected by live-watch.';

-- Same enforced shape as share_token: 128 bits base64url minted client-side.
-- A client that weakened this would make its own broadcast writable by guessing.
alter table public.live_runs drop constraint if exists live_runs_publish_token_shape;
alter table public.live_runs add constraint live_runs_publish_token_shape
  check (publish_token is null or publish_token ~ '^[A-Za-z0-9_-]{22,64}$');

-- Uniqueness makes the token resolve to exactly one row (it is the lookup key
-- for the RPCs below). Partial: pre-v3 rows and token-dropped rows are null.
-- The share_token squat attack has no analogue here — a publish token is never
-- given to anyone — but a collision would surface as 23505 naming this index,
-- so the JS publisher classifies it separately and re-mints (publisher.ts).
create unique index if not exists live_runs_publish_token_key
  on public.live_runs (publish_token) where publish_token is not null;

-- The append the native uploader calls (via the live-publish edge function,
-- service role). ONE authoritative UPDATE on purpose: a SELECT-then-UPDATE
-- read-modify-write would race the JS full-trace writer (lost updates,
-- resurrected traces) and make the cap advisory. Decisions inside it:
--
--   * only a 'live' or 'paused' row within its freshness window is touched —
--     an ended run must not be re-animated, and the window keys on updated_at
--     (matching live-watch/isActive; keying on started_at would kill a >6h
--     ultra's uploader) with a 24h started_at backstop so an abandoned or
--     squatted row cannot be kept fresh forever;
--   * incoming points are dropped unless tMs > the stored tail — this makes a
--     retried timed-out-but-committed POST idempotent AND resolves any
--     interleaving with a JS full-trace write deterministically. Timestamps
--     are clamped to now() so a skewed device clock degrades, never bricks;
--   * at the cap the concat is skipped but stats still land, so updated_at
--     keeps advancing — freezing it would make a moving runner read as
--     "signal lost". Thinned history beats false staleness.
--
-- Stats are whitelisted and coerced here, not trusted: the row is served to
-- watchers, and a free-form jsonb would be an unbounded side channel around
-- the points cap.
create or replace function public.live_publish_append(
  p_token text,
  p_points jsonb,
  p_stats jsonb
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_tail_ms numeric;
  v_count integer;
  v_capped boolean := false;
  v_batch jsonb;
  v_now_ms numeric := extract(epoch from now()) * 1000;
begin
  -- The stored tail's timestamp (last non-gap point). Used only to filter the
  -- batch; the UPDATE below remains the single authoritative statement — a
  -- stale read here can only mean a few dropped or duplicated-then-deduped
  -- points, never a lost row.
  select max((p->>2)::numeric) into v_tail_ms
  from public.live_runs r, jsonb_array_elements(r.points) p
  where r.publish_token = p_token and jsonb_typeof(p) = 'array';

  -- Keep gap markers (null) and points strictly after the stored tail, with
  -- timestamps clamped to "no later than now".
  select coalesce(jsonb_agg(
    case when jsonb_typeof(e) = 'null' then e
         else jsonb_build_array(e->0, e->1,
                to_jsonb(least((e->>2)::numeric, v_now_ms)), e->3)
    end order by ord), '[]'::jsonb)
  into v_batch
  from jsonb_array_elements(p_points) with ordinality t(e, ord)
  where jsonb_typeof(e) = 'null'
     or v_tail_ms is null or (e->>2)::numeric > v_tail_ms;

  update public.live_runs
  set points = case when jsonb_array_length(points) < 20000
                    then points || v_batch else points end,
      stats = jsonb_build_object(
        'km',          coalesce((p_stats->>'km')::numeric, (stats->>'km')::numeric, 0),
        'durationSec', coalesce((p_stats->>'durationSec')::numeric, (stats->>'durationSec')::numeric, 0),
        'avgPace',     coalesce((p_stats->>'avgPace')::numeric, (stats->>'avgPace')::numeric, 0),
        'curPace',     coalesce((p_stats->>'curPace')::numeric, (stats->>'curPace')::numeric, 0))
  where publish_token = p_token
    and status in ('live', 'paused')
    and updated_at > now() - interval '6 hours'
    and started_at > now() - interval '24 hours'
  returning jsonb_array_length(points) >= 20000 into v_capped;

  get diagnostics v_count = row_count;
  if v_count = 0 then
    return jsonb_build_object('live', false);
  end if;
  return jsonb_build_object('live', true, 'capped', v_capped);
end;
$$;

-- Teardown by capability: lets a signed-out or offline-at-save session still
-- take a finished run off the air through the edge function (endLiveRun's
-- fallback). DELETE was already premium-free and own-row; by-token is
-- strictly narrower than by-user.
create or replace function public.live_publish_end(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  delete from public.live_runs where publish_token = p_token;
  get diagnostics v_count = row_count;
  return jsonb_build_object('deleted', v_count > 0);
end;
$$;

-- Service-role only: these are reached exclusively through the live-publish
-- edge function, which owns token-shape validation, payload caps and rate
-- limiting. No browser client ever calls them.
revoke execute on function public.live_publish_append(text, jsonb, jsonb) from public;
revoke execute on function public.live_publish_append(text, jsonb, jsonb) from anon;
revoke execute on function public.live_publish_append(text, jsonb, jsonb) from authenticated;
grant execute on function public.live_publish_append(text, jsonb, jsonb) to service_role;
revoke execute on function public.live_publish_end(text) from public;
revoke execute on function public.live_publish_end(text) from anon;
revoke execute on function public.live_publish_end(text) from authenticated;
grant execute on function public.live_publish_end(text) to service_role;

comment on function public.live_publish_append(text, jsonb, jsonb) is
  'Native screen-off upload: single-statement append+stats for the row holding this publish token. Idempotent (tail-timestamp dedupe), capped, ended/stale rows refused. Service role only, via the live-publish edge function.';
comment on function public.live_publish_end(text) is
  'Teardown by publish token (endLiveRun fallback when no session). Service role only, via the live-publish edge function.';
