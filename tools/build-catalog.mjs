// Builds catalog.json (and missing thumbnails) from the GLB files in /models.
//
//   models/<id>.glb             required — the model
//   models/<id>.json            optional — { "title", "description", "size", "order", "hidden" }
//   models/<id>.png|jpg|webp    optional — your own thumbnail (otherwise one is rendered)
//
// Run locally with:  npm install && npx playwright install chromium && npm run build
// On GitHub this runs automatically on every push (see .github/workflows/catalog.yml).

import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS = path.join(ROOT, 'models');
const THUMBS = path.join(ROOT, 'thumbs');
const CATALOG = path.join(ROOT, 'catalog.json');
const WARN_MB = 15;

const warnings = [];
const warn = (msg) => { warnings.push(msg); console.warn('⚠ ' + msg); };

// --- GLB inspection (no dependencies) ------------------------------------
function inspectGlb(buf, file) {
  if (buf.length < 20 || buf.toString('ascii', 0, 4) !== 'glTF') throw new Error(`${file} is not a binary glTF (.glb) file`);
  const jsonLen = buf.readUInt32LE(12);
  const json = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  let triangles = 0;
  for (const mesh of json.meshes || []) {
    for (const prim of mesh.primitives || []) {
      const mode = prim.mode ?? 4;
      if (mode !== 4) continue;
      const acc = prim.indices !== undefined ? json.accessors[prim.indices] : json.accessors[prim.attributes.POSITION];
      triangles += Math.floor((acc?.count || 0) / 3);
    }
  }
  return {
    animations: (json.animations || []).map((a, i) => a.name || `Animation ${i + 1}`),
    triangles,
    extensions: json.extensionsUsed || [],
  };
}

// --- tiny static server for the thumbnail renderer ------------------------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.glb': 'model/gltf-binary', '.wasm': 'application/wasm', '.json': 'application/json' };
function serve() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = path.join(ROOT, decodeURIComponent(new URL(req.url, 'http://x').pathname));
      if (!p.startsWith(ROOT) || !existsSync(p)) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
      createReadStream(p).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function renderThumbnails(jobs) {
  if (!jobs.length) return;
  const { chromium } = await import('playwright');
  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 384, height: 384 } });
  for (const job of jobs) {
    await page.goto(`http://127.0.0.1:${port}/tools/thumb.html?model=${encodeURIComponent('/models/' + job.file)}`);
    await page.waitForFunction(() => window.__done === true, null, { timeout: 120000 });
    const error = await page.evaluate(() => window.__error);
    if (error) { warn(`Could not render a thumbnail for ${job.file}: ${error}`); continue; }
    await page.locator('canvas').screenshot({ path: job.out, omitBackground: true });
    console.log(`  rendered thumbs/${path.basename(job.out)}`);
  }
  await browser.close();
  server.close();
}

// --- main -------------------------------------------------------------------
await fs.mkdir(THUMBS, { recursive: true });
const files = (await fs.readdir(MODELS)).sort();
const glbs = files.filter((f) => f.toLowerCase().endsWith('.glb'));
if (!glbs.length) warn('No .glb files in /models.');

const entries = [];
const thumbJobs = [];
for (const file of glbs) {
  const id = file.slice(0, -4);
  const full = path.join(MODELS, file);
  const buf = await fs.readFile(full);
  let info;
  try { info = inspectGlb(buf, file); } catch (e) { warn(e.message); continue; }

  let meta = {};
  if (files.includes(`${id}.json`)) {
    try { meta = JSON.parse(await fs.readFile(path.join(MODELS, `${id}.json`), 'utf8')); }
    catch (e) { warn(`models/${id}.json is not valid JSON (${e.message}); using defaults.`); }
  }
  if (meta.hidden) { console.log(`  skipped ${file} (hidden)`); continue; }

  const mb = buf.length / 1048576;
  if (mb > WARN_MB) warn(`${file} is ${mb.toFixed(1)} MB; phones may struggle. Consider compressing it (e.g. gltf-transform optimize).`);
  if (!info.animations.length) console.log(`  note: ${file} has no animation`);

  // Thumbnail: your own image wins; otherwise render one (re-render when the GLB changes).
  const version = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 10);
  const own = ['png', 'jpg', 'jpeg', 'webp'].map((ext) => `${id}.${ext}`).find((f) => files.includes(f));
  let thumbnail;
  if (own) {
    thumbnail = `models/${own}`;
  } else {
    const out = path.join(THUMBS, `${id}-${version}.png`);
    thumbnail = `thumbs/${id}-${version}.png`;
    if (!existsSync(out)) thumbJobs.push({ file, out });
  }

  entries.push({
    id,
    title: String(meta.title || id),
    description: meta.description ? String(meta.description) : '',
    file: `models/${file}?v=${version}`,
    thumbnail,
    size: Number(meta.size) > 0 ? Number(meta.size) : 1,
    order: Number.isFinite(Number(meta.order)) ? Number(meta.order) : 1000,
    animations: info.animations,
    triangles: info.triangles,
    megabytes: +mb.toFixed(2),
    extensions: info.extensions,
  });
}

await renderThumbnails(thumbJobs);

// Remove rendered thumbnails that no longer belong to any model version.
const keep = new Set(entries.map((e) => e.thumbnail).filter((t) => t.startsWith('thumbs/')).map((t) => t.slice(7)));
for (const f of await fs.readdir(THUMBS)) {
  if (!keep.has(f)) { await fs.unlink(path.join(THUMBS, f)); console.log(`  removed old thumbs/${f}`); }
}

entries.sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));
const catalog = {
  updated: new Date().toISOString(),
  models: entries.map(({ order, ...e }) => e),
};
await fs.writeFile(CATALOG, JSON.stringify(catalog, null, 2) + '\n');
console.log(`catalog.json: ${entries.length} model(s)${warnings.length ? `, ${warnings.length} warning(s)` : ''}`);
for (const e of entries) console.log(`  • ${e.title}  (${e.megabytes} MB, ${e.triangles.toLocaleString()} triangles, ${e.animations.length ? 'animated' : 'static'})`);
