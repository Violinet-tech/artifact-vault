#!/usr/bin/env node
// artifact-vault: keep saved Claude artifacts in one git repo (one branch per app and kind, plus an `images`
// branch), then search them and compare them against a session, a feature list or an uploaded file.
// Zero dependencies. Needs Node 18+ and git. Run `node vault.mjs help` for the commands.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const KINDS = ['features', 'guides', 'screenshots', 'slides', 'docs'];
let INDEX = 'dev';            // the branch that holds README.md and index.json (override with --index-branch)
const IMAGES = 'images';      // generated pictures from app tests

// ---------- small helpers ----------
const die = (m) => { console.error('vault: ' + m); process.exit(1); };
const slug = (s, n = 60) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, n) || 'untitled';
const sha1 = (b) => crypto.createHash('sha1').update(b).digest('hex');
const posix = (p) => p.split(path.sep).join('/');

function parseArgs(argv) {
  const pos = [], o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || (next.startsWith('--') && next.length > 2)) o[k] = true; else { o[k] = next; i++; }
    } else pos.push(a);
  }
  return { pos, o };
}

function git(repo, args, { env, input, buffer } = {}) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: buffer ? undefined : 'utf8', input, env: { ...process.env, ...env }, maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] });
}
const tryGit = (...a) => { try { return git(...a); } catch { return null; } };

function needRepo(p) {
  if (!p) die('give the vault folder as the first argument');
  const r = path.resolve(p);
  if (!fs.existsSync(r) || tryGit(r, ['rev-parse', '--git-dir']) === null) die(`${r} is not a git repository (run: vault.mjs init <folder>)`);
  return r;
}

/** Every branch, local first, then origin's: name -> full ref. */
function branches(repo) {
  const out = tryGit(repo, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes/origin']) || '';
  const m = new Map();
  for (const ref of out.split('\n').filter(Boolean)) {
    const name = ref.replace(/^refs\/(heads|remotes\/origin)\//, '');
    if (name === 'HEAD') continue;
    if (!m.has(name) || ref.startsWith('refs/heads/')) m.set(name, ref);
  }
  return m;
}

/** Read many blobs in one git process. specs are `ref:path`; the result keeps the order, null where missing. */
function catBatch(repo, specs) {
  if (!specs.length) return [];
  const buf = git(repo, ['cat-file', '--batch'], { input: specs.join('\n') + '\n', buffer: true });
  const res = [];
  let i = 0;
  while (i < buf.length) {
    const nl = buf.indexOf(10, i);
    if (nl < 0) break;
    const head = buf.toString('utf8', i, nl);
    i = nl + 1;
    if (head.endsWith(' missing')) { res.push(null); continue; }
    const size = Number(head.split(' ')[2]);
    res.push(buf.subarray(i, i + size));
    i += size + 1;
  }
  return res;
}

/** Everything the vault knows: one entry per artifact folder, read from the ARTIFACT.json beside it. */
function scanVault(repo) {
  const refs = branches(repo);
  const entries = [];
  const files = new Map();
  for (const [name, ref] of refs) {
    if (name === INDEX || name === IMAGES || !name.includes('/')) continue;
    const cut = name.lastIndexOf('/');
    const app = name.slice(0, cut), kind = name.slice(cut + 1);
    const list = (tryGit(repo, ['-c', 'core.quotepath=false', 'ls-tree', '-r', '-z', '--name-only', ref]) || '').split('\0').filter(Boolean);
    files.set(name, list);
    const metas = list.filter((f) => /^[^/]+\/ARTIFACT\.json$/.test(f));
    const blobs = catBatch(repo, metas.map((f) => `${ref}:${f}`));
    metas.forEach((f, i) => {
      let m = {};
      try { m = JSON.parse(blobs[i].toString('utf8')); } catch { /* damaged meta: still list the folder */ }
      const folder = f.split('/')[0];
      entries.push({
        id: String(m.url || '').split('/').pop() || folder, title: m.title || folder, url: m.url || '', date: m.updated || '',
        app: m.app || app, category: m.category || kind, branch: name, ref, folder,
        screens: list.filter((x) => x.startsWith(folder + '/screenshots/')),
      });
    });
  }
  entries.sort((a, b) => (a.app + a.category + a.title).localeCompare(b.app + b.category + b.title));
  return { refs, entries, files };
}

function readImages(repo, refs) {
  const ref = refs.get(IMAGES);
  if (!ref) return [];
  const b = catBatch(repo, [`${ref}:index.json`])[0];
  try { return JSON.parse(b.toString('utf8')); } catch { return []; }
}

// ---------- text, tokens, scoring ----------
const plain = (html) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&[a-z#0-9]+;/gi, ' ').replace(/\s+/g, ' ').trim();
const STOP = new Set('the and for with that this from are was were has have had not but you your all any can will into out use used using add added new per via one two its our their they them then than also when what which who how why where been being more most some such only over under about after before above below between each other those these should would could may might must shall does did done get got set let make made like just very'.split(' '));
const stem = (w) => (w.length > 4 ? w.replace(/(ing|ed)$/, '').replace(/s$/, '').replace(/e$/, '') : w);
const tokens = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w)).map(stem));
const jaccard = (a, b) => { let i = 0; for (const x of a) if (b.has(x)) i++; return a.size + b.size - i ? i / (a.size + b.size - i) : 0; };

