-- Carry `elevation` through the native uploader's stats.
--
-- The watcher used to derive elevation gain from the published trace, which is
-- Douglas-Peucker simplified on HORIZONTAL geometry: a climb taken in a
-- straight line collapses to its endpoints and its ascent goes with it, so the
-- watch page read 181m for a run the recorder measured at 231m. The recorder's
-- own number is now published like `km`, and this function has to preserve it
-- for the screen-off path — the whitelist rebuilds `stats` wholesale, so a key
-- it doesn't name is a key the next native publish erases.
--
-- Body otherwise identical to 20260805062612.
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
  select max((p->>2)::numeric) into v_tail_ms
  from public.live_runs r, jsonb_array_elements(r.points) p
  where r.publish_token = p_token and jsonb_typeof(p) = 'array';

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
        'elevation',   coalesce((p_stats->>'elevation')::numeric, (stats->>'elevation')::numeric, 0),
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
