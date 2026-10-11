'use strict';
// Unit tests for script/gitlab-projects.cjs. No network, no real GitLab: git runs only against
// throwaway repositories created under a temporary HOME.   Run: node --test script/test/
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');

const HOME = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'glp-home-'));
process.env.HOME = HOME; // os.homedir() follows $HOME, so every default path stays inside the sandbox
process.env.OPENCODE_REMOTE_STATE_DIR = path.join(HOME, 'state');
process.env.OPENCODE_GITLAB_MANIFEST = path.join(HOME, 'manifest.json');
const gl = require('../gitlab-projects.cjs');

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const KEY = 'opencode.global.dat:server';
const STATE = 'stalin.gitlab-projects.v2';
const DIRS = [`${HOME}/GitLab/a`, `${HOME}/GitLab/b`, `${HOME}/GitLab/c`];

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    stdio: 'pipe',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
  }).toString();
const writeManifest = (projects, root = path.join(HOME, 'GitLab')) =>
  fs.writeFileSync(process.env.OPENCODE_GITLAB_MANIFEST, JSON.stringify({ version: 2, root, projects }));
const bodyOf = (script) => script.replace(/^<script id="[^"]+">/, '').replace(/<\/script>$/, '');

// Runs the injected script against a fake localStorage and returns the resulting store.
function boot(dirs, initial, { throwOnKey } = {}) {
  const store = new Map(Object.entries(initial));
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      if (k === throwOnKey) throw new Error('QuotaExceededError');
      store.set(k, String(v));
    },
    removeItem: (k) => store.delete(k),
  };
  vm.runInNewContext(bodyOf(gl.buildSeedScript(dirs)), { localStorage });
  return store;
}
const appStore = (local, extra = {}) =>
  JSON.stringify({ list: [], projects: { local: local.map((w) => ({ worktree: w, expanded: true })) }, lastProject: { local: local[0] }, recentlyClosed: {}, ...extra });
const worktrees = (store) => JSON.parse(store.get(KEY)).projects.local.map((p) => p.worktree);

// ------------------------------------------------------------ 1. XSS / escaping

test('jsonForScript: escapa < > & y los separadores U+2028/U+2029', () => {
  const out = gl.jsonForScript(['</script><img src=x onerror=alert(1)>', `a&b${LS}${PS}`]);
  assert.equal(/[<>&]/.test(out), false);
  assert.equal(out.includes(LS) || out.includes(PS), false);
  assert.deepEqual(JSON.parse(out), ['</script><img src=x onerror=alert(1)>', `a&b${LS}${PS}`]); // sin pérdida
});

test('buildSeedScript con nombre malicioso: un solo </script>, sin <img, y viaja intacto al almacenamiento', () => {
  const evil = `${HOME}/GitLab/</script><img src=x onerror=alert(1)>${LS}`;
  const script = gl.buildSeedScript([evil]);
  const data = /var LIST=(.*?);if\(!LIST\.length\)/.exec(script)[1]; // solo el dato (el código tiene comparaciones legítimas con <)
  assert.equal(/[<>&]/.test(data), false);
  assert.equal(script.includes('<img') || script.includes('<!--'), false);
  assert.equal((script.match(/<\/script/g) || []).length, 1);
  const store = boot([evil], { [KEY]: appStore([`${HOME}/hostinger-clone`]) });
  assert.ok(worktrees(store).includes(evil)); // la cadena llega literal al JS, no se interpreta
});

test('readManifest rechaza nombres/urls/dirs maliciosos y usa la raíz por defecto', () => {
  writeManifest([
    { name: '</script><img onerror=1>', url: 'https://gitlab.com/g/a.git' },
    { name: '../evil', url: 'https://gitlab.com/g/a.git' },
    { name: 'ok', url: 'https://gitlab.com/g/ok.git', dir: '/etc' },
    { name: 'ok2', url: 'https://gitlab.com/g/ok2.git', dir: `${HOME}/rel/../x` },
    { name: 'ok3', url: 'https://gitlab.com/g/ok3.git', dir: `${HOME}/lin\nea` },
    { name: 'cred', url: 'https://user:pw@gitlab.com/g/a.git' },
    { name: 'otro', url: 'https://evil.example/g/a.git' },
    { name: 'ssh', url: 'git@gitlab.com:g/a.git' },
    { name: 'ok', url: 'https://gitlab.com/g/dup.git' },
  ]);
  const { projects, root } = gl.readManifest();
  assert.deepEqual(projects.map((p) => p.name), ['ok', 'ok2', 'ok3']);
  assert.deepEqual(projects.map((p) => p.dir), [`${root}/ok`, `${root}/ok2`, `${root}/ok3`]);
});

