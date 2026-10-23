'use strict';
// Moteur : conversion, compression intelligente et archivage.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { spawn } = require('child_process');
const F = require('./formats');

let _sharp;
function sharp(...args) {
  if (!_sharp) { _sharp = require('sharp'); _sharp.cache(false); }
  return _sharp(...args);
}
const FFMPEG = () => require('ffmpeg-static');
const SEVEN = () => require('7zip-bin').path7za;
const Q7 = ['-bso0', '-bsp0', '-y'];
// Garde-fous pour un usage public.
const TIMEOUT = (Number(process.env.JOB_TIMEOUT_MIN) || 20) * 60 * 1000;
const MAX_EXTRACT = (Number(process.env.MAX_EXTRACT_MB) || 4096) * 1024 * 1024;
const MAX_ENTRIES = 20000;
// Sur une petite machine, le 7z « ultra » dépasse 700 Mo de mémoire : on borne le dictionnaire.
const SEVENZ_MEM = process.env.SEVENZ_DICT_MB ? [`-md=${Number(process.env.SEVENZ_DICT_MB)}m`, '-mmt=1'] : [];

/* ---------- utilitaires ---------- */

function run(cmd, args, { cwd, onStderr, capture } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true });
    let err = '';
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; p.kill('SIGKILL'); }, TIMEOUT);
    p.stdout.on('data', (d) => { if (capture) out += d.toString(); });
    p.stderr.on('data', (d) => {
      const s = d.toString();
      err = (err + s).slice(-6000);
      if (onStderr) onStderr(s);
    });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new Error('Le traitement a pris trop de temps.'));
      if (code === 0) return resolve(out);
      const last = err.trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' — ');
      reject(new Error(last || `${path.basename(cmd)} a échoué (code ${code})`));
    });
  });
}

function ffmpeg(args, job) {
  let duration = 0;
  return runFfmpeg(args, job, (d) => { duration = d; }, () => duration).catch((e) => {
    console.error('ffmpeg:', e.message);
    if (/trop de temps/.test(e.message)) throw e;
    throw new Error('Ce fichier est illisible ou endommagé.');
  });
}

function runFfmpeg(args, job, setDuration, getDuration) {
  return run(FFMPEG(), ['-hide_banner', '-y', ...args], {
    onStderr(s) {
      const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s);
      if (d) setDuration(+d[1] * 3600 + +d[2] * 60 + +d[3]);
      const duration = getDuration();
      const all = [...s.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
      const t = all[all.length - 1];
      if (t && duration && job) {
        const cur = +t[1] * 3600 + +t[2] * 60 + +t[3];
        job.progress = Math.max(0, Math.min(0.99, cur / duration));
      }
    },
  });
}

const read = (p) => fsp.readFile(p, 'utf8').then((s) => s.replace(/^\uFEFF/, ''));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const baseOf = (name) => {
  const m = /\.tar\.(gz|bz2|xz)$/i.exec(name);
  const cut = m ? m[0].length : path.extname(name).length;
  return name.slice(0, name.length - cut) || 'fichier';
};

