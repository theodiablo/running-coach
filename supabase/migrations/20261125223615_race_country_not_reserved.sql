-- Reserved and retired alpha-2 codes pass the two-letter check but name no country a race can be in
-- (TA is Tristan da Cunha, not Tanzania). Mirrors NOT_A_COUNTRY in src/utils/country.ts.
-- not valid: enforced on every insert/update, without re-checking rows already in the catalogue.
alter table public.races add constraint races_country_not_reserved
  check (country not in ('AC','AN','CP','CQ','DG','EA','EU','EZ','FX','IC','SU','TA','UN','YU','ZZ')) not valid;
