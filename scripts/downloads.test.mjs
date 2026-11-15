import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const ctx=vm.createContext({Blob,TextEncoder,Date});
vm.runInContext(readFileSync(new URL('../docs/report-downloads.js',import.meta.url),'utf8'),ctx);
const D=ctx.LedgerDownloads;
const chart=[['1100','Cash','Asset','Cash'],['1110','Bank','Asset','Bank'],['1500','Equipment','Asset',''],['3100','Opening equity','Equity',''],['4100','Support','Income',''],['5100','Supplies','Expense','']].map(([code,name,type,role])=>({code,name,type,role,use:'Posting'}));
const data={books:['Personal','Business'],accounts:['Personal','Business'].flatMap(book=>chart.map(a=>({...a,book}))),entries:[]};
function entry(id,date,book,memo,lines,extra={}){for(const [code,debit,credit] of lines){const a=chart.find(a=>a.code===code);data.entries.push({id,date,book,memo,lineMemo:memo,code,name:a.name,type:a.type,debit,credit,...extra});}}
entry('opening','2026-10-31','Personal','Opening',[['1110',1000,0],['3100',0,1000]]);
entry('income','2026-11-01','Personal','Support',[['1110',500,0],['4100',0,500]]);
entry('split','2026-11-03','Personal','Split purchase',[['5100',20.01,0],['1500',100.02,0],['1110',0,120.03]]);
entry('refund','2026-11-04','Personal','Refund',[['1110',2.01,0],['5100',0,2.01]]);
entry('income','2026-11-01','Business','Other book',[['1100',50,0],['4100',0,50]]);
entry('draft','2026-11-05','Personal','Draft',[['5100',30,0],['1110',0,30]],{sheetDraft:true});
const summary=(m,label)=>m.summary.find(r=>r[0]===label)?.[1];
const params={book:'Personal',from:'2026-11-01',to:'2026-11-30',basis:'Posted only'};
test('journal keeps split entries together, separates identical IDs across books and supplies exact entry and report totals',()=>{
 const m=D.journal(data.entries);assert.equal(summary(m,'Entry groups'),6);assert.equal(summary(m,'Debit less credit (LAK)'),0);
 const rows=m.records.filter(r=>r[0]==='split');assert.equal(rows.length,4);assert.equal(rows[3][7],120.03);assert.equal(rows[3][8],120.03);
 assert.equal(m.groupRows.length,6);assert.equal(m.totalRows.length,6);assert.equal(summary(m,'Balanced draft groups'),1);
});
test('trial balance carries the opening, nets refunds in integer cents and excludes other books, dates and drafts',()=>{
 const m=D.financial(data,{...params,kind:'Trial balance'});assert.equal(summary(m,'Opening debit (LAK)'),1000);assert.equal(summary(m,'Opening credit (LAK)'),1000);assert.equal(summary(m,'Closing difference (LAK)'),0);
 const bank=m.records.find(r=>r[1]==='1110');assert.equal(bank[7],1381.98);assert.equal(bank[5],502.01);assert.equal(bank[6],120.03);
 const supplies=m.records.find(r=>r[1]==='5100');assert.equal(supplies[7],18);assert(!m.records.some(r=>r[0]==='Business'));
});
test('each report has its own content and summary, ledger retains IDs and running balances',()=>{
 const pl=D.financial(data,{...params,kind:'Income and expenses'});assert.equal(summary(pl,'Income (LAK)'),500);assert.equal(summary(pl,'Expenses (LAK)'),18);assert.equal(summary(pl,'Net income / (loss) (LAK)'),482);
 const bs=D.financial(data,{...params,kind:'Balance sheet'});assert.equal(summary(bs,'Assets (LAK)'),1482);assert.equal(summary(bs,'Balance sheet difference (LAK)'),0);
 const gl=D.financial(data,{...params,kind:'General ledger'});assert(gl.headers.includes('Entry ID'));assert.equal(gl.records.find(r=>r[1]==='1110'&&r[4]==='refund')[9],1381.98);assert.equal(summary(gl,'Period journal lines'),7);
 const fixed=D.financial(data,{...params,kind:'Fixed assets',assetKeys:[JSON.stringify(['Personal','1500'])]});assert.equal(summary(fixed,'Closing carrying balance (LAK)'),100.02);assert.equal(summary(fixed,'Selected fixed asset accounts'),1);assert(!fixed.records.some(r=>r[1]==='1110'));
 const exp=D.expense(data.entries,{book:'Personal',month:'2026-11'});assert.equal(summary(exp,'Net expenses (LAK)'),18);assert.equal(summary(exp,'Refunds / credits (LAK)'),2.01);
 const month=D.monthly(data,{book:'Personal',month:'2026-11',basis:'Posted only'});assert.equal(summary(month,'Closing bank balance (LAK)'),1381.98);assert.equal(month.scope.to,'2026-11-30');assert.equal(summary(month,'Net income / (loss) (LAK)'),482);
 const a=D.accounts(data,'Personal');assert.equal(summary(a,'Accounts'),6);assert(a.records.every(r=>r[0]==='Personal'));
});
test('styled Excel is a real ZIP workbook, preserves text IDs and safely stores formula-like descriptions as text',async()=>{
 const m=D.journal([{...data.entries[0],id:'00123',memo:'=SUM(A1:A2)',lineMemo:'=SUM(A1:A2)'}],{book:'Personal'}),buffer=Buffer.from(await D.xlsx(m).arrayBuffer());
 const files=new Map();let p=0;while(buffer.readUInt32LE(p)===0x04034b50){const size=buffer.readUInt32LE(p+18),nameLength=buffer.readUInt16LE(p+26),extraLength=buffer.readUInt16LE(p+28),name=buffer.toString('utf8',p+30,p+30+nameLength),start=p+30+nameLength+extraLength;files.set(name,buffer.toString('utf8',start,start+size));p=start+size;}
 assert(files.has('[Content_Types].xml'));assert(files.has('xl/workbook.xml'));const sheet=files.get('xl/worksheets/sheet1.xml');assert.match(sheet,/<c r="A1"/);assert.match(sheet,/00123/);assert.match(sheet,/inlineStr.*=SUM\(A1:A2\)/);assert.doesNotMatch(sheet,/<f>/);assert.match(sheet,/s="4"/);assert.match(sheet,/s="5"/);assert.match(files.get('xl/styles.xml'),/FFE0EFE8/);assert.match(sheet,/Total debit \(LAK\)/);
});
