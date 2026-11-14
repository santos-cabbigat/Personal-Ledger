// Installed in the owner's bound spreadsheet project. Only the fingerprint leaves script properties during setup.
const PERSONAL_DB_URL_='https://uyyihuvjbrbsombzzvqw.supabase.co';
const PERSONAL_PUBLIC_KEY_='sb_publishable_VwYzs5ihi9tR_r1wcfCo-w_mboqCHV_';
const ARCHIVE_TAB_='Ledger Archive';
const ARCHIVE_HEADERS_=['Revision','Part','Record type','Book','Entry ID','Date','Description','Code','Account','Debit (LAK)','Credit (LAK)','Posted by','Reference','Original record JSON'];
function personalArchiveOwner_(){
  const id=ledgerId_() || SpreadsheetApp.getActiveSpreadsheet()?.getId();
  const sheet=SpreadsheetApp.openById(id);
  const owner=sheet.getOwner().getEmail().toLowerCase();
  if(!owner || Session.getEffectiveUser().getEmail().toLowerCase()!==owner || Session.getActiveUser().getEmail().toLowerCase()!==owner)
    throw Error('The workbook owner must run archive setup.');
  return sheet;
}
function preparePersonalArchive(){
  personalArchiveOwner_();
  const props=PropertiesService.getScriptProperties();
  let key=props.getProperty('PERSONAL_ARCHIVE_PROOF');
  if(!key){key=Utilities.getUuid()+Utilities.getUuid();props.setProperty('PERSONAL_ARCHIVE_PROOF',key);}
  const fingerprint=Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,key).map(b=>(b&255).toString(16).padStart(2,'0')).join('');
  console.log('Archive fingerprint '+fingerprint);
}
function archiveRpc_(action,p){
  const proof=PropertiesService.getScriptProperties().getProperty('PERSONAL_ARCHIVE_PROOF');
  if(!proof)throw Error('Prepare the archive connection first.');
  const response=UrlFetchApp.fetch(PERSONAL_DB_URL_+'/rest/v1/rpc/personal_ledger_archive',{method:'post',headers:{apikey:PERSONAL_PUBLIC_KEY_},
    contentType:'application/json',payload:JSON.stringify({action,proof,p:p||{}}),muteHttpExceptions:true});
  const body=JSON.parse(response.getContentText());
  if(response.getResponseCode()>=300)throw Error(body.message||'Archive request failed.');
  return body;
}
function startPersonalLedger(){
  const sheet=personalArchiveOwner_();
  const lock=LockService.getScriptLock();lock.waitLock(10000);
  try{
    const props=PropertiesService.getScriptProperties();
    if(!props.getProperty('PERSONAL_IMPORTED')){
      const owner=sheet.getOwner().getEmail().toLowerCase();
      const current=workbookState_(sheet,owner,owner);
      try{const imported=archiveRpc_('import',current);console.log('Imported '+imported.entries+' entries and '+imported.accounts+' accounts.');}
      catch(error){if(!String(error.message).includes('already imported'))throw error;}
      props.setProperty('PERSONAL_IMPORTED','1');
    }
    if(!ScriptApp.getProjectTriggers().some(t=>t.getHandlerFunction()==='dailyPersonalArchive'))
      ScriptApp.newTrigger('dailyPersonalArchive').timeBased().atHour(2).everyDays(1).inTimezone('Asia/Vientiane').create();
  }finally{lock.releaseLock();}
  dailyPersonalArchive();
}
function activatePersonalLedger(){
  const sheet=personalArchiveOwner_();
  if(!PropertiesService.getScriptProperties().getProperty('PERSONAL_IMPORTED') || archiveRpc_('batch').length)
    throw Error('Finish importing and verifying the first archive before switching.');
  const archive=sheet.getSheetByName(ARCHIVE_TAB_);
  if(!archive || archive.getLastRow()<2)throw Error('The first archive has not been written.');
  PropertiesService.getScriptProperties().setProperty('PERSONAL_LIVE_WORKBOOK',sheet.getId());
}
function archiveRows_(record){
  const x=record.content;
  const parts=JSON.stringify(x).match(/[\s\S]{1,18000}/gu)||[''];
  const lines=x.catalog?x.catalog.accounts:x.lines;
  const result=[];
  for(let i=0;i<Math.max(parts.length,lines.length,1);i++){
    const l=lines[i]||{};
    result.push([record.revision,i+1,x.catalog?'Account catalog':x.draft?'Balanced draft':'Journal revision',
      x.book||l.book||'',x.id||'',x.day||'',l.lineMemo||x.memo||'',l.code||'',l.name||'',l.debit??'',l.credit??'',x.poster||'',l.reference||'',parts[i]||'']);
  }
  return result;
}
function dailyPersonalArchive(){
  const sheet=SpreadsheetApp.openById(ledgerId_() || SpreadsheetApp.getActiveSpreadsheet().getId());
  if(sheet.getOwner().getEmail().toLowerCase()!==Session.getEffectiveUser().getEmail().toLowerCase())throw Error('The archive runs as the owner.');
  const lock=LockService.getScriptLock();if(!lock.tryLock(1000))return;
  const start=Date.now();
  try{
    let tab=sheet.getSheetByName(ARCHIVE_TAB_);
    if(!tab){tab=sheet.insertSheet(ARCHIVE_TAB_);tab.getRange(1,1,1,ARCHIVE_HEADERS_.length).setValues([ARCHIVE_HEADERS_]);tab.setFrozenRows(1);}
    const titles=tab.getRange(1,1,1,ARCHIVE_HEADERS_.length).getValues()[0];
    if(JSON.stringify(titles)!==JSON.stringify(ARCHIVE_HEADERS_))throw Error('Archive columns have changed. No entries acknowledged.');
    const existing=new Map();const count=tab.getLastRow()-1;
    if(count)tab.getRange(2,1,count,2).getValues().forEach(([rev,part],i)=>existing.set(rev+'/'+part,i+2));
    const range="'"+ARCHIVE_TAB_+"'!A:N";
    while(Date.now()-start<235000){
      const batch=archiveRpc_('batch');if(!batch.length){archiveRpc_('complete');return;}
      const wanted=batch.flatMap(archiveRows_);const additions=wanted.filter(r=>!existing.has(r[0]+'/'+r[1]));
      if(additions.length){
        let next=tab.getLastRow()+1;
        Sheets.Spreadsheets.Values.append({values:additions},sheet.getId(),range,{valueInputOption:'RAW',insertDataOption:'INSERT_ROWS'});
        for(const r of additions)existing.set(r[0]+'/'+r[1],next++);
      }
      const requests=wanted.map(r=>{const pos=existing.get(r[0]+'/'+r[1]);return "'"+ARCHIVE_TAB_+"'!A"+pos+':N'+pos;});
      for(let i=0;i<requests.length;i+=50){
        const chunk=requests.slice(i,i+50);
        const read=Sheets.Spreadsheets.Values.batchGet(sheet.getId(),{ranges:chunk,valueRenderOption:'UNFORMATTED_VALUE'}).valueRanges;
        if(read.length!==chunk.length)throw Error('Archive readback was incomplete.');
        for(let j=0;j<chunk.length;j++){
          const cells=read[j].values?.[0]||[];
          if(!wanted[i+j].every((v,k)=>v===(cells[k]??'')))throw Error('Archive readback differs. Detail remains in Supabase.');
        }
      }
      archiveRpc_('confirm',batch.map(r=>({seq:r.seq,revision:r.revision})));
    }
  }finally{lock.releaseLock();}
}
