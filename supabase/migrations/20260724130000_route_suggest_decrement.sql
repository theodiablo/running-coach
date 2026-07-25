-- Running Coach — refund counterpart to increment_route_suggest_usage.
--
-- The route-suggest edge function now charges the daily budget ATOMICALLY BEFORE
-- calling openrouteservice (so two concurrent generations can never both slip
-- under the cap on a stale read), then REFUNDS the unit when the generation was
-- rejected: either the caller was already over budget, or ORS returned no usable
-- loop. This decrement is that refund. Clamped at 0 so a refund can never drive
-- the counter negative. Service role only, exactly like the increment.

create or replace function public.decrement_route_suggest_usage(p_user_id uuid, p_day date)
returns integer language sql security definer set search_path = public as $$
  update public.route_suggest_usage
     set count = greatest(count - 1, 0)
   where user_id = p_user_id and day = p_day
  returning count;
$$;
revoke execute on function public.decrement_route_suggest_usage(uuid, date) from anon, authenticated, public;
grant execute on function public.decrement_route_suggest_usage(uuid, date) to service_role;
