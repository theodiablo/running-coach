-- Contributed races: field rules every client must meet (old builds included), and a duplicate
-- finder the add-race form asks before creating a race (docs/races.md, "Contributing").
-- Constraints are `not valid`: enforced on every insert/update without re-checking existing rows.
set local lock_timeout = '5s';

-- A web address with a real host: a dot and an alphabetic TLD, so `https://https//:x.com` fails.
alter table public.races add constraint races_url_host
  check (url is null or url ~* '^https?://[a-z0-9-]+(\.[a-z0-9-]+)*\.([a-z]{2,}|xn-{2}[a-z0-9-]+)(:[0-9]+)?([/?#]|$)') not valid;

-- Trimmed, and long enough to name something.
alter table public.races add constraint races_name_city_shape
  check (name = btrim(name) and length(name) >= 3
    and (city is null or (city = btrim(city) and length(city) >= 2))) not valid;

-- The same list as src/utils/country.ts (pinned by src/raceSubmissionChecks.test.ts): ISO 3166-1
-- alpha-2 plus XK, without the reserved codes (TA is Tristan da Cunha, not Tanzania).
alter table public.races drop constraint if exists races_country_code;
alter table public.races add constraint races_country_code
  check (country in (
    'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
    'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
    'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
    'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
    'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
    'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
    'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
    'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC',
    'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
    'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
    'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
    'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
    'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
    'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
    'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
    'VN', 'VU', 'WF', 'WS', 'XK', 'YE', 'YT', 'ZA', 'ZM', 'ZW'
  )) not valid;

-- A race date from a year back to two years ahead.
alter policy "race_editions insert own unverified" on public.race_editions
  with check (
    (select auth.uid()) = created_by and verified = false
    and date between current_date - 365 and current_date + 731
    and (select count(*) from public.race_editions e
         where e.created_by = (select auth.uid()) and not e.verified) < 50
  );

create or replace function public.race_km_between(lat1 double precision, lng1 double precision,
  lat2 double precision, lng2 double precision)
returns double precision
language sql
immutable
security invoker
set search_path = ''
as $$
  select 2 * 6371 * asin(least(1, sqrt(greatest(0,
    power(sin(radians(lat2 - lat1) / 2), 2)
    + cos(radians(lat1)) * cos(radians(lat2)) * power(sin(radians(lng2 - lng1) / 2), 2)))))
$$;

-- The distinctive words of a race name: accents folded, generic race words and numbers dropped.
create or replace function public.race_name_tokens(p_name text)
returns text[]
language sql
immutable
security invoker
set search_path = ''
as $$
  select coalesce(array_agg(distinct w), '{}')
  from regexp_split_to_table(translate(lower(left(coalesce(p_name, ''), 200)),
    'áàâäãåéèêëíìîïóòôöõúùûüñçœ', 'aaaaaaeeeeiiiiooooouuuunco'), '[^a-z0-9]+') as w
  where length(w) >= 3 and w !~ '^[0-9]+(k|km|kms)?$'
    and w <> all (array[
      'the', 'and', 'des', 'les', 'las', 'los', 'del', 'der', 'die', 'das', 'und', 'une', 'sur',
      'marathon', 'maraton', 'marato', 'maratona', 'halbmarathon', 'half', 'semi', 'media', 'mezza', 'meia', 'mitja',
      'race', 'run', 'runs', 'running', 'course', 'courses', 'carrera', 'cursa', 'corsa', 'corrida', 'lauf',
      'trail', 'trails', 'ultra', 'international', 'internacional', 'internazionale', 'city', 'ville', 'ciudad',
      'night', 'nocturne', 'nocturna', 'edition', 'annual', 'foulee', 'foulees', 'classic', 'challenge',
      'festival', 'official', 'grand', 'gran', 'prix', 'premio', 'mile', 'miles', 'kms', 'medio',
      'popular', 'cross', 'trofeo', 'trophee', 'memorial', 'san', 'sao', 'santa', 'santo', 'saint', 'sainte',
      'silvestre', 'silbestre', 'silvestrea', 'sylvestre', 'por', 'para', 'con', 'contra'
    ])
$$;

