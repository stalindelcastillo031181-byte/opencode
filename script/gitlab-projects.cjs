'use strict';
// GitLab projects for the OpenCode mobile remote (iPhone).
//
// The web UI keeps its "opened projects" list (the project selector in the middle of the home
// screen) in the browser's localStorage, so the Mac cannot push projects into it directly.
// This module lets the proxy do it without touching the Cloudflare worker:
//   1. keeps a checkout of every GitLab project listed in ~/.config/opencode/gitlab-projects.json
//      (existing folder: only `git fetch`; missing folder: `git clone`) using the Mac's own git setup;
//      it never pulls, merges, resets or checks out anything and never touches a dirty tree;
//   2. injects a tiny script into the HTML the proxy serves that MERGES the checked-out projects into the
//      UI's opened-projects list, once per project, with a persistent tombstone for projects the user closed;
//   3. exposes /__opencode_remote/gitlab-projects (status) and /__opencode_remote/gitlab-sync (POST).
// Everything is best-effort: the proxy requires this file inside try/catch and falls back to plain
// pass-through if anything throws. Routes are only reachable after the proxy's own auth check.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { execFile } = require('node:child_process');

const SEED_ID = 'gitlab-projects-seed';
const FIRST_SYNC_DELAY_MS = 20_000;
const SYNC_INTERVAL_MS = 30 * 60_000;
const MANUAL_SYNC_GAP_MS = 60_000;
const LOCK_STALE_MS = 45 * 60_000;
const LOG_MAX_BYTES = 1_000_000;
const LOG_KEEP_BYTES = 256_000;
const TIMEOUT = { local: 60_000, fetch: 5 * 60_000, clone: 20 * 60_000 };
const URL_RE = /^https:\/\/gitlab\.com\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+\.git$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const GIT_BIN =
  ['/usr/local/bin/git', '/opt/homebrew/bin/git', '/usr/bin/git'].find((p) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }) || 'git';

// Lazy so tests and the smoke test can redirect HOME / state with environment variables.
function paths(overrides = {}) {
  const home = os.homedir();
  const state = process.env.OPENCODE_REMOTE_STATE_DIR || path.join(home, '.local/state/opencode-mobile-remote');
  return {
    home,
    manifest: overrides.manifestPath || process.env.OPENCODE_GITLAB_MANIFEST || path.join(home, '.config/opencode/gitlab-projects.json'),
    status: overrides.statusPath || path.join(state, 'gitlab-projects-status.json'),
    lock: overrides.lockPath || path.join(state, 'gitlab-sync.lock'),
    log: overrides.logPath || path.join(state, 'gitlab-sync.log'),
  };
}

// ---------------------------------------------------------------- manifest

const hasControlChars = (text) => /[\x00-\x1f\x7f]/.test(text);

function validDir(dir, home) {
  return (
    typeof dir === 'string' &&
    dir.length < 400 &&
    !hasControlChars(dir) &&
    path.isAbsolute(dir) &&
    path.resolve(dir) === dir &&
    dir.startsWith(home + path.sep)
  );
}

function readManifest(file) {
  const P = paths({ manifestPath: file });
  const fallback = { root: path.join(P.home, 'GitLab'), projects: [] };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(P.manifest, 'utf8'));
  } catch {
    return fallback;
  }
  if (!raw || typeof raw !== 'object') return fallback;
  const root = validDir(raw.root, P.home) ? raw.root : fallback.root;
  const seen = new Set();
  const projects = [];
  for (const item of Array.isArray(raw.projects) ? raw.projects : []) {
    if (!item || typeof item.name !== 'string' || typeof item.url !== 'string') continue;
    if (!NAME_RE.test(item.name) || seen.has(item.name) || !URL_RE.test(item.url)) continue;
    seen.add(item.name);
    projects.push({
      name: item.name,
      path: typeof item.path === 'string' ? item.path.slice(0, 200) : '',
      url: item.url,
      branch: typeof item.branch === 'string' ? item.branch.slice(0, 200) : undefined,
      // Existing clone to use in place (never copied). Must live under $HOME.
      dir: validDir(item.dir, P.home) ? item.dir : path.join(root, item.name),
      selector: item.selector !== false,
    });
  }
  return { root, projects };
}

