import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../apps-script/Code.gs',import.meta.url),'utf8');
const accounts=[{code:'1100',name:'Cash',type:'Asset',use:'Posting'},{code:'5100',name:'Supplies',type:'Expense',use:'Posting'},{code:'1110',name:'Bank',type:'Asset',use:'Posting'}];
function fixture() {
  const book={getId:()=>'ledger',getSheetByName:()=>tab,getSpreadsheetTimeZone:()=>'Asia/Vientiane'};
  const tab={getSheetId:()=>1,getMaxRows:()=>1000,getRange:()=>({getDisplayValues:()=>[['Project','Edit request ID','Category']]})};
  const raw=[], locks=[];
  const context=vm.createContext({Date,Map,Set,Utilities:{
    DigestAlgorithm:{SHA_256:'sha256'},computeDigest:(algo,value)=>createHash(algo).update(value).digest(),
    base64EncodeWebSafe:value=>Buffer.from(value).toString('base64url')},
    LockService:{getScriptLock:()=>({waitLock:()=>locks.push('lock'),releaseLock:()=>locks.push('unlock')})},
    SpreadsheetApp:{flush(){}},Sheets:{Spreadsheets:{batchUpdate:({requests})=>{
      const convert=row=>row.values.map(c=>Object.values(c.userEnteredValue)[0]);
      for(const req of requests){
        if(req.appendCells)raw.push(...req.appendCells.rows.map(convert));
        if(req.updateCells)req.updateCells.rows.forEach((row,i)=>{
          const start=req.updateCells.start, at=start.rowIndex-1+i;
          raw[at]??=Array(18).fill('');
          convert(row).forEach((v,j)=>raw[at][start.columnIndex+j]=v);
        });
        if(req.repeatCell)raw[req.repeatCell.range.startRowIndex-1]=Array(14).fill('');
      }
    }}}});
  vm.runInContext(source,context);
  context.ensureJournalPresentation_=()=>{};
  context.context_=()=>({email:'poster@example.org',sheet:book});
  context.accounts_=()=>accounts;context.rows_=()=>raw;
  context.bookNames_=()=>['Personal','Business','Family'];
  return {api:context,book,raw,locks};
}
const draft=(amount=1000)=>({ledgerId:'ledger',date:'2026-11-11',book:'Personal',memo:'Supplies',project:'School',key:randomUUID(),lines:[{code:'5100',debit:amount},{code:'1100',credit:amount}]});
test('daily sequence rolls over independently of book',()=>{
  const {api}=fixture();
  for(const [prior,next] of [['','A001'],['A998','A999'],['A999','B001'],['Z999','AA001'],['AZ999','BA001'],['ZZ999','AAA001']]){
    assert.equal(api.nextEntryId_('2026-11-11',['2611-10Z999','J-old','2611-11'+prior]),'2611-11'+next);
  }
});
test('posting, retries, editing posted entries and Sheet conflicts',()=>{
  const {api,raw,book,locks}=fixture(),input=draft();
  const id=api.postEntry(input);
  assert.equal(id,'2611-11A001');assert.equal(raw.length,2);
  assert.equal(api.postEntry(input),id);assert.equal(raw.length,2);
  const other={...draft(),book:'Business'};assert.equal(api.postEntry(other),'2611-11A002');
  const row=api.journalState_(book,accounts).entries[0];
  const edit={...draft(),editId:id,groupKey:row.groupKey,revision:row.revision,project:'Revised',
    lines:[{code:'5100',debit:1000},{code:'1100',credit:500},{code:'1110',credit:500}]};
  api.context_=()=>({email:'second@example.org',sheet:book});
  assert.equal(api.postEntry(edit),id);assert.equal(api.postEntry(edit),id);
  assert.equal(raw.filter(r=>r[0]===id).length,3);assert.equal(raw[0][9],'poster@example.org');
  assert.equal(raw[0][12],'Revised');assert.throws(()=>api.postEntry({...edit,key:randomUUID()}),/changed/);
  const current=api.journalState_(book,accounts).entries[0];
  assert.equal(api.postEntry({...draft(),editId:id,groupKey:current.groupKey,revision:current.revision}),id);
  assert.equal(raw.filter(r=>r[0]===id).length,2);assert.equal(raw[2][0],'2611-11A002');
  assert.throws(()=>api.postEntry({...draft(),ledgerId:'other'}),/active ledger/);
  assert.equal(locks.filter(l=>l==='lock').length,locks.filter(l=>l==='unlock').length);
});
test('direct Sheet drafts receive the poster and permanent ID once',()=>{
  const {api,book,raw}=fixture();
  const row=(values)=>Array.from({length:14},(_,i)=>values[i]??'');
  raw.push(row(['','2026-11-11','Business','Sheet entry','5100','','',400]),row(['','','','','1100','','','',400]));
  raw.push(row(['','2026-11-11','Business','Next draft','5100','','',10]));
  let state=api.journalState_(book,accounts);
  assert.equal(state.entries.length,2);assert.equal(state.warnings.length,1);
  const line=state.entries[0];assert.equal(line.sheetDraft,true);assert.equal(line.by,'');assert.equal(line.name,'Supplies');
  const input={...draft(400),editId:line.id,groupKey:line.groupKey,revision:line.revision};
  assert.equal(api.postEntry(input),'2611-11A001');assert.equal(api.postEntry(input),'2611-11A001');
  state=api.journalState_(book,accounts);assert.equal(raw.length,3);
  assert.equal(state.entries[1].by,'poster@example.org');assert.equal(state.entries[1].sheetDraft,false);
});
test('Drive setup creates one empty ledger per new owner and reopens it',()=>{
  const {api}=fixture(), files=new Map(), properties=new Map(), initialized=[];
  const book=id=>({getId:()=>id,getSheetByName:()=>({getRange:()=>({getDisplayValue:()=>'Book types'})}),getOwner:()=>({getEmail:()=>files.get(id).owner})});
  let email='first@example.org';
  api.signedIn_=()=>email;
  api.context_=()=>({sheet:null,email});
  api.setupNewBook_=sheet=>initialized.push(sheet.getId());
  api.schema_=()=>{};
  api.PropertiesService={getUserProperties:()=>{
    if(!properties.has(email))properties.set(email,{});
    const props=properties.get(email);
    return {getProperty:k=>props[k],setProperty:(k,v)=>{props[k]=v;},setProperties:obj=>Object.assign(props,obj)};
  }};
  api.LockService.getUserLock=()=>({waitLock(){},releaseLock(){}});
  api.SpreadsheetApp.openById=id=>book(id);
  api.Drive={Files:{
    list:({q})=>({files:[...files].filter(([,f])=>f.owner===email && q.includes("value='"+f.appProperties.ledgerRole+"'")).map(([id])=>({id}))}),
    create:resource=>{const id=randomUUID();files.set(id,{...resource,owner:email});return {id};}
  }};
  api.connectPersonalDrive();api.connectPersonalDrive();
  const first=properties.get(email).OWN_LEDGER;
  assert.equal(files.size,2);assert.equal(files.get(first).parents.length,1);
  email='second@example.org';api.connectPersonalDrive();
  assert.equal(files.size,4);const own=properties.get(email).OWN_LEDGER;
  assert.notEqual(first,own);
  api.setupBookPickers_=()=>{};
  api.openExistingLedger('https://docs.google.com/spreadsheets/d/'+first+'/edit');
  assert.equal(properties.get(email).ACTIVE_LEDGER,first);
  api.connectPersonalDrive();assert.equal(properties.get(email).ACTIVE_LEDGER,own);
  assert.deepEqual(initialized,[first,own]);
});

