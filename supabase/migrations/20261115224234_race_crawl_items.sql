-- The race crawler's ledger (docs/race-crawler.md): one row per event a source
-- proposed, so no event is proposed twice and every catalogue row the crawler
-- added says where it came from. Written by the crawler workflow, read by the
-- review skill; no client ever sees it.
create table if not exists public.race_crawl_items (
  source      text not null,
  source_key  text not null,
  date        date not null,
  verdict     text not null check (verdict in ('newEdition', 'newRace', 'dateChange', 'review')),
  status      text not null check (status in ('inserted', 'review', 'verified', 'rejected')),
  race_slug   text,
  edition_id  text,
  url         text not null,
  candidate   jsonb not null,
  note        text,
  first_seen  date not null default current_date,
  last_seen   date not null default current_date,
  primary key (source, source_key, date)
);

create index if not exists race_crawl_items_status_idx on public.race_crawl_items (status);

-- Service-role only: RLS with no policies denies every client role.
alter table public.race_crawl_items enable row level security;
revoke all on public.race_crawl_items from anon, authenticated;
grant select, insert, update, delete on public.race_crawl_items to service_role;