// {present:true} when dir is a git checkout; otherwise the reason, so a macOS privacy block (TCC) on
// ~/Documents is reported instead of silently looking like "missing".
function probeCheckout(dir) {
  try {
    const git = path.join(dir, '.git');
    const stat = fs.statSync(git);
    if (stat.isFile()) return { present: true };
    fs.statSync(path.join(git, 'HEAD'));
    return { present: true };
  } catch (error) {
    const code = error && error.code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { present: false, reason: 'no_existe' };
    if (code === 'EPERM' || code === 'EACCES') return { present: false, reason: 'sin_permiso' };
    return { present: false, reason: `error_${String(code || 'desconocido').toLowerCase()}` };
  }
}

const hasCheckout = (dir) => probeCheckout(dir).present;

const presentDirs = (manifest) => manifest.projects.filter((p) => p.selector && hasCheckout(p.dir)).map((p) => p.dir);

// ------------------------------------------------------- html injection

// Runs before the app boots. MERGES each checked-out GitLab project into the UI's opened-projects store
// (localStorage "opencode.global.dat:server" -> projects.local); everything else in the store is left
// byte-for-byte as the app wrote it. Persistent state in "stalin.gitlab-projects.v2":
//   seeded[dir] = we added (or adopted) it once;  closed[dir] = tombstone, never added again.
// A seeded project that is no longer in the list was closed by the user -> tombstone. A project listed in
// the app's own recentlyClosed is also respected. It never creates the store (the app owns first-run and
// legacy migration) and never throws.
const SEED_BODY = `(function(){try{
var LIST=__LIST__;if(!LIST.length)return;
var KEY='opencode.global.dat:server',STATE='stalin.gitlab-projects.v2';
var raw=localStorage.getItem(KEY);if(raw===null)return;
var st=JSON.parse(raw);if(!st||typeof st!=='object'||Array.isArray(st))return;
var projects=(st.projects===undefined||st.projects===null)?{}:st.projects;
if(typeof projects!=='object'||Array.isArray(projects))return;
var local=(projects.local===undefined)?[]:projects.local;if(!Array.isArray(local))return;
var recent=[];if(st.recentlyClosed&&typeof st.recentlyClosed==='object'&&Array.isArray(st.recentlyClosed.local))recent=st.recentlyClosed.local;
var ts={};try{ts=JSON.parse(localStorage.getItem(STATE)||'{}')||{}}catch(e){ts={}}
if(typeof ts!=='object'||Array.isArray(ts))ts={};
var seeded=(ts.seeded&&typeof ts.seeded==='object'&&!Array.isArray(ts.seeded))?ts.seeded:{};
var closed=(ts.closed&&typeof ts.closed==='object'&&!Array.isArray(ts.closed))?ts.closed:{};
var have={};for(var i=0;i<local.length;i++){var w=local[i]&&local[i].worktree;if(typeof w==='string')have[w]=1}
var rc={};for(var k=0;k<recent.length;k++){if(typeof recent[k]==='string')rc[recent[k]]=1}
var add=[],changed=false;
for(var j=0;j<LIST.length;j++){var d=LIST[j];
if(closed[d])continue;
if(seeded[d]){if(!have[d]){closed[d]=1;changed=true}continue}
if(have[d]){seeded[d]=1;changed=true;continue}
if(rc[d]){closed[d]=1;changed=true;continue}
seeded[d]=1;changed=true;add.push({worktree:d,expanded:true})}
if(add.length){projects.local=local.concat(add);st.projects=projects;localStorage.setItem(KEY,JSON.stringify(st))}
if(changed)localStorage.setItem(STATE,JSON.stringify({v:2,seeded:seeded,closed:closed}));
}catch(e){}})();`;

