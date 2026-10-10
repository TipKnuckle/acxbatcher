import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { makePlan, validatePlan } from './plan.mjs';
import { waitForUploadPage } from './readiness.mjs';

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  folder: {type:'string'}, url: {type:'string'}, out: {type:'string'}, limit: {type:'string'},
  execute: {type:'boolean', default:false}, profile: {type:'string'},
} });
try {
  if (positionals[0] === 'plan') {
    if (!values.folder || !values.url) throw new Error('plan requires --folder and --url.');
    const plan = await makePlan(values.folder, values.url, values.limit ? Number(values.limit) : Infinity);
    const output = path.resolve(values.out || 'upload-plan.json');
    await writeFile(output, JSON.stringify(plan, null, 2) + '\n', {flag:'wx'});
    console.table(plan.items.map((x,i) => ({order:i+1, title:x.title, MB:(x.bytes/1e6).toFixed(1)})));
    console.log(`Saved ${output}. ${plan.items.length} MP3 files selected in natural filename order. No files renamed or uploaded.`);
  } else if (positionals[0] === 'upload') {
    if (!positionals[1]) throw new Error('upload requires a plan JSON path.');
    const planPath = path.resolve(positionals[1]);
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    await validatePlan(plan);
    console.table(plan.items.map((x,i) => ({order:i+1, title:x.title, file:x.file})));
    if (!values.execute) console.log('Preview only. Add --execute to upload.');
    else {
      const { chromium } = await import('playwright');
      const { runUpload } = await import('./uploader.mjs');
      const profile = path.resolve(values.profile || '.acx-profile');
      await mkdir(profile, {recursive:true,mode:0o700});
      const context = await chromium.launchPersistentContext(profile, {channel:'chrome',headless:false});
      try {
        const page = context.pages()[0] || await context.newPage();
        page.setDefaultTimeout(30000);
        await page.goto(plan.url, {waitUntil:'domcontentloaded'});
        console.log('Checking whether the ACX upload page is ready…');
        if (!await waitForUploadPage(page, plan.url)) {
          const terminal = createInterface({input:process.stdin, output:process.stdout});
          try { await terminal.question('In the Chrome window, sign in and open this title’s Produce audiobook → Produce finished audio page. Press Enter when ready. '); }
          finally { terminal.close(); }
          if (!await waitForUploadPage(page, plan.url)) throw new Error('The planned title’s upload page is not ready. Check the Chrome window and rerun.');
        }
        console.log('Upload page ready. Starting batch.');
        await runUpload({page, plan, statePath:planPath + '.state.json',
          currentUrl:() => page.url(), reload:() => page.reload(),
          upload:async (button,file) => {
            const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
            await chooser.setFiles(file);
          }});
      } finally { await context.close(); }
    }
  } else console.log('Usage:\n  npm run acx -- plan --folder PATH --url ACX_URL [--limit 3] [--out plan.json]\n  npm run acx -- upload plan.json [--execute]');
} catch (error) { console.error(error.message); process.exitCode = 1; }
