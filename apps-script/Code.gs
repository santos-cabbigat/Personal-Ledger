function ledgerId_() {
  const properties = PropertiesService.getScriptProperties();
  const id = properties.getProperty('LEDGER_ID');

  return id;
}
function initializeLedger() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!sheet || sheet.getOwner().getEmail() !== Session.getEffectiveUser().getEmail()) throw Error('Only the spreadsheet owner may initialize the ledger.');
  if (!['Settings','Overview','Journal','Accounts'].every(name=>sheet.getSheetByName(name))) throw Error('Open the prepared ledger workbook.');
  PropertiesService.getScriptProperties().setProperty('LEDGER_ID', sheet.getId());
  openLedger();
}
const TYPES = ['Asset','Liability','Equity','Income','Expense'];
const BOOKS = ['Personal','Business'];
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Ledger').addItem('Initialize ledger','initializeLedger').addItem('Open ledger','openLedger').addToUi();
}
function openLedger() {
  SpreadsheetApp.getUi().showSidebar(page_().setTitle('Ledger'));
}
function doGet() { return page_(); }
function page_() {
  return HtmlService.createHtmlOutputFromFile('Index').setTitle('Shared ledger').addMetaTag('viewport','width=device-width, initial-scale=1, viewport-fit=cover');
}
const LEDGER_NAME = 'Personal & Business Ledger';
const JOURNAL_HEADERS = ['Entry ID','Date','Book','Description','Account code','Account name','Type','Debit (LAK)','Credit (LAK)','Posted by','Posted at','Request ID','Project','Edit request ID'];
const ACCOUNT_HEADERS = ['Code','Account name','Classification','Parent code','Use'];
function signedIn_() {
  const email = Session.getActiveUser().getEmail().toLowerCase();
  if (!email || email !== Session.getEffectiveUser().getEmail().toLowerCase())
    throw Error('Sign in with Google. The web app must run as the user accessing it.');
  return email;
}
function context_(optional) {
  const email = signedIn_();
  const selected = PropertiesService.getUserProperties().getProperty('ACTIVE_LEDGER');
  const id = selected || ledgerId_();
  let sheet;
  if (id) {
    try { sheet = SpreadsheetApp.openById(id); }
    catch (error) { if (!optional) throw Error('Open a ledger available to your Google account.'); }
  }
  if (!sheet && !optional) throw Error('Connect your Google Drive first.');
  return {sheet, email, owner: sheet ? sheet.getOwner().getEmail().toLowerCase() : ''};
}
function schema_(sheet) {
  for (const [name, expected] of [['Accounts', ACCOUNT_HEADERS], ['Journal', JOURNAL_HEADERS.slice(0,12)]]) {
    const tab = sheet.getSheetByName(name);
    if (!tab || JSON.stringify(tab.getRange(1,1,1,expected.length).getDisplayValues()[0]) !== JSON.stringify(expected))
      throw Error('Choose a Personal & Business Ledger spreadsheet with its original columns.');
  }
  if (!sheet.getSheetByName('Settings') || !sheet.getSheetByName('Overview')) throw Error('The ledger is missing Settings or Overview.');
}
function openExistingLedger(url) {
  signedIn_();
  const match = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([\w-]+)(?:[/?#]|$)/.exec(String(url).trim());
  if (!match) throw Error('Paste the Google Sheets link for your ledger.');
  const sheet = SpreadsheetApp.openById(match[1]);
  schema_(sheet);
  PropertiesService.getUserProperties().setProperty('ACTIVE_LEDGER',sheet.getId());
  return true;
}
function driveItem_(role, name, mimeType, parent) {
  const query = "trashed = false and 'me' in owners and mimeType = '" + mimeType +
    "' and appProperties has { key='ledgerRole' and value='" + role + "' }";
  const matches = Drive.Files.list({q:query,fields:'files(id)',pageSize:2}).files || [];
  if (matches.length > 1) throw Error('Multiple ledgers were found. Use Open existing ledger to select your file.');
  if (matches.length) return matches[0].id;
  const resource = {name, mimeType, appProperties:{ledgerRole:role}};
  if (parent) resource.parents = [parent];
  return Drive.Files.create(resource,null,{fields:'id'}).id;
}
function setupNewBook_(sheet) {
  const seed = [
    ['1000','Assets','Asset','','Group'],['1100','Cash on hand','Asset','1000','Posting'],['1110','Bank','Asset','1000','Posting'],
    ['2000','Liabilities','Liability','','Group'],['2100','Accounts payable','Liability','2000','Posting'],
    ['3000','Equity','Equity','','Group'],['3100','Opening balance','Equity','3000','Posting'],
    ['4000','Income','Income','','Group'],['4100','Personal income','Income','4000','Posting'],['4200','Sales income','Income','4000','Posting'],
    ['5000','Expenses','Expense','','Group'],['5100','Household expenses','Expense','5000','Posting'],['5200','Business supplies','Expense','5000','Posting']
  ];
  const first = sheet.getSheets()[0];
  if (sheet.getSheets().length === 1 && first.getLastRow() === 0) first.setName('Overview');
  const tabs = {Overview:[[LEDGER_NAME],['Type matching debit and credit lines together on the Journal tab. Leave Entry ID blank, then review and post from the app.']],
    Accounts:[ACCOUNT_HEADERS,...seed], Journal:[JOURNAL_HEADERS], Settings:[['Setting','Value'],['App name',LEDGER_NAME],['Currency','LAK']]};
  for (const [name, rows] of Object.entries(tabs)) {
    const tab = sheet.getSheetByName(name) || sheet.insertSheet(name);
    if (tab.getLastRow() === 0) {
      tab.getRange(1,1,rows.length,rows[0].length).setValues(rows);
      tab.setFrozenRows(1); tab.getRange(1,1,1,rows[0].length).setFontWeight('bold');
      tab.autoResizeColumns(1,rows[0].length);
    }
  }
  schema_(sheet);
}
function connectPersonalDrive() {
  const email = signedIn_(), lock=LockService.getUserLock();
  lock.waitLock(30000);
  try {
    const props=PropertiesService.getUserProperties();
    let id=props.getProperty('OWN_LEDGER');
    if (!id) {
      // Keep the original owner's existing books. New accounts start with empty journals.
      const legacy=context_(true);
      if(legacy.sheet && legacy.owner===email) id=legacy.sheet.getId();
    }
    if (!id) {
      const folder=driveItem_('folder',LEDGER_NAME,'application/vnd.google-apps.folder');
      id=driveItem_('book',LEDGER_NAME,'application/vnd.google-apps.spreadsheet',folder);
      setupNewBook_(SpreadsheetApp.openById(id));
    }
    const sheet=SpreadsheetApp.openById(id);
    if(sheet.getOwner().getEmail().toLowerCase()!==email) throw Error('Choose a ledger owned by this account.');
    schema_(sheet);
    props.setProperties({OWN_LEDGER:id,ACTIVE_LEDGER:id}); return true;
  } finally { lock.releaseLock(); }
}
function rows_(sheet, name, columns) {
  const tab = sheet.getSheetByName(name);
  if (!tab) throw Error('Missing sheet: '+name);
  const count = tab.getLastRow()-1;
  return count>0 ? tab.getRange(2,1,count,columns).getValues() : [];
}
function date_(value) {
  return value instanceof Date ? Utilities.formatDate(value,'Asia/Vientiane','yyyy-MM-dd') : String(value);
}
function accounts_(sheet) {
  return rows_(sheet,'Accounts',5).filter(r=>r[0] !== '').map(r=>({code:String(r[0]), name:String(r[1]),type:String(r[2]),parent:String(r[3]),use:String(r[4])}));
}
function revision_(rows) {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,JSON.stringify(rows)));
}
// Blank-ID lines typed together in Sheets become one draft when their debits and credits balance.
function journalGroups_(rawRows) {
  const groups=new Map();
  let draft='',balance=0,count=0;
  rawRows.forEach((row,index)=>{
    if(!row.some(value=>value!=='')){draft='';return;}
    let key=String(row[0]).trim();
    if(key){draft='';key='id:'+key;}
    else{
      if(!draft){draft='sheet:'+(index+2);balance=0;count=0;}
      key=draft;
      balance+=Math.round(Number(row[7]||0)*100)-Math.round(Number(row[8]||0)*100);
      count++;
      if(balance===0 && count>=2)draft='';
    }
    if(!groups.has(key))groups.set(key,[]);
    groups.get(key).push({row,number:index+2});
  });
  return groups;
}
function journalState_(sheet, accounts) {
  const warnings=[];
  const chart = new Map(accounts.map(a=>[a.code,a]));
  const tz=sheet.getSpreadsheetTimeZone();
  const groups=journalGroups_(rows_(sheet,'Journal',JOURNAL_HEADERS.length));
  const entries=[];
  for (const [groupKey,group] of groups) {
    const id=String(group[0].row[0]).trim();
    try {
      const rows=group.map(item=>item.row);
      const shared = index => {
        const values = [...new Set(rows.map(row=>row[index] instanceof Date ?
          Utilities.formatDate(row[index],tz,'yyyy-MM-dd') : String(row[index]).trim()).filter(Boolean))];
        if(values.length>1) throw Error('Use the same date, book, description and project on its lines.');
        return values[0] || '';
      };
      const date=shared(1), book=shared(2), memo=shared(3), project=shared(12);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date || !BOOKS.includes(book) || !memo) throw Error('Fill in the date, book and description.');
      let debitCents=0,creditCents=0;
      const version=revision_(rows);
      const lines=rows.map(r=>{
        const code=String(r[4]).trim(), a=chart.get(code);
        if(!a || a.use!=='Posting') throw Error('Choose a posting account code from Accounts.');
        const debit=cents_(r[7]),credit=cents_(r[8]);
        if((debit>0)===(credit>0)) throw Error('Each line needs one debit or credit.');
        debitCents+=debit;creditCents+=credit;
        return {id:id||('Sheet rows '+group[0].number+'–'+group[group.length-1].number),groupKey,date,book,memo,project,code,name:String(r[5]||a.name),type:String(r[6]||a.type),
          debit:debit/100,credit:credit/100,by:String(r[9]),sheetDraft:rows.every(item=>!item[9]&&!item[11]),revision:version};
      });
      if (debitCents!==creditCents || new Set(lines.map(l=>l.code)).size<2) throw Error('Balance the debit and credit lines across at least two accounts.');
      entries.push(...lines);
    } catch(error) { warnings.push('Row '+group[0].number+(id?' ('+id+')':'')+': '+error.message); }
  }
  return {entries,warnings};
}
function state() {
  const {sheet,email,owner}=context_(true);
  if (!sheet) return {connected:false,email};
  const accounts=accounts_(sheet);
  return {connected:true,ledgerId:sheet.getId(),title:sheet.getSheetByName('Settings').getRange('B2').getDisplayValue(),
    url:sheet.getUrl(),email,owner:email===owner,accounts,...journalState_(sheet,accounts),today:date_(new Date())};
}
function lock_(action) {
  const lock=LockService.getScriptLock(); lock.waitLock(15000);
  try { const result=action(); SpreadsheetApp.flush(); return result; } finally { lock.releaseLock(); }
}
function text_(s,limit) {
  s=String(s||'').trim();
  if(!s || s.length>limit || /^[=+@\-]/.test(s)) throw Error('Enter plain text up to '+limit+' characters.');
  return s;
}
function cents_(n) {
  if(n==='' || n==null) return 0;
  if(!/^(0|[1-9]\d{0,10})(\.\d{1,2})?$/.test(String(n))) throw Error('Use a nonnegative amount with at most two decimals.');
  return Math.round(Number(n)*100);
}
function checkLedger_(sheet,id) {
  if(id!==sheet.getId()) throw Error('The active ledger changed. Refresh before saving.');
}
function saveAccount(input) {
  return lock_(()=>{
    const {sheet}=context_(), accounts=accounts_(sheet);
    checkLedger_(sheet,input.ledgerId);
    const code=String(input.code||'').trim(), name=text_(input.name,80),parent=String(input.parent||'');
    if(!/^[1-9]\d{1,9}$/.test(code)||accounts.some(a=>a.code===code)) throw Error('Use a new numeric code (2–10 digits).');
    if(!TYPES.includes(input.type)||!['Group','Posting'].includes(input.use)) throw Error('Choose a valid classification and use.');
    if(parent && !accounts.some(a=>a.code===parent&&a.type===input.type&&a.use==='Group')) throw Error('Choose a parent group of the same classification.');
    sheet.getSheetByName('Accounts').appendRow([code,name,input.type,parent,input.use]);
    return code;
  });
}
function renameLedger(name,ledgerId) {
  return lock_(()=>{
    const {sheet,email,owner}=context_(); if(email!==owner) throw Error('Only the owner can change the app name.');
    checkLedger_(sheet,ledgerId);
    const title=text_(name,60); sheet.getSheetByName('Settings').getRange('B2').setValue(title); sheet.getSheetByName('Overview').getRange('A1').setValue(title); return title;
  });
}
function makeLines_(sheet,input,id,posted) {
  if (!BOOKS.includes(input.book)) throw Error('Choose Personal or Business.');
  const date=String(input.date||'');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0,10)!==date) throw Error('Choose a valid date.');
  const memo=text_(input.memo,180), project=input.project ? text_(input.project,80) : '';
  if (!Array.isArray(input.lines)||input.lines.length<2||input.lines.length>40) throw Error('Use 2–40 journal lines.');
  const accounts=new Map(accounts_(sheet).filter(a=>a.use==='Posting').map(a=>[a.code,a]));
  let debits=0,credits=0;const used=new Set();
  const rows=input.lines.map(line=>{
    const account=accounts.get(String(line.code)),dr=cents_(line.debit),cr=cents_(line.credit);
    if (!account || ((dr>0)===(cr>0))) throw Error('Choose a posting account and one debit or credit per line.');
    used.add(account.code); debits+=dr; credits+=cr;
    return [id,date,input.book,memo,account.code,account.name,account.type,dr/100,cr/100,...posted,project,input.editId ? input.key : ''];
  });
  if (used.size<2 || debits!==credits) throw Error('Balance debits and credits across at least two accounts.');
  return rows;
}
function cells_(values) {
  return {values:values.map(value=>({userEnteredValue: typeof value==='number' ? {numberValue:value} : {stringValue:String(value)}}))};
}
// Sequence is shared by both books and starts again on each journal date.
function nextEntryId_(date, existingIds) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw Error('Choose a valid entry date.');
  const prefix=date.slice(2,4)+date.slice(5,7)+'-'+date.slice(8);
  let maximum=0;
  for(const id of existingIds){
    if(!String(id).startsWith(prefix)) continue;
    const match=/^([A-Z]+)(\d{3})$/.exec(String(id).slice(prefix.length));
    if(!match || match[2]==='000') continue;
    let group=0;
    for(const letter of match[1]) group=group*26+letter.charCodeAt(0)-64;
    const position=(group-1)*999+Number(match[2]);
    if(!Number.isSafeInteger(position)) throw Error('Invalid sequence number for '+prefix+'.');
    maximum=Math.max(maximum,position);
  }
  let group=Math.floor(maximum/999)+1, letters='';
  while(group){group--;letters=String.fromCharCode(65+group%26)+letters;group=Math.floor(group/26);}
  return prefix+letters+String(maximum%999+1).padStart(3,'0');
}