// JSON for an inline <script>: no raw "<", ">", "&" or JS line terminators can survive.
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .split(String.fromCharCode(0x2028)).join('\\u2028')
    .split(String.fromCharCode(0x2029)).join('\\u2029');
}

function buildSeedScript(dirs) {
  const list = (Array.isArray(dirs) ? dirs : []).filter((d) => typeof d === 'string' && d.length > 0);
  if (list.length === 0) return '';
  return `<script id="${SEED_ID}">${SEED_BODY.replace('__LIST__', () => jsonForScript(list))}</script>`;
}

function injectHtml(html, script) {
  if (typeof html !== 'string' || !script || html.includes(`id="${SEED_ID}"`)) return html;
  const head = html.search(/<\/head\s*>/i);
  if (head >= 0) return html.slice(0, head) + script + html.slice(head);
  const body = html.search(/<body[^>]*>/i);
  if (body >= 0) return html.slice(0, body) + script + html.slice(body);
  return script + html;
}

function wantsHtml(req) {
  if (!req || req.method !== 'GET') return false;
  const headers = req.headers || {};
  if (headers.upgrade || headers.range) return false;
  if (!String(headers.accept || '').includes('text/html')) return false;
  return !String(req.url || '/').startsWith('/__opencode_remote/');
}

// Buffered variant of the proxy's final upstream hop, used only for HTML navigations.
function proxyHtml(req, res, options, deps = {}) {
  const request = deps.request || http.request;
  const dirs = deps.dirs || (() => presentDirs(readManifest()));
  const headers = { ...options.headers };
  delete headers['accept-encoding']; // identity, so the body can be edited as text
  const upstream = request({ ...options, headers }, (r) => {
    const type = String(r.headers['content-type'] || '');
    if (r.statusCode !== 200 || !/text\/html/i.test(type)) {
      res.writeHead(r.statusCode, r.headers);
      res.flushHeaders();
      r.pipe(res);
      return;
    }
    const chunks = [];
    r.on('data', (chunk) => chunks.push(chunk));
    r.on('error', () => res.destroy());
    r.on('end', () => {
      const original = Buffer.concat(chunks);
      let body = original;
      try {
        const text = original.toString('utf8');
        const html = injectHtml(text, buildSeedScript(dirs()));
        if (html !== text) body = Buffer.from(html, 'utf8');
      } catch {
        body = original;
      }
      const out = { ...r.headers };
      delete out['content-length'];
      delete out['transfer-encoding'];
      delete out['content-encoding'];
      delete out.etag;
      out['content-length'] = String(body.length);
      res.writeHead(r.statusCode, out);
      res.end(body);
    });
  });
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(503, { 'content-type': 'application/json' });
    res.end('{"healthy":false,"connected":false}');
  });
  req.pipe(upstream);
  res.on('close', () => upstream.destroy());
  return true;
}

// ------------------------------------------------------------------- sync

let running = false;
let lastManual = 0;

const redact = (text) =>
  String(text || '')
    .replace(/https?:\/\/[^\s/@]+@/g, 'https://***@')
    .replace(/glpat-[A-Za-z0-9_-]+/g, '***')
    .replace(/\b(?:ghp|gho|ghu|ghs)_[A-Za-z0-9]{20,}/g, '***')
    .slice(0, 300);
const firstLine = (text) =>
  String(text || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)[0] || '';

// Why a git operation failed, in the words the log should use.
function classify(stderr, timedOut) {
  if (timedOut) return 'timeout';
  const text = String(stderr || '');
  if (/could not read (Username|Password)|Authentication failed|terminal prompts disabled|HTTP Basic: Access denied|returned error: 40[13]|Permission denied \(publickey\)|invalid credentials|You are not allowed/i.test(text)) return 'credenciales';
  if (/Could not resolve host|Network is unreachable|Connection (timed out|refused|reset)|Failed to connect|unable to access|SSL|TLS|early EOF|RPC failed|Operation timed out/i.test(text)) return 'red';
  if (/Repository not found|does not appear to be a git repository/i.test(text)) return 'repo_no_encontrado';
  return 'git';
}

