'use strict';
// Runs the REAL script/mobile-remote-proxy.cjs in-process with `node:http` replaced by a fake, so the
// request handler can be exercised without opening sockets (works inside sandboxes that forbid bind()).
// Covers: auth gating of the new routes, HTML injection through the real proxy code path, pass-through of
// everything else, and the env overrides the smoke test relies on.   Run: node --test script/test/
const test = require('node:test');
const { after } = test;
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const HOME = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'proxy-inproc-'));
const PASSWORD = 'pw-de-prueba-9f3a';
const STATE_DIR = path.join(HOME, 'state');
const PROXY = path.join(__dirname, '..', 'mobile-remote-proxy.cjs');
fs.mkdirSync(path.join(HOME, '.config/opencode'), { recursive: true });
fs.mkdirSync(STATE_DIR, { recursive: true });
fs.writeFileSync(path.join(HOME, 'pw'), PASSWORD);
const demo = path.join(HOME, 'GitLab/demo');
fs.mkdirSync(path.join(demo, '.git'), { recursive: true });
fs.writeFileSync(path.join(demo, '.git/HEAD'), 'ref: refs/heads/main\n');
const manifest = (projects) => fs.writeFileSync(path.join(HOME, 'manifest.json'), JSON.stringify({ version: 2, root: path.join(HOME, 'GitLab'), projects }));
manifest([{ name: 'demo', url: 'https://gitlab.com/g/demo.git', path: 'g/demo' }]);

Object.assign(process.env, {
  HOME,
  OPENCODE_REMOTE_PASSWORD_FILE: path.join(HOME, 'pw'),
  OPENCODE_REMOTE_STATE_DIR: STATE_DIR,
  OPENCODE_GITLAB_MANIFEST: path.join(HOME, 'manifest.json'),
  OPENCODE_REMOTE_PORT: '4198',
  OPENCODE_REMOTE_BIND: '127.0.0.1',
  OPENCODE_REMOTE_UPSTREAM_PORT: '4196',
});

// ---- fake node:http
const captured = { gets: [], requests: [], upgradeHandlers: {} };
let scenario = null; // what the fake upstream answers next: {status, headers, chunks}
const fakeHttp = {
  get: (options) => {
    captured.gets.push(options);
    return new EventEmitter(); // subscribe(): never answers, never errors -> no retry timers
  },
  request: (options, cb) => {
    captured.requests.push(options);
    const up = new EventEmitter();
    up.destroy = () => {};
    up.end = () => {};
    process.nextTick(() => {
      if (!cb || !scenario) return;
      const r = new EventEmitter();
      r.statusCode = scenario.status;
      r.headers = scenario.headers;
      r.pipe = (res) => {
        for (const c of scenario.chunks) res.write(c);
        res.end();
        return res;
      };
      cb(r);
      for (const c of scenario.chunks) r.emit('data', Buffer.from(c));
      r.emit('end');
    });
    return up;
  },
  createServer: (handler) => {
    captured.handler = handler;
    return {
      listen: (...args) => (captured.listen = args),
      on: (event, fn) => (captured.upgradeHandlers[event] = fn),
    };
  },
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'node:http' ? fakeHttp : realLoad.call(this, request, ...rest);
};
require(PROXY); // executes the real proxy file
Module._load = realLoad;

const basic = 'Basic ' + Buffer.from('opencode:' + PASSWORD).toString('base64');
const mkReq = (o = {}) => Object.assign(new EventEmitter(), { method: 'GET', url: '/', headers: {}, pipe: (d) => d }, o);
const mkRes = () => {
  const r = new EventEmitter();
  r.headersSent = false;
  r.chunks = [];
  r.writeHead = (c, h) => ((r.status = c), (r.hdrs = h || {}), (r.headersSent = true));
  r.flushHeaders = () => {};
  r.write = (c) => r.chunks.push(Buffer.from(c));
  r.end = (c) => (c && r.chunks.push(Buffer.from(c)), (r.done = true));
  r.destroy = () => {};
  r.text = () => Buffer.concat(r.chunks).toString('utf8');
  return r;
};
const tick = () => new Promise((r) => setTimeout(r, 25));
const call = async (req) => {
  const res = mkRes();
  captured.requests.length = 0;
  captured.handler(req, res);
  await tick();
  return res;
};
const HTML = '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>fake-opencode</title></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>';

test('el proxy real carga con el módulo y respeta las variables de entorno', () => {
  assert.equal(typeof captured.handler, 'function');
  assert.deepEqual(captured.listen, [4198, '127.0.0.1']);
  assert.equal(captured.gets[0].port, 4196);
  assert.equal(captured.gets[0].path, '/global/event');
  assert.equal(typeof captured.upgradeHandlers.upgrade, 'function');
});

test('sin credenciales: las rutas nuevas, el HTML y todo lo demás dan 401 y no llegan al upstream', async () => {
  for (const [method, url, accept] of [['GET', '/__opencode_remote/gitlab-projects', 'application/json'], ['POST', '/__opencode_remote/gitlab-sync', '*/*'], ['GET', '/', 'text/html'], ['GET', '/session', 'application/json']]) {
    const res = await call(mkReq({ method, url, headers: { accept } }));
    assert.equal(res.status, 401, `${method} ${url}`);
    assert.equal(res.text(), 'Unauthorized');
    assert.equal(captured.requests.length, 0);
  }
  const bad = await call(mkReq({ url: '/__opencode_remote/gitlab-projects', headers: { authorization: 'Basic ' + Buffer.from('opencode:otra').toString('base64') } }));
  assert.equal(bad.status, 401);
});

