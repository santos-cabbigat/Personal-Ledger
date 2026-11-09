'use strict';
const demoAccounts = [
 ['1000','Assets','Asset','','Group'],['1100','Cash on hand','Asset','1000','Posting'],['1110','Bank','Asset','1000','Posting'],['1200','Accounts receivable','Asset','1000','Posting'],
 ['2000','Liabilities','Liability','','Group'],['2100','Accounts payable','Liability','2000','Posting'],
 ['3000','Equity','Equity','','Group'],['3100','Opening balance','Equity','3000','Posting'],['3200','Owner contributions','Equity','3000','Posting'],['3300','Owner withdrawals','Equity','3000','Posting'],
 ['4000','Income','Income','','Group'],['4100','Personal income','Income','4000','Posting'],['4200','Sales income','Income','4000','Posting'],
 ['5000','Expenses','Expense','','Group'],['5100','Household expenses','Expense','5000','Posting'],['5200','Business supplies','Expense','5000','Posting'],['5300','Utilities','Expense','5000','Posting']
].map(([code,name,type,parent,use])=>({code,name,type,parent,use}));
const sampleDay = offset=>new Date(Date.now()+7*3600000-offset*86400000).toISOString().slice(0,10);
const previewData={title:'Personal & Business Ledger',owner:true,accounts:demoAccounts,entries:[],today:sampleDay(0)};
const savedKeys=new Map();
function recordSample(id,date,book,memo,lines){
 const records=lines.map(l=>{
   const a=previewData.accounts.find(a=>a.code===l.code&&a.use==='Posting');
   if(!a)throw Error('Choose a posting account.');
   return {id,date,book,memo,code:a.code,name:a.name,type:a.type,debit:Number(l.debit)||0,credit:Number(l.credit)||0,by:'Preview user'};
 });
 previewData.entries.push(...records);
}
for(const [id,days,book,memo,debit,credit,total] of [
 ['S1',4,'Personal','Monthly income','1110','4100',2400000],
 ['S2',3,'Business','Customer payment','1100','4200',850000],
 ['S3',2,'Business','Packaging supplies','5200','1100',180000],
 ['S4',1,'Personal','Groceries','5100','1110',245000]
])recordSample(id,sampleDay(days),book,memo,[{code:debit,debit:total},{code:credit,credit:total}]);
async function previewCall(action,input){
 switch(action){
 case 'state':return structuredClone(previewData);
 case 'postEntry':{
   if(savedKeys.has(input.key))return savedKeys.get(input.key);
   const id=crypto.randomUUID();
   recordSample(id,input.date,input.book,input.memo,input.lines);
   savedKeys.set(input.key,id);return id;
 }
 case 'saveAccount':{
   if(!/^[1-9]\d{1,9}$/.test(input.code)||previewData.accounts.some(a=>a.code===input.code))throw Error('Choose a new numeric account code of 2–10 digits.');
   if(!input.name.trim())throw Error('Enter an account name.');
   previewData.accounts.push({...input,name:input.name.trim()});return input.code;
 }
 case 'renameLedger':{
   const title=input.trim();if(!title||title.length>60)throw Error('Enter a name of 1–60 characters.');
   previewData.title=title;return title;
 }
 default:throw Error('Unknown preview action.');
 }
}
