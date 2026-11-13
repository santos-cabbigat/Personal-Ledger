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
    window: {}, location: {search: ''}, URLSearchParams,
    document: {getElementById: () => modal, addEventListener() {}},
    ledgerGoogle: {authorized: () => false, prepare: () => new Promise(() => {})}
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
