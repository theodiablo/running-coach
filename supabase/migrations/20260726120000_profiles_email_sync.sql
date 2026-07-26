-- Keep public.profiles.email in sync with auth.users.email.
-- The init-schema trigger only fires on user CREATION, so an email change via
-- supabase.auth.updateUser({ email }) (Settings -> Account) would leave the
-- profiles row stale forever. Auth enforces email uniqueness, so the unique
-- constraint on profiles.email cannot conflict here.
create or replace function public.handle_user_email_updated()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.profiles set email = new.email where id = new.id;
  return new;
end;
$$;

drop trigger if exists on_auth_user_email_updated on auth.users;
create trigger on_auth_user_email_updated
  after update of email on auth.users
  for each row
  when (new.email is distinct from old.email)
  execute function public.handle_user_email_updated();
