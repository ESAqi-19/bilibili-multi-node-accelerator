'use strict';
// 用真实的 B 站 CDN 对比：播放器原本的单节点请求 vs 加速器（固定分块 / 自适应分块）。
// 每个拖动位置三种方式轮流跑、轮换先后顺序，报告中位数和 P90。只下载到内存，不落盘。
// 用法：node test/real-cdn.js [BV号] [位置数]   不填 BV 号则从热门里挑一个最长的视频。
const { createCore } = require('../bilibili-accelerator.user.js');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const MB = 1024 * 1024;
const FIRST = 512 * 1024;   // 拖动后能接着播放，大约需要先拿到这么多数据
const UPOS_MIRRORS = ['upos-sz-mirrorcos.bilivideo.com', 'upos-sz-mirrorali.bilivideo.com', 'upos-sz-mirrorhw.bilivideo.com',
  'upos-sz-mirrorcoso1.bilivideo.com', 'upos-sz-mirror08c.bilivideo.com', 'upos-sz-estgoss.bilivideo.com'];

function biliFetch(url, init) {
  init = init || {};
  return fetch(url, Object.assign({}, init, {
    headers: Object.assign({ Referer: 'https://www.bilibili.com/', 'User-Agent': UA }, init.headers || {}),
  }));
}

async function json(url) {
  return (await biliFetch(url)).json();
}

async function pickVideo(bvid) {
  if (!bvid) {
    const pop = await json('https://api.bilibili.com/x/web-interface/popular?ps=20&pn=1');
    const list = (pop.data && pop.data.list) || [];
    list.sort((a, b) => b.duration - a.duration);
    bvid = list[0].bvid;
  }
  const view = await json('https://api.bilibili.com/x/web-interface/view?bvid=' + bvid);
  return { bvid, cid: view.data.cid, title: view.data.title, duration: view.data.duration };
}

async function drain(body, t0) {
  const reader = body.getReader();
  let n = 0;
  let first = null;
  for (;;) {
    const r = await reader.read();
    if (r.done) return { n, first };
    n += r.value.length;
    if (first == null && n >= FIRST) first = performance.now() - t0;
  }
}

async function single(url, a, b) {
  const t0 = performance.now();
  const res = await biliFetch(url, { headers: { Range: 'bytes=' + a + '-' + b } });
  if (res.status !== 206) throw new Error('HTTP ' + res.status);
  const d = await drain(res.body, t0);
  return { ms: performance.now() - t0, first: d.first, n: d.n };
}

async function accel(core, url, a, b) {
  const t0 = performance.now();
  const info = await core.request(url, a, b, null);
  const d = await drain(info.body, t0);
  return { ms: performance.now() - t0, first: d.first, n: d.n };
}

function pct(arr, p) {
  const s = arr.slice().sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1) + 0.5))];
}

(async () => {
  const v = await pickVideo(process.argv[2]);
  const trials = Number(process.argv[3]) || 10;
  const play = await json('https://api.bilibili.com/x/player/playurl?bvid=' + v.bvid + '&cid=' + v.cid + '&qn=80&fnval=16&fourk=1');
  const rep = play.data.dash.video.slice().sort((x, y) => y.bandwidth - x.bandwidth)[0];
  const base = rep.baseUrl;
  const urls = [base].concat(rep.backupUrl || []);
  const up = urls.find(u => /^upos-/.test(new URL(u).host));
  if (up) for (const h of UPOS_MIRRORS) { const x = new URL(up); x.host = h; urls.push(x.href); }

  const head = await biliFetch(base, { headers: { Range: 'bytes=0-0' } });
  const total = Number((head.headers.get('content-range') || '').split('/')[1]);
  await drain(head.body, performance.now());
  console.log('视频：' + v.title + '（' + v.bvid + '，' + Math.round(v.duration / 60) + ' 分钟）');
  console.log('码率 ' + Math.round(rep.bandwidth / 1000) + ' kbps，文件 ' + (total / MB).toFixed(1) + ' MB，节点 ' +
    new Set(urls.map(u => new URL(u).host)).size + ' 个，首选 ' + new URL(base).host);

  const playback = { bufferedAhead: 0, playbackRate: 1, stalled: false };
  const mk = cfg => {
    const t0 = performance.now();
    const c = createCore({ fetch: biliFetch, getPlayback: () => playback, now: () => performance.now(), config: cfg,
      log: process.env.ACCEL_DEBUG ? (...a) => console.log('    [' + Math.round(performance.now() - t0) + 'ms]', ...a) : undefined });
    c.register({ urls, bandwidth: rep.bandwidth });
    return c;
  };
  const accelCore = mk({});
  const variants = {
    single: (a, b) => single(base, a, b),
    accel: (a, b) => accel(accelCore, base, a, b),
  };
  const label = { single: '单节点（原播放器）', accel: '加速器' };
  // ACCEL_COMPARE=1 时加一个"更恋旧"的对照：别的节点要快到首选节点耗时的 35% 以下才换
  if (process.env.ACCEL_COMPARE) {
    const sticky = mk({ homeSwitchRatio: 0.35 });
    variants.sticky = (a, b) => accel(sticky, base, a, b);
    label.sticky = '加速器·更恋旧';
  }
  const names = Object.keys(variants);
  const res = {};
  for (const n of names) res[n] = [];

  const size = Math.min(4 * MB, Math.floor(total / 6));
  for (let i = 0; i < trials; i++) {
    const off = Math.floor((total - size) * (0.05 + 0.9 * i / Math.max(1, trials - 1)));
    for (let k = 0; k < names.length; k++) {
      const name = names[(i + k) % names.length];
      const r = await variants[name](off, off + size - 1);
      if (r.n !== size) throw new Error(name + ' 长度不对');
      res[name].push(r);
    }
  }
  console.log('每次拖动请求 ' + (size / MB).toFixed(1) + ' MB，共 ' + trials + ' 个位置：');
  console.log('                       前512KB 中位/P90      整段 中位/P90');
  for (const n of names) {
    const f = res[n].map(r => r.first);
    const m = res[n].map(r => r.ms);
    console.log('  ' + label[n].padEnd(14, '　') + String(pct(f, 0.5).toFixed(0)).padStart(6) + ' / ' + String(pct(f, 0.9).toFixed(0)).padStart(5) +
      ' ms    ' + String(pct(m, 0.5).toFixed(0)).padStart(6) + ' / ' + String(pct(m, 0.9).toFixed(0)).padStart(5) + ' ms');
  }
  const snap = accelCore.snapshot();
  console.log('加速器统计：' + JSON.stringify(snap.stats));
  for (const n of snap.nodes.sort((x, y) => y.mb - x.mb)) {
    if (!n.mb && n.state === '未测') continue;
    console.log('  ' + n.host.padEnd(46) + n.state.padEnd(5) + ' 评分 ' + n.score.toFixed(2) + ' 估速 ' + n.mbps.toFixed(0).padStart(4) + 'Mbps 首包 ' +
      (n.ttfb == null ? '-' : n.ttfb.toFixed(0)).padStart(4) + 'ms ' + n.mb.toFixed(1).padStart(5) + 'MB 按时/迟到 ' + n.onTime + '/' + n.late);
  }
  process.exit(0);
})().catch(e => { console.error('失败：', e); process.exit(1); });
