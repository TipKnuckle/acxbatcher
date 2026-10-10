import { readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { validatePlan } from './plan.mjs';

// This function reads only rendered chapter controls, never private ACX APIs.
export async function readRows(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('input[placeholder="Chapter name"]')).map(input => {
    const region = input.closest('[role="region"]');
    return { title:input.value, text:region.innerText,
      buttons:Array.from(region.querySelectorAll('button')).map(b=>b.getAttribute('aria-label') || b.innerText),
      disabled:input.disabled };
  }));
}

export async function until(read, description, timeoutMs=60000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
  throw new Error(`Timed out waiting for ${description}. Stop and inspect ACX before resuming.`);
}

export function rowStatus(row, file) {
  if (!row) return 'missing';
  if (/\b(error|failed|failure)\b/i.test(row.text)) return 'error';
  if (row.disabled || /Analyzing file|Uploading|\d+%/i.test(row.text)) return 'busy';
  if (row.buttons.includes('Upload file')) return 'empty';
  // Completion detection is calibrated against the live ACX UI.
  if (row.text.split('\n').some(line=>line.trim()===path.basename(file)) && /\d+:\d{2}/.test(row.text)) return 'uploaded';
  return 'unknown';
}

export async function runUpload({page,plan,statePath,currentUrl,reload,upload,log=console.log,timeoutMs=20*60*1000}) {
  await validatePlan(plan);
  if (await currentUrl() !== plan.url) throw new Error('Browser is on a different title. Open the exact plan URL.');
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
    await page.getByRole('button',{name:'Add chapter',exact:true}).waitFor({state:'visible'});
    // Existing planned rows must form a prefix in the same order. Never reorder/delete automatically.
    const existing = await readRows(page);
    if (state.pendingAdd) {
      if (!existing.some(r=>r.title===state.pendingAdd.title)) throw new Error(`Interrupted while adding ${state.pendingAdd.title}. Name the newly added empty row exactly that on ACX, then rerun.`);
      delete state.pendingAdd; await save();
    }
    if (new Set(existing.map(x=>x.title)).size !== existing.length) throw new Error('Duplicate chapter titles on ACX. Resolve them first.');
    const planned = new Set(plan.items.map(x=>x.title));
    const matched = existing.filter(x=>planned.has(x.title));
    if (matched.some((x,i)=>x.title!==plan.items[i].title)) throw new Error('Existing chapters do not match the planned order.');
    if (matched.length && existing.slice(-matched.length).some((x,i)=>x.title!==matched[i].title)) throw new Error('Planned chapters must be the last existing rows before appending.');
    for (const [index,item] of plan.items.entries()) {
      if (await currentUrl() !== plan.url) throw new Error('Browser left the intended title.');
      let rows = await readRows(page);
      let rowIndex = rows.findIndex(r=>r.title===item.title);
      if (rowIndex < 0) {
        if (state.chapters[item.title]) throw new Error(`Recorded chapter is missing: ${item.title}. Reconcile manually before resuming.`);
        state.pendingAdd={title:item.title,count:rows.length}; await save();
        await page.getByRole('button',{name:'Add chapter',exact:true}).click();
        rows=await until(async()=>{const r=await readRows(page); return r.length===rows.length+1 ? r : false;},'new chapter');
        rowIndex=rows.length-1;
        const input=page.getByRole('textbox',{name:'Chapter name',exact:true}).nth(rowIndex);
        await input.fill(item.title); await input.press('Tab');
        await until(async()=> (await readRows(page))[rowIndex]?.title===item.title,'chapter name');
        delete state.pendingAdd;
        state.chapters[item.title]={status:'created',file:item.file}; await save();
      }
      const readRow=async()=> (await readRows(page)).find(r=>r.title===item.title);
      let status=rowStatus(await readRow(),item.file);
      if (status==='busy') status=await until(async()=>{const s=rowStatus(await readRow(),item.file);return s==='busy'?false:s;},'existing upload',timeoutMs);
      if (status==='uploaded') {
        log(`[${index+1}/${plan.items.length}] Already uploaded: ${item.title}`);
        state.chapters[item.title]={status:'uploaded',file:item.file}; await save(); continue;
      }
      if (status!=='empty') throw new Error(`Cannot safely upload ${item.title}: ${status}. Inspect ACX.`);
      if (state.chapters[item.title]?.status==='uploaded') throw new Error(`Previously uploaded file is now missing: ${item.title}. Inspect ACX.`);
      state.chapters[item.title]={status:'uploading',file:item.file}; await save();
      log(`[${index+1}/${plan.items.length}] Uploading: ${item.title}`);
      const region=page.getByRole('region').filter({has:page.getByRole('textbox',{name:'Chapter name',exact:true})}).nth(rowIndex);
      await upload(region.getByRole('button',{name:'Upload file',exact:true}),item.file);
      await until(async()=>{
        const row=await readRow(), status=rowStatus(row,item.file);
        if(status==='error') throw new Error(`ACX reported a problem with ${item.title}: ${row.text}`);
        return status==='uploaded';
      },`upload and analysis of ${item.title}`,timeoutMs);
      state.chapters[item.title]={status:'uploaded',file:item.file}; await save();
      log(`Confirmed: ${item.title}`);
    }
    await reload();
    await page.getByRole('button',{name:'Add chapter',exact:true}).waitFor({state:'visible'});
    await until(async()=>{
      const rows=await readRows(page);
      return plan.items.every(item=>rowStatus(rows.find(r=>r.title===item.title),item.file)==='uploaded');
    },'uploaded chapters to persist after reload');
    log('All planned chapters persisted after reload. Audiobook has NOT been submitted for review.');
    delete state.lastError; await save();
    return state;
  } catch(error) {
    if(state) {state.lastError={message:error.message,time:new Date().toISOString()}; await save();}
    throw error;
  } finally {await lock.close(); await unlink(lockPath);}
}