async function walk(dir) {
  const out = [];
  for (const d of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

function finish(job, file, name, note) {
  job.output = file;
  job.outputName = name;
  job.outputSize = fs.statSync(file).size;
  job.inputSize = job.inputs.reduce((a, b) => a + b.size, 0);
  if (note) job.note = note;
}

/* ---------- images ---------- */

const QUALITY = {
  jpg: { light: 85, balanced: 75, max: 60 },
  png: { light: null, balanced: 80, max: 60 },
  webp: { light: 82, balanced: 70, max: 55 },
  avif: { light: 62, balanced: 50, max: 38 },
  gif: { light: 90, balanced: 75, max: 55 },
  tiff: { light: 85, balanced: 75, max: 60 },
};
const MAXDIM = { light: null, balanced: 3840, max: 2560 };

function encode(img, t, q) {
  switch (t) {
    case 'jpg': return img.flatten({ background: '#ffffff' }).jpeg({ quality: q ?? 92, mozjpeg: true });
    case 'png': return q
      ? img.png({ palette: true, quality: q, compressionLevel: 9, effort: 10 })
      : img.png({ compressionLevel: 9, adaptiveFiltering: true });
    case 'webp': return img.webp({ quality: q ?? 90, effort: 5 });
    case 'avif': return img.avif({ quality: q ?? 64, effort: 4 });
    case 'tiff': return img.tiff(q ? { compression: 'jpeg', quality: q } : { compression: 'lzw' });
    case 'gif': return img.gif(q ? { effort: 8, colours: q > 80 ? 256 : q > 60 ? 128 : 64, dither: 0.8 } : { effort: 7 });
    default: throw new Error(`Format image non géré : ${t}`);
  }
}

async function imageSource(input, ext, dir) {
  if (ext === 'heic') {
    const convert = require('heic-convert');
    return Buffer.from(await convert({ buffer: await fsp.readFile(input), format: 'PNG' }));
  }
  if (['bmp', 'ico', 'tga'].includes(ext)) {
    const tmp = path.join(dir, `src-${Date.now()}.png`);
    await ffmpeg(['-i', input, '-frames:v', '1', tmp]);
    return tmp;
  }
  return input;
}

function openImage(src, ext, animated) {
  const opts = { animated };
  if (ext === 'svg') opts.density = 192;
  return sharp(src, opts).rotate();
}

async function convertImage(job, input, ext, t, out) {
  const src = await imageSource(input, ext, job.dir);
  const animated = ['gif', 'webp'].includes(ext) && ['gif', 'webp'].includes(t);
  let img = openImage(src, ext, animated);

  if (t === 'pdf') {
    const { PDFDocument } = require('pdf-lib');
    const { data, info } = await img.flatten({ background: '#ffffff' }).jpeg({ quality: 92 }).toBuffer({ resolveWithObject: true });
    const pdf = await PDFDocument.create();
    const jpg = await pdf.embedJpg(data);
    const w = info.width * 0.75; const h = info.height * 0.75;
    pdf.addPage([w, h]).drawImage(jpg, { x: 0, y: 0, width: w, height: h });
    return fsp.writeFile(out, await pdf.save());
  }
  if (t === 'bmp' || t === 'ico') {
    img = t === 'ico'
      ? img.resize(256, 256, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      : img.flatten({ background: '#ffffff' });
    const tmp = path.join(job.dir, 'tmp-out.png');
    await img.png().toFile(tmp);
    return ffmpeg(['-i', tmp, ...(t === 'bmp' ? ['-pix_fmt', 'bgr24'] : []), out]);
  }
  await encode(img, t, null).toFile(out);
}

/* ---------- audio / vidéo ---------- */

const EVEN = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
function avArgs(t, level) {
  const crf = { light: 24, balanced: 28, max: 32 }[level] ?? 22;
  const width = { balanced: 1920, max: 1280 }[level];
  const vf = width ? `scale='trunc(min(${width},iw)/2)*2':-2` : EVEN;
  const ab = { light: '160k', balanced: '128k', max: '96k' }[level] ?? '192k';
  const x264 = ['-vf', vf, '-c:v', 'libx264', '-preset', level ? 'slow' : 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', ab];
  switch (t) {
    case 'mp4': case 'mov': case 'm4v': return [...x264, '-movflags', '+faststart'];
    case 'mkv': return x264;
    case 'webm': return ['-vf', vf, '-c:v', 'libvpx-vp9', '-crf', String(level ? crf + 6 : 31), '-b:v', '0', '-deadline', 'good', '-cpu-used', '4', '-row-mt', '1', '-c:a', 'libopus', '-b:a', ab];
    case 'avi': return ['-vf', vf, '-c:v', 'mpeg4', '-q:v', '4', '-c:a', 'libmp3lame', '-b:a', ab];
    case 'gif': return ['-vf', "fps=12,scale='min(640,iw)':-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse", '-loop', '0'];
    case 'mp3': return ['-vn', '-c:a', 'libmp3lame', ...(level ? ['-b:a', { light: '192k', balanced: '128k', max: '96k' }[level]] : ['-q:a', '2'])];
    case 'wav': return ['-vn', '-c:a', 'pcm_s16le'];
    case 'flac': return ['-vn', '-c:a', 'flac', '-compression_level', '12'];
    case 'ogg': return ['-vn', '-c:a', 'libvorbis', '-q:a', { light: '5', balanced: '3', max: '1' }[level] ?? '6'];
    case 'aac': case 'm4a': return ['-vn', '-c:a', 'aac', '-b:a', ab];
    case 'opus': return ['-vn', '-c:a', 'libopus', '-b:a', { light: '128k', balanced: '96k', max: '64k' }[level] ?? '128k'];
    default: throw new Error(`Format audio/vidéo non géré : ${t}`);
  }
}

async function convertAV(job, input, ext, t, out) {
  if (t === 'jpg' || t === 'png') return ffmpeg(['-i', input, '-vf', 'thumbnail', '-frames:v', '1', out], job);
  return ffmpeg(['-i', input, ...avArgs(t, null), out], job);
}

/* ---------- documents ---------- */

function toMarkdown(html) {
  const TurndownService = require('turndown');
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.remove(['script', 'style', 'head', 'noscript', 'iframe']);
  td.addRule('dataImg', { filter: (n) => n.nodeName === 'IMG' && /^data:/i.test(n.getAttribute('src') || ''), replacement: () => '' });
  return td.turndown(html);
}

function mdToPlain(md) {
  return String(md)
    .replace(/```\w*\r?\n?/g, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<!\w)([*_])(?!\s)(.+?)(?<!\s)\1(?!\w)/g, '$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^>\s?/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}

function mdToBlocks(md) {
  const blocks = []; let para = []; let code = null;
  const inline = (s) => mdToPlain(s).trim();
  const flush = () => { if (para.length) { blocks.push({ t: 'p', s: inline(para.join(' ')) }); para = []; } };
  for (const line of String(md).split(/\r?\n/)) {
    let m;
    if (code) { if (/^```/.test(line)) { blocks.push({ t: 'code', s: code.join('\n') }); code = null; } else code.push(line); continue; }
    if (/^```/.test(line)) { flush(); code = []; continue; }
    if (!line.trim()) { flush(); continue; }
    if ((m = /^(#{1,6})\s+(.*)$/.exec(line))) { flush(); blocks.push({ t: 'h' + Math.min(3, m[1].length), s: inline(m[2]) }); continue; }
    if ((m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line))) { flush(); blocks.push({ t: 'li', s: inline(m[1]) }); continue; }
    if ((m = /^>\s?(.*)$/.exec(line))) { flush(); blocks.push({ t: 'quote', s: inline(m[1]) }); continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); blocks.push({ t: 'hr' }); continue; }
    if (/^\|/.test(line)) {
      flush();
      if (/^\|?[\s:|-]+$/.test(line)) continue;
      blocks.push({ t: 'p', s: inline(line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).join('   ·   ')) });
      continue;
    }
    para.push(line.trim());
  }
  if (code) blocks.push({ t: 'code', s: code.join('\n') });
  flush();
  return blocks;
}

const textBlocks = (txt) => String(txt).split(/\r?\n\s*\r?\n/).map((s) => s.trim()).filter(Boolean).map((s) => ({ t: 'p', s }));

function fontFile(names) {
  const dirs = process.platform === 'win32'
    ? [path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts')]
    : ['/Library/Fonts', '/System/Library/Fonts/Supplemental', '/usr/share/fonts/truetype/dejavu'];
  for (const d of dirs) for (const n of names) { const p = path.join(d, n); if (fs.existsSync(p)) return p; }
  return null;
}

async function blocksToPdf(blocks, out, title) {
  const PDFDocument = require('pdfkit');
  const R = fontFile(['arial.ttf', 'Arial.ttf', 'DejaVuSans.ttf']) || 'Helvetica';
  const B = fontFile(['arialbd.ttf', 'Arial Bold.ttf', 'DejaVuSans-Bold.ttf']) || 'Helvetica-Bold';
  const M = fontFile(['consola.ttf', 'Courier New.ttf', 'DejaVuSansMono.ttf']) || 'Courier';
  const doc = new PDFDocument({ size: 'A4', margin: 64, info: { Title: title } });
  const stream = fs.createWriteStream(out);
  doc.pipe(stream);
  const W = doc.page.width - 128;
  for (const b of blocks.length ? blocks : [{ t: 'p', s: ' ' }]) {
    switch (b.t) {
      case 'h1': doc.moveDown(0.4).font(B).fontSize(22).fillColor('#111111').text(b.s, { width: W, paragraphGap: 8 }); break;
      case 'h2': doc.moveDown(0.4).font(B).fontSize(16).fillColor('#111111').text(b.s, { width: W, paragraphGap: 6 }); break;
      case 'h3': doc.moveDown(0.3).font(B).fontSize(13).fillColor('#111111').text(b.s, { width: W, paragraphGap: 4 }); break;
      case 'li': doc.font(R).fontSize(11).fillColor('#222222').text('•  ' + b.s, { width: W, paragraphGap: 3, lineGap: 2 }); break;
      case 'quote': doc.font(R).fontSize(11).fillColor('#666666').text(b.s, { width: W, paragraphGap: 8, lineGap: 2 }); break;
      case 'code': doc.font(M).fontSize(9.5).fillColor('#333333').text(b.s, { width: W, paragraphGap: 8 }); break;
      case 'hr': doc.moveDown(0.5); doc.moveTo(64, doc.y).lineTo(64 + W, doc.y).strokeColor('#dddddd').stroke(); doc.moveDown(0.5); break;
      default: doc.font(R).fontSize(11).fillColor('#222222').text(b.s, { width: W, paragraphGap: 8, lineGap: 2 });
    }
  }
  doc.end();
  await new Promise((res, rej) => { stream.on('finish', res); stream.on('error', rej); });
}

function htmlPage(title, body) {
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>body{font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;max-width:760px;margin:48px auto;padding:0 20px;color:#1d1d1f}img{max-width:100%}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:6px 10px}pre{background:#f5f5f7;padding:12px;border-radius:10px;overflow:auto}@media(prefers-color-scheme:dark){body{background:#111;color:#eee}pre{background:#222}td,th{border-color:#333}}</style></head><body>${body}</body></html>`;
}
const textToHtml = (txt) => textBlocks(txt).map((b) => `<p>${esc(b.s).replace(/\r?\n/g, '<br>')}</p>`).join('\n');

async function convertDoc(job, input, ext, t, out, title) {
  let md = null; let html = null; let plain = null;
  if (ext === 'docx') {
    const mammoth = require('mammoth');
    if (t === 'txt') plain = (await mammoth.extractRawText({ path: input })).value;
    else { html = (await mammoth.convertToHtml({ path: input })).value; md = toMarkdown(html); }
  } else if (ext === 'md') {
    md = await read(input);
    html = require('marked').marked.parse(md);
  } else if (ext === 'html') {
    const src = await read(input);
    md = toMarkdown(src.replace(/<head[\s\S]*?<\/head>/i, ''));
  } else if (ext === 'txt') {
    plain = await read(input);
  } else if (ext === 'pdf') {
    const pdfParse = require('pdf-parse/lib/pdf-parse.js');
    plain = (await pdfParse(await fsp.readFile(input))).text;
  }
  if (plain == null) plain = mdToPlain(md);

  switch (t) {
    case 'txt': return fsp.writeFile(out, plain, 'utf8');
    case 'md': return fsp.writeFile(out, md ?? plain, 'utf8');
    case 'html': return fsp.writeFile(out, htmlPage(title, html ?? (md != null ? require('marked').marked.parse(md) : textToHtml(plain))), 'utf8');
    case 'pdf': return blocksToPdf(md != null ? mdToBlocks(md) : textBlocks(plain), out, title);
    default: throw new Error(`Conversion de document non gérée : ${ext} → ${t}`);
  }
}

async function convertOffice(job, input, t, out) {
  const soffice = F.soffice();
  if (!soffice) throw new Error('LibreOffice est nécessaire pour cette conversion.');
  const outDir = path.join(job.dir, 'lo');
  await fsp.mkdir(outDir, { recursive: true });
  const filter = t === 'txt' ? 'txt:Text (encoded):UTF8' : t === 'csv' ? 'csv:Text - txt - csv (StarCalc):44,34,76' : t;
  const profile = 'file:///' + path.join(job.dir, 'lo-profile').replace(/\\/g, '/');
  await run(soffice, [`-env:UserInstallation=${profile}`, '--headless', '--norestore', '--convert-to', filter, '--outdir', outDir, input]);
  const made = (await fsp.readdir(outDir)).find((f) => f.toLowerCase().endsWith('.' + t));
  if (!made) throw new Error("LibreOffice n'a produit aucun fichier.");
  await fsp.rename(path.join(outDir, made), out);
}

/* ---------- tableurs & données ---------- */

async function convertSheet(job, input, ext, t, out) {
  const XLSX = require('xlsx');
  let wb;
  if (ext === 'json') {
    const data = JSON.parse(await read(input));
    const firstArray = data && typeof data === 'object' && !Array.isArray(data) ? Object.values(data).find(Array.isArray) : null;
    const rows = Array.isArray(data) ? data : firstArray || [data];
    const flat = rows.map((r) => (r && typeof r === 'object' ? Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v && typeof v === 'object' ? JSON.stringify(v) : v])) : { valeur: r }));
    wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(flat), 'Feuille1');
  } else if (ext === 'csv' || ext === 'tsv') {
    wb = XLSX.read(await read(input), { type: 'string', raw: false });
  } else {
    wb = XLSX.read(await fsp.readFile(input), { type: 'buffer', cellDates: true });
  }
  const first = wb.Sheets[wb.SheetNames[0]];
  let note;
  switch (t) {
    case 'csv': case 'tsv':
      if (wb.SheetNames.length > 1) note = `Seule la première feuille (« ${wb.SheetNames[0]} ») a été exportée.`;
      await fsp.writeFile(out, '\uFEFF' + XLSX.utils.sheet_to_csv(first, t === 'tsv' ? { FS: '\t' } : {}), 'utf8');
      break;
    case 'json': {
      const res = wb.SheetNames.length > 1
        ? Object.fromEntries(wb.SheetNames.map((n) => [n, XLSX.utils.sheet_to_json(wb.Sheets[n])]))
        : XLSX.utils.sheet_to_json(first);
      await fsp.writeFile(out, JSON.stringify(res, null, 2), 'utf8');
      break;
    }
    case 'html': {
      const body = wb.SheetNames.map((n) => `<h2>${esc(n)}</h2>` + XLSX.utils.sheet_to_html(wb.Sheets[n], { header: '', footer: '' })).join('\n');
      await fsp.writeFile(out, htmlPage(wb.SheetNames[0], body), 'utf8');
      break;
    }
    default:
      XLSX.writeFile(wb, out, { bookType: t, compression: true });
  }
  return note;
}