function postEntry(input) {
  return lock_(()=>{
    const {sheet,email}=context_(),journal=sheet.getSheetByName('Journal');
    checkLedger_(sheet,input.ledgerId);
    if (!/^[a-f0-9-]{36}$/i.test(String(input.key))) throw Error('Missing posting reference.');
    const rows=rows_(sheet,'Journal',JOURNAL_HEADERS.length);
    const header=journal.getRange(1,13,1,2).getDisplayValues()[0];
    if(header.some((v,i)=>v && v!==JOURNAL_HEADERS[12+i])) throw Error('Journal columns M and N must be Project and Edit request ID.');
    const sheetId=journal.getSheetId(), requests=[];
    const update=(index,column,values)=>({updateCells:{start:{sheetId,rowIndex:index,columnIndex:column},
      rows:values.map(cells_),fields:'userEnteredValue'}});
    if(header.some(v=>!v)) requests.push(update(0,12,[JOURNAL_HEADERS.slice(12)]));
    const edit=!!input.editId;
    const prior=rows.find(row=>String(row[edit?13:11])===input.key);
    if(prior) {
      if(!edit && String(prior[9]).toLowerCase()!==email) throw Error('Posting reference already used.');
      return String(prior[0]);
    }
    const target=edit?String(input.editId):'';
    const positions=[];
    if(edit){
      const group=journalGroups_(rows).get(input.groupKey || ('id:'+target)) || [];
      group.forEach(item=>positions.push(item.number-2));
      if(!positions.length || revision_(positions.map(i=>rows[i]))!==input.revision)
        throw Error('This entry changed in the Sheet or on another device. Close it, refresh and reopen it.');
    }
    const original=rows[positions[0]];
    const sheetPosting=edit && (!original[0] || positions.every(i=>!rows[i][9] && !rows[i][11]));
    const id=(!edit || sheetPosting) ? nextEntryId_(input.date,rows.map(row=>row[0])) : target;
    const posted=edit && !sheetPosting ? [original[9],original[10] instanceof Date ? original[10].toISOString() : original[10],original[11]] :
      [email,new Date().toISOString(),input.key];
    const values=makeLines_(sheet,input,id,posted);
    const common=Math.min(positions.length,values.length);
    for(let i=0;i<common;i++) requests.push(update(positions[i]+1,0,[values[i]]));
    for(let i=common;i<positions.length;i++){
      requests.push({repeatCell:{range:{sheetId,startRowIndex:positions[i]+1,endRowIndex:positions[i]+2,startColumnIndex:0,endColumnIndex:JOURNAL_HEADERS.length},
        cell:{},fields:'userEnteredValue'}});
    }
    if(common<values.length){
      requests.push({appendCells:{sheetId,rows:values.slice(common).map(cells_),fields:'userEnteredValue'}});
    }
    Sheets.Spreadsheets.batchUpdate({requests},sheet.getId());
    return id;
  });
}
