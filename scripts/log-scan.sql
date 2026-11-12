-- Daily Supabase log scan (scripts/log-scan.sh). Returns ONLY anomalies: a quiet
-- day is zero rows. Thresholds live here; see docs/monitoring.md before tuning.
-- Columns are counts and codes only: the job summary is public. Never output an
-- IP, a user id, a name or a log message.
select src, code, what, n from (

  -- Failures -----------------------------------------------------------------

  -- Auth 5xx at the gateway: a failing /recover or /signup locks users out.
  select 'auth' as src, log_attributes['response.status_code'] as code,
         log_attributes['request.path'] as what, count() as n
  from logs
  where source = 'edge_logs' and startsWith(log_attributes['request.path'], '/auth/v1/')
    and toInt32OrZero(log_attributes['response.status_code']) >= 500
  group by code, what having n >= 1

  union all
  -- GoTrue's own error lines (its access log carries no route).
  select 'auth' as src, log_attributes['level'] as code, 'gotrue error log' as what, count() as n
  from logs
  where source = 'auth_logs' and log_attributes['level'] in ('error', 'fatal', 'panic')
  group by code having n >= 1

  union all
  -- Other gateway 5xx (REST, realtime, storage); ids masked out of paths.
  select 'api' as src, log_attributes['response.status_code'] as code,
         replaceRegexpAll(log_attributes['request.path'], '[0-9A-Za-z_-]{20,}', ':id') as what,
         count() as n
  from logs
  where source = 'edge_logs' and not startsWith(log_attributes['request.path'], '/auth/v1/')
    and toInt32OrZero(log_attributes['response.status_code']) >= 500
  group by code, what having n >= 3

  union all
  -- Any 5xx from an edge function.
  select 'function' as src, log_attributes['response.status_code'] as code,
         log_attributes['request.pathname'] as what, count() as n
  from logs
  where source = 'function_edge_logs' and toInt32OrZero(log_attributes['response.status_code']) >= 500
  group by code, what having n >= 1

  union all
  -- Lifecycle events other than Boot/Shutdown/Log: a boot failure or a crash.
  select 'function-event' as src, log_attributes['event_type'] as code,
         log_attributes['function_id'] as what, count() as n
  from logs
  where source = 'function_logs' and log_attributes['event_type'] not in ('Boot', 'Shutdown', 'Log', '')
  group by code, what having n >= 1

  union all
  -- console.error inside functions: clients hanging up log a few a day.
  select 'function-error-log' as src, 'error' as code, log_attributes['function_id'] as what, count() as n
  from logs
  where source = 'function_logs' and log_attributes['level'] = 'error'
  group by what having n >= 10

  union all
  -- Calls of 30 s or more: a function drifting toward its wall-clock limit.
  select 'function-slow' as src, '>=30s' as code, log_attributes['request.pathname'] as what, count() as n
  from logs
  where source = 'function_edge_logs' and toFloat64OrZero(log_attributes['execution_time_ms']) >= 30000
  group by what having n >= 3

  union all
  -- Postgres: FATAL/PANIC always; an ERROR state seen daily (signed-out clients
  -- refused by grants/RLS, realtime filter checks, unique-slug retries) only in bulk.
  select 'postgres' as src, log_attributes['parsed.error_severity'] as code,
         log_attributes['parsed.sql_state_code'] as what, count() as n
  from logs
  where source = 'postgres_logs' and log_attributes['parsed.error_severity'] in ('ERROR', 'FATAL', 'PANIC')
  group by code, what
  having n >= if(code = 'ERROR' and what in ('42501', 'P0001', '23505'), 25, 1)

  union all
  -- Realtime errors: live sharing rides on it.
  select 'realtime' as src, log_attributes['level'] as code, 'realtime error log' as what, count() as n
  from logs
  where source = 'realtime_logs' and log_attributes['level'] in ('error', 'critical')
  group by code having n >= 3

  -- Abuse and attacks ----------------------------------------------------------

  union all
  -- Failed password sign-ins / token refreshes, all sources.
  select 'auth-failed' as src, '400' as code, '/auth/v1/token' as what, count() as n
  from logs
  where source = 'edge_logs' and log_attributes['request.path'] = '/auth/v1/token'
    and log_attributes['response.status_code'] = '400'
  having n >= 20

  union all
  -- Addresses with 10+ failed sign-ins: credential stuffing. Counts IPs, never names them.
  select 'auth-failed' as src, 'per-ip' as code, 'IPs with 10+ failures' as what, count() as n
  from (
    select log_attributes['request.headers.cf_connecting_ip'] as ip, count() as c
    from logs
    where source = 'edge_logs' and log_attributes['request.path'] = '/auth/v1/token'
      and log_attributes['response.status_code'] = '400'
    group by ip having c >= 10
  )
  having n >= 1

  union all
  -- Admin API writes (create/delete users, set passwords). No edge function calls
  -- it, so outside your own dashboard use this means the service-role key is in use.
  select 'auth-admin' as src, log_attributes['request.method'] as code,
         replaceRegexpAll(log_attributes['request.path'], '[0-9A-Za-z_-]{20,}', ':id') as what, count() as n
  from logs
  where source = 'edge_logs' and startsWith(log_attributes['request.path'], '/auth/v1/admin/')
    and log_attributes['request.method'] not in ('GET', 'HEAD', 'OPTIONS')
  group by code, what having n >= 1

  union all
  -- Signup / reset bursts: throwaway accounts multiply coach budgets and catalogue
  -- caps; a reset burst can be someone mail-bombing an address.
  select 'auth-burst' as src, JSONExtractString(event_message, 'auth_audit_event', 'action') as code,
         'per day' as what, count() as n
  from logs
  where source = 'auth_audit_logs'
    and JSONExtractString(event_message, 'auth_audit_event', 'action') in ('user_signedup', 'user_recovery_requested')
  group by code having n >= 20

  union all
  -- Rate limits being hit (mailer cooldown, coach daily limit, live-watch throttle).
  select 'rate-limited' as src, '429' as code,
         replaceRegexpAll(log_attributes['request.path'], '[0-9A-Za-z_-]{20,}', ':id') as what, count() as n
  from logs
  where source = 'edge_logs' and log_attributes['response.status_code'] = '429'
  group by what having n >= 10

  union all
  -- 403/404/405 bursts: someone probing endpoints or RPCs. 401 is the known
  -- signed-out-client noise.
  select 'probing' as src, log_attributes['response.status_code'] as code,
         splitByChar('/', log_attributes['request.path'])[2] as what, count() as n
  from logs
  where source = 'edge_logs' and log_attributes['response.status_code'] in ('403', '404', '405')
  group by code, what having n >= 50

  union all
  -- Coach volume: the model bill. About 75 calls on a normal day.
  select 'coach-volume' as src, 'calls' as code, '/functions/v1/coach-agent' as what, count() as n
  from logs
  where source = 'function_edge_logs' and log_attributes['request.pathname'] = '/functions/v1/coach-agent'
  having n >= 400

  union all
  -- One address driving the coach hard: scripted use. Counts IPs, never names them.
  select 'coach-volume' as src, 'per-ip' as code, 'IPs with 150+ coach calls' as what, count() as n
  from (
    select log_attributes['request.headers.cf_connecting_ip'] as ip, count() as c
    from logs
    where source = 'function_edge_logs' and log_attributes['request.pathname'] = '/functions/v1/coach-agent'
    group by ip having c >= 150
  )
  having n >= 1

  -- Silence ----------------------------------------------------------------------

  union all
  -- Too little successful traffic: the app may be down before it reaches Supabase
  -- (a broken deploy, DNS, a crash on launch), which produces no errors at all.
  select 'traffic' as src, 'low' as code, 'successful API responses' as what, count() as n
  from logs
  where source = 'edge_logs' and toInt32OrZero(log_attributes['response.status_code']) between 200 and 399
  having n < 50
)