test('readManifest acepta dir existente bajo $HOME (con espacios) y selector:false', () => {
  writeManifest([
    { name: 'control-remoto-ia', url: 'https://gitlab.com/g/c.git', dir: `${HOME}/GitLab/CONTROL REMOTO IA` },
    { name: 'oculto', url: 'https://gitlab.com/g/o.git', selector: false },
  ]);
  const { projects } = gl.readManifest();
  assert.equal(projects[0].dir, `${HOME}/GitLab/CONTROL REMOTO IA`);
  assert.equal(projects[1].selector, false);
});

// ------------------------------------------------------------ 2. sin secretos

test('status() y la lista inyectada no exponen tokens, URLs con credenciales ni la contraseña', () => {
  const secret = 'SUPER-SECRETO-1234';
  fs.mkdirSync(path.join(HOME, '.config/opencode'), { recursive: true });
  fs.writeFileSync(path.join(HOME, '.config/opencode/mobile-remote-password'), secret);
  const dir = path.join(HOME, 'GitLab/demo');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git/HEAD'), 'ref: refs/heads/main\n');
  writeManifest([{ name: 'demo', url: 'https://gitlab.com/g/demo.git' }]);
  fs.mkdirSync(process.env.OPENCODE_REMOTE_STATE_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(process.env.OPENCODE_REMOTE_STATE_DIR, 'gitlab-projects-status.json'),
    JSON.stringify({ finished: '2026-10-11T00:00:00Z', projects: { demo: { state: 'error', reason: 'red', message: 'fatal: https://user:tok@gitlab.com/g/demo.git glpat-ABCDEFGHIJKLMNOPQRSTUV ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123', token: 'glpat-NOPE', password: secret, url: 'https://user:tok@gitlab.com/x.git' } } }),
  );
  const out = JSON.stringify(gl.status());
  for (const needle of [secret, 'glpat-', 'ghp_', 'user:tok', 'tok@', 'password', '"token"', '"url"']) assert.equal(out.includes(needle), false, `filtró ${needle}`);
  assert.ok(out.includes('"present":true'));
  const seed = gl.buildSeedScript(gl.presentDirs(gl.readManifest()));
  for (const needle of [secret, 'glpat-', 'gitlab.com', 'user:tok']) assert.equal(seed.includes(needle), false, `la lista inyectada filtró ${needle}`);
  assert.ok(seed.includes(dir));
});

test('handle(): GET devuelve JSON sin secretos; rutas desconocidas no se manejan', () => {
  const res = new EventEmitter();
  res.writeHead = (c, h) => ((res.status = c), (res.hdrs = h));
  res.end = (b) => (res.body = b);
  assert.equal(gl.handle({ method: 'GET', url: '/__opencode_remote/gitlab-projects' }, res), true);
  assert.equal(res.status, 200);
  assert.equal(res.hdrs['cache-control'], 'no-store');
  assert.ok(JSON.parse(res.body).projects);
  assert.equal(gl.handle({ method: 'GET', url: '/otra/ruta' }, res), false);
  assert.equal(gl.handle({ method: 'DELETE', url: '/__opencode_remote/gitlab-projects' }, res), false);
});

// ------------------------------------------------------------ 3. localStorage: merge + lápida

test('sin store de la app: no crea nada (la app es dueña del primer arranque y la migración)', () => {
  const s = boot(DIRS, {});
  assert.equal(s.size, 0);
});

