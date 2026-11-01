-- This project's default privileges give service_role no SELECT/INSERT on new
-- tables, so every table an edge function touches as service_role needs an
-- explicit grant. `get` could not count a scan and `notify-contribution` read
-- every contribution as missing, so no maintainer mail went out.

grant select, insert on public.qr_scans to service_role;
grant select on public.races, public.race_editions, public.race_reports to service_role;
