// Only the GitHub Pages ledger may exchange messages with this invisible session page.
function browserSession_(nonce) {
  const origin='https://santos-cabbigat.github.io';
  if(!/^[0-9a-f-]{36}$/.test(nonce))throw Error('Invalid ledger session request.');
  const ownerSheet=ledgerId_();
  if(!ownerSheet || SpreadsheetApp.openById(ownerSheet).getOwner().getEmail().toLowerCase()!==signedIn_())
    throw Error('Use the Google account that owns this personal ledger.');
  const html='<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><script>('+
    ledgerSessionPage_.toString()+')('+JSON.stringify(origin)+','+JSON.stringify(nonce)+');</script>';
  return HtmlService.createHtmlOutput(html).setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function ledgerSessionPage_(origin,nonce) {
  const methods=['state','openExistingLedger','connectPersonalDrive','saveAccount','postEntry','renameLedger','saveBookType'];
  function connect(event) {
    if(event.origin!==origin || event.source!==window.top || event.data?.type!=='ledger-connect' ||
       event.data.nonce!==nonce || !event.ports[0])return;
    window.removeEventListener('message',connect);
    const port=event.ports[0];
    port.onmessage=function({data}) {
      if(!data || !Number.isSafeInteger(data.id) || !methods.includes(data.method) || !Array.isArray(data.args))return;
      google.script.run.withSuccessHandler(result=>port.postMessage({id:data.id,result}))
        .withFailureHandler(error=>port.postMessage({id:data.id,error:error.message||String(error)}))[data.method](...data.args);
    };
    port.postMessage({ready:true});
  }
  window.addEventListener('message',connect);
  window.top.postMessage({type:'ledger-session',nonce},origin);
}
