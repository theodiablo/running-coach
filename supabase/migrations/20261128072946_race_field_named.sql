-- Race field PR 2: who's running (docs/race-field.md, "PR 2: the named list").
-- race_field() gains 'named' in its open branch: the runners who chose to show their
-- name, and their goal when they chose to show it. Only a runner who joined the field
-- sees it (a non-member gets 'named': [] and the same count). No ids, no join dates;
-- rows are ordered by goal, then name.

create or replace function public.race_field(p_edition_id text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := (select auth.uid());
  v_date   date;
  v_others integer;
  v_joined boolean;
begin
  if v_uid is null then
    raise exception 'race_field: no authenticated user' using errcode = '28000';
  end if;

  select e.date into v_date from public.race_editions e
    where e.id = p_edition_id and e.verified and length(p_edition_id) <= 200;
  select exists (
    select 1 from public.race_field_members m
    where m.user_id = v_uid and m.edition_id = p_edition_id
  ) into v_joined;
  select count(*) into v_others from public.race_field_members m
    where m.edition_id = p_edition_id and m.user_id <> v_uid;

  if v_date is null or v_date < current_date - 1 or v_others < 3 then
    return jsonb_build_object('open', false, 'joined', v_joined);
  end if;

  return jsonb_build_object(
    'open', true,
    'joined', v_joined,
    'count', v_others + (case when v_joined then 1 else 0 end),
    'named', case when not v_joined then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object('name', p.public_name, 'goalSec', m.goal_sec, 'me', m.user_id = v_uid)
                       order by m.goal_sec nulls last, p.public_name)
      from public.race_field_members m
      join public.profiles p on p.id = m.user_id
      where m.edition_id = p_edition_id
        and m.visibility = 'named'
        and p.public_name is not null
    ), '[]'::jsonb) end
  );
end;
$$;

revoke all on function public.race_field(text) from public, anon;
grant execute on function public.race_field(text) to authenticated;

comment on function public.race_field(text) is
  'An edition''s field of app runners: nothing until 3 others joined, one closed shape otherwise; then the count, and to a runner who joined, the names (and goals) others chose to show. The only cross-user read of runner data (docs/race-field.md). SECURITY DEFINER by necessity, client-callable by design; returns no ids or dates.';
