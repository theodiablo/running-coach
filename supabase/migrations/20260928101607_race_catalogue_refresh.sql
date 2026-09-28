-- Race catalogue refresh (2026-09-28): correct dates, names and URLs, add the
-- next announced editions, and add missing major races. Curation rules: docs/races.md.
--
-- Data-only and idempotent. Most curated races were added outside migrations, so
-- every edition insert joins public.races and silently skips a race this database
-- doesn't have. Editions that a participation already references keep their id
-- and are corrected in place (a participation links by editionId).

-- ── Race-level corrections ──────────────────────────────────────────────────
update public.races set name = 'Bank of America Chicago Marathon' where slug = 'chicago-marathon';
update public.races set name = 'Phoenix Energy Belfast City Marathon' where slug = 'belfast-city-marathon';
update public.races set name = 'AJ Bell Great Manchester Run' where slug = 'great-manchester-run';
update public.races set name = 'AJ Bell Great North Run', url = 'https://www.greatrun.org/events/great-north-run/' where slug = 'great-north-run';
update public.races set name = 'adidas Manchester Marathon' where slug = 'manchester-marathon';
update public.races set name = 'Oysho Royal Parks Half Marathon' where slug = 'royal-parks-half';
update public.races set url = 'https://www.greatwelshmarathon.co.uk/' where slug = 'great-welsh-marathon';
update public.races set city = 'Skirlaugh', lat = 53.8150, lng = -0.2330 where slug = 'east-yorkshire-half';
update public.races set country = 'GB', url = 'https://www.hackneymoves.com/', lat = 51.5490, lng = -0.0360 where slug = 'hackney-half';
update public.races set name = 'ASICS Marathon de Paris', url = 'https://www.asicsmarathondeparis.com/' where slug = 'marathon-de-paris';
update public.races set url = 'https://www.hokasemideparis.fr/' where slug = 'semi-de-paris';
update public.races set name = 'Marathon de Bordeaux AG2R La Mondiale', url = 'https://www.marathon-de-bordeaux-ag2r-la-mondiale.fr/' where slug = 'marathon-de-bordeaux';
update public.races set url = 'https://mediamaratondealicante.com/' where slug = 'media-maraton-alicante';
update public.races set url = 'https://www.mediamaratonsalamanca.es/' where slug = 'media-maraton-salamanca';
update public.races set name = 'Media Maratón de Murcia Costa Cálida', url = 'https://www.maratonmurcia.com/' where slug = 'media-maraton-murcia';
update public.races set name = 'LA21 Media Maratón de Vigo', url = 'https://mediamaratondevigo.com/' where slug = 'media-maraton-vigo';
update public.races set url = 'https://www.donostia.eus/kirola/es/actualidad/agenda-dkirola/eventos/san-silvestre-donostiarra-kopia-2' where slug = 'san-silvestre-donostiarra';

-- The Stirling Scottish Marathon has not been held since 2019; its successor is
-- a different event (the Stirling Half, added below).
delete from public.races where slug = 'stirling-marathon';