async function convertData(job, input, ext, t, out) {
  const yaml = require('js-yaml');
  const { XMLParser, XMLBuilder } = require('fast-xml-parser');
  const src = await read(input);
  const data = ext === 'json' ? JSON.parse(src)
    : ext === 'yaml' ? yaml.load(src)
      : new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' }).parse(src);
  let text;
  if (t === 'json') text = JSON.stringify(data, null, 2);
  else if (t === 'yaml') text = yaml.dump(data, { lineWidth: 120 });
  else {
    const single = data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).filter((k) => k !== '?xml').length === 1;
    const root = single ? data : { root: Array.isArray(data) ? { item: data } : data };
    text = '<?xml version="1.0" encoding="UTF-8"?>\n' + new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true }).build(root);
  }
  await fsp.writeFile(out, text, 'utf8');
}

/* ---------- archives ---------- */

// Refuse les « bombes » : archives minuscules qui se décompressent en des Go.
async function checkArchive(input) {
  let listing;
  try { listing = await run(SEVEN(), ['l', '-slt', input, '-bsp0'], { capture: true }); } catch { throw new Error('Cette archive est illisible ou endommagée.'); }
  let total = 0; let count = 0;
  for (const m of listing.matchAll(/^Size = (\d+)/gm)) { total += Number(m[1]); count++; }
  if (total > MAX_EXTRACT || count > MAX_ENTRIES) throw new Error('Cette archive est trop volumineuse une fois décompressée.');
}

