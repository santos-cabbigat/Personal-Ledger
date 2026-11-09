function ledgerId_() {
  const properties = PropertiesService.getScriptProperties();
  const id = properties.getProperty('LEDGER_ID');
  if (!id) throw Error('The owner must initialize this spreadsheet from its Ledger menu first.');
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
function context_() {
  const email = Session.getActiveUser().getEmail().toLowerCase();
  if (!email || email !== Session.getEffectiveUser().getEmail().toLowerCase()) throw Error('Open the ledger while signed in with your invited Google account.');
  const sheet = SpreadsheetApp.openById(ledgerId_());
  const owner = sheet.getOwner().getEmail().toLowerCase();
  return { sheet, email, owner };
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
function state() {
  const {sheet,email,owner} = context_();
  const entries=rows_(sheet,'Journal',12).filter(r=>r[0]).map(r=>({id:String(r[0]),date:date_(r[1]),book:String(r[2]),memo:String(r[3]),code:String(r[4]),name:String(r[5]),type:String(r[6]),debit:Number(r[7]||0),credit:Number(r[8]||0),by:String(r[9])}));
  return {title:sheet.getSheetByName('Settings').getRange('B2').getDisplayValue(), url:sheet.getUrl(),email,owner:email===owner,accounts:accounts_(sheet),entries,today:date_(new Date())};
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
function saveAccount(input) {
  return lock_(()=>{
    const {sheet}=context_(), accounts=accounts_(sheet);
    const code=String(input.code||'').trim(), name=text_(input.name,80),parent=String(input.parent||'');
    if(!/^[1-9]\d{1,9}$/.test(code)||accounts.some(a=>a.code===code)) throw Error('Use a new numeric code (2–10 digits).');
    if(!TYPES.includes(input.type)||!['Group','Posting'].includes(input.use)) throw Error('Choose a valid classification and use.');
    if(parent && !accounts.some(a=>a.code===parent&&a.type===input.type&&a.use==='Group')) throw Error('Choose a parent group of the same classification.');
    sheet.getSheetByName('Accounts').appendRow([code,name,input.type,parent,input.use]);
    return code;
  });
}
function renameLedger(name) {
  return lock_(()=>{
    const {sheet,email,owner}=context_(); if(email!==owner) throw Error('Only the owner can change the app name.');
    const title=text_(name,60); sheet.getSheetByName('Settings').getRange('B2').setValue(title); sheet.getSheetByName('Overview').getRange('A1').setValue(title); return title;
  });
}
function postEntry(input) {
  return lock_(()=>{
    const {sheet,email}=context_(), journal=sheet.getSheetByName('Journal');
    const token=String(input.key||'');
    if(!/^[a-f0-9-]{36}$/i.test(token)) throw Error('Missing posting reference.');
    const existing=journal.getLastRow()>1 && journal.getRange(2,12,journal.getLastRow()-1,1).createTextFinder(token).matchEntireCell(true).findNext();
    if(existing) {
      const row=journal.getRange(existing.getRow(),1,1,10).getValues()[0];
      if(String(row[9]).toLowerCase()!==email) throw Error('Posting reference already used.');
      return String(row[0]);
    }
    if(!BOOKS.includes(input.book)) throw Error('Choose Personal or Business.');
    const date=String(input.date||'');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date) throw Error('Choose a valid date.');
    const memo=text_(input.memo,180);
    if(!Array.isArray(input.lines)||input.lines.length<2||input.lines.length>40) throw Error('Use 2–40 journal lines.');
    const accounts=new Map(accounts_(sheet).filter(a=>a.use==='Posting').map(a=>[a.code,a]));
    let debits=0,credits=0;const used=new Set();
    const id='J-'+Utilities.getUuid(),stamp=new Date().toISOString();
    const data=input.lines.map(line=>{
      const a=accounts.get(String(line.code)),dr=cents_(line.debit),cr=cents_(line.credit);
      if(!a||((dr>0)===(cr>0))) throw Error('Each line needs a posting account and one debit or credit.');
      used.add(a.code);debits+=dr;credits+=cr;
      return [id,date,input.book,memo,a.code,a.name,a.type,dr/100,cr/100,email,stamp,token];
    });
    if(used.size<2||debits!==credits) throw Error('Use at least two different accounts and balance debits and credits.');
    journal.getRange(journal.getLastRow()+1,1,data.length,12).setValues(data);
    return id;
  });
}
