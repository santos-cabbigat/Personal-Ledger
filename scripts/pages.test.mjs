import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
test('generated sidebar includes the theme and has no external Pages dependencies', () => {
  const bound = read('apps-script/Index.html');
  assert.ok(bound.includes(read('docs/ledger.css')));
  assert.doesNotMatch(bound,/<script src=|<link rel="stylesheet"/);
  assert.match(bound,/google\.script\.run\.withSuccessHandler/);
});

test('monthly spending nets posted expense lines within each book and links split entries to the journal', () => {
  const app = read('docs/index.html').match(/<script>([\s\S]*?)<\/script>/)[1];
  const modal = {addEventListener() {}};
  const context = vm.createContext({
    window: {addEventListener() {}}, location: {search: ''}, URLSearchParams,
    document: {getElementById: () => modal, addEventListener() {}, querySelectorAll: () => []},
    ledgerDb: {call() {}, session: () => new Promise(() => {})}
  });
  vm.runInContext(app, context);
  const base = {id:'split',book:'Personal',code:'5100',name:'Food',type:'Expense',date:'2026-11-01',debit:0,credit:0};
  context.entries = [
    {debit:50.22}, {code:'5200',name:'Supplies',debit:100.30},
    {type:'Asset',credit:150.52}, {id:'refund',date:'2026-11-04',credit:20.10},
    {book:'Business',debit:15}, {sheetDraft:true,debit:12},
    {date:'2026-10-31',debit:150}, {date:'2026-12-01',debit:200},
    {type:'Asset',debit:1800}, {type:'Asset',credit:1800}
  ].map(line => ({...base,...line}));
  const report = (month,book) => context.spendingByAccount(context.entries,month,book);
  const all = report('2026-11','');
  assert.equal(all.totalCents,14542);
  assert.deepEqual(Array.from(all.accounts,a=>[a.book,a.code,a.cents]),[
    ['Personal','5200',10030],['Personal','5100',3012],['Business','5100',1500]
  ]);
  assert.deepEqual(Array.from(all.accounts[1].lines,item=>item.index),[3,0]);
  assert.equal(report('2026-11','Personal').totalCents,13042);
  assert.equal(report('2026-10','Personal').totalCents,15000);
  assert.equal(report('2026-10','Business').accounts.length,0);
});

test('session handoff accepts only the expected Pages window, nonce and ledger methods', () => {
  let listener;
  const top={postMessage() {}};
  const window={top,addEventListener:(_,fn)=>listener=fn,removeEventListener:()=>{}};
  const google={script:{run:{withSuccessHandler:fn=>({withFailureHandler:()=>({state:()=>fn('checked')})})}}};
  const session=vm.runInNewContext(read('apps-script/Session.gs')+'\nledgerSessionPage_',{window,google});
  const origin='https://santos-cabbigat.github.io',nonce='example';
  session(origin,nonce);
  const messages=[];
  const port={postMessage:value=>messages.push(value)};
  const hello={data:{type:'ledger-connect',nonce},origin,source:top,ports:[port]};
  for(const change of [{origin:'https://example.com'},{source:{}},{data:{type:'ledger-connect',nonce:'wrong'}}]){
    listener({...hello,...change});
    assert.equal(messages.length,0);
  }
  listener(hello);
  assert.equal(messages[0].ready,true);
  port.onmessage({data:{id:1,method:'notAllowed',args:[]}});
  assert.equal(messages.length,1);
  port.onmessage({data:{id:2,method:'state',args:[]}});
  assert.equal(messages[1].result,'checked');
});

test('other tabs can reuse a live grant only for its account, and sign-out clears the grant',async()=>{
  const worker={};
  let now=Date.now();
  vm.runInNewContext(read('docs/session-worker.js'),{Date:{now:()=>now},self:worker,fetch:async()=>({ok:true,json:async()=>({done:true,response:{result:'loaded'}})})});
  function openTab(){
    let last;
    const port={postMessage:reply=>{last=reply;}};
    worker.onconnect({ports:[port]});
    return async(action,values={})=>{await port.onmessage({data:{id:1,action,...values}});return last;};
  }
  const first=openTab(),second=openTab();
  await first('save',{account:'owner',token:'sample',expiresAt:now+3600000,deployment:'example',summary:{title:'Personal',income:55,expenses:8,entries:['private']}});
  const cached=(await second('check',{account:'owner'})).summary;
  assert.equal(cached.expenses,8);
  assert.equal(cached.entries,undefined);
  assert.equal((await second('check',{account:'other'})).summary,undefined);
  now+=300001;
  assert.equal((await second('check',{account:'owner'})).summary,null);
  assert.equal((await second('check',{account:'owner'})).result,true);
  assert.equal((await second('check',{account:'other'})).expired,true);
  assert.equal((await second('call',{account:'owner',method:'state',args:[]})).result,'loaded');
  await first('clear');
  assert.equal((await second('check',{account:'owner'})).expired,true);
});


test('Pages restores a persistent Supabase session and uses the personal database for posting', async () => {
  const calls = [];
  const session = {user:{id:'test-owner'}};
  const client = {
    auth: {getSession: async () => ({data:{session}})},
    rpc: async (name, payload) => {
      calls.push({name, payload});
      return {data:'entry-id'};
    }
  };
  const supabase = {createClient(url, key, options) {
    assert.equal(new URL(url).hostname, 'uyyihuvjbrbsombzzvqw.supabase.co');
    assert.match(key, /^sb_publishable_/);
    assert.equal(options.auth.persistSession, true);
    return client;
  }};
  const db = vm.runInNewContext(read('docs/personal-db.js')+'\nledgerDb', {supabase});
  assert.equal(await db.session(), session);
  const post = {key:'original-request', book:'Personal'};
  assert.equal(await db.call('postEntry', post), 'entry-id');
  assert.equal(calls[0].name, 'personal_ledger');
  assert.equal(calls[0].payload.p, post);
});

test('sign-in accepts email and password and reads no financial records before authentication', async () => {
  const nodes=new Map();
  const document={body:{classList:{add(){},remove(){}}},addEventListener(){},querySelectorAll:()=>[],
    getElementById(id){
      if(!nodes.has(id)) nodes.set(id,{addEventListener(){},open:false,value:''});
      return nodes.get(id);
    }
  };
  let reads=0;
  const page=vm.createContext({window:{addEventListener(){}},document,URLSearchParams,location:{search:''},
    ledgerDb:{session:async()=>null,call:async()=>{reads++;}}});
  const app=read('docs/index.html').match(/<script>([\s\S]*?)<\/script>/)[1];
  vm.runInContext(app,page);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,0);
  assert.equal(nodes.get('dashboard').hidden,true);
  assert.match(nodes.get('accessActions').innerHTML,/type="password"/);
  assert.match(nodes.get('accessActions').innerHTML,/Set up login/);
});
