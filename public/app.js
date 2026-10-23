'use strict';

/* ---------- petits outils ---------- */
const $ = (s, el = document) => el.querySelector(s);
const SVGNS = 'http://www.w3.org/2000/svg';
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(k));
  return el;
}
function icon(id, cls = '') {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', `ic ${cls}`);
  s.setAttribute('aria-hidden', 'true');
  const u = document.createElementNS(SVGNS, 'use');
  u.setAttribute('href', `#${id}`);
  s.append(u);
  return s;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
function fmtSize(b) {
  if (b == null) return '';
  const u = ['octets', 'Ko', 'Mo', 'Go'];
  let i = 0; let v = b;
  while (v >= 1024 && i < 3) { v /= 1024; i++; }
  return `${i === 0 ? v : v.toLocaleString('fr-FR', { maximumFractionDigits: v < 10 ? 1 : 0 })} ${u[i]}`;
}
const label = (ext) => (ext ? ext.toUpperCase() : '—');

/* ---------- vocabulaire de l'interface ---------- */
const MODES = {
  convert: { title: 'Convertir', sub: 'Change le format de n’importe quel fichier.', run: (n) => `Convertir ${plural(n, 'fichier')}` },
  compress: { title: 'Compresser', sub: 'Allège tes fichiers sans perdre l’essentiel.', run: (n) => `Compresser ${plural(n, 'fichier')}` },
  archive: { title: 'Archiver', sub: 'Regroupe tes fichiers dans une seule archive.', run: () => 'Créer l’archive' },
};
const CATS = {
  image: { label: 'Images', icon: 'i-photo' },
  video: { label: 'Vidéos', icon: 'i-film' },
  audio: { label: 'Audio', icon: 'i-wave' },
  document: { label: 'Documents', icon: 'i-doc' },
  sheet: { label: 'Tableurs', icon: 'i-table' },
  data: { label: 'Données', icon: 'i-braces' },
  archive: { label: 'Archives', icon: 'i-box' },
  other: { label: 'Tout le reste', icon: 'i-file' },
};
const LEVELS = {
  light: { label: 'Légère', hint: 'Qualité quasi identique.' },
  balanced: { label: 'Équilibrée', hint: 'Le meilleur compromis taille / qualité.' },
  max: { label: 'Maximale', hint: 'Le plus léger possible, quitte à perdre un peu.' },
};
const ARCHIVE_FORMATS = { zip: 'ZIP', '7z': '7Z', 'tar.gz': 'TAR.GZ' };
const PREF = {
  image: ['png', 'jpg'], video: ['mp4', 'webm'], audio: ['mp3', 'wav'], document: ['pdf', 'docx', 'txt'],
  sheet: ['xlsx', 'csv'], data: ['json', 'yaml'], archive: ['zip', '7z'], other: ['zip'],
};

const state = {
  mode: 'convert', level: 'balanced', archiveFormat: 'zip',
  items: [], caps: null, running: false, archive: null,
};

/* ---------- formats ---------- */
function extOf(name) {
  const n = name.toLowerCase();
  const m = /\.(tar\.(?:gz|bz2|xz))$/.exec(n);
  if (m) return m[1];
  const dot = n.lastIndexOf('.');
  const e = dot > 0 ? n.slice(dot + 1) : '';
  return (state.caps?.aliases || {})[e] || e;
}
function infoFor(ext) {
  return state.caps?.formats[ext] || { cat: 'other', targets: state.caps?.universal || ['zip', '7z', 'gz'] };
}
function defaultTarget(cat, targets) {
  for (const p of PREF[cat] || []) if (targets.includes(p)) return p;
  return targets[0];
}

/* ---------- ajout de fichiers ---------- */
function addFiles(fileList) {
  let files = [...fileList].filter((f) => f.size > 0 || f.type);
  const limits = state.caps?.limits;
  if (limits) {
    const tooBig = files.filter((f) => f.size > limits.maxFileMB * 1024 * 1024);
    if (tooBig.length) {
      toast(tooBig.length === 1
        ? `« ${tooBig[0].name} » est trop lourd : ${limits.maxFileMB} Mo maximum.`
        : `${plural(tooBig.length, 'fichier')} dépassent ${limits.maxFileMB} Mo et ont été ignorés.`);
      files = files.filter((f) => !tooBig.includes(f));
    }
    const room = limits.maxFiles - state.items.length;
    if (files.length > room) {
      toast(`${limits.maxFiles} fichiers maximum à la fois.`, 'i-info');
      files = files.slice(0, Math.max(0, room));
    }
  }
  if (!files.length) return;
  for (const file of files) {
    const ext = extOf(file.name);
    const { cat, targets } = infoFor(ext);
    const item = {
      id: Math.random().toString(36).slice(2), file, name: file.name, size: file.size, ext, cat, targets,
      target: defaultTarget(cat, targets), status: 'idle', progress: 0,
    };
    state.items.push(item);
    item.el = createRow(item);
    $('#list').append(item.el);
    updateRow(item);
  }
  state.archive = null;
  renderArchive();
  renderOptions();
  updateChrome();
}

function removeItem(item) {
  state.items = state.items.filter((i) => i !== item);
  item.el.classList.add('leaving');
  item.el.addEventListener('animationend', () => item.el.remove(), { once: true });
  renderOptions();
  updateChrome();
}

/* ---------- lignes ---------- */
function createRow(item) {
  const bar = h('div', { class: 'bar' }, h('i'));
  const target = h('button', { class: 'target', 'aria-haspopup': 'menu', title: 'Choisir le format de sortie' },
    h('span', { class: 'to' }, 'en'), h('span', { class: 'tv' }), icon('i-chev'));
  target.addEventListener('click', (e) => {
    e.stopPropagation();
    openPopover(target, item.targets, item.target, (t) => { item.target = t; resetItem(item); updateRow(item); updateChrome(); });
  });
  const row = h('article', { class: 'row glass' },
    h('div', { class: 'tile' }, icon(CATS[item.cat].icon)),
    h('div', { class: 'info' }, h('div', { class: 'name', title: item.name }, item.name), h('div', { class: 'meta' }), h('div', { class: 'note', hidden: true })),
    target,
    h('div', { class: 'acts' }),
    bar,
  );
  row.style.setProperty('--cat', `var(--c-${item.cat})`);
  return row;
}

function resetItem(item) {
  if (item.status === 'done' || item.status === 'error') { item.status = 'idle'; item.result = null; item.error = null; item.jobId = null; }
}

function updateRow(item, celebrate = false) {
  const row = item.el;
  const busy = item.status === 'uploading' || item.status === 'working';
  row.toggleAttribute('data-busy', busy);
  row.classList.toggle('error', item.status === 'error');
  $('.tv', row).textContent = label(item.target);

  // Ligne d'info
  const meta = $('.meta', row);
  meta.replaceChildren();
  const r = item.result;
  if (item.status === 'done' && r) {
    const outExt = extOf(r.outputName);
    const gain = r.inputSize ? Math.round((1 - r.outputSize / r.inputSize) * 100) : 0;
    meta.append(
      `${label(item.ext)} · ${fmtSize(item.size)}`, h('span', { class: 'arrow' }, '→'), `${label(outExt)} · ${fmtSize(r.outputSize)}`,
    );
    if (state.mode === 'compress' && gain > 0) {
      const badge = h('span', { class: 'badge' }, `−${gain} %`);
      meta.append(badge);
      if (celebrate) countUp(badge, gain);
    }
  } else if (item.status === 'uploading') {
    meta.append(`Envoi… ${Math.round((item.progress / 0.2) * 100)} %`);
  } else if (item.status === 'working') {
    meta.append(item.progress == null ? 'Traitement…' : `Traitement… ${Math.round(((item.progress - 0.2) / 0.8) * 100)} %`);
  } else {
    meta.append(`${label(item.ext)} · ${fmtSize(item.size)}`);
  }

  const note = $('.note', row);
  const msg = item.status === 'error' ? item.error : (item.status === 'done' && r?.note) || '';
  note.textContent = msg;
  note.hidden = !msg;

  // Progression
  const bar = $('.bar', row);
  bar.classList.toggle('indet', busy && item.progress == null);
  $('i', bar).style.width = `${Math.round((item.progress || 0) * 100)}%`;

  // Actions
  const acts = $('.acts', row);
  acts.replaceChildren();
  if (busy) {
    acts.append(h('div', { class: 'status-ic' }, h('div', { class: 'spinner', role: 'status', 'aria-label': 'En cours' })));
  } else if (item.status === 'done') {
    acts.append(h('a', { class: 'btn dl', href: `/api/jobs/${item.jobId}/download`, download: r.outputName, title: `Télécharger ${r.outputName}` },
      icon('i-down'), h('span', {}, 'Télécharger')));
  } else if (item.status === 'error') {
    acts.append(h('div', { class: 'status-ic err-ic', title: 'Échec' }, icon('i-alert')));
  }
  if (!busy && state.mode !== 'archive') {
    acts.append(h('button', { class: 'btn ghost round', title: 'Retirer', 'aria-label': `Retirer ${item.name}`, onclick: () => removeItem(item) }, icon('i-x')));
  } else if (!busy && state.mode === 'archive' && !state.running) {
    acts.append(h('button', { class: 'btn ghost round', title: 'Retirer', 'aria-label': `Retirer ${item.name}`, onclick: () => removeItem(item) }, icon('i-x')));
  }

  if (celebrate) {
    row.classList.remove('pop');
    void row.offsetWidth;
    row.classList.add('pop');
  }
}

function countUp(el, to) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const t0 = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - t0) / 700);
    el.textContent = `−${Math.round(to * (1 - (1 - p) ** 3))} %`;
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------- options selon le mode ---------- */
function segmented(options, current, onPick, small = true) {
  const seg = h('div', { class: `seg glass${small ? ' small' : ''}`, role: 'radiogroup' }, h('span', { class: 'thumb', 'aria-hidden': 'true' }));
  for (const [value, text] of Object.entries(options)) {
    seg.append(h('button', {
      role: 'radio', 'aria-selected': String(value === current), 'aria-checked': String(value === current), 'data-value': value,
      onclick: () => {
        for (const b of seg.querySelectorAll('button')) { const on = b.dataset.value === value; b.setAttribute('aria-selected', on); b.setAttribute('aria-checked', on); }
        moveThumb(seg);
        onPick(value);
      },
    }, text));
  }
  requestAnimationFrame(() => moveThumb(seg, true));
  return seg;
}

