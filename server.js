'use strict';
// Prisme — serveur. En local il n'écoute que sur 127.0.0.1 ; en ligne, on règle HOST=0.0.0.0.
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const formats = require('./lib/formats');
const engine = require('./lib/engine');

/* ---------- réglages (variables d'environnement) ---------- */
const PORT = Number(process.env.PORT) || 3210;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = process.env.PUBLIC ? process.env.PUBLIC === '1' : !['127.0.0.1', 'localhost', '::1'].includes(HOST);
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB) || (PUBLIC ? 500 : 4096);
const MAX_FILES = Number(process.env.MAX_FILES) || 50;
const TTL_MIN = Number(process.env.FILE_TTL_MIN) || 60;
const MAX_QUEUE = Number(process.env.MAX_QUEUE) || 40;
const RATE_LIMIT = Number(process.env.RATE_LIMIT) || (PUBLIC ? 60 : 100000); // tâches par IP toutes les 10 min
const WORK = process.env.WORK_DIR || path.join(os.tmpdir(), 'prisme');

fs.rmSync(WORK, { recursive: true, force: true });
fs.mkdirSync(path.join(WORK, '_uploads'), { recursive: true });

const app = express();
app.disable('x-powered-by');
// Derrière un hébergeur (Render, Railway, Nginx…), l'IP réelle arrive par le proxy.
if (PUBLIC) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

const upload = multer({
  dest: path.join(WORK, '_uploads'),
  limits: { fileSize: MAX_FILE_MB * 1024 * 1024, files: MAX_FILES, fields: 10, fieldSize: 1024 },
});
const jobs = new Map();

/* ---------- file d'attente ---------- */
const MAX_PARALLEL = Number(process.env.MAX_PARALLEL) || Math.max(1, Math.min(3, Math.floor(os.cpus().length / 2)));
let running = 0;
const queue = [];
function schedule(fn) { queue.push(fn); pump(); }
function pump() {
  while (running < MAX_PARALLEL && queue.length) {
    const fn = queue.shift();
    running++;
    fn().finally(() => { running--; pump(); });
  }
}

/* ---------- garde-fous ---------- */
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  });
  if (PUBLIC && req.secure) res.set('Strict-Transport-Security', 'max-age=31536000');
  next();
});

const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const list = (hits.get(req.ip) || []).filter((t) => now - t < 10 * 60 * 1000);
  if (list.length >= RATE_LIMIT) return res.status(429).json({ error: 'Trop d’envois d’un coup. Réessaie dans quelques minutes.' });
  list.push(now);
  hits.set(req.ip, list);
  next();
}
function notOverloaded(req, res, next) {
  if (queue.length >= MAX_QUEUE) return res.status(503).json({ error: 'Le service est très demandé. Réessaie dans un instant.' });
  next();
}

/* ---------- outils ---------- */
function safeName(raw) {
  let n = raw;
  const decoded = Buffer.from(raw, 'latin1').toString('utf8');
  if (!decoded.includes('�')) n = decoded;
  n = n.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_').trim();
  return n.slice(-180) || 'fichier';
}
function uniqueName(name, used) {
  let n = name; let i = 2;
  const { name: b, ext } = path.parse(name);
  while (used.has(n.toLowerCase())) n = `${b} (${i++})${ext}`;
  used.add(n.toLowerCase());
  return n;
}
const publicJob = (j) => ({
  id: j.id, status: j.status, progress: j.progress, error: j.error, note: j.note,
  outputName: j.outputName, outputSize: j.outputSize, inputSize: j.inputSize,
});
// Après traitement, on ne garde que le résultat.
async function keepOnlyOutput(dir) {
  for (const e of await fsp.readdir(dir).catch(() => [])) if (e !== 'out') await fsp.rm(path.join(dir, e), { recursive: true, force: true });
}
function dropJob(id) {
  const j = jobs.get(id);
  if (!j) return;
  jobs.delete(id);
  fsp.rm(j.dir, { recursive: true, force: true });
}

/* ---------- routes ---------- */
// Le navigateur revalide à chaque visite (réponse 304 légère) : une mise à jour est visible tout de suite.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: 0 }));

app.get('/healthz', (req, res) => res.send('ok'));

app.get('/api/capabilities', (req, res) => res.json({
  ...formats.capabilities(),
  limits: { maxFileMB: MAX_FILE_MB, maxFiles: MAX_FILES, ttlMin: TTL_MIN, public: PUBLIC },
}));

