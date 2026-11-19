-- Run after book-access.sql. Each saved password belongs to one issued login.
begin;
create or replace function public.ledger_assign_reviewer(p jsonb, assigned_password text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare login uuid := (p->>'loginId')::uuid;
begin
 perform ledger.actor(true);
 if login is null or assigned_password is null or length(assigned_password)<10 or octet_length(assigned_password)>72 then
   raise exception 'A valid assigned password is required.';
 end if;
 perform ledger.manage_access('saveAccess',p);
 perform vault.create_secret(assigned_password,'ledger-issued-'||login::text);
 return 'true'::jsonb;
end $$;

create or replace function public.ledger_assigned_password(address text, expected_version uuid)
returns text language plpgsql stable security definer set search_path='' as $$
declare member ledger.members%rowtype;
begin
 perform ledger.actor(true);
 select * into member from ledger.members where email=lower(trim(address)) and not owner;
 if not found or member.version is distinct from expected_version then raise exception 'Access changed. Reopen this person.'; end if;
 return (select decrypted_secret from vault.decrypted_secrets where name='ledger-issued-'||member.login_id::text);
end $$;

create or replace function ledger.remove_assigned_password()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if tg_op='DELETE' or old.login_id is distinct from new.login_id then
   delete from vault.secrets where name='ledger-issued-'||old.login_id::text;
 end if;
 return null;
end $$;
create or replace trigger remove_assigned_password after delete or update of login_id on ledger.members
for each row execute function ledger.remove_assigned_password();

revoke all on function ledger.remove_assigned_password() from public,anon,authenticated;
revoke all on function public.ledger_assign_reviewer(jsonb,text),public.ledger_assigned_password(text,uuid) from public,anon;
grant execute on function public.ledger_assign_reviewer(jsonb,text),public.ledger_assigned_password(text,uuid) to authenticated;
commit;
