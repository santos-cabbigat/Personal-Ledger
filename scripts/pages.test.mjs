import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
const clientSource = read('docs/google-client.js');
const manifest = JSON.parse(read('apps-script/appsscript.json'));

function simulate(config, response) {
  const calls = [];
  const google = {accounts: {oauth2: {
    initTokenClient(options) {
      assert.deepEqual(options.scope.split(' ').sort(), [...manifest.oauthScopes].sort());
      return {requestAccessToken() {options.callback({access_token: 'sample', expires_in: 3600});}};
    },
    hasGrantedAllScopes() {return true;}
  }}};
  const fetch = async (url, options) => {
    if (url === './google-config.json') return {ok: true, json: async () => config};
    calls.push({url,options});
    return response;
  };
  const client = vm.runInNewContext(clientSource+'\nledgerGoogle', {fetch, window: {google}, google});
  return {client,calls};
}

test('unconfigured Pages never opens sample books as live data or calls the posting service', async () => {
  const {client,calls} = simulate({clientId: '',deploymentId: ''});
  await client.prepare();
  assert.equal(client.configured(),false);
  await assert.rejects(client.call('state'),/Sign in/);
  assert.equal(calls.length,0);
  const html = read('docs/index.html');
  assert.doesNotMatch(html,/location\.replace\(/);
  assert.match(html,/get\('preview'\)==='1'/);
});

test('live posts keep the request ID and use the existing Apps Script function', async () => {
  const {client,calls} = simulate({clientId:'public-id',deploymentId:'sample-deployment'},{
    ok:true,status:200,json:async()=>({done:true,response:{result:'entry-id'}})
  });
  await client.prepare();
  await client.signIn();
  assert.equal(await client.call('postEntry',{key:'request-id'}),'entry-id');
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,'https://script.googleapis.com/v1/scripts/sample-deployment:run');
  assert.deepEqual(JSON.parse(calls[0].options.body),{function:'postEntry',parameters:[{key:'request-id'}],devMode:false});
  assert.equal(calls[0].options.headers.Authorization,'Bearer sample');
});

test('expired access stops subsequent calls and never replays a write automatically', async () => {
  const {client,calls} = simulate({clientId:'public-id',deploymentId:'example'},{status:401});
  await client.prepare();
  await client.signIn();
  await assert.rejects(client.call('postEntry',{key:'original'}),/expired/);
  assert.equal(client.authorized(),false);
  await assert.rejects(client.call('postEntry',{key:'original'}),/Sign in/);
  assert.equal(calls.length,1);
});

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
    ledgerGoogle: {authorized: () => false, prepare: () => new Promise(() => {}), restore: () => new Promise(() => {})}
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

test('remembered email alone never authorizes Google access and is removed on sign-out', async () => {
  const saved=new Map();
  const localStorage={
    getItem:key=>saved.get(key), setItem:(key,value)=>saved.set(key,value), removeItem:key=>saved.delete(key)
  };
  const client=vm.runInNewContext(clientSource+'\nledgerGoogle',{window:{localStorage}});
  assert.equal(await client.restore(),null);
  client.remember('owner@example.com');
  assert.deepEqual([...saved.values()],['owner@example.com']);
  assert.equal(client.authorized(),false);
  client.forget();
  assert.equal(saved.size,0);
  assert.equal(await client.restore(),null);
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
  vm.runInNewContext(read('docs/session-worker.js'),{self:worker,fetch:async()=>({ok:true,json:async()=>({done:true,response:{result:'loaded'}})})});
  function openTab(){
    let last;
    const port={postMessage:reply=>{last=reply;}};
    worker.onconnect({ports:[port]});
    return async(action,values={})=>{await port.onmessage({data:{id:1,action,...values}});return last;};
  }
  const first=openTab(),second=openTab();
  await first('save',{account:'owner',token:'sample',expiresAt:Date.now()+3600000,deployment:'example'});
  assert.equal((await second('check',{account:'owner'})).result,true);
  assert.equal((await second('check',{account:'other'})).expired,true);
  assert.equal((await second('call',{account:'owner',method:'state',args:[]})).result,'loaded');
  await first('clear');
  assert.equal((await second('check',{account:'owner'})).expired,true);
});

test('the Google login button is usable while a saved-session check is still pending', async()=>{
  const app=read('docs/index.html').match(/<script>([\s\S]*?)<\/script>/)[1];
  const nodes=new Map();
  const document={
    addEventListener(){},querySelectorAll:()=>[],
    getElementById(id){
      if(!nodes.has(id))nodes.set(id,{addEventListener(){},open:false,value:''});
      return nodes.get(id);
    }
  };
  let finishRestore,finishLogin,signedIn=false,reads=0;
  const google={
    configured:()=>true,authorized:()=>signedIn,savedAccount:()=>'owner@example.com',
    prepare:async()=>{},restore:()=>new Promise(resolve=>{finishRestore=resolve;}),
    remember:async()=>{},signIn:()=>new Promise(resolve=>{finishLogin=()=>{signedIn=true;resolve();};}),
    call:async()=>{reads++;return {connected:true,books:[],entries:[],title:'Verified ledger',email:'owner@example.com'};}
  };
  const page=vm.createContext({window:{addEventListener(){}},document,URLSearchParams,location:{search:''},ledgerGoogle:google});
  vm.runInContext(app,page);
  await new Promise(resolve=>setImmediate(resolve));
  assert.match(nodes.get('accessActions').innerHTML,/Continue with Google/);
  const selected=vm.runInContext('signIn()',page);
  finishLogin();
  await selected;
  finishRestore(null);
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(reads,1);
  assert.equal(nodes.get('dashboard').hidden,false);
  assert.equal(nodes.get('title').textContent,'Verified ledger');
});
