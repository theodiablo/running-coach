-- Races catalogue goes server-side: a terrain column and the paged search Find, onboarding and What's next? call (docs/races.md).

alter table public.races add column if not exists terrain text;
alter table public.races drop constraint if exists races_terrain_values;
alter table public.races add constraint races_terrain_values check (terrain is null or terrain in ('road', 'trail'));

-- First guess for the existing rows, reviewed by hand afterwards (review-race-crawl).
update public.races r set terrain = case
  when r.name ~* '\m(trail|trails|ultra|ultra-trail|skyrace|sky|vertical|montaña|montana|muntanya|montagne|mountain|spartan)\M'
    or exists (
      select 1 from public.race_editions e
      where e.race_slug = r.slug and e.distance_km > 0 and e.elevation / e.distance_km >= 30
    )
  then 'trail' else 'road' end
where r.terrain is null;

create index if not exists race_editions_date_idx on public.race_editions (date);

create or replace function public.search_races(
  p_query text default null,
  p_min_km double precision default null,
  p_max_km double precision default null,
  p_from date default null,
  p_to date default null,
  p_countries text[] default null,
  p_terrain text default null,
  p_verified_only boolean default false,
  p_lat double precision default null,
  p_lng double precision default null,
  p_radius_km double precision default null,
  p_sort text default 'date',
  p_after_key double precision default null,
  p_after_slug text default null,
  p_limit integer default 20
) returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with params as (
    select
      nullif(translate(lower(trim(coalesce(p_query, ''))), 'áàâäãåéèêëíìîïóòôöõúùûüñçœ', 'aaaaaaeeeeiiiiooooouuuunco'), '') as q,
      greatest(1, least(coalesce(p_limit, 20), 50)) as lim,
      current_date as today
  ),
  eds as (
    select e.*,
      (p_min_km is null or e.distance_km >= p_min_km * 0.95)
        and (p_max_km is null or e.distance_km <= p_max_km * 1.05)
        and (p_from is null or e.date >= p_from)
        and (p_to is null or e.date <= p_to) as hit
    from public.race_editions e
  ),
  agg as (
    select e.race_slug,
      min(e.date) filter (where e.hit and e.date >= (select today from params)) as next_date,
      max(e.date) filter (where e.hit and e.date < (select today from params)) as last_date,
      jsonb_agg(jsonb_build_object(
        'id', e.id, 'date', e.date, 'distance_km', e.distance_km, 'elevation', e.elevation,
        'verified', e.verified, 'created_by', e.created_by
      ) order by e.date desc, e.distance_km desc) as editions
    from eds e
    group by e.race_slug
  ),
  matched as (
    select r.*, a.editions, a.next_date, a.last_date,
      case when p_lat is null or p_lng is null or r.lat is null or r.lng is null then null
        else 2 * 6371 * asin(sqrt(
          power(sin(radians(r.lat - p_lat) / 2), 2)
          + cos(radians(p_lat)) * cos(radians(r.lat)) * power(sin(radians(r.lng - p_lng) / 2), 2)
        )) end as dist_km
    from public.races r
    join agg a on a.race_slug = r.slug
    cross join params p
    where (a.next_date is not null or (p.q is not null and a.last_date is not null and p_from is null and p_to is null))
      and (p.q is null or translate(lower(r.name || ' ' || coalesce(r.city, '') || ' ' || coalesce(r.country, '')),
        'áàâäãåéèêëíìîïóòôöõúùûüñçœ', 'aaaaaaeeeeiiiiooooouuuunco') like '%' || p.q || '%')
      and (coalesce(cardinality(p_countries), 0) = 0 or r.country = any(p_countries))
      and (p_terrain is null or r.terrain is null or r.terrain = p_terrain)
      and (not coalesce(p_verified_only, false) or r.verified)
  ),
  keyed as (
    select m.*,
      case when p_sort = 'distance' then coalesce(m.dist_km, 1e9)
        when m.next_date is not null then (m.next_date - (select today from params))::double precision
        else 100000 + ((select today from params) - m.last_date) end as sort_key
    from matched m
    where p_radius_km is null or (m.dist_km is not null and m.dist_km <= p_radius_km)
  ),
  page as (
    select * from keyed k
    where p_after_slug is null or (k.sort_key, k.slug) > (p_after_key, p_after_slug)
    order by k.sort_key, k.slug
    limit (select lim + 1 from params)
  ),
  shown as (
    select * from page order by sort_key, slug limit (select lim from params)
  )
  select jsonb_build_object(
    'races', coalesce((select jsonb_agg(jsonb_build_object(
      'slug', s.slug, 'name', s.name, 'city', s.city, 'country', s.country, 'lat', s.lat, 'lng', s.lng,
      'distances', s.distances, 'url', s.url, 'verified', s.verified, 'created_by', s.created_by,
      'terrain', s.terrain, 'editions', s.editions, 'dist_km', s.dist_km
    ) order by s.sort_key, s.slug) from shown s), '[]'::jsonb),
    'next', case when (select count(*) from page) > (select lim from params)
      then (select jsonb_build_object('key', s.sort_key, 'slug', s.slug) from shown s order by s.sort_key desc, s.slug desc limit 1)
      else null end,
    'total', case when p_after_slug is null then (select count(*) from keyed) else null end
  );
$$;

grant execute on function public.search_races(text, double precision, double precision, date, date, text[], text, boolean, double precision, double precision, double precision, text, double precision, text, integer) to anon, authenticated;

-- Countries with an upcoming race, for the Find tab's country filter.
create or replace function public.race_countries()
returns table (country text, races bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select r.country, count(distinct r.slug)
  from public.races r
  join public.race_editions e on e.race_slug = r.slug
  where e.date >= current_date and r.country is not null
  group by r.country
  order by 2 desc, 1;
$$;

grant execute on function public.race_countries() to anon, authenticated;
