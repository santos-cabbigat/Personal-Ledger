// Deploy this standalone project as its owner with access restricted to "Only myself".
const PROJECT_API_ = 'https://api.supabase.com/v1/projects/uyyihuvjbrbsombzzvqw';
const PROJECT_DASHBOARD_ = 'https://supabase.com/dashboard/project/uyyihuvjbrbsombzzvqw';
const LEDGER_SITE_ = 'https://santos-cabbigat.github.io/Personal-Ledger/';

function doGet() {
  return HtmlService.createHtmlOutput(`<!doctype html><html lang="en"><head><base target="_top"><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{font:16px/1.5 system-ui;color:#113e33;background:#f4efe5;margin:0}main{margin:12vh auto;max-width:28rem;padding:1.6rem;background:white;border-radius:1rem}h1{margin:0;font-size:1.65rem}button,a{font:inherit}button{padding:.65rem 1.15rem;border:0;border-radius:1.5rem;color:white;background:#095d50;cursor:pointer}button:disabled{opacity:.55}a{color:#07564a}p{margin:.9rem 0}[hidden]{display:none}</style>
    <title>Personal Ledger recovery</title></head><body><main><h1>Personal Ledger recovery</h1>
    <p id="status" role="status">Checking project status…</p>
    <button id="resume" hidden>Resume personal ledger</button> <button id="check">Check again</button>
    <p><a href="${LEDGER_SITE_}">Return to ledger</a> · <a href="${PROJECT_DASHBOARD_}" target="_blank" rel="noopener">Open Supabase</a></p></main>
    <script>
    const statusBox=document.getElementById('status'),resume=document.getElementById('resume'),check=document.getElementById('check');
    function show(result){statusBox.textContent=result.message;resume.hidden=!result.canResume;resume.disabled=false;check.disabled=false;}
    function run(action){resume.disabled=true;check.disabled=true;const handler=google.script.run.withSuccessHandler(show).withFailureHandler(()=>show({message:'The owner recovery service could not respond. Try again or open Supabase.'}));
      if(action==='restore')handler.resumePersonalProject();else handler.checkPersonalProject();
    }
    check.onclick=()=>run('check');resume.onclick=()=>run('restore');run('check');
    </script></body></html>`).setTitle('Personal Ledger recovery').addMetaTag('viewport','width=device-width, initial-scale=1');
}

function projectRequest_(token, method, path) {
  return UrlFetchApp.fetch(PROJECT_API_+path,{method,headers:{Authorization:'Bearer '+token},
    muteHttpExceptions:true,followRedirects:false});
}

function checkPersonalProject() {
  const token=PropertiesService.getUserProperties().getProperty('PERSONAL_PROJECT_RECOVERY_TOKEN');
  if(!token)return {message:'Direct recovery is awaiting activation. You can open Supabase to check or resume the project.'};
  const response=projectRequest_(token,'get','');
  if(response.getResponseCode()!==200)return {message:'Supabase could not verify project status. Check the recovery credential or open Supabase.'};
  const project=JSON.parse(response.getContentText());
  if(project.id!=='uyyihuvjbrbsombzzvqw' && project.ref!=='uyyihuvjbrbsombzzvqw')throw Error('Unexpected project.');
  switch(project.status){
    case 'INACTIVE': return {canResume:true,message:'Your personal ledger is paused.'};
    case 'ACTIVE_HEALTHY': return {message:'Your personal ledger is online.'};
    case 'RESTORING': case 'COMING_UP': return {message:'Your personal ledger is starting. Check again shortly.'};
    default: return {message:'Supabase reports '+String(project.status||'an unknown state')+'. Check again or open the project for details.'};
  }
}

function resumePersonalProject() {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(3000))return {message:'Another recovery check is in progress. Check again shortly.'};
  try{
    const state=checkPersonalProject();
    if(!state.canResume)return state;
    const props=PropertiesService.getUserProperties();
    const now=Date.now();
    if(now-Number(props.getProperty('LAST_RESTORE_REQUEST')||0)<60000)return {message:'A restore was requested recently. Check again shortly.'};
    const response=projectRequest_(props.getProperty('PERSONAL_PROJECT_RECOVERY_TOKEN'),'post','/restore');
    if(response.getResponseCode()<200||response.getResponseCode()>=300)return {message:'Supabase did not accept the restore request. Check the project in Supabase.'};
    props.setProperty('LAST_RESTORE_REQUEST',String(now));
    return {message:'Supabase accepted the restore request. Check again shortly.'};
  }finally{lock.releaseLock();}
}