test('custom books and independent categories survive posting and sheet review',()=>{
  const {api,book,raw}=fixture();
  assert.throws(()=>api.postEntry({...draft(),book:'Unknown'}),/listed in Settings/);
  const id=api.postEntry({...draft(),book:'Family',category:'Education'});
  const entry=api.journalState_(book,accounts).entries[0];
  assert.deepEqual([entry.book,entry.project,entry.category],['Family','School','Education']);
  api.bookNames_=()=>['Personal','Business'];
  assert.equal(api.journalState_(book,accounts).entries[0].id,id);
  const edit={...draft(),book:'Family',editId:id,groupKey:entry.groupKey,revision:entry.revision,category:'Tuition'};
  assert.equal(api.postEntry(edit),id);
  assert.equal(raw[0][14],'Tuition');
});
test('Sheet pickers reference the book list, posted IDs, projects and categories',()=>{
  const {api}=fixture();
  const requests=api.bookPickerRequests_(123,321,true);
  const lists=requests.map(r=>r.setDataValidation).filter(Boolean);
  assert.deepEqual(Array.from(lists,r=>r.range.startColumnIndex),[2,12,14,15]);
  assert.equal(lists[0].rule.condition.values[0].userEnteredValue,'=Settings!$F$2:$F');
  assert.equal(lists[3].range.endRowIndex,2);
  const settings=requests.filter(r=>r.updateCells?.start.sheetId===321);
  assert.ok(settings.some(r=>r.updateCells.rows.some(row=>row.values[0].userEnteredValue.stringValue==='Business')));
  assert.ok(requests.some(r=>r.updateCells?.rows[0].values[0].userEnteredValue.formulaValue?.includes('MATCH(P2,A:A,0)')));
});

