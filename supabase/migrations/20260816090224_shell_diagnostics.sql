-- Running Coach — shell diagnostics drop-box.
--
-- A place for a phone to leave the evidence of a recording session that went
-- wrong, so diagnosing it does not depend on the owner reproducing it while
-- someone watches, or on reading a hidden panel out loud.
--
-- The bug this exists for: a backgrounded recorder comes back frozen. Three
-- fixes have been aimed at it (a foreground service, a renderer priority
-- policy, and the deferred rebuild that ships with this) without anyone
-- knowing which of three very different things actually happened — the WebView
-- renderer was reclaimed, the whole app process was killed, or JS was merely
-- frozen. The JS-side log stops identically in all three, because JS is what
-- died. The Android shell records those events natively instead
-- (ShellDiagLog.kt), and this table is where a report of them lands.
--
-- **Append-only, opt-in, and deliberately dull.** Rows are written only while
-- the hidden developer log is enabled on that device (the 5-tap gesture in
-- Settings → Connections), never by a normal install: this is a debugging
-- channel, not telemetry, and the consent story for telemetry is a separate
-- opt-in seam (docs/telemetry.md).
--
-- **No location, ever.** The payload is app lifecycle kinds, timestamps,
-- free-memory numbers, a device model string, and the GPS log's *metadata*
-- (fix arrival times, accuracy radii, drop reasons) — the coordinates are not
-- in that log and must never be added to it.

create table if not exists public.shell_diagnostics (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  -- "android" | "ios" | "web", and the installed build, so a report can be
  -- tied to the code that produced it.
  platform    text,
  app_version text,
  device      text,
  -- One-line reading of what the timeline says died (verdictFor in
  -- src/diag/shellLog.ts). Denormalised out of `events` on purpose: it is what
  -- makes a list of reports scannable without opening each one.
  verdict     text,
  -- The native shell log: [{at, kind, detail}, ...].
  events      jsonb not null default '[]'::jsonb,
  -- The JS GPS log, when the device has one: [{at, kind, t, acc, sinceMs, ...}].
  track       jsonb not null default '[]'::jsonb,
  -- Free-text from the person filing it ("froze at ~1 min, screen off").
  note        text
);

comment on table public.shell_diagnostics is
  'Opt-in debug reports from the native shell: what died while a recording session was backgrounded. Written only with the hidden developer log enabled; contains no location data.';

create index if not exists shell_diagnostics_user_created_idx
  on public.shell_diagnostics (user_id, created_at desc);

alter table public.shell_diagnostics enable row level security;

-- RLS filters rows; it does not grant the table itself. No update: a report is
-- a snapshot of a moment, and editing one after the fact only makes it a worse
-- record of it.
grant select, insert, delete on public.shell_diagnostics to authenticated;
grant all on public.shell_diagnostics to service_role;

drop policy if exists "shell_diagnostics insert own" on public.shell_diagnostics;
create policy "shell_diagnostics insert own"
  on public.shell_diagnostics for insert to authenticated
  with check (auth.uid() = user_id);

-- Readable by the account that filed it, so the reporter can always see exactly
-- what they sent. Cross-account reads are service_role only, which is how the
-- reports are actually triaged.
drop policy if exists "shell_diagnostics read own" on public.shell_diagnostics;
create policy "shell_diagnostics read own"
  on public.shell_diagnostics for select to authenticated using (auth.uid() = user_id);

drop policy if exists "shell_diagnostics delete own" on public.shell_diagnostics;
create policy "shell_diagnostics delete own"
  on public.shell_diagnostics for delete to authenticated using (auth.uid() = user_id);
