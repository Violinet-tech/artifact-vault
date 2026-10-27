// Self-test: builds a throwaway vault from made-up artifacts and checks every command. `node scripts/selftest.mjs`
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const vault = path.join(path.dirname(fileURLToPath(import.meta.url)), 'vault.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-selftest-'));
const AUTHOR = 'Self Test <selftest@example.com>';
const run = (...a) => execFileSync(process.execPath, [vault, ...a], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const json = (...a) => JSON.parse(run(...a, '--json'));
let n = 0;
const ok = (name, fn) => { fn(); n++; console.log('ok   ' + name); };

try {
  // three made-up artifacts: a guide with a (fake) key and a picture, a deck, a feature report
  const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452000000400000002008060000', 'hex'), Buffer.alloc(9000, 7)]);
  const fakeKey = 'AIza' + 'k'.repeat(35);
  const page = (title, body) => `<html><body><h1>${title}</h1>${body}</body></html>`;
  const make = (id, html) => { fs.mkdirSync(path.join(tmp, 'saved', id), { recursive: true }); fs.writeFileSync(path.join(tmp, 'saved', id, 'index.html'), html); };
  make('aaaa1111111111111111', page('Photo Studio User Guide', `<p>Open the restore panel. apiKey: ${fakeKey}</p><img alt="restore before and after" src="data:image/png;base64,${png.toString('base64')}">`));
  make('bbbb2222222222222222', page('Photo Studio Launch Deck', '<p>Slide one: portrait retouching for everyone.</p>'));
  make('cccc3333333333333333', page('Loader Status Report', '<p>Model loader extension installs, enables and updates per app.</p>'));
  const manifest = path.join(tmp, 'manifest.json');
  fs.writeFileSync(manifest, JSON.stringify([
    { id: 'aaaa1111111111111111', title: 'Photo Studio User Guide', updated: '2026-10-01', app: 'photo-studio', generated: [{ match: 'before and after', what: 'restore-test' }] },
    { id: 'bbbb2222222222222222', title: 'Photo Studio Launch Deck', updated: '2026-10-02', app: 'photo-studio' },
    { id: 'cccc3333333333333333', title: 'Loader Status Report', updated: '2026-10-03', app: 'loaders' },
  ]));
  const V = path.join(tmp, 'vault');

  ok('init makes a repo with an index branch', () => { run('init', V, '--author', AUTHOR); assert.ok(fs.existsSync(path.join(V, 'README.md'))); });
  ok('ingest sorts by app and kind and reports the key by kind only', () => {
    const out = run('ingest', V, manifest, '--root', path.join(tmp, 'saved'), '--author', AUTHOR);
    assert.ok(!out.includes(fakeKey));
    const r = JSON.parse(out);
    assert.equal(r.artifacts, 3);
    assert.deepEqual(r.redacted[0].found, { GOOGLE_API_KEY: 1 });
    const names = execFileSync('git', ['-C', V, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' }).split('\n');
    for (const b of ['photo-studio/guides', 'photo-studio/slides', 'loaders/features', 'images', 'dev']) assert.ok(names.includes(b), b);
  });
  ok('the saved copy holds no key, and scan finds nothing', () => {
    const html = execFileSync('git', ['-C', V, 'show', 'photo-studio/guides:photo-studio-user-guide-aaaa/index.html'], { encoding: 'utf8' });
    assert.ok(html.includes('REDACTED_GOOGLE_API_KEY') && !html.includes(fakeKey));
    assert.equal(run('scan', V).trim(), '(nothing found)');
  });
  ok('a generated picture goes to the images branch', () => {
    const imgs = json('search', V, 'images', '--generated');
    assert.equal(imgs.length, 1);
    assert.equal(imgs[0].what, 'restore-test');
  });
  ok('ingest again changes nothing', () => {
    const r = JSON.parse(run('ingest', V, manifest, '--root', path.join(tmp, 'saved'), '--author', AUTHOR));
    assert.equal(r.branches.filter((b) => b.changed).length, 0);
  });
  ok('search by kind, app and words', () => {
    assert.equal(json('search', V, 'slides').length, 1);
    assert.equal(json('search', V, 'guides', '--app', 'photo-studio').length, 1);
    assert.equal(json('search', V, 'all', 'extension').length, 1);
    assert.equal(json('search', V, 'features', 'nothing-like-this').length, 0);
  });
  ok('compare against a feature list', () => {
    const r = json('compare', V, '--features', 'model loader extension installs; quantum teleporter');
    assert.equal(r[0].verdict, 'covered');
    assert.equal(r[1].verdict, 'missing');
  });
  ok('compare against a session finds unsaved artifact links', () => {
    const f = path.join(tmp, 'session.txt');
    fs.writeFileSync(f, 'Added a quantum teleporter to the exporter\nSee https://claude.ai/artifact/zzzz9999999999999999 and https://claude.ai/artifact/aaaa1111111111111111\n');
    const r = json('compare', V, '--session', f);
    assert.deepEqual(r.unsavedLinks, ['zzzz9999999999999999']);
    assert.equal(r.claims.filter((c) => c.verdict === 'missing').length, 1);
  });
  ok('compare against an upload', () => {
    const f = path.join(tmp, 'upload.html');
    fs.writeFileSync(f, fs.readFileSync(path.join(tmp, 'saved', 'cccc3333333333333333', 'index.html')));
    assert.match(run('compare', V, '--upload', f), /identical/);
    fs.writeFileSync(f, '<html><body><h1>Gardening</h1><p>Tomatoes need sun and water.</p></body></html>');
    assert.match(run('compare', V, '--upload', f), /new to the vault/);
  });
  ok('a changed kind moves the artifact and drops the old branch', () => {
    const m = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    m[2].category = 'guides';
    fs.writeFileSync(manifest, JSON.stringify(m));
    run('ingest', V, manifest, '--root', path.join(tmp, 'saved'), '--author', AUTHOR);
    const names = execFileSync('git', ['-C', V, 'branch', '--format=%(refname:short)'], { encoding: 'utf8' }).split('\n');
    assert.ok(names.includes('loaders/guides') && !names.includes('loaders/features'));
  });
  ok('stats, gaps, list, show, get, unsaved and dupes run', () => {
    assert.equal(json('stats', V).artifacts, 3);
    assert.ok(json('gaps', V).some((g) => g.app === 'loaders'));
    assert.equal(json('list', V, '--limit', '2').length, 2);
    assert.match(run('show', V, 'launch-deck'), /Photo Studio Launch Deck/);
    run('get', V, 'launch-deck', '--out', path.join(tmp, 'out'));
    assert.ok(fs.existsSync(path.join(tmp, 'out', 'index.html')));
    const list = path.join(tmp, 'live.txt');
    fs.writeFileSync(list, 'https://claude.ai/artifact/aaaa1111111111111111 2026-11-01\nhttps://claude.ai/artifact/zzzz9999999999999999 2026-11-01\n');
    assert.equal(json('unsaved', V, '--list', list).length, 2);
    assert.equal(run('dupes', V).trim(), '(nothing found)');
  });
  console.log(`\n${n} checks passed`);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
