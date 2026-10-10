import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const filenameOrder = new Intl.Collator('en', {numeric:true, sensitivity:'base'});
function compareFilenames(a,b) {
  return filenameOrder.compare(a,b) || (a < b ? -1 : a > b ? 1 : 0);
}

export function displayTitle(filename) {
  return filename.replace(/\.mp3$/i, '').replace(/^\d+\s*[-–—_.]\s*/, '');
}

export async function makePlan(folder, url, limit = Infinity) {
  if (!/^https:\/\/www\.acx\.com\/titleview\/[A-Z0-9]+$/.test(url)) throw new Error('Use the exact ACX titleview URL.');
  if (!(limit > 0)) throw new Error('Limit must be positive.');
  const names = await readdir(folder);
  const chapters = names.filter(n => /\.mp3$/i.test(n))
    .sort(compareFilenames);
  const items = [];
  for (const name of chapters.slice(0, limit)) {
    const file = path.resolve(folder, name);
    const info = await stat(file);
    if (!info.isFile() || !info.size) throw new Error(`Not a nonempty file: ${file}`);
    items.push({ title: displayTitle(name), file, bytes: info.size, mtimeMs: info.mtimeMs });
  }
  if (!items.length) throw new Error('No MP3 files found.');
  return { version: 1, url, items, excluded: names.filter(n => /\.mp3$/i.test(n) && !chapters.includes(n)) };
}

export async function validatePlan(plan) {
  if (plan.version !== 1 || !/^https:\/\/www\.acx\.com\/titleview\/[A-Z0-9]+$/.test(plan.url)) throw new Error('Invalid plan or ACX URL.');
  if (!Array.isArray(plan.items) || !plan.items.length) throw new Error('Plan has no chapters.');
  const titles = new Set(), files = new Set();
  for (const item of plan.items) {
    if (typeof item.title !== 'string' || !item.title.trim() || item.title.length > 100 || titles.has(item.title)) throw new Error(`Invalid/duplicate chapter title: ${item.title}`);
    if (!path.isAbsolute(item.file) || files.has(item.file)) throw new Error(`Invalid/duplicate file: ${item.file}`);
    const info = await stat(item.file);
    if (!info.isFile() || !info.size || info.size !== item.bytes || info.mtimeMs !== item.mtimeMs) throw new Error(`Source changed since plan creation: ${item.file}`);
    titles.add(item.title); files.add(item.file);
  }
}
