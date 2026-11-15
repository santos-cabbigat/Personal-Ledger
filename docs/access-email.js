'use strict';
// Gmail tokens and invitation credentials are never persisted to browser storage.
const LedgerAccessEmail = (() => {
  const scope = 'https://www.googleapis.com/auth/gmail.send';
  const appUrl = 'https://santos-cabbigat.github.io/Personal-Ledger/';
  let ready, clientId, accessToken = '', expiresAt = 0, sending = false;
  function compose({email, password, books, sender}) {
    if (!/^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/.test(email)) throw Error('Enter one valid recipient email address.');
    const access = Object.entries(books).map(([book,role]) => '- ' + book + ': ' + (role === 'editor' ? 'Co-editor' : 'View only')).join('\n');
    return {to:email, subject:'Your Personal & Business Ledger Access', body:
      'Dear Ledger User,\n\nYou have been granted access to the Personal & Business Ledger. Please use the following details to sign in:\n\n' +
      'App link: ' + appUrl + '\nEmail: ' + email + '\nPassword: ' + (password || 'Please use the password previously provided to you.') +
      '\n\nYour authorized book access:\n' + access +
      '\n\nOpen the app link and enter the email address and password shown above. Please keep your login details confidential and do not share them with others.' +
      '\n\nIf you need assistance or a password change, please contact the ledger administrator.\n\nKind regards,\nLedger Administrator\n' + sender};
  }
  function prepare() {
    if (ready) return ready;
    ready = Promise.all([
      fetch('./google-config.json', {cache:'no-cache'}).then(async r => {if (!r.ok) throw Error('Email connection settings could not load.');clientId = (await r.json()).clientId;if (!clientId) throw Error('The email connection is not configured.');}),
      new Promise((resolve,reject) => {
        if (window.google?.accounts?.oauth2) return resolve();
        const script = document.createElement('script');script.src = 'https://accounts.google.com/gsi/client';
        script.onload = () => window.google?.accounts?.oauth2 ? resolve() : reject(Error('Google email connection could not load.'));
        script.onerror = () => {script.remove();reject(Error('Google email connection could not load. Check your internet connection.'));};
        document.head.append(script);
      })
    ]).catch(e => {ready = null;throw e;});
    return ready;
  }
  function authorize(sender) {
    if (accessToken && expiresAt > Date.now() + 30000) return Promise.resolve(accessToken);
    return new Promise((resolve,reject) => {
      // Called directly from Send email, after preparation, to preserve the popup's user gesture.
      const client = google.accounts.oauth2.initTokenClient({client_id:clientId,scope,include_granted_scopes:false,
        callback:result => {
          if (result.error || !result.access_token || !google.accounts.oauth2.hasGrantedAllScopes(result,scope)) return reject(Error('Email permission was not granted. Nothing was sent.'));
          accessToken = result.access_token;expiresAt = Date.now() + Number(result.expires_in) * 1000;resolve(accessToken);
        },error_callback:() => reject(Error('The Google connection was closed or blocked. Nothing was sent.'))});
      client.requestAccessToken({prompt:'',login_hint:sender});
    });
  }
  function rawMessage(message) {
    const base64 = value => btoa(String.fromCharCode(...new TextEncoder().encode(value)));
    const mime = ['To: '+message.to,'Subject: =?UTF-8?B?'+base64(message.subject)+'?=',
      'MIME-Version: 1.0','Content-Type: text/plain; charset=UTF-8','Content-Transfer-Encoding: base64','',
      base64(message.body).match(/.{1,76}/g).join('\r\n')].join('\r\n');
    return base64(mime).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  }
  async function send(message,sender,validate) {
    if (sending) throw Error('An email is already being sent.');
    if (!clientId || !window.google?.accounts?.oauth2) throw Error('Wait for the email connection to finish loading, then press Send email.');
    sending = true;
    try {
      const token = await authorize(sender);
      await validate();
      let response;
      try {response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send',{
        method:'POST',cache:'no-store',credentials:'omit',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({raw:rawMessage(message)})});}
      catch {throw Error('The email result could not be confirmed. Check Sent mail before trying again.');}
      let result;
      try {result = await response.json();} catch {throw Error('The email result could not be confirmed. Check Sent mail before trying again.');}
      if (response.status === 401) {accessToken = '';expiresAt = 0;throw Error('Your Google email connection expired. Press Send email to reconnect.');}
      if (!response.ok) {
        const disabled = result.error?.details?.some(d => d.reason === 'SERVICE_DISABLED') || /not been used|disabled/i.test(result.error?.message || '');
        throw Error(disabled ? 'Email sending needs Gmail API activation for this app. Your access is saved; no email was sent. You can copy the email below.' : 'Google did not accept the email. Check your email permission and try again.');
      }
      if (!result.id) throw Error('The email result could not be confirmed. Check Sent mail before trying again.');
      return result.id;
    } finally {sending = false;}
  }
  function clear() {accessToken = '';expiresAt = 0;}
  return {compose,prepare,send,clear};
})();
