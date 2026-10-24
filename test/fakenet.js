'use strict';
// 模拟多个 CDN 节点：每个 host 可以设置首包延迟、速度、中途卡死、固定返回某个状态码

function byteAt(i) {
  return (i * 131 + 7) & 255;
}

function abortErr() {
  return new DOMException('aborted', 'AbortError');
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortErr());
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(t);
      reject(abortErr());
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

function makeNet(spec, fileSize) {
  const net = { inflight: 0, log: [], aborts: 0 };

  net.fetch = async function (url, init) {
    init = init || {};
    const u = new URL(url);
    const node = spec[u.host];
    if (!node) throw new TypeError('unknown host ' + u.host);
    const h = init.headers || {};
    const range = h.Range || h.range || (typeof h.get === 'function' ? h.get('Range') : null);
    const m = /bytes=(\d+)-(\d+)/.exec(range || '');
    // 坏节点：fileSize 不同（另一份文件）或 variant 为真（长度相同但内容不同）
    const size = node.fileSize || fileSize;
    const content = node.variant ? (i => (i * 131 + 9) & 255) : byteAt;
    const a = m ? Number(m[1]) : 0;
    const b = m ? Math.min(Number(m[2]), size - 1) : size - 1;
    const entry = { host: u.host, a, b, aborted: false, bytes: 0 };
    net.log.push(entry);
    const signal = init.signal;
    let open = true;
    net.inflight++;
    const close = aborted => {
      if (!open) return;
      open = false;
      net.inflight--;
      if (aborted) { entry.aborted = true; net.aborts++; }
    };
    try {
      await sleep(node.ttfb || 0, signal);
    } catch (e) {
      close(true);
      throw e;
    }
    if (node.status) {
      close(false);
      return new Response('denied', { status: node.status });
    }
    let pos = a;
    let sent = 0;
    const piece = 32768;
    const bodyStart = Date.now();
    const stream = new ReadableStream({
      async pull(c) {
        try {
          if (pos > b) { close(false); c.close(); return; }
          if (node.stallAfter != null && sent >= node.stallAfter) await sleep(3600 * 1000, signal);
          const n = Math.min(piece, b - pos + 1);
          // 按累计进度控速：Windows 定时器精度约 15ms，逐块 sleep 会把快节点压到 1MB/s 左右
          // 已经落后于计划就不再 sleep（Windows 上 setTimeout(0) 也要等十几毫秒，会把快节点拖慢）
          const due = bodyStart + (sent + n) / node.bps * 1000;
          const wait = due - Date.now();
          if (wait > 2) await sleep(wait, signal);
          else await new Promise(r => setImmediate(r));
          if (signal && signal.aborted) throw abortErr();
          const buf = new Uint8Array(n);
          for (let i = 0; i < n; i++) buf[i] = content(pos + i);
          pos += n;
          sent += n;
          entry.bytes += n;
          c.enqueue(buf);
        } catch (e) {
          close(true);
          throw e;
        }
      },
      cancel() { close(true); },
    });
    return new Response(stream, {
      status: 206,
      headers: { 'Content-Range': 'bytes ' + a + '-' + b + '/' + size, 'Content-Type': 'video/mp4' },
    });
  };
  return net;
}

async function readAll(stream) {
  const reader = stream.getReader();
  const parts = [];
  let len = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    parts.push(r.value);
    len += r.value.length;
  }
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function firstMismatch(bytes, start) {
  for (let i = 0; i < bytes.length; i++) if (bytes[i] !== byteAt(start + i)) return i;
  return -1;
}

module.exports = { makeNet, readAll, firstMismatch, byteAt, sleep };
