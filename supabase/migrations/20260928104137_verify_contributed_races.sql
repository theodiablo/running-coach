-- Verify the user-contributed races whose details were confirmed on organiser
-- sites (2026-09-28), tidying names/locations first. Santa Susanna's edition
-- stays unverified: its 1000 m climb is not published anywhere official.
update public.races set name = 'Lasarte-Oria 14,5 Trail Memorial Juanlu', city = 'Lasarte-Oria', verified = true
  where slug = 'lasarte-14-5-trail-janlu-memorial';
update public.race_editions set verified = true where id = 'lasarte-14-5-trail-janlu-memorial-2026-09-26';

update public.races set name = 'Foulée des Monts d''Ain', city = 'Port', lat = 46.1700, lng = 5.5620,
  url = 'https://fouleedesmontsdain.fr/', verified = true
  where slug = 'foulee-des-mont-d-ain';
update public.race_editions set verified = true where id = 'foulee-des-mont-d-ain-2026-10-31';

update public.races set name = 'Spartan Race Estérel Saint-Raphaël', city = 'Saint-Raphaël', lat = 43.4180, lng = 6.8470, verified = true
  where slug = 'spartan-race';
update public.race_editions set verified = true where id = 'spartan-race-2026-10-03';

update public.races set name = 'Spartan Race Santa Susanna-Barcelona', lat = 41.6360, lng = 2.7120, verified = true
  where slug = 'spartan-race-santa-susanna';

update public.races set name = 'HOKA Hackney Half', verified = true where slug = 'hackney-half';
update public.race_editions set verified = true where id = 'hackney-half-2027-05-16';