/** Load the readable text of each entry's index.html, with its token set. */
function corpus(repo, entries) {
  const blobs = catBatch(repo, entries.map((e) => `${e.ref}:${e.folder}/index.html`));
  return entries.map((e, i) => {
    const text = blobs[i] ? plain(blobs[i].toString('utf8')).slice(0, 400000) : '';
    return { ...e, text: text.toLowerCase(), htmlHash: blobs[i] ? sha1(blobs[i]) : '', body: tokens(text), head: tokens(e.title + ' ' + e.app) };
  });
}

/** How well one requested feature is covered by one entry: 0..1. */
function coverage(feature, entry) {
  const ft = tokens(feature);
  if (!ft.size) return 0;
  const phrase = feature.toLowerCase().replace(/\s+/g, ' ').trim();
  if (phrase.length > 6 && entry.text.includes(phrase)) return 1;
  let hit = 0, title = 0;
  for (const t of ft) { if (entry.body.has(t)) hit++; if (entry.head.has(t)) title++; }
  return Math.min(1, hit / ft.size + (title ? 0.1 : 0));
}
const verdict = (s) => (s >= 0.8 ? 'covered' : s >= 0.5 ? 'partial' : 'missing');

function rankFor(feature, docs, n = 3) {
  return docs.map((d) => ({ d, s: coverage(feature, d) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, n);
}

// ---------- secrets ----------
const PEM = '-----BEGIN ';
const SECRETS = [
  ['GOOGLE_API_KEY', 'AIza[0-9A-Za-z_-]{30,}'],
  ['ANTHROPIC_KEY', 'sk-ant-[0-9A-Za-z_-]{20,}'],
  ['OPENAI_KEY', 'sk-(proj-)?[0-9A-Za-z_-]{32,}'],
  ['GITHUB_TOKEN', 'gh[pousr]_[0-9A-Za-z]{30,}'],
  ['GITHUB_TOKEN', 'github_pat_[0-9A-Za-z_]{40,}'],
  ['HF_TOKEN', 'hf_[0-9A-Za-z]{30,}'],
  ['SLACK_TOKEN', 'xox[abprs]-[0-9A-Za-z-]{10,}'],
  ['AWS_ACCESS_KEY', 'AKIA[0-9A-Z]{16}'],
  ['STRIPE_LIVE_KEY', '[sr]k_live_[0-9A-Za-z]{20,}'],
  ['PRIVATE_KEY', PEM + '[A-Z ]*PRIVATE KEY-----', new RegExp(PEM + '[A-Z ]*PRIVATE KEY-----[\\s\\S]*?-----END [A-Z ]*PRIVATE KEY-----', 'g')],
];
function redact(text, counts) {
  let t = text;
  for (const [kind, ere, re] of SECRETS) {
    t = t.replace(re ? new RegExp(re.source, 'g') : new RegExp(ere, 'g'), () => { counts[kind] = (counts[kind] || 0) + 1; return 'REDACTED_' + kind; });
  }
  return t;
}

// ---------- classification and images ----------
const TEXT_EXT = /\.(html?|css|m?js|json|md|txt|svg|csv|xml|ya?ml|ts|tsx|py)$/i;
const SKIP_DIR = /^(artifact-type|node_modules|\.git)$/;

function classify(e, src) {
  const t = (e.title || '').toLowerCase();
  const names = fs.existsSync(src) ? fs.readdirSync(src) : [];
  if (e.type === 'slides' || /\b(slides?|deck|pitch|presentation)\b/.test(t) || names.includes('slides')) return 'slides';
  if (e.type === 'docs') return 'docs';
  if (/\b(guide|how[- ]to|setup|set up|runbook|checklist|walkthrough|manual|tutorial|handbook|playbook)\b/.test(t)) return 'guides';
  if (/\b(screenshots?|shots|gallery|test report|before\W+after)\b/.test(t)) return 'screenshots';
  return 'features';
}

function extractImages(html) {
  const out = [], seen = new Set();
  const re = /data:image\/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]{10000,})/g;
  let m;
  while ((m = re.exec(html))) {
    const buf = Buffer.from(m[2], 'base64');
    const h = sha1(buf);
    if (seen.has(h)) continue;
    seen.add(h);
    const start = html.lastIndexOf('<img', m.index), end = html.indexOf('>', m.index);
    const tag = start >= 0 && end > start && m.index - start < 4000 ? html.slice(start, end) : '';
    const alt = /\balt\s*=\s*"([^"]*)"/i.exec(tag) || /\baria-label\s*=\s*"([^"]*)"/i.exec(tag);
    out.push({ buf, ext: m[1] === 'jpeg' ? 'jpg' : m[1], label: alt ? alt[1] : '' });
    if (out.length >= 60) break;
  }
  return out;
}