function writeLog(file, project, op, result, reason, detail) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) {
        const buffer = fs.readFileSync(file);
        fs.writeFileSync(file, buffer.subarray(buffer.length - LOG_KEEP_BYTES));
      }
    } catch {
      /* no log yet */
    }
    const line = [new Date().toISOString(), project, op, result, reason || '-', redact(detail || '').replace(/[\t\r\n]+/g, ' ')].join('\t');
    fs.appendFileSync(file, line + '\n');
  } catch {
    /* logging is informational only */
  }
}

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !!error && error.code === 'EPERM';
  }
};

// One sync at a time across processes: O_EXCL lock file, stale after LOCK_STALE_MS or when its pid is gone.
function acquireLock(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      return () => {
        try {
          fs.unlinkSync(file);
        } catch {
          /* already gone */
        }
      };
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw error;
      let info = null;
      try {
        info = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch {
        /* unreadable lock counts as stale */
      }
      const fresh = info && info.at && Date.now() - info.at < LOCK_STALE_MS && info.pid && pidAlive(info.pid);
      if (fresh) return null;
      try {
        fs.unlinkSync(file);
      } catch {
        /* lost the race; loop retries */
      }
    }
  }
  return null;
}

function git(args, { cwd, timeout = TIMEOUT.local, network = false } = {}) {
  return new Promise((resolve) => {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' };
    if (network) {
      env.GIT_HTTP_LOW_SPEED_LIMIT = '1000';
      env.GIT_HTTP_LOW_SPEED_TIME = '90';
    }
    execFile(GIT_BIN, args, { cwd, timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024, env }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || ''),
        timedOut: !!(error && (error.killed || error.signal === 'SIGKILL')),
      });
    });
  });
}

// host + repository path, whatever the protocol (https, ssh://, scp-like git@host:path): a clone made over SSH
// is still the same project.
function repoIdentity(url) {
  const text = String(url || '').trim();
  const match =
    /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/i.exec(text) || /^(?:[^@/]+@)?([^:/]+):(.+?)(?:\.git)?\/?$/.exec(text);
  return match ? `${match[1]}/${match[2]}`.toLowerCase() : text.toLowerCase();
}