test('merge: añade AL FINAL, conserva orden/otros campos/otros scopes y lastProject byte a byte', () => {
  const user = [`${HOME}/hostinger-clone`, `${HOME}/mio`];
  const original = JSON.stringify({
    list: [{ type: 'http', http: { url: 'https://x' } }],
    projects: { local: user.map((w) => ({ worktree: w, expanded: false })), 'https://otro': [{ worktree: '/otro', expanded: true }] },
    lastProject: { local: user[0], 'https://otro': '/otro' },
    recentlyClosed: { local: [`${HOME}/viejo`] },
    extra: { a: [1, 2, 3] },
  });
  const s = boot(DIRS, { [KEY]: original });
  const before = JSON.parse(original);
  const after = JSON.parse(s.get(KEY));
  assert.deepEqual(after.projects.local.map((p) => p.worktree), [...user, ...DIRS]);
  assert.deepEqual(after.projects.local.slice(0, 2), before.projects.local); // expanded:false del usuario intacto
  for (const k of ['list', 'lastProject', 'recentlyClosed', 'extra']) assert.deepEqual(after[k], before[k]);
  assert.deepEqual(after.projects['https://otro'], before.projects['https://otro']);
});

test('lista vacía: añade todos; segunda carga es idempotente (KEY y estado idénticos)', () => {
  const s1 = boot(DIRS, { [KEY]: appStore([]) });
  assert.deepEqual(worktrees(s1), DIRS);
  const s2 = boot(DIRS, { [KEY]: s1.get(KEY), [STATE]: s1.get(STATE) });
  assert.equal(s2.get(KEY), s1.get(KEY));
  assert.equal(s2.get(STATE), s1.get(STATE));
});

test('lápida persistente: si el usuario cierra uno, no reaparece en cargas siguientes', () => {
  const s1 = boot(DIRS, { [KEY]: appStore([`${HOME}/hostinger-clone`]) });
  const closedByUser = JSON.parse(s1.get(KEY));
  closedByUser.projects.local = closedByUser.projects.local.filter((p) => p.worktree !== DIRS[0]);
  const s2 = boot(DIRS, { [KEY]: JSON.stringify(closedByUser), [STATE]: s1.get(STATE) });
  assert.equal(worktrees(s2).includes(DIRS[0]), false);
  assert.equal(JSON.parse(s2.get(STATE)).closed[DIRS[0]], 1); // lápida escrita
  const s3 = boot(DIRS, { [KEY]: s2.get(KEY), [STATE]: s2.get(STATE) });
  const s4 = boot(DIRS, { [KEY]: s3.get(KEY), [STATE]: s3.get(STATE) });
  assert.equal(worktrees(s4).includes(DIRS[0]), false);
  assert.ok(worktrees(s4).includes(DIRS[1]) && worktrees(s4).includes(DIRS[2]));
});

test('proyecto ya abierto por el usuario: se adopta sin duplicar; si lo cierra después, lápida', () => {
  const s1 = boot(DIRS, { [KEY]: appStore([DIRS[1]]) });
  assert.equal(worktrees(s1).filter((w) => w === DIRS[1]).length, 1);
  const without = JSON.parse(s1.get(KEY));
  without.projects.local = without.projects.local.filter((p) => p.worktree !== DIRS[1]);
  const s2 = boot(DIRS, { [KEY]: JSON.stringify(without), [STATE]: s1.get(STATE) });
  assert.equal(worktrees(s2).includes(DIRS[1]), false);
});

test('recentlyClosed de la app se respeta como lápida', () => {
  const s = boot(DIRS, { [KEY]: appStore([`${HOME}/x`], { recentlyClosed: { local: [DIRS[2]] } }) });
  assert.equal(worktrees(s).includes(DIRS[2]), false);
  assert.equal(JSON.parse(s.get(STATE)).closed[DIRS[2]], 1);
});

test('un proyecto nuevo del manifiesto se añade; los ya cerrados siguen cerrados', () => {
  const s1 = boot(DIRS.slice(0, 2), { [KEY]: appStore([`${HOME}/x`]) });
  const trimmed = JSON.parse(s1.get(KEY));
  trimmed.projects.local = trimmed.projects.local.filter((p) => p.worktree !== DIRS[0]);
  const s2 = boot(DIRS, { [KEY]: JSON.stringify(trimmed), [STATE]: s1.get(STATE) });
  assert.equal(worktrees(s2).includes(DIRS[0]), false);
  assert.ok(worktrees(s2).includes(DIRS[2]));
});

test('entradas corruptas o con forma rara: no lanza y no toca nada', () => {
  assert.equal(boot(DIRS, { [KEY]: 'no es json' }).get(KEY), 'no es json');
  for (const raw of ['[]', '"x"', '7', 'null', JSON.stringify({ projects: [] }), JSON.stringify({ projects: { local: {} } })]) assert.equal(boot(DIRS, { [KEY]: raw }).get(KEY), raw);
  const s = boot(DIRS, { [KEY]: appStore([]), [STATE]: '{{{roto' }); // estado corrupto = vacío
  assert.deepEqual(worktrees(s), DIRS);
  assert.equal(JSON.parse(s.get(STATE)).v, 2);
});

