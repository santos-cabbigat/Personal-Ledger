'use strict';

// These are public deployment identifiers. Access tokens exist only in this tab's memory.
const ledgerGoogle = (() => {
  const webApp = 'https://script.google.com/macros/s/AKfycbywWbAojmt9_zXueXPOqSXSqpJwDwyUydy_7sUJBxclgC9pc71yxjringWlJfGTxw/exec';
  const scopes = ['drive.file', 'spreadsheets', 'userinfo.email', 'script.container.ui']
    .map(name => 'https://www.googleapis.com/auth/' + name);
  let config, client, token = '', expiresAt = 0, loading, signingIn;
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
      client.requestAccessToken();
    }).finally(() => { signingIn = null; });
    return signingIn;
  }
  function authorized() { return Boolean(token && expiresAt > Date.now()+30000); }
  async function call(method,...parameters) {
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
  return {webApp,prepare,configured,authorized,signIn,call};
})();