async function extractAll(input, dest) {
  await checkArchive(input);
  await fsp.mkdir(dest, { recursive: true });
  await run(SEVEN(), ['x', input, `-o${dest}`, ...Q7]);
  const entries = await fsp.readdir(dest);
  if (entries.length === 1 && /\.tar$/i.test(entries[0])) {
    const tar = path.join(dest, entries[0]);
    await checkArchive(tar);
    const inner = dest + '_tar';
    await run(SEVEN(), ['x', tar, `-o${inner}`, ...Q7]);
    await fsp.rm(dest, { recursive: true, force: true });
    await fsp.rename(inner, dest);
  }
}

async function packDir(dir, fmt, out, mx = 9) {
  const z = SEVEN();
  if (fmt === 'zip') return run(z, ['a', '-tzip', `-mx=${mx}`, out, '*', ...Q7], { cwd: dir });
  if (fmt === '7z') return run(z, ['a', '-t7z', `-mx=${mx}`, ...SEVENZ_MEM, out, '*', ...Q7], { cwd: dir });
  if (fmt === 'tar') return run(z, ['a', '-ttar', out, '*', ...Q7], { cwd: dir });
  if (fmt === 'tar.gz') {
    const tar = out.replace(/\.gz$/i, '');
    await run(z, ['a', '-ttar', tar, '*', ...Q7], { cwd: dir });
    await run(z, ['a', '-tgzip', `-mx=${mx}`, out, tar, ...Q7]);
    return fsp.rm(tar, { force: true });
  }
  throw new Error(`Format d'archive inconnu : ${fmt}`);
}