app.post('/api/jobs', rateLimit, notOverloaded, upload.array('files', MAX_FILES), async (req, res) => {
  const files = req.files || [];
  const cleanup = () => Promise.all(files.map((f) => fsp.rm(f.path, { force: true })));
  try {
    const op = String(req.body.op || 'convert');
    const target = String(req.body.target || '').toLowerCase().slice(0, 12);
    const level = String(req.body.level || 'balanced');
    const format = String(req.body.format || 'zip');
    if (!files.length) return res.status(400).json({ error: 'Aucun fichier reçu.' });
    if (!['convert', 'compress', 'archive'].includes(op)) { await cleanup(); return res.status(400).json({ error: 'Opération inconnue.' }); }
    if (op !== 'archive' && files.length !== 1) { await cleanup(); return res.status(400).json({ error: 'Un seul fichier à la fois pour cette opération.' }); }
    if (op === 'convert') {
      const ext = formats.extOf(safeName(files[0].originalname));
      if (!formats.routeFor(ext, target)) { await cleanup(); return res.status(400).json({ error: `Impossible de convertir .${ext || '?'} en .${target || '?'}.` }); }
    }

    const id = crypto.randomBytes(16).toString('hex');
    const dir = path.join(WORK, id);
    await fsp.mkdir(path.join(dir, 'in'), { recursive: true });
    await fsp.mkdir(path.join(dir, 'out'), { recursive: true });
    const used = new Set();
    const inputs = [];
    for (const f of files) {
      const name = uniqueName(safeName(f.originalname), used);
      const p = path.join(dir, 'in', name);
      await fsp.rename(f.path, p);
      inputs.push({ name, path: p, size: f.size });
    }
    const job = { id, dir, inputs, op, target, level, format, status: 'queued', progress: null, created: Date.now() };
    jobs.set(id, job);
    schedule(async () => {
      if (!jobs.has(id)) return;
      job.status = 'working';
      try {
        await engine.run(job);
        job.status = 'done';
        job.progress = 1;
      } catch (e) {
        job.status = 'error';
        const raw = e.message || String(e);
        console.error(`[${id.slice(0, 8)}] ${op} → ${target || format}: ${raw}`);
        // Jamais de chemin interne ni de jargon technique côté visiteur.
        const technical = raw.includes(WORK) || /[\\/]|errno|ENOENT|EACCES|code \d+/i.test(raw);
        job.error = technical ? 'Ce fichier n’a pas pu être traité. Il est peut-être endommagé.' : raw;
      }
      job.finished = Date.now();
      await keepOnlyOutput(dir);
      if (job.status === 'error') await fsp.rm(path.join(dir, 'out'), { recursive: true, force: true });
    });
    res.json({ id });
  } catch (e) {
    await cleanup();
    console.error(e);
    res.status(500).json({ error: 'Erreur interne. Réessaie.' });
  }
});

app.get('/api/jobs/:id', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j) return res.status(404).json({ error: 'Ce fichier a expiré. Relance le traitement.' });
  res.json(publicJob(j));
});

app.get('/api/jobs/:id/download', (req, res) => {
  const j = jobs.get(req.params.id);
  if (!j || j.status !== 'done') return res.status(404).send('Ce fichier a expiré.');
  res.download(j.output, j.outputName);
});

// Plusieurs résultats d'un coup : on les regroupe dans un zip.
app.get('/api/bundle', async (req, res) => {
  const ids = String(req.query.ids || '').split(',').filter(Boolean).slice(0, MAX_FILES);
  const done = ids.map((i) => jobs.get(i)).filter((j) => j && j.status === 'done');
  if (!done.length) return res.status(404).send('Ces fichiers ont expiré.');
  const dir = path.join(WORK, 'bundle-' + crypto.randomBytes(8).toString('hex'));
  const src = path.join(dir, 'files');
  try {
    await fsp.mkdir(src, { recursive: true });
    const used = new Set();
    for (const j of done) await fsp.copyFile(j.output, path.join(src, uniqueName(j.outputName, used)));
    const out = path.join(dir, 'Prisme.zip');
    await engine.packDir(src, 'zip', out, 1);
    res.download(out, 'Prisme.zip', () => fsp.rm(dir, { recursive: true, force: true }));
  } catch (e) {
    fsp.rm(dir, { recursive: true, force: true });
    console.error(e);
    res.status(500).send('Impossible de préparer le téléchargement.');
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = {
      LIMIT_FILE_SIZE: `Fichier trop lourd : ${MAX_FILE_MB} Mo maximum.`,
      LIMIT_FILE_COUNT: `Trop de fichiers : ${MAX_FILES} maximum.`,
    }[err.code] || 'Envoi refusé.';
    return res.status(413).json({ error: msg });
  }
  console.error(err);
  res.status(500).json({ error: 'Erreur interne. Réessaie.' });
});

/* ---------- ménage automatique ---------- */
setInterval(() => {
  const now = Date.now();
  for (const [id, j] of jobs) {
    if (j.status === 'working' || j.status === 'queued') continue;
    if (now - (j.finished || j.created) > TTL_MIN * 60 * 1000) dropJob(id);
  }
  for (const [ip, list] of hits) if (!list.some((t) => now - t < 10 * 60 * 1000)) hits.delete(ip);
}, 60 * 1000).unref();

function shutdown() {
  fs.rmSync(WORK, { recursive: true, force: true });
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n  Prisme est prêt → ${PUBLIC ? `${HOST}:${PORT} (mode public)` : url}`);
  console.log(`  Fichiers : ${MAX_FILE_MB} Mo max, supprimés après ${TTL_MIN} min`);
  console.log(`  LibreOffice : ${formats.soffice() ? 'détecté' : 'non installé (formats Office limités)'}\n`);
  if (!PUBLIC && !process.env.NO_OPEN) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  }
});
