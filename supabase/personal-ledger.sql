begin;
create schema if not exists ledger;
revoke all on schema ledger from public, anon, authenticated;
create table ledger.settings (
  singleton boolean primary key default true check(singleton), workbook text not null,
  title text not null, report_book text, warnings jsonb not null default '[]',
  archive_key_hash text, last_archive timestamptz, initialized boolean not null default false
);
create table ledger.members (email text primary key check(email=lower(email)), owner boolean not null default false);
create table ledger.books (name text primary key);
create table ledger.accounts (book text not null references ledger.books, code text not null,
  name text not null, type text not null check(type in ('Asset','Expense','Liability','Equity','Income')),
  parent text not null default '', use text not null check(use in ('Posting','Group')), role text not null default '',
  primary key(book,code,use));
create table ledger.entries (key uuid primary key default gen_random_uuid(), book text not null references ledger.books,
  id text not null, day date not null, memo text not null, lines jsonb not null, poster text not null,
  revision uuid not null default gen_random_uuid(), archived uuid, draft boolean not null default false,
  summary boolean not null default false, entry_count integer not null default 1, opening_amount numeric not null default 0,
  unique(book,id));
create index entries_range on ledger.entries(book,day);
create table ledger.archive_queue (seq bigint generated always as identity primary key, key uuid not null,
  revision uuid not null unique, content jsonb not null);
create table ledger.requests (request uuid primary key, entry_id text not null, actor text not null);
create table ledger.daily_numbers (day date primary key, last_number bigint not null);
create table ledger.cleanups (request uuid primary key, result jsonb not null);
create function ledger.actor(require_owner boolean default false) returns text language plpgsql stable security definer set search_path='' as $$
declare identity text;
begin
 select m.email into identity from auth.users u join ledger.members m on m.email=lower(u.email)
 where u.id=auth.uid() and u.email_confirmed_at is not null and (not require_owner or m.owner);
 if identity is null then raise exception 'This account does not have access to this ledger.' using errcode='42501'; end if;
 return identity;
end $$;
create function ledger.archive_change() returns trigger language plpgsql set search_path='' as $$
begin
 if not new.summary and (tg_op='INSERT' or old.revision is distinct from new.revision) then
   insert into ledger.archive_queue(key,revision,content) values(new.key,new.revision,to_jsonb(new)-'archived');
 end if;
 return new;
end $$;
create trigger record_revision after insert or update of revision on ledger.entries for each row execute function ledger.archive_change();
create function ledger.state() returns jsonb language plpgsql stable set search_path='' as $$
declare viewer text:=ledger.actor(); cfg ledger.settings%rowtype;
begin
 select * into cfg from ledger.settings;
 if not coalesce(cfg.initialized,false) then raise exception 'Your workbook is being migrated. Please try again later.'; end if;
 return jsonb_build_object('connected',true,'ledgerId',cfg.workbook,'title',cfg.title,'reportBook',cfg.report_book,
 'email',viewer,'owner',(select m.owner from ledger.members m where m.email=viewer),'today',(now() at time zone 'Asia/Vientiane')::date,
 'books',coalesce((select jsonb_agg(name order by name) from ledger.books),'[]'),
 'accounts',coalesce((select jsonb_agg(to_jsonb(a) order by book,code) from ledger.accounts a),'[]'),
 'warnings',cfg.warnings,'entries',coalesce((select jsonb_agg(l.value||jsonb_build_object('id',e.id,'groupKey',e.key,'book',e.book,'date',e.day,
 'memo',e.memo,'by',e.poster,'revision',e.revision,'sheetDraft',e.draft,'summary',e.summary,'entryCount',e.entry_count,'openingAmount',e.opening_amount)
 order by e.day,e.id,l.n) from ledger.entries e cross join lateral jsonb_array_elements(e.lines) with ordinality l(value,n)),'[]'));
end $$;
create function ledger.next_id(d date) returns text language plpgsql set search_path='' as $$
declare n bigint; grp bigint; letters text:='';
begin
 insert into ledger.daily_numbers(day,last_number) values(d,1) on conflict(day) do update
 set last_number=ledger.daily_numbers.last_number+1 returning last_number into n;
 grp:=(n-1)/999+1;
 while grp>0 loop grp:=grp-1; letters:=chr(65+(grp%26)::integer)||letters; grp:=grp/26; end loop;
 return to_char(d,'YYMM-DD')||letters||lpad((((n-1)%999)+1)::text,3,'0');
