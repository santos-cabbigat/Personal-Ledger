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
 assert.equal(m.to,e.details.email);assert.match(m.body,/Dear Ledger User,/);assert.ok(m.body.includes(e.details.password));assert.match(m.body,/https:\/\/santos-cabbigat.github.io\/Personal-Ledger\//);assert.match(m.body,/Business: Co-editor/);assert.match(m.body,/Personal: View only/);
 assert.throws(()=>e.api.compose({...e.details,email:'a@example.com\r\nBcc:other@example.com'}));
});
test('preparation sends nothing; one deliberate send authorizes Google and transmits the complete UTF-8 message',async()=>{
 const e=mailEnv();await e.api.prepare();assert.equal(e.consent,0);assert.equal(e.calls.length,1);
 assert.equal(await e.api.send(e.api.compose(e.details),e.details.sender,e.validate),'message-1');assert.equal(e.consent,1);
 const sent=e.calls.find(c=>c.url.includes('/messages/send'));assert.equal(sent.opts.credentials,'omit');
 const mime=Buffer.from(JSON.parse(sent.opts.body).raw,'base64url').toString('utf8');
 assert.match(mime,/To: reviewer@example.com/);
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