test('con credenciales: GET /__opencode_remote/gitlab-projects devuelve JSON del manifiesto sin secretos', async () => {
  const res = await call(mkReq({ url: '/__opencode_remote/gitlab-projects', headers: { authorization: basic } }));
  assert.equal(res.status, 200);
  assert.equal(res.hdrs['content-type'], 'application/json');
  const body = res.text();
  const data = JSON.parse(body);
  assert.deepEqual(data.projects.map((p) => [p.name, p.present]), [['demo', true]]);
  for (const needle of [PASSWORD, basic, 'glpat-', 'authorization']) assert.equal(body.includes(needle), false, `filtró ${needle}`);
  assert.equal(captured.requests.length, 0); // lo atiende el proxy, no el upstream
});

test('con credenciales: la navegación HTML llega al upstream (puerto 4196), vuelve con la lista inyectada y válida', async () => {
  scenario = { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'content-length': String(HTML.length), etag: 'W/"x"' }, chunks: [HTML.slice(0, 50), HTML.slice(50)] };
  const res = await call(mkReq({ url: '/', headers: { authorization: basic, accept: 'text/html,application/xhtml+xml', 'accept-encoding': 'gzip, br', cookie: 'x=1' } }));
  const out = res.text();
  assert.equal(res.status, 200);
  assert.equal(captured.requests.length, 1);
  assert.equal(captured.requests[0].port, 4196);
  assert.equal(captured.requests[0].headers.host, '127.0.0.1:4196');
  assert.equal(captured.requests[0].headers['accept-encoding'], undefined);
  assert.ok(out.startsWith('<!doctype html>') && out.endsWith('</html>'));
  assert.equal((out.match(/<head>/g) || []).length, 1);
  assert.equal((out.match(/<\/head>/g) || []).length, 1);
  assert.equal((out.match(/<script/g) || []).length, 2); // la siembra + el módulo de la app
  assert.equal((out.match(/<\/script>/g) || []).length, 2);
  assert.ok(out.includes('<title>fake-opencode</title>') && out.includes('id="gitlab-projects-seed"') && out.includes(demo));
  assert.ok(out.indexOf('id="gitlab-projects-seed"') < out.indexOf('src="/app.js"')); // corre antes que la app
  assert.equal(res.hdrs['content-length'], String(Buffer.byteLength(out)));
  assert.equal(res.hdrs.etag, undefined);
  assert.equal(out.includes(PASSWORD), false);
});

test('con credenciales: lo que no es HTML pasa intacto (sin siembra, accept-encoding conservado)', async () => {
  scenario = { status: 200, headers: { 'content-type': 'application/json' }, chunks: ['{"ok":true}'] };
  const res = await call(mkReq({ url: '/session', headers: { authorization: basic, accept: 'application/json', 'accept-encoding': 'gzip' } }));
  assert.equal(res.text(), '{"ok":true}');
  assert.equal(captured.requests[0].headers['accept-encoding'], 'gzip');
  assert.equal(captured.requests[0].port, 4196);
  scenario = { status: 200, headers: { 'content-type': 'text/css' }, chunks: ['body{}'] };
  const css = await call(mkReq({ url: '/assets/a.css', headers: { authorization: basic, accept: 'text/css,*/*;q=0.1' } }));
  assert.equal(css.text(), 'body{}');
});

test('con credenciales: POST /__opencode_remote/gitlab-sync arranca un sync (202) y el segundo se frena (429)', async () => {
  manifest([]); // sin proyectos: el sync no toca red ni git
  const first = await call(mkReq({ method: 'POST', url: '/__opencode_remote/gitlab-sync', headers: { authorization: basic } }));
  assert.equal(first.status, 202);
  await new Promise((r) => setTimeout(r, 100));
  const second = await call(mkReq({ method: 'POST', url: '/__opencode_remote/gitlab-sync', headers: { authorization: basic } }));
  assert.equal(second.status, 429);
});

test('upgrade (WebSocket) sin credenciales se rechaza con 401', () => {
  let written = '';
  const socket = { end: (t) => (written += t), destroy: () => {}, on: () => {}, write: () => {}, pipe: () => {} };
  captured.upgradeHandlers.upgrade({ headers: {}, url: '/ws', method: 'GET' }, socket, Buffer.alloc(0));
  assert.match(written, /401 Unauthorized/);
});

test('orden del código: la comprobación de auth va ANTES de cualquier ruta nueva o inyección', () => {
  const src = fs.readFileSync(PROXY, 'utf8');
  const auth = src.indexOf('timingSafeEqual');
  const handle = src.indexOf('gl.handle(');
  const html = src.indexOf('gl.proxyHtml(');
  assert.ok(auth > 0 && handle > auth && html > handle, 'auth debe preceder a gl.handle y gl.proxyHtml');
  assert.match(src, /let gl=null;try\{gl=require\('\.\/gitlab-projects\.cjs'\)\}catch/); // si el módulo falla, el proxy sigue como antes
  assert.match(src, /try\{if\(gl\.handle\(req,res\)\)return;\}catch\{\}/);
  assert.match(src, /try\{if\(gl\.proxyHtml\(/);
  assert.match(src, /OPENCODE_REMOTE_UPSTREAM_PORT\|\|4096/); // valores por defecto = comportamiento original
  assert.match(src, /OPENCODE_REMOTE_PORT\|\|4097/);
  assert.match(src, /OPENCODE_REMOTE_BIND\|\|'0\.0\.0\.0'/);
});

after(() => fs.rmSync(HOME, { recursive: true, force: true }));
