import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source=readFileSync(new URL('../apps-script/PersonalArchive.gs',import.meta.url),'utf8');

function archiveFixture(){
  const cells=[],queue=[{seq:1,revision:'journal-revision',content:{id:'sample',book:'Personal',day:'2026-01-01',memo:'=literal text',lines:[
    {code:'100',name:'Bank',debit:1.23,credit:0},{code:'500',name:'Other',debit:0,credit:1.23}
  ]}}];
  let corrupt=true,acknowledged=0,completed=false;
  const sheet={
    getOwner:()=>({getEmail:()=>'owner@example.org'}),getId:()=>'demo',
    getSheetByName:()=>cells.length?tab:null,insertSheet:()=>tab
  };
  const tab={
    getLastRow:()=>cells.length,setFrozenRows(){},
    getRange:(r,c,n,m)=>({setValues:rows=>cells.push(...rows),
      getValues:()=>cells.slice(r-1,r-1+n).map(row=>row.slice(c-1,c-1+m))})
  };
  const values={
    append:({values},id,range,options)=>{
      assert.equal(options.valueInputOption,'RAW');
      cells.push(...values.map(row=>Array.from(row)));
    },
    batchGet:(id,{ranges})=>({valueRanges:ranges.map(range=>{
      const row=Number(range.match(/!A(\d+):/)[1]);
      const result=cells[row-1].slice();
      if(corrupt)result[9]=999;
      return {values:[result]};
    })})
  };
  const context=vm.createContext({SpreadsheetApp:{openById:()=>sheet},ledgerId_:()=>'demo',
    Session:{getEffectiveUser:()=>sheet.getOwner()},LockService:{getScriptLock:()=>({tryLock:()=>true,releaseLock(){}})},
    Sheets:{Spreadsheets:{Values:values}}});
  vm.runInContext(source,context);
  context.archiveRpc_=(action,batch)=>{
    if(action==='batch')return queue;
    if(action==='confirm'){assert.equal(batch[0].revision,'journal-revision');acknowledged++;queue.pop();}
    if(action==='complete')completed=true;
  };
  return {run:()=>context.dailyPersonalArchive(),repair:()=>{corrupt=false;},cells,
    acknowledged:()=>acknowledged,completed:()=>completed};
}

test('Sheet archive keeps original rows and only acknowledges matching readback on retry',()=>{
  const archive=archiveFixture();
  assert.throws(archive.run,/readback differs/);
  assert.equal(archive.acknowledged(),0);
  assert.equal(archive.completed(),false);
  assert.equal(archive.cells.length,3);
  assert.equal(archive.cells[1][6],'=literal text');
  archive.repair();
  archive.run();
  assert.equal(archive.acknowledged(),1);
  assert.equal(archive.completed(),true);
  assert.equal(archive.cells.length,3);
});