function moveThumb(seg, instant = false) {
  const thumb = $('.thumb', seg);
  const on = seg.querySelector('button[aria-selected="true"]');
  if (!thumb || !on) return;
  if (instant) thumb.style.transition = 'none';
  thumb.style.width = `${on.offsetWidth}px`;
  thumb.style.transform = `translateX(${on.offsetLeft}px)`;
  if (instant) requestAnimationFrame(() => { thumb.style.transition = ''; });
}

function renderOptions() {
  const box = $('#options');
  box.replaceChildren();
  if (state.mode === 'compress' || state.mode === 'archive') {
    const hint = h('div', { class: 'opt-hint' }, LEVELS[state.level].hint);
    const levels = Object.fromEntries(Object.entries(LEVELS).map(([k, v]) => [k, v.label]));
    box.append(h('div', { class: 'opt-group' },
      h('div', { class: 'opt-label' }, 'Compression'),
      segmented(levels, state.level, (v) => { state.level = v; hint.textContent = LEVELS[v].hint; invalidateResults(); }),
      state.mode === 'compress' ? hint : null));
  }
  if (state.mode === 'archive') {
    box.append(h('div', { class: 'opt-group' },
      h('div', { class: 'opt-label' }, 'Format'),
      segmented(ARCHIVE_FORMATS, state.archiveFormat, (v) => { state.archiveFormat = v; invalidateResults(); })));
  }
  if (state.mode === 'convert' && state.items.length > 1) {
    const all = [];
    for (const i of state.items) for (const t of i.targets) if (!all.includes(t)) all.push(t);
    const btn = h('button', { class: 'btn' }, icon('i-sparkle'), h('span', {}, 'Tout convertir en…'));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPopover(btn, all, null, (t) => {
        let n = 0;
        for (const i of state.items) if (i.targets.includes(t) && i.status !== 'working' && i.status !== 'uploading') { i.target = t; resetItem(i); updateRow(i); n++; }
        const skipped = state.items.length - n;
        if (skipped) toast(`${plural(skipped, 'fichier')} ne peu${skipped > 1 ? 'vent' : 't'} pas être converti${skipped > 1 ? 's' : ''} en ${label(t)}.`, 'i-info');
        updateChrome();
      }, 'Appliquer à tous les fichiers');
    });
    box.append(btn);
  }
}

