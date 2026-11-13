'use strict';
// A browser-managed worker can serve other open ledger tabs without exposing the grant to them.
let session;
const readsAndWrites=new Set(['state','openExistingLedger','connectPersonalDrive','saveAccount','postEntry','renameLedger','saveBookType']);
self.onconnect=({ports:[port]})=>{
  port.onmessage=async ({data})=>{
    const {id,action}=data;
    try {
      if(action==='clear'){session=undefined;port.postMessage({id,result:true});return;}
      if(action==='save'){
        const {account,token,expiresAt,deployment}=data;
        if(!account || !token || !/^[\w-]+$/.test(deployment) || !Number.isFinite(expiresAt))throw Error('Invalid session.');
        session={account,token,expiresAt,deployment};
        port.postMessage({id,result:true});return;
      }
      const active=session;
      if(!active || active.expiresAt<=Date.now()+30000 || data.account!==active.account){
        port.postMessage({id,expired:true});return;
      }
      if(action==='check'){port.postMessage({id,result:true});return;}
      if(action!=='call' || !readsAndWrites.has(data.method) || !Array.isArray(data.args))throw Error('Invalid ledger request.');
      const response=await fetch('https://script.googleapis.com/v1/scripts/'+active.deployment+':run',{
        method:'POST',cache:'no-store',credentials:'omit',
        headers:{Authorization:'Bearer '+active.token,'Content-Type':'application/json'},
        body:JSON.stringify({function:data.method,parameters:data.args,devMode:false})
      });
      if(response.status===401){
        if(active===session)session=undefined;
        port.postMessage({id,expired:true});return;
      }
      const reply=await response.json();
      if(!response.ok || reply.error)throw Error(reply.error?.details?.[0]?.errorMessage || reply.error?.message || 'Google could not complete this request.');
      if(!reply.done || !reply.response)throw Error('Google did not confirm the result. Refresh before retrying.');
      port.postMessage({id,result:reply.response.result});
    }catch(error){port.postMessage({id,error:error.message});}
  };
};
