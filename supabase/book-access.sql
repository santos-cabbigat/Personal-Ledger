begin;
alter table ledger.members add column if not exists login_id uuid, add column if not exists version uuid not null default gen_random_uuid();
alter table ledger.entries add column if not exists abandoned boolean not null default false;
do $upgrade$
begin
 if to_regclass('ledger.book_access') is null then
 create table ledger.book_access (
 email text not null references ledger.members(email) on delete cascade,
 book text not null references ledger.books(name), role text not null check(role in ('viewer','editor')),
 primary key(email,book)
);
insert into ledger.book_access(email,book,role)
select m.email,b.name,'editor' from ledger.members m cross join ledger.books b where not m.owner;
 end if;
end $upgrade$;
create unique index if not exists ledger_member_login on ledger.members(login_id) where login_id is not null;

create or replace function ledger.actor(require_owner boolean default false) returns text language plpgsql stable security definer set search_path='' as $$
declare identity text;
begin
 select m.email into identity from auth.users u join ledger.members m on (m.login_id=u.id or (m.login_id is null and m.email=lower(u.email)))
 where u.id=auth.uid() and u.email_confirmed_at is not null and (not require_owner or m.owner);
 if identity is null then raise exception 'This account does not have access to this ledger.' using errcode='42501'; end if;
 return identity;
end $$;
create or replace function ledger.book_allowed(b text, writing boolean default false) returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from ledger.members m where m.email=ledger.actor() and (m.owner or exists(
 select 1 from ledger.book_access a where a.email=m.email and a.book=b and (not writing or a.role='editor'))))
$$;
create or replace function ledger.state() returns jsonb language plpgsql stable set search_path='' as $$
declare viewer text:=ledger.actor(); cfg ledger.settings%rowtype;
begin
 select * into cfg from ledger.settings;
 if not coalesce(cfg.initialized,false) then raise exception 'Your workbook is being migrated. Please try again later.'; end if;
 return jsonb_build_object('connected',true,'ledgerId',case when (select owner from ledger.members where email=viewer) then cfg.workbook else 'shared' end,'title',cfg.title,'reportBook',case when ledger.book_allowed(cfg.report_book) then cfg.report_book end,
 'email',viewer,'owner',(select m.owner from ledger.members m where m.email=viewer),'today',(now() at time zone 'Asia/Vientiane')::date,
 'editableBooks',coalesce((select jsonb_agg(name order by name) from ledger.books where ledger.book_allowed(name,true)),'[]'),
 'books',coalesce((select jsonb_agg(name order by name) from ledger.books where ledger.book_allowed(name)),'[]'),
 'accounts',coalesce((select jsonb_agg(to_jsonb(a) order by book,code) from ledger.accounts a where ledger.book_allowed(a.book)),'[]'),
 'warnings',case when (select owner from ledger.members where email=viewer) then cfg.warnings else '[]'::jsonb end,'entries',coalesce((select jsonb_agg(l.value||jsonb_build_object('id',e.id,'groupKey',e.key,'book',e.book,'date',e.day,
 'memo',e.memo,'by',e.poster,'revision',e.revision,'sheetDraft',e.draft,'summary',e.summary,'entryCount',e.entry_count,'openingAmount',e.opening_amount)
 order by e.day,e.id,l.n) from ledger.entries e cross join lateral jsonb_array_elements(e.lines) with ordinality l(value,n) where not e.abandoned and ledger.book_allowed(e.book)),'[]'));
end $$;
create or replace function ledger.post(p jsonb) returns text language plpgsql set search_path='' as $$
declare writer text:=ledger.actor(); b text:=p->>'book'; d date:=(p->>'date')::date;
 rid uuid:=(p->>'key')::uuid; prior text; oldrow ledger.entries%rowtype; acct ledger.accounts%rowtype;
 l jsonb; normalized jsonb:='[]'; dr numeric; cr numeric; debits numeric:=0; credits numeric:=0; codes text[]:='{}'; displayid text;
