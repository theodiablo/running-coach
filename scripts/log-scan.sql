-- Daily Supabase log scan (scripts/log-scan.sh). Returns ONLY anomalies: a quiet
-- day is zero rows. Thresholds live here; see docs/monitoring.md before tuning.
-- Columns are counts and codes only: the job summary is public. Never output an
-- IP, a user id, a name or a log message. A path is attacker-chosen text, so it
-- only ever surfaces as a label from the fixed lists below ('other' otherwise);
-- add a table or function there when it ships. log-scan.sh filters cells again.
select src, code, what, n from (

  -- Failures -----------------------------------------------------------------

  -- Gateway: auth 5xx (users locked out), other 5xx, admin API writes (no edge
  -- function calls it: outside dashboard use, the service-role key is in use),
  -- 429s, and 403/404/405 probing. 401 is the known signed-out-client noise.
  select src, code, what, count() as n
  from (
    select log_attributes['request.path'] as p, log_attributes['request.method'] as m,
           toInt32OrZero(log_attributes['response.status_code']) as st, splitByChar('/', p) as s,
           multiIf(startsWith(p, '/auth/v1/admin/') and m not in ('GET', 'HEAD', 'OPTIONS'), 'auth-admin',
                   st >= 500 and startsWith(p, '/auth/v1/'), 'auth', st >= 500, 'api',
                   st = 429, 'rate-limited', st in (403, 404, 405), 'probing', '') as src,
           multiIf(src = 'auth-admin', m, src = 'probing', '403/404/405', toString(st)) as code,
           if(s[3] = 'v1' and has(['auth', 'rest', 'functions', 'realtime', 'storage', 'graphql'], s[2]),
              concat('/', s[2], '/v1/', if(has([
                'token', 'signup', 'recover', 'verify', 'user', 'logout', 'otp', 'magiclink', 'authorize',
                'callback', 'admin', 'settings', 'health', 'factors', 'resend', 'reauthenticate', 'invite',
                'rpc', 'agent_rounds', 'agent_trajectories', 'agent_usage', 'app_config', 'app_state',
                'apple_auth_grants', 'beta_feedback', 'coach_feedback', 'contribution_notifications',
                'integration_connections', 'integration_staged_workouts', 'integration_sync_usage',
                'live_broadcast_viewers', 'live_broadcasts', 'live_runs', 'live_share_tokens', 'polar_tokens',
                'profiles', 'qr_scans', 'race_crawl_items', 'race_editions', 'race_field_members', 'race_reports', 'races', 'route_suggest_usage',
                'run_routes', 'saved_routes', 'shell_diagnostics', 'websocket', 'object', 'bucket',
                'admin-metrics', 'apple-auth', 'coach-agent', 'coros-import', 'get', 'live-publish',
                'live-watch', 'notify-contribution', 'polar-import', 'route-suggest', 'suunto-import',
                'suunto-webhook'], s[4]),
                s[4], 'other')), 'other') as what
    from logs
    where source = 'edge_logs'
  )
  where src != ''
  group by src, code, what
  having n >= multiIf(src in ('auth', 'auth-admin'), 1, src = 'api', 3, src = 'rate-limited', 10, 50)

  union all
  -- GoTrue's own error lines (its access log carries no route).
  select 'auth' as src, log_attributes['level'] as code, 'gotrue error log' as what, count() as n
  from logs
  where source = 'auth_logs' and log_attributes['level'] in ('error', 'fatal', 'panic')
  group by code having n >= 1

  union all
  -- Any 5xx from an edge function.
  select 'function' as src, log_attributes['response.status_code'] as code,
         if(has(['admin-metrics', 'apple-auth', 'coach-agent', 'coros-import', 'get', 'live-publish',
                 'live-watch', 'notify-contribution', 'polar-import', 'route-suggest', 'suunto-import',
                 'suunto-webhook'], splitByChar('/', log_attributes['request.pathname'])[4]),
            splitByChar('/', log_attributes['request.pathname'])[4], 'other') as what, count() as n
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
  select 'function-slow' as src, '>=30s' as code,
         if(has(['admin-metrics', 'apple-auth', 'coach-agent', 'coros-import', 'get', 'live-publish',
                 'live-watch', 'notify-contribution', 'polar-import', 'route-suggest', 'suunto-import',
                 'suunto-webhook'], splitByChar('/', log_attributes['request.pathname'])[4]),
            splitByChar('/', log_attributes['request.pathname'])[4], 'other') as what, count() as n
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
      and log_attributes['response.status_code'] = '400' and ip != ''
    group by ip having c >= 10
  )
  having n >= 1

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
      and ip != ''
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
