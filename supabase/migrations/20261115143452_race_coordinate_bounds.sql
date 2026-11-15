-- A race's pin is a real point on Earth: lat in [-90, 90], lng in [-180, 180] (LocationPicker wraps it).
-- not valid: enforced on every insert/update, without re-checking rows already in the catalogue.
alter table public.races add constraint races_coordinate_bounds
  check ((lat is null or lat between -90 and 90) and (lng is null or lng between -180 and 180)) not valid;
