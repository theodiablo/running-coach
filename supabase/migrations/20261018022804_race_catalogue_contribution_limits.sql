-- Bound what one account can add to the world-readable race catalogue: a per-user
-- cap on unverified rows (verified rows free a slot) and field-size limits, so a
-- single signup can't flood every client's catalogue download.

drop policy if exists "races insert own unverified" on public.races;
create policy "races insert own unverified" on public.races for insert to authenticated
  with check (
    (select auth.uid()) = created_by and verified = false
    and (select count(*) from public.races r
         where r.created_by = (select auth.uid()) and not r.verified) < 25
  );

drop policy if exists "race_editions insert own unverified" on public.race_editions;
create policy "race_editions insert own unverified" on public.race_editions for insert to authenticated
  with check (
    (select auth.uid()) = created_by and verified = false
    and (select count(*) from public.race_editions e
         where e.created_by = (select auth.uid()) and not e.verified) < 50
  );

alter table public.races add constraint races_field_bounds check (
  length(slug) <= 240
  and length(name) <= 120
  and length(coalesce(city, '')) <= 80
  and length(coalesce(country, '')) <= 2
  and length(coalesce(url, '')) <= 300
  and jsonb_typeof(distances) = 'array'
  and jsonb_array_length(distances) <= 10
);

alter table public.race_editions add constraint race_editions_field_bounds check (
  length(id) <= 280
  and distance_km > 0 and distance_km <= 500
  and elevation between 0 and 20000
);

alter table public.race_reports add constraint race_reports_note_bounds check (
  length(coalesce(note, '')) <= 2000 and length(reason) <= 64
);
