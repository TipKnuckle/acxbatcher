import {createInterface} from 'node:readline';
import {readFile,writeFile,mkdir,readdir,stat} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {displayTitle,compareFilenames,validatePlan} from './plan.mjs';
import {getProject,readRows,rowStatus,waitForUploadPage} from './acx-page.mjs';
import {runUpload,checkOrder} from './uploader.mjs';

// JSON-lines protocol: Swift owns UI/batches; this process owns Chrome.
const home=process.argv[2];
if(!home || !path.isAbsolute(home)) throw new Error('An absolute application-support directory is required.');
await mkdir(home,{recursive:true,mode:0o700});
const emit=event=>process.stdout.write(JSON.stringify(event)+'\n');
let context,page,busy=false,pause=false,running=false,quitting=false;
let uploadController;
async function browserPage() {
  if(!context) {
    context=await chromium.launchPersistentContext(path.join(home,'Chrome'),{channel:'chrome',headless:false,viewport:null,chromiumSandbox:true});
    context.on('close',()=>{context=undefined;page=undefined;emit({type:'browserClosed'});});
  }
  if(!page || page.isClosed()) page=context.pages()[0]||await context.newPage();
  return page;
}
function batchPath(id) {
  if(!/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Invalid batch identifier.');
  return path.join(home,`${id}.plan.json`);
}
async function inspect(plan) {
  await validatePlan(plan);
  const p=await browserPage();
  if(p.url()!==plan.url) await p.goto(plan.url,{waitUntil:'domcontentloaded'});
  if(!await waitForUploadPage(p,plan.url)) throw new Error('In Chrome, sign in and open this project’s finished-audio page, then check again.');
  const rows=await readRows(p);checkOrder(rows,plan);
  const items=plan.items.map(item=>{
    const row=rows.find(r=>r.title===item.title);
    const status=rowStatus(row,item.file);
    if(!['missing','empty','uploaded','busy'].includes(status)) throw new Error(`${item.title}: ACX reports ${status}. Inspect this row in Chrome.`);
    return {file:item.file,title:item.title,status:status==='missing'?'add':status==='empty'?'upload':status==='busy'?'waiting':'skip'};
  });
  const names=new Set(plan.items.map(i=>i.title));
  return {project:await getProject(p),items,existing:rows.map(row=>({title:row.title,inPlan:names.has(row.title)})),unrelated:rows.filter(r=>!names.has(r.title)).length};
}
async function command(message) {
  const {id,action}=message;
  if(message.plan) message.plan={version:message.plan.version,url:message.plan.url,items:message.plan.items.map(item=>({title:item.title,file:item.file,bytes:item.bytes,mtimeMs:item.mtimeMs}))};
  if(action==='pause') {pause=true;emit({id,type:'pauseRequested'});return;}
  if(action==='cancel') {
    uploadController?.abort(new Error('Stopped waiting. The current file may still be processing in Chrome. Resume will check ACX before uploading anything.'));
    emit({id,type:'cancelRequested'});return;
  }
  if(action==='shutdown') {quitting=true;pause=true;if(!busy){await context?.close();process.exit(0);}return;}
  if(busy) {emit({id,type:'error',message:'Finish the current operation first.'});return;}
  busy=true;
  try {
    let data;
    if(action==='import') {
      const files=[];
      for(const input of message.paths) {
        const info=await stat(input);
        if(info.isDirectory()) {
          for(const entry of await readdir(input,{withFileTypes:true})) if(entry.isFile()&&/\.mp3$/i.test(entry.name)) files.push(path.join(input,entry.name));
        } else if(/\.mp3$/i.test(input)) files.push(input);
      }
      data=[];
      for(const file of [...new Set(files)].sort((a,b)=>compareFilenames(path.basename(a),path.basename(b))||a.localeCompare(b))) {
        const info=await stat(file);
        if(!info.size) throw new Error(`Empty audio file: ${file}`);
        data.push({file,title:message.strip?displayTitle(path.basename(file)):path.basename(file).replace(/\.mp3$/i,''),bytes:info.size,mtimeMs:info.mtimeMs});
      }
      if(!data.length) throw new Error('No MP3 files found. Folders are read one level deep.');
    } else if(action==='browse') {
      const p=await browserPage();
      const url=message.url||'https://www.acx.com/dashboard';
      if(!/^https:\/\/www\.acx\.com\/(dashboard|titleview\/[A-Z0-9]+)$/.test(url)) throw new Error('Use an ACX project URL.');
      if(p.url()!==url) await p.goto(url,{waitUntil:'domcontentloaded'});
      await p.bringToFront();data={};
    } else if(action==='project') {
      await browserPage();
      const candidates=context.pages().filter(p=>/^https:\/\/www\.acx\.com\/titleview\/[A-Z0-9]+$/.test(p.url()));
      const visible=[];
      for(const candidate of candidates) if(await candidate.evaluate(()=>document.visibilityState==='visible').catch(()=>false)) visible.push(candidate);
      if(candidates.length===1) page=candidates[0];
      else if(visible.length===1) page=visible[0];
      else if(candidates.length>1) throw new Error('Several project tabs are open. Close the others so the intended project is unambiguous.');
      data=await getProject(page);
    } else if(action==='preflight') {
      data=await inspect(message.plan);
    } else if(action==='start') {
      await inspect(message.plan);
      const file=batchPath(message.batchID);
      // Never rewrite an existing plan after it has been journaled.
      try {
        const saved=JSON.parse(await readFile(file,'utf8'));
        if(JSON.stringify(saved)!==JSON.stringify(message.plan)) throw new Error('This batch changed after starting. Create a new batch rather than changing its saved plan.');
      } catch(error) {if(error.code!=='ENOENT') throw error;await writeFile(file,JSON.stringify(message.plan,null,2),{mode:0o600});}
      pause=false;running=true;uploadController=new AbortController();
      emit({type:'started'});
      const result=await runUpload({page,plan:message.plan,statePath:file+'.state.json',currentUrl:()=>page.url(),reload:()=>page.reload(),
        shouldPause:()=>pause,signal:uploadController.signal,onEvent:emit,log:message=>emit({type:'log',message}),
        upload:async(button,file)=>{const [chooser]=await Promise.all([page.waitForEvent('filechooser'),button.click()]);await chooser.setFiles(file);}});
      running=false;data={paused:!!result.paused};
    } else throw new Error(`Unknown command: ${action}`);
    emit({id,type:'result',action,data});
  } catch(error) {running=false;emit({id,type:'error',action,message:error.message});}
  finally {uploadController=undefined;busy=false;if(quitting){await context?.close();process.exit(0);}}
}
const input=createInterface({input:process.stdin});
input.on('line',line=>{try {void command(JSON.parse(line)).catch(error=>emit({type:'error',message:error.message}));}catch(error){emit({type:'error',message:error.message});}});
input.on('close',()=>{quitting=true;pause=true;if(!busy) void context?.close().finally(()=>process.exit(0));});
emit({type:'ready'});
