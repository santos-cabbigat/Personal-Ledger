import {readFile,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url);
const read=path=>readFile(new URL(path,root),'utf8');
const write=(path,content)=>writeFile(new URL(path,root),content);
const source=await read('docs/index.html'), backend=await read('apps-script/Code.gs');
const reporting=await read('apps-script/Reporting.gs');
const session=await read('apps-script/Session.gs');
const manifest=await read('apps-script/appsscript.json');
const css=await read('docs/ledger.css');
const archiveBackend=await read('apps-script/PersonalArchive.gs');
const live=source.replace(/<link rel="stylesheet" href="ledger\.css(?:\?[^"]*)?">/,()=>'<style>'+css+'</style>')
  .replace(/<script src="google-client\.js(?:\?[^"]*)?"><\/script>/,'')
  .replace(/<script src="(?:vendor\/supabase|personal-db|demo)\.js(?:\?[^"]*)?"><\/script>/g,'');
await write('apps-script/Index.html',live);
const demoPath='docs/demo.js';
const demo=(await read(demoPath)).split('// Sequence is shared by both books')[0].trimEnd();
const sequence=backend.slice(backend.indexOf('// Sequence is shared by both books'),backend.indexOf('function postEntry(input) {'));
await write(demoPath,demo+'\n\n'+sequence.trimEnd()+'\n');
const single=backend.replace("properties.getProperty('LEDGER_ID')","properties.getProperty('LEDGER_ID') || '__WORKBOOK__'")
  .replace("HtmlService.createHtmlOutputFromFile('Index').getContent()",'LEDGER_HTML_')+
  '\n'+reporting+'\n'+session+'\n'+archiveBackend+'\nconst LEDGER_HTML_ = '+JSON.stringify(live)+';\n';
const js=value=>JSON.stringify(value).replaceAll('<','\\u003c');
const installer=`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Update Personal &amp; Business Ledger</title><style>body{max-width:42rem;margin:5vh auto;padding:1.2rem;font:17px/1.5 system-ui;color:#282d28;background:#f1ecdf}button{padding:.8rem 1rem;border:0;border-radius:.6rem;background:#075c58;color:#fffaf0;font:inherit}textarea{display:block;width:100%;height:8rem}[hidden]{display:none}</style>
<h1>Update your ledger app</h1>
<ol><li>Open your ledger spreadsheet on a computer. Choose <b>Extensions → Apps Script</b>.</li>
<li>Replace <b>Code.gs</b> with the complete script below, then save.<p><button id="code">Copy Code.gs</button> <button id="showCode">Show Code.gs</button></p></li>
<li>In <b>Project Settings</b>, turn on <b>Show “appsscript.json” manifest file in editor</b>. Replace that file with the manifest below and save. It enables Google Drive and Google Sheets for the app.<p><button id="manifest">Copy appsscript.json</button> <button id="showManifest">Show appsscript.json</button></p></li>
<li>Choose <b>Deploy → Manage deployments → Edit → New version → Deploy</b>. Keep <b>Execute as: User accessing the web app</b> and use the existing deployment. Google may ask you to authorize the updated app.</li></ol>
<p id="result" role="status"></p><textarea id="manual" hidden readonly aria-label="Select and copy"></textarea><script>
const source=${js(single)},manifest=${js(manifest)},id=location.hash.slice(1),linked=/^[\\w-]{20,100}$/.test(id);
const statusBox=document.querySelector('#result'),manual=document.querySelector('#manual');
async function copy(value){try{await navigator.clipboard.writeText(value);statusBox.textContent='Copied.'}catch{manual.hidden=false;manual.value=value;manual.select();statusBox.textContent='Select and copy the code.'}}
const preparedCode=source.replace('__WORKBOOK__',linked?id:'');
function show(value){manual.hidden=false;manual.value=value;manual.focus();manual.select();}
document.querySelector('#showCode').onclick=()=>show(preparedCode);
document.querySelector('#showManifest').onclick=()=>show(manifest);
document.querySelector('#code').onclick=()=>copy(preparedCode);
document.querySelector('#manifest').onclick=()=>copy(manifest);
</script></html>\n`;
await write('docs/copy-script.html',installer);