function packFile(input, fmt, out, mx = 9) {
  const type = { zip: 'zip', '7z': '7z', gz: 'gzip' }[fmt];
  return run(SEVEN(), ['a', `-t${type}`, `-mx=${mx}`, ...(type === '7z' ? SEVENZ_MEM : []), out, path.basename(input), ...Q7], { cwd: path.dirname(input) });
}

/* ---------- conversion ---------- */

async function convert(job) {
  const inp = job.inputs[0];
  const ext = F.extOf(inp.name);
  const t = job.target;
  const via = F.routeFor(ext, t);
  if (!via) throw new Error(`Impossible de convertir .${ext} en .${t}.`);
  const outDir = path.join(job.dir, 'out');
  const outName = via === 'pack' ? `${inp.name}.${t}` : `${baseOf(inp.name)}.${t}`;
  const out = path.join(outDir, outName);
  let note;
  switch (via) {
    case 'image': await convertImage(job, inp.path, ext, t, out); break;
    case 'av': await convertAV(job, inp.path, ext, t, out); break;
    case 'doc': await convertDoc(job, inp.path, ext, t, out, baseOf(inp.name)); break;
    case 'office': await convertOffice(job, inp.path, t, out); break;
    case 'sheet': note = await convertSheet(job, inp.path, ext, t, out); break;
    case 'data': await convertData(job, inp.path, ext, t, out); break;
    case 'archive': {
      const x = path.join(job.dir, 'x');
      await extractAll(inp.path, x);
      await packDir(x, t, out, 9);
      break;
    }
    case 'pack': await packFile(inp.path, t, out, 9); break;
    default: throw new Error('Route inconnue.');
  }
  finish(job, out, outName, note);
}