begin
 perform pg_advisory_xact_lock(382881,23);
 if not exists(select 1 from ledger.settings where initialized and ((workbook=p->>'ledgerId') or (p->>'ledgerId'='shared' and not (select owner from ledger.members where email=writer)))) then raise exception 'Incorrect ledger.'; end if;
 if not ledger.book_allowed(b,true) then raise exception 'Editing is not allowed for this book.' using errcode='42501'; end if;
 select entry_id into prior from ledger.requests r where r.request=rid and r.actor=writer;
 if found then return prior; end if;
 if d is null or not exists(select 1 from ledger.books where name=b) or length(trim(coalesce(p->>'memo',''))) not between 1 and 180
 or coalesce(jsonb_array_length(p->'lines'),0) not between 2 and 40 then raise exception 'Enter the book, date, description and journal lines.'; end if;
 if p->>'editId' is not null then
   select * into oldrow from ledger.entries where key=(p->>'groupKey')::uuid for update;
   if not found or not ledger.book_allowed(oldrow.book,true) or oldrow.abandoned or oldrow.summary or oldrow.revision::text is distinct from p->>'revision' then raise exception 'Entry changed or summarized. Refresh first.'; end if;
 end if;
 for l in select value from jsonb_array_elements(p->'lines') loop
   select * into acct from ledger.accounts where book=b and code=l->>'code' and use='Posting';
   if not found then raise exception 'Choose a posting account for this book.'; end if;
   dr:=coalesce(nullif(l->>'debit',''),'0')::numeric; cr:=coalesce(nullif(l->>'credit',''),'0')::numeric;
   if not(dr between 0 and 99999999999.99 and cr between 0 and 99999999999.99) or (dr>0)=(cr>0)
   or dr<>round(dr,2) or cr<>round(cr,2) then raise exception 'Use one debit or credit per line, to two decimals.'; end if;
   debits:=debits+dr; credits:=credits+cr; codes:=array_append(codes,acct.code);
   normalized:=normalized||jsonb_build_array(jsonb_build_object('code',acct.code,'name',acct.name,'type',acct.type,'debit',dr,'credit',cr,
     'lineMemo',coalesce(nullif(l->>'lineMemo',''),p->>'memo'),'reference',upper(coalesce(nullif(l->>'reference',''),p->>'reference',''))));
 end loop;
 if debits<>credits or (select count(distinct c) from unnest(codes) c)<2 then raise exception 'Balance both sides across two accounts.'; end if;
 displayid:=oldrow.id;
 if displayid is null or (oldrow.draft and displayid like 'Sheet rows %') then displayid:=ledger.next_id(d); end if;
 if oldrow.key is null then
   insert into ledger.entries(book,id,day,memo,lines,poster) values(b,displayid,d,trim(p->>'memo'),normalized,writer);
 else
   update ledger.entries set book=b,id=displayid,day=d,memo=trim(p->>'memo'),lines=normalized,poster=case when draft then writer else poster end,
     draft=false,revision=gen_random_uuid(),archived=null where key=oldrow.key;
 end if;
 insert into ledger.requests values(rid,displayid,writer);
 return displayid;
end $$;
create or replace function ledger.cleanup(p jsonb,apply boolean) returns jsonb language plpgsql set search_path='' as $$
declare b text:=p->>'book'; a text:=nullif(p->>'account',''); first_day date:=(p->>'from')::date; last_day date:=(p->>'through')::date;
 ids uuid[]; fingerprint text; pending int; result jsonb; rec record; inserted int:=0; req uuid;