test('si localStorage lanza (cuota) al escribir: no lanza, no deja estado a medias', () => {
  const s = boot(DIRS, { [KEY]: appStore([]) }, { throwOnKey: KEY });
  assert.equal(s.has(STATE), false); // se reintenta en la próxima carga
});

// ------------------------------------------------------------ 4. HTML

test('injectHtml / wantsHtml', () => {
  const html = '<!doctype html><html><head><title>x</title></head><body>hi</body></html>';
  const script = gl.buildSeedScript(DIRS);
  const out = gl.injectHtml(html, script);
  assert.ok(out.indexOf(script) < out.indexOf('</head>') && out.includes('<title>x</title>'));
  assert.equal(gl.injectHtml(out, script), out);
  assert.ok(gl.injectHtml('<html><body>b</body></html>', script).includes(script));
  assert.ok(gl.injectHtml('solo texto', script).startsWith('<script'));
  assert.equal(gl.injectHtml(html, ''), html);
  const req = (o) => ({ method: 'GET', url: '/', headers: {}, ...o });
  assert.equal(gl.wantsHtml(req({ headers: { accept: 'text/html,application/xhtml+xml' } })), true);
  assert.equal(gl.wantsHtml(req({ headers: { accept: '*/*' } })), false);
  assert.equal(gl.wantsHtml(req({ method: 'POST', headers: { accept: 'text/html' } })), false);
  assert.equal(gl.wantsHtml(req({ headers: { accept: 'text/html', upgrade: 'websocket' } })), false);
  assert.equal(gl.wantsHtml(req({ headers: { accept: 'text/html', range: 'bytes=0-1' } })), false);
  assert.equal(gl.wantsHtml(req({ url: '/__opencode_remote/status', headers: { accept: 'text/html' } })), false);
});

function fakeUpstream(status, headers, chunks, { error } = {}) {
  const fn = (options, cb) => {
    const up = new EventEmitter();
    up.destroy = () => {};
    fn.captured = options;
    process.nextTick(() => {
      if (error) return up.emit('error', new Error('boom'));
      const r = new EventEmitter();
      r.statusCode = status;
      r.headers = headers;
      r.pipe = (res) => {
        for (const c of chunks) res.write(c);
        res.end();
        return res;
      };
      cb(r);
      for (const c of chunks) r.emit('data', Buffer.from(c));
      r.emit('end');
    });
    return up;
  };
  return fn;
}
const fakeRes = () => {
  const r = new EventEmitter();
  r.headersSent = false;
  r.chunks = [];
  r.writeHead = (c, h) => ((r.status = c), (r.hdrs = h), (r.headersSent = true));
  r.flushHeaders = () => {};
  r.write = (c) => r.chunks.push(Buffer.from(c));
  r.end = (c) => (c && r.chunks.push(Buffer.from(c)), (r.done = true));
  r.destroy = () => {};
  return r;
};
const fakeReq = () => Object.assign(new EventEmitter(), { method: 'GET', url: '/', headers: { accept: 'text/html', 'accept-encoding': 'gzip, br' }, pipe: (d) => d });
const tick = () => new Promise((r) => setTimeout(r, 25));
const HTML = '<!doctype html><html><head><title>x</title></head><body>hi</body></html>';

