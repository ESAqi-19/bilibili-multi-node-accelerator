// ==UserScript==
// @name         B站多节点加速器
// @namespace    bili-accel.local
// @version      0.2.1
// @description  B 站视频分段先整段交给最合适的 CDN 节点，预计赶不上播放时把剩余部分按速度拆给多个节点并行拉取；跨节点核对内容一致，节点按表现动态评分。Alt+Shift+B 或左下角 ⚡ 打开面板。
// @match        https://www.bilibili.com/video/*
// @match        https://www.bilibili.com/bangumi/play/*
// @match        https://www.bilibili.com/list/*
// @match        https://www.bilibili.com/medialist/play/*
// @match        https://www.bilibili.com/festival/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    minInterceptBytes: 128 * 1024,  // 小于这个的请求（初始化段、索引）直接放行
    maxConcurrent: 8,               // 全局同时进行的请求数
    maxPerNode: 3,                  // 单个节点同时进行的请求数
    lookaheadChunks: 8,             // 每个请求最多同时推进多少个分段
    maxSplitWays: 3,                // 落后时，剩余部分最多分给几个节点（含原节点）
    minSplitBytes: 256 * 1024,      // 拆出来的每一段至少这么大，否则不值得多发一个请求
    splitObserveMs: 150,            // 至少观察这么久的实际速度，再决定要不要拆
    verifyBytes: 4096,              // 从中间开始拉时多拉的重叠字节，交付前核对各节点内容一致
    raceDecideBytes: 256 * 1024,    // 冷启动抢跑：领先者至少收到这么多，且对手也测出速度后，按预计完成时间判胜负
    raceMaxBytes: 2 * 1024 * 1024,  // 领先者收到这么多还分不出来就强制判定
    maxRaceRounds: 3,               // 每路流最多抢跑几轮（给没测到速度的冷启动节点再次机会）
    reliableBytes: 1024 * 1024,     // 至少这么大的一次传输，测出的速度才算可靠（短传输受 TCP 慢启动影响会严重低估）
    homeSwitchRatio: 0.35,          // 别的节点可靠地快到首选节点耗时的 35% 以下，紧急请求才不用首选节点
                                    // （实测 0.6 时常被短时测速误导换走，0.35 最接近原播放器的中位数）
    homeRaceBias: 0.7,              // 抢跑判定时首选节点的预计完成时间打折，抵消短时测速的偏差
    coldStartNodes: 2,              // 冷启动阶段只用前几个节点
    coldRace: true,                 // 冷启动时让两个节点抢跑
    urgentSlackMs: 2000,            // 离截止时间不到这么久算高危（截止时间封顶 1.5 秒，所以实际上每段都按紧急处理）
    seekTargetMs: 500,              // 缓冲为空时（拖动后）的目标交付时间
    rescueMarginMs: 300,            // 预计完成时间晚于"截止时间 - 这个余量"就考虑拆分或救援
    rescueHorizonMs: 10000,         // 只救援这么久之内就要播放的分块
    rescueGain: 0.8,                // 救援节点预计耗时必须比原请求快 20% 以上
    maxRescuesPerChunk: 1,
    maxConcurrentRescues: 2,
    playerTimeoutMs: 2000,          // B 站播放器约 2 秒拿不到数据就自己取消重发（真实页面诊断实测 2.0~2.06 秒）
    noProgressTimeoutMs: 2000,      // 收到首包后这么久没有新数据，判定请求卡死
    ttfbTimeoutMs: 800,             // 首包等待上限（实际取它的 2 倍和该节点首包时间的 3 倍中较大的）
    maxAttempts: 4,                 // 同一分块最多失败几次后放弃，交回播放器自己处理
    explore: true,                  // 播放稳定后用远端分块试探未测过的节点
                                    // 探索的做法是"陪跑"：已知节点照常拉，未测节点同时拉同一段，按抢跑规则判定
    maxConcurrentExplore: 1,
    exploreGraceMs: 4000,           // 探测请求被别人抢先完成后，最多再跑这么久采集真实速度
    stableBufferSec: 8,             // 缓冲超过这么多秒且最近没卡顿，算播放稳定
    stableAfterStallMs: 10000,
    windowMs: 3000,                 // 滑动窗口吞吐的统计窗口
    priorBps: 2 * 1024 * 1024,      // 没有任何样本时假设的节点速度
    priorTtfbMs: 150,
    deadNodeMs: 30000,              // 普通失败后节点暂停使用的时间
    tickMs: 150,
    extraUposMirrors: true,         // 额外试探同一签名下的其他 upos 镜像
  };

  const UPOS_MIRRORS = [
    'upos-sz-mirrorcos.bilivideo.com',
    'upos-sz-mirrorali.bilivideo.com',
    'upos-sz-mirrorhw.bilivideo.com',
    'upos-sz-mirrorcoso1.bilivideo.com',
    'upos-sz-mirror08c.bilivideo.com',
    'upos-sz-estgoss.bilivideo.com',
  ];

  function filenameOf(url) {
    try { return new URL(url, 'https://www.bilibili.com/').pathname.split('/').pop() || ''; } catch (e) { return ''; }
  }

  function hostOf(url) {
    try { return new URL(url, 'https://www.bilibili.com/').host; } catch (e) { return ''; }
  }

  function parseRange(value) {
    const m = /^\s*bytes=(\d+)-(\d+)\s*$/i.exec(value || '');
    if (!m) return null;
    const start = Number(m[1]);
    const end = Number(m[2]);
    return end >= start ? { start, end } : null;
  }

  function parseContentRange(value) {
    const m = /^\s*bytes\s+(\d+)-(\d+)\/(\d+|\*)\s*$/i.exec(value || '');
    if (!m) return null;
    return { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) };
  }

  function abortError() {
    try { return new DOMException('The operation was aborted.', 'AbortError'); } catch (e) {
      const err = new Error('The operation was aborted.');
      err.name = 'AbortError';
      return err;
    }
  }

  function isAbort(err) {
    return !!err && err.name === 'AbortError';
  }

  // ---------------------------------------------------------------------------
  // 调度核心：与浏览器无关，fetch / 时钟 / 播放状态都从外部注入，便于测试
  //
  // 策略：播放器请求的一段数据先整段交给最合适的节点（冷启动时两个节点抢跑）；
  // 一边下一边按实际速度预测完成时间，预计赶不上播放截止时间时，把还没下的部分
  // 按各节点速度现场切开，分给其他节点并行拉取。节点正常时只有一个请求，没有额外开销。
  // ---------------------------------------------------------------------------
  function createCore(deps) {
    const cfg = Object.assign({}, DEFAULTS, deps.config || {});
    const doFetch = deps.fetch;
    const now = deps.now || (() => Date.now());
    const getPlayback = deps.getPlayback || (() => null);
    const log = deps.log || (() => {});

    const contexts = new Map();   // 文件名（同一路视频/音频流） -> 节点池、评分、文件身份
    const hostPrior = new Map();  // host -> 跨视频的历史速度，只用于冷启动排序和初始估计
    for (const [h, p] of Object.entries(deps.priors || {})) {
      if (p && p.bps > 0) hostPrior.set(h, { bps: p.bps, ttfb: p.ttfb > 0 ? p.ttfb : cfg.priorTtfbMs });
    }
    const jobs = new Set();
    const graceReqs = new Set();
    const stats = { jobs: 0, chunks: 0, bytes: 0, splits: 0, rescues: 0, explores: 0, stalls: 0, failures: 0, mismatches: 0, fallbacks: 0 };
    let active = 0;
    let activeRescues = 0;
    let activeExplores = 0;
    let lastStallAt = -Infinity;
    let timer = null;
    let lastCtx = null;

    function newNode(host, url) {
      const prior = hostPrior.get(host);
      return {
        host, url,
        tested: false, exploring: false,
        dead: false, deadUntil: 0, permanentDead: false, mismatch: false,
        score: 0.5,
        ewmaBps: prior ? prior.bps : null,
        ewmaTtfb: prior ? prior.ttfb : null,
        samples: [], live: new Set(), bigSamples: 0, noShow: 0,
        active: 0, bytes: 0,
        onTime: 0, late: 0, rescued: 0, stalled: 0, failures: 0,
      };
    }

    function register(rep) {
      const urls = [...new Set((rep.urls || []).filter(Boolean))];
      if (!urls.length) return null;
      const key = rep.key || filenameOf(urls[0]);
      if (!key) return null;
      let ctx = contexts.get(key);
      if (!ctx) {
        ctx = { key, bandwidth: 0, nodes: new Map(), order: [], cold: null, total: null };
        contexts.set(key, ctx);
      }
      if (rep.bandwidth) ctx.bandwidth = rep.bandwidth;
      for (const u of urls) addNode(ctx, u);
      return ctx;
    }

    function addNode(ctx, url) {
      const host = hostOf(url);
      if (!host) return;
      const node = ctx.nodes.get(host);
      if (node) {
        // 重新拿到 playurl 时签名会更新；之前因为 403 之类判死的节点给一次新机会（内容不一致的除外）
        if (node.url !== url && node.permanentDead && !node.mismatch) {
          node.permanentDead = false;
          node.dead = false;
          node.score = 0.3;
        }
        node.url = url;
        return;
      }
      ctx.nodes.set(host, newNode(host, url));
      ctx.order.push(host);
      ctx.cold = null;
    }

    function knows(url) {
      return contexts.has(filenameOf(url));
    }

    function usable(node, t) {
      if (node.permanentDead) return false;
      if (node.dead && t < node.deadUntil) return false;
      node.dead = false;
      return true;
    }

    // 没有历史数据时的先验：官方 upos 节点最可靠，mcdn/PCDN 类节点（含非标准端口）放最后
    function hostTier(host) {
      if (/^upos-/.test(host)) return 0;
      if (/:\d+$/.test(host) || /(mcdn\.bilivideo\.cn|mountaintoys\.cn|szbdyd\.com)$/.test(host)) return 2;
      return 1;
    }

    function coldSet(ctx) {
      if (ctx.cold) return ctx.cold;
      const ranked = ctx.order.map((h, i) => ({ h, i, p: hostPrior.get(h) }));
      ranked.sort((a, b) => {
        const pa = a.p ? a.p.bps : -1;
        const pb = b.p ? b.p.bps : -1;
        return pb - pa || hostTier(a.h) - hostTier(b.h) || a.i - b.i;
      });
      // B 站自己的首选节点（池里第一个）一定参加冷启动，再补上排名最好的其他节点，靠抢跑决定谁快
      const cold = new Set();
      if (ctx.order.length) cold.add(ctx.order[0]);
      for (const x of ranked) {
        if (cold.size >= cfg.coldStartNodes) break;
        cold.add(x.h);
      }
      ctx.cold = cold;
      return ctx.cold;
    }

    // 节点总吞吐（滑动窗口），只用于面板显示
    function nodeThroughput(node, t) {
      const from = t - cfg.windowMs;
      while (node.samples.length && node.samples[0][0] < from) node.samples.shift();
      let sum = 0;
      for (const s of node.samples) sum += s[1];
      return node.samples.length ? sum * 1000 / Math.max(t - node.samples[0][0], 500) : 0;
    }

    // 单个请求能跑多快：在途请求的实时速度与历史 EWMA 结合。CDN 常见按连接限速，所以不用总吞吐来估
    function nodeRate(node, t) {
      let sum = 0;
      let n = 0;
      for (const r of node.live) {
        const el = t - r.firstByte;
        if (r.firstByte && el > 300 && r.received > 32 * 1024) {
          let rate = r.received * 1000 / el;
          const idle = t - r.lastProgress;
          if (idle > 1000) rate = rate * 1000 / idle;
          sum += rate;
          n++;
        }
      }
      if (n) {
        const recent = sum / n;
        return node.ewmaBps != null ? recent * 0.6 + node.ewmaBps * 0.4 : recent;
      }
      if (node.ewmaBps != null) return node.ewmaBps;
      return cfg.priorBps * 0.5;
    }

    function effRate(node, t) {
      return Math.max(nodeRate(node, t), 32 * 1024) * (0.3 + 0.7 * node.score) / (1 + 0.3 * node.active);
    }

    function nodeTtfb(node) {
      return node.ewmaTtfb != null ? node.ewmaTtfb : cfg.priorTtfbMs;
    }

    function estimate(node, bytes, t) {
      return nodeTtfb(node) + bytes * 1000 / effRate(node, t);
    }

    function isStable(t) {
      const pb = getPlayback();
      return !!pb && !pb.stalled && (pb.bufferedAhead || 0) >= cfg.stableBufferSec && t - lastStallAt > cfg.stableAfterStallMs;
    }

    // 给一个分块挑节点。purpose: 'primary' 正常拉取（可能变成探索），'rescue' 救援
    function pickNode(ch, exclude, bytes, purpose) {
      const ctx = ch.job.ctx;
      const t = now();
      const slack = ch.deadline - t;
      let all = [...ctx.nodes.values()].filter(n => usable(n, t) && n.active < cfg.maxPerNode && !exclude.has(n.host));
      if (!all.length) {
        // 所有节点都在暂停期：宁可用暂停中的，也不要让分块卡住
        all = [...ctx.nodes.values()].filter(n => !n.permanentDead && n.active < cfg.maxPerNode && !exclude.has(n.host));
        if (!all.length) return null;
      }
      const cold = coldSet(ctx);
      const known = all.filter(n => n.tested || cold.has(n.host));
      const pool = known.length ? known : all;
      const scored = pool.map(n => ({ n, eta: estimate(n, bytes, t) }));
      scored.sort((a, b) => a.eta - b.eta);

      if (purpose === 'primary' && slack < cfg.urgentSlackMs) {
        // 紧急请求优先用 B 站首选节点（播放器本来要请求的那个）。只有别的节点在可靠的大传输里
        // 被测出明显更快才换；首选节点还没做过一次大传输、也没出过问题，就给它一次完整的机会。
        // 被救援过、失败过、抢跑时连首包都没到的首选节点不再享受这次机会（真实页面诊断里见过反复卡住的首选节点）
        const home = ch.job.home ? ctx.nodes.get(ch.job.home) : null;
        if (home && pool.includes(home) && home.score >= 0.3) {
          const homeEta = estimate(home, bytes, t);
          const better = scored.find(s => s.n !== home && s.n.bigSamples >= 2 && s.eta < homeEta * cfg.homeSwitchRatio);
          const clean = home.rescued === 0 && home.failures === 0 && home.noShow === 0;
          if (!better || (home.bigSamples === 0 && clean)) return { node: home, kind: purpose, eta: homeEta };
        }
      }
      if (purpose === 'rescue' || slack < cfg.urgentSlackMs) {
        return { node: scored[0].n, kind: purpose, eta: scored[0].eta };
      }
      // 不急的请求：在能按时完成的节点里挑最慢的，把快节点留给即将播放的高危请求
      const feasible = scored.filter(s => s.eta < slack - cfg.rescueMarginMs && s.n.score >= 0.25);
      if (feasible.length) {
        feasible.sort((a, b) => nodeRate(a.n, t) - nodeRate(b.n, t));
        return { node: feasible[0].n, kind: 'primary', eta: feasible[0].eta };
      }
      return { node: scored[0].n, kind: 'primary', eta: scored[0].eta };
    }

    function makeChunk(job, offset, buf, deadline) {
      return {
        job, idx: 0, offset, len: buf.length, buf,
        segs: [], reqs: new Set(), verifies: [],
        deadline, done: false, attempts: 0, racing: false,
      };
    }

    function createJob(ctx, start, end, signal) {
      const t0 = now();
      const pb = getPlayback() || {};
      const rate = pb.playbackRate > 0 ? pb.playbackRate : 1;
      const ahead = pb.stalled ? 0 : Math.max(0, pb.bufferedAhead || 0);
      // 截止时间：缓冲按当前倍速耗尽的时刻，但不超过播放器自己的超时（约 2 秒，留 25% 余量）——
      // 超过这个时间播放器会取消并重发，缓冲再多也没用。播放器要等整段下完才能用，所以整段共用一个截止时间；
      // 缓冲几乎为空（刚拖动或卡住）时给一个起播目标时间，否则谁交付都算迟到
      const deadline = t0 + Math.min(Math.max(ahead / rate * 1000, cfg.seekTargetMs), cfg.playerTimeoutMs * 0.75);
      const len = end - start + 1;
      const job = {
        ctx, start, end, len, created: t0,
        buf: new Uint8Array(len),
        chunks: [], next: 0, total: null, contentType: null,
        finished: false, headersReady: false, controller: null,
      };
      job.headers = new Promise((resolve, reject) => { job.resolveHeaders = resolve; job.rejectHeaders = reject; });
      job.headers.catch(() => {});
      job.stream = new ReadableStream({
        start(c) { job.controller = c; },
        cancel() { cancelJob(job); },
      });
      // 整段先作为一个分块；只有落后时才会被拆开
      job.chunks.push(makeChunk(job, 0, job.buf, deadline));
      if (signal) {
        if (signal.aborted) cancelJob(job);
        else signal.addEventListener('abort', () => cancelJob(job), { once: true });
      }
      return job;
    }

    function coverPrefix(ch) {
      const segs = ch.segs.slice().sort((a, b) => a.from - b.from);
      let p = 0;
      for (const s of segs) {
        if (s.from > p) break;
        p = Math.max(p, s.end);
      }
      return Math.min(p, ch.len);
    }

    function sameBytes(a, b, n) {
      for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
      return true;
    }

    function remainingOf(req) {
      return (req.ov - req.ovGot) + (req.to - req.from) - req.received;
    }

    function startReq(ch, node, from, kind) {
      const t = now();
      const job = ch.job;
      // 不是从整段开头拉时，多拉前面一小段已有的数据，交付前用来核对两个节点给的内容是否一致
      const ov = Math.min(cfg.verifyBytes, ch.offset + from);
      const req = {
        ch, node, kind, from, to: ch.len, received: 0,
        ov, ovBuf: ov ? new Uint8Array(ov) : null, ovGot: 0, priv: null,
        started: t, firstByte: 0, lastProgress: t,
        ctrl: new AbortController(), state: 'live', finished: false,
        seg: { from, end: from },
      };
      ch.segs.push(req.seg);
      ch.reqs.add(req);
      node.live.add(req);
      node.active++;
      active++;
      if (kind === 'rescue') activeRescues++;
      if (kind === 'explore') { activeExplores++; node.exploring = true; stats.explores++; }
      const a = job.start + ch.offset + from - ov;
      const b = job.start + ch.offset + ch.len - 1;
      run(req, a, b);
      return req;
    }

    function cancelBody(x) {
      try { const p = x && x.cancel && x.cancel(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
    }

    async function run(req, a, b) {
      const { ch, node } = req;
      const job = ch.job;
      const ctx = job.ctx;
      let res;
      try {
        res = await doFetch(node.url, { headers: { Range: 'bytes=' + a + '-' + b }, signal: req.ctrl.signal });
      } catch (e) {
        if (!req.finished) failReq(req, e, 0);
        return;
      }
      if (req.finished) { cancelBody(res.body); return; }
      req.firstByte = now();
      req.lastProgress = req.firstByte;
      const cr = parseContentRange(res.headers.get('content-range'));
      if (res.status !== 206 || !cr || cr.start !== a || cr.end !== b || !res.body) {
        try { req.ctrl.abort(); } catch (e) { /* ignore */ }
        failReq(req, new Error('HTTP ' + res.status), res.status);
        return;
      }
      // 跨节点一致性：同一路流在各节点上的文件总长度必须相同，否则不是同一份文件，拼起来会坏
      if (cr.total != null) {
        if (ctx.total == null) ctx.total = cr.total;
        else if (ctx.total !== cr.total) {
          try { req.ctrl.abort(); } catch (e) { /* ignore */ }
          markMismatch(node, '文件长度 ' + cr.total + ' ≠ ' + ctx.total);
          failReq(req, new Error('文件长度不一致'), 'mismatch');
          return;
        }
      }
      updateTtfb(node, req.firstByte - req.started);
      if (!job.headersReady) {
        job.headersReady = true;
        job.total = ctx.total != null ? ctx.total : cr.total;
        job.contentType = res.headers.get('content-type') || 'video/mp4';
        job.resolveHeaders();
      }
      const reader = res.body.getReader();
      try {
        while (!req.finished && remainingOf(req) > 0) {
          const r = await reader.read();
          if (r.done || req.finished) break;
          onData(req, r.value);
        }
      } catch (e) {
        if (!req.finished) failReq(req, e, 0);
        return;
      }
      // 读够了（包括被拆分截短的情况）就断开，剩下的字节不再需要
      cancelBody(reader);
      try { req.ctrl.abort(); } catch (e) { /* ignore */ }
      if (req.finished) return;
      if (remainingOf(req) <= 0) finishOk(req);
      else failReq(req, new Error('short body'), 0);
    }

    function onData(req, value) {
      const { ch, node } = req;
      const t = now();
      let v = value;
      req.lastProgress = t;
      // 先收重叠核对用的字节
      if (req.ovGot < req.ov) {
        const n = Math.min(req.ov - req.ovGot, v.length);
        req.ovBuf.set(v.subarray(0, n), req.ovGot);
        req.ovGot += n;
        node.bytes += n;
        node.samples.push([t, n]);
        if (req.ovGot === req.ov) ch.verifies.push({ off: ch.offset + req.from - req.ov, bytes: req.ovBuf, req });
        v = v.subarray(n);
        if (!v.length) return;
      }
      const room = (req.to - req.from) - req.received;
      if (room <= 0) return;
      let p = v.length > room ? v.subarray(0, room) : v;
      node.bytes += p.length;
      node.samples.push([t, p.length]);
      if (req.priv) {
        // 冷启动抢跑中：先写进自己的缓冲，分出胜负后再并入
        const n = Math.min(req.priv.length - req.received, p.length);
        req.priv.set(p.subarray(0, n), req.received);
        req.received += n;
        p = p.subarray(n);
        maybeDecideRace(ch, t);
        if (!p.length || req.finished || req.state !== 'live' || ch.done) return;
        if (req.priv) return;   // 缓冲已满但还没判定（理论上不会发生）
      }
      if (req.state === 'live' && !ch.done) {
        ch.buf.set(p, req.from + req.received);
        req.seg.end = req.from + req.received + p.length;
      }
      req.received += p.length;
      if (req.state === 'live' && !ch.done && coverPrefix(ch) >= ch.len) completeChunk(ch, req);
    }

    // 抢跑判定：比的是"谁能先下完整段"，不是谁先收到若干字节（那样比的主要是首包快慢）
    function raceRate(r, t) {
      const el = t - r.firstByte;
      return r.firstByte && el >= 30 && r.received >= 32 * 1024 ? r.received * 1000 / el : 0;
    }

    function maybeDecideRace(ch, t) {
      if (!ch.racing) return;
      const racers = [...ch.reqs].filter(r => r.priv);
      if (!racers.length) { ch.racing = false; return; }
      let leader = racers[0];
      for (const r of racers) if (r.received > leader.received) leader = r;
      const forced = leader.received >= leader.priv.length;   // 领先者缓冲已满（收到 raceMaxBytes 或整段）
      if (!forced && leader.received < cfg.raceDecideBytes) return;
      let best = null;
      let bestFin = Infinity;
      for (const r of racers) {
        const rate = raceRate(r, t);
        if (!rate) {
          // 对手还没测出速度（常见于新建连接，TLS 握手让首包晚几十毫秒）：等到领先者收满上限再判。
          // 抢跑期间领先者的数据会保留，多等不浪费
          if (!forced && r !== leader) return;
          continue;
        }
        let fin = ((r.to - r.from) - r.received) * 1000 / rate;
        if (r.node.host === ch.job.home) fin *= cfg.homeRaceBias;   // 短时测速偏差大，偏向 B 站首选节点
        if (fin < bestFin) { best = r; bestFin = fin; }
      }
      decideRace(ch, best || leader);
    }

    // 抢跑分出胜负：赢家继续，输家取消。输家已收到的字节先和赢家核对，一致的话多出来的部分直接用上
    function decideRace(ch, w) {
      if (!ch.racing) return;
      ch.racing = false;
      const t = now();
      const racers = [...ch.reqs].filter(r => r.priv);
      log('抢跑判定', ch.job.ctx.key, '赢家 ' + w.node.host, racers.map(r => r.node.host + '(首包' +
        (r.firstByte ? Math.round(r.firstByte - r.started) + 'ms' : '未到') + ' 已收' + Math.round(r.received / 1024) + 'KB ' +
        Math.round(raceRate(r, t) * 8 / 1e6) + 'Mbps)').join(' vs '));
      const wp = w.priv;
      w.priv = null;
      if (wp && !ch.done) {
        ch.buf.set(wp.subarray(0, w.received), w.from);
        w.seg.end = w.from + w.received;
      }
      for (const r of racers) {
        if (r === w) continue;
        const n = Math.min(r.received, w.received);
        if (wp && r.from === w.from && n > 0 && !sameBytes(r.priv, wp, n)) {
          markMismatch(r.node, '抢跑时内容不同');
        } else {
          if (wp && r.from === w.from && r.received > w.received && !ch.done) {
            ch.buf.set(r.priv.subarray(w.received, r.received), r.from + w.received);
            r.seg.end = r.from + r.received;
          }
          if (r.firstByte && t - r.firstByte >= 30 && r.received >= 16 * 1024) {
            updateBps(r.node, r, 16 * 1024);
            if (r.received >= 64 * 1024) r.node.tested = true;
          } else if (!r.firstByte && t - r.started > Math.max(400, 3 * (w.firstByte ? w.firstByte - w.started : 0))) {
            // 等了足够久还没出首包才算"没到场"（赢家太快、对手首包还没来得及回来的不算）。
            // 从没成功过的节点两次没到场就停用
            r.node.noShow++;
            r.node.score *= 0.7;
            if (!r.node.tested && r.node.noShow >= 2) r.node.permanentDead = true;
          }
        }
        r.priv = null;
        abortReq(r);
      }
      if (!ch.done && coverPrefix(ch) >= ch.len) completeChunk(ch, w);
    }

    function markMismatch(node, why) {
      if (node.mismatch) return;
      node.mismatch = true;
      node.permanentDead = true;
      node.score = 0;
      stats.mismatches++;
      log('内容不一致，停用节点', node.host, why);
    }

    function release(req) {
      if (req.finished) return false;
      req.finished = true;
      req.node.live.delete(req);
      req.node.active--;
      active--;
      if (req.kind === 'rescue') activeRescues--;
      if (req.kind === 'explore') { activeExplores--; req.node.exploring = false; }
      graceReqs.delete(req);
      req.ch.reqs.delete(req);
      return true;
    }

    function abortReq(req) {
      if (!release(req)) return;
      req.state = 'aborted';
      try { req.ctrl.abort(); } catch (e) { /* ignore */ }
    }

    function finishOk(req) {
      const { node } = req;
      const wasGrace = req.state === 'grace';
      if (!release(req)) return;
      req.state = 'done';
      node.tested = true;
      updateBps(node, req, 64 * 1024);
      if (!wasGrace) pumpAll();
    }

    function failReq(req, err, status) {
      const { ch, node } = req;
      const wasGrace = req.state === 'grace';
      if (!release(req)) return;
      req.state = 'failed';
      try { req.ctrl.abort(); } catch (e) { /* ignore */ }
      node.failures++;
      stats.failures++;
      if (status === 403 || status === 404 || status === 410) {
        node.permanentDead = true;   // 签名失效或这个节点没有这份文件
        node.score = 0;
      } else if (!node.tested && node.failures >= 2) {
        node.permanentDead = true;   // 从没成功过、又连续失败（多半是签名不通用的镜像，CORS 报 Failed to fetch），不再试
        node.score = 0;
      } else if (!node.permanentDead) {
        node.dead = true;
        node.deadUntil = now() + cfg.deadNodeMs;
        node.score *= 0.5;
      }
      log('节点失败', node.host, status || (err && err.message));
      if (wasGrace) return;
      if (ch.racing) {
        // 抢跑的一方失败：剩下的那个直接算赢
        const rest = [...ch.reqs].filter(r => r.priv);
        if (rest.length === 1) decideRace(ch, rest[0]);
        else if (!rest.length) ch.racing = false;
      }
      if (!ch.done && ch.reqs.size === 0) {
        ch.attempts++;
        if (ch.attempts >= cfg.maxAttempts) { failJob(ch.job, err || new Error('all nodes failed')); return; }
      }
      pumpAll();
    }

    function completeChunk(ch, byReq) {
      const t = now();
      ch.done = true;
      stats.chunks++;
      stats.bytes += ch.len;
      const node = byReq.node;
      if (t <= ch.deadline + cfg.rescueMarginMs) {
        node.onTime++;
        node.score += (1 - node.score) * 0.08;   // 按时交付，逐步恢复信誉
      } else {
        node.late++;
        node.score *= 0.95;
      }
      for (const r of [...ch.reqs]) {
        if (r === byReq) continue;
        if (r.kind === 'explore') {
          // 探测请求不立刻取消，限时跑完以拿到真实速度样本，数据不再使用
          r.state = 'grace';
          r.graceUntil = t + cfg.exploreGraceMs;
          ch.reqs.delete(r);
          graceReqs.add(r);
        } else {
          // 冗余请求立即取消，避免空耗带宽；已经收到足够数据的话，顺便留下这次的实测速度
          if (r.firstByte && r.received >= 64 * 1024) {
            updateBps(r.node, r, 64 * 1024);
            r.node.tested = true;
          }
          abortReq(r);
        }
      }
      deliver(ch.job);
    }

    // 按顺序交付已完成的分块；交付前核对重叠字节，内容对不上就整段作废，交回播放器重试
    function deliver(job) {
      if (job.finished) return;
      while (job.next < job.chunks.length && job.chunks[job.next].done) {
        const ch = job.chunks[job.next];
        for (const v of ch.verifies) {
          const have = job.buf.subarray(v.off, v.off + v.bytes.length);
          if (!sameBytes(have, v.bytes, v.bytes.length)) {
            markMismatch(v.req.node, '重叠字节不同');
            if (v.req.seg.end > v.req.seg.from) { failJob(job, new Error('不同节点返回的内容不一致')); return; }
          }
        }
        ch.verifies.length = 0;
        job.next++;
        try { job.controller.enqueue(ch.buf); } catch (e) { /* 消费方已取消 */ }
      }
      if (job.next === job.chunks.length) {
        job.finished = true;
        jobs.delete(job);
        log('完成', job.ctx.key, Math.round(now() - job.created) + 'ms', job.chunks.length + '段');
        try { job.controller.close(); } catch (e) { /* ignore */ }
      }
    }

    function stopJob(job) {
      job.finished = true;
      jobs.delete(job);
      for (const ch of job.chunks) for (const r of [...ch.reqs]) abortReq(r);
    }

    function failJob(job, err) {
      if (job.finished) return;
      stopJob(job);
      if (!job.headersReady) job.rejectHeaders(err);
      else try { job.controller.error(err); } catch (e) { /* ignore */ }
    }

    function cancelJob(job) {
      if (job.finished) return;
      stopJob(job);
      const err = abortError();
      if (!job.headersReady) job.rejectHeaders(err);
      else try { job.controller.error(err); } catch (e) { /* ignore */ }
    }

    function updateTtfb(node, ms) {
      node.ewmaTtfb = node.ewmaTtfb == null ? ms : node.ewmaTtfb * 0.7 + ms * 0.3;
      hostPrior.set(node.host, { bps: node.ewmaBps != null ? node.ewmaBps : cfg.priorBps, ttfb: node.ewmaTtfb });
    }

    function updateBps(node, req, minBytes) {
      const el = now() - (req.firstByte || req.started);
      if (req.received < minBytes || el < 30) return;
      const bps = req.received * 1000 / el;
      if (req.received >= cfg.reliableBytes) {
        // 大传输测出的速度可靠：第一次可靠样本直接替换掉之前短传输留下的估计
        node.ewmaBps = node.bigSamples ? node.ewmaBps * 0.7 + bps * 0.3 : bps;
        node.bigSamples++;
      } else {
        node.ewmaBps = node.ewmaBps == null ? bps : node.ewmaBps * 0.7 + bps * 0.3;
      }
      hostPrior.set(node.host, { bps: node.ewmaBps, ttfb: node.ewmaTtfb != null ? node.ewmaTtfb : cfg.priorTtfbMs });
    }

    function pumpAll() {
      const cands = [];
      for (const job of jobs) {
        if (job.finished) continue;
        const limit = job.next + cfg.lookaheadChunks;
        for (const ch of job.chunks) {
          if (ch.idx >= limit) break;
          if (!ch.done && ch.reqs.size === 0) cands.push(ch);
        }
      }
      cands.sort((a, b) => a.deadline - b.deadline);
      for (const ch of cands) {
        if (active >= cfg.maxConcurrent) break;
        if (ch.job.finished || ch.reqs.size) continue;
        const ctx = ch.job.ctx;
        let busy = 0;
        let tested = false;
        for (const n of ctx.nodes.values()) { busy += n.active; tested = tested || n.tested; }
        if (cfg.coldRace && !tested && busy > 0) continue;   // 冷启动抢跑还没出结果，先不派别的
        const from = coverPrefix(ch);
        const pick = pickNode(ch, new Set(), ch.len - from, 'primary');
        if (pick) {
          const first = startReq(ch, pick.node, from, pick.kind);
          // 冷启动抢跑：同一段让两个节点一起拉，测出速度后按预计完成时间判胜负。
          // 对手优先选还没测到速度的冷启动节点（例如上一轮因为首包慢一点就输掉、没拿到样本的 B 站首选节点）
          ctx.raceRounds = ctx.raceRounds || 0;
          if (cfg.coldRace && pick.kind === 'primary' && ctx.raceRounds < cfg.maxRaceRounds &&
              active < cfg.maxConcurrent && ch.len - from >= cfg.raceDecideBytes) {
            const cold = coldSet(ctx);
            const t = now();
            let rival = null;
            for (const h of cold) {
              const n = ctx.nodes.get(h);
              if (n && n !== pick.node && n.ewmaBps == null && usable(n, t) && n.active < cfg.maxPerNode) { rival = n; break; }
            }
            if (!rival && !tested) {
              const second = pickNode(ch, new Set([pick.node.host]), ch.len - from, 'rescue');
              if (second && cold.has(second.node.host)) rival = second.node;
            }
            if (rival) {
              const other = startReq(ch, rival, from, 'primary');
              ch.racing = true;
              ctx.raceRounds++;
              const cap = Math.min(ch.len - from, cfg.raceMaxBytes);
              first.priv = new Uint8Array(cap);
              other.priv = new Uint8Array(cap);
            }
          }
          // 后台探索（陪跑）：播放稳定时，让一个没测过的节点和已知节点同时拉同一段，按抢跑规则判定。
          // 已知节点照常在拉，所以探测节点再慢、再不通，也不会让这段卡住
          if (!ch.racing && cfg.explore && pick.kind === 'primary' && activeExplores < cfg.maxConcurrentExplore &&
              active < cfg.maxConcurrent && ch.len - from >= cfg.raceDecideBytes && isStable(now())) {
            const t = now();
            const cold = coldSet(ctx);
            const fresh = [...ctx.nodes.values()].find(n => n !== pick.node && !n.tested && !cold.has(n.host) &&
              !n.exploring && usable(n, t) && n.active < cfg.maxPerNode);
            if (fresh) {
              const probe = startReq(ch, fresh, from, 'explore');
              ch.racing = true;
              const cap = Math.min(ch.len - from, cfg.raceMaxBytes);
              first.priv = new Uint8Array(cap);
              probe.priv = new Uint8Array(cap);
              log('探索', ctx.key, fresh.host, '陪跑', pick.node.host);
            }
          }
        } else if ([...ctx.nodes.values()].every(n => n.permanentDead)) {
          failJob(ch.job, new Error('all nodes failed'));   // 节点全部失效，交回播放器自己请求
        }
      }
      if (cands.length || jobs.size || graceReqs.size) ensureTimer();
    }

    function reqEta(r, t) {
      const need = remainingOf(r);
      if (!r.firstByte) {
        const waited = t - r.started;
        const ttfb = nodeTtfb(r.node);
        if (waited > Math.max(cfg.ttfbTimeoutMs, 3 * ttfb)) return Infinity;
        return t + Math.max(0, ttfb - waited) + need * 1000 / Math.max(nodeRate(r.node, t), 64 * 1024);
      }
      const el = t - r.firstByte;
      let rate = el > 300 && r.received > 32 * 1024 ? r.received * 1000 / el : nodeRate(r.node, t);
      const idle = t - r.lastProgress;
      if (idle > 1000) rate = rate * 1000 / idle;   // 最近没有进展，按停顿时间折算
      return t + need * 1000 / Math.max(rate, 1);
    }

    function tick() {
      const t = now();
      for (const r of [...graceReqs]) {
        if (t >= r.graceUntil) {
          r.node.tested = true;
          updateBps(r.node, r, 64 * 1024);
          abortReq(r);
        }
      }
      for (const job of [...jobs]) {
        for (const ch of [...job.chunks]) {
          if (job.finished) break;
          if (ch.done || !ch.reqs.size) continue;
          // 卡死检测
          for (const r of [...ch.reqs]) {
            const waited = r.firstByte ? t - r.lastProgress : t - r.started;
            const limit = r.firstByte ? cfg.noProgressTimeoutMs : Math.max(cfg.ttfbTimeoutMs * 2, 3 * nodeTtfb(r.node));
            if (waited > limit) failReq(r, new Error('timeout'), 0);
          }
          if (ch.done || !ch.reqs.size || ch.racing) continue;
          if (!maybeSplit(ch, t)) maybeRescue(ch, t);
        }
      }
      pumpAll();
      if (!jobs.size && !graceReqs.size && timer) {
        clearInterval(timer);
        timer = null;
      }
    }

    // 把分块在 at 处切成两段，后半段成为新的分块（共用同一块内存，不复制）
    function splitChunk(ch, at) {
      const job = ch.job;
      const nc = makeChunk(job, ch.offset + at, ch.buf.subarray(at), ch.deadline);
      ch.buf = ch.buf.subarray(0, at);
      ch.len = at;
      for (const r of ch.reqs) if (r.to > at) r.to = at;
      for (const s of ch.segs) if (s.end > at) s.end = at;
      job.chunks.splice(job.chunks.indexOf(ch) + 1, 0, nc);
      job.chunks.forEach((c, k) => { c.idx = k; });
      return nc;
    }

    // 已知各节点速度和首包时间，求让剩余字节最早下完的分配：每个节点从首包后开始按自己的速度拉
    function solveSplit(parts, bytes) {
      let hi = Infinity;
      for (const p of parts) hi = Math.min(hi, p.ttfb + bytes * 1000 / p.bps);
      let lo = 0;
      for (let i = 0; i < 40; i++) {
        const mid = (lo + hi) / 2;
        let sum = 0;
        for (const p of parts) sum += p.bps * Math.max(0, mid - p.ttfb) / 1000;
        if (sum >= bytes) hi = mid; else lo = mid;
      }
      const shares = parts.map(p => p.bps * Math.max(0, hi - p.ttfb) / 1000);
      return { T: hi, shares };
    }

    // 动态拆分：整段请求预计赶不上截止时间时，把还没下的部分按速度分给原节点和其他节点
    function maybeSplit(ch, t) {
      if (cfg.maxSplitWays < 2) return false;
      const live = [...ch.reqs];
      if (live.length !== 1) return false;
      const r = live[0];
      if (!r.firstByte || r.priv || r.ovGot < r.ov) return false;
      const el = t - r.firstByte;
      if (el < cfg.splitObserveMs || r.received < 64 * 1024) return false;
      if (ch.deadline - t > cfg.rescueHorizonMs) return false;   // 离播放还早，不急
      const pos = r.from + r.received;
      const remaining = ch.len - pos;
      if (remaining < 2 * cfg.minSplitBytes) return false;
      let rate = r.received * 1000 / el;
      const idle = t - r.lastProgress;
      if (idle > 1000) rate = rate * 1000 / idle;
      rate = Math.max(rate, 1);
      const eta = t + remaining * 1000 / rate;
      if (eta <= ch.deadline - cfg.rescueMarginMs) return false;

      const ctx = ch.job.ctx;
      const cold = coldSet(ctx);
      let cands = [...ctx.nodes.values()].filter(n => n !== r.node && usable(n, t) && n.active < cfg.maxPerNode);
      const known = cands.filter(n => n.tested || cold.has(n.host));
      if (known.length) cands = known;
      let helpers = cands.map(n => ({ n, bps: effRate(n, t), ttfb: nodeTtfb(n) }))
        .sort((x, y) => (x.ttfb + remaining * 1000 / x.bps) - (y.ttfb + remaining * 1000 / y.bps))
        .slice(0, cfg.maxSplitWays - 1);
      if (!helpers.length) return false;

      let plan = null;
      for (let i = 0; i < 3; i++) {
        plan = solveSplit([{ bps: rate, ttfb: 0 }].concat(helpers), remaining);
        const keep = helpers.filter((h, k) => plan.shares[k + 1] >= cfg.minSplitBytes);
        if (keep.length === helpers.length) break;
        helpers = keep;
        if (!helpers.length) return false;
      }
      if (plan.T >= (eta - t) * cfg.rescueGain) return false;   // 拆了也快不了多少，不值得

      let keepBytes = Math.round(plan.shares[0]);
      let shares = plan.shares.slice(1);
      if (keepBytes < cfg.minSplitBytes) {
        // 原节点几乎拉不动了：剩余部分全部交出去，算它一次被救援
        keepBytes = 0;
        r.node.rescued++;
        r.node.score *= 0.75;
        stats.rescues++;
      }
      const sumH = shares.reduce((x, y) => x + y, 0);
      shares = shares.map(s => s * (remaining - keepBytes) / sumH);

      const pieces = [];
      let target = splitChunk(ch, pos + keepBytes);
      for (let i = 0; i < helpers.length; i++) {
        const last = i === helpers.length - 1;
        const size = Math.round(shares[i]);
        if (!last && size >= cfg.minSplitBytes && target.len - size >= cfg.minSplitBytes) {
          const next = splitChunk(target, size);
          pieces.push([target, helpers[i].n]);
          target = next;
        } else {
          pieces.push([target, helpers[i].n]);
          break;
        }
      }
      for (const [c, n] of pieces) startReq(c, n, 0, 'split');
      stats.splits++;
      log('拆分', ctx.key, '原节点', r.node.host, '保留', Math.round(keepBytes / 1024) + 'KB',
        pieces.map(([c, n]) => n.host + ':' + Math.round(c.len / 1024) + 'KB').join(' '),
        '预计 ' + Math.round(eta - t) + '→' + Math.round(plan.T) + 'ms');
      if (keepBytes === 0 && coverPrefix(ch) >= ch.len) completeChunk(ch, r);
      return true;
    }

    // 救援：只处理真正卡住的请求（迟迟等不到首包，或超过 1 秒没有新数据）。
    // 正常但偏慢的请求交给 maybeSplit：测出速度后按比例拆，而不是让别的节点从头再下一遍
    function maybeRescue(ch, t) {
      if (activeRescues >= cfg.maxConcurrentRescues) return;
      const live = [...ch.reqs];
      if (live.filter(r => r.kind === 'rescue').length >= cfg.maxRescuesPerChunk) return;
      const stuck = live.every(r => r.firstByte ? t - r.lastProgress > 1000
        : t - r.started > Math.max(2 * nodeTtfb(r.node), 400));
      if (!stuck) return;   // 卡住的请求不管离截止时间多远都立即救援：播放器约 2 秒就会自己放弃重发
      let eta = Infinity;
      for (const r of live) eta = Math.min(eta, reqEta(r, t));
      if (eta <= ch.deadline - cfg.rescueMarginMs) return;
      const from = coverPrefix(ch);
      const need = ch.len - from;
      if (need < 32 * 1024) return;
      const exclude = new Set(live.map(r => r.node.host));
      const pick = pickNode(ch, exclude, need, 'rescue');
      if (!pick) return;
      if (eta !== Infinity && pick.eta >= (eta - t) * cfg.rescueGain) return;
      startReq(ch, pick.node, from, 'rescue');
      stats.rescues++;
      for (const r of live) {
        if (r.kind === 'rescue') continue;
        r.node.rescued++;
        r.node.score *= 0.75;   // 触发救援的节点降级
      }
      log('救援', ch.job.ctx.key, '#' + ch.idx, live.map(r => r.node.host).join(','), '->', pick.node.host);
    }

    function ensureTimer() {
      if (!timer) timer = setInterval(tick, cfg.tickMs);
    }

    // 播放器出现缓冲停顿：惩罚正拖着最近分块的节点，剩余分块全部变成紧急
    function notifyStall() {
      const t = now();
      lastStallAt = t;
      stats.stalls++;
      for (const job of jobs) {
        const first = job.chunks.find(c => !c.done);
        if (!first) continue;
        for (const r of first.reqs) {
          r.node.stalled++;
          r.node.score *= 0.6;
        }
        for (const ch of job.chunks) if (!ch.done) ch.deadline = Math.min(ch.deadline, t);
      }
      if (jobs.size) tick();
    }

    // 接管一个 Range 请求。返回 null 表示不认识这个地址；Promise 失败时调用方应回退到原始请求
    function request(url, start, end, signal) {
      const ctx = contexts.get(filenameOf(url));
      if (!ctx) return null;
      addNode(ctx, url);   // 播放器实际请求的地址一定在池里
      lastCtx = ctx;
      ctx.lastUsed = now();
      const job = createJob(ctx, start, end, signal);
      job.home = hostOf(url);   // 播放器本来要请求的节点，即 B 站的首选
      if (job.finished) return Promise.reject(abortError());
      jobs.add(job);
      stats.jobs++;
      log('接管', ctx.key, start + '-' + end, Math.round(job.len / 1024) + 'KB');
      pumpAll();
      return job.headers.then(() => ({
        status: 206, start, end, total: job.total, contentType: job.contentType, body: job.stream,
      }));
    }

    function setConfig(patch) {
      Object.assign(cfg, patch || {});
    }

    function snapshot() {
      const t = now();
      // 视频和音频请求交替进行，面板优先显示最近 30 秒内用过的、码率最高的那一路（通常是视频）
      let ctx = lastCtx;
      for (const c of contexts.values()) {
        if (c.lastUsed && t - c.lastUsed < 30000 && (!ctx || c.bandwidth > ctx.bandwidth || t - (ctx.lastUsed || 0) >= 30000)) ctx = c;
      }
      const nodes = ctx ? [...ctx.nodes.values()].map(n => ({
        host: n.host,
        state: n.mismatch ? '内容不一致' : n.permanentDead ? '失效' : (n.dead && t < n.deadUntil) ? '暂停' : n.exploring ? '探索中'
          : n.tested ? '已测' : (coldSet(ctx).has(n.host) ? '冷启动' : '未测'),
        score: n.score,
        mbps: (n.active ? nodeThroughput(n, t) : nodeRate(n, t)) * 8 / 1e6,
        ttfb: n.ewmaTtfb,
        active: n.active,
        onTime: n.onTime, late: n.late, rescued: n.rescued, stalled: n.stalled, failures: n.failures,
        mb: n.bytes / 1048576,
      })) : [];
      return { stats: Object.assign({}, stats), active, ctxKey: ctx ? ctx.key : null, nodes };
    }

    function exportPriors() {
      const out = {};
      for (const [h, p] of hostPrior) out[h] = { bps: Math.round(p.bps), ttfb: Math.round(p.ttfb) };
      return out;
    }

    return {
      register, request, knows, notifyStall, setConfig, snapshot, exportPriors,
      noteFallback() { stats.fallbacks++; },
      _contexts: contexts, _cfg: cfg,
    };
  }

  // ---------------------------------------------------------------------------
  // 浏览器部分：拿到节点池、接管播放器的分段请求、显示面板
  // ---------------------------------------------------------------------------
  const VERSION = '0.2.1';
  const PLAYURL_RE = /\/(x\/player\/(wbi\/)?playurl|pgc\/player\/web\/(v2\/)?playurl|ogv\/player\/playview)/;
  // 看起来像视频分段的请求（用于诊断记录；是否接管还要看文件名是否在节点池里）
  const MEDIA_RE = /\.m4s(\?|$)|\/\/[^/]*(bilivideo\.(com|cn)|mountaintoys\.cn|szbdyd\.com|akamaized\.net)(:\d+)?\//;

  // 只看域名和路径：统计上报（data.bilibili.com）的查询参数里会带着视频地址，不能算作视频请求
  function isMedia(u) {
    return MEDIA_RE.test(String(u).split(/[?#]/)[0]);
  }

  function safeUrl(u) {
    try { const x = new URL(u); return x.host + '/…/' + x.pathname.split('/').pop(); } catch (e) { return String(u).split('?')[0].slice(-80); }
  }
  const SETTINGS_KEY = 'biliAccel.settings';
  const PRIORS_KEY = 'biliAccel.priors';

  function installBrowser(win, options) {
    options = options || {};
    if (win.__biliAccelInstalled) return win.__biliAccelInstalled;

    const settings = Object.assign({ enabled: true, splitWays: DEFAULTS.maxSplitWays, extraUposMirrors: true }, loadSettings(win));
    delete settings.chunkSize;   // 0.1.x 的旧设置，0.2 起不再使用
    const origFetch = win.fetch.bind(win);

    // 诊断记录：始终保留最近的日志和视频请求的处理结果，面板"复制诊断信息"一键导出
    const diag = { logs: [], seen: [], counts: {}, ingests: [], workers: [] };
    const ring = (arr, item, max) => { arr.push(item); if (arr.length > max) arr.shift(); };
    const stamp = () => Math.round(win.performance.now());
    const log = (...a) => {
      const line = stamp() + 'ms ' + a.map(x => (typeof x === 'string' || typeof x === 'number') ? String(x)
        : (x && x.message) ? x.message : JSON.stringify(x)).join(' ');
      ring(diag.logs, line, 300);
      if (settings.debug) try { win.console.log('[B站加速]', ...a); } catch (e) { /* ignore */ }
    };
    const noteRequest = (via, url, range, decision) => {
      const k = via + ':' + decision;
      diag.counts[k] = (diag.counts[k] || 0) + 1;
      ring(diag.seen, { t: stamp(), via, u: safeUrl(url), range: range || null, decision }, 120);
    };
    let priors = {};
    try { priors = JSON.parse(win.localStorage.getItem(PRIORS_KEY) || '{}') || {}; } catch (e) { /* ignore */ }
    const core = createCore({
      fetch: (url, init) => origFetch(url, init),
      now: () => win.performance.now(),
      getPlayback: () => readPlayback(win.document),
      config: { maxSplitWays: settings.splitWays },
      priors,
      log,
    });
    const api = { core, settings };
    win.__biliAccelInstalled = api;

    // 各节点的历史速度跨页面保存，下次打开视频时冷启动直接挑快的
    if (options.persist !== false) {
      const savePriors = () => {
        try { win.localStorage.setItem(PRIORS_KEY, JSON.stringify(core.exportPriors())); } catch (e) { /* ignore */ }
      };
      try { win.addEventListener('pagehide', savePriors); win.setInterval(savePriors, 60000); } catch (e) { /* ignore */ }
    }

    function save() {
      try { win.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
      core.setConfig({ maxSplitWays: settings.splitWays });
    }
    api.save = save;

    function withMirrors(urls) {
      if (!settings.extraUposMirrors) return urls;
      const up = urls.find(u => /^upos-/.test(hostOf(u)));
      if (!up) return urls;
      const out = urls.slice();
      for (const h of UPOS_MIRRORS) {
        try { const x = new URL(up); x.host = h; out.push(x.href); } catch (e) { /* ignore */ }
      }
      return [...new Set(out)];
    }

    function findDash(o, depth) {
      if (!o || typeof o !== 'object' || depth > 6) return null;
      if (o.dash && (o.dash.video || o.dash.audio)) return o.dash;
      for (const k of Object.keys(o)) {
        const r = findDash(o[k], depth + 1);
        if (r) return r;
      }
      return null;
    }

    function ingest(json, source) {
      const dash = findDash(json, 0);
      if (!dash) { ring(diag.ingests, { t: stamp(), source: source || '?', reps: 0 }, 30); return 0; }
      const reps = [].concat(dash.video || [], dash.audio || [],
        (dash.dolby && dash.dolby.audio) || [], (dash.flac && dash.flac.audio) ? [dash.flac.audio] : []);
      let n = 0;
      for (const rep of reps) {
        if (!rep) continue;
        const urls = [rep.baseUrl || rep.base_url].concat(rep.backupUrl || rep.backup_url || []).filter(Boolean)
          .map(u => (u.indexOf('//') === 0 ? 'https:' + u : u));
        if (!urls.length) continue;
        core.register({ urls: withMirrors(urls), bandwidth: rep.bandwidth });
        n++;
      }
      log('登记视频流', n, source || '?');
      ring(diag.ingests, { t: stamp(), source: source || '?', reps: n }, 30);
      return n;
    }
    api.ingest = ingest;

    // 页面内嵌的 __playinfo__
    try {
      let pi = win.__playinfo__;
      Object.defineProperty(win, '__playinfo__', {
        configurable: true,
        get() { return pi; },
        set(v) { pi = v; try { ingest(v, '__playinfo__'); } catch (e) { /* ignore */ } },
      });
      if (pi) ingest(pi, '__playinfo__(已存在)');
    } catch (e) { /* ignore */ }

    // 记录页面创建的 Worker：如果播放器在 Worker 里下载视频，主页面的钩子是看不到的
    try {
      const OW = win.Worker;
      if (OW && options.hookWorker !== false) {
        const W = function (url, opts) {
          const s = String(url);
          ring(diag.workers, { t: stamp(), url: s.indexOf('blob:') === 0 ? 'blob:' : safeUrl(s) }, 20);
          return new OW(url, opts);
        };
        W.prototype = OW.prototype;
        win.Worker = W;
      }
    } catch (e) { /* ignore */ }

    function headerFrom(input, init, name) {
      const lname = name.toLowerCase();
      const h = init && init.headers;
      if (h) {
        if (typeof h.get === 'function') { const v = h.get(name); if (v != null) return v; }
        else if (Array.isArray(h)) { for (const [k, v] of h) if (String(k).toLowerCase() === lname) return v; }
        else { for (const k of Object.keys(h)) if (k.toLowerCase() === lname) return h[k]; }
      }
      if (input && typeof input === 'object' && input.headers && typeof input.headers.get === 'function') {
        return input.headers.get(name);
      }
      return null;
    }

    function absUrl(u) {
      try { return new URL(u, win.location ? win.location.href : 'https://www.bilibili.com/').href; } catch (e) { return u; }
    }

    // fetch 钩子
    win.fetch = function (input, init) {
      let url = '';
      try {
        url = absUrl(typeof input === 'string' ? input : (input && input.url) || String(input));
        if (PLAYURL_RE.test(url)) {
          return origFetch(input, init).then(res => {
            try { res.clone().json().then(j => ingest(j, 'fetch'), () => {}); } catch (e) { /* ignore */ }
            return res;
          });
        }
        if (isMedia(url)) {
          const method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
          const raw = headerFrom(input, init, 'Range');
          const decision = interceptDecision(method, raw, url, 'arraybuffer');
          noteRequest('fetch', url, raw, decision);
          if (decision === 'intercepted') {
            const range = parseRange(raw);
            const signal = (init && init.signal) || (input && input.signal) || null;
            const p = core.request(url, range.start, range.end, signal);
            if (p) {
              return p.then(info => buildResponse(win, info, url), err => {
                if (isAbort(err)) throw err;
                core.noteFallback();
                log('回退原请求', safeUrl(url), err && err.message);
                return origFetch(input, init);
              });
            }
          }
        }
      } catch (e) {
        log('fetch 钩子异常', e);
      }
      return origFetch(input, init);
    };

    // 判断一个视频请求能不能接管；不能的话给出原因，写进诊断
    function interceptDecision(method, rawRange, url, responseType) {
      if (!settings.enabled) return 'disabled';
      if (method !== 'GET') return 'method:' + method;
      if (!rawRange) return 'no-range';
      const r = parseRange(rawRange);
      if (!r) return 'unsupported-range';
      if (!core.knows(url)) return 'unknown-file';
      if (r.end - r.start + 1 < DEFAULTS.minInterceptBytes) return 'small';
      if (responseType !== 'arraybuffer' && responseType !== 'blob') return 'responseType:' + (responseType || 'text');
      return 'intercepted';
    }

    hookXhr(win, core, settings, ingest, absUrl, log, (via, url, raw, rt, method) => {
      const decision = interceptDecision(method, raw, url, rt);
      noteRequest(via, url, raw, decision);
      return decision === 'intercepted';
    });

    // 诊断信息：只含域名和文件名，不含链接里的签名、用户 ID 等参数
    function diagnostics() {
      let media = [];
      try { media = win.performance.getEntriesByType('resource').filter(e => isMedia(e.name)); } catch (e) { /* ignore */ }
      const byInitiator = {};
      for (const e of media) byInitiator[e.initiatorType] = (byInitiator[e.initiatorType] || 0) + 1;
      let video = null;
      try {
        const v = win.document.querySelector('.bpx-player-video-wrap video, .bpx-player-video-wrap bwp-video') || win.document.querySelector('video, bwp-video');
        if (v) {
          const src = String(v.currentSrc || v.src || '');
          video = { tag: v.tagName.toLowerCase(), src: src.indexOf('blob:') === 0 ? 'blob(MSE)' : src ? safeUrl(src) : '', readyState: v.readyState,
            currentTime: Math.round((v.currentTime || 0) * 10) / 10, paused: !!v.paused };
        }
      } catch (e) { /* ignore */ }
      const snap = core.snapshot();
      return {
        version: VERSION,
        time: new Date().toISOString(),
        page: win.location ? win.location.pathname : '',
        ua: win.navigator ? win.navigator.userAgent : '',
        settings,
        video,
        playback: readPlayback(win.document),
        playinfo: diag.ingests,
        streams: [...core._contexts.values()].map(c => ({ file: c.key, kbps: Math.round(c.bandwidth / 1000), nodes: c.order })),
        requestDecisions: diag.counts,
        recentRequests: diag.seen.slice(-40),
        workers: diag.workers,
        resourceTiming: {
          mediaEntries: media.length,
          byInitiator,
          recent: media.slice(-12).map(e => ({ u: safeUrl(e.name), via: e.initiatorType, ms: Math.round(e.duration), kb: Math.round((e.transferSize || 0) / 1024) })),
        },
        stats: snap.stats,
        nodes: snap.nodes.map(n => ({ host: n.host, state: n.state, score: Math.round(n.score * 100) / 100, mbps: Math.round(n.mbps * 10) / 10,
          ttfb: n.ttfb == null ? null : Math.round(n.ttfb), onTime: n.onTime, late: n.late, rescued: n.rescued, stalled: n.stalled, failures: n.failures, mb: Math.round(n.mb * 10) / 10 })),
        logs: diag.logs.slice(-150),
      };
    }
    api.diagnostics = diagnostics;
    try { win.__biliAccelDiag = () => JSON.stringify(diagnostics(), null, 1); } catch (e) { /* ignore */ }

    // 播放卡顿（非拖动造成的）通知调度器
    try {
      win.document.addEventListener('waiting', e => {
        const el = e.target;
        if (el && /^(VIDEO|BWP-VIDEO)$/i.test(el.tagName || '') && !el.seeking) core.notifyStall();
      }, true);
    } catch (e) { /* ignore */ }

    if (options.panel !== false) mountPanel(win, api);
    return api;
  }

  function loadSettings(win) {
    try { return JSON.parse(win.localStorage.getItem(SETTINGS_KEY) || '{}') || {}; } catch (e) { return {}; }
  }

  function buildResponse(win, info, url) {
    const len = info.end - info.start + 1;
    const headers = {
      'Content-Type': info.contentType || 'video/mp4',
      'Content-Length': String(len),
      'Content-Range': 'bytes ' + info.start + '-' + info.end + '/' + (info.total == null ? '*' : info.total),
      'Accept-Ranges': 'bytes',
    };
    const res = new win.Response(info.body, { status: 206, statusText: 'Partial Content', headers });
    try { Object.defineProperty(res, 'url', { value: url }); } catch (e) { /* ignore */ }
    return res;
  }

  function readPlayback(doc) {
    let v = null;
    try {
      v = doc.querySelector('.bpx-player-video-wrap video, .bpx-player-video-wrap bwp-video') || doc.querySelector('video, bwp-video');
    } catch (e) { return null; }
    if (!v) return null;
    const t = Number(v.currentTime) || 0;
    let ahead = 0;
    try {
      const b = v.buffered;
      for (let i = 0; i < b.length; i++) {
        if (b.start(i) <= t + 0.3 && b.end(i) > t) ahead = Math.max(ahead, b.end(i) - t);
      }
    } catch (e) { /* ignore */ }
    const stalled = !!v.seeking || (typeof v.readyState === 'number' && v.readyState < 3 && !v.paused);
    return { currentTime: t, bufferedAhead: ahead, playbackRate: Number(v.playbackRate) || 1, stalled };
  }

  // XHR 钩子：接管 responseType 为 arraybuffer/blob 的 Range 请求，失败时退回真实请求
  function hookXhr(win, core, settings, ingest, absUrl, log, shouldIntercept) {
    const X = win.XMLHttpRequest;
    if (!X || !X.prototype) return;
    const P = X.prototype;
    const oOpen = P.open, oSend = P.send, oSet = P.setRequestHeader, oAbort = P.abort;
    const oGet = P.getResponseHeader, oAll = P.getAllResponseHeaders;
    const OWN = ['readyState', 'status', 'statusText', 'response', 'responseURL'];

    function setOwn(xhr, props) {
      for (const k of Object.keys(props)) {
        Object.defineProperty(xhr, k, { value: props[k], configurable: true, writable: true, enumerable: true });
      }
    }
    function clearOwn(xhr) {
      for (const k of OWN) { try { delete xhr[k]; } catch (e) { /* ignore */ } }
    }
    function fire(xhr, type, init) {
      let ev;
      try { ev = type === 'readystatechange' ? new win.Event(type) : new win.ProgressEvent(type, init || {}); } catch (e) { ev = new win.Event(type); }
      xhr.dispatchEvent(ev);
    }

    P.open = function (method, url) {
      this.__ba = { method: String(method || 'GET').toUpperCase(), url: absUrl(String(url)), headers: {} };
      return oOpen.apply(this, arguments);
    };
    P.setRequestHeader = function (k, v) {
      if (this.__ba) this.__ba.headers[String(k).toLowerCase()] = String(v);
      return oSet.apply(this, arguments);
    };
    P.send = function (body) {
      const st = this.__ba;
      if (st && PLAYURL_RE.test(st.url)) {
        this.addEventListener('load', () => {
          try {
            const rt = this.responseType;
            if (rt === 'json') ingest(this.response, 'xhr');
            else if (rt === '' || rt === 'text') ingest(JSON.parse(this.responseText), 'xhr');
          } catch (e) { /* ignore */ }
        });
      }
      if (st && isMedia(st.url) && shouldIntercept('xhr', st.url, st.headers.range, this.responseType, st.method)) {
        emulate(this, st, parseRange(st.headers.range), arguments);
        return undefined;
      }
      return oSend.apply(this, arguments);
    };
    P.abort = function () {
      const st = this.__ba;
      if (st && st.emulated) {
        if (st.aborted || st.completed) return undefined;
        st.aborted = true;
        try { st.ac.abort(); } catch (e) { /* ignore */ }
        if (st.startLoad) st.startLoad();
        setOwn(this, { readyState: 4, status: 0, statusText: '', response: null });
        fire(this, 'readystatechange');
        fire(this, 'abort');
        fire(this, 'loadend');
        setOwn(this, { readyState: 0 });
        return undefined;
      }
      return oAbort.apply(this, arguments);
    };
    P.getResponseHeader = function (name) {
      const st = this.__ba;
      if (st && st.emulated) {
        if (!st.respHeaders) return null;
        const v = st.respHeaders[String(name).toLowerCase()];
        return v == null ? null : v;
      }
      return oGet.apply(this, arguments);
    };
    P.getAllResponseHeaders = function () {
      const st = this.__ba;
      if (st && st.emulated) {
        if (!st.respHeaders) return '';
        return Object.keys(st.respHeaders).map(k => k + ': ' + st.respHeaders[k] + '\r\n').join('');
      }
      return oAll.apply(this, arguments);
    };

    function emulate(xhr, st, r, sendArgs) {
      st.emulated = true;
      st.ac = new AbortController();
      const p = core.request(st.url, r.start, r.end, st.ac.signal);
      if (!p) { st.emulated = false; oSend.apply(xhr, sendArgs); return; }
      setOwn(xhr, { readyState: 1 });
      // loadstart 推迟到确定由加速器交付时再发：如果要回退，真实 XHR 会自己发，播放器只会看到一次
      st.startLoad = () => {
        if (st.loadStarted) return;
        st.loadStarted = true;
        fire(xhr, 'loadstart', { loaded: 0, total: 0 });
      };
      p.then(async info => {
        if (st.aborted) return;
        st.startLoad();
        const total = info.end - info.start + 1;
        st.respHeaders = {
          'content-type': info.contentType || 'video/mp4',
          'content-length': String(total),
          'content-range': 'bytes ' + info.start + '-' + info.end + '/' + (info.total == null ? '*' : info.total),
          'accept-ranges': 'bytes',
        };
        setOwn(xhr, { readyState: 2, status: 206, statusText: 'Partial Content', responseURL: st.url });
        fire(xhr, 'readystatechange');
        setOwn(xhr, { readyState: 3 });
        fire(xhr, 'readystatechange');
        const out = new Uint8Array(total);
        let got = 0;
        const reader = info.body.getReader();
        try {
          for (;;) {
            const x = await reader.read();
            if (x.done) break;
            out.set(x.value, got);
            got += x.value.length;
            if (st.aborted) return;
            fire(xhr, 'progress', { lengthComputable: true, loaded: got, total });
          }
        } catch (e) {
          if (st.aborted) return;
          st.completed = true;
          setOwn(xhr, { readyState: 4, status: 0, statusText: '', response: null });
          fire(xhr, 'readystatechange');
          fire(xhr, 'error');
          fire(xhr, 'loadend');
          return;
        }
        if (st.aborted) return;
        st.completed = true;
        const response = xhr.responseType === 'blob' ? new win.Blob([out], { type: st.respHeaders['content-type'] }) : out.buffer;
        setOwn(xhr, { response, readyState: 4 });
        fire(xhr, 'readystatechange');
        fire(xhr, 'load', { lengthComputable: true, loaded: got, total });
        fire(xhr, 'loadend', { lengthComputable: true, loaded: got, total });
      }, err => {
        if (st.aborted || isAbort(err)) return;
        // 还没交付任何数据：交还给真实 XHR，播放器无感知
        core.noteFallback();
        st.emulated = false;
        clearOwn(xhr);
        try { oSend.apply(xhr, sendArgs); } catch (e) { log('XHR 回退失败', e); }
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 面板：左下角 ⚡ 或 Alt+Shift+B
  // ---------------------------------------------------------------------------
  function mountPanel(win, api) {
    const doc = win.document;
    const { core, settings } = api;
    let panel = null;
    let body = null;
    let timer = null;

    const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const fmt = (v, d) => (v == null || !isFinite(v) ? '-' : Number(v).toFixed(d));

    function build() {
      const btn = doc.createElement('div');
      btn.textContent = '⚡';
      btn.title = 'B站多节点加速器（Alt+Shift+B）';
      btn.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483646;width:26px;height:26px;line-height:26px;' +
        'text-align:center;border-radius:13px;background:rgba(0,0,0,.55);color:#ffd54f;cursor:pointer;font-size:15px;user-select:none;';
      btn.addEventListener('click', toggle);
      doc.body.appendChild(btn);

      panel = doc.createElement('div');
      panel.style.cssText = 'position:fixed;left:8px;bottom:40px;z-index:2147483647;display:none;max-width:640px;' +
        'background:rgba(20,20,20,.92);color:#eee;font:12px/1.5 Consolas,"Microsoft YaHei",monospace;padding:10px 12px;' +
        'border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.4);';
      const head = doc.createElement('div');
      head.style.cssText = 'display:flex;gap:12px;align-items:center;margin-bottom:6px;flex-wrap:wrap;';
      head.innerHTML =
        '<b style="color:#ffd54f">⚡ B站多节点加速器</b>' +
        '<label><input type="checkbox" data-k="enabled"> 启用</label>' +
        '<label title="预计赶不上播放时，剩余部分最多分给几个节点">落后时拆成 <select data-k="splitWays"><option value="1">不拆</option><option value="2">2 路</option><option value="3">3 路</option><option value="4">4 路</option></select></label>' +
        '<label><input type="checkbox" data-k="extraUposMirrors"> 试探 upos 镜像</label>' +
        '<label><input type="checkbox" data-k="debug"> 控制台日志</label>' +
        '<button data-act="diag" style="background:#ffd54f;color:#222;border:0;border-radius:4px;padding:2px 10px;cursor:pointer;font:inherit">复制诊断信息</button>';
      panel.appendChild(head);
      const diagBtn = head.querySelector('[data-act="diag"]');
      diagBtn.addEventListener('click', () => {
        const text = JSON.stringify(api.diagnostics(), null, 1);
        const done = ok => {
          diagBtn.textContent = ok ? '已复制 ✓ 去粘贴吧' : '复制失败，请手动复制下方文本';
          win.setTimeout(() => { diagBtn.textContent = '复制诊断信息'; }, 3000);
        };
        const manual = () => {
          let ta = panel.querySelector('textarea');
          if (!ta) {
            ta = doc.createElement('textarea');
            ta.style.cssText = 'display:block;width:100%;height:140px;margin-top:6px;font:11px Consolas,monospace;';
            panel.appendChild(ta);
          }
          ta.value = text;
          ta.focus();
          ta.select();
          let ok = false;
          try { ok = doc.execCommand('copy'); } catch (e) { /* ignore */ }
          done(ok);
        };
        try { win.navigator.clipboard.writeText(text).then(() => done(true), manual); } catch (e) { manual(); }
      });
      body = doc.createElement('div');
      panel.appendChild(body);
      const tip = doc.createElement('div');
      tip.style.cssText = 'color:#999;margin-top:6px;';
      tip.textContent = '设置对之后的新请求生效；切换视频或刷新页面后节点重新评分。';
      panel.appendChild(tip);
      doc.body.appendChild(panel);

      for (const el of head.querySelectorAll('[data-k]')) {
        const k = el.getAttribute('data-k');
        if (el.type === 'checkbox') el.checked = !!settings[k];
        else el.value = String(settings[k]);
        el.addEventListener('change', () => {
          settings[k] = el.type === 'checkbox' ? el.checked : Number(el.value);
          api.save();
        });
      }
    }

    function render() {
      const s = core.snapshot();
      const st = s.stats;
      let html = '<div>已接管请求 ' + st.jobs + '（' + fmt(st.bytes / 1048576, 1) + ' MB），落后拆分 ' + st.splits + '，救援 ' +
        st.rescues + '，探索 ' + st.explores + '，播放卡顿 ' + st.stalls + '，内容不一致 ' + st.mismatches + '，回退原请求 ' + st.fallbacks +
        '，进行中 ' + s.active + '</div>';
      if (!s.ctxKey) {
        html += '<div style="color:#999;margin-top:4px">还没有接管任何视频请求。打开一个视频开始播放后再看。</div>';
      } else {
        html += '<div style="color:#999;margin-top:4px">当前流：' + esc(s.ctxKey) + '</div>';
        html += '<table style="border-collapse:collapse;margin-top:4px"><tr style="color:#aaa">' +
          ['节点', '状态', '评分', 'Mbps', '首包ms', '并发', '按时/迟到', '被救援', '致卡顿', '失败', 'MB'].map(h => '<td style="padding:1px 6px">' + h + '</td>').join('') + '</tr>';
        const rows = s.nodes.slice().sort((a, b) => b.score - a.score);
        for (const n of rows) {
          const color = n.state === '失效' || n.state === '暂停' ? '#ef5350' : n.score >= 0.6 ? '#81c784' : n.score >= 0.35 ? '#eee' : '#ffb74d';
          html += '<tr style="color:' + color + '">' + [
            esc(n.host.replace(/\.(bilivideo\.com|bilivideo\.cn)$/, '')), n.state, fmt(n.score, 2), fmt(n.mbps, 1), fmt(n.ttfb, 0),
            n.active, n.onTime + '/' + n.late, n.rescued, n.stalled, n.failures, fmt(n.mb, 1),
          ].map(v => '<td style="padding:1px 6px">' + v + '</td>').join('') + '</tr>';
        }
        html += '</table>';
      }
      body.innerHTML = html;
    }

    function toggle() {
      if (!panel) return;
      const show = panel.style.display === 'none';
      panel.style.display = show ? 'block' : 'none';
      if (show) { render(); timer = win.setInterval(render, 1000); } else if (timer) { win.clearInterval(timer); timer = null; }
    }

    win.addEventListener('keydown', e => {
      if (e.altKey && e.shiftKey && (e.code === 'KeyB' || e.key === 'B' || e.key === 'b')) { e.preventDefault(); toggle(); }
    }, true);

    if (doc.body) build();
    else doc.addEventListener('DOMContentLoaded', build, { once: true });
  }

  const api = { createCore, installBrowser, DEFAULTS, parseRange, parseContentRange, filenameOf, hostOf };
  if (typeof module === 'object' && module && module.exports) {
    module.exports = api;
    return;
  }
  if (typeof window !== 'undefined') installBrowser(window, {});
})();