function invalidateResults() {
  if (state.running) return;
  for (const i of state.items) { resetItem(i); updateRow(i); }
  state.archive = null;
  renderArchive();
  updateChrome();
}

/* ---------- mode ---------- */
function setMode(mode) {
  if (state.running || mode === state.mode) return;
  state.mode = mode;
  document.body.dataset.mode = mode;
  for (const b of document.querySelectorAll('#modeSeg button')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  moveThumb($('#modeSeg'));
  const title = $('#modeTitle'); const sub = $('#modeSub');
  title.textContent = MODES[mode].title;
  sub.textContent = MODES[mode].sub;
  for (const el of [title, sub]) { el.style.animation = 'none'; void el.offsetWidth; el.style.animation = ''; }
  renderOptions();
  invalidateResults();
}

/* ---------- barre d'action ---------- */
function updateChrome() {
  const items = state.items;
  document.body.classList.toggle('has-items', items.length > 0);
  $('#drop').classList.toggle('compact', items.length > 0);
  $('#drop h2').textContent = items.length ? 'Ajouter d’autres fichiers' : 'Dépose tes fichiers ici';
  $('#pickBtn').textContent = items.length ? 'Parcourir' : 'Choisir des fichiers';
  $('#pickBtn').classList.toggle('primary', !items.length);

  const pending = items.filter((i) => i.status === 'idle' || i.status === 'error');
  const done = items.filter((i) => i.status === 'done');
  const run = $('#runBtn');
  const dlAll = $('#downloadAll');
  const summary = $('#summary');

  if (state.mode === 'archive') {
    run.textContent = state.running ? 'Création…' : MODES.archive.run();
    run.disabled = state.running || !items.length || !!state.archive?.result;
    dlAll.hidden = true;
    summary.replaceChildren(h('b', {}, plural(items.length, 'fichier')), ` · ${fmtSize(items.reduce((a, i) => a + i.size, 0))}`);
  } else {
    run.textContent = state.running ? 'En cours…' : MODES[state.mode].run(pending.length || items.length);
    run.disabled = state.running || !pending.length;
    dlAll.hidden = done.length < 2;
    if (done.length >= 2) dlAll.href = `/api/bundle?ids=${done.map((i) => i.jobId).join(',')}`;
    if (done.length && state.mode === 'compress') {
      const before = done.reduce((a, i) => a + i.result.inputSize, 0);
      const after = done.reduce((a, i) => a + i.result.outputSize, 0);
      const pct = before ? Math.round((1 - after / before) * 100) : 0;
      summary.replaceChildren(h('b', {}, fmtSize(before)), ' → ', h('b', {}, fmtSize(after)), pct > 0 ? h('span', { class: 'gain' }, `  −${pct} %`) : '');
    } else if (done.length) {
      summary.replaceChildren(h('b', {}, `${done.length}/${items.length}`), ' terminés');
    } else {
      summary.replaceChildren(h('b', {}, plural(items.length, 'fichier')), ` · ${fmtSize(items.reduce((a, i) => a + i.size, 0))}`);
    }
  }
}

/* ---------- réseau ---------- */
function uploadForm(fd, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', '/api/jobs');
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total); };
    x.onload = () => {
      let j;
      try { j = JSON.parse(x.responseText); } catch { return reject(new Error('Réponse illisible du serveur.')); }
      if (x.status >= 300) return reject(new Error(j.error || 'Erreur serveur.'));
      resolve(j);
    };
    x.onerror = () => reject(new Error('Le serveur ne répond pas. Vérifie que Prisme est lancé.'));
    x.send(fd);
  });
}