begin
 perform ledger.actor(true);
 perform pg_advisory_xact_lock(382881,23);
 if b is null or not exists(select 1 from ledger.books where name=b) or first_day is null or last_day is null or first_day>last_day then raise exception 'Select a book and a valid date range.'; end if;
 if apply then req:=(p->>'request')::uuid; select c.result into result from ledger.cleanups c where request=req; if found then return result; end if; end if;
 select array_agg(key order by key) filter(where not draft and archived=revision),
 md5(coalesce(string_agg(key::text||revision::text,',' order by key) filter(where not draft and archived=revision),'')),
 count(*) filter(where draft or archived is distinct from revision)
 into ids,fingerprint,pending from ledger.entries e where book=b and day between first_day and last_day and not summary and not abandoned
 and (a is null or exists(select 1 from jsonb_array_elements(e.lines) l where l->>'code'=a));
 result:=jsonb_build_object('count',coalesce(cardinality(ids),0),'pending',pending,'fingerprint',fingerprint);
 if not apply then return result; end if;
 if fingerprint is distinct from p->>'fingerprint' or ids is null or req is null then raise exception 'Selection changed. Preview the range again.'; end if;
 for rec in
   with daily as (select e.day,sum(e.entry_count)::int cnt from ledger.entries e where e.key=any(ids) group by e.day),
   amounts as (select e.day,l->>'code' code,l->>'name' name,l->>'type' type,
      sum((l->>'debit')::numeric) dr,sum((l->>'credit')::numeric) cr
      from ledger.entries e cross join lateral jsonb_array_elements(e.lines) l where e.key=any(ids) group by 1,2,3,4),
   openings as (select e.day,sum(greatest(0,t.banknet)) opening from ledger.entries e cross join lateral (
     select coalesce(sum((l->>'debit')::numeric-(l->>'credit')::numeric) filter(where ac.role='Bank'),0) banknet,
       count(*) filter(where ac.role='Bank') banks,count(*) filter(where ac.role<>'Bank') others,
       bool_and(ac.type='Equity' and ac.name~*'opening balance|beginning balance') filter(where ac.role<>'Bank') qualifies
     from jsonb_array_elements(e.lines) l join ledger.accounts ac on ac.book=e.book and ac.use='Posting' and ac.code=l->>'code'
   ) t where e.key=any(ids) and t.banks>0 and t.others>0 and t.qualifies group by e.day)
   select d.day,d.cnt,coalesce(o.opening,0) opening,sum(x.dr) dr,sum(x.cr) cr,
     jsonb_agg(jsonb_build_object('code',x.code,'name',x.name,'type',x.type,'debit',x.dr,'credit',x.cr) order by x.code) lines
   from daily d join amounts x on x.day=d.day left join openings o on o.day=d.day group by d.day,d.cnt,o.opening
 loop
   if rec.dr<>rec.cr then raise exception 'Original entries do not balance. No detail removed.'; end if;
   insert into ledger.entries(book,id,day,memo,lines,poster,summary,entry_count,opening_amount) values
   (b,'Summary-'||req::text||'-'||rec.day,rec.day,'Archived journal summary',rec.lines,ledger.actor(true),true,rec.cnt,rec.opening);
   inserted:=inserted+1;
 end loop;
 delete from ledger.entries where key=any(ids);
 result:=result||jsonb_build_object('summaries',inserted);
 insert into ledger.cleanups values(req,result);return result;
end $$;
create or replace function ledger.manage_access(action text,p jsonb) returns jsonb language plpgsql set search_path='' as $$
declare target text:=lower(trim(p->>'email')); member ledger.members%rowtype; grants jsonb:=p->'books'; uid uuid;
begin
 perform ledger.actor(true);
 if action='listAccess' then
   return coalesce((select jsonb_agg(jsonb_build_object('email',m.email,'version',m.version,'managed',m.login_id is not null,
    'books',coalesce((select jsonb_object_agg(a.book,a.role) from ledger.book_access a where a.email=m.email),'{}')) order by m.email)
    from ledger.members m where not m.owner),'[]');
 end if;
 if target is null or target like '%@reviewer.invalid' or length(target)>254 or target !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then raise exception 'Enter a valid email.'; end if;
 perform pg_advisory_xact_lock(382881,23);
 select * into member from ledger.members where email=target for update;
 if member.owner then raise exception 'Owner access is managed separately.'; end if;
 if member.version is distinct from (p->>'version')::uuid then raise exception 'Access changed. Open the form again.'; end if;
 if action='revokeAccess' then
   delete from ledger.members where email=target and not owner;
   delete from auth.users where id=member.login_id and raw_app_meta_data->>'ledger_reviewer'=target and email like '%@reviewer.invalid';
   return 'true';
 end if;
 if jsonb_typeof(grants) is distinct from 'object' or grants='{}'::jsonb then raise exception 'Choose at least one book.'; end if;
 if exists(select 1 from jsonb_each_text(grants) g where g.value is null or g.value not in ('viewer','editor')
    or not exists(select 1 from ledger.books where name=g.key)) then raise exception 'Choose valid book permissions.'; end if;
 uid:=coalesce((p->>'loginId')::uuid,member.login_id);
 if p ? 'loginId' and not exists(select 1 from auth.users u where u.id=uid
    and u.raw_app_meta_data->>'ledger_reviewer'=target and u.email like '%@reviewer.invalid' and u.email_confirmed_at is not null)
    then raise exception 'Reviewer login could not be verified.'; end if;
 if member.email is null and uid is null then raise exception 'Set a password for this person first.'; end if;
 insert into ledger.members(email,owner,login_id) values(target,false,uid)
 on conflict(email) do update set login_id=excluded.login_id,version=gen_random_uuid();
 if member.login_id is distinct from uid then
   delete from auth.users where id=member.login_id and raw_app_meta_data->>'ledger_reviewer'=target and email like '%@reviewer.invalid';
 end if;
 delete from ledger.book_access where email=target;
 insert into ledger.book_access select target,key,value from jsonb_each_text(grants);
 return 'true';
