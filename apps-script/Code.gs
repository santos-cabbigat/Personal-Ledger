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
const DEFAULT_BOOKS = ['Personal','Business'];
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Ledger').addItem('Initialize ledger','initializeLedger').addItem('Open ledger','openLedger').addItem('Post selected journal entry','postSelectedJournalEntry').addToUi();
}
function openLedger() {
  SpreadsheetApp.getUi().showSidebar(page_(SpreadsheetApp.getActiveSpreadsheet()).setTitle('Ledger'));
}
function doGet() { return page_(); }
function page_(activeSheet) {
  const html=HtmlService.createHtmlOutputFromFile('Index');
  // Load the signed-in user's initial view in the same invocation that serves the page.
  // Refreshes and edits still read the live workbook.
  let initial;
  try { initial=activeSheet ? workbookState_(activeSheet,signedIn_()) : state(); }
  catch(error) { initial={loadError:String(error.message||error)}; }
  const encoded=JSON.stringify(initial).replace(/</g,'\\u003c');
  html.setContent(html.getContent().replace('<!--ledger-state-->',()=>'<script type="application/json" id="initialLedger">'+encoded+'</script>'));
  return html.setTitle('Shared ledger').addMetaTag('viewport','width=device-width, initial-scale=1, viewport-fit=cover');
}
const LEDGER_NAME = 'Personal & Business Ledger';
const JOURNAL_HEADERS = ['Entry ID','Date','Book','Description','Account code','Account name','Type','Debit (LAK)','Credit (LAK)','Posted by','Posted at','Request ID','Project','Edit request ID','Category'];
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
  if(sheet.getSheetByName('Settings').getRange('F1').getDisplayValue()!=='Book types')setupBookPickers_(sheet);
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
function bookNames_(sheet) {
  const tab=sheet.getSheetByName('Settings');
  if(tab.getRange('F1').getDisplayValue()!=='Book types')return DEFAULT_BOOKS.slice();
  const count=Math.max(1,tab.getLastRow()-1);
  return [...new Set(tab.getRange(2,6,count,1).getDisplayValues().flat().map(name=>name.trim()).filter(Boolean))];
}
function saveBookType(name,ledgerId) {
  return lock_(()=>{
    const {sheet}=context_();
    checkLedger_(sheet,ledgerId);
    const book=text_(name,80),settings=sheet.getSheetByName('Settings');
    if(settings.getRange('F1').getDisplayValue()!=='Book types')setupBookPickers_(sheet);
    const names=bookNames_(sheet);
    const existing=names.find(value=>value.toLowerCase()===book.toLowerCase());
    if(existing)return existing;
    const range=settings.getRange(2,6,Math.max(1,settings.getLastRow()-1),1);
    const values=range.getDisplayValues();
    const count=values.reduce((last,row,index)=>row[0] ? index+1 : last,0);
    if(count+2>settings.getMaxRows())settings.insertRowAfter(settings.getMaxRows());
    settings.getRange(count+2,6).setValue(book);
    return book;
  });
}
function bookPickerRequests_(journalId,settingsId,seedBooks){
  const requests=[];
  function put(sheetId,rowIndex,columnIndex,values){
    requests.push({updateCells:{start:{sheetId,rowIndex,columnIndex},rows:values.map(row=>({values:row.map(value=>({
      userEnteredValue:value.startsWith('=')?{formulaValue:value}:{stringValue:value}
    }))})),fields:'userEnteredValue'}});
  }
  put(settingsId,0,5,[['Book types','Posted entry IDs','Projects','Categories']]);
  if(seedBooks)put(settingsId,1,5,DEFAULT_BOOKS.map(name=>[name]));
  const distinct=col=>'=IFERROR(SORT(UNIQUE(FILTER(Journal!'+col+'2:'+col+',Journal!'+col+'2:'+col+'<>""))),"")';
  const postedIds='=IFERROR(SORT(UNIQUE(FILTER(Journal!A2:A,Journal!A2:A<>"",((Journal!J2:J<>"")+(Journal!L2:L<>""))>0))),"")';
  put(settingsId,1,6,[[postedIds,distinct('M'),distinct('O')]]);
  put(journalId,0,14,[['Category','Find entry ID','Journal row']]);
  put(journalId,1,16,[['=IF(P2="","",IFERROR(HYPERLINK("#gid='+journalId+'&range=A"&MATCH(P2,A:A,0),"Open row "&MATCH(P2,A:A,0)),""))']]);
  function dropdown(col,source,help,endRowIndex,strict){
    const range={sheetId:journalId,startColumnIndex:col,endColumnIndex:col+1,startRowIndex:1};
    if(endRowIndex)range.endRowIndex=endRowIndex;
    requests.push({setDataValidation:{range,rule:{condition:{type:'ONE_OF_RANGE',values:[{userEnteredValue:'=Settings!$'+source+'$2:$'+source}]},inputMessage:help,showCustomUi:true,strict}}});
  }
  dropdown(2,'F','Choose a book. Add book names in Settings column F.',null,true);
  dropdown(12,'H','Choose a project or type a new name.',null,false);
  dropdown(14,'I','Choose a category or type a new name.',null,false);
  dropdown(15,'G','Select an existing entry to find its rows.',2,true);
  return requests;
}
function setupBookPickers_(sheet){
  const journal=sheet.getSheetByName('Journal'),settings=sheet.getSheetByName('Settings');
  const current=settings.getRange('F1:I1').getDisplayValues()[0];
  const labels=['Book types','Posted entry IDs','Projects','Categories'];
  const target=journal.getRange('O1:Q1').getDisplayValues()[0];
  if(current.some((name,i)=>name && name!==labels[i]) || target.some((name,i)=>name && name!==['Category','Find entry ID','Journal row'][i]))
    throw Error('The ledger needs empty or matching headers in Settings F:I and Journal O:Q.');
  const seed=!current[0] && settings.getRange('F2:F3').isBlank();
  Sheets.Spreadsheets.batchUpdate({requests:bookPickerRequests_(journal.getSheetId(),settings.getSheetId(),seed)},sheet.getId());
}
function journalRules_(journalId,settingsId,firstBlank,rowCount) {
  const requests=[];
  const cells=(col,first=1,end=rowCount)=>({sheetId:journalId,startRowIndex:first,endRowIndex:end,startColumnIndex:col,endColumnIndex:col+1});
  const field=(range,cell,fields)=>requests.push({repeatCell:{range,cell,fields}});
  const settingsRows=[['Posting account codes','Posting account names'],[
    '=IFERROR(FILTER(Accounts!A2:A,Accounts!E2:E="Posting"),"")',
    '=IFERROR(FILTER(Accounts!B2:B,Accounts!E2:E="Posting"),"")'
  ]];
  requests.push({updateCells:{start:{sheetId:settingsId,rowIndex:0,columnIndex:3},rows:settingsRows.map((row,i)=>({values:row.map(value=>({
    userEnteredValue:i?{formulaValue:value}:{stringValue:value}
  }))})),fields:'userEnteredValue'}});
  function rule(col,type,values,help,strict=true){
    const condition={type};
    if(values.length)condition.values=values.map(userEnteredValue=>({userEnteredValue}));
    requests.push({setDataValidation:{range:cells(col),rule:{condition,strict,showCustomUi:true,inputMessage:help}}});
  }
  rule(1,'DATE_IS_VALID',[],'Choose a journal date.');
  rule(4,'ONE_OF_RANGE',["=Settings!$D$2:$D"],'Select a posting account code, or choose its name in column F.',false);
  rule(5,'ONE_OF_RANGE',["=Settings!$E$2:$E"],'Choose a posting account name.',false);
  field(cells(1),{userEnteredFormat:{numberFormat:{type:'DATE',pattern:'yyyy-mm-dd'}}},'userEnteredFormat.numberFormat');
  for(const col of [7,8])field(cells(col),{userEnteredFormat:{numberFormat:{type:'NUMBER',pattern:'#,##0.##'}}},'userEnteredFormat.numberFormat');
  if(firstBlank<rowCount){
    const n=firstBlank+1;
    const code='=IF(F'+n+'="","",IFERROR(INDEX(Accounts!$A$2:$A,MATCH(F'+n+',Accounts!$B$2:$B,0)),""))';
    const type='=IF(E'+n+'="","",IFERROR(INDEX(Accounts!$C$2:$C,MATCH(TO_TEXT(E'+n+'),ARRAYFORMULA(TO_TEXT(Accounts!$A$2:$A)),0)),""))';
    field(cells(4,firstBlank),{userEnteredValue:{formulaValue:code}},'userEnteredValue');
    field(cells(6,firstBlank),{userEnteredValue:{formulaValue:type}},'userEnteredValue');
  }
  field(cells(0,0,1),{note:'Assigned when you post. Select a transaction row and use Ledger → Post selected journal entry, or review and post the draft in the app.'},'note');
  return requests;
}
function setupJournal_(sheet) {
  const journal=sheet.getSheetByName('Journal'), settings=sheet.getSheetByName('Settings');
  const existing=settings.getRange('D1:E2').getDisplayValues()[0];
  if((existing[0] && existing[0]!=='Posting account codes')||(existing[1] && existing[1]!=='Posting account names'))
    throw Error('Settings columns D and E are already in use.');
  const used=rows_(sheet,'Journal',JOURNAL_HEADERS.length);
  const requests=journalRules_(journal.getSheetId(),settings.getSheetId(),used.length+1,journal.getMaxRows());
  Sheets.Spreadsheets.batchUpdate({requests},sheet.getId());
}
// A bound workbook can immediately fill the matching account when either dropdown changes.
function onEdit(e){
  if(!e || !e.range)return;
  const range=e.range, tab=range.getSheet();
  if(tab.getName()!=='Journal' || range.getLastRow()<2 || range.getColumn()>6 || range.getLastColumn()<5)return;
  const chart=accounts_(e.source).filter(a=>a.use==='Posting');
  const first=Math.max(2,range.getRow()),count=range.getLastRow()-first+1;
  const target=tab.getRange(first,5,count,3), values=target.getValues(), formulas=target.getFormulas();
  const editName=range.getColumn()===6,editCode=range.getLastColumn()===5;
  for(let i=0;i<count;i++){
    const [code,name]=values[i],n=first+i;
    if(!code&&!name)continue;
    const matched=editName || (!editCode && !code) ? chart.filter(a=>a.name===String(name)) : chart.filter(a=>a.code===String(code));
    if(matched.length!==1 || (!editName&&!editCode && code && name && matched[0].name!==String(name)))continue;
    const account=matched[0];
    if(editName && !formulas[i][0])tab.getRange(n,5).setValue(account.code);
    if(!editName && String(name)!==account.name)tab.getRange(n,6).setValue(account.name);
    if(!formulas[i][2] && values[i][2]!==account.type)tab.getRange(n,7).setValue(account.type);
  }
}
function postSelectedJournalEntry(){
  const sheet=SpreadsheetApp.getActiveSpreadsheet(), range=sheet.getActiveRange();
  if(range.getSheet().getName()!=='Journal'||range.getRow()<2)throw Error('Select a transaction row in Journal first.');
  const raw=rows_(sheet,'Journal',JOURNAL_HEADERS.length);
  const target=[...journalGroups_(raw)].find(([,items])=>items.some(item=>item.number===range.getRow()));
  if(!target)throw Error('Select a row with a journal entry.');
  const view=journalState_(sheet,accounts_(sheet));
  const lines=view.entries.filter(line=>line.groupKey===target[0]), first=lines[0];
  if(!first)throw Error(view.warnings.find(w=>w.startsWith('Row '+target[1][0].number+' ' ) || w.startsWith('Row '+target[1][0].number+':'))||'Complete both sides of this entry first.');
  if(!first.sheetDraft){sheet.toast('Already posted as '+first.id);return;}
  const email=signedIn_();
  const id=postWithContext_({ledgerId:sheet.getId(),editId:first.id,groupKey:first.groupKey,revision:first.revision,key:Utilities.getUuid(),
    date:first.date,book:first.book,memo:first.memo,project:first.project,category:first.category,lines}, {sheet,email});
  sheet.toast('Posted as '+id);
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
  setupJournal_(sheet);
  setupBookPickers_(sheet);
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
  const rows=count>0 ? tab.getRange(2,1,count,columns).getValues() : [];
  while(rows.length && rows[rows.length-1].every(value=>value==='')) rows.pop();
  return rows;
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
  const tz=sheet.getSpreadsheetTimeZone(),books=bookNames_(sheet);
  const groups=journalGroups_(rows_(sheet,'Journal',JOURNAL_HEADERS.length));
  const entries=[];
  for (const [groupKey,group] of groups) {
    const id=String(group[0].row[0]).trim();
    try {
      const rows=group.map(item=>item.row);
      const shared = index => {
        const values = [...new Set(rows.map(row=>index===1 && typeof row[1]==='number' ? new Date((row[1]-25569)*86400000).toISOString().slice(0,10) : row[index] instanceof Date ?
          Utilities.formatDate(row[index],tz,'yyyy-MM-dd') : String(row[index]??'').trim()).filter(Boolean))];
        if(values.length>1) throw Error('Use the same date, book, description, project and category on the lines of one entry.');
        return values[0] || '';
      };
      const date=shared(1), book=shared(2), memo=shared(3), project=shared(12), category=shared(14);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date || !book || !memo) throw Error('Fill in the date, book and description.');
      if (!books.includes(book) && !rows.some(r=>r[0] && (r[9] || r[11]))) throw Error('Choose a book listed in Settings.');
      let debitCents=0,creditCents=0;
      const version=revision_(rows);
      const lines=rows.map(r=>{
        let code=String(r[4]).trim();
        if(!code && r[5]) { const candidates=accounts.filter(a=>a.use==='Posting' && a.name===String(r[5]));if(candidates.length===1)code=candidates[0].code; }
        const a=chart.get(code);
        if(!id && a && r[5] && a.name!==String(r[5])) throw Error('Account name and code differ. Reselect the account or clear the unused field.');
        if(!a || a.use!=='Posting') throw Error('Choose a posting account code from Accounts.');
        const debit=cents_(r[7]),credit=cents_(r[8]);
        if((debit>0)===(credit>0)) throw Error('Each line needs one debit or credit.');
        debitCents+=debit;creditCents+=credit;
        return {id:id||('Sheet rows '+group[0].number+'–'+group[group.length-1].number),groupKey,date,book,memo,project,category,code,name:String(r[5]||a.name),type:String(r[6]||a.type),
          debit:debit/100,credit:credit/100,by:String(r[9]),sheetDraft:rows.every(item=>!item[9]&&!item[11]),revision:version};
      });
      if (debitCents!==creditCents || new Set(lines.map(l=>l.code)).size<2) throw Error('Balance the debit and credit lines across at least two accounts.');
      entries.push(...lines);
    } catch(error) { warnings.push('Row '+group[0].number+(id?' ('+id+')':'')+': '+error.message); }
  }
  return {entries,warnings};
}
function state() {
  const {sheet,email}=context_(true);
  return sheet ? workbookState_(sheet,email) : {connected:false,email};
}
function workbookState_(sheet,email) {
  const accounts=accounts_(sheet),owner=sheet.getOwner().getEmail().toLowerCase();
  return {connected:true,ledgerId:sheet.getId(),title:sheet.getSheetByName('Settings').getRange('B2').getDisplayValue(),
    url:sheet.getUrl(),email,owner:email===owner,books:bookNames_(sheet),accounts,...journalState_(sheet,accounts),today:date_(new Date())};
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
function makeLines_(sheet,input,id,posted,originalBook) {
  if (!bookNames_(sheet).includes(input.book) && (!originalBook || input.book!==originalBook)) throw Error('Choose a book listed in Settings.');
  const date=String(input.date||'');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0,10)!==date) throw Error('Choose a valid date.');
  const memo=text_(input.memo,180), project=input.project ? text_(input.project,80) : '';
  const category=input.category ? text_(input.category,80) : '';
  if (!Array.isArray(input.lines)||input.lines.length<2||input.lines.length>40) throw Error('Use 2–40 journal lines.');
  const accounts=new Map(accounts_(sheet).filter(a=>a.use==='Posting').map(a=>[a.code,a]));
  let debits=0,credits=0;const used=new Set();
  const rows=input.lines.map(line=>{
    const account=accounts.get(String(line.code)),dr=cents_(line.debit),cr=cents_(line.credit);
    if (!account || ((dr>0)===(cr>0))) throw Error('Choose a posting account and one debit or credit per line.');
    used.add(account.code); debits+=dr; credits+=cr;
    return [id,date,input.book,memo,account.code,account.name,account.type,dr/100,cr/100,...posted,project,input.editId ? input.key : '',category];
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
  return postWithContext_(input,context_());
}
function postWithContext_(input,{sheet,email}) {
  return lock_(()=>{
    const journal=sheet.getSheetByName('Journal');
    checkLedger_(sheet,input.ledgerId);
    if (!/^[a-f0-9-]{36}$/i.test(String(input.key))) throw Error('Missing posting reference.');
    const rows=rows_(sheet,'Journal',JOURNAL_HEADERS.length);
    const header=journal.getRange(1,13,1,3).getDisplayValues()[0];
    if(header.some((v,i)=>v && v!==JOURNAL_HEADERS[12+i])) throw Error('Check the Project, Edit request ID and Category headers in Journal.');
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
    const values=makeLines_(sheet,input,id,posted,edit && !sheetPosting ? original[2] : null);
    // Use a native Sheet date so the calendar and the date validation also work on app posts.
    values.forEach(row=>row[1]=Math.round(Date.parse(input.date)/86400000)+25569);
    const common=Math.min(positions.length,values.length);
    for(let i=0;i<common;i++) requests.push(update(positions[i]+1,0,[values[i]]));
    for(let i=common;i<positions.length;i++){
      requests.push({repeatCell:{range:{sheetId,startRowIndex:positions[i]+1,endRowIndex:positions[i]+2,startColumnIndex:0,endColumnIndex:JOURNAL_HEADERS.length},
        cell:{},fields:'userEnteredValue'}});
    }
    if(common<values.length){
      const extra=values.slice(common);
      const required=rows.length+1+extra.length-journal.getMaxRows();
      if(required>0)requests.push({appendDimension:{sheetId,dimension:'ROWS',length:required}});
      requests.push(update(rows.length+1,0,extra));
    }
    Sheets.Spreadsheets.batchUpdate({requests},sheet.getId());
    return id;
  });
}
