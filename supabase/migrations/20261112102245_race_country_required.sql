-- Every race names its country as an ISO 3166-1 alpha-2 code (the add-race form requires it).
-- not valid: enforced on every insert/update, without re-checking rows already in the catalogue.
alter table public.races add constraint races_country_code
  check (country is not null and country ~ '^[A-Z]{2}$') not valid;