end $$;
create or replace function public.personal_ledger(action text,p jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg ledger.settings%rowtype; e text; value text; n bigint; result jsonb;
begin
 e:=ledger.actor(action in ('preview','compact','renameLedger','saveBookType','status'));
 select * into cfg from ledger.settings;
 if not coalesce(cfg.initialized,false) then raise exception 'The existing workbook has not finished importing.'; end if;
 case action
 when 'listAccess','saveAccess','revokeAccess' then return ledger.manage_access(action,p);
 when 'abandonDraft' then
   perform pg_advisory_xact_lock(382881,23);
   update ledger.entries set abandoned=true, revision=gen_random_uuid(),archived=null where key=(p->>'groupKey')::uuid and draft and not abandoned and revision=(p->>'revision')::uuid and ledger.book_allowed(book,true);
   if not found then raise exception 'Draft changed or is no longer available. Refresh the journal.'; end if;
   return 'true';
 when 'state' then return ledger.state();
 when 'postEntry' then return to_jsonb(ledger.post(p));
 when 'status' then
   n:=pg_database_size(current_database());
   return jsonb_build_object('bytes',n,'limitBytes',524288000,'lastArchive',cfg.last_archive,
   'pending',(select count(*) from ledger.archive_queue),'summaries',(select count(*) from ledger.entries where summary));
 when 'preview' then return ledger.cleanup(p,false);
 when 'compact' then return ledger.cleanup(p,true);
 when 'renameLedger' then value:=trim(p->>'name'); if coalesce(length(value),0) not between 1 and 60 then raise exception 'Enter an app name.'; end if;
   update ledger.settings set title=value where singleton;
 when 'saveBookType' then value:=trim(p->>'name'); if coalesce(length(value),0) not between 1 and 80 then raise exception 'Enter a book name.'; end if;
   insert into ledger.books values(value) on conflict do nothing;
 when 'saveAccount' then
   if not ledger.book_allowed(p->>'book',true) then raise exception 'Editing is not allowed for this book.' using errcode='42501'; end if;
   if coalesce(p->>'code','') !~ '^[1-9][0-9]{1,9}$' or length(trim(coalesce(p->>'name',''))) not between 1 and 80 then raise exception 'Enter an account code and name.'; end if;
   if coalesce(p->>'parent','')<>'' and not exists(select 1 from ledger.accounts where book=p->>'book' and code=p->>'parent' and use='Group' and type=p->>'type') then raise exception 'Choose a parent group of the same classification.'; end if;
   insert into ledger.accounts values(p->>'book',p->>'code',trim(p->>'name'),p->>'type',coalesce(p->>'parent',''),p->>'use',coalesce(p->>'role',''));value:=p->>'code';
 else raise exception 'Unknown ledger operation.';
 end case;
 insert into ledger.archive_queue(key,revision,content) values(gen_random_uuid(),gen_random_uuid(),jsonb_build_object('catalog',ledger.catalog()));
 return to_jsonb(value);
end $$;
-- The sign-in form receives an opaque Auth alias. Unknown addresses get the same shape of response.
create or replace function public.personal_reviewer_alias(address text) returns text
language sql stable security definer set search_path='' as $$
 select coalesce((select u.email from ledger.members m join auth.users u on m.login_id=u.id
 where m.email=lower(trim(address)) and not m.owner), (select md5(coalesce(archive_key_hash,'') || lower(trim(address)))::uuid::text || '@reviewer.invalid' from ledger.settings))
$$;
revoke all on function public.personal_reviewer_alias(text) from public;
grant execute on function public.personal_reviewer_alias(text) to anon,authenticated;
revoke all on all functions in schema ledger from public,anon,authenticated;
commit;