async function waitJob(id, onProgress) {
  for (;;) {
    await sleep(350);
    const r = await fetch(`/api/jobs/${id}`).catch(() => null);
    if (!r) throw new Error('Connexion au serveur perdue.');
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Tâche introuvable.');
    if (j.status === 'done') return j;
    if (j.status === 'error') throw new Error(j.error || 'Échec du traitement.');
    onProgress(j.status === 'queued' ? null : j.progress);
  }
}

async function processItem(item) {
  item.status = 'uploading'; item.progress = 0; item.error = null;
  updateRow(item);
  try {
    const fd = new FormData();
    fd.append('op', state.mode);
    fd.append('target', item.target || '');
    fd.append('level', state.level);
    fd.append('files', item.file, item.name);
    const { id } = await uploadForm(fd, (p) => { item.progress = p * 0.2; updateRow(item); });
    item.jobId = id;
    item.status = 'working'; item.progress = null;
    updateRow(item);
    const job = await waitJob(id, (p) => { item.progress = p == null ? null : 0.2 + 0.8 * p; updateRow(item); });
    item.status = 'done'; item.result = job; item.progress = 1;
    updateRow(item, true);
  } catch (e) {
    item.status = 'error'; item.error = e.message;
    updateRow(item);
  }
  updateChrome();
}

