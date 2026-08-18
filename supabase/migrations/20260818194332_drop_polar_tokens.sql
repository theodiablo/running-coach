-- Running Coach — drop the legacy per-provider Polar token table.
--
-- `20260730204228_integration_connections.sql` copied every polar_tokens row
-- into the generic `integration_connections` table (provider = 'polar') and
-- said the original would be dropped "once verified live". It is: the rewritten
-- `polar-import` (deployed 2026-08-04) writes only integration_connections, and
-- polar_tokens has been empty since — nothing was left behind by the dual-read
-- window this table existed to cover.
--
-- The dual-read fallback in `polar-import` goes with it, so connecting Polar is
-- now a plain OAuth exchange into integration_connections. Deploy order doesn't
-- matter: the fallback ignored the query error and reported "not connected",
-- the same answer the empty table gave.

drop table if exists public.polar_tokens;