-- ── New races ───────────────────────────────────────────────────────────────
insert into public.races (slug, name, city, country, lat, lng, distances, url, verified) values
  ('sydney-marathon',             'TCS Sydney Marathon',                           'Sydney',             'AU', -33.8390, 151.2070, '[42.2]', 'https://www.tcssydneymarathon.com/',                    true),
  ('amsterdam-marathon',          'TCS Amsterdam Marathon',                        'Amsterdam',          'NL',  52.3432,   4.8547, '[42.2]', 'https://www.tcsamsterdammarathon.eu/',                  true),
  ('rotterdam-marathon',          'NN Marathon Rotterdam',                         'Rotterdam',          'NL',  51.9225,   4.4792, '[42.2]', 'https://nnmarathonrotterdam.nl/en/',                    true),
  ('frankfurt-marathon',          'Mainova Frankfurt Marathon',                    'Frankfurt am Main',  'DE',  50.1110,   8.6520, '[42.2]', 'https://www.frankfurt-marathon.com/en/',                true),
  ('berlin-half-marathon',        'GENERALI BERLINER HALBMARATHON',                'Berlin',             'DE',  52.5145,  13.3620, '[21.1]', 'https://www.generali-berliner-halbmarathon.de/en/',     true),
  ('lisbon-marathon',             'EDP Lisbon Marathon',                           'Cascais',            'PT',  38.6784,  -9.3323, '[42.2]', 'https://maratonaclubedeportugal.com/en/',               true),
  ('lisbon-half-marathon',        'EDP Lisbon Half Marathon',                      'Lisbon',             'PT',  38.6800,  -9.1760, '[21.1]', 'https://maratonaclubedeportugal.com/en/corrida-marco/edp-lisbon-half-marathon/', true),
  ('rome-marathon',               'Run Rome The Marathon',                         'Rome',               'IT',  41.8925,  12.4870, '[42.2]', 'https://www.runromethemarathon.com/',                   true),
  ('milano-marathon',             'Wizz Air Milano Marathon',                      'Milan',              'IT',  45.4760,   9.1730, '[42.2]', 'https://www.milanomarathon.it/en/',                     true),
  ('florence-marathon',           'Estra Firenze Marathon',                        'Florence',           'IT',  43.7731,  11.2560, '[42.2]', 'https://www.firenzemarathon.it/en/',                    true),
  ('athens-marathon',             'Athens Marathon. The Authentic',                'Marathon',           'GR',  38.1536,  23.9636, '[42.2]', 'https://www.athensauthenticmarathon.gr/',               true),
  ('vienna-city-marathon',        'Vienna City Marathon',                          'Vienna',             'AT',  48.2340,  16.4150, '[42.2]', 'https://www.vienna-marathon.com/',                      true),
  ('prague-marathon',             'Vodafone Prague Marathon',                      'Prague',             'CZ',  50.0875,  14.4213, '[42.2]', 'https://www.runczech.com/en/',                          true),
  ('copenhagen-marathon',         'Copenhagen Marathon',                           'Copenhagen',         'DK',  55.6660,  12.5740, '[42.2]', 'https://copenhagenmarathon.dk/en/',                     true),
  ('stockholm-marathon',          'adidas Stockholm Marathon',                     'Stockholm',          'SE',  59.3450,  18.0790, '[42.2]', 'https://stockholmmarathon.se/eng/eng-lopare/',          true),
  ('dublin-marathon',             'Irish Life Dublin Marathon',                    'Dublin',             'IE',  53.3340,  -6.2560, '[42.2]', 'https://irishlifedublinmarathon.ie/',                   true),
  ('marathon-de-lille',           'Trek Marathon de Lille',                        'Lille',              'FR',  50.6330,   3.0560, '[42.2]', 'https://marathon-lille.com/',                           true),
  ('marathon-la-rochelle',        'Marathon de La Rochelle Serge Vigot',           'La Rochelle',        'FR',  46.1575,  -1.1510, '[42.2]', 'https://marathondelarochelle.com/',                     true),
  ('semi-boulogne-billancourt',   'Semi-Marathon de Boulogne-Billancourt Christian Granger', 'Boulogne-Billancourt', 'FR', 48.8350, 2.2400, '[21.1]', 'https://semi-marathonbb.fr/',               true),
  ('run-in-marseille',            'Run In Marseille',                              'Marseille',          'FR',  43.2966,   5.3610, '[42.2]', 'https://www.runinmarseille.com/',                       true),
  ('zurich-maraton-san-sebastian','Zurich Maratón Donostia San Sebastián',         'San Sebastián',      'ES',  43.3195,  -1.9830, '[42.2]', 'https://zurichmaratonsansebastian.com/en/',             true),
  ('media-maraton-getafe',        'Medio Maratón Internacional Ciudad de Getafe',  'Getafe',             'ES',  40.3135,  -3.7230, '[21.1]', 'https://mediadegetafe.com/',                           true),
  ('vig-bay',                     'Medio Maratón Gran Bahía Vig-Bay',              'Vigo',               'ES',  42.2100,  -8.7750, '[21.1]', 'https://vig-bay.com/',                                  true),
  ('big-half',                    'The Big Half',                                  'London',             'GB',  51.5055,  -0.0754, '[21.1]', 'https://www.londonmarathonevents.co.uk/big-half',       true),
  ('london-landmarks-half',       'London Landmarks Half Marathon',                'London',             'GB',  51.5065,  -0.1265, '[21.1]', 'https://www.llhm.co.uk/',                               true),
  ('cambridge-half',              'Cambridge Half Marathon',                       'Cambridge',          'GB',  52.2100,   0.1270, '[21.1]', 'https://cambridgehalfmarathon.com/',                    true),
  ('oxford-half',                 'Oxford Half Marathon',                          'Oxford',             'GB',  51.7610,  -1.2560, '[21.1]', 'https://www.oxfordhalf.co.uk/',                         true),
  ('brighton-half',               'Altra Brighton Half Marathon',                  'Hove',               'GB',  50.8240,  -0.1590, '[21.1]', 'https://brightonhalfmarathon.com/',                     true),
  ('stirling-half',               'Stirling Half Marathon',                        'Stirling',           'GB',  56.1121,  -3.9464, '[21.1]', 'https://www.upandrunningevents.co.uk/stirling-half-marathon', true),
  ('marathon-eryri',              'Marathon Eryri',                                'Llanberis',          'GB',  53.1130,  -4.1200, '[42.2]', 'https://www.snowdoniamarathon.co.uk/',                  true),
  ('diagonale-des-fous',          'Diagonale des Fous (Grand Raid Réunion)',       'Saint-Pierre',       'RE', -21.3450,  55.4600, '[180]',  'https://www.grandraid-reunion.com/',                    true),
  ('lavaredo-ultra-trail',        'La Sportiva Lavaredo Ultra Trail by UTMB',      'Cortina d''Ampezzo', 'IT',  46.5370,  12.1370, '[120]',  'https://lavaredo.utmb.world/',                          true),
  ('val-daran-by-utmb',           'HOKA Val d''Aran by UTMB',                      'Vielha',             'ES',  42.7020,   0.7950, '[163]',  'https://valdaran.utmb.world/',                          true),
  ('transvulcania',               'Transvulcania',                                 'Fuencaliente',       'ES',  28.4570, -17.8430, '[73]',   'https://transvulcania.com/en/',                         true),
  ('western-states',              'Western States Endurance Run',                  'Olympic Valley',     'US',  39.1970,-120.2350, '[161]',  'https://www.wser.org/',                                 true)
