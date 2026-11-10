-- Daily Supabase log scan (scripts/log-scan.sh). Returns ONLY anomalies: a quiet
-- day is zero rows. Thresholds live here; see docs/monitoring.md before tuning.
-- Columns are counts and codes only: the job summary is public.
select src, code, what, n from (
  -- Gateway 5xx (REST, realtime, storage, auth routes); ids masked out of paths.
  select 'api' as src, log_attributes['response.status_code'] as code,
         replaceRegexpAll(log_attributes['request.path'], '[0-9A-Za-z_-]{20,}', ':id') as what,
         count() as n
  from logs
  where source = 'edge_logs' and toInt32OrZero(log_attributes['response.status_code']) >= 500
  group by code, what having n >= 3

  union all
  -- Any 5xx from GoTrue: a failing /recover or /signup means users can't get in.
  select 'auth' as src, log_attributes['status'] as code, log_attributes['path'] as what, count() as n
  from logs
  where source = 'auth_logs' and toInt32OrZero(log_attributes['status']) >= 500
  group by code, what having n >= 1

  union all
  -- Any 5xx from an edge function.
  select 'function' as src, log_attributes['response.status_code'] as code,
         log_attributes['request.pathname'] as what, count() as n
  from logs
  where source = 'function_edge_logs' and toInt32OrZero(log_attributes['response.status_code']) >= 500
  group by code, what having n >= 1

  union all
  -- console.error inside functions: clients hanging up log a few a day.
  select 'function-error-log' as src, 'error' as code, log_attributes['function_id'] as what, count() as n
  from logs
  where source = 'function_logs' and log_attributes['level'] = 'error'
  group by what having n >= 10

  union all
  -- Postgres: FATAL/PANIC always; an ERROR state seen daily (signed-out clients
  -- refused by grants/RLS, realtime filter checks, unique-slug retries) only in bulk.
  select 'postgres' as src, log_attributes['parsed.error_severity'] as code,
         log_attributes['parsed.sql_state_code'] as what, count() as n
  from logs
  where source = 'postgres_logs' and log_attributes['parsed.error_severity'] in ('ERROR', 'FATAL', 'PANIC')
  group by code, what
  having n >= if(code = 'ERROR' and what in ('42501', 'P0001', '23505'), 25, 1)
)
