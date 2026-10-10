// Local-only integration test of real Playwright selectors and file-chooser flow.
import { chromium } from 'playwright';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { makePlan } from './plan.mjs';
import { runUpload } from './uploader.mjs';
import { waitForUploadPage } from './readiness.mjs';

const folder = await mkdtemp(path.join(os.tmpdir(),'acx-playwright-'));
const html = `<!doctype html><button id="add">Add chapter</button><main></main><script>
let rows=JSON.parse(localStorage.rows||'[]');
function save(){localStorage.rows=JSON.stringify(rows)}
function render(){
 const main=document.querySelector('main'); main.replaceChildren();
 for(const row of rows){
  const outer=document.createElement('div'); outer.setAttribute('role','region');
  const input=document.createElement('input'); input.placeholder='Chapter name'; input.value=row.title;
  input.onchange=()=>{row.title=input.value;save()}; outer.append(input);
  const inner=document.createElement('div'); inner.setAttribute('role','region'); outer.append(inner);
  if(row.file){const p=document.createElement('p');p.style.whiteSpace='pre-line';p.textContent='00:00\\n09:02\\n'+row.file;inner.append(p)}
  else {const file=document.createElement('input');file.type='file';file.hidden=true;
   file.onchange=()=>{row.file=file.files[0].name;save();render()};
   const button=document.createElement('button');button.textContent='Upload file';button.onclick=()=>file.click();inner.append(file,button)}
  main.append(outer);
 }
}
document.querySelector('#add').onclick=()=>{rows.push({title:'Chapter '+(rows.length+1)});save();render()};render();
</script>`;
const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(html)});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try {
  for(let n=1;n<=3;n++) await writeFile(path.join(folder,`Book - Chapter ${n}.mp3`),'test fixture');
  const plan=await makePlan(folder,'https://www.acx.com/titleview/TEST');
  browser=await chromium.launch({channel:'chrome',headless:true});
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await waitForUploadPage(page,page.url()),true);
  assert.equal(await waitForUploadPage(page,page.url()+'wrong-title',100),false);
  await page.evaluate(()=>{document.querySelector('#add').disabled=true;});
  assert.equal(await waitForUploadPage(page,page.url(),100),false);
  await page.evaluate(()=>{setTimeout(()=>{document.querySelector('#add').disabled=false;},100);});
  assert.equal(await waitForUploadPage(page,page.url()),true);
  let uploads=0;
  const options={page,plan,timeoutMs:10000,statePath:path.join(folder,'state.json'),currentUrl:()=>plan.url,reload:()=>page.reload(),upload:async(button,file)=>{
    const [chooser]=await Promise.all([page.waitForEvent('filechooser'),button.click()]);
    await chooser.setFiles(file); uploads++;
  }};
  await runUpload(options);
  await runUpload(options);
  assert.equal(uploads,3,'resume should not re-upload completed files');
  assert.equal(await page.getByRole('textbox',{name:'Chapter name',exact:true}).count(),3);
  console.log('PASS: real Playwright added/uploaded three rows, reloaded, and resumed without duplicates.');
} finally {
  await browser?.close(); await new Promise(resolve=>server.close(resolve));
  await rm(folder,{recursive:true,force:true});
}