on conflict (slug) do nothing;

-- ── Referenced editions: corrected in place, id kept ─────────────────────────
update public.race_editions set date = '2027-02-14' where id = 'barcelona-half-marathon-2027-02-21';
update public.race_editions set date = '2027-04-04' where id = 'marathon-de-paris-2027-04-11';
-- The April half in Vigo is Vig-Bay, not the November LA21 race.
update public.race_editions set race_slug = 'vig-bay', date = '2026-04-12', elevation = 0
  where id = 'media-maraton-vigo-2026-04-18' and exists (select 1 from public.races where slug = 'vig-bay');
update public.race_editions set race_slug = 'vig-bay', date = '2027-04-11', elevation = 0
  where id = 'media-maraton-vigo-2027-04-18' and exists (select 1 from public.races where slug = 'vig-bay');
update public.race_editions set elevation = 40 where id = 'hackney-half-2027-05-16';
update public.race_editions set elevation = 100 where id = 'marathon-nice-cannes-2026-11-08';

-- ── Wrong or unannounced editions ────────────────────────────────────────────
-- Wrong dates are re-inserted below under their correct id; the rest were never
-- announced (or, for Mont-Saint-Michel, the race didn't run).
delete from public.race_editions where id in (
  'bath-half-2026-03-14',
  'belfast-city-marathon-2026-05-09', 'belfast-city-marathon-2027-05-09',
  'brighton-marathon-2027-04-11',
  'east-yorkshire-half-2026-06-27', 'east-yorkshire-half-2027-06-27',
  'great-birmingham-run-2026-05-09', 'great-birmingham-run-2027-05-09',
  'great-bristol-run-2026-05-16', 'great-bristol-run-2027-05-16',
  'great-manchester-run-2026-06-06', 'great-manchester-run-2027-06-06',
  'great-welsh-marathon-2026-03-13', 'great-welsh-marathon-2027-03-13',
  'liverpool-half-2026-03-21', 'liverpool-half-2027-03-21',
  'adidas-10k-paris-2027-06-06',
  'ecotrail-paris-2026-03-27', 'ecotrail-paris-2027-03-27',
  'marathon-baie-mont-saint-michel-2026-05-23', 'marathon-baie-mont-saint-michel-2027-05-23',
  'marathon-golfe-saint-tropez-2026-04-04', 'marathon-golfe-saint-tropez-2027-04-04',
  'marathon-lac-annecy-2026-04-25', 'marathon-lac-annecy-2027-04-25',
  'marathon-lyon-2026-11-29',
  'montpellier-run-festival-2027-04-18',
  'semi-de-paris-2026-03-07',
  'semi-marathon-nice-2026-04-25', 'semi-marathon-nice-2027-04-25',
  'semi-strasbourg-2026-05-16', 'semi-strasbourg-2027-05-16',
  'barcelona-half-marathon-2026-02-21',
  'barcelona-marathon-2026-03-14',
  'c21-coruna-2026-03-07', 'c21-coruna-2027-03-07',
  'carrera-del-agua-2026-03-21', 'carrera-del-agua-2027-03-21',
  'carrera-mujer-madrid-2026-05-16', 'carrera-mujer-madrid-2027-05-16',
  'cursa-bombers-bcn-2026-11-07',
  'cursa-el-corte-ingles-bcn-2027-05-16',
  'madrid-marathon-2026-04-25',
  'maraton-martin-fiz-2027-05-16',
  'media-maraton-alicante-2026-02-28', 'media-maraton-alicante-2027-02-28',
  'media-maraton-castellon-2026-01-31', 'media-maraton-castellon-2027-01-31',
  'media-maraton-elche-2026-04-11',
  'media-maraton-murcia-2026-03-27', 'media-maraton-murcia-2027-03-27',
  'media-maraton-salamanca-2026-03-07', 'media-maraton-salamanca-2027-03-07',
  'media-maraton-santander-2026-05-16', 'media-maraton-santander-2027-05-16',
  'movistar-madrid-half-marathon-2026-04-04', 'movistar-madrid-half-marathon-2027-04-04',
  'sevilla-marathon-2026-02-21',
  'transgrancanaria-2026-03-13', 'transgrancanaria-2027-03-13',
  'zegama-aizkorri-2026-05-23', 'zegama-aizkorri-2027-05-23'
);

-- ── Corrected and newly announced editions ───────────────────────────────────
insert into public.race_editions (id, race_slug, date, distance_km, elevation, verified)
select v.race_slug || '-' || v.date, v.race_slug, v.date::date, v.km, v.elev, true
from (values
  -- corrected dates
  ('bath-half',                     '2026-03-15', 21.1,  130),
  ('belfast-city-marathon',         '2026-05-03', 42.2,   80),
  ('belfast-city-marathon',         '2027-05-02', 42.2,   80),
  ('brighton-marathon',             '2027-04-04', 42.2,   90),
  ('east-yorkshire-half',           '2026-06-21', 21.1,   30),
  ('east-yorkshire-half',           '2027-06-20', 21.1,   30),
  ('great-birmingham-run',          '2026-05-03', 21.1,   50),
  ('great-birmingham-run',          '2027-05-02', 21.1,   50),
  ('great-bristol-run',             '2026-05-10', 21.1,   60),
  ('great-bristol-run',             '2027-05-09', 21.1,   60),
  ('great-manchester-run',          '2026-05-31', 10,     30),
  ('great-manchester-run',          '2027-05-23', 10,     30),
  ('great-welsh-marathon',          '2026-03-08', 42.2,  110),
  ('liverpool-half',                '2026-03-15', 21.1,   40),
  ('liverpool-half',                '2027-03-14', 21.1,   40),
  ('adidas-10k-paris',              '2027-05-23', 10,     50),
  ('ecotrail-paris',                '2026-03-21', 80,   1250),
  ('ecotrail-paris',                '2027-03-20', 80,   1250),
  ('marathon-golfe-saint-tropez',   '2026-03-29', 42.2,  100),
  ('marathon-golfe-saint-tropez',   '2027-03-14', 42.2,  100),
  ('marathon-lac-annecy',           '2026-04-19', 42.2,   80),
  ('marathon-lyon',                 '2026-10-04', 42.2,   60),
  ('semi-de-paris',                 '2026-03-08', 21.1,   60),
  ('semi-marathon-nice',            '2026-04-19', 21.1,   40),
  ('semi-marathon-nice',            '2027-04-18', 21.1,   40),
  ('semi-strasbourg',               '2026-05-10', 21.1,   30),
  ('barcelona-half-marathon',       '2026-02-15', 21.1,   70),
  ('barcelona-marathon',            '2026-03-15', 42.2,  120),
  ('c21-coruna',                    '2026-03-01', 21.1,   40),
  ('carrera-del-agua',              '2026-03-15', 10,     35),
  ('carrera-mujer-madrid',          '2026-05-10', 6.5,    30),
  ('cursa-bombers-bcn',             '2026-11-08', 10,     30),
  ('madrid-marathon',               '2026-04-26', 42.2,  140),
  ('media-maraton-alicante',        '2026-02-22', 21.1,   40),
  ('media-maraton-castellon',       '2026-01-25', 21.1,   20),
  ('media-maraton-elche',           '2026-03-22', 21.1,   40),
  ('media-maraton-murcia',          '2026-02-01', 21.1,   30),
  ('media-maraton-murcia',          '2027-02-07', 21.1,   30),
  ('media-maraton-salamanca',       '2026-03-01', 21.1,   60),
  ('media-maraton-santander',       '2026-05-10', 21.1,   50),
  ('movistar-madrid-half-marathon', '2026-03-22', 21.1,   60),
  ('sevilla-marathon',              '2026-02-15', 42.2,   20),
  ('transgrancanaria',              '2026-03-07', 81,   3800),
  ('zegama-aizkorri',               '2026-05-17', 42.2, 2736),
  -- next editions of existing races
  ('berlin-marathon',               '2027-09-26', 42.2,   60),
  ('chicago-marathon',              '2027-10-10', 42.2,   30),
  ('nyc-marathon',                  '2027-11-07', 42.2,  250),
  ('cardiff-10k',                   '2027-09-05', 10,     20),
  ('cardiff-half',                  '2027-10-03', 21.1,   50),
  ('chester-marathon',              '2027-10-10', 42.2,   50),
  ('great-north-run',               '2027-09-12', 21.1,  130),
  ('loch-ness-marathon',            '2027-09-26', 42.2,  200),
  ('royal-parks-half',              '2027-10-10', 21.1,   50),
  ('auray-vannes',                  '2027-09-12', 21.1,   90),
  ('marathon-du-medoc',             '2027-09-04', 42.2,   80),
  ('paris-versailles',              '2027-09-26', 16.2,  150),
  ('media-maraton-vigo',            '2026-11-15', 21.1,    0),
  -- new races
  ('sydney-marathon',               '2027-08-29', 42.2,  313),
  ('amsterdam-marathon',            '2026-10-18', 42.2,   30),
  ('rotterdam-marathon',            '2027-04-11', 42.2,   40),
  ('frankfurt-marathon',            '2026-10-25', 42.2,   60),
  ('berlin-half-marathon',          '2027-04-04', 21.1,   30),
  ('lisbon-marathon',               '2026-10-10', 42.2,  100),
  ('lisbon-half-marathon',          '2027-03-07', 21.1,   60),
  ('rome-marathon',                 '2027-03-14', 42.2,  150),
  ('milano-marathon',               '2027-04-04', 42.2,   40),
  ('florence-marathon',             '2026-11-29', 42.2,   60),
  ('athens-marathon',               '2026-11-08', 42.2,  290),
  ('vienna-city-marathon',          '2027-04-18', 42.2,   60),
  ('prague-marathon',               '2027-05-02', 42.2,   60),
  ('copenhagen-marathon',           '2027-05-09', 42.2,   30),
  ('stockholm-marathon',            '2027-05-29', 42.2,  150),
  ('dublin-marathon',               '2026-10-25', 42.2,   90),
  ('marathon-de-lille',             '2026-10-25', 42.2,   50),
  ('marathon-la-rochelle',          '2026-11-29', 42.2,   40),
  ('semi-boulogne-billancourt',     '2026-11-15', 21.1,   40),
  ('zurich-maraton-san-sebastian',  '2026-11-22', 42.2,   50),
  ('media-maraton-getafe',          '2027-01-31', 21.1,   60),
  ('big-half',                      '2027-09-05', 21.1,   60),
  ('london-landmarks-half',         '2027-04-04', 21.1,   40),
  ('cambridge-half',                '2027-03-14', 21.1,   20),
  ('oxford-half',                   '2026-10-11', 21.1,   30),
  ('brighton-half',                 '2027-02-28', 21.1,   30),
  ('stirling-half',                 '2027-05-16', 21.1,    0),
  ('marathon-eryri',                '2026-10-24', 42.2,  830),
  ('diagonale-des-fous',            '2026-10-15', 180, 10200),
  ('lavaredo-ultra-trail',          '2027-06-25', 120,  5800),
  ('transvulcania',                 '2027-05-08', 73,   4350),
  ('western-states',                '2027-06-26', 161,  5500)
) as v(race_slug, date, km, elev)
join public.races r on r.slug = v.race_slug
on conflict do nothing;
