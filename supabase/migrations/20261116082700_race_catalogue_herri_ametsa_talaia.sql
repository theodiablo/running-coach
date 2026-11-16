-- Add Herri Ametsa Talaia (Donostia mountain cross), from the organiser's site
-- kross.herriametsa.eus. Data-only and idempotent; rules: docs/races.md.
-- Only the 16 km Mendi Krosa is a running race (the 3.7 km family walk and kids'
-- cross are not catalogued).

insert into public.races (slug, name, city, country, lat, lng, distances, url, verified) values
  ('herri-ametsa-talaia', 'Herri Ametsa Talaia', 'Donostia / San Sebastián', 'ES', 43.3284, -1.9431, '[16]', 'https://kross.herriametsa.eus/', true)
on conflict (slug) do nothing;

insert into public.race_editions (id, race_slug, date, distance_km, elevation, verified)
select 'herri-ametsa-talaia-2027-01-31', r.slug, '2027-01-31', 16, 820, true
from public.races r where r.slug = 'herri-ametsa-talaia'
on conflict (id) do nothing;