async function runAll() {
  if (state.running) return;
  if (state.mode === 'archive') return runArchive();
  const todo = state.items.filter((i) => i.status === 'idle' || i.status === 'error');
  if (!todo.length) return;
  state.running = true;
  updateChrome();
  let next = 0;
  const worker = async () => { while (next < todo.length) await processItem(todo[next++]); };
  await Promise.all([worker(), worker()]);
  state.running = false;
  for (const i of state.items) if (i.status !== 'working') updateRow(i);
  updateChrome();
  const failed = todo.filter((i) => i.status === 'error').length;
  if (failed) toast(`${plural(failed, 'fichier')} n’${failed > 1 ? 'ont' : 'a'} pas pu être traité${failed > 1 ? 's' : ''}.`);
}

async function runArchive() {
  if (!state.items.length) return;
  state.running = true;
  state.archive = { status: 'working', progress: 0 };
  renderArchive(); updateChrome();
  for (const i of state.items) updateRow(i);
  try {
    const fd = new FormData();
    fd.append('op', 'archive'); fd.append('format', state.archiveFormat); fd.append('level', state.level);
    for (const i of state.items) fd.append('files', i.file, i.name);
    const { id } = await uploadForm(fd, (p) => { state.archive.progress = p * 0.6; renderArchive(); });
    state.archive.progress = null; renderArchive();
    const job = await waitJob(id, () => {});
    state.archive = { status: 'done', id, result: job };
  } catch (e) {
    state.archive = null;
    toast(e.message);
  }
  state.running = false;
  renderArchive(true); updateChrome();
  for (const i of state.items) updateRow(i);
}