async function describe(dir, branchHint) {
  const [branch, last, status] = await Promise.all([
    git(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']),
    git(['-C', dir, 'log', '-1', '--format=%h %cs']),
    git(['-C', dir, 'status', '--porcelain']),
  ]);
  const info = {
    branch: branch.code === 0 ? branch.stdout.trim() : undefined,
    head: last.code === 0 ? last.stdout.trim() : undefined,
    dirty: status.stdout.split('\n').filter(Boolean).length,
  };
  const name = info.branch && info.branch !== 'HEAD' ? info.branch : branchHint;
  if (name) {
    const counts = await git(['-C', dir, 'rev-list', '--left-right', '--count', `HEAD...refs/remotes/origin/${name}`]);
    const match = counts.code === 0 && /^(\d+)\s+(\d+)/.exec(counts.stdout.trim());
    if (match) {
      info.ahead = Number(match[1]);
      info.behind = Number(match[2]);
    }
  }
  return info;
}

async function syncProject(p, opts, files) {
  const out = { at: new Date().toISOString() };
  const T = { ...TIMEOUT, ...(opts.timeouts || {}) };
  const log = (op, result, reason, detail) => writeLog(files.log, p.name, op, result, reason, detail);
  const probe = probeCheckout(p.dir);

  if (!probe.present && probe.reason === 'sin_permiso') {
    log('check', 'error', 'permisos', `macOS no deja leer ${p.dir}`);
    return { ...out, state: 'error', reason: 'permisos', message: 'sin permiso de lectura (macOS: Documentos/privacidad)' };
  }

  if (!probe.present) {
    if (fs.existsSync(p.dir)) {
      log('check', 'error', 'ruta_ocupada', `${p.dir} existe y no es un repositorio git; no se toca`);
      return { ...out, state: 'error', reason: 'ruta_ocupada', message: 'la carpeta existe pero no es un repositorio git; no se toca' };
    }
    if (opts.offline) {
      log('clone', 'omitido', 'offline', 'modo sin red');
      return { ...out, state: 'pending', message: 'sin carpeta; se clonará con las credenciales de git del Mac' };
    }
    const tmp = `${p.dir}.cloning`;
    if (!tmp.endsWith('.cloning') || !tmp.startsWith(files.home + path.sep)) {
      return { ...out, state: 'error', reason: 'ruta_ocupada', message: 'ruta de clonado no válida' };
    }
    fs.mkdirSync(path.dirname(p.dir), { recursive: true });
    fs.rmSync(tmp, { recursive: true, force: true });
    const cloned = await git(['clone', '--quiet', p.url, tmp], { timeout: T.clone, network: true });
    if (cloned.code !== 0) {
      fs.rmSync(tmp, { recursive: true, force: true });
      const reason = classify(cloned.stderr, cloned.timedOut);
      log('clone', 'error', reason, firstLine(cloned.stderr) || 'git clone falló');
      return { ...out, state: 'error', reason, message: redact(firstLine(cloned.stderr)) || 'git clone falló' };
    }
    fs.renameSync(tmp, p.dir);
    out.state = 'cloned';
    out.how = 'clon de GitLab';
    log('clone', 'ok', '-', p.dir);
  } else {
    out.state = 'ready';
  }

  Object.assign(out, await describe(p.dir, p.branch));
  if (opts.offline) return out;

  // The configured URL, not `remote get-url`: that one applies url.<base>.insteadOf rewrites.
  const origin = await git(['-C', p.dir, 'config', '--get', 'remote.origin.url']);
  if (origin.code !== 0) {
    out.origin = 'sin_origin';
    log('fetch', 'omitido', 'sin_origin', 'el repositorio no tiene remoto origin');
    return out;
  }
  if (repoIdentity(origin.stdout) !== repoIdentity(p.url)) {
    out.origin = 'distinto';
    log('fetch', 'omitido', 'origin_distinto', redact(origin.stdout.trim()));
    return out;
  }
  out.origin = 'ok';

  // Fetch only: updates remote-tracking refs, never the working tree, the index or any branch.
  const fetched = await git(['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-C', p.dir, 'fetch', '--no-tags', '--prune', '--quiet', 'origin'], {
    timeout: T.fetch,
    network: true,
  });
  if (fetched.code !== 0) {
    const reason = classify(fetched.stderr, fetched.timedOut);
    out.reason = reason;
    out.message = redact(firstLine(fetched.stderr)) || 'git fetch falló';
    if (out.state === 'ready') out.state = 'error';
    log('fetch', 'error', reason, firstLine(fetched.stderr) || 'git fetch falló');
    return out;
  }
  if (out.state === 'ready') out.state = 'fetched';
  Object.assign(out, await describe(p.dir, p.branch));
  log('fetch', 'ok', '-', `behind=${out.behind ?? '?'} ahead=${out.ahead ?? '?'} dirty=${out.dirty}`);
  return out;
}

function writeStatus(summary, file) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(summary, null, 1));
    fs.renameSync(tmp, file);
  } catch {
    /* status is informational only */
  }
}

