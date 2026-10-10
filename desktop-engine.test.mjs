import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createInterface} from 'node:readline';
import os from 'node:os';
import path from 'node:path';
test('desktop protocol imports every MP3 naturally and shuts down without launching Chrome',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'acx-desktop-'));
  const child=spawn(process.execPath,['desktop-engine.mjs',path.join(root,'support')],{stdio:['pipe','pipe','pipe']});
  const exit=new Promise(resolve=>child.once('exit',resolve));
  try {
    await writeFile(path.join(root,'010 - Closing credits.mp3'),'fixture');
    await writeFile(path.join(root,'002 - Opening credits.mp3'),'fixture');
    await writeFile(path.join(root,'notes.txt'),'ignored');
    const result=await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Engine protocol timed out')),10000);
      const lines=createInterface({input:child.stdout});
      lines.on('line',line=>{
        const event=JSON.parse(line);
        if(event.type==='ready') child.stdin.write(JSON.stringify({id:'import',action:'import',paths:[root],strip:true})+'\n');
        if(event.id==='import') {clearTimeout(timeout);lines.close();resolve(event);}
      });
    });
    assert.equal(result.type,'result');
    assert.deepEqual(result.data.map(x=>x.title),['Opening credits','Closing credits']);
    assert.ok(result.data.every(x=>x.bytes===7&&x.mtimeMs>0));
    child.stdin.write(JSON.stringify({action:'shutdown'})+'\n');
    assert.equal(await exit,0);
  } finally {child.kill();await rm(root,{recursive:true,force:true});}
});