/* ---------- compression intelligente ---------- */

const VIDEO_KEEP = ['mp4', 'mov', 'mkv', 'webm', 'm4v'];
const OFFICE_ZIP = ['docx', 'xlsx', 'pptx', 'xlsm', 'odt', 'ods', 'odp', 'odg'];

async function compressOffice(job, inp, ext, level, out) {
  const dir = path.join(job.dir, 'x');
  await checkArchive(inp.path);
  await fsp.mkdir(dir, { recursive: true });
  await run(SEVEN(), ['x', inp.path, `-o${dir}`, ...Q7]);
  const dim = { light: null, balanced: 2560, max: 1600 }[level];
  for (const f of await walk(dir)) {
    const e = F.extOf(f);
    if (!['jpg', 'png'].includes(e)) continue;
    const before = (await fsp.stat(f)).size;
    if (before < 20 * 1024) continue;
    try {
      let img = sharp(await fsp.readFile(f));
      if (dim) img = img.resize(dim, dim, { fit: 'inside', withoutEnlargement: true });
      const buf = await encode(img, e, QUALITY[e][level]).toBuffer();
      if (buf.length < before) await fsp.writeFile(f, buf);
    } catch { /* image illisible : on la laisse telle quelle */ }
  }
  const z = SEVEN();
  if (ext.startsWith('od') && fs.existsSync(path.join(dir, 'mimetype'))) {
    await run(z, ['a', '-tzip', '-mx=0', out, 'mimetype', ...Q7], { cwd: dir });
    await run(z, ['a', '-tzip', '-mx=9', out, '*', '-x!mimetype', ...Q7], { cwd: dir });
  } else {
    await run(z, ['a', '-tzip', '-mx=9', out, '*', ...Q7], { cwd: dir });
  }
}

