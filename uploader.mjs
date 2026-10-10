import { readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { validatePlan } from './plan.mjs';
import {createACXPage,readRows,rowStatus} from './acx-page.mjs';
export {readRows,rowStatus};

export async function until(read, description, timeoutMs=60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`Timed out waiting for ${description}. Stop and inspect ACX before resuming.`);
}

export function checkOrder(existing,plan) {
  if(new Set(existing.map(x=>x.title)).size!==existing.length) throw new Error('Duplicate chapter titles on ACX. Resolve them first.');
  const planned=new Set(plan.items.map(x=>x.title));
  const matched=existing.filter(x=>planned.has(x.title));
  if(matched.some((x,i)=>x.title!==plan.items[i].title)) throw new Error('Existing chapters do not match the planned order.');
  if(matched.length && existing.slice(-matched.length).some((x,i)=>x.title!==matched[i].title)) throw new Error('Planned chapters must be the last existing rows before appending.');
}

export async function runUpload({page,plan,statePath,currentUrl,reload,upload,adapter,log=console.log,timeoutMs=20*60*1000,shouldPause=()=>false,onEvent=()=>{}}) {
  const acx=adapter||createACXPage({page,currentUrl,reload,upload});
  await validatePlan(plan);
  if (await acx.url() !== plan.url) throw new Error('Browser is on a different title. Open the exact plan URL.');
  const lockPath = statePath + '.lock';
  const lock = await open(lockPath,'wx').catch(() => {throw new Error(`Another run may be active. Inspect ${lockPath} before removing a stale lock.`);});
  const fingerprint = createHash('sha256').update(JSON.stringify({url:plan.url,items:plan.items})).digest('hex');
  let state;
  async function save() {
    await writeFile(statePath+'.tmp', JSON.stringify(state,null,2)+'\n',{mode:0o600});
    await rename(statePath+'.tmp',statePath);
  }
  try {
    await lock.writeFile(`Started ${new Date().toISOString()}\n`);
    try {state=JSON.parse(await readFile(statePath,'utf8'));}
    catch(error) {if(error.code !== 'ENOENT') throw error; state={fingerprint,url:plan.url,chapters:{}};}
    if (state.fingerprint !== fingerprint) throw new Error('Plan changed since this run. Use a new plan/state filename.');
    await acx.ready();
    // Existing planned rows must form a prefix in the same order. Never reorder/delete automatically.
    const existing = await acx.listSections();
    if (state.pendingAdd) {
      if (!existing.some(r=>r.title===state.pendingAdd.title)) throw new Error(`Interrupted while adding ${state.pendingAdd.title}. Name the newly added empty row exactly that on ACX, then rerun.`);
      delete state.pendingAdd; await save();
    }
    checkOrder(existing,plan);
    for (const [index,item] of plan.items.entries()) {
      if(shouldPause()) {onEvent({type:'paused'});return {...state,paused:true};}
      if (await acx.url() !== plan.url) throw new Error('Browser left the intended title.');
      let rows = await acx.listSections();
      let rowIndex = rows.findIndex(r=>r.title===item.title);
      if (rowIndex < 0) {
        if (state.chapters[item.title]) throw new Error(`Recorded chapter is missing: ${item.title}. Reconcile manually before resuming.`);
        state.pendingAdd={title:item.title,count:rows.length}; await save();
        await acx.addSection();
        rows=await until(async()=>{const r=await acx.listSections(); return r.length===rows.length+1 ? r : false;},'new chapter');
        rowIndex=rows.length-1;
        await acx.nameSection(rowIndex,item.title);
        await until(async()=> (await acx.listSections())[rowIndex]?.title===item.title,'chapter name');
        delete state.pendingAdd;
        state.chapters[item.title]={status:'created',file:item.file}; await save();
      }
      const readRow=async()=> (await acx.listSections()).find(r=>r.title===item.title);
      let status=acx.status(await readRow(),item.file);
      if (status==='busy') status=await until(async()=>{const s=acx.status(await readRow(),item.file);return s==='busy'?false:s;},'existing upload',timeoutMs);
      if (status==='uploaded') {
        log(`[${index+1}/${plan.items.length}] Already uploaded: ${item.title}`);
        state.chapters[item.title]={status:'uploaded',file:item.file}; await save(); onEvent({type:'item',file:item.file,status:'uploaded'}); continue;
      }
      if (status!=='empty') throw new Error(`Cannot safely upload ${item.title}: ${status}. Inspect ACX.`);
      if (state.chapters[item.title]?.status==='uploaded') throw new Error(`Previously uploaded file is now missing: ${item.title}. Inspect ACX.`);
      state.chapters[item.title]={status:'uploading',file:item.file}; await save();
      log(`[${index+1}/${plan.items.length}] Uploading: ${item.title}`);
      onEvent({type:'item',file:item.file,status:'uploading'});
      await acx.uploadFile(rowIndex,item.file);
      await until(async()=>{
        const row=await readRow(), status=acx.status(row,item.file);
        if(status==='error') throw new Error(`ACX reported a problem with ${item.title}: ${row.text}`);
        return status==='uploaded';
      },`upload and analysis of ${item.title}`,timeoutMs);
      state.chapters[item.title]={status:'uploaded',file:item.file}; await save();
      log(`Confirmed: ${item.title}`);
      onEvent({type:'item',file:item.file,status:'uploaded'});
    }
    await acx.reload();
    await acx.ready();
    await until(async()=>{
      const rows=await acx.listSections();
      return plan.items.every(item=>acx.status(rows.find(r=>r.title===item.title),item.file)==='uploaded');
    },'uploaded chapters to persist after reload');
    log('All planned chapters persisted after reload. Audiobook has NOT been submitted for review.');
    delete state.lastError; await save();
    return state;
  } catch(error) {
    if(state) {state.lastError={message:error.message,time:new Date().toISOString()}; await save();}
    throw error;
  } finally {await lock.close(); await unlink(lockPath);}
}