function dims(b, ext) {
  try {
    if (ext === 'png') return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`;
    if (ext === 'gif') return `${b.readUInt16LE(6)}x${b.readUInt16LE(8)}`;
    if (ext === 'jpg') {
      let i = 2;
      while (i < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const mk = b[i + 1];
        if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return `${b.readUInt16BE(i + 7)}x${b.readUInt16BE(i + 5)}`;
        i += 2 + b.readUInt16BE(i + 2);
      }
    }
    if (ext === 'webp') {
      const k = b.toString('ascii', 12, 16);
      if (k === 'VP8X') return `${1 + b.readUIntLE(24, 3)}x${1 + b.readUIntLE(27, 3)}`;
      if (k === 'VP8 ') return `${b.readUInt16LE(26) & 0x3fff}x${b.readUInt16LE(28) & 0x3fff}`;
      if (k === 'VP8L') { const v = b.readUInt32LE(21); return `${(v & 0x3fff) + 1}x${((v >> 14) & 0x3fff) + 1}`; }
    }
  } catch { /* unreadable header: leave the size out */ }
  return '';
}

// ---------- writing branches (git plumbing, no checkout) ----------
function commitFiles(repo, branch, files, { remove = [], message, author } = {}) {
  const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']).trim();
  const idx = path.join(gitDir, 'vault-index.tmp');
  fs.rmSync(idx, { force: true });
  const env = { GIT_INDEX_FILE: idx };
  if (author) {
    const m = /^(.*?)\s*<(.+)>$/.exec(author);
    if (!m) die('--author must look like: Name <email>');
    Object.assign(env, { GIT_AUTHOR_NAME: m[1], GIT_AUTHOR_EMAIL: m[2], GIT_COMMITTER_NAME: m[1], GIT_COMMITTER_EMAIL: m[2] });
  }
  try {
    const refs = branches(repo);
    const parent = refs.has(branch) ? git(repo, ['rev-parse', refs.get(branch)]).trim() : null;
    if (parent) git(repo, ['read-tree', parent], { env });
    const lines = [];
    for (const dir of remove) {
      for (const f of git(repo, ['-c', 'core.quotepath=false', 'ls-files', '-z', '--', dir], { env }).split('\0').filter(Boolean)) lines.push(`0 ${'0'.repeat(40)}\t${f}`);
    }
    if (files.length) {
      const shas = git(repo, ['hash-object', '-w', '--stdin-paths'], { input: files.map((f) => f.abs).join('\n') + '\n' }).trim().split('\n');
      files.forEach((f, i) => lines.push(`100644 ${shas[i]}\t${f.rel}`));
    }
    if (lines.length) git(repo, ['update-index', '--add', '--index-info'], { env, input: lines.join('\n') + '\n' });
    const tree = git(repo, ['write-tree'], { env }).trim();
    if (parent && git(repo, ['rev-parse', parent + '^{tree}']).trim() === tree) return false;
    if (tree === '4b825dc642cb6eb9a060e54bf8d69288fbee4904' && branch !== INDEX) { git(repo, ['update-ref', '-d', 'refs/heads/' + branch]); return true; }
    const commit = git(repo, ['commit-tree', tree, ...(parent ? ['-p', parent] : []), '-m', message || 'Update'], { env }).trim();
    git(repo, ['update-ref', 'refs/heads/' + branch, commit]);
    return true;
  } finally { fs.rmSync(idx, { force: true }); }
}

function writeTemp(root, rel, data, prefix = '') {
  const abs = path.join(root, prefix, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, data);
  return { abs, rel: posix(rel) };
}

// ---------- the index branch ----------
function buildIndex(repo, opts = {}) {
  const { refs, entries } = scanVault(repo);
  const imgs = readImages(repo, refs);
  const idx = entries.map((e) => ({ id: e.id, title: e.title, date: e.date, app: e.app, category: e.category, branch: e.branch, folder: e.folder, url: e.url }));
  const byApp = new Map();
  for (const e of idx) { if (!byApp.has(e.app)) byApp.set(e.app, new Map()); const k = byApp.get(e.app); if (!k.has(e.category)) k.set(e.category, []); k.get(e.category).push(e); }
  const head = [
    '# artifacts', '',
    `Saved copies of ${idx.length} Claude artifacts. ${opts.note || 'Kept private. The index branch only lists what the other branches hold.'}`, '',
    '## How it is laid out', '',
    'One branch per app and kind: `<app>/features`, `<app>/guides`, `<app>/screenshots`, `<app>/slides`, `<app>/docs` (only the kinds an app has), plus one `images` branch.', '',
    '- **features**: status reports, plans, changelogs, explainers, site and brand pages.',
    '- **guides**: user guides, setup guides, runbooks, checklists, how-to pages.',
    '- **screenshots**: pages that are mostly screenshots, and the pictures pulled out of other pages (`<artifact>/screenshots/`).',
    '- **slides** and **docs**: artifacts made as Slides or Docs.',
    `- **images**: generated pictures from app tests, in \`<app>/<what the test was>/\` (${imgs.length} pictures).`, '',
    'Each artifact is a folder named after it, with `index.html`, the files it needs and `ARTIFACT.json` (original link, last update, app, kind).', '',
    'Check one out: `git fetch origin <app>/<kind>` then `git switch <app>/<kind>`. Search and compare with `node scripts/vault.mjs help`.', '',
  ];
  const body = [];
  for (const app of [...byApp.keys()].sort()) {
    body.push(`## ${app}`, '');
    for (const kind of [...byApp.get(app).keys()].sort()) {
      body.push(`**\`${app}/${kind}\`**`, '');
      for (const e of byApp.get(app).get(kind)) body.push(`- [${e.title.replace(/[[\]]/g, '')}](${e.url}), \`${e.folder}/\`, ${e.date}`);
      body.push('');
    }
  }
  return { readme: head.concat(body).join('\n') + '\n', json: JSON.stringify(idx, null, 1) + '\n', count: idx.length };
}