test('a manually assigned ID, split receipts and different line descriptions survive posting',()=>{
  const {api,book,raw}=fixture(), date='2026-11-11', id='2611-11A004';
  const row=(memo,code,dr,cr,ref)=>[id,date,'Family',memo,code,'','',dr,cr,'','','','','','','picker','jump',ref];
  raw.push(row('Bank transfer','1100',1000,0,'000782'),row('Contribution','5100',0,1000,''));
  const {entries,warnings}=api.journalState_(book,accounts);
  assert.equal(warnings.length,0);assert.equal(entries.length,2);assert.equal(entries[0].sheetDraft,true);
  const edit={...draft(),book:'Family',editId:id,groupKey:entries[0].groupKey,revision:entries[0].revision,lines:entries};
  assert.equal(api.postEntry(edit),id);assert.deepEqual(raw.map(r=>r[3]),['Bank transfer','Contribution']);
  assert.equal(raw[0][17],'000782');assert.equal(raw[0][15],'picker');assert.equal(raw[1][16],'jump');
  assert.equal(api.postEntry(draft()),'2611-11A005');assert.equal(raw[0][9],'poster@example.org');
});
test('bound laptop edits allocate on account choice and post only when a multi-line entry balances',()=>{
  const {api,book}=fixture(),records=[],stamps=[],notes=[];
  const blank=()=>Array(16).fill('');
  const tab={getName:()=>'Journal',getRange:(r,c,n=1,w=1)=>({
    setValue(v){records[r-2][c-1]=v;},
    setValues(v){for(let i=0;i<n;i++)for(let j=0;j<w;j++)records[r-2+i][c-1+j]=v[i][j];if(c===10)stamps.push([r,n]);},
    clearContent(){for(let i=0;i<n;i++)records[r-2+i][c-1]='';}
  })};
  api.fillEditedAccount_=()=>{};api.journalRows_=()=>records;
  api.Utilities.formatDate=(_d,_tz,fmt)=>fmt==='yyyy-MM-dd'?'2026-11-11':'2026-11-11 13:20:00';
  api.Utilities.getUuid=randomUUID;book.toast=t=>notes.push(t);
  let email='first@example.org';api.sheetEditorEmail_=()=>email;
  function edit(i,c,value){
    while(records.length<=i)records.push(blank());records[i][c-1]=value;
    api.onEdit({source:book,range:{getSheet:()=>tab,getColumn:()=>c,getLastColumn:()=>c,getRow:()=>i+2,getLastRow:()=>i+2}});
  }
  edit(0,2,'2026-11-09');edit(0,3,'Family');edit(0,4,'Deposits');assert.equal(records[0][0],'');
  edit(0,6,'Cash');assert.equal(records[0][0],'2611-09A001');edit(0,8,100);
  for(let i=1;i<=4;i++){edit(i,6,'Supplies');assert.equal(records[i][0],'2611-09A001');edit(i,9,25);if(i<4)assert.equal(stamps.length,0);}
  assert.deepEqual(stamps,[[2,5]]);
  assert.ok(records.every(r=>r[9]===email && r[10].includes('+07:00') && r[11]===records[0][11]));
  edit(5,2,'2026-11-09');edit(5,3,'Family');edit(5,4,'Next');edit(5,6,'Cash');
  assert.equal(records[5][0],'2611-09A002');
  email='';edit(5,8,10);edit(6,6,'Supplies');edit(6,9,10);assert.equal(stamps.length,1);assert.equal(records[6][9],'');
  email='second@example.org';edit(6,9,10);assert.equal(stamps.length,2);assert.equal(records[5][9],email);
});
test('preselected lines split at the balancing row and backdated provisional IDs follow the entered date',()=>{
  const {api}=fixture(),rows=Array.from({length:4},()=>Array(16).fill(''));
  for(const [i,r] of rows.entries()){r[0]='2611-11A002';r[13]='auto:'+r[0];r[4]=i%2?'5100':'1100';}
  rows[0][1]='2026-11-09';rows[0][7]=10;rows[1][8]=10;
  const groups=api.sheetEntryPlan_(rows,accounts,1,1,'Asia/Vientiane','2026-11-11');
  assert.equal(groups.length,2);assert.equal(groups[0].id,'2611-09A001');assert.equal(groups[0].balanced,true);
  assert.equal(groups[1].id,'2611-11A002');assert.equal(groups[1].balanced,false);
});
