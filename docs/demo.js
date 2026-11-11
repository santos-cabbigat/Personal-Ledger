'use strict';
const demoAccounts = [
 ['1000','Assets','Asset','','Group'],['1100','Cash on hand','Asset','1000','Posting'],['1110','Bank','Asset','1000','Posting'],['1200','Accounts receivable','Asset','1000','Posting'],
 ['2000','Liabilities','Liability','','Group'],['2100','Accounts payable','Liability','2000','Posting'],
 ['3000','Equity','Equity','','Group'],['3100','Opening balance','Equity','3000','Posting'],['3200','Owner contributions','Equity','3000','Posting'],['3300','Owner withdrawals','Equity','3000','Posting'],
 ['4000','Income','Income','','Group'],['4100','Personal income','Income','4000','Posting'],['4200','Sales income','Income','4000','Posting'],
 ['5000','Expenses','Expense','','Group'],['5100','Household expenses','Expense','5000','Posting'],['5200','Business supplies','Expense','5000','Posting'],['5300','Utilities','Expense','5000','Posting']
].map(([code,name,type,parent,use])=>({code,name,type,parent,use}));
const sampleDay = offset=>new Date(Date.now()+7*3600000-offset*86400000).toISOString().slice(0,10);
const previewData={title:'Personal & Business Ledger',owner:true,books:['Personal','Business'],ledgerId:'demo',accounts:demoAccounts,entries:[],today:sampleDay(0)};
const savedKeys=new Map();
function recordSample(id,date,book,memo,lines,project='',revision=id,category='',reference=''){
 const records=lines.map(l=>{
   const a=previewData.accounts.find(a=>a.code===l.code&&a.use==='Posting');
   if(!a)throw Error('Choose a posting account.');
   return {id,date,book,memo,lineMemo:l.lineMemo||memo,reference:String(l.reference||reference||'').toUpperCase(),project,category,revision,code:a.code,name:a.name,type:a.type,debit:Number(l.debit)||0,credit:Number(l.credit)||0,by:'Preview user'};
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
   const id=input.editId||nextEntryId_(input.date,previewData.entries.map(r=>r.id));
   const old=previewData.entries.filter(r=>r.id===id);
   if(input.editId && (!old.length || old[0].revision!==input.revision)) throw Error('Refresh and reopen this entry.');
   recordSample(id,input.date,input.book,input.memo,input.lines,input.project,input.key,input.category,input.reference);
   previewData.entries=previewData.entries.filter(r=>!old.includes(r));
   savedKeys.set(input.key,id);return id;
 }
 case 'saveBookType':{
   const name=input.trim();
   if(!name||name.length>80||/^[=+@-]/.test(name))throw Error('Enter a book name of 1–80 characters.');
   const existing=previewData.books.find(book=>book.toLowerCase()===name.toLowerCase());
   if(!existing)previewData.books.push(name);
   return existing||name;
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
