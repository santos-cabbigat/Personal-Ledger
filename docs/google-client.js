'use strict';

// These are public deployment identifiers. Access tokens exist only in this tab's memory.
const ledgerGoogle = (() => {
  const webApp = 'https://script.google.com/macros/s/AKfycbywWbAojmt9_zXueXPOqSXSqpJwDwyUydy_7sUJBxclgC9pc71yxjringWlJfGTxw/exec';
  const scopes = ['drive.file', 'spreadsheets', 'userinfo.email', 'script.container.ui']
    .map(name => 'https://www.googleapis.com/auth/' + name);
  let config, client, token = '', expiresAt = 0, loading, signingIn;
  // The saved account is only a hint. Google validates access on every workbook request.
  const accountKey='personal-ledger.remembered-account.v1';
  let port,connecting,requestId=0,frame;
  const pending=new Map();
  function savedAccount(){
    try{return window.localStorage.getItem(accountKey)||'';}catch{return '';}
  }
  function remember(email){
    if(!email)return;
    try{window.localStorage.setItem(accountKey,email);}catch{}
  }
  function clearChannel(){
    port?.close();port=null;
    frame?.remove();frame=null;
    for(const request of pending.values()){
      clearTimeout(request.timer);
      request.reject(Error('Connection closed. Check your journal before retrying a change.'));
    }
    pending.clear();
  }
  function forget(){
    token='';expiresAt=0;
    try{window.localStorage.removeItem(accountKey);}catch{}
    clearChannel();
  }
  function belongsToFrame(source,outer) {
    try{
      while(source && source!==window && source!==outer){
        if(source===source.parent)return false;
        source=source.parent;
      }
      return source===outer;
    }catch{return false;}
  }
  function channelCall(method,args){
    return new Promise((resolve,reject)=>{
      const id=++requestId;
      const timer=setTimeout(()=>{
        pending.delete(id);
        reject(Error('Google did not confirm the result. Refresh before retrying.'));
        clearChannel();
      },90000);
      pending.set(id,{resolve,reject,timer});
      port.postMessage({id,method,args});
    });
  }
  function openChannel() {
    if(port)return Promise.resolve(true);
    if(connecting)return connecting;
    const nonce=crypto.randomUUID();
    frame=document.createElement('iframe');
    frame.className='sessionFrame';frame.tabIndex=-1;frame.setAttribute('aria-hidden','true');frame.title='Ledger session';frame.referrerPolicy='no-referrer';
    connecting=new Promise(resolve=>{
      let handshake,finished=false;
      const finish=ok=>{
        if(finished)return;
        finished=true;
        clearTimeout(timer);
        window.removeEventListener('message',receive);
        if(!ok){handshake?.close();clearChannel();}
        resolve(ok);
      };
      function receive(event){
        if(!frame || event.data?.type!=='ledger-session' || event.data.nonce!==nonce ||
          !/^https:\/\/(?:[a-z0-9-]+-)?script\.googleusercontent\.com$/.test(event.origin) ||
          !belongsToFrame(event.source,frame?.contentWindow) || handshake)return;
        const channel=new MessageChannel();
        handshake=channel.port1;
        handshake.onmessage=({data})=>{
          if(!port && data?.ready===true){port=handshake;finish(true);return;}
          const request=pending.get(data?.id);
          if(!request)return;
          clearTimeout(request.timer);pending.delete(data.id);
          if(data.error)request.reject(Error(data.error));else request.resolve(data.result);
        };
        event.source.postMessage({type:'ledger-connect',nonce},event.origin,[channel.port2]);
      }
      const timer=setTimeout(()=>finish(false),35000);
      window.addEventListener('message',receive);
      frame.src=webApp+'?ledgerSession='+encodeURIComponent(nonce);
      document.body.append(frame);
    }).finally(()=>{connecting=null;});
    return connecting;
  }
  async function restore(){
    const expected=savedAccount();
    if(!expected || !await openChannel())return null;
    try{
      const state=await channelCall('state',[]);
      if(state?.email && state.email.toLowerCase()===expected.toLowerCase() && savedAccount()===expected)return state;
    }catch{}
    clearChannel();
    return null;
  }
  async function setup() {
    if (config) return config;
    const response = await fetch('./google-config.json', {cache: 'no-cache'});
    if (!response.ok) throw Error('The Google connection settings could not be loaded.');
    config = await response.json();
    return config;
  }
  function configured() {
    return Boolean(config?.clientId && config?.deploymentId);
  }
  function loadIdentity() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    if (!loading) loading = new Promise((resolve,reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.onload = resolve;
      script.onerror = () => {
        loading = null;
        script.remove();
        reject(Error('Google sign-in could not load. Check your connection and try again.'));
      };
      document.head.append(script);
    });
    return loading;
  }
  async function prepare() {
    await setup();
    if (configured()) await loadIdentity();
  }
  function signIn() {
    if (signingIn) return signingIn;
    if (!configured() || !window.google?.accounts?.oauth2) {
      return Promise.reject(Error('Google sign-in is not ready. Refresh and try again.'));
    }
    signingIn = new Promise((resolve,reject) => {
      client = google.accounts.oauth2.initTokenClient({
        client_id: config.clientId, scope: scopes.join(' '),
        callback: result => {
          if (result.error || !result.access_token || !google.accounts.oauth2.hasGrantedAllScopes(result,...scopes)) {
            reject(Error('Google access was not granted for this ledger.'));
            return;
          }
          token = result.access_token;
          expiresAt = Date.now() + Number(result.expires_in) * 1000;
          resolve();
        },
        error_callback: () => reject(Error('Google sign-in did not finish. Try again when ready.'))
      });
      const hint=savedAccount();
      client.requestAccessToken(hint?{prompt:'',login_hint:hint}:{prompt:'select_account'});
    }).finally(() => { signingIn = null; });
    return signingIn;
  }
  function authorized() { return Boolean(port || (token && expiresAt > Date.now()+30000)); }
  async function call(method,...parameters) {
    if(!authorized() && method!=='state' && savedAccount()){
      if(!await restore())throw Error('Sign in to Google again to continue.');
    }
    if(port)return channelCall(method,parameters);
    if (!authorized()) throw Error('Sign in to Google again to continue.');
    const id = encodeURIComponent(config.deploymentId);
    const response = await fetch('https://script.googleapis.com/v1/scripts/' + id + ':run', {
      method: 'POST', cache: 'no-store',
      headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
      body: JSON.stringify({function: method, parameters, devMode: false})
    });
    if (response.status === 401) {
      token = '';
      throw Error('Your Google session expired. Sign in again, then retry.');
    }
    const result = await response.json();
    if (!response.ok || result.error) {
      throw Error(result.error?.details?.[0]?.errorMessage || result.error?.message || 'Google could not complete this request.');
    }
    if (result.done !== true || !result.response) throw Error('Google did not confirm the result. Refresh before retrying.');
    return result.response.result;
  }
  return {prepare,configured,authorized,signIn,call,remember,savedAccount,restore,forget};
})();
