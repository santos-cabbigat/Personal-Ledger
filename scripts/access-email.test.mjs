import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
const read = p => readFileSync(new URL('../'+p,import.meta.url),'utf8');
const app = read('docs/index.html').match(/<script>([\s\S]*?)<\/script>/)[1];
function page(){
  const nodes=new Map();
  const node=id=>{if(!nodes.has(id))nodes.set(id,{addEventListener(){},classList:{add(){},remove(){}},focus(){},showModal(){this.open=true;},open:false,innerHTML:'',value:'',textContent:'',setAttribute(k,v){this[k]=v;}});return nodes.get(id);};
  const backend={call:async()=>[]};
  const context=vm.createContext({window:{addEventListener(){}},document:{getElementById:node,addEventListener(){},querySelectorAll:()=>[],body:{classList:{add(){},remove(){}}}},location:{search:''},URLSearchParams,ledgerDb:{session:()=>new Promise(()=>{}),call:(...args)=>backend.call(...args)}});
  vm.runInContext(app,context);return {context,node,backend};
}
test('all sign-in and password-creation modes show an accessible eye that preserves the typed password',()=>{
 const {context,node}=page();
 for(const mode of ['login','reviewer','signup','reset']){
  context.loginScreen('',mode);
  assert.match(node('accessActions').innerHTML,/id="loginPassword" type="password"/);
  assert.match(node('accessActions').innerHTML,/type="button" class="passwordEye"/);
 }
 const input=node('loginPassword'),button=node('eye');input.type='password';input.value='Sample-only-123';
 context.togglePassword('loginPassword',button);assert.equal(input.type,'text');assert.equal(input.value,'Sample-only-123');assert.equal(button['aria-label'],'Hide password');
 context.togglePassword('loginPassword',button);assert.equal(input.type,'password');assert.equal(input.value,'Sample-only-123');assert.equal(button['aria-pressed'],'false');
 vm.runInContext("data={owner:true,books:['Personal']};people=[]",context);context.personForm(-1);
 assert.match(node('content').innerHTML,/aria-controls="personPass"/);
 assert.match(node('content').innerHTML,/data-email="1"/);
});
test('email preparation follows a successful save and uses the saved recipient and access version',async()=>{
 const {context,node,backend}=page();let saved=0,prepared;
 vm.runInContext("data={owner:true,books:['Personal'],email:'owner@example.com'};people=[]",context);
 node('personEmail').value='REVIEWER@example.com';node('personPass').value='Assigned-123';node('includeBook0').checked=true;node('grant0').value='viewer';
 context.ledgerDb.provisionReviewer=async p=>{saved++;assert.equal(p.email,'reviewer@example.com');};
 backend.call=async()=>[{email:'reviewer@example.com',books:{Personal:'viewer'},version:'v2'}];
 context.peopleSettings=async()=>{};context.accessEmailPreview=details=>{prepared=details;};
 await context.savePerson(-1,true);assert.equal(saved,1);assert.equal(prepared.version,'v2');assert.equal(prepared.password,'Assigned-123');assert.equal(prepared.email,'reviewer@example.com');
 prepared=undefined;await context.savePerson(-1,false);assert.equal(prepared,undefined);
 context.ledgerDb.provisionReviewer=async()=>{throw Error('Save failed');};
 await context.savePerson(-1,true);assert.equal(prepared,undefined);assert.equal(node('err').textContent,'Save failed');
});
function mailEnv({failure,validateError,hold=false}={}){
 const calls=[],deferred={};let consent=0;
 const oauth={hasGrantedAllScopes:()=>true,initTokenClient:options=>({requestAccessToken(){consent++;options.callback({access_token:'fake-token',expires_in:3600});}})};
 const env={window:{google:{accounts:{oauth2:oauth}}},google:{accounts:{oauth2:oauth}},TextEncoder,btoa:s=>Buffer.from(s,'binary').toString('base64'),Date,
  fetch:async(url,opts)=>{calls.push({url,opts});if(url.includes('google-config'))return {ok:true,json:async()=>({clientId:'public-test-client'})};
   if(hold)await new Promise(resolve=>{deferred.resolve=resolve;});
   if(failure)return {ok:false,status:403,json:async()=>({error:{details:[{reason:'SERVICE_DISABLED'}]}})};
   return {ok:true,status:200,json:async()=>({id:'message-1'})};}};
 const api=vm.runInNewContext(read('docs/access-email.js')+'\nLedgerAccessEmail',env);
 const details={email:'reviewer@example.com',password:'Assigned-✓123',books:{Personal:'viewer',Business:'editor'},sender:'owner@example.com'};
 return {api,details,calls,deferred,get consent(){return consent;},validate:async()=>{if(validateError)throw Error(validateError);}};
}
test('formal invitation contains the sign-in link, exact credentials and book permissions; header injection is rejected',()=>{
 const e=mailEnv(),m=e.api.compose(e.details);
 assert.equal(m.to,e.details.email);assert.ok(m.body.endsWith('Kind regards,\nSantos Cabbigat'));assert.ok(!m.body.includes(e.details.sender));assert.match(m.body,/Dear Ledger User,/);assert.ok(m.body.includes(e.details.password));assert.match(m.body,/https:\/\/santos-cabbigat.github.io\/Personal-Ledger\//);assert.match(m.body,/Business: Co-editor/);assert.match(m.body,/Personal: View only/);
 assert.throws(()=>e.api.compose({...e.details,email:'a@example.com\r\nBcc:other@example.com'}));
});
test('preparation sends nothing; one deliberate send authorizes Google and transmits the complete UTF-8 message',async()=>{
 const e=mailEnv();await e.api.prepare();assert.equal(e.consent,0);assert.equal(e.calls.length,1);
 assert.equal(await e.api.send(e.api.compose(e.details),e.details.sender,e.validate),'message-1');assert.equal(e.consent,1);
 const sent=e.calls.find(c=>c.url.includes('/messages/send'));assert.equal(sent.opts.credentials,'omit');
 const mime=Buffer.from(JSON.parse(sent.opts.body).raw,'base64url').toString('utf8');
 assert.match(mime,/To: reviewer@example.com/);assert.ok(mime.includes(Buffer.from('Santos Cabbigat').toString('base64')));assert.match(mime,/<owner@example.com>/);
 const body=Buffer.from(mime.split('\r\n\r\n')[1].replace(/\r\n/g,''),'base64').toString('utf8');assert.equal(body,e.api.compose(e.details).body);
});
test('revoked access prevents sending and disabled Gmail produces an honest error',async()=>{
 const changed=mailEnv({validateError:'Access changed'});await changed.api.prepare();await assert.rejects(changed.api.send(changed.api.compose(changed.details),changed.details.sender,changed.validate),/Access changed/);assert.equal(changed.calls.length,1);
 const disabled=mailEnv({failure:true});await disabled.api.prepare();await assert.rejects(disabled.api.send(disabled.api.compose(disabled.details),disabled.details.sender,disabled.validate),/needs Gmail API activation/);
});
test('a second click cannot duplicate an in-flight email',async()=>{
 const e=mailEnv({hold:true});await e.api.prepare();const sending=e.api.send(e.api.compose(e.details),e.details.sender,e.validate);
 await new Promise(r=>setImmediate(r));await assert.rejects(e.api.send(e.api.compose(e.details),e.details.sender,e.validate),/already being sent/);e.deferred.resolve();await sending;assert.equal(e.calls.filter(c=>c.url.includes('/messages/send')).length,1);
});
test('one sign-in method accepts issued reviewer logins and the main owner login without changing permissions',async()=>{
 for(const role of ['reviewer','owner']){
  const attempts=[];
  const client={rpc:async(name,p)=>{assert.equal(name,'personal_reviewer_alias');assert.equal(p.address,'person@example.com');return {data:'opaque@reviewer.invalid'};},
   auth:{signInWithPassword:async input=>{attempts.push(input);return (role==='reviewer'||input.email==='person@example.com')?{data:{session:{user:{id:role}}}}:{error:{message:'Invalid login credentials'}};}}};
  const api=vm.runInNewContext(read('docs/personal-db.js')+'\nledgerDb',{supabase:{createClient:()=>client}});
  const result=await api.signIn(' Person@Example.com ','ExactPassword');
  assert.equal(result.session.user.id,role);assert.equal(attempts.length,role==='owner'?2:1);assert.ok(attempts.every(p=>p.password==='ExactPassword'));
 }
 const attempts=[];
 const api=vm.runInNewContext(read('docs/personal-db.js')+'\nledgerDb',{supabase:{createClient:()=>({rpc:async()=>({data:'opaque@reviewer.invalid'}),auth:{signInWithPassword:async p=>{attempts.push(p);return {error:{message:'Network unavailable'}};}}})}});
 await assert.rejects(api.signIn('person@example.com','test'),/Network unavailable/);assert.equal(attempts.length,1);
});

test('the sender can edit the default subject and message, and both Copy and Send use those exact edits',async()=>{
 const {context,node,backend}=page(),mail=mailEnv();let copied,sent;
 context.LedgerAccessEmail={compose:mail.api.compose,prepare:async()=>{},send:async(m,s,validate)=>{await validate();sent={...m};return 'test-message';}};
 context.navigator={clipboard:{writeText:async text=>{copied=text;}}};
 vm.runInContext("data={owner:true,email:'owner@example.com'}",context);
 backend.call=async()=>[{email:mail.details.email,books:mail.details.books,version:'v1'}];
 context.accessEmailPreview({...mail.details,version:'v1'});
 assert.match(node('content').innerHTML,/<input id="accessEmailSubject"/);
 assert.match(node('content').innerHTML,/<textarea id="accessEmailBody"/);
 assert.doesNotMatch(node('content').innerHTML,/<pre class="emailPreview"/);
 node('accessEmailSubject').value='Access invitation and additional instructions';
 node('accessEmailBody').value=mail.api.compose(mail.details).body+'\n\nPlease review the November entries before Friday.';
 const body=node('accessEmailBody').value;
 await context.copyAccessEmail();assert.equal(copied,'Subject: '+node('accessEmailSubject').value+'\n\n'+body);
 await context.sendAccessEmail();assert.equal(sent.subject,'Access invitation and additional instructions');assert.equal(sent.body,body);assert.equal(sent.to,mail.details.email);
 assert.equal(node('accessEmailBody').value,'');assert.equal(node('sendAccessEmail').disabled,true);
});

function mailAppPage() {
  const {context,node,backend}=page(),mail=mailEnv(),drafts=[];
  context.LedgerAccessEmail={
    compose:mail.api.compose,mailAppUrl:mail.api.mailAppUrl,
    prepare:async()=>{throw Error('Google unavailable');}
  };
  vm.runInContext("data={owner:true,email:'owner@example.com'}",context);
  const member={email:'reviewer+nov@example.com',books:mail.details.books,version:'v1'};
  backend.call=async()=>[member];
  context.window.location={assign:url=>drafts.push(new URL(url))};
  context.accessEmailPreview({...mail.details,email:member.email,version:member.version});
  node('accessEmailSubject').value='Access & November';
  node('accessEmailBody').value='Password: ?&bcc=another@example.com\n✓ ລາວ';
  return {context,node,backend,drafts,member};
}
test('opening the edited invitation in a mail app works without Google setup and does not mark it sent',async()=>{
  const {context,node,drafts,member}=mailAppPage();
  await context.sendAccessEmail(true);
  assert.equal(drafts.length,1);
  const [draft]=drafts;
  assert.equal(draft.protocol,'mailto:');
  assert.equal(decodeURIComponent(draft.pathname),member.email);
  assert.deepEqual([...draft.searchParams.keys()],['subject','body']);
  assert.equal(draft.searchParams.get('subject'),node('accessEmailSubject').value);
  assert.equal(draft.searchParams.get('body'),node('accessEmailBody').value.replace(/\n/g,'\r\n'));
  assert.equal(node('accessEmailBody').readOnly,false);
  assert.equal(node('sendAccessEmail').disabled,true);
  assert.match(node('emailStatus').textContent,/tap Send in your email app/);
});
test('mail app handoff stops if access changed and uses a fresh tap if validation outlasted the user gesture',async()=>{
  const {context,node,backend,drafts,member}=mailAppPage();
  backend.call=async()=>[{...member,version:'v2'}];
  await context.sendAccessEmail(true);
  assert.equal(drafts.length,0);
  assert.match(node('emailStatus').textContent,/access changed/);
  backend.call=async()=>[member];
  context.window.navigator={userActivation:{isActive:false}};
  await context.sendAccessEmail(true);
  assert.equal(drafts.length,0);
  assert.match(node('emailStatus').textContent,/Tap Open in email app again/);
  node('accessEmailSubject').value='Edited before opening';
  context.window.navigator.userActivation.isActive=true;
  await context.sendAccessEmail(true);
  assert.equal(drafts.length,1);
  assert.equal(drafts[0].searchParams.get('subject'),'Edited before opening');
});
test('after Gmail rejects a direct send for disabled API, the edited draft is ready for the mail app',async()=>{
  const {context,node,drafts}=mailAppPage(),mail=mailEnv({failure:true});
  await mail.api.prepare();
  context.LedgerAccessEmail=mail.api;
  await context.sendAccessEmail();
  assert.equal(node('gmailSetup').hidden,false);
  assert.equal(drafts.length,0);
  assert.match(node('emailStatus').textContent,/Choose Open in email app/);
  await context.sendAccessEmail(true);
  assert.equal(drafts.length,1);
  assert.equal(mail.calls.filter(c=>c.url.includes('/messages/send')).length,1);
});

test('invitation and Facebook visits isolate authentication from the returning Chrome account',()=>{
 const invitation=mailEnv().api.compose(mailEnv().details).body.match(/App link: (\S+)/)[1];
 assert.equal(new URL(invitation).search,'?invite=1');
 for(const [search,userAgent,isolated] of [['?invite=1','Chrome',true],['?fbclid=test','FB_IAB/FB4A',true],['','Chrome',false]]){
  let auth;
  vm.runInNewContext(read('docs/personal-db.js'),{location:{search},navigator:{userAgent},URLSearchParams,supabase:{createClient:(url,key,options)=>{auth=options.auth;return {};}}});
  assert.equal(auth.persistSession,!isolated);
  assert.equal(auth.detectSessionInUrl,!isolated);
  assert.equal(auth.storageKey==='personal-ledger.auth.v1',!isolated);
 }
});

test('embedded visitors get a browser handoff before the password form',()=>{
 for(const [ua,chrome] of [['Android FB_IAB',true],['iPhone WhatsApp',false]]){
  const {context,node}=page();
  context.navigator={userAgent:ua};context.ledgerDb.embedded=true;
  context.loginScreen();
  assert.equal(node('accessTitle').textContent,'Open the ledger in your browser');
  const actions=node('accessActions').innerHTML;
  assert.equal(actions.includes('intent://'),chrome);
  assert.match(actions,/\?invite=1/);assert.doesNotMatch(actions,/loginPassword/);
  vm.runInContext('continueInApp=true;loginScreen()',context);
  assert.match(node('accessActions').innerHTML,/loginPassword/);
 }
});

test('reopening an assigned password masks its saved value and permission-only saves keep the login',async()=>{
 const {context,node,backend}=page();
 const member={email:'reviewer@example.com',version:'v1',books:{Personal:'viewer'}};
 vm.runInContext("data={owner:true,books:['Personal'],email:'owner@example.com'}",context);
 context.member=member;vm.runInContext('people=[member]',context);
 const input=node('personPass');input.isConnected=true;
 context.ledgerDb.assignedPassword=async()=>'Example-Only123';
 await context.loadAssignedPassword(member);
 assert.equal(input.value,'Example-Only123');assert.equal(input.defaultValue,input.value);
 node('personEmail').value=member.email;node('includeBook0').checked=true;node('grant0').value='editor';
 const calls=[];backend.call=async name=>{calls.push(name);return [member];};
 context.ledgerDb.provisionReviewer=async()=>calls.push('replace');
 context.peopleSettings=async()=>{};
 await context.savePerson(0);assert.deepEqual(calls,['saveAccess']);
 input.value='Replacement123';await context.savePerson(0);assert.deepEqual(calls,['saveAccess','replace']);
});
