-- Running Coach — beta feedback drop-box.
--
-- One button, reachable from anywhere, for "this is broken / confusing /
-- annoying". Distinct from coach_feedback (20260705105509), which flags one
-- specific coach ANSWER as wrong and is keyed to the round that produced it:
-- that is eval signal, this is product signal, and merging them would lose
-- both. Follows the coach_feedback shape exactly — INSERT-only from the
-- client, no client SELECT, maintainer reads it in the SQL editor and is
-- emailed by notify-contribution.
--
-- The body is TEXT the user typed or dictated. Voice notes are transcribed on
-- the device and only the transcript is sent: no audio is uploaded, stored or
-- referenced here, and no column should ever be added for one.

create table if not exists public.beta_feedback (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  -- What they said. Bounded so a runaway client can't post a novel.
  body        text not null check (length(body) between 1 and 4000),
  -- Where they were when they tapped the button ("dash" | "plan" | "races" |
  -- "progress" | "coach" | "settings"), plus the build and platform. Captured
  -- for them, and shown to them before sending — never a hidden payload.
  source      text,
  platform    text,
  app_version text,
  -- How the text got there: "text" | "voice". Tells us whether dictation is
  -- being used at all, without inspecting the words.
  input_mode  text
);

comment on table public.beta_feedback is
  'Beta feedback from the in-app button: free text (typed or device-transcribed), plus the screen/build it came from. No audio is ever stored.';

create index if not exists beta_feedback_created_idx
  on public.beta_feedback (created_at desc);

alter table public.beta_feedback enable row level security;

-- INSERT only: a grant without a policy still 403s, and vice-versa — both are
-- required. No select grant/policy, so the client can never read the table.
grant insert on public.beta_feedback to authenticated;
grant all    on public.beta_feedback to service_role;

drop policy if exists "beta_feedback insert own" on public.beta_feedback;
create policy "beta_feedback insert own"
  on public.beta_feedback for insert to authenticated
  with check (auth.uid() = user_id);
