function ledgerId_() {
  const properties = PropertiesService.getScriptProperties();
  const id = properties.getProperty('LEDGER_ID');

  return id;
}
function initializeLedger() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!sheet || sheet.getOwner().getEmail() !== Session.getEffectiveUser().getEmail()) throw Error('Only the spreadsheet owner may initialize the ledger.');
  if (!['Settings','Overview','Accounts'].every(name=>sheet.getSheetByName(name)) || (!sheet.getSheetByName('Journal') && !bookTabs_(sheet).length)) throw Error('Open the prepared ledger workbook.');
  PropertiesService.getScriptProperties().setProperty('LEDGER_ID', sheet.getId());
  openLedger();
}
const TYPES = ['Asset','Liability','Equity','Income','Expense'];
const DEFAULT_BOOKS = ['Personal','Business'];
const PERSONAL_SITE_='https://santos-cabbigat.github.io/Personal-Ledger/';
function archivedWorkbook_(sheet){
  const id=PropertiesService.getScriptProperties().getProperty('PERSONAL_LIVE_WORKBOOK');
  return Boolean(id && sheet && sheet.getId()===id);
}
function liveLedgerLink_(){
  return HtmlService.createHtmlOutput('<p>This workbook is the daily ledger archive.</p><p><a target="_blank" rel="noopener" href="'+PERSONAL_SITE_+'">Open Personal Ledger</a></p>');
}
function onOpen() {
  if(archivedWorkbook_(SpreadsheetApp.getActiveSpreadsheet())){
    SpreadsheetApp.getUi().createMenu('Ledger').addItem('Open Personal Ledger','openLedger').addToUi();
    return;
  }
  SpreadsheetApp.getUi().createMenu('Ledger').addItem('Initialize ledger','initializeLedger').addItem('Open ledger','openLedger').addItem('Monthly financial report','openMonthlyFinancialReport').addItem('Enable my Sheet posting','enableMySheetPosting').addItem('Post selected journal entry','postSelectedJournalEntry').addToUi();
}
function openLedger() {
  if(archivedWorkbook_(SpreadsheetApp.getActiveSpreadsheet())){
    SpreadsheetApp.getUi().showSidebar(liveLedgerLink_().setTitle('Personal Ledger'));
    return;
  }
  rememberSheetPoster_();
  SpreadsheetApp.getUi().showSidebar(page_(SpreadsheetApp.getActiveSpreadsheet()).setTitle('Ledger'));
}
function openMonthlyFinancialReport(){
  const sheet=SpreadsheetApp.getActiveSpreadsheet();
  SpreadsheetApp.getUi().showModalDialog(page_(sheet,true).setWidth(710).setHeight(750),'Monthly financial report');
}
function doGet(e) { return e?.parameter?.ledgerSession ? browserSession_(e.parameter.ledgerSession) : page_(); }
function page_(activeSheet,openReport) {
  const source=HtmlService.createHtmlOutputFromFile('Index').getContent();
  // Load the signed-in user's initial view in the same invocation that serves the page.
  // Refreshes and edits still read the live workbook.
  let initial;
  try { initial=activeSheet ? workbookState_(SpreadsheetApp.openById(activeSheet.getId()),signedIn_()) : state(); }
  catch(error) { initial={loadError:String(error.message||error)}; }
  const encoded=JSON.stringify(initial).replace(/</g,'\\u003c');
  const content=source.replace('const serverLedger = null;',()=> 'const serverLedger = '+encoded+';')
    .replace('const showMonthOnOpen = false;',()=> 'const showMonthOnOpen = '+Boolean(openReport)+';');
  const html=HtmlService.createHtmlOutput(content);
  return html.setTitle('Shared ledger').addMetaTag('viewport','width=device-width, initial-scale=1, viewport-fit=cover');
}
const LEDGER_NAME = 'Personal & Business Ledger';
const JOURNAL_HEADERS = ['Entry ID','Date','Book','Description','Account code','Account name','Type','Debit (LAK)','Credit (LAK)','Posted by','Posted at','Request ID','Project','Edit request ID','Category'];
// Journal columns P and Q are an ID lookup. R stores an external receipt or bank reference.
const REFERENCE_COLUMN = 18;
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
    if(name==='Journal' && !tab && bookTabs_(sheet).length) continue;
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
  if(sheet.getSheetByName('Journal') && sheet.getSheetByName('Settings').getRange('F1').getDisplayValue()!=='Book types')setupBookPickers_(sheet);
  ensureJournalPresentation_(sheet);
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
const BOOK_TAB_HEADERS=['Entry ID','Date','Reference','Account code','Account name','Type','Description','Debit (LAK)','Credit (LAK)','Posted by','Posted at','Request ID','Project','Edit request ID','Category','Find entry ID','Journal row','Draft running balance'];
function bookTabs_(sheet){
  return sheet.getSheets().filter(tab=>{
    if(['Overview','Settings','Accounts','Journal'].includes(tab.getName()))return false;
    const h=tab.getRange('A1:C1').getDisplayValues()[0];
    return h[0]==='Entry ID'&&h[1]==='Date'&&h[2]==='Reference';
  });
}
function validTabName_(name){
  if(!name || name.length>80 || /[:\\/\?\*\[\]]/.test(name) || ['overview','settings','accounts','journal','general ledger','trial balance','monthly report','report data'].includes(name.toLowerCase()))
    throw Error('Use a unique book name suitable for a Sheet tab, up to 80 characters.');
}
function formatBookJournal_(sheet,tab,fresh){
  const settings=sheet.getSheetByName('Settings'),n=tab.getMaxRows()-1;
  if(fresh){
    tab.getRange(1,1,1,BOOK_TAB_HEADERS.length).setValues([BOOK_TAB_HEADERS]).setFontWeight('bold').setBackground('#254566').setFontColor('#ffffff');
    tab.setFrozenRows(1);
    tab.setColumnWidth(1,126);tab.setColumnWidth(2,110);tab.setColumnWidth(3,175);tab.setColumnWidth(5,180);tab.setColumnWidth(7,255);
    tab.getRange(2,2,n,1).setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build());
    for(const [col,source] of [[4,'D2:D'],[5,'E2:E'],[13,'H2:H'],[15,'I2:I']]){
      tab.getRange(2,col,n,1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(settings.getRange(source),true).setAllowInvalid(true).build());
    }
    tab.getRange(2,8,n,2).setNumberFormat('#,##0.##');
    const formulas=Array.from({length:n},(_,i)=>{const r=i+2;return [
      '=IF(E'+r+'="","",IFERROR(INDEX(Accounts!$A$2:$A,MATCH(E'+r+',Accounts!$B$2:$B,0)),""))',
      '=IF(D'+r+'="","",IFERROR(INDEX(Accounts!$C$2:$C,MATCH(TO_TEXT(D'+r+'),ARRAYFORMULA(TO_TEXT(Accounts!$A$2:$A)),0)),""))'
    ];});
    tab.getRange(2,4,n,1).setFormulas(formulas.map(row=>[row[0]]));
    tab.getRange(2,6,n,1).setFormulas(formulas.map(row=>[row[1]]));
  }
  tab.getRange('A1:O1').setBackground('#191e38').setFontColor('#f5f2ff').setFontWeight('bold');
  tab.getRange('B2:B').setNumberFormat('dd-mmm-yyyy');
  tab.getRange('A1').setNote('Choose an account to start an entry. The same ID continues until the entry balances.');
  tab.getRange('R1').setValue('Draft running balance');
  tab.getRange('C2:C').setNumberFormat('@');tab.hideColumns(18);
  tab.getRange('P2').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(tab.getRange('A2:A'),true).setAllowInvalid(false).build());
  tab.getRange('Q2').setFormula('=IF(P2="","",IFERROR(HYPERLINK("#gid='+tab.getSheetId()+'&range=A"&MATCH(P2,A:A,0),"Open row "&MATCH(P2,A:A,0)),""))');
  tab.getRange('R2').setFormula('=SCAN(0,SEQUENCE(ROWS(A2:A),1,2),LAMBDA(b,rnum,IF(OR(INDEX(A:A,rnum)<>"",AND(INDEX(B:B,rnum)="",INDEX(C:C,rnum)="",INDEX(D:D,rnum)="",INDEX(E:E,rnum)="",INDEX(G:G,rnum)="",INDEX(H:H,rnum)="",INDEX(I:I,rnum)="")),0,ROUND(b+N(INDEX(H:H,rnum))-N(INDEX(I:I,rnum)),2))))');
  const occupied=n=>'OR('+['A','B','C','D','E','G','H','I'].map(col=>'$'+col+n+'<>""').join(',')+')';
  const starts='=AND('+occupied(2)+',OR(ROW()=2,$A2<>$A1,AND($A2="",OR(NOT('+occupied(1)+'),AND($R1=0,OR(N($H1)>0,N($I1)>0))))))';
  const next='=AND(NOT('+occupied(2)+'),OR(ROW()=2,AND($A1<>"",COUNTIF($A$2:$A,$A1)>=2,SUMIF($A$2:$A,$A1,$H$2:$H)>0,ROUND(SUMIF($A$2:$A,$A1,$H$2:$H)-SUMIF($A$2:$A,$A1,$I$2:$I),2)=0),AND($A1="",$R1=0,OR(N($H1)>0,N($I1)>0))))';
  const ranges=[tab.getRange('A2:O')];
  const rule=(formula,color)=>SpreadsheetApp.newConditionalFormatRule().whenFormulaSatisfied(formula).setBackground(color).setRanges(ranges);
  const others=tab.getConditionalFormatRules().filter(r=>!String(r.getBooleanCondition()?.getCriteriaValues()[0]||'').includes('ROW()=2'));
  tab.setConditionalFormatRules([rule(starts,'#e8e1fa').setBold(true).build(),rule(next,'#d4f4f3').build(),...others]);
}
function syncBookTabs_(sheet){
  const known=bookNames_(sheet);
  for(const name of known){
    validTabName_(name);
    let tab=sheet.getSheetByName(name);
    if(!tab){tab=sheet.insertSheet(name);formatBookJournal_(sheet,tab,true);if(sheet.getSheetByName('Report Data'))configureBookChart_(tab);}
    else if(tab.getRange('A1').getDisplayValue()!=='Entry ID'){
      if(tab.getRange('A1:R1').isBlank() && tab.getLastRow()===0)formatBookJournal_(sheet,tab,true);
      else throw Error('The tab named '+name+' is already used for something else.');
    }
  }
  const names=bookTabs_(sheet).map(t=>t.getName());
  if(!names.length)return;
  const distinct=col=>{
    const stack='VSTACK('+names.map(name=>"'"+name.replace(/'/g,"''")+"'!"+col+'2:'+col).join(',')+')';
    return '=IFERROR(LET(values,'+stack+',SORT(UNIQUE(FILTER(values,values<>"")))),"")';
  };
  sheet.getSheetByName('Settings').getRange('G2:I2').setFormulas([[distinct('A'),distinct('M'),distinct('O')]]);
  if(sheet.getSheetByName('Report Data'))refreshReportSource_(sheet);
}
function useProjectOneJournal(){
  const sheet=SpreadsheetApp.getActiveSpreadsheet();
  if(sheet.getOwner().getEmail().toLowerCase()!==signedIn_())throw Error('Only the owner can migrate the workbook.');
  lock_(()=>migrateSingleBook_(sheet,sheet.getSheetByName('Journal')?'Project 1':primaryBookName_(sheet)));
  rememberSheetPoster_();
}
function migrateSingleBook_(sheet,name){
  const old=sheet.getSheetByName('Journal');
  if(old){
    if(sheet.getSheetByName(name))throw Error('A tab with the destination name already exists.');
    const books=new Set(journalRows_(sheet).map(r=>r[2]).filter(Boolean));
    if([...books].some(b=>b!==name))throw Error('There are entries from another book in the Journal. Separate those entries before migrating.');
    Sheets.Spreadsheets.batchUpdate({requests:[
      {updateSheetProperties:{properties:{sheetId:old.getSheetId(),title:name},fields:'title'}},
      {deleteDimension:{range:{sheetId:old.getSheetId(),dimension:'COLUMNS',startIndex:2,endIndex:3}}}
    ]},sheet.getId());
  }
  // Read fresh server state after a Sheets API structural change.
  const fresh=SpreadsheetApp.openById(sheet.getId()),primary=fresh.getSheetByName(name);
  if(!primary)throw Error('Could not re-open the renamed book tab.');
  // An untouched older Journal has Description in C and Reference in Q after removing Book.
  // Move whole columns so amounts, formulas, validation and cell notes stay attached.
  if(primary.getRange('C1').getDisplayValue()==='Description' && primary.getRange('Q1').getDisplayValue()==='Reference'){
    primary.moveColumns(primary.getRange('Q:Q'),3);
    primary.moveColumns(primary.getRange('D:D'),8);
  }
  if(JSON.stringify(primary.getRange('A1:R1').getDisplayValues()[0])!==JSON.stringify(BOOK_TAB_HEADERS))
    throw Error('Check the book headers before migrating.');
  formatBookJournal_(fresh,primary,false);
  syncBookTabs_(fresh);
  fresh.setActiveSheet(primary);
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
    validTabName_(book);
    const names=bookNames_(sheet);
    const existing=names.find(value=>value.toLowerCase()===book.toLowerCase());
    if(existing){if(!sheet.getSheetByName('Journal'))syncBookTabs_(sheet);return existing;}
    const range=settings.getRange(2,6,Math.max(1,settings.getLastRow()-1),1);
    const values=range.getDisplayValues();
    const count=values.reduce((last,row,index)=>row[0] ? index+1 : last,0);
    if(count+2>settings.getMaxRows())settings.insertRowAfter(settings.getMaxRows());
    settings.getRange(count+2,6).setValue(book);
    if(!sheet.getSheetByName('Journal'))syncBookTabs_(sheet);
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
  put(settingsId,0,5,[['Book types','Journal entry IDs','Projects','Categories']]);
  if(seedBooks)put(settingsId,1,5,DEFAULT_BOOKS.map(name=>[name]));
  const distinct=col=>'=IFERROR(SORT(UNIQUE(FILTER(Journal!'+col+'2:'+col+',Journal!'+col+'2:'+col+'<>""))),"")';
  put(settingsId,1,6,[[distinct('A'),distinct('M'),distinct('O')]]);
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
  const labels=['Book types','Journal entry IDs','Projects','Categories'];
  const target=journal.getRange('O1:Q1').getDisplayValues()[0];
  if(current.some((name,i)=>name && name!==labels[i] && !(i===1 && name==='Posted entry IDs')) || target.some((name,i)=>name && name!==['Category','Find entry ID','Journal row'][i]))
    throw Error('The ledger needs empty or matching headers in Settings F:I and Journal O:Q.');
  const seed=!current[0] && settings.getRange('F2:F3').isBlank();
  Sheets.Spreadsheets.batchUpdate({requests:bookPickerRequests_(journal.getSheetId(),settings.getSheetId(),seed)},sheet.getId());
}
function journalPresentationRequests_(sheetId) {
  const rowHasData=c=>['A','B','C','D','E','F','H','I','R'].map(col=>'$'+col+c+'<>""').join(',');
  const emptyRow=['B','C','D','E','F','H','I','R'].map(col=>'INDEX('+col+':'+col+',rownum)=""').join(',');
  const running='=SCAN(0,SEQUENCE(ROWS(A2:A),1,2),LAMBDA(b,rownum,IF(OR(INDEX(A:A,rownum)<>"",AND('+emptyRow+')),0,ROUND(b+N(INDEX(H:H,rownum))-N(INDEX(I:I,rownum)),2))))';
  const starts='=AND(OR('+rowHasData(2)+'),OR(ROW()=2,$A2<>$A1,AND($A2="",OR(NOT(OR('+rowHasData(1)+')),AND($S1=0,OR(N($H1)>0,N($I1)>0))))))';
  const next='=AND(NOT(OR('+rowHasData(2)+')),OR(ROW()=2,AND($A1<>"",COUNTIF($A$2:$A,$A1)>=2,SUMIF($A$2:$A,$A1,$H$2:$H)>0,ROUND(SUMIF($A$2:$A,$A1,$H$2:$H)-SUMIF($A$2:$A,$A1,$I$2:$I),2)=0),AND($A1="",$S1=0,OR(N($H1)>0,N($I1)>0))))';
  const ranges=[{sheetId,startRowIndex:1,startColumnIndex:0,endColumnIndex:15},{sheetId,startRowIndex:1,startColumnIndex:17,endColumnIndex:18}];
  return [
    {updateCells:{start:{sheetId,rowIndex:0,columnIndex:17},rows:[{values:[
      {userEnteredValue:{stringValue:'Reference'},note:'Optional receipt or bank transfer number. Each journal line can have its own reference.'},
      {userEnteredValue:{stringValue:'Draft running balance'}}]}],fields:'userEnteredValue,note'}},
    {updateCells:{start:{sheetId,rowIndex:1,columnIndex:18},rows:[{values:[{userEnteredValue:{formulaValue:running}}]}],fields:'userEnteredValue'}},
    {repeatCell:{range:{sheetId,startRowIndex:1,startColumnIndex:17,endColumnIndex:18},cell:{userEnteredFormat:{numberFormat:{type:'TEXT'}}},fields:'userEnteredFormat.numberFormat'}},
    {updateDimensionProperties:{range:{sheetId,dimension:'COLUMNS',startIndex:18,endIndex:19},properties:{hiddenByUser:true},fields:'hiddenByUser'}},
    {updateDimensionProperties:{range:{sheetId,dimension:'COLUMNS',startIndex:17,endIndex:18},properties:{pixelSize:170},fields:'pixelSize'}},
    {addConditionalFormatRule:{index:0,rule:{ranges,booleanRule:{condition:{type:'CUSTOM_FORMULA',values:[{userEnteredValue:starts}]},format:{backgroundColor:{red:0.78,green:0.88,blue:0.96},textFormat:{bold:true}}}}}},
    {addConditionalFormatRule:{index:1,rule:{ranges,booleanRule:{condition:{type:'CUSTOM_FORMULA',values:[{userEnteredValue:next}]},format:{backgroundColor:{red:1,green:0.94,blue:0.71}}}}}}
  ];
}
function ensureJournalPresentation_(sheet) {
  const journal=sheet.getSheetByName('Journal');
  if(!journal)return;
  const labels=journal.getRange('R1:S1').getDisplayValues()[0];
  if(labels[0]==='Reference' && labels[1]==='Draft running balance')return;
  if(!journal.getRange('R:S').isBlank())throw Error('Columns R and S are already in use. Check them before adding Reference.');
  const requests=journalPresentationRequests_(journal.getSheetId());
  Sheets.Spreadsheets.batchUpdate({requests},sheet.getId());
}
function journalRows_(sheet,bookTab) {
  if(bookTab){
    const count=bookTab.getLastRow()-1,bookName=bookTab.getName();
    const values=count>0 ? bookTab.getRange(2,1,count,17).getValues() : [];
    const rows=values.map(r=>{
      const cells=[r[0],r[1],'',r[6],r[3],r[4],r[5],...r.slice(7,15),r[2]];
      if(cells.some(v=>v!=='' && v!=null))cells[2]=bookName;
      return cells;
    });
    while(rows.length && rows[rows.length-1].every(v=>v===''))rows.pop();
    return rows;
  }
  if(!sheet.getSheetByName('Journal'))return bookTabs_(sheet).flatMap(tab=>journalRows_(sheet,tab));

  // Ignore the search controls in P/Q even if someone is using the ID picker.
  const rows=rows_(sheet,'Journal',REFERENCE_COLUMN).map(row=>[...row.slice(0,15),row[17]??'']);
  while(rows.length && rows[rows.length-1].every(value=>value===''))rows.pop();
  return rows;
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
  field(cells(1),{userEnteredFormat:{numberFormat:{type:'DATE',pattern:'dd-mmm-yyyy'}}},'userEnteredFormat.numberFormat');
  for(const col of [7,8])field(cells(col),{userEnteredFormat:{numberFormat:{type:'NUMBER',pattern:'#,##0.##'}}},'userEnteredFormat.numberFormat');
  if(firstBlank<rowCount){
    const n=firstBlank+1;
    const code='=IF(F'+n+'="","",IFERROR(INDEX(Accounts!$A$2:$A,MATCH(F'+n+',Accounts!$B$2:$B,0)),""))';
    const type='=IF(E'+n+'="","",IFERROR(INDEX(Accounts!$C$2:$C,MATCH(TO_TEXT(E'+n+'),ARRAYFORMULA(TO_TEXT(Accounts!$A$2:$A)),0)),""))';
    field(cells(4,firstBlank),{userEnteredValue:{formulaValue:code}},'userEnteredValue');
    field(cells(6,firstBlank),{userEnteredValue:{formulaValue:type}},'userEnteredValue');
  }
  field(cells(0,0,1),{note:'Choose an account to start an ID. Each line uses the same ID until the entry balances. Posting records your Gmail and time.'},'note');
  return requests;
}
function setupJournal_(sheet) {
  const journal=sheet.getSheetByName('Journal'), settings=sheet.getSheetByName('Settings');
  const existing=settings.getRange('D1:E2').getDisplayValues()[0];
  if((existing[0] && existing[0]!=='Posting account codes')||(existing[1] && existing[1]!=='Posting account names'))
    throw Error('Settings columns D and E are already in use.');
  const used=journalRows_(sheet);
  const requests=journalRules_(journal.getSheetId(),settings.getSheetId(),used.length+1,journal.getMaxRows());
  Sheets.Spreadsheets.batchUpdate({requests},sheet.getId());
}
// A bound workbook can immediately fill the matching account when either dropdown changes.
function fillEditedAccount_(e,chart,shift=0){
  const range=e.range, tab=range.getSheet();
  if(range.getLastRow()<2 || range.getColumn()>6-shift || range.getLastColumn()<5-shift)return;
  const first=Math.max(2,range.getRow()),count=range.getLastRow()-first+1;
  const target=tab.getRange(first,5-shift,count,3), values=target.getValues(), formulas=target.getFormulas();
  const editName=range.getColumn()===6-shift,editCode=range.getLastColumn()===5-shift;
  for(let i=0;i<count;i++){
    const [code,name]=values[i],n=first+i;
    if(!code&&!name)continue;
    const matched=editName || (!editCode && !code) ? chart.filter(a=>a.name===String(name)) : chart.filter(a=>a.code===String(code));
    if(matched.length!==1 || (!editName&&!editCode && code && name && matched[0].name!==String(name)))continue;
    const account=matched[0];
    if(editName && !formulas[i][0])tab.getRange(n,5-shift).setValue(account.sheetCode??account.code);
    if(!editName && String(name)!==account.name)tab.getRange(n,6-shift).setValue(account.name);
    if(!formulas[i][2] && values[i][2]!==account.type)tab.getRange(n,7-shift).setValue(account.type);
  }
}
function rememberSheetPoster_(){
  const email=signedIn_(), key=Session.getTemporaryActiveUserKey();
  if(key)PropertiesService.getUserProperties().setProperty('SHEET_POSTER',JSON.stringify({key,email}));
  return email;
}
function enableMySheetPosting(){
  const email=rememberSheetPoster_();
  SpreadsheetApp.getActiveSpreadsheet().toast('Automatic Sheet posting enabled for '+email);
}
function sheetEditorEmail_(event){
  try{
    const email=event.user && event.user.getEmail();
    if(email)return email.toLowerCase();
  }catch(error){}
  try{
    const email=Session.getActiveUser().getEmail();
    if(email)return email.toLowerCase();
    const record=JSON.parse(PropertiesService.getUserProperties().getProperty('SHEET_POSTER')||'null');
    if(record && record.key && record.key===Session.getTemporaryActiveUserKey())return record.email;
  }catch(error){}
  return '';
}
function onEdit(e){
  if(!e || !e.range || archivedWorkbook_(e.source))return;
  const range=e.range,tab=range.getSheet(),firstCol=range.getColumn(),lastCol=range.getLastColumn();
  if(tab.getName()==='Settings' && firstCol<=6 && lastCol>=6 && range.getLastRow()>=2 && !e.source.getSheetByName('Journal')){
    lock_(()=>syncBookTabs_(e.source));return;
  }
  const dedicated=tab.getName()!=='Journal';
  if(dedicated && (['Settings','Overview','Accounts'].includes(tab.getName()) || tab.getRange('C1').getDisplayValue()!=='Reference'))return;
  const shift=dedicated?1:0;
  if(range.getLastRow()<2 || !(dedicated?[1,2,3,4,5,6,7,8,9,13,15]:[1,2,3,4,5,6,7,8,9,13,15,18]).some(c=>firstCol<=c && lastCol>=c))return;
  lock_(()=>{
    const chart=accounts_(e.source).filter(a=>a.use==='Posting' && (!dedicated || accountInBook_(a,tab.getName())));
    const refCol=dedicated?3:18;
    if(firstCol<=refCol && lastCol>=refCol){
      const start=Math.max(2,range.getRow()), count=range.getLastRow()-start+1;
      const refs=tab.getRange(start,refCol,count,1), values=refs.getValues(), formulas=refs.getFormulas();
      values.forEach(([value],i)=>{
        if(typeof value==='string' && !formulas[i][0] && value!==value.toUpperCase())
          tab.getRange(start+i,refCol).setRichTextValue(SpreadsheetApp.newRichTextValue().setText(value.toUpperCase()).build());
      });
    }
    if(firstCol<=6-shift && lastCol>=5-shift)fillEditedAccount_(e,chart,shift);
    SpreadsheetApp.flush();
    const rows=journalRows_(e.source,dedicated?tab:null), first=Math.max(0,range.getRow()-2), last=range.getLastRow()-2;
    const otherIds=dedicated ? bookTabs_(e.source).filter(t=>t.getSheetId()!==tab.getSheetId()).flatMap(t=>journalRows_(e.source,t).map(r=>r[0])).filter(Boolean) : [];
    const groups=sheetEntryPlan_(rows,chart,first,last,e.source.getSpreadsheetTimeZone(),date_(new Date()),otherIds);
    if(!groups.length)return;
    const books=bookNames_(e.source),email=sheetEditorEmail_(e);
    for(const group of groups){
      const {id,start,end,date,changes}=group;
      for(const change of changes){
        const n=change.index+2;
        if(change.id){tab.getRange(n,1).setValue(id);tab.getRange(n,14).setValue('auto:'+id);}
        if(change.date)tab.getRange(n,2).setValue(Math.round(Date.parse(date)/86400000)+25569);
      }
      if(group.backfillOnly || !group.balanced || !group.validId || !group.book || !books.includes(group.book) || !group.hasMemo || group.conflict)continue;
      if(!email){e.source.toast('Choose Ledger → Enable my Sheet posting to record your Gmail.');continue;}
      // One range write stamps the entire transaction, leaving amounts, descriptions and receipts in place.
      const stamp=[email,Utilities.formatDate(new Date(),'Asia/Vientiane','yyyy-MM-dd HH:mm:ss')+' +07:00',Utilities.getUuid()];
      tab.getRange(start+2,10,end-start+1,3).setValues(Array.from({length:end-start+1},()=>stamp.slice()));
      tab.getRange(start+2,14,end-start+1,1).clearContent();
    }
  });
}
function sheetEntryPlan_(rows,accounts,first,last,tz,today,otherIds=[]){
  const codes=new Set(accounts.map(a=>a.code));
  const names=new Map(accounts.map(a=>[a.name,a.code]));
  const ids=rows.map(r=>String(r[0]||'').trim()),reserved=new Set([...ids,...otherIds].filter(Boolean));
  const groups=[],affectedAutoIds=new Set();
  for(let i=first;i<=Math.min(last,rows.length-1);i++)if(rows[i][13]==='auto:'+ids[i])affectedAutoIds.add(ids[i]);
  let group;
  function close(){if(group)groups.push(group);group=null;}
  const day=value=>value instanceof Date ? Utilities.formatDate(value,tz,'yyyy-MM-dd') :
    typeof value==='number' ? new Date((value-25569)*86400000).toISOString().slice(0,10) : String(value||'').trim();
  rows.forEach((row,i)=>{
    const id=ids[i],auto=id && row[13]==='auto:'+id,manual=auto?'':id;
    if(row[9] || row[11] || !row.some((v,c)=>c!==13 && v!=='' && v!=null)){close();return;}
    if(group && ((manual && group.manual && group.manual!==manual) ||
      (row[1] && group.dates.size && !group.dates.has(day(row[1])))))close();
    if(!group)group={start:i,end:i,manual:'',autoIds:[],indexes:[],dates:new Set(),books:new Set(),codes:new Set(),projects:new Set(),categories:new Set(),validLines:true,balance:0,hasMemo:false};
    group.end=i;
    if(manual)group.manual=manual;
    if(auto && !group.autoIds.includes(id))group.autoIds.push(id);
    if(row[1])group.dates.add(day(row[1]));
    if(row[2])group.books.add(String(row[2]).trim());
    if(row[12])group.projects.add(String(row[12]).trim());
    if(row[14])group.categories.add(String(row[14]).trim());
    if(String(row[3]||'').trim())group.hasMemo=true;
    const code=String(row[4]||names.get(row[5])||'');
    if(codes.has(code) && (!row[5] || names.get(row[5])===code)){group.indexes.push(i);group.codes.add(code);}
    else group.validLines=false;
    try{const dr=cents_(row[7]),cr=cents_(row[8]);if((dr>0)===(cr>0))group.validLines=false;group.balance+=dr-cr;}
    catch(error){group.validLines=false;}
    group.balanced=group.validLines && group.codes.size>=2 && group.balance===0;
    if(group.balanced)close();
  });
  close();
  // If accounts were selected in advance, a newly balanced prefix can split its provisional ID.
  const touched=g=>g.start<=last&&g.end>=first;
  for(const g of groups)if(touched(g))g.autoIds.forEach(id=>affectedAutoIds.add(id));
  const claimed=new Set(),plans=[];
  for(const g of groups){
    const backfillOnly=!touched(g) && !g.autoIds.some(id=>affectedAutoIds.has(id));
    if(!g.indexes.length)continue;
    // Edits also repair earlier complete transactions that missed an edit event.
    // Their original editor and posting time cannot be inferred from a later edit.
    if(backfillOnly && (!g.balanced || g.dates.size!==1 || !g.indexes.some(i=>!ids[i])))continue;
    const date=[...g.dates][0]||today;
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date)))continue;
    const prefix=date.slice(2,4)+date.slice(5,7)+'-'+date.slice(8);
    const fits=id=>id.startsWith(prefix)&&/^[A-Z]+(?!000$)\d{3}$/.test(id.slice(prefix.length));
    const existing=g.autoIds.find(id=>fits(id)&&!claimed.has(id)&&!otherIds.includes(id));
    const id=g.manual||existing||nextEntryId_(date,reserved);
    const duplicateManual=g.manual && (otherIds.includes(g.manual) || rows.some((row,i)=>(i<g.start||i>g.end)&&ids[i]===id && row[13]!=='auto:'+id));
    claimed.add(id);reserved.add(id);
    const changes=g.indexes.map(i=>({index:i,id:ids[i]!==id,date:!rows[i][1] && i===g.indexes[0] && !g.dates.size})).filter(c=>c.id||c.date);
    if(backfillOnly && (duplicateManual || !fits(id) || g.books.size!==1 || g.projects.size>1 || g.categories.size>1))continue;
    plans.push({...g,id,date,changes,backfillOnly,book:[...g.books][0],validId:fits(id),conflict:duplicateManual||g.dates.size>1||g.books.size>1||g.projects.size>1||g.categories.size>1});
  }
  return plans;
}