test('proxyHtml: inyecta, ajusta cabeceras y pide identity', async () => {
  const res = fakeRes();
  const request = fakeUpstream(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': String(HTML.length), etag: 'W/"a"', 'content-encoding': 'identity' }, [HTML.slice(0, 20), HTML.slice(20)]);
  gl.proxyHtml(fakeReq(), res, { hostname: '127.0.0.1', port: 4096, path: '/', method: 'GET', headers: { 'accept-encoding': 'gzip', host: 'x' } }, { request, dirs: () => DIRS });
  await tick();
  const out = Buffer.concat(res.chunks).toString();
  assert.ok(out.includes('id="gitlab-projects-seed"') && out.includes('<title>x</title>') && out.endsWith('</html>'));
  assert.equal(res.hdrs['content-length'], String(Buffer.byteLength(out)));
  assert.equal(res.hdrs.etag, undefined);
  assert.equal(request.captured.headers['accept-encoding'], undefined);
});

test('proxyHtml: no-HTML y 404 pasan intactos; manifiesto roto entrega el original; upstream caído -> 503', async () => {
  let res = fakeRes();
  gl.proxyHtml(fakeReq(), res, { headers: {} }, { request: fakeUpstream(200, { 'content-type': 'application/json' }, ['{"a":1}']), dirs: () => DIRS });
  await tick();
  assert.equal(Buffer.concat(res.chunks).toString(), '{"a":1}');
  res = fakeRes();
  gl.proxyHtml(fakeReq(), res, { headers: {} }, { request: fakeUpstream(404, { 'content-type': 'text/html' }, ['nf']), dirs: () => DIRS });
  await tick();
  assert.equal(res.status, 404);
  res = fakeRes();
  gl.proxyHtml(fakeReq(), res, { headers: {} }, { request: fakeUpstream(200, { 'content-type': 'text/html' }, [HTML]), dirs: () => { throw new Error('manifest roto'); } });
  await tick();
  assert.equal(Buffer.concat(res.chunks).toString(), HTML);
  res = fakeRes();
  gl.proxyHtml(fakeReq(), res, { headers: {} }, { request: fakeUpstream(200, {}, [], { error: true }), dirs: () => DIRS });
  await tick();
  assert.equal(res.status, 503);
});

// ------------------------------------------------------------ 5. sync seguro (git real, repos temporales)

function makeRepos(name) {
  const base = path.join(HOME, 'sync', name);
  const bare = path.join(base, 'remote.git');
  const work = path.join(base, 'work');
  const other = path.join(base, 'other');
  fs.mkdirSync(base, { recursive: true });
  git(base, 'init', '-q', '--bare', '-b', 'main', bare);
  git(base, 'clone', '-q', bare, other);
  fs.writeFileSync(path.join(other, 'a.txt'), 'uno');
  git(other, 'add', '.');
  git(other, 'commit', '-qm', 'c1');
  git(other, 'push', '-q', 'origin', 'HEAD:main');
  git(base, 'clone', '-q', bare, work);
  const url = `https://gitlab.com/test/${name}.git`;
  git(work, 'remote', 'set-url', 'origin', url);
  git(work, 'config', `url.${bare}.insteadOf`, url); // el "GitLab" de la prueba es un repo bare local: cero red
  return { base, bare, work, other, url };
}
const syncOnly = (opts = {}) => gl.runSync({ ...opts });
const readLog = () => {
  try {
    return fs.readFileSync(path.join(process.env.OPENCODE_REMOTE_STATE_DIR, 'gitlab-sync.log'), 'utf8');
  } catch {
    return '';
  }
};

test('sync: carpeta existente = SOLO fetch; el árbol limpio no cambia aunque haya commits nuevos remotos', async () => {
  const r = makeRepos('solofetch');
  const headBefore = git(r.work, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(r.other, 'b.txt'), 'dos');
  git(r.other, 'add', '.');
  git(r.other, 'commit', '-qm', 'c2');
  git(r.other, 'push', '-q', 'origin', 'HEAD:main');
  writeManifest([{ name: 'solofetch', url: r.url, dir: r.work, branch: 'main' }]);
  const out = await syncOnly();
  const p = out.projects.solofetch;
  assert.equal(p.state, 'fetched');
  assert.equal(p.behind, 1); // el remoto avanzó…
  assert.equal(git(r.work, 'rev-parse', 'HEAD').trim(), headBefore); // …pero HEAD, índice y archivos no se movieron
  assert.equal(fs.existsSync(path.join(r.work, 'b.txt')), false);
  assert.equal(git(r.work, 'status', '--porcelain'), '');
  assert.ok(git(r.work, 'rev-parse', 'refs/remotes/origin/main').trim() !== headBefore); // la ref remota sí se actualizó
  assert.match(readLog(), /solofetch\tfetch\tok/);
});

test('sync: árbol sucio no se toca (archivos y estado idénticos) y se informa dirty', async () => {
  const r = makeRepos('sucio');
  fs.writeFileSync(path.join(r.work, 'a.txt'), 'CAMBIO LOCAL SIN COMMIT');
  fs.writeFileSync(path.join(r.work, 'nuevo.txt'), 'untracked');
  const before = git(r.work, 'status', '--porcelain');
  writeManifest([{ name: 'sucio', url: r.url, dir: r.work }]);
  const p = (await syncOnly()).projects.sucio;
  assert.equal(p.dirty, 2);
  assert.equal(git(r.work, 'status', '--porcelain'), before);
  assert.equal(fs.readFileSync(path.join(r.work, 'a.txt'), 'utf8'), 'CAMBIO LOCAL SIN COMMIT');
  assert.equal(fs.readFileSync(path.join(r.work, 'nuevo.txt'), 'utf8'), 'untracked');
});

test('sync: origin distinto al del manifiesto -> no se hace fetch', async () => {
  const r = makeRepos('otroorigin');
  git(r.work, 'remote', 'set-url', 'origin', 'https://gitlab.com/otro/proyecto.git');
  writeManifest([{ name: 'otroorigin', url: r.url, dir: r.work }]);
  const p = (await syncOnly()).projects.otroorigin;
  assert.equal(p.origin, 'distinto');
  assert.match(readLog(), /otroorigin\tfetch\tomitido\torigin_distinto/);
});

test('sync: fallo de fetch se clasifica y queda en el log; el repo no se altera', async () => {
  const r = makeRepos('fallo');
  git(r.work, 'config', `url.${path.join(r.base, 'no-existe.git')}.insteadOf`, r.url);
  git(r.work, 'config', '--unset', `url.${r.bare}.insteadOf`);
  const head = git(r.work, 'rev-parse', 'HEAD').trim();
  writeManifest([{ name: 'fallo', url: r.url, dir: r.work }]);
  const p = (await syncOnly()).projects.fallo;
  assert.equal(p.state, 'error');
  assert.equal(p.reason, 'repo_no_encontrado');
  assert.equal(git(r.work, 'rev-parse', 'HEAD').trim(), head);
  assert.match(readLog(), /fallo\tfetch\terror\trepo_no_encontrado/);
});

test('sync: timeout por operación -> reason timeout', async () => {
  const r = makeRepos('lento');
  writeManifest([{ name: 'lento', url: r.url, dir: r.work }]);
  const p = (await syncOnly({ timeouts: { fetch: 1 } })).projects.lento;
  assert.equal(p.reason, 'timeout');
});

test('repoIdentity: https, ssh:// y scp-like del mismo proyecto coinciden; otro proyecto no', () => {
  const a = gl.repoIdentity('https://gitlab.com/Grupo/Proy.git');
  for (const u of ['git@gitlab.com:Grupo/Proy.git', 'ssh://git@gitlab.com/Grupo/Proy.git', 'https://gitlab.com/Grupo/Proy', 'https://gitlab.com/Grupo/Proy.git/']) assert.equal(gl.repoIdentity(u), a, u);
  for (const u of ['https://gitlab.com/Grupo/Otro.git', 'https://github.com/Grupo/Proy.git', 'git@gitlab.com:Otro/Proy.git']) assert.notEqual(gl.repoIdentity(u), a, u);
});

test('classify: credenciales / red / timeout / repo / git', () => {
  assert.equal(gl.classify('fatal: could not read Username for \'https://gitlab.com\': terminal prompts disabled'), 'credenciales');
  assert.equal(gl.classify('remote: HTTP Basic: Access denied'), 'credenciales');
  assert.equal(gl.classify('fatal: unable to access \'https://gitlab.com/x.git/\': Could not resolve host: gitlab.com'), 'red');
  assert.equal(gl.classify('', true), 'timeout');
  assert.equal(gl.classify('fatal: repository \'x\' does not appear to be a git repository'), 'repo_no_encontrado');
  assert.equal(gl.classify('algo raro'), 'git');
});

test('sync: ruta ocupada por una carpeta que no es repo -> error y la carpeta queda intacta', async () => {
  const dir = path.join(HOME, 'GitLab/ocupada');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'mis-notas.txt'), 'no me borres');
  writeManifest([{ name: 'ocupada', url: 'https://gitlab.com/g/ocupada.git', dir }]);
  const p = (await syncOnly()).projects.ocupada;
  assert.equal(p.reason, 'ruta_ocupada');
  assert.equal(fs.readFileSync(path.join(dir, 'mis-notas.txt'), 'utf8'), 'no me borres');
  assert.match(readLog(), /ocupada\tcheck\terror\truta_ocupada/);
});