async function runSync(opts = {}) {
  if (running) return { skipped: 'ya hay una sincronización en curso' };
  running = true;
  const P = paths(opts);
  const files = { log: P.log, home: P.home };
  let release = null;
  try {
    release = acquireLock(P.lock);
    if (!release) {
      writeLog(P.log, '-', 'lock', 'omitido', 'otro_proceso', 'otra sincronización tiene el lock');
      return { skipped: 'otra sincronización tiene el lock' };
    }
    const started = new Date().toISOString();
    const manifest = readManifest(P.manifest);
    const projects = {};
    // Existing checkouts (quick fetch) go before clones (slow).
    const rank = (p) => (hasCheckout(p.dir) ? 0 : 1);
    const ordered = manifest.projects.map((p, i) => [p, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map((x) => x[0]);
    for (const p of ordered) {
      try {
        projects[p.name] = await syncProject(p, opts, files);
      } catch (error) {
        projects[p.name] = { state: 'error', reason: 'git', message: redact(error && error.message), at: new Date().toISOString() };
        writeLog(P.log, p.name, 'sync', 'error', 'git', error && error.message);
      }
      writeStatus({ started, finished: null, offline: !!opts.offline, projects }, P.status);
    }
    const summary = { started, finished: new Date().toISOString(), offline: !!opts.offline, projects };
    writeStatus(summary, P.status);
    return summary;
  } finally {
    if (release) release();
    running = false;
  }
}

// ------------------------------------------------------------ http routes

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

const STATUS_KEYS = ['state', 'reason', 'message', 'how', 'branch', 'head', 'dirty', 'ahead', 'behind', 'origin', 'at'];

// Whitelisted fields only, strings redacted again: nothing but project/state facts leaves the Mac.
function sanitizeEntry(entry) {
  const out = {};
  if (!entry || typeof entry !== 'object') return out;
  for (const key of STATUS_KEYS) {
    if (entry[key] === undefined) continue;
    out[key] = typeof entry[key] === 'string' ? redact(entry[key]) : entry[key];
  }
  return out;
}

function status(opts = {}) {
  const P = paths(opts);
  const manifest = readManifest(P.manifest);
  let last = {};
  try {
    last = JSON.parse(fs.readFileSync(P.status, 'utf8')) || {};
  } catch {
    /* no sync has run yet */
  }
  return {
    root: manifest.root,
    syncing: running,
    lastRun: typeof last.finished === 'string' ? last.finished : null,
    projects: manifest.projects.map((p) => {
      const probe = probeCheckout(p.dir);
      return {
        name: p.name,
        path: p.path,
        dir: p.dir,
        selector: p.selector,
        present: probe.present,
        ...(probe.present ? {} : { absent: probe.reason }),
        ...sanitizeEntry(last.projects && last.projects[p.name]),
      };
    }),
  };
}

// Returns true when the request was handled. Call only after the proxy's auth check.
function handle(req, res) {
  const pathname = String(req.url || '').split('?')[0];
  if (pathname === '/__opencode_remote/gitlab-projects' && req.method === 'GET') {
    json(res, 200, status());
    return true;
  }
  if (pathname === '/__opencode_remote/gitlab-sync' && req.method === 'POST') {
    const now = Date.now();
    if (running || now - lastManual < MANUAL_SYNC_GAP_MS) {
      json(res, 429, { started: false, syncing: running });
      return true;
    }
    lastManual = now;
    runSync({}).catch(() => undefined);
    json(res, 202, { started: true });
    return true;
  }
  return false;
}

function start() {
  const tick = () =>
    runSync({})
      .then((summary) => {
        if (summary && summary.projects) {
          const line = Object.entries(summary.projects)
            .map(([name, item]) => `${name}=${item.state}${item.reason ? `(${item.reason})` : ''}`)
            .join(' ');
          console.log(`[gitlab-projects] sync ${line}`);
        }
      })
      .catch(() => undefined);
  setTimeout(() => {
    tick();
    setInterval(tick, SYNC_INTERVAL_MS).unref();
  }, FIRST_SYNC_DELAY_MS).unref();
}

module.exports = {
  paths,
  readManifest,
  presentDirs,
  probeCheckout,
  buildSeedScript,
  jsonForScript,
  injectHtml,
  wantsHtml,
  proxyHtml,
  classify,
  repoIdentity,
  acquireLock,
  runSync,
  status,
  handle,
  start,
  redact,
  SEED_ID,
};