end $$;
create function ledger.post(p jsonb) returns text language plpgsql set search_path='' as $$
declare writer text:=ledger.actor(); b text:=p->>'book'; d date:=(p->>'date')::date;
 rid uuid:=(p->>'key')::uuid; prior text; oldrow ledger.entries%rowtype; acct ledger.accounts%rowtype;
 l jsonb; normalized jsonb:='[]'; dr numeric; cr numeric; debits numeric:=0; credits numeric:=0; codes text[]:='{}'; displayid text;
begin
 perform pg_advisory_xact_lock(382881,23);
 if not exists(select 1 from ledger.settings where initialized and workbook=p->>'ledgerId') then raise exception 'Incorrect ledger.'; end if;
 select entry_id into prior from ledger.requests r where r.request=rid and r.actor=writer;
 if found then return prior; end if;
 if d is null or not exists(select 1 from ledger.books where name=b) or length(trim(coalesce(p->>'memo',''))) not between 1 and 180
 or coalesce(jsonb_array_length(p->'lines'),0) not between 2 and 40 then raise exception 'Enter the book, date, description and journal lines.'; end if;
 if p->>'editId' is not null then
   select * into oldrow from ledger.entries where key=(p->>'groupKey')::uuid for update;
   if not found or oldrow.summary or oldrow.revision::text is distinct from p->>'revision' then raise exception 'Entry changed or summarized. Refresh first.'; end if;
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
create function ledger.cleanup(p jsonb,apply boolean) returns jsonb language plpgsql set search_path='' as $$
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
 into ids,fingerprint,pending from ledger.entries e where book=b and day between first_day and last_day and not summary
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
create function ledger.catalog() returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('title',s.title,'reportBook',s.report_book,'books',(select jsonb_agg(name order by name) from ledger.books),
 'accounts',(select jsonb_agg(to_jsonb(a) order by book,code) from ledger.accounts a)) from ledger.settings s