-- Races the one being added may already be (docs/races.md, "Duplicates"). Listed: a name word
-- matching a word of theirs by prefix (so typing finds it), or the same race day within 10 km.
-- `strong` (the form stops and asks) needs an exact shared word and place agreement, or a pin
-- within 2 km on the same race day. `edition_id` is that race day's edition, for reuse.
create or replace function public.race_duplicates(
  p_name text default null,
  p_country text default null,
  p_lat double precision default null,
  p_lng double precision default null,
  p_date date default null,
  p_distance_km double precision default null,
  p_limit integer default 5
)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$
  with q as (
    select public.race_name_tokens(p_name) as toks
  ),
  cand as (
    select r.*, rt.toks as rtoks,
      (select count(*) from unnest(q.toks) t where exists (select 1 from unnest(rt.toks) x where x like t || '%')) as prefix_hits,
      cardinality(array(select unnest(q.toks) intersect select unnest(rt.toks))) as exact_hits,
      greatest(cardinality(q.toks), cardinality(rt.toks), 1) as max_toks,
      greatest(cardinality(q.toks), 1) as n_toks,
      case when p_lat is null or p_lng is null or r.lat is null or r.lng is null then null
        else public.race_km_between(p_lat, p_lng, r.lat, r.lng) end as dist_km,
      (select e.id from public.race_editions e
        where e.race_slug = r.slug and p_date is not null and p_distance_km is not null
          and abs(e.date - p_date) <= 3
          and abs(e.distance_km - p_distance_km) <= greatest(0.5, p_distance_km * 0.05)
        order by abs(e.date - p_date), abs(e.distance_km - p_distance_km)
        limit 1) as edition_id,
      exists (select 1 from public.race_editions e
        where e.race_slug = r.slug and p_distance_km is not null
          and abs(e.distance_km - p_distance_km) <= greatest(0.5, p_distance_km * 0.05)) as same_km
    from public.races r
    cross join q
    cross join lateral (select public.race_name_tokens(r.name) as toks) rt
  ),
  placed as (
    select c.*,
      coalesce(c.dist_km <= 10, c.dist_km is null and p_country is not null and c.country = upper(p_country)) as same_place
    from cand c
  ),
  scored as (
    select p.*,
      coalesce(
        (p.edition_id is not null and (p.dist_km <= 2 or (p.same_place and p.exact_hits > 0)))
        or (p.same_km and p.same_place and p.exact_hits > 0 and p.exact_hits::float / p.max_toks >= 0.5),
        false) as strong
    from placed p
    where p.prefix_hits > 0 or (p.edition_id is not null and p.dist_km <= 10)
  ),
  top as (
    select * from scored s
    order by s.strong desc, (s.edition_id is not null) desc, s.prefix_hits::float / s.n_toks desc,
      s.dist_km asc nulls last, s.name
    limit greatest(1, least(coalesce(p_limit, 5), 10))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
    'slug', t.slug, 'name', t.name, 'city', t.city, 'country', t.country, 'lat', t.lat, 'lng', t.lng,
    'distances', t.distances, 'url', t.url, 'verified', t.verified, 'created_by', t.created_by,
    'terrain', t.terrain, 'strong', t.strong, 'edition_id', t.edition_id, 'dist_km', t.dist_km,
    'editions', (select coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id, 'date', e.date, 'distance_km', e.distance_km, 'elevation', e.elevation,
        'verified', e.verified, 'created_by', e.created_by
      ) order by e.date desc, e.distance_km desc), '[]'::jsonb)
      from public.race_editions e where e.race_slug = t.slug)
  ) order by t.strong desc, (t.edition_id is not null) desc, t.prefix_hits::float / t.n_toks desc,
    t.dist_km asc nulls last, t.name), '[]'::jsonb)
  from top t
$$;

-- The exact repeat, for clients that never ask race_duplicates: an edition on the same day, at the
-- same distance (±0.5 km), of another race pinned within 2 km. Detail carries the existing race.
create or replace function public.race_editions_reject_duplicate()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  pin record;
  dup record;
begin
  if (select auth.role()) is distinct from 'authenticated' then return new; end if;
  select lat, lng into pin from public.races where slug = new.race_slug;
  if pin.lat is null or pin.lng is null then return new; end if;
  select e.race_slug, e.id into dup
    from public.race_editions e join public.races r on r.slug = e.race_slug
   where e.race_slug <> new.race_slug and e.date = new.date
     and abs(e.distance_km - new.distance_km) <= 0.5
     and r.lat is not null and r.lng is not null
     and public.race_km_between(pin.lat, pin.lng, r.lat, r.lng) <= 2
   limit 1;
  if found then
    raise exception 'race_duplicate' using errcode = 'RC409', detail = dup.race_slug, hint = dup.id;
  end if;
  return new;
end
$$;

drop trigger if exists race_editions_reject_duplicate on public.race_editions;
create trigger race_editions_reject_duplicate
  before insert on public.race_editions
  for each row execute function public.race_editions_reject_duplicate();
