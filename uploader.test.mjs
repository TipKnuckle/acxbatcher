import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile,access} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {makePlan,validatePlan,displayTitle} from './plan.mjs';
import {rowStatus,runUpload} from './uploader.mjs';

const url='https://www.acx.com/titleview/A1VMOLSQ4F8VZQ';
for (const stop of ['timeout','cancel']) {
  test(`${stop} releases lock; resume recognizes completed upload without sending it twice`,()=>fixture(async folder=>{
    await writeFile(path.join(folder,'Chapter 1.mp3'),'audio');
    const plan=await makePlan(folder,url), item=plan.items[0];
    let status='empty', uploads=0;
    const controller=new AbortController();
    const adapter={
      url:()=>url,ready:async()=>{},reload:async()=>{},
      listSections:async()=>[{title:item.title}],status:()=>status,
      uploadFile:async()=>{uploads++;status='busy';if(stop==='cancel') controller.abort(new Error('Stopped by user'));}
    };
    const statePath=path.join(folder,'state.json');
    const options={plan,statePath,adapter,timeoutMs:5,signal:controller.signal,log:()=>{}};
    await assert.rejects(runUpload(options),stop==='cancel'?/Stopped by user/:/Timed out/);
    await assert.rejects(access(statePath+'.lock'),{code:'ENOENT'});
    status='uploaded';
    await runUpload({...options,signal:undefined});
    assert.equal(uploads,1);
    assert.equal(JSON.parse(await readFile(statePath,'utf8')).chapters[item.title].status,'uploaded');
  }));
}
test('display titles strip only the opening numeric prefix and separator',()=>{
  assert.equal(displayTitle('001 - DR6 - Reckoning - Credits - Open.mp3'),'DR6 - Reckoning - Credits - Open');
  for(const separator of ['-', '–', '—', '_', '.']) {
    assert.equal(displayTitle(`002${separator} DR6 - Chapter 2.MP3`),'DR6 - Chapter 2');
  }
  assert.equal(displayTitle('DR6 - Chapter 2.mp3'),'DR6 - Chapter 2');
  assert.equal(displayTitle('1984 Opening Credits.mp3'),'1984 Opening Credits');
});
async function fixture(fn) {
  const folder=await mkdtemp(path.join(os.tmpdir(),'acx-test-'));
  try { await fn(folder); } finally {await rm(folder,{recursive:true,force:true});}
}
test('all MP3s including credits and samples use natural filename order',()=>fixture(async folder=>{
  for(const name of ['Book - Chapter 10.mp3','Book - Chapter 2.mp3','Book - Chapter 1.mp3','Opening credits.mp3','Retail sample.MP3','notes.txt']) await writeFile(path.join(folder,name),'audio');
  const plan=await makePlan(folder,url);
  assert.deepEqual(plan.items.map(x=>path.basename(x.file)),['Book - Chapter 1.mp3','Book - Chapter 2.mp3','Book - Chapter 10.mp3','Opening credits.mp3','Retail sample.MP3']);
  assert.deepEqual(plan.excluded,[]);
  await validatePlan(plan);
  await writeFile(plan.items[0].file,'changed audio');
  await assert.rejects(validatePlan(plan),/Source changed/);
}));
test('boxed sets use global prefixes and permit repeated chapter numbers across books',()=>fixture(async folder=>{
  for(const name of ['100 - DR9 - Desperation - Chapter 13.mp3','029 - DR7 - Deception - Chapter 1.mp3','010 - DR6 - Reckoning - Chapter 9.mp3','002 - DR6 - Reckoning - Chapter 1.mp3','001 - DR6 - Reckoning - Credits - Open.mp3']) await writeFile(path.join(folder,name),'audio');
  const plan=await makePlan(folder,url);
  assert.deepEqual(plan.items.map(x=>path.basename(x.file)),[
    '001 - DR6 - Reckoning - Credits - Open.mp3','002 - DR6 - Reckoning - Chapter 1.mp3','010 - DR6 - Reckoning - Chapter 9.mp3',
    '029 - DR7 - Deception - Chapter 1.mp3','100 - DR9 - Desperation - Chapter 13.mp3']);
  assert.equal(plan.excluded.length,0);
  await validatePlan(plan);
  assert.equal((await makePlan(folder,url,2)).items.length,2);
  await writeFile(path.join(folder,'030 - DR7 - Deception - Chapter 1 alternate.mp3'),'audio');
  assert.equal((await makePlan(folder,url)).items.length,6);
}));
test('full filenames determine order without prefix or chapter-number restrictions',()=>fixture(async folder=>{
  const expected=['001 - Book A - Chapter 1.mp3','001 - Book B - Chapter 1.mp3',
    'Book 2 - Chapter 2 alternate.mp3','Book 2 - Chapter 2.mp3','Book 2 - Chapter 10.mp3',
    'Book 10 - Chapter 1.mp3'];
  for(const name of [...expected].reverse()) await writeFile(path.join(folder,name),'audio');
  const plan=await makePlan(folder,url);
  assert.deepEqual(plan.items.map(x=>path.basename(x.file)),expected);
  await validatePlan(plan);
}));
test('completion requires exact filename and duration; processing and errors are not success',()=>{
  const row={text:'00:00\n09:02\nBook - Chapter 1.mp3',buttons:[],disabled:false};
  assert.equal(rowStatus(row,'/audio/Book - Chapter 1.mp3'),'uploaded');
  assert.equal(rowStatus(row,'/audio/Chapter 1.mp3'),'unknown');
  assert.equal(rowStatus({...row,text:'Analyzing file...'},'/audio/Book - Chapter 1.mp3'),'busy');
  assert.equal(rowStatus({...row,text:'Upload failed'},'/audio/Book - Chapter 1.mp3'),'error');
});
test('resume skips completed files; wrong title and unexpected row order fail before upload',()=>fixture(async folder=>{
  await writeFile(path.join(folder,'Chapter 1.mp3'),'audio');
  await writeFile(path.join(folder,'Chapter 2.mp3'),'audio');
  const plan=await makePlan(folder,url);
  let rows=plan.items.map(x=>({title:x.title,text:`00:00\n09:02\n${path.basename(x.file)}`,buttons:[],disabled:false}));
  let reloads=0,uploads=0;
  const page={evaluate:async()=>structuredClone(rows),getByRole:()=>({waitFor:async()=>{}})};
  const options={page,plan,statePath:path.join(folder,'state.json'),currentUrl:()=>url,reload:async()=>{reloads++;},upload:async()=>{uploads++;},log:()=>{}};
  await runUpload(options); await runUpload(options);
  assert.equal(uploads,0); assert.equal(reloads,2);
  assert.equal(Object.keys(JSON.parse(await readFile(options.statePath,'utf8')).chapters).length,2);
  await assert.rejects(runUpload({...options,currentUrl:()=>url+'X'}),/different title/);
  rows.reverse();
  await assert.rejects(runUpload(options),/planned order/);
  assert.equal(uploads,0);
}));
