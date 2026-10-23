'use strict';
// Table des formats : quelles extensions on sait lire, et vers quoi on sait les convertir.
const fs = require('fs');
const path = require('path');

const ALIASES = {
  jpeg: 'jpg', jfif: 'jpg', jpe: 'jpg', tif: 'tiff', htm: 'html', yml: 'yaml',
  markdown: 'md', mpg: 'mpeg', aif: 'aiff', tgz: 'tar.gz', heif: 'heic', oga: 'ogg',
};

function extOf(name) {
  const n = String(name).toLowerCase();
  const m = /\.(tar\.(?:gz|bz2|xz))$/.exec(n);
  if (m) return m[1];
  const e = path.extname(n).slice(1);
  return ALIASES[e] || e;
}

const IMAGE_IN = ['jpg', 'png', 'webp', 'avif', 'tiff', 'gif', 'svg', 'heic', 'bmp', 'ico', 'tga'];
const IMAGE_OUT = ['jpg', 'png', 'webp', 'avif', 'tiff', 'gif', 'bmp', 'ico', 'pdf'];
const VIDEO_IN = ['mp4', 'mov', 'mkv', 'avi', 'webm', 'flv', 'wmv', 'm4v', 'mpeg', '3gp', 'ts', 'mts', 'm2ts', 'ogv'];
const VIDEO_OUT = ['mp4', 'webm', 'mkv', 'mov', 'avi', 'gif', 'mp3', 'wav', 'm4a', 'ogg', 'flac', 'jpg', 'png'];
const AUDIO_IN = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus', 'wma', 'aiff', 'amr'];
const AUDIO_OUT = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus'];
const SHEET_IN = ['csv', 'tsv', 'xlsx', 'xls', 'xlsm', 'ods', 'numbers'];
const SHEET_OUT = ['xlsx', 'csv', 'tsv', 'ods', 'xls', 'json', 'html'];
const ARCHIVE_IN = ['zip', '7z', 'tar', 'tar.gz', 'tar.bz2', 'tar.xz', 'gz', 'bz2', 'xz', 'cab'];
const ARCHIVE_OUT = ['zip', '7z', 'tar', 'tar.gz'];
const UNIVERSAL = ['zip', '7z', 'gz'];

const LO_TEXT = ['doc', 'docx', 'odt', 'rtf', 'wpd', 'pages', 'txt', 'html'];
const LO_SLIDES = ['ppt', 'pptx', 'odp', 'key'];

const CATEGORY = {};
const tag = (cat, list) => list.forEach((e) => { CATEGORY[e] ??= cat; });
tag('image', IMAGE_IN);
tag('video', VIDEO_IN);
tag('audio', AUDIO_IN);
tag('sheet', SHEET_IN);
tag('data', ['json', 'yaml', 'xml']);
tag('document', ['pdf', 'docx', 'doc', 'odt', 'rtf', 'txt', 'md', 'html', 'pages', 'wpd', ...LO_SLIDES]);
tag('archive', ARCHIVE_IN);

function catOf(ext) { return CATEGORY[ext] || 'other'; }

function soffice() {
  const candidates = [
    process.env.SOFFICE_PATH,
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/usr/bin/soffice', '/usr/bin/libreoffice',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || null;
}

function rules() {
  const lo = soffice();
  const R = [];
  // LibreOffice rend mieux Word/HTML → PDF : prioritaire quand il est installé.
  if (lo) R.push({ via: 'office', from: ['docx', 'html'], to: ['pdf'] });
  R.push(
    { via: 'image', from: IMAGE_IN, to: IMAGE_OUT },
    { via: 'av', from: VIDEO_IN, to: VIDEO_OUT },
    { via: 'av', from: AUDIO_IN, to: AUDIO_OUT },
    { via: 'doc', from: ['docx'], to: ['pdf', 'html', 'md', 'txt'] },
    { via: 'doc', from: ['md'], to: ['pdf', 'html', 'txt'] },
    { via: 'doc', from: ['html'], to: ['pdf', 'md', 'txt'] },
    { via: 'doc', from: ['txt'], to: ['pdf', 'html', 'md'] },
    { via: 'doc', from: ['pdf'], to: ['txt', 'md', 'html'] },
    { via: 'sheet', from: SHEET_IN, to: SHEET_OUT },
    { via: 'sheet', from: ['json'], to: ['xlsx', 'csv', 'ods'] },
    { via: 'data', from: ['json'], to: ['yaml', 'xml'] },
    { via: 'data', from: ['yaml'], to: ['json', 'xml'] },
    { via: 'data', from: ['xml'], to: ['json', 'yaml'] },
    { via: 'archive', from: ARCHIVE_IN, to: ARCHIVE_OUT },
  );
  if (lo) {
    R.push(
      { via: 'office', from: LO_TEXT, to: ['pdf', 'docx', 'odt', 'rtf', 'doc', 'txt', 'html'] },
      { via: 'office', from: LO_SLIDES, to: ['pdf', 'pptx', 'odp', 'ppt'] },
      { via: 'office', from: ['xls', 'xlsx', 'xlsm', 'ods', 'csv'], to: ['pdf'] },
    );
  }
  return R;
}

function targetsFor(ext, R = rules()) {
  const out = [];
  for (const r of R) if (r.from.includes(ext)) for (const t of r.to) if (t !== ext && !out.includes(t)) out.push(t);
  for (const t of UNIVERSAL) if (!out.includes(t) && t !== ext) out.push(t);
  return out;
}

function routeFor(ext, target, R = rules()) {
  const r = R.find((x) => x.from.includes(ext) && x.to.includes(target));
  if (r) return r.via;
  if (UNIVERSAL.includes(target)) return 'pack';
  return null;
}

function capabilities() {
  const R = rules();
  const all = [...new Set(R.flatMap((r) => r.from))];
  const formats = {};
  for (const e of all) formats[e] = { cat: catOf(e), targets: targetsFor(e, R) };
  const groups = {};
  for (const [e, f] of Object.entries(formats)) {
    const g = (groups[f.cat] ??= { inputs: [], outputs: [] });
    g.inputs.push(e);
    for (const t of f.targets) if (!UNIVERSAL.includes(t) && !g.outputs.includes(t)) g.outputs.push(t);
  }
  return { formats, universal: UNIVERSAL, aliases: ALIASES, groups, libreoffice: !!soffice() };
}

module.exports = { extOf, catOf, targetsFor, routeFor, capabilities, soffice, UNIVERSAL };
