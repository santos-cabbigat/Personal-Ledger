// Each book keeps a private set of dropdown choices drawn from its own chart.
function configureBookChart_(tab){
  const name=tab.getName().replace(/"/g,'""'), n=tab.getMaxRows()-1;
  if(!tab.getRange('T1').isBlank() && tab.getRange('T1').getDisplayValue()!=='Book account codes')throw Error('Columns T:W are in use on '+tab.getName());
  tab.getRange('T1:W1').setValues([['Book account codes','Book account names','Classification','Cash / bank']]);
  tab.getRange('T2').setFormula('=IFNA(FILTER({Accounts!A2:A,Accounts!B2:B,Accounts!C2:C,Accounts!G2:G},Accounts!F2:F="'+name+'",Accounts!E2:E="Posting"),"")');
  tab.hideColumns(20,4);
  for(const [col,source] of [[4,'T2:T'],[5,'U2:U']]){
    tab.getRange(2,col,n,1).setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(tab.getRange(source),true).setAllowInvalid(false).build());
  }
  // Change only formulas or empty cells. Literal posting codes and types are historical records.
  for(const col of [4,6]){
    const range=tab.getRange(2,col,n,1),values=range.getValues(),forms=range.getFormulas();
    let start=0;
    for(let i=0;i<=n;i++){
      if(i<n && (forms[i][0] || values[i][0]===''))continue;
      if(i>start){
        const formulas=Array.from({length:i-start},(_,j)=>{const r=start+j+2;return [col===4?
          '=IF(E'+r+'="","",IFNA(INDEX($T$2:$T,MATCH(E'+r+',$U$2:$U,0)),""))':
          '=IF(D'+r+'="","",IFNA(INDEX($V$2:$V,MATCH(TO_TEXT(D'+r+'),ARRAYFORMULA(TO_TEXT($T$2:$T)),0)),""))'];});
        tab.getRange(start+2,col,i-start,1).setFormulas(formulas);
      }
      start=i+1;
    }
  }
}
function installProjectReporting(){
  const sheet=SpreadsheetApp.getActiveSpreadsheet();
  if(sheet.getOwner().getEmail().toLowerCase()!==signedIn_())throw Error('Open this setup as the workbook owner.');
  lock_(()=>installBookReports_(sheet,primaryBookName_(sheet),true));
}
function installBookReports_(sheet,initialBook,temporary){
  const chart=sheet.getSheetByName('Accounts'),settings=sheet.getSheetByName('Settings');
  if(!sheet.getSheetByName(initialBook))throw Error('Missing journal '+initialBook);
  const headers=chart.getRange('F1:G1').getDisplayValues()[0];
  if(headers.some((v,i)=>v && v!==['Book type','Cash / bank'][i]))throw Error('The chart needs empty columns F and G.');
  const firstInstall=!headers[0], count=Math.max(0,chart.getLastRow()-1);
  if(firstInstall && count && !chart.getRange(2,6,count,2).isBlank())throw Error('The chart already contains values in F:G.');
  chart.getRange('F1:G1').setValues([['Book type','Cash / bank']]);
  if(firstInstall && count){
    const labels=chart.getRange(2,1,count,5).getDisplayValues();
    chart.getRange(2,6,count,2).setValues(labels.map(([code,name,type,,use])=>[code?initialBook:'',
      type==='Asset' && use==='Posting' ? (/\bbank\b|\bbcel\b/i.test(name)?'Bank':/cash on hand/i.test(name)?'Cash':''):'']));
  }
  if(temporary){
    const present=accounts_(sheet);
    for(const book of ['Personal','Business']){
      if(present.some(a=>a.book===book))continue;
      chart.getRange(chart.getLastRow()+1,1,2,7).setValues([
        ['1100','Temporary cash','Asset','','Posting',book,'Cash'],
        ['3100','Temporary opening balance','Equity','','Posting',book,'']]);
    }
  }
  chart.getRange('A1:G1').setBackground('#191e38').setFontColor('#f5f2ff').setFontWeight('bold');
  chart.setColumnWidth(6,140);chart.setColumnWidth(7,105);
  chart.getRange('F2:F').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(settings.getRange('F2:F'),true).setAllowInvalid(false).build());
  chart.getRange('G2:G').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['Bank','Cash'],true).setAllowInvalid(false).build());
  for(const tab of bookTabs_(sheet)){formatBookJournal_(sheet,tab,false);configureBookChart_(tab);}
  for(const [name,signature] of [['Report Data','Book'],['General Ledger','Book'],['Trial Balance','Book'],['Monthly Report','MONTHLY FINANCIAL REPORT']]){
    const existing=sheet.getSheetByName(name);
    if(existing && existing.getLastRow() && existing.getRange('A1').getDisplayValue()!==signature)throw Error('The tab '+name+' is already in use.');
    if(!existing)sheet.insertSheet(name);
  }
  refreshReportSource_(sheet);
  buildLedgerViews_(sheet);
  buildMonthSheet_(sheet,initialBook);
  sheet.getSheetByName('Report Data').hideSheet();
  sheet.setActiveSheet(sheet.getSheetByName(initialBook));
}
const REPORT_COLUMNS_=['Book','Code','Account','Classification','Date','Entry ID','Reference','Description','Debit (LAK)','Credit (LAK)','Project','Category','Cash / bank','Status','Parent account'];
function sourceBookFormula_(tab){
  const book='"'+tab.getName().replace(/"/g,'""')+'"',prefix="'"+tab.getName().replace(/'/g,"''")+"'!";
  const col=s=>prefix+s+'2:'+s, ids=col('A');
  const accountMap='FILTER({ARRAYFORMULA(TO_TEXT(Accounts!A2:A)),Accounts!D2:D,Accounts!G2:G},Accounts!F2:F='+book+',Accounts!E2:E="Posting")';
  const parentMap='FILTER({ARRAYFORMULA(TO_TEXT(Accounts!A2:A)),Accounts!B2:B},Accounts!F2:F='+book+',Accounts!E2:E="Group")';
  return 'IFNA(LET(lines,FILTER('+prefix+'A2:O,'+ids+'<>""),keys,CHOOSECOLS(lines,1),codes,ARRAYFORMULA(TO_TEXT(CHOOSECOLS(lines,4))),uniqueIds,UNIQUE(keys),'+
    'dates,MAP(uniqueIds,LAMBDA(key,MAXIFS('+col('B')+','+ids+',key))),'+
    'states,MAP(uniqueIds,LAMBDA(key,LET(grp,FILTER(lines,keys=key),debits,CHOOSECOLS(grp,8),credits,CHOOSECOLS(grp,9),accts,CHOOSECOLS(grp,4),dts,CHOOSECOLS(grp,2),ct,ROWS(grp),'+
    'sides,SUM(MAP(debits,credits,LAMBDA(dval,cval,N(AND(OR(dval="",ISNUMBER(dval)),OR(cval="",ISNUMBER(cval)),N(dval)>=0,N(cval)>=0,(N(dval)>0)+(N(cval)>0)=1))))),'+
    'validAccts,SUM(MAP(accts,LAMBDA(ac,N(COUNTIFS(Accounts!F2:F,'+book+',Accounts!E2:E,"Posting",Accounts!A2:A,ac)=1)))),'+
    'dated,IFNA(COUNTUNIQUE(FILTER(dts,ISNUMBER(dts))),0),signedRows,COUNTIFS('+ids+',key,'+col('J')+',"<>"' +','+col('L')+',"<>"' +'),'+
    'clean,AND(ct>=2,sides=ct,validAccts=ct,dated=1,COUNTUNIQUE(accts)>=2,SUM(debits)>0,ROUND(SUM(debits)-SUM(credits),2)=0,COUNTIF(CHOOSECOLS(grp,7),"<>")>0),'+
    'IF(NOT(clean),"Review",IF(signedRows=ct,"Posted",IF(AND(COUNTIFS('+ids+',key,'+col('J')+',"<>"' +')=0,COUNTIFS('+ids+',key,'+col('L')+',"<>"' +')=0),"Balanced draft","Review")))))),'+
    'roles,ARRAYFORMULA(IFNA(VLOOKUP(codes,'+accountMap+',3,FALSE),"")),parents,ARRAYFORMULA(IFNA(VLOOKUP(TO_TEXT(IFNA(VLOOKUP(codes,'+accountMap+',2,FALSE),"")),'+parentMap+',2,FALSE),"")),'+
    'HSTACK(ARRAYFORMULA(IF(keys<>"",'+book+',"")),codes,CHOOSECOLS(lines,5,6),ARRAYFORMULA(VLOOKUP(keys,HSTACK(uniqueIds,dates),2,FALSE)),keys,CHOOSECOLS(lines,3,7,8,9,13,15),roles,ARRAYFORMULA(VLOOKUP(keys,HSTACK(uniqueIds,states),2,FALSE)),parents)),MAKEARRAY(1,15,LAMBDA(rr,cc,"")))';
}
function refreshReportSource_(sheet){
  const tab=sheet.getSheetByName('Report Data'),books=bookTabs_(sheet);
  tab.getRange(1,1,1,15).setValues([REPORT_COLUMNS_]);
  const capacity=books.reduce((n,t)=>n+t.getMaxRows()-1,1);
  for(const t of ['Report Data','General Ledger','Trial Balance'].map(name=>sheet.getSheetByName(name)).filter(Boolean))
    if(t.getMaxRows()<capacity)t.insertRowsAfter(t.getMaxRows(),capacity-t.getMaxRows());
  tab.getRange('A2').setFormula('=LET(stacked,VSTACK('+books.map(sourceBookFormula_).join(',')+'),IFNA(FILTER(stacked,CHOOSECOLS(stacked,1)<>""),""))');
}
function reportTable_(tab,headers,widths){
  tab.setHiddenGridlines(true).setFrozenRows(1);
  tab.getRange(1,1,1,headers.length).setValues([headers]).setBackground('#191e38').setFontColor('#ffffff').setFontWeight('bold').setVerticalAlignment('middle');
  tab.setRowHeight(1,36);
  widths.forEach((w,i)=>tab.setColumnWidth(i+1,w));
}
function buildLedgerViews_(sheet){
  const ledger=sheet.getSheetByName('General Ledger'),trial=sheet.getSheetByName('Trial Balance'),src="'Report Data'!";
  reportTable_(ledger,[...REPORT_COLUMNS_.slice(0,10),'Running Dr − Cr','Project','Category','Status'],[130,75,190,110,116,134,150,300,125,125,149,140,140,135]);
  const basis=sheet.getSheetByName('Settings').getRange('K2');
  sheet.getSheetByName('Settings').getRange('K1').setValue('Ledger & trial balance basis');
  basis.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['All balanced entries','Posted only'],true).setAllowInvalid(false).build());
  if(!basis.getValue())basis.setValue('All balanced entries');
  ledger.getRange('A2').setFormula('=IFNA(LET(lines,SORT(FILTER('+src+'A2:N,(('+src+'N2:N="Posted")+('+src+'N2:N="Balanced draft")*(Settings!K2<>"Posted only"))>0),1,TRUE,2,TRUE,5,TRUE,6,TRUE),bal,SCAN(0,SEQUENCE(ROWS(lines)),LAMBDA(prev,idx,ROUND(INDEX(lines,idx,9)-INDEX(lines,idx,10)+IF(OR(idx=1,INDEX(lines,idx,1)<>INDEX(lines,MAX(1,idx-1),1),INDEX(lines,idx,2)<>INDEX(lines,MAX(1,idx-1),2)),0,prev),2))),HSTACK(CHOOSECOLS(lines,1,2,3,4,5,6,7,8,9,10),bal,CHOOSECOLS(lines,11,12,14))),"")');
  ledger.getRange('E2:E').setNumberFormat('dd-mmm-yyyy');ledger.getRange('I2:K').setNumberFormat('#,##0.##;[Red](#,##0.##);0');
  reportTable_(trial,['Book','Code','Account','Classification','Debit balance','Credit balance'],[140,90,240,135,155,155]);
  const gl="'General Ledger'!";
  // Group by book and account before splitting the net into debit and credit balances.
  trial.getRange('A2').setFormula('=IFNA(LET(keys,UNIQUE(FILTER('+gl+'A2:D,'+gl+'A2:A<>"")),books,CHOOSECOLS(keys,1),codes,CHOOSECOLS(keys,2),nets,MAP(books,codes,LAMBDA(bk,ac,ROUND(SUMIFS('+gl+'I2:I,'+gl+'A2:A,bk,'+gl+'B2:B,ac)-SUMIFS('+gl+'J2:J,'+gl+'A2:A,bk,'+gl+'B2:B,ac),2))),HSTACK(keys,ARRAYFORMULA(IF(nets>0,nets,0)),ARRAYFORMULA(IF(nets<0,-nets,0)))),"")');
  trial.getRange('E2:F').setNumberFormat('#,##0.##');
  trial.getRange('H1:J1').setValues([['Book totals','Debit (LAK)','Credit (LAK)']]).setBackground('#483870').setFontColor('#ffffff').setFontWeight('bold');
  trial.getRange('H2').setFormula('=IFNA(LET(books,FILTER(Settings!F2:F,Settings!F2:F<>""),HSTACK(books,MAP(books,LAMBDA(bk,SUMIF(A2:A,bk,E2:E))),MAP(books,LAMBDA(bk,SUMIF(A2:A,bk,F2:F))))),"")');
  trial.getRange('I2:J').setNumberFormat('#,##0.##');trial.setColumnWidths(8,3,135);
}
function buildMonthSheet_(sheet,initialBook){
  const tab=sheet.getSheetByName('Monthly Report'),source="'Report Data'!";
  const first=!tab.getRange('A1').getValue(),navy='#191e38',ink='#211f3d',violet='#503b78',pale='#eee8fa',aqua='#bfece6';
  tab.setHiddenGridlines(true);tab.setTabColor(violet);
  tab.setColumnWidth(1,148);tab.setColumnWidth(2,220);tab.setColumnWidth(3,150);tab.setColumnWidth(4,178);
  tab.getRange('A1:D18').setFontFamily('Arial').setFontColor(ink).setVerticalAlignment('middle');
  const merge=(a)=>{const r=tab.getRange(a);if(!r.isPartOfMerge())r.merge();return r;};
  const band=(a,text,color)=>merge(a).setValue(text).setBackground(color).setFontColor('#ffffff').setFontWeight('bold');
  band('A1:D1','MONTHLY FINANCIAL REPORT',navy).setFontSize(18);tab.setRowHeight(1,49);
  merge('A2:D2').setFormula('=A4&"  /  "&TEXT(C4,"mmmm yyyy")&"  /  Lao kip"').setBackground(violet).setFontColor('#ffffff').setFontSize(13);tab.setRowHeight(2,32);
  tab.getRange('A3:D3').setValues([['Book','','Reporting month','Basis']]).setFontColor(violet).setFontWeight('bold');
  merge('A4:B4');tab.getRange('A4').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInRange(sheet.getSheetByName('Settings').getRange('F2:F'),true).setAllowInvalid(false).build());
  tab.getRange('C4').setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build()).setNumberFormat('mmm yyyy').setNote('Choose any date in the month to report.');
  if(first){tab.getRange('A4').setValue(initialBook);tab.getRange('C4').setValue(Math.round(Date.parse(date_(new Date()).slice(0,7)+'-01')/86400000)+25569);}
  const basis=tab.getRange('D4');
  basis.setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['All balanced entries','Posted only'],true).setAllowInvalid(false).build());
  if(!['All balanced entries','Posted only'].includes(basis.getDisplayValue()))basis.setValue('All balanced entries');
  tab.getRange('A4:D4').setBackground(pale).setFontWeight('bold');tab.setRowHeight(4,32);
  const sum=(col,when,filter,value)=>'SUMIFS('+source+col+'2:'+col+','+source+'A2:A,$A$4,'+source+'N2:N,IF($D$4="Posted only","Posted","<>Review"),'+source+'E2:E,"' + (when==='prior'?'<':'<=') + '"&'+(when==='prior'?'(EOMONTH($C$4,-1)+1)':'EOMONTH($C$4,0)')+(when==='month'?','+source+'E2:E,">"&EOMONTH($C$4,-1)':'')+','+source+filter+'2:'+filter+',"'+value+'")';
  merge('A5:D5').setFormula('="After money in and money out, "&A4&" has ₭"&TEXT(D8,"#,##0")&" in the bank."').setFontColor(ink).setFontSize(11).setWrap(true);
  tab.setRowHeight(5,42);
  band('A6:D6','MONEY IN THE BANK',navy);
  tab.getRange('A7:D7').setValues([['Bank at start','Money in','Money out','Money left in the bank']]).setFontColor(violet).setFontWeight('bold');
  tab.getRange('A8:D8').setFormulas([['='+sum('I','prior','M','Bank')+'-'+sum('J','prior','M','Bank'),'='+sum('I','month','M','Bank'),'='+sum('J','month','M','Bank'),'=A8+B8-C8']]).setBackground('#e9f6f4').setFontSize(15).setFontWeight('bold');tab.getRange('D8').setBackground(aqua);tab.setRowHeight(8,39);
  band('A10:D10','INCOME AND SPENDING',navy);
  tab.getRange('A11:D11').setValues([['Income','Expenses','Income less expenses','Entries included']]).setFontColor(violet).setFontWeight('bold');
  const count='COUNTUNIQUEIFS('+source+'F2:F,'+source+'A2:A,$A$4,'+source+'E2:E,">"&EOMONTH($C$4,-1),'+source+'E2:E,"<="&EOMONTH($C$4,0),'+source+'F2:F,"<>",'+source+'N2:N,';
  tab.getRange('A12:D12').setFormulas([['='+sum('J','month','D','Income')+'-'+sum('I','month','D','Income'),'='+sum('I','month','D','Expense')+'-'+sum('J','month','D','Expense'),'=A12-B12','='+count+'IF($D$4="Posted only","Posted","<>Review"))']]).setBackground(pale).setFontSize(15).setFontWeight('bold');tab.setRowHeight(12,38);
  merge('A14:D14').setFormula('='+count+'"Posted")&" posted   ·   "&'+count+'"Balanced draft")&IF($D$4="Posted only"," balanced drafts excluded"," balanced drafts included")&"   ·   "&'+count+'"Review")&" need review"').setFontSize(10).setFontColor(violet);
  band('A16:D16','WHERE THE INCOME CAME FROM AND WHAT IT PAID FOR',navy);
  tab.getRange('A17:D17').setValues([['Classification','Parent account','Account','Amount (LAK)']]).setFontWeight('bold').setBackground(pale);
  tab.getRange('A18').setFormula('=IFNA(LET(lines,FILTER('+source+'A2:O,'+source+'A2:A=$A$4,'+source+'N2:N<>"Review",IF($D$4="Posted only",'+source+'N2:N="Posted",'+source+'N2:N<>""),'+source+'E2:E>EOMONTH($C$4,-1),'+source+'E2:E<=EOMONTH($C$4,0),(('+source+'D2:D="Income")+('+source+'D2:D="Expense"))>0),typ,CHOOSECOLS(lines,4),parts,HSTACK(typ,CHOOSECOLS(lines,15,3),ARRAYFORMULA(IF(typ="Income",CHOOSECOLS(lines,10)-CHOOSECOLS(lines,9),CHOOSECOLS(lines,9)-CHOOSECOLS(lines,10)))),QUERY(parts,"select Col1,Col2,Col3,sum(Col4) group by Col1,Col2,Col3 order by Col1 desc,Col2,Col3 label Col1 \'\',Col2 \'\',Col3 \'\',sum(Col4) \'\'",0)),"No income or expenses for this selection")');
  for(const addr of ['A8:D8','A12:C12','D18:D'])tab.getRange(addr).setNumberFormat('#,##0.##;[Red](#,##0.##);0');
  tab.getRange('A18:C').setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);tab.setRowHeights(6,2,28);tab.setRowHeight(10,28);tab.setRowHeight(16,28);
}
