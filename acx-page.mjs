import path from 'node:path';

// All ACX DOM assumptions are confined to this adapter. No private endpoints.
export const ACX = Object.freeze({add:'Add chapter',chapter:'Chapter name',upload:'Upload file',chapterInput:'input[placeholder="Chapter name"]',region:'[role="region"]'});
export async function readRows(page) {
  return page.evaluate(({chapterInput,region})=>Array.from(document.querySelectorAll(chapterInput)).map(input=>{
    const container=input.closest(region);
    return {title:input.value,text:container.innerText,disabled:input.disabled,
      buttons:Array.from(container.querySelectorAll('button')).map(b=>b.getAttribute('aria-label')||b.innerText)};
  }),ACX);
}
export function rowStatus(row,file) {
  if(!row) return 'missing';
  const text=row.text.split('\n').filter(line=>!line.trim().toLowerCase().endsWith('.mp3')).join('\n');
  if(/\b(error|failed|failure)\b/i.test(text)) return 'error';
  if(row.disabled || /Analyzing file|Uploading|\d+%/i.test(text)) return 'busy';
  if(row.buttons.includes(ACX.upload)) return 'empty';
  if(row.text.split('\n').some(line=>line.trim()===path.basename(file)) && /\d+:\d{2}/.test(text)) return 'uploaded';
  return 'unknown';
}
export async function waitForUploadPage(page,url,timeout=8000) {
  try {
    await page.waitForFunction(({url,add})=>location.href===url && Array.from(document.querySelectorAll('button')).some(b=>(b.getAttribute('aria-label')||b.textContent).trim()===add && !b.disabled && b.getClientRects().length>0),{url,add:ACX.add},{timeout});
    return true;
  } catch(error) {if(error.name==='TimeoutError') return false;throw error;}
}
export function createACXPage({page,currentUrl,reload,upload}) {
  const input=()=>page.getByRole('textbox',{name:ACX.chapter,exact:true});
  return {
    url:currentUrl,reload,status:rowStatus,
    listSections:()=>readRows(page),
    ready:()=>page.getByRole('button',{name:ACX.add,exact:true}).waitFor({state:'visible'}),
    addSection:()=>page.getByRole('button',{name:ACX.add,exact:true}).click(),
    async nameSection(index,title) {await input().nth(index).fill(title);await input().nth(index).press('Tab');},
    uploadFile(index,file) {return upload(page.getByRole('region').filter({has:input()}).nth(index).getByRole('button',{name:ACX.upload,exact:true}),file);},
  };
}
export async function getProject(page) {
  const url=page.url();
  if(!/^https:\/\/www\.acx\.com\/titleview\/[A-Z0-9]+$/.test(url)) throw new Error('Open an ACX title and its finished-audio page in Chrome first.');
  if(!await waitForUploadPage(page,url)) throw new Error('Open Produce audiobook → Produce finished audio, then try again.');
  const info=await page.evaluate(()=>{const image=document.querySelector('main img[alt]');return {title:image?.alt||'',cover:image?.src||''};});
  return {url,title:info.title||url.split('/').at(-1),cover:info.cover};
}
