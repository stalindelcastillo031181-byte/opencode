'use strict';
// Tiny stand-in for `opencode serve`, used only by script/smoke-test.sh.   node fake-upstream.cjs [port]
const http = require('node:http');

const port = Number(process.argv[2] || 4196);
const html = '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>fake-opencode</title></head><body><div id="root">ok</div><script type="module" src="/app.js"></script></body></html>';

http
  .createServer((req, res) => {
    if (req.url.startsWith('/global/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"healthy":true,"version":"fake"}');
    }
    if (req.url.startsWith('/global/event')) {
      res.writeHead(404);
      return res.end();
    }
    if (String(req.headers.accept || '').includes('text/html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ fake: true, path: req.url }));
  })
  .listen(port, '127.0.0.1', () => console.log(`fake upstream on ${port}`));