function postSelectedJournalEntry(){
  const sheet=SpreadsheetApp.getActiveSpreadsheet(), range=sheet.getActiveRange();
  const active=range.getSheet(),bookTab=active.getName()==='Journal'?null:active;
  if((bookTab && !bookTabs_(sheet).some(t=>t.getSheetId()===active.getSheetId()))||range.getRow()<2)throw Error('Select a transaction row in Journal first.');
  const raw=journalRows_(sheet,bookTab);
  const target=[...journalGroups_(raw)].find(([,items])=>items.some(item=>item.number===range.getRow()));
  if(!target)throw Error('Select a row with a journal entry.');
  const view=journalState_(sheet,accounts_(sheet),bookTab);
  const lines=view.entries.filter(line=>line.groupKey===(bookTab?'book:'+bookTab.getSheetId()+':':'')+target[0]), first=lines[0];
  if(!first)throw Error(view.warnings.find(w=>w.startsWith('Row '+target[1][0].number+' ' ) || w.startsWith('Row '+target[1][0].number+':'))||'Complete both sides of this entry first.');
  if(!first.sheetDraft){sheet.toast('Already posted as '+first.id);return;}
  const email=signedIn_();
  const id=postWithContext_({ledgerId:sheet.getId(),editId:first.id,groupKey:first.groupKey,revision:first.revision,key:Utilities.getUuid(),
    date:first.date,book:first.book,sourceBook:first.book,memo:first.memo,project:first.project,category:first.category,lines}, {sheet,email});
  sheet.toast('Posted as '+id);
}
function setupNewBook_(sheet) {
  if(!sheet.getSheetByName('Journal') && sheet.getSheetByName('Settings') && bookTabs_(sheet).length){syncBookTabs_(sheet);return;}
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
  ensureJournalPresentation_(sheet);
  migrateSingleBook_(sheet,'Personal');
  installBookReports_(sheet,'Personal',false);
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
function accountInBook_(account,book){return account.book===undefined || account.book===book;}
function accounts_(sheet) {
  const scoped=sheet.getSheetByName('Accounts').getRange('F1').getDisplayValue()==='Book type';
  return chartFromRows_(rows_(sheet,'Accounts',7),scoped);
}
function chartFromRows_(rows,scoped){
  return rows.filter(r=>r[0]!=='' && r[0]!=null).map(r=>({code:String(r[0]),sheetCode:r[0], name:String(r[1]??''),type:String(r[2]??''),parent:String(r[3]??''),use:String(r[4]??''),book:scoped?String(r[5]||''):undefined,role:String(r[6]||'')}));
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
function journalState_(sheet, accounts,bookTab,books=bookNames_(sheet),tz=sheet.getSpreadsheetTimeZone()) {
  if(!bookTab && !sheet.getSheetByName('Journal')){
    const views=bookTabs_(sheet).map(t=>journalState_(sheet,accounts,t,books,tz));
    return {entries:views.flatMap(v=>v.entries),warnings:views.flatMap(v=>v.warnings)};
  }

  const warnings=[],bookName=bookTab?.getName(),keyPrefix=bookTab?'book:'+bookTab.getSheetId()+':':'';
  if(bookTab)accounts=accounts.filter(a=>accountInBook_(a,bookName));
  const chart = new Map(accounts.filter(a=>a.use==='Posting').map(a=>[a.code,a]));
  const groups=journalGroups_(journalRows_(sheet,bookTab));
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
      const date=shared(1), book=shared(2), memo=String(rows.find(r=>String(r[3]??'').trim())?.[3]||'').trim(), project=shared(12), category=shared(14);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10)!==date || !book || !memo) throw Error('Fill in the date, book and description.');
      if (!books.includes(book) && !rows.some(r=>r[0] && (r[9] || r[11]))) throw Error('Choose a book listed in Settings.');
      const draftRows=rows.filter(r=>!r[9] && !r[11]).length;
      if(draftRows && draftRows!==rows.length)throw Error('This ID includes posted and unposted lines. Give the new transaction its own ID.');
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
        return {id:id||('Sheet rows '+group[0].number+'–'+group[group.length-1].number),groupKey:keyPrefix+groupKey,date,book,memo,lineMemo:String(r[3]||'').trim(),reference:String(r[15]??'').trim().toUpperCase(),project,category,code,name:String(r[5]||a.name),type:String(r[6]||a.type),
          debit:debit/100,credit:credit/100,by:String(r[9]),sheetDraft:rows.every(item=>!item[9]&&!item[11]),revision:version};
      });
      if (debitCents!==creditCents || new Set(lines.map(l=>l.code)).size<2) throw Error('Balance the debit and credit lines across at least two accounts.');
      entries.push(...lines);
    } catch(error) { warnings.push((bookTab?bookName+' · ':'')+'Row '+group[0].number+(id?' ('+id+')':'')+': '+error.message); }
  }
  return {entries,warnings};
}
function state(fresh=false) {
  const {sheet,email,owner}=context_(true);
  if(!sheet)return {connected:false,email};
  // The file version also changes after edits made directly in Google Sheets.
  let cache,key;
  try{
    const file=Drive.Files.get(sheet.getId(),{fields:'version,trashed'});
    if(file.version && !file.trashed){
      key=['ledger-state-v2',sheet.getId(),email,owner,file.version].join('/');
      cache=CacheService.getUserCache();
      const value=fresh?null:cache.get(key);
      if(value){
        const cached=JSON.parse(Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(value),'application/x-gzip')).getDataAsString());
        cached.today=date_(new Date());
        return cached;
      }
    }
  }catch(error){cache=null;}
  const result=workbookState_(sheet,email,owner);
  if(cache && key){
    try{
      const compressed=Utilities.base64Encode(Utilities.gzip(Utilities.newBlob(JSON.stringify(result),'application/json')).getBytes());
      if(compressed.length<98000)cache.put(key,compressed,300);
    }catch(error){/* A cache miss or limit must never prevent opening the live workbook. */}
  }
  return result;
}
function primaryBookName_(sheet,books=bookNames_(sheet)){
  return books.find(book=>!DEFAULT_BOOKS.includes(book))||books[0];
}
function workbookState_(sheet,email,owner=sheet.getOwner().getEmail().toLowerCase()) {
  const tabs=sheet.getSheets();
  const titles=tabs.map(tab=>tab.getName());
  const legacy=titles.includes('Journal');
  const candidates=legacy?[]:tabs.filter((_,i)=>!['Overview','Settings','Accounts','Journal'].includes(titles[i]));
  const ranges=["'Accounts'!A:G","'Settings'!B2","'Settings'!F:F"];
  const hasReport=titles.includes('Monthly Report');
  if(hasReport)ranges.push("'Monthly Report'!A4");
  const firstHeader=ranges.length;
  for(const tab of candidates)ranges.push("'"+tab.getName().replace(/'/g,"''")+"'!A1:C1");
  const id=sheet.getId(),tz=sheet.getSpreadsheetTimeZone();
  const result=Sheets.Spreadsheets.Values.batchGet(id,{ranges,valueRenderOption:'UNFORMATTED_VALUE'}).valueRanges;
  const chart=result[0].values||[],settings=result[2].values||[];
  const accounts=chartFromRows_(chart.slice(1),chart[0]?.[5]==='Book type');
  const books=settings[0]?.[0]==='Book types'?[...new Set(settings.slice(1).map(row=>String(row[0]??'').trim()).filter(Boolean))]:DEFAULT_BOOKS.slice();
  // Read journal cells with their native types, as edit conflict checks hash those same cells.
  const sources=legacy?[null]:candidates.filter((_,i)=>{
    const h=result[firstHeader+i].values?.[0]||[];
    return h[0]==='Entry ID' && h[1]==='Date' && h[2]==='Reference';
  });
  const views=sources.map(tab=>journalState_(sheet,accounts,tab,books,tz));
  const reportBook=hasReport?result[3].values?.[0]?.[0]:'';
  return {connected:true,ledgerId:id,title:String(result[1].values?.[0]?.[0]??''),url:sheet.getUrl(),
    email,owner:email===owner,reportBook:reportBook||primaryBookName_(sheet,books),books,accounts,
    entries:views.flatMap(view=>view.entries),warnings:views.flatMap(view=>view.warnings),today:date_(new Date())};
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
  if(archivedWorkbook_(sheet))throw Error('The workbook is archived. Post at '+PERSONAL_SITE_);
  if(id!==sheet.getId()) throw Error('The active ledger changed. Refresh before saving.');
}
function saveAccount(input) {
  return lock_(()=>{
    const {sheet}=context_(), accounts=accounts_(sheet);
    checkLedger_(sheet,input.ledgerId);
    const code=String(input.code||'').trim(), name=text_(input.name,80),parent=String(input.parent||'');
    const book=String(input.book||'');
    if(!bookNames_(sheet).includes(book))throw Error('Choose a book for this account.');
    if(!/^[1-9]\d{1,9}$/.test(code)||accounts.some(a=>accountInBook_(a,book)&&a.code===code)) throw Error('Use a new numeric code (2–10 digits).');
    if(!TYPES.includes(input.type)||!['Group','Posting'].includes(input.use)) throw Error('Choose a valid classification and use.');
    if(parent && !accounts.some(a=>accountInBook_(a,book)&&a.code===parent&&a.type===input.type&&a.use==='Group')) throw Error('Choose a parent group of the same classification.');
    const role=String(input.role||'');
    if(role && (!['Bank','Cash'].includes(role) || input.type!=='Asset' || input.use!=='Posting'))throw Error('Bank and cash roles require a posting asset.');
    sheet.getSheetByName('Accounts').appendRow([code,name,input.type,parent,input.use,book,role]);
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
  const accounts=new Map(accounts_(sheet).filter(a=>a.use==='Posting' && accountInBook_(a,input.book)).map(a=>[a.code,a]));
  let debits=0,credits=0;const used=new Set();
  const rows=input.lines.map(line=>{
    const account=accounts.get(String(line.code)),dr=cents_(line.debit),cr=cents_(line.credit);
    if (!account || ((dr>0)===(cr>0))) throw Error('Choose a posting account and one debit or credit per line.');
    used.add(account.code); debits+=dr; credits+=cr;
    const lineMemo=line.lineMemo ? text_(line.lineMemo,180) : memo;
    const reference=String(line.reference||input.reference||'').trim().toUpperCase();
    if(reference.length>180)throw Error('Use a reference of up to 180 characters.');
    return [id,date,input.book,lineMemo,account.sheetCode??account.code,account.name,account.type,dr/100,cr/100,...posted,project,input.editId ? input.key : '',category,reference];
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
    const legacy=sheet.getSheetByName('Journal'), dedicated=!legacy;
    const journal=legacy||sheet.getSheetByName(input.sourceBook||input.book);
    const destination=legacy||sheet.getSheetByName(input.book);
    if(!journal || !destination || (dedicated && [journal,destination].some(t=>t.getRange('C1').getDisplayValue()!=='Reference')))throw Error('Choose an available book tab.');
    checkLedger_(sheet,input.ledgerId);
    ensureJournalPresentation_(sheet);
    if (!/^[a-f0-9-]{36}$/i.test(String(input.key))) throw Error('Missing posting reference.');
    const rows=journalRows_(sheet,dedicated?journal:null);
    const allRows=dedicated?journalRows_(sheet):rows;
    const header=journal.getRange(1,13,1,3).getDisplayValues()[0];
    if(header.some((v,i)=>v && v!==JOURNAL_HEADERS[12+i])) throw Error('Check the Project, Edit request ID and Category headers in Journal.');
    const sheetId=journal.getSheetId(), requests=[];
    const update=(index,column,values,tabId=sheetId)=>({updateCells:{start:{sheetId:tabId,rowIndex:index,columnIndex:column},
      rows:values.map(cells_),fields:'userEnteredValue'}});
    if(header.some(v=>!v)) requests.push(update(0,12,[JOURNAL_HEADERS.slice(12)]));
    const edit=!!input.editId;
    const prior=allRows.find(row=>String(row[edit?13:11])===input.key);
    if(prior) {
      if(!edit && String(prior[9]).toLowerCase()!==email) throw Error('Posting reference already used.');
      return String(prior[0]);
    }
    const target=edit?String(input.editId):'';
    const positions=[];
    if(edit){
      const group=journalGroups_(rows).get(String(input.groupKey || ('id:'+target)).replace(/^book:\d+:/,'')) || [];
      group.forEach(item=>positions.push(item.number-2));
      if(!positions.length || revision_(positions.map(i=>rows[i]))!==input.revision)
        throw Error('This entry changed in the Sheet or on another device. Close it, refresh and reopen it.');
    }
    const original=rows[positions[0]];
    const sheetPosting=edit && (!original[0] || positions.every(i=>!rows[i][9] && !rows[i][11]));
    let id;
    if(sheetPosting && original[0]){
      id=String(original[0]).trim();
      const prefix=String(input.date).slice(2,4)+String(input.date).slice(5,7)+'-'+String(input.date).slice(8);
      if(dedicated && bookTabs_(sheet).some(t=>t.getSheetId()!==journal.getSheetId() && journalRows_(sheet,t).some(r=>r[0]===id)))throw Error('This ID is already in another book.');
      if(!id.startsWith(prefix) || !/^[A-Z]+(?!000$)\d{3}$/.test(id.slice(prefix.length)))
        throw Error('The manual ID must match the transaction date and sequence, or you can clear it in the Sheet for automatic numbering.');
    }else id=edit && !sheetPosting ? target : nextEntryId_(input.date,allRows.map(row=>String(row[0]).trim()));
    const posted=edit && !sheetPosting ? [original[9],original[10] instanceof Date ? original[10].toISOString() : original[10],original[11]] :
      [email,new Date().toISOString(),input.key];
    const values=makeLines_(sheet,input,id,posted,edit && !sheetPosting ? original[2] : null);
    // Use a native Sheet date so the calendar and the date validation also work on app posts.
    values.forEach(row=>row[1]=Math.round(Date.parse(input.date)/86400000)+25569);
    const moving=destination.getSheetId()!==sheetId;
    const common=moving?0:Math.min(positions.length,values.length);
    function writeLines(index,lines){
      requests.push(update(index,0,lines.map(row=>dedicated?[row[0],row[1],row[15],row[4],row[5],row[6],row[3],...row.slice(7,15)]:row.slice(0,15)),destination.getSheetId()));
      if(!dedicated)requests.push(update(index,REFERENCE_COLUMN-1,lines.map(row=>[row[15]]),destination.getSheetId()));
    }
    for(let i=0;i<common;i++)writeLines(positions[i]+1,[values[i]]);
    for(let i=common;i<positions.length;i++){
      requests.push({repeatCell:{range:{sheetId,startRowIndex:positions[i]+1,endRowIndex:positions[i]+2,startColumnIndex:0,endColumnIndex:JOURNAL_HEADERS.length},
        cell:{},fields:'userEnteredValue'}});
      if(!dedicated)requests.push(update(positions[i]+1,REFERENCE_COLUMN-1,[['']]));
    }
    if(common<values.length){
      const extra=values.slice(common);
      const last=moving?journalRows_(sheet,destination).length:rows.length;
      const required=last+1+extra.length-destination.getMaxRows();
      if(required>0)requests.push({appendDimension:{sheetId:destination.getSheetId(),dimension:'ROWS',length:required}});
      writeLines(last+1,extra);
    }
    Sheets.Spreadsheets.batchUpdate({requests},sheet.getId());
    return id;
  });
}