function renderArchive(celebrate = false) {
  const box = $('#archiveResult');
  box.replaceChildren();
  const a = state.archive;
  if (!a || state.mode !== 'archive') return;
  if (a.status === 'working') {
    const bar = h('div', { class: `bar${a.progress == null ? ' indet' : ''}` }, h('i', { style: `width:${Math.round((a.progress || 0) * 100)}%` }));
    const card = h('div', { class: 'archive-card glass row', 'data-busy': '' },
      h('div', { class: 'tile', style: '--cat: var(--c-archive)' }, icon('i-box')),
      h('div', { class: 'info' }, h('div', { class: 'name' }, 'Création de l’archive…'), h('div', { class: 'meta' }, a.progress == null ? 'Compression en cours' : 'Envoi des fichiers')),
      h('div', { class: 'status-ic' }, h('div', { class: 'spinner' })), bar);
    card.style.display = 'flex';
    box.append(card);
    return;
  }
  const r = a.result;
  const gain = r.inputSize ? Math.round((1 - r.outputSize / r.inputSize) * 100) : 0;
  const card = h('div', { class: `archive-card glass row${celebrate ? ' pop' : ''}` },
    h('div', { class: 'tile', style: '--cat: var(--c-archive)' }, icon('i-check')),
    h('div', { class: 'info' }, h('div', { class: 'name' }, r.outputName),
      h('div', { class: 'meta' }, `${fmtSize(r.inputSize)}`, h('span', { class: 'arrow' }, '→'), `${fmtSize(r.outputSize)}`, gain > 0 ? h('span', { class: 'badge' }, `−${gain} %`) : '')),
    h('a', { class: 'btn dl', href: `/api/jobs/${a.id}/download`, download: r.outputName }, icon('i-down'), h('span', {}, 'Télécharger')));
  card.style.display = 'flex';
  box.append(card);
}

/* ---------- popover ---------- */
let popCleanup = null;
function openPopover(anchor, targets, current, onPick, title) {
  closePopover();
  const pop = $('#popover');
  const uni = state.caps?.universal || [];
  const main = targets.filter((t) => !uni.includes(t));
  const pack = targets.filter((t) => uni.includes(t));
  const group = (name, list) => h('div', { class: 'pop-group' }, h('div', { class: 'pop-label' }, name),
    h('div', { class: 'chips' }, list.map((t) => h('button', {
      class: `chip${t === current ? ' on' : ''}`, role: 'menuitemradio', 'aria-checked': String(t === current),
      onclick: () => { onPick(t); closePopover(); },
    }, label(t)))));
  pop.replaceChildren(...[
    title ? h('div', { class: 'pop-title' }, title) : null,
    main.length ? group('Formats', main) : null,
    pack.length ? group('Archive', pack) : null,
  ].filter(Boolean));
  pop.hidden = false;
  const r = anchor.getBoundingClientRect();
  const pw = pop.offsetWidth; const ph = pop.offsetHeight;
  const left = Math.min(innerWidth - pw - 12, Math.max(12, r.right - pw));
  let top = r.bottom + 8;
  const above = top + ph > innerHeight - 12;
  if (above) top = Math.max(12, r.top - ph - 8);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  pop.style.transformOrigin = `${r.left + r.width / 2 - left}px ${above ? '100%' : '0'}`;
  requestAnimationFrame(() => pop.classList.add('open'));
  pop.querySelector('.chip.on, .chip')?.focus({ preventScroll: true });

  const onDown = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closePopover(); };
  const onKey = (e) => { if (e.key === 'Escape') { closePopover(); anchor.focus(); } };
  const onScroll = () => closePopover();
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey);
  addEventListener('scroll', onScroll, { passive: true, once: true });
  popCleanup = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey);
    removeEventListener('scroll', onScroll);
  };
}
function closePopover() {
  const pop = $('#popover');
  pop.classList.remove('open');
  pop.hidden = true;
  if (popCleanup) { popCleanup(); popCleanup = null; }
}

/* ---------- feuille des formats ---------- */
function renderFormats() {
  const body = $('#formatsBody');
  const caps = state.caps;
  if (!caps) return;
  const order = ['image', 'video', 'audio', 'document', 'sheet', 'data', 'archive'];
  const list = (arr) => arr.map(label).join(' · ');
  body.replaceChildren(
    ...order.filter((c) => caps.groups[c]).map((c) => {
      const tile = h('div', { class: 'tile' }, icon(CATS[c].icon));
      tile.style.setProperty('--cat', `var(--c-${c})`);
      return h('div', { class: 'fgroup' }, tile, h('h3', {}, CATS[c].label),
        h('div', { class: 'fline' }, h('b', {}, 'Lit'), list(caps.groups[c].inputs)),
        h('div', { class: 'fline' }, h('b', {}, 'Produit'), list(caps.groups[c].outputs)));
    }),
    (() => {
      const tile = h('div', { class: 'tile' }, icon('i-file'));
      tile.style.setProperty('--cat', 'var(--c-other)');
      return h('div', { class: 'fgroup' }, tile, h('h3', {}, 'Tout le reste'),
        h('div', { class: 'fline' }, 'N’importe quel fichier peut être emballé en ZIP, 7Z ou GZ, et compressé sans perte.'));
    })(),
    caps.libreoffice
      ? h('div', { class: 'callout ok' }, icon('i-check'), h('div', {}, 'LibreOffice est détecté : Word, PowerPoint, RTF et OpenDocument sont pris en charge, avec des PDF haute fidélité.'))
      : h('div', { class: 'callout' }, icon('i-info'), h('div', {}, h('b', {}, 'Débloque Word, PowerPoint et RTF. '), 'Installe LibreOffice (gratuit) puis relance Prisme : il sera détecté automatiquement.')),
  );
}

