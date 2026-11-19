'use strict';
const ledgerDb=(()=>{
 const url='https://uyyihuvjbrbsombzzvqw.supabase.co';
 const key='sb_publishable_VwYzs5ihi9tR_r1wcfCo-w_mboqCHV_';
 const embedded=/FBAN|FBAV|FB_IAB|FB4A|FBIOS|MessengerFor/i.test(globalThis.navigator?.userAgent||'');
 const params=typeof location==='undefined'?null:new URLSearchParams(location.search);
 const invitation=params?.get('invite')==='1';
 const isolated=invitation||embedded;
 const client=supabase.createClient(url,key,{auth:{
   storageKey:isolated?'personal-ledger.guest':'personal-ledger.auth.v1',
   persistSession:!isolated,
   autoRefreshToken:true,
   detectSessionInUrl:!isolated||(!invitation&&params?.get('reset')==='1')
 }});
 function check(result){
   if(result.error)throw Error((result.status===540||result.error.status===540||result.error.code==='PROJECT_PAUSED')?'Personal Ledger is paused. Resume the project to reconnect.':result.error.message);
   return result.data;
 }
 async function call(action,input){
   const p=action==='state'?{}:['saveBookType','renameLedger'].includes(action)?{name:input}:input||{};
   return check(await client.rpc('personal_ledger',{action,p}));
 }
 async function serviceStatus(){
   const controller=new AbortController();
   const timeout=setTimeout(()=>controller.abort(),8000);
   try{
     const response=await fetch(url+'/auth/v1/health',{headers:{apikey:key},cache:'no-store',credentials:'omit',signal:controller.signal});
     if(response.status===540)return 'paused';
     if(!response.ok)return 'unavailable';
     const body=await response.json();
     return body && typeof body.version==='string' ? 'online' : 'unavailable';
   }catch{return 'unreachable';}finally{clearTimeout(timeout);}
 }
 async function session(){return check(await client.auth.getSession()).session;}
 async function passwordSignIn(email,password){return check(await client.auth.signInWithPassword({email,password}));}
 async function signIn(email,password){
   email=email.trim().toLowerCase();
   const alias=check(await client.rpc('personal_reviewer_alias',{address:email}));
   try{return await passwordSignIn(alias,password);}
   catch(error){if(!/invalid login credentials/i.test(error.message))throw error;return passwordSignIn(email,password);}
 }
 const signInReviewer=signIn; // Existing shared links use the same sign-in flow.
 async function provisionReviewer(payload){
   const {data,error}=await client.functions.invoke('ledger-reviewer',{body:payload});
   if(error){
     const details=await error.context?.json?.().catch(()=>null);
     throw Error(details?.error||error.message);
   }
   return data;
 }
 async function signup(email,password){return check(await client.auth.signUp({email,password,options:{emailRedirectTo:location.origin+location.pathname}}));}
 async function forgot(email){return check(await client.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname+'?reset=1'}));}
 async function password(value){return check(await client.auth.updateUser({password:value}));}
 async function signOut(){return check(await client.auth.signOut({scope:'local'}));}
 return {isolated,embedded,serviceStatus,session,signIn,signInReviewer,provisionReviewer,signup,forgot,password,signOut,call};
})();