test('sync offline: carpeta ausente queda pending y NO se crea nada', async () => {
  const dir = path.join(HOME, 'GitLab/ausente');
  writeManifest([{ name: 'ausente', url: 'https://gitlab.com/g/ausente.git', dir }]);
  const p = (await syncOnly({ offline: true })).projects.ausente;
  assert.equal(p.state, 'pending');
  assert.equal(fs.existsSync(dir), false);
  assert.equal(fs.existsSync(`${dir}.cloning`), false);
});

test('sync: sin permiso de lectura se informa como permisos (TCC), sin intentar clonar', async () => {
  const dir = path.join(HOME, 'Documents/protegida');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.chmodSync(dir, 0);
  try {
    writeManifest([{ name: 'protegida', url: 'https://gitlab.com/g/protegida.git', dir }]);
    const p = (await syncOnly()).projects.protegida;
    assert.equal(p.reason, 'permisos');
    assert.equal(gl.status().projects[0].absent, 'sin_permiso');
    assert.equal(gl.presentDirs(gl.readManifest()).includes(dir), false);
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

// ------------------------------------------------------------ 6. lock

test('lock: un sync a la vez; un lock vivo bloquea, uno viejo o de un pid muerto se recupera', async () => {
  const lock = path.join(process.env.OPENCODE_REMOTE_STATE_DIR, 'gitlab-sync.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  const release = gl.acquireLock(lock);
  assert.ok(release);
  assert.equal(gl.acquireLock(lock), null); // segundo intento mientras el primero vive
  writeManifest([]);
  const skipped = await syncOnly();
  assert.match(skipped.skipped, /lock/);
  assert.match(readLog(), /-\tlock\tomitido\totro_proceso/);
  release();
  assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() })); // pid inexistente
  const second = gl.acquireLock(lock);
  assert.ok(second);
  second();
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, at: Date.now() - 60 * 60_000 })); // viejo
  const third = gl.acquireLock(lock);
  assert.ok(third);
  third();
  fs.writeFileSync(lock, 'basura'); // ilegible = obsoleto
  const fourth = gl.acquireLock(lock);
  assert.ok(fourth);
  fourth();
});