function writeIndexBranch(repo, o) {
  const b = buildIndex(repo, { note: o.note });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-idx-'));
  try {
    const files = [writeTemp(tmp, 'README.md', b.readme), writeTemp(tmp, 'index.json', b.json)];
    if (!branches(repo).has(INDEX)) files.push(writeTemp(tmp, '.gitignore', '_*\n*.tmp\n'));
    const changed = commitFiles(repo, INDEX, files, { message: `Index: ${b.count} artifacts`, author: o.author });
    const cur = (tryGit(repo, ['symbolic-ref', '--short', '-q', 'HEAD']) || '').trim();
    if (changed && cur === INDEX) tryGit(repo, ['checkout', 'HEAD', '--', 'README.md', 'index.json']);
    return { changed, count: b.count };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// ---------- commands ----------
function cmdInit(pos, o) {
  const dir = path.resolve(pos[0] || die('usage: init <vault-folder> [--remote <url>]'));
  fs.mkdirSync(dir, { recursive: true });
  if (tryGit(dir, ['rev-parse', '--git-dir']) === null) execFileSync('git', ['init', '-q', '-b', INDEX, dir]);
  if (o.remote && typeof o.remote === 'string' && tryGit(dir, ['remote', 'get-url', 'origin']) === null) git(dir, ['remote', 'add', 'origin', o.remote]);
  const r = writeIndexBranch(dir, o);
  tryGit(dir, ['symbolic-ref', 'HEAD', 'refs/heads/' + INDEX]);
  tryGit(dir, ['reset', '-q', '--hard', INDEX]);
  console.log(`vault ready at ${dir} (index branch: ${INDEX}${r.changed ? ', first commit made' : ''})`);
}

function cmdIngest(pos, o) {
  const repo = needRepo(pos[0]);
  const mf = pos[1] || die('usage: ingest <vault> <manifest.json> [--root <saved-folder>] [--apps apps.json] [--dry-run] [--push]');
  const parsed = JSON.parse(fs.readFileSync(mf, 'utf8').replace(/^﻿/, ''));
  const list = Array.isArray(parsed) ? parsed : parsed.artifacts;
  if (!Array.isArray(list)) die('the manifest must be a list, or { "artifacts": [ ... ] }');
  const appRules = o.apps ? JSON.parse(fs.readFileSync(o.apps, 'utf8')) : {};
  const root = o.root ? path.resolve(o.root) : path.dirname(path.resolve(mf));
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-stage-'));
  const groups = new Map();      // branch -> { files, remove, titles }
  const imgAdd = [];             // generated pictures for the images branch
  const report = { artifacts: 0, skipped: [], redacted: [], screenshots: 0, generated: 0, branches: [] };
  const existing = scanVault(repo).entries;
  const stale = new Map();       // branch -> old folders to drop (the artifact moved kind, app or name)
  try {
    list.forEach((e, n) => {
      if (!e.id || !e.title) { report.skipped.push(`#${n}: needs id and title`); return; }
      const src = path.resolve(e.dir || path.join(root, e.id));
      if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) { report.skipped.push(`${e.title}: no saved folder at ${src}`); return; }
      let app = e.app;
      if (!app) for (const [name, words] of Object.entries(appRules)) if (words.some((w) => e.title.toLowerCase().includes(String(w).toLowerCase()))) { app = name; break; }
      app = slug(app || 'misc', 40);
      if (app === INDEX || app === IMAGES) { report.skipped.push(`${e.title}: app name "${app}" is reserved`); return; }
      const category = KINDS.includes(e.category) ? e.category : classify(e, src);
      const folder = `${slug(e.title, 40)}-${e.id.slice(0, 4).toLowerCase()}`;
      const branch = `${app}/${category}`;
      const url = e.url || `https://claude.ai/artifact/${e.id}`;
      const counts = {};
      const files = [];
      const put = (rel, data) => files.push(writeTemp(stage, path.join(folder, rel), data, branch));
      const htmlFiles = [];
      const walk = (d, rel) => {
        for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
          const r = rel ? rel + '/' + ent.name : ent.name;
          if (ent.isDirectory()) { if (!SKIP_DIR.test(ent.name)) walk(path.join(d, ent.name), r); continue; }
          if (!ent.isFile() || (!rel && ent.name === 'SKILL.md')) continue;
          const buf = fs.readFileSync(path.join(d, ent.name));
          if (TEXT_EXT.test(ent.name)) {
            const clean = redact(buf.toString('utf8'), counts);
            put(r, clean);
            if (/\.html?$/i.test(ent.name)) htmlFiles.push(clean);
          } else put(r, buf);
        }
      };
      walk(src, '');
      let k = 0;
      const seen = new Set();
      for (const html of htmlFiles) {
        for (const im of extractImages(html)) {
          const h = sha1(im.buf);
          if (seen.has(h)) continue;
          seen.add(h);
          k++;
          const label = slug(im.label || 'image', 40);
          const rule = (e.generated || []).find((g) => g.match && im.label.toLowerCase().includes(String(g.match).toLowerCase()));
          if (rule) {
            const what = slug(rule.what || e.title, 40), name = (rule.name ? slug(rule.name, 60) : `${String(k).padStart(2, '0')}-${label}`) + '.' + im.ext;
            imgAdd.push({ rel: `${app}/${what}/${name}`, buf: im.buf, meta: { app, what, name, from: e.title, url, size: dims(im.buf, im.ext) } });
            report.generated++;
          } else { put(`screenshots/${String(k).padStart(2, '0')}-${label}.${im.ext}`, im.buf); report.screenshots++; }
        }
      }
      put('ARTIFACT.json', JSON.stringify({ title: e.title, url, updated: e.updated || e.date || '', app, category }, null, 2) + '\n');
      if (Object.keys(counts).length) report.redacted.push({ artifact: e.title, found: counts });
      for (const x of existing) if (x.id === e.id && !(x.branch === branch && x.folder === folder)) { if (!stale.has(x.branch)) stale.set(x.branch, new Set()); stale.get(x.branch).add(x.folder); if (x.branch !== branch) report.moved = (report.moved || 0) + 1; }
      if (!groups.has(branch)) groups.set(branch, { files: [], remove: [], titles: [] });
      const g = groups.get(branch);
      g.files.push(...files); g.remove.push(folder); g.titles.push(e.title);
      report.artifacts++;
    });

    if (o['dry-run']) {
      for (const [b, g] of groups) report.branches.push({ branch: b, artifacts: g.titles.length, files: g.files.length, would: 'commit' });
      console.log(JSON.stringify(report, null, 1));
      return;
    }
    for (const [b, g] of groups) {
      if (stale.has(b)) { g.remove.push(...stale.get(b)); stale.delete(b); }
      const changed = commitFiles(repo, b, g.files, { remove: g.remove, author: o.author, message: g.titles.length === 1 ? `Save ${g.titles[0]}` : `Save ${g.titles.length} artifacts` });
      report.branches.push({ branch: b, artifacts: g.titles.length, changed });
    }
    for (const [b, folders] of stale) {
      const changed = commitFiles(repo, b, [], { remove: [...folders], author: o.author, message: 'Move artifacts to another branch' });
      report.branches.push({ branch: b, artifacts: 0, changed, removed: folders.size });
    }
    if (imgAdd.length) {
      const refs = branches(repo);
      const old = readImages(repo, refs);
      const key = (x) => `${x.app}/${x.what}/${x.name}`;
      const merged = new Map(old.map((x) => [key(x), x]));
      imgAdd.forEach((x) => merged.set(key(x.meta), x.meta));
      const all = [...merged.values()].sort((a, b) => key(a).localeCompare(key(b)));
      const readme = ['# images', '', `Generated pictures from app tests, ${all.length} in all. Folders are \`<app>/<what the test was>/\`; \`index.json\` says which artifact each came from.`, '', 'Check the licence of the model that made a picture before using it anywhere public.', ''].join('\n');
      const files = imgAdd.map((x) => writeTemp(stage, x.rel, x.buf, IMAGES));
      files.push(writeTemp(stage, 'index.json', JSON.stringify(all, null, 1) + '\n', IMAGES), writeTemp(stage, 'README.md', readme + '\n', IMAGES));
      const changed = commitFiles(repo, IMAGES, files, { message: `Add ${imgAdd.length} generated pictures`, author: o.author });
      report.branches.push({ branch: IMAGES, artifacts: imgAdd.length, changed });
    }
    report.index = writeIndexBranch(repo, o);
    if (o.push) report.pushed = push(repo, o);
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  console.log(JSON.stringify(report, null, 1));
  if (report.redacted.length) console.error('vault: secrets were found and replaced in the copies (kinds only, never values). Rotate any key that was live.');
}

function push(repo, o) {
  const remote = typeof o.remote === 'string' ? o.remote : 'origin';
  if (tryGit(repo, ['remote', 'get-url', remote]) === null) die(`no remote named ${remote}; add one first (git remote add ${remote} <url>)`);
  const out = [];
  for (const [name, ref] of branches(repo)) {
    if (!ref.startsWith('refs/heads/')) continue;
    try { git(repo, ['push', '-q', remote, `${ref}:${ref}`]); out.push(name); } catch (e) { out.push(`${name}: not pushed (${String(e.stderr || e.message).split('\n')[0]})`); }
  }
  return out;
}

function fmt(e) { return `${e.app}/${e.category}  ${e.date || '          '}  ${e.title}  [${e.folder}]${e.url ? '  ' + e.url : ''}`; }
function emit(o, rows, lines) { if (o.json) console.log(JSON.stringify(rows, null, 1)); else console.log(lines.length ? lines.join('\n') : '(nothing found)'); }

function cmdSearch(pos, o) {
  const repo = needRepo(pos[0]);
  const kind = (pos[1] || 'all').toLowerCase();
  const query = pos.slice(2).join(' ').toLowerCase().split(/\s+/).filter(Boolean);
  if (kind !== 'all' && kind !== 'images' && !KINDS.includes(kind)) die(`kind must be one of: all, images, ${KINDS.join(', ')}`);
  const { refs, entries } = scanVault(repo);
  const limit = Number(o.limit) || 30;
  const lines = [], rows = [];
  if (kind !== 'images') {
    let pool = entries.filter((e) => (kind === 'all' || e.category === kind) && (!o.app || e.app === o.app) && (!o.since || e.date >= o.since));
    const docs = query.length && !o.titles ? corpus(repo, pool) : pool.map((e) => ({ ...e, text: '' }));
    const hits = docs.map((d) => {
      const head = `${d.title} ${d.app} ${d.folder}`.toLowerCase();
      if (!query.every((w) => head.includes(w) || d.text.includes(w))) return null;
      return { d, s: query.filter((w) => head.includes(w)).length };
    }).filter(Boolean).sort((a, b) => b.s - a.s || (b.d.date || '').localeCompare(a.d.date || '')).slice(0, limit);
    for (const h of hits) { rows.push({ type: 'artifact', ...h.d, text: undefined, body: undefined, head: undefined, ref: undefined }); lines.push(fmt(h.d)); }
  }
  if (kind === 'images' || kind === 'all' || kind === 'screenshots') {
    const wantGen = kind !== 'screenshots' && !o.screens, wantShots = kind !== 'images' || !o.generated;
    if (wantGen) for (const im of readImages(repo, refs)) {
      const hay = `${im.app} ${im.what} ${im.name} ${im.from}`.toLowerCase();
      if ((!o.app || im.app === o.app) && query.every((w) => hay.includes(w))) { rows.push({ type: 'generated-image', ...im }); lines.push(`image  ${im.app}/${im.what}/${im.name}  ${im.size || ''}  from "${im.from}"  ${im.url}`); }
    }
    if (wantShots && !o.generated) for (const e of entries) {
      if (o.app && e.app !== o.app) continue;
      for (const f of e.screens) {
        const hay = `${e.app} ${e.title} ${f}`.toLowerCase();
        if (query.every((w) => hay.includes(w))) { rows.push({ type: 'screenshot', app: e.app, branch: e.branch, path: f, from: e.title, url: e.url }); lines.push(`shot   ${e.branch}:${f}  from "${e.title}"`); }
      }
    }
  }
  emit(o, rows.slice(0, limit * 3), lines.slice(0, limit * 3));
}

function findEntry(entries, key) {
  const k = String(key || '').toLowerCase();
  const exact = entries.filter((e) => e.id.toLowerCase() === k || e.folder === k);
  if (exact.length) return exact[0];
  const some = entries.filter((e) => e.id.toLowerCase().startsWith(k) || e.folder.includes(k) || e.title.toLowerCase().includes(k));
  if (some.length === 1) return some[0];
  if (!some.length) die(`no artifact matches "${key}"`);
  die(`"${key}" matches ${some.length}: ${some.slice(0, 6).map((e) => e.folder).join(', ')}`);
}

function cmdShow(pos, o) {
  const repo = needRepo(pos[0]);
  const { files, entries } = scanVault(repo);
  const e = findEntry(entries, pos[1]);
  const list = files.get(e.branch).filter((f) => f.startsWith(e.folder + '/'));
  if (o.json) return console.log(JSON.stringify({ ...e, ref: undefined, files: list }, null, 1));
  console.log(`${e.title}\n${e.url}\nbranch ${e.branch}, updated ${e.date}\n${list.length} files:\n  ${list.join('\n  ')}`);
}

function cmdGet(pos, o) {
  const repo = needRepo(pos[0]);
  const { files, entries } = scanVault(repo);
  const e = findEntry(entries, pos[1]);
  const out = path.resolve(typeof o.out === 'string' ? o.out : e.folder);
  const list = files.get(e.branch).filter((f) => f.startsWith(e.folder + '/'));
  const blobs = catBatch(repo, list.map((f) => `${e.ref}:${f}`));
  list.forEach((f, i) => { const dest = path.join(out, f.slice(e.folder.length + 1)); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.writeFileSync(dest, blobs[i]); });
  console.log(`wrote ${list.length} files to ${out}`);
}

function cmdStats(pos, o) {
  const repo = needRepo(pos[0]);
  const { refs, entries } = scanVault(repo);
  const imgs = readImages(repo, refs);
  const apps = [...new Set(entries.map((e) => e.app))].sort();
  const rows = apps.map((a) => ({ app: a, ...Object.fromEntries(KINDS.map((k) => [k, entries.filter((e) => e.app === a && e.category === k).length])), shots: entries.filter((e) => e.app === a).reduce((n, e) => n + e.screens.length, 0), images: imgs.filter((i) => i.app === a).length }));
  if (o.json) return console.log(JSON.stringify({ artifacts: entries.length, apps: rows }, null, 1));
  const w = Math.max(4, ...apps.map((a) => a.length));
  console.log(`${entries.length} artifacts, ${apps.length} apps, ${imgs.length} generated pictures, ${entries.reduce((n, e) => n + e.screens.length, 0)} extracted screenshots`);
  console.log(['app'.padEnd(w), ...KINDS.map((k) => k.padStart(11)), 'shots'.padStart(6), 'images'.padStart(7)].join(' '));
  for (const r of rows) console.log([r.app.padEnd(w), ...KINDS.map((k) => String(r[k]).padStart(11)), String(r.shots).padStart(6), String(r.images).padStart(7)].join(' '));
}

function cmdGaps(pos, o) {
  const repo = needRepo(pos[0]);
  const { entries } = scanVault(repo);
  const want = (typeof o.want === 'string' ? o.want : 'guides,screenshots,slides').split(',').map((s) => s.trim());
  const apps = [...new Set(entries.map((e) => e.app))].sort().filter((a) => a !== 'misc');
  const rows = apps.map((a) => ({ app: a, missing: want.filter((k) => !entries.some((e) => e.app === a && e.category === k)) })).filter((r) => r.missing.length);
  emit(o, rows, rows.map((r) => `${r.app}: no ${r.missing.join(', no ')}`));
}

function cmdDupes(pos, o) {
  const repo = needRepo(pos[0]);
  const docs = corpus(repo, scanVault(repo).entries);
  const th = Number(o.threshold) || 0.9, pairs = [];
  for (let i = 0; i < docs.length; i++) for (let j = i + 1; j < docs.length; j++) {
    const a = docs[i], b = docs[j];
    if (a.htmlHash && a.htmlHash === b.htmlHash) pairs.push({ a: a.folder, b: b.folder, similarity: 1, same: 'identical' });
    else if (a.body.size > 20 && b.body.size > 20) { const s = jaccard(a.body, b.body); if (s >= th) pairs.push({ a: a.folder, b: b.folder, similarity: Number(s.toFixed(2)), same: 'near-duplicate' }); }
  }
  emit(o, pairs, pairs.map((p) => `${p.same} ${p.similarity}  ${p.a}  <->  ${p.b}`));
}

function cmdScan(pos, o) {
  const repo = needRepo(pos[0]);
  const found = [];
  const combined = SECRETS.map(([, ere]) => `(${ere})`).join('|');
  for (const [name, ref] of branches(repo)) {
    const out = tryGit(repo, ['grep', '-I', '-n', '-o', '-E', '-e', combined, ref]) || '';
    for (const line of out.split('\n').filter(Boolean)) {
      const m = /^(.+?):(\d+):(.*)$/.exec(line.startsWith(ref + ':') ? line.slice(ref.length + 1) : line);
      if (!m) continue;
      const hit = m[3];
      const kind = SECRETS.find(([, ere]) => new RegExp('^(' + ere + ')').test(hit))?.[0] || 'SECRET';
      found.push({ branch: name, file: m[1], line: Number(m[2]), kind });
    }
  }
  emit(o, found, found.map((f) => `${f.kind}  ${f.branch}:${f.file}:${f.line}`));
  if (found.length) console.error(`vault: ${found.length} possible secret(s). Values are not printed. Rotate any key that was live, then re-ingest (ingest replaces them in the copies).`);
  process.exitCode = found.length ? 2 : 0;
}

function readInput(p) {
  if (!p || p === true) die('this needs a file (or - for standard input)');
  return p === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
}

function printFeatures(rows, o) {
  if (o.json) return console.log(JSON.stringify(rows, null, 1));
  for (const r of rows) {
    console.log(`${r.verdict.toUpperCase().padEnd(8)} ${r.feature}`);
    for (const m of r.best.slice(0, 2)) console.log(`           ${m.score.toFixed(2)}  ${m.app}/${m.category}  ${m.title}`);
  }
  const c = (v) => rows.filter((r) => r.verdict === v).length;
  console.log(`\n${c('covered')} covered, ${c('partial')} partial, ${c('missing')} missing, of ${rows.length}`);
}

function checkFeatures(features, docs) {
  return features.map((f) => {
    const best = rankFor(f, docs).map((x) => ({ score: x.s, app: x.d.app, category: x.d.category, title: x.d.title, folder: x.d.folder }));
    return { feature: f, verdict: verdict(best[0]?.score || 0), best };
  });
}

function cmdCompare(pos, o) {
  const repo = needRepo(pos[0]);
  let { entries } = scanVault(repo);
  if (o.app) entries = entries.filter((e) => e.app === o.app);
  const docs = corpus(repo, entries);

  if (o.features || o['features-file']) {
    const raw = o.features && o.features !== true ? String(o.features) : readInput(o['features-file']);
    const features = raw.split(/\r?\n|;/).map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim()).filter((s) => s.length > 2);
    return printFeatures(checkFeatures(features, docs), o);
  }

  if (o.session) {
    const text = readInput(o.session);
    const claims = [...new Set(text.split(/\r?\n/).map((s) => s.replace(/https?:\/\/\S+/g, ' ').replace(/^\s*(?:[-*•#>]+|\d+[.)])\s*/, '').replace(/[*`_]/g, '').replace(/\s+/g, ' ').trim()).filter((s) => s.split(/\s+/).length >= 4 && s.length <= 240))];
    const rows = checkFeatures(claims, docs);
    const ids = [...new Set([...text.matchAll(/claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9_-]{10,})/g)].map((m) => m[1]))];
    const have = new Set(entries.map((e) => e.id));
    const unsaved = ids.filter((i) => !have.has(i));
    if (o.json) return console.log(JSON.stringify({ claims: rows, artifactLinks: ids.length, unsavedLinks: unsaved }, null, 1));
    const gone = rows.filter((r) => r.verdict === 'missing');
    console.log(`${claims.length} statements in the session, ${rows.length - gone.length} touch something already in the vault, ${gone.length} do not.`);
    if (gone.length) console.log('\nNot in the vault yet:\n' + gone.slice(0, Number(o.limit) || 25).map((r) => '  - ' + r.feature).join('\n'));
    console.log(`\nArtifact links in the session: ${ids.length}, not saved in the vault: ${unsaved.length}`);
    if (unsaved.length) console.log(unsaved.map((i) => '  https://claude.ai/artifact/' + i).join('\n'));
    return;
  }

  if (o.upload) {
    const p = String(o.upload);
    const raw = fs.readFileSync(p, 'utf8');
    const html = /\.html?$/i.test(p) || /^\s*<(!doctype|html)/i.test(raw);
    const text = html ? plain(raw) : raw;
    const t = tokens(text), h = sha1(Buffer.from(raw));
    const ranked = docs.map((d) => ({ d, s: d.htmlHash === h ? 1 : jaccard(t, d.body) })).sort((a, b) => b.s - a.s).slice(0, 5);
    const top = ranked[0];
    const v = !top ? 'new' : top.s >= 0.98 ? 'identical to a saved artifact' : top.s >= 0.8 ? 'near-duplicate (probably a newer version)' : top.s >= 0.35 ? 'related to saved artifacts' : 'new to the vault';
    const heads = html ? [...raw.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)].map((m) => plain(m[1])).filter(Boolean) : text.split(/\r?\n/).filter((l) => /^#{1,3}\s/.test(l)).map((l) => l.replace(/^#+\s*/, ''));
    const unseen = top ? heads.filter((x) => x.length > 3 && !top.d.text.includes(x.toLowerCase())) : heads;
    if (o.json) return console.log(JSON.stringify({ verdict: v, matches: ranked.map((r) => ({ similarity: Number(r.s.toFixed(2)), app: r.d.app, category: r.d.category, title: r.d.title, folder: r.d.folder })), headingsNotInBest: unseen }, null, 1));
    console.log(`Verdict: ${v}`);
    for (const r of ranked) console.log(`  ${r.s.toFixed(2)}  ${r.d.app}/${r.d.category}  ${r.d.title}`);
    if (top && unseen.length) console.log('\nHeadings in the upload that the closest saved artifact does not have:\n' + unseen.slice(0, 15).map((x) => '  - ' + x).join('\n'));
    return;
  }
  die('compare needs one of: --features "a; b" | --features-file <file> | --session <file> | --upload <file>');
}

/** Which live artifacts (from a pasted list) are not saved yet, or changed since they were. */
function cmdUnsaved(pos, o) {
  const repo = needRepo(pos[0]);
  const { entries } = scanVault(repo);
  const have = new Map(entries.map((e) => [e.id, e]));
  const rows = [];
  const seen = new Set();
  for (const line of readInput(o.list || pos[1]).split(/\r?\n/)) {
    const m = /claude\.ai\/(?:code\/)?artifact\/([A-Za-z0-9_-]{10,})/.exec(line);
    if (!m || seen.has(m[1])) continue;
    seen.add(m[1]);
    const when = /(\d{4}-\d{2}-\d{2})/.exec(line)?.[1] || '';
    const mine = have.get(m[1]);
    if (!mine) rows.push({ id: m[1], state: 'unsaved', live: when });
    else if (when && mine.date && when > mine.date) rows.push({ id: m[1], state: 'changed since saved', saved: mine.date, live: when, title: mine.title });
  }
  emit(o, rows, rows.map((r) => `${r.state.padEnd(20)} https://claude.ai/artifact/${r.id}  ${r.title || ''} ${r.saved ? `(saved ${r.saved}, live ${r.live})` : r.live ? `(live ${r.live})` : ''}`));
  if (!o.json) console.log(`\n${seen.size} links read, ${rows.length} need saving`);
}

function cmdTimeline(pos, o) {
  const repo = needRepo(pos[0]);
  const { entries } = scanVault(repo);
  const rows = entries.filter((e) => !o.app || e.app === o.app).sort((a, b) => (b.date || '').localeCompare(a.date || '')).slice(0, Number(o.limit) || 20);
  emit(o, rows.map((e) => ({ ...e, ref: undefined, screens: undefined })), rows.map(fmt));
}

const HELP = `artifact-vault: keep saved Claude artifacts in a git repo, then search and compare them.

  init <vault> [--remote <url>]                create the vault (index branch ${INDEX})
  ingest <vault> <manifest.json> [options]     sort saved artifacts into <app>/<kind> branches
        --root <folder>      where each artifact was saved (default: next to the manifest, one folder per id)
        --apps <apps.json>   {"app": ["title word", ...]} to guess the app from a title
        --author "Name <email>"   commit author (default: your git config)
        --dry-run            show what would happen, change nothing
        --push               push every branch to origin afterwards (never forced)
  index <vault>                                rebuild README.md and index.json on the index branch
  push <vault> [--remote origin]               push all branches (never forced)

  search <vault> <kind> [words...]             kind: all | images | features | guides | screenshots | slides | docs
        --app <app>  --since YYYY-MM-DD  --titles (skip page text)  --generated | --screens (images only)  --limit N
  list <vault> [--app a]                       the newest artifacts   (alias: timeline)
  show <vault> <id|folder|title word>          one artifact's details and files
  get <vault> <id|folder> --out <dir>          copy one artifact out of the vault
  stats <vault>                                counts per app and kind
  gaps <vault> [--want guides,screenshots,slides]   apps missing a kind
  dupes <vault> [--threshold 0.9]              identical or near-identical artifacts
  scan <vault>                                 look for keys and tokens in the saved copies (kinds only, never values)

  compare <vault> --features "a; b; c"         which requested features the vault covers
  compare <vault> --features-file <file>
  compare <vault> --session <file|->           what a session did vs what the vault holds; unsaved artifact links
  compare <vault> --upload <file>              is this file new, a duplicate, or a newer version?   [--app a]
  unsaved <vault> --list <file|->              artifact links from a pasted list that are not saved or changed since

Every read command takes --json. Global: --index-branch <name> (default dev).`;

function main() {
  const { pos, o } = parseArgs(process.argv.slice(2));
  if (typeof o['index-branch'] === 'string') INDEX = o['index-branch'];
  const cmd = pos.shift();
  const table = {
    init: cmdInit, ingest: cmdIngest, search: cmdSearch, list: cmdTimeline, timeline: cmdTimeline, show: cmdShow, get: cmdGet, stats: cmdStats, gaps: cmdGaps,
    dupes: cmdDupes, scan: cmdScan, compare: cmdCompare, unsaved: cmdUnsaved,
    index: (p, op) => { const r = writeIndexBranch(needRepo(p[0]), op); console.log(`index ${r.changed ? 'updated' : 'already current'}: ${r.count} artifacts`); },
    push: (p, op) => console.log(push(needRepo(p[0]), op).join('\n')),
  };
  if (!cmd || cmd === 'help' || o.help) return console.log(HELP);
  if (!table[cmd]) die(`unknown command "${cmd}". Run: node vault.mjs help`);
  table[cmd](pos, o);
}
main();
