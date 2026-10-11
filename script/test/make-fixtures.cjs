'use strict';
// Genera, con el proxy REAL ejecutándose en proceso (sin sockets), los mismos archivos que
// script/smoke-test.sh recoge por HTTP. Sirve para validar las aserciones del smoke test en
// entornos sin puertos:   node script/test/make-fixtures.cjs <dir> && SMOKE_ASSERT_ONLY=<dir> bash script/smoke-test.sh
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const { EventEmitter } = require('node:events');

const out = path.resolve(process.argv[2] || '');
if (!process.argv[2]) throw new Error('uso: node make-fixtures.cjs <dir>');
const home = path.join(out, 'home');
const state = path.join(home, '.local/state/opencode-mobile-remote');
const pw = crypto.randomBytes(12).toString('hex');
fs.mkdirSync(path.join(home, '.config/opencode'), { recursive: true });
fs.mkdirSync(state, { recursive: true });
fs.mkdirSync(path.join(home, 'GitLab/demo/.git'), { recursive: true });
fs.writeFileSync(path.join(home, 'GitLab/demo/.git/HEAD'), 'ref: refs/heads/main\n');
fs.writeFileSync(path.join(out, 'pw'), pw);
fs.writeFileSync(
  path.join(home, '.config/opencode/gitlab-projects.json'),
  JSON.stringify({ version: 2, root: path.join(home, 'GitLab'), projects: [{ name: 'demo', path: 'g/demo', url: 'https://gitlab.com/g/demo.git' }, { name: 'ausente', path: 'g/ausente', url: 'https://gitlab.com/g/ausente.git' }] }),
);
Object.assign(process.env, { HOME: home, OPENCODE_REMOTE_PASSWORD_FILE: path.join(out, 'pw'), OPENCODE_REMOTE_STATE_DIR: state, OPENCODE_REMOTE_PORT: '4198', OPENCODE_REMOTE_BIND: '127.0.0.1', OPENCODE_REMOTE_UPSTREAM_PORT: '4196' });
delete process.env.OPENCODE_GITLAB_MANIFEST;

// Same responses as script/test/fake-upstream.cjs
const HTML = '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>fake-opencode</title></head><body><div id="root">ok</div><script type="module" src="/app.js"></script></body></html>';
let handler;
const fakeHttp = {
  get: () => new EventEmitter(),
  request: (options, cb) => {
    const up = new EventEmitter();
    up.destroy = () => {};
    process.nextTick(() => {
      const accept = String(options.headers.accept || '');
      let body;
      let type;
      if (options.path.startsWith('/global/health')) [body, type] = ['{"healthy":true,"version":"fake"}', 'application/json'];
      else if (accept.includes('text/html')) [body, type] = [HTML, 'text/html; charset=utf-8'];
      else [body, type] = [JSON.stringify({ fake: true, path: options.path }), 'application/json'];
      const r = new EventEmitter();
      r.statusCode = 200;
      r.headers = { 'content-type': type };
      r.pipe = (res) => (res.write(body), res.end(), res);
      cb(r);
      r.emit('data', Buffer.from(body));
      r.emit('end');
    });
    return up;
  },
  createServer: (fn) => ((handler = fn), { listen: () => {}, on: () => {} }),
};
const realLoad = Module._load;
Module._load = function (request, ...rest) {
  return request === 'node:http' ? fakeHttp : realLoad.call(this, request, ...rest);
};
require(path.join(__dirname, '..', 'mobile-remote-proxy.cjs'));
Module._load = realLoad;

const auth = 'Basic ' + Buffer.from('opencode:' + pw).toString('base64');
function get(url, accept) {
  return new Promise((resolve) => {
    const req = Object.assign(new EventEmitter(), { method: 'GET', url, headers: { authorization: auth, accept }, pipe: (d) => d });
    const res = new EventEmitter();
    const chunks = [];
    res.headersSent = false;
    res.writeHead = (status, headers) => ((res.status = status), (res.hdrs = headers || {}), (res.headersSent = true));
    res.flushHeaders = () => {};
    res.write = (c) => chunks.push(Buffer.from(c));
    res.end = (c) => {
      if (c) chunks.push(Buffer.from(c));
      resolve({ status: res.status, headers: res.hdrs, body: Buffer.concat(chunks) });
    };
    res.destroy = () => {};
    handler(req, res);
  });
}

(async () => {
  const status = await get('/__opencode_remote/gitlab-projects', 'application/json');
  fs.writeFileSync(path.join(out, 'status.json'), status.body);
  fs.writeFileSync(path.join(out, 'status.code'), String(status.status));
  const page = await get('/', 'text/html,application/xhtml+xml');
  fs.writeFileSync(path.join(out, 'page.html'), page.body);
  fs.writeFileSync(path.join(out, 'page.headers'), `HTTP/1.1 ${page.status} OK\r\n${Object.entries(page.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
  fs.writeFileSync(path.join(out, 'json.out'), (await get('/session/abc', 'application/json')).body);
  fs.writeFileSync(path.join(out, 'health.out'), (await get('/global/health', '*/*')).body);
  console.log(`fixtures escritas en ${out}`);
  process.exit(0);
})();