/* ---------- toasts ---------- */
function toast(text, ic = 'i-alert') {
  const t = h('div', { class: 'toast glass', role: 'status' }, icon(ic), h('span', {}, text));
  $('#toasts').append(t);
  setTimeout(() => { t.classList.add('out'); t.addEventListener('animationend', () => t.remove(), { once: true }); }, 4200);
}

/* ---------- glisser-déposer ---------- */
function bindDrop() {
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; document.body.classList.add('dragging'); $('#drop').classList.add('over'); });
  addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) { document.body.classList.remove('dragging'); $('#drop').classList.remove('over'); } });
  addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    $('#drop').classList.remove('over');
    if (state.running) return toast('Patiente jusqu’à la fin du traitement en cours.', 'i-info');
    addFiles(e.dataTransfer.files);
  });
  addEventListener('paste', (e) => { if (e.clipboardData?.files?.length && !state.running) addFiles(e.clipboardData.files); });
}

/* ---------- démarrage ---------- */
async function init() {
  for (const b of document.querySelectorAll('#modeSeg button')) b.addEventListener('click', () => setMode(b.dataset.mode));
  requestAnimationFrame(() => moveThumb($('#modeSeg'), true));
  addEventListener('resize', () => document.querySelectorAll('.seg').forEach((s) => moveThumb(s, true)));
  document.fonts?.ready.then(() => document.querySelectorAll('.seg').forEach((s) => moveThumb(s, true)));

  $('#pickBtn').addEventListener('click', (e) => { e.stopPropagation(); $('#picker').click(); });
  $('#drop').addEventListener('click', (e) => { if (e.target === e.currentTarget || !e.target.closest('button')) $('#picker').click(); });
  $('#picker').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('#runBtn').addEventListener('click', runAll);
  $('#clearBtn').addEventListener('click', () => {
    if (state.running) return;
    for (const i of state.items) i.el.remove();
    state.items = []; state.archive = null;
    renderArchive(); renderOptions(); updateChrome();
  });
  $('#formatsBtn').addEventListener('click', () => { renderFormats(); $('#formatsSheet').showModal(); });
  $('#closeSheet').addEventListener('click', () => $('#formatsSheet').close());
  $('#formatsSheet').addEventListener('click', (e) => { if (e.target === e.currentTarget) e.currentTarget.close(); });
  bindDrop();

  try {
    state.caps = await fetch('/api/capabilities').then((r) => r.json());
    const l = state.caps.limits;
    if (l) {
      $('#foot').textContent = l.public
        ? `Jusqu’à ${l.maxFileMB >= 1024 ? `${Math.round(l.maxFileMB / 1024)} Go` : `${l.maxFileMB} Mo`} par fichier. Tes fichiers sont supprimés automatiquement au bout de ${l.ttlMin >= 60 ? plural(Math.round(l.ttlMin / 60), 'heure') : `${l.ttlMin} minutes`}, et personne d’autre n’y a accès.`
        : 'Tout reste sur ton ordinateur. Rien n’est envoyé sur internet.';
    }
  } catch {
    toast('Le service ne répond pas. Réessaie dans un instant.');
  }
  renderOptions();
  updateChrome();
}

init();