$$;
create function public.personal_ledger(action text,p jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg ledger.settings%rowtype; e text; value text; n bigint; result jsonb;
begin
 e:=ledger.actor(action in ('preview','compact','renameLedger','saveBookType','saveAccount'));
 select * into cfg from ledger.settings;
 if not coalesce(cfg.initialized,false) then raise exception 'The existing workbook has not finished importing.'; end if;
 case action
 when 'state' then return ledger.state();
 when 'postEntry' then return to_jsonb(ledger.post(p));
 when 'status' then
   n:=pg_database_size(current_database());
   return jsonb_build_object('bytes',n,'limitBytes',524288000,'lastArchive',cfg.last_archive,
   'pending',(select count(*) from ledger.archive_queue),'summaries',(select count(*) from ledger.entries where summary));
 when 'preview' then return ledger.cleanup(p,false);
 when 'compact' then return ledger.cleanup(p,true);
 when 'renameLedger' then value:=trim(p->>'name'); if coalesce(length(value),0) not between 1 and 60 then raise exception 'Enter an app name.'; end if;
   update ledger.settings set title=value;
 when 'saveBookType' then value:=trim(p->>'name'); if coalesce(length(value),0) not between 1 and 80 then raise exception 'Enter a book name.'; end if;
   insert into ledger.books values(value) on conflict do nothing;
 when 'saveAccount' then
   if coalesce(p->>'code','') !~ '^[1-9][0-9]{1,9}$' or length(trim(coalesce(p->>'name',''))) not between 1 and 80 then raise exception 'Enter an account code and name.'; end if;
   if coalesce(p->>'parent','')<>'' and not exists(select 1 from ledger.accounts where book=p->>'book' and code=p->>'parent' and use='Group' and type=p->>'type') then raise exception 'Choose a parent group of the same classification.'; end if;
   insert into ledger.accounts values(p->>'book',p->>'code',trim(p->>'name'),p->>'type',coalesce(p->>'parent',''),p->>'use',coalesce(p->>'role',''));value:=p->>'code';
 else raise exception 'Unknown ledger operation.';
 end case;
 insert into ledger.archive_queue(key,revision,content) values(gen_random_uuid(),gen_random_uuid(),jsonb_build_object('catalog',ledger.catalog()));
 return to_jsonb(value);
end $$;

create function ledger.import_book(p jsonb) returns jsonb language plpgsql set search_path='' as $$
declare line jsonb; rec record; letters text; m text[]; grp integer; i int; serial_no bigint;
begin
 if (select initialized from ledger.settings) then raise exception 'The workbook was already imported.'; end if;
 if coalesce(jsonb_array_length(p->'books'),0)=0 or coalesce(jsonb_array_length(p->'accounts'),0)=0
 or not coalesce((p->>'owner')::boolean,false) or nullif(p->>'email','') is null or
 p->>'ledgerId' is distinct from (select workbook from ledger.settings) then raise exception 'Workbook or owner verification failed.'; end if;
 insert into ledger.members values(lower(p->>'email'),true);
 insert into ledger.books select jsonb_array_elements_text(p->'books');
 for line in select value from jsonb_array_elements(p->'accounts') loop
   insert into ledger.accounts select name,line->>'code',line->>'name',line->>'type',coalesce(line->>'parent',''),line->>'use',coalesce(line->>'role','')
   from ledger.books where line->>'book' is null or name=line->>'book';
 end loop;
 for rec in select l->>'groupKey' k,min(l->>'id') id,min(l->>'book') book,min(l->>'date')::date d,min(l->>'memo') memo,
   min(l->>'by') poster,bool_or((l->>'sheetDraft')::boolean) draft,jsonb_agg(l order by n) lines,
   sum((l->>'debit')::numeric) dr,sum((l->>'credit')::numeric) cr
   from jsonb_array_elements(p->'entries') with ordinality as x(l,n) group by 1
 loop
   if rec.dr<>rec.cr then raise exception 'Imported entry does not balance.'; end if;
   insert into ledger.entries(book,id,day,memo,lines,poster,draft) values(rec.book,rec.id,rec.d,rec.memo,rec.lines,coalesce(rec.poster,''),rec.draft);
   m:=regexp_match(rec.id,'^([0-9]{4}-[0-9]{2})([A-Z]+)([0-9]{3})$');
   if m is not null then
     grp:=0;letters:=m[2];for i in 1..length(letters) loop grp:=grp*26+ascii(substr(letters,i,1))-64;end loop;
     serial_no:=(grp-1)::bigint*999+m[3]::int;
     insert into ledger.daily_numbers values(to_date('20'||m[1],'YYYYMM-DD'),serial_no) on conflict(day) do update
     set last_number=greatest(ledger.daily_numbers.last_number,excluded.last_number);
   end if;
 end loop;
 update ledger.settings set initialized=true,title=p->>'title',report_book=p->>'reportBook',warnings=coalesce(p->'warnings','[]');
 insert into ledger.archive_queue(key,revision,content) values(gen_random_uuid(),gen_random_uuid(),jsonb_build_object('catalog',ledger.catalog()));
 return jsonb_build_object('entries',(select count(*) from ledger.entries),'accounts',(select count(*) from ledger.accounts));
end $$;

create function public.personal_ledger_archive(action text, proof text, p jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg ledger.settings%rowtype; batch jsonb;
begin
 select * into cfg from ledger.settings;
 if cfg.archive_key_hash is null or length(proof)<40 or proof is null or encode(sha256(convert_to(proof,'UTF8')),'hex')<>cfg.archive_key_hash then raise exception 'Archive connection unauthorized.' using errcode='42501'; end if;
 case action
 when 'import' then perform pg_advisory_xact_lock(382881,23);return ledger.import_book(p);
 when 'batch' then
 select coalesce(jsonb_agg(to_jsonb(q) order by seq),'[]') into batch from (select * from ledger.archive_queue order by seq limit 30) q;
 return batch;
 when 'confirm' then
 with saved as (delete from ledger.archive_queue q using jsonb_array_elements(p) a
   where q.seq=(a->>'seq')::bigint and q.revision=(a->>'revision')::uuid returning q.key,q.revision)
 update ledger.entries e set archived=e.revision from saved where e.key=saved.key and e.revision=saved.revision;
 return 'true';
 when 'complete' then
 update ledger.settings set last_archive=clock_timestamp() where not exists(select 1 from ledger.archive_queue);
 return to_jsonb(found);
 else raise exception 'Unknown archive action.'; end case;
end $$;
revoke all on all functions in schema ledger from public,anon,authenticated;
revoke all on function public.personal_ledger(text,jsonb),public.personal_ledger_archive(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.personal_ledger(text,jsonb) to authenticated;
grant execute on function public.personal_ledger_archive(text,text,jsonb) to anon;
commit;
