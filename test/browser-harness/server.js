'use strict';
// 浏览器端验证用：8765 提供测试页和脚本；8766 快节点、8767 慢节点、8768 一律 403，都支持 Range 和 CORS
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SIZE = 8 * 1024 * 1024;
const byteAt = i => (i * 131 + 7) & 255;

http.createServer((req, res) => {
  const file = req.url === '/' ? path.join(__dirname, 'index.html')
    : req.url === '/bilibili-accelerator.user.js' ? path.join(ROOT, 'bilibili-accelerator.user.js') : null;
  if (!file) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(8765);

function cdn(port, bps, status) {
  http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Range',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Content-Type',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    if (status) { res.writeHead(status, cors); res.end('denied'); return; }
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    const a = m ? Number(m[1]) : 0;
    const b = m ? Math.min(Number(m[2]), SIZE - 1) : SIZE - 1;
    res.writeHead(m ? 206 : 200, Object.assign({
      'Content-Type': 'video/mp4',
      'Content-Length': String(b - a + 1),
      'Content-Range': 'bytes ' + a + '-' + b + '/' + SIZE,
      'Cache-Control': 'no-store',
    }, cors));
    let pos = a;
    const t0 = Date.now();
    let sent = 0;
    let closed = false;
    req.on('close', () => { closed = true; });
    (function pump() {
      if (closed) return;
      if (pos > b) { res.end(); return; }
      const n = Math.min(65536, b - pos + 1);
      const buf = Buffer.alloc(n);
      for (let i = 0; i < n; i++) buf[i] = byteAt(pos + i);
      pos += n;
      sent += n;
      res.write(buf);
      const due = t0 + sent / bps * 1000;
      setTimeout(pump, Math.max(0, due - Date.now()));
    })();
  }).listen(port);
}

cdn(8766, 20 * 1024 * 1024);
cdn(8767, 1 * 1024 * 1024);
cdn(8768, 0, 403);
console.log('harness on http://localhost:8765/');