async function compress(job) {
  const inp = job.inputs[0];
  const ext = F.extOf(inp.name);
  const cat = F.catOf(ext);
  const level = ['light', 'balanced', 'max'].includes(job.level) ? job.level : 'balanced';
  const outDir = path.join(job.dir, 'out');
  const base = baseOf(inp.name);
  let outExt = ext;
  let note;
  const target = (e) => path.join(outDir, `${base}-compressé.${e}`);

  if (cat === 'image' && ext === 'svg') {
    const { optimize } = require('svgo');
    await fsp.writeFile(target('svg'), optimize(await read(inp.path), { multipass: true }).data, 'utf8');
  } else if (cat === 'image' && ext !== 'ico') {
    outExt = { bmp: 'png', tga: 'png', heic: 'jpg' }[ext] || ext;
    if (outExt !== ext) note = `Converti en .${outExt} pour gagner de la place.`;
    const src = await imageSource(inp.path, ext, job.dir);
    let img = openImage(src, ext, ['gif', 'webp'].includes(ext));
    if (MAXDIM[level]) img = img.resize(MAXDIM[level], MAXDIM[level], { fit: 'inside', withoutEnlargement: true });
    await encode(img, outExt, QUALITY[outExt][level]).toFile(target(outExt));
  } else if (cat === 'video') {
    outExt = VIDEO_KEEP.includes(ext) ? ext : 'mp4';
    if (outExt !== ext) note = 'Converti en .mp4 pour gagner de la place.';
    await ffmpeg(['-i', inp.path, ...avArgs(outExt, level), target(outExt)], job);
  } else if (cat === 'audio') {
    if (['mp3', 'ogg', 'opus', 'm4a'].includes(ext)) outExt = ext;
    else if (ext === 'aac') outExt = 'm4a';
    else if (['wav', 'aiff', 'flac'].includes(ext)) outExt = level === 'light' ? 'flac' : 'mp3';
    else outExt = 'mp3';
    if (outExt !== ext) note = outExt === 'flac' ? 'Converti en .flac : même qualité, sans perte.' : `Converti en .${outExt} pour gagner de la place.`;
    await ffmpeg(['-i', inp.path, ...avArgs(outExt, level), target(outExt)], job);
  } else if (ext === 'pdf') {
    const { PDFDocument } = require('pdf-lib');
    const pdf = await PDFDocument.load(await fsp.readFile(inp.path), { ignoreEncryption: true, updateMetadata: false });
    await fsp.writeFile(target('pdf'), await pdf.save({ useObjectStreams: true }));
  } else if (OFFICE_ZIP.includes(ext)) {
    await compressOffice(job, inp, ext, level, target(ext));
  } else if (ext === 'json') {
    await fsp.writeFile(target('json'), JSON.stringify(JSON.parse(await read(inp.path))), 'utf8');
  } else if (cat === 'archive') {
    outExt = '7z';
    note = 'Recompressé au format .7z, le plus efficace.';
    const x = path.join(job.dir, 'x');
    await extractAll(inp.path, x);
    await packDir(x, '7z', target('7z'), 9);
  } else {
    // Tout le reste : archive 7z, la compression sans perte la plus forte.
    outExt = '7z';
    note = 'Emballé dans une archive .7z (sans perte).';
    const name = `${inp.name}.7z`;
    await packFile(inp.path, '7z', path.join(outDir, name), { light: 5, balanced: 7, max: 9 }[level]);
    return keepSmaller(job, inp, path.join(outDir, name), name, note);
  }
  return keepSmaller(job, inp, target(outExt), `${base}-compressé.${outExt}`, note);
}

async function keepSmaller(job, inp, out, name, note) {
  const after = (await fsp.stat(out)).size;
  if (after >= inp.size) {
    await fsp.copyFile(inp.path, out);
    const orig = path.join(path.dirname(out), inp.name);
    await fsp.rename(out, orig);
    return finish(job, orig, inp.name, 'Ce fichier est déjà optimisé : on te rend l’original.');
  }
  finish(job, out, name, note);
}

/* ---------- archivage multi-fichiers ---------- */

async function archive(job) {
  const fmt = ['zip', '7z', 'tar', 'tar.gz'].includes(job.format) ? job.format : 'zip';
  const mx = { light: 3, balanced: 7, max: 9 }[job.level] ?? 7;
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const name = `${job.inputs.length === 1 ? baseOf(job.inputs[0].name) : `Archive ${stamp}`}.${fmt}`;
  const out = path.join(job.dir, 'out', name);
  await packDir(path.join(job.dir, 'in'), fmt, out, mx);
  finish(job, out, name);
}

async function runJob(job) {
  if (job.op === 'convert') return convert(job);
  if (job.op === 'compress') return compress(job);
  if (job.op === 'archive') return archive(job);
  throw new Error('Opération inconnue.');
}

module.exports = { run: runJob, packDir, extOf: F.extOf };