test('log: rota al pasar de 1 MB y nunca contiene credenciales', async () => {
  const log = path.join(process.env.OPENCODE_REMOTE_STATE_DIR, 'gitlab-sync.log');
  fs.writeFileSync(log, 'x'.repeat(1_100_000) + '\n');
  const r = makeRepos('rota');
  git(r.work, 'remote', 'set-url', 'origin', 'https://user:tok@gitlab.com/otro/proyecto.git');
  writeManifest([{ name: 'rota', url: r.url, dir: r.work }]);
  await syncOnly();
  const text = fs.readFileSync(log, 'utf8');
  assert.ok(text.length < 600_000);
  assert.equal(/user:tok|tok@/.test(text), false);
});

// ------------------------------------------------------------ 7. manifiesto real del usuario

test('manifiesto real (si existe): control remoto 1.º con nombre de carpeta visible, ODÓMETRO 2.º, sin copias ni centro-control-ia', () => {
  const real = '/Users/stalindelcasttillo/.config/opencode/gitlab-projects.json';
  if (!fs.existsSync(real)) return;
  const raw = JSON.parse(fs.readFileSync(real, 'utf8'));
  assert.deepEqual(raw.projects.map((p) => p.name), ['control-remoto-ia', 'odometro', 'stratta', 'magenta-real', 'magentaiastudio-project']);
  assert.equal(path.basename(raw.projects[0].dir), 'CONTROL REMOTO IA');
  assert.equal(raw.projects[0].url, 'https://gitlab.com/magentaiastudio-group/centro-control-ia-duo-lab.git');
  assert.equal(raw.projects.some((p) => /centro-control-ia\.git$/.test(p.url)), false);
  assert.equal(raw.projects.some((p) => 'seed' in p), false);
  assert.equal(raw.projects[1].dir, '/Users/stalindelcasttillo/Documents/ODOMETRO/odometro');
  assert.equal(raw.projects[3].dir, '/Users/stalindelcasttillo/magenta-real-gitlab-close');
});

after(() => fs.rmSync(HOME, { recursive: true, force: true }));
