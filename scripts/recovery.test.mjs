import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../recovery/Code.gs',import.meta.url),'utf8');
function service(status,token='fixture'){
  const props=new Map(),requests=[];
  if(token)props.set('PERSONAL_PROJECT_RECOVERY_TOKEN',token);
  const scope={PropertiesService:{getUserProperties:()=>({getProperty:k=>props.get(k),setProperty:(k,v)=>props.set(k,v)})},
    LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},UrlFetchApp:{fetch:(url,options)=>{
      requests.push([url,options.method]);
      return {getResponseCode:()=>200,getContentText:()=>JSON.stringify({id:'uyyihuvjbrbsombzzvqw',status})};
    }}};
  vm.createContext(scope);vm.runInContext(source,scope);return {scope,requests};
}
test('owner recovery never changes an online, restoring, unknown or disconnected project',()=>{
  for(const status of ['ACTIVE_HEALTHY','RESTORING','UNKNOWN']){
    const {scope,requests}=service(status);scope.resumePersonalProject();assert.equal(requests.length,1);assert.equal(requests[0][1],'get');
  }
  const {scope,requests}=service('INACTIVE','');assert.match(scope.resumePersonalProject().message,/awaiting activation/);assert.equal(requests.length,0);
});
test('restore rechecks the project and prevents duplicate requests',()=>{
  const {scope,requests}=service('INACTIVE');
  assert.equal(scope.checkPersonalProject().canResume,true);
  assert.match(scope.resumePersonalProject().message,/accepted/);
  assert.match(scope.resumePersonalProject().message,/recently/);
  assert.deepEqual(requests.filter(r=>r[1]==='post'),[['https://api.supabase.com/v1/projects/uyyihuvjbrbsombzzvqw/restore','post']]);
});
