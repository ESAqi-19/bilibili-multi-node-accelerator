'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCore, installBrowser } = require('../bilibili-accelerator.user.js');
const { makeNet, readAll, firstMismatch, sleep } = require('./fakenet');

const MB = 1024 * 1024;
const FILE = 'v/1234-1-80.m4s';

function setup(spec, opts) {
  opts = opts || {};
  const net = makeNet(spec, opts.fileSize || 16 * MB);
  const playback = Object.assign({ bufferedAhead: 2, playbackRate: 1, stalled: false }, opts.playback);
  const core = createCore({
    fetch: net.fetch,
    getPlayback: () => playback,
    config: Object.assign({ tickMs: 50 }, opts.config),
  });
  const hosts = Object.keys(spec);
  const urls = hosts.map((h, i) => 'https://' + h + '/' + FILE + '?sig=' + i);
  core.register({ urls, bandwidth: opts.bandwidth || 2e6 });
  return { net, core, urls, playback, ctx: core._contexts.get('1234-1-80.m4s') };
}

// 在跑满整个套件、机器负载较高时，取消信号传到 fakenet 的 abort 回调可能要多等一会，
// 给够余量再判断「请求应该已经断开」，避免测试本身在重负载下偶发超时
async function settle(net) {
  for (let i = 0; i < 100 && net.inflight > 0; i++) await sleep(50);
}

// 先拉一段，让节点都有速度样本、脱离冷启动
async function warm(core, urls, bytes) {
  await readAll((await core.request(urls[0], 0, (bytes || MB) - 1, null)).body);
}

test('节点正常、来得及时，整段只发一个请求，不额外拆分', async () => {
  const { net, core, urls } = setup({ 'a.test': { ttfb: 20, bps: 8 * MB }, 'b.test': { ttfb: 20, bps: 8 * MB } },
    { playback: { bufferedAhead: 5 } });
  await warm(core, urls);
  await settle(net);
  net.log.length = 0;
  const info = await core.request(urls[0], 100, 3 * MB + 99, null);
  assert.equal(info.total, 16 * MB);
  const bytes = await readAll(info.body);
  assert.equal(bytes.length, 3 * MB);
  assert.equal(firstMismatch(bytes, 100), -1);
  assert.equal(net.log.length, 1, '只应有一个请求：' + JSON.stringify(net.log.map(e => [e.host, e.a, e.b])));
  assert.equal(core.snapshot().stats.splits, 0);
  await settle(net);
  assert.equal(net.inflight, 0);
});

test('整段预计赶不上时，把剩余部分按速度拆给多个节点，字节完整', async () => {
  const spec = { 'a.test': { ttfb: 20, bps: 1.5 * MB }, 'b.test': { ttfb: 20, bps: 1.5 * MB }, 'c.test': { ttfb: 20, bps: 1.5 * MB } };
  const { net, core, urls, ctx } = setup(spec, { playback: { bufferedAhead: 0 }, config: { coldStartNodes: 3 } });
  await warm(core, urls, 512 * 1024);
  await settle(net);
  for (const n of ctx.nodes.values()) n.tested = true;
  net.log.length = 0;
  const t0 = Date.now();
  const info = await core.request(urls[0], 4 * MB, 7 * MB - 1, null);
  const bytes = await readAll(info.body);
  const took = Date.now() - t0;
  assert.equal(firstMismatch(bytes, 4 * MB), -1);
  assert.ok(core.snapshot().stats.splits >= 1, '应该发生拆分');
  assert.equal(new Set(net.log.map(e => e.host)).size, 3, '应该用上三个节点');
  assert.ok(took < 1600, '3MB 单节点要 2 秒，拆成三路应明显更快，实际 ' + took + 'ms');
  await settle(net);
  assert.equal(net.inflight, 0, '被截短的原请求应已断开');
});

test('拆分时按速度分配：快节点分到更多字节', async () => {
  const { net, core, urls, ctx } = setup(
    { 'slow.test': { ttfb: 20, bps: 1 * MB }, 'fast.test': { ttfb: 20, bps: 6 * MB } },
    { playback: { bufferedAhead: 0 }, config: { explore: false } },
  );
  await warm(core, urls, 512 * 1024);
  await settle(net);
  // 让慢节点成为原请求：它被选中后落后，剩余部分应大头交给快节点
  ctx.nodes.get('fast.test').active = 99;
  const p = core.request(urls[0], 2 * MB, 6 * MB - 1, null);
  ctx.nodes.get('fast.test').active = 0;
  net.log.length = 0;
  const bytes = await readAll((await p).body);
  assert.equal(firstMismatch(bytes, 2 * MB), -1);
  const by = h => net.log.filter(e => e.host === h).reduce((s, e) => s + e.bytes, 0);
  assert.ok(core.snapshot().stats.splits >= 1);
  assert.ok(by('fast.test') > 2 * by('slow.test'), '快节点应分到更多：fast ' + by('fast.test') + ' slow ' + by('slow.test'));
  await settle(net);
});

test('文件长度和其他节点不同的节点会被停用，它那段改由正常节点完成', async () => {
  const net = makeNet({ 'good.test': { ttfb: 10, bps: 1 * MB }, 'other.test': { ttfb: 10, bps: 8 * MB, fileSize: 15 * MB } }, 16 * MB);
  const core = createCore({ fetch: net.fetch, getPlayback: () => ({ bufferedAhead: 0, playbackRate: 1 }), config: { tickMs: 50 } });
  const good = 'https://good.test/' + FILE;
  core.register({ urls: [good] });
  await warm(core, [good], 256 * 1024);
  await settle(net);
  core.register({ urls: [good, 'https://other.test/' + FILE] });
  const ctx = core._contexts.get('1234-1-80.m4s');
  const info = await core.request(good, 2 * MB, 4 * MB - 1, null);
  const bytes = await readAll(info.body);
  assert.equal(firstMismatch(bytes, 2 * MB), -1, '交付的数据必须完整正确');
  const other = ctx.nodes.get('other.test');
  assert.ok(net.log.some(e => e.host === 'other.test'), '长度不同的节点确实被派去拉过数据');
  assert.equal(other.mismatch, true);
  assert.equal(other.permanentDead, true);
  assert.equal(core.snapshot().stats.mismatches, 1);
  await settle(net);
});

test('长度相同但内容不同：抢跑时核对已收到的字节，发现后停用', async () => {
  const { net, core, urls, ctx } = setup(
    { 'good.test': { ttfb: 10, bps: 8 * MB }, 'bad.test': { ttfb: 10, bps: 2 * MB, variant: true } },
    { playback: { bufferedAhead: 0 } },
  );
  const info = await core.request(urls[0], 0, MB - 1, null);
  const bytes = await readAll(info.body);
  assert.equal(firstMismatch(bytes, 0), -1, '交付的数据必须来自正确的节点');
  assert.equal(ctx.nodes.get('bad.test').mismatch, true);
  await settle(net);
});

test('拆出去的那段内容不同：交付前核对重叠字节，整段作废并停用节点', async () => {
  const net = makeNet({ 'good.test': { ttfb: 10, bps: 1 * MB }, 'bad.test': { ttfb: 300, bps: 8 * MB, variant: true } }, 16 * MB);
  // 关掉抢跑：否则坏节点在抢跑核对阶段就被拦下了，走不到拆分后的核对
  const core = createCore({ fetch: net.fetch, getPlayback: () => ({ bufferedAhead: 0, playbackRate: 1 }), config: { tickMs: 50, coldRace: false } });
  const good = 'https://good.test/' + FILE;
  const bad = 'https://bad.test/' + FILE;
  core.register({ urls: [good] });
  await warm(core, [good], 256 * 1024);
  await settle(net);
  core.register({ urls: [good, bad] });
  const ctx = core._contexts.get('1234-1-80.m4s');
  const info = await core.request(good, 2 * MB, 5 * MB - 1, null);
  await assert.rejects(readAll(info.body), /不一致/);
  assert.equal(ctx.nodes.get('bad.test').mismatch, true);
  assert.ok(core.snapshot().stats.splits >= 1);
  await settle(net);
});

test('不认识的地址返回 null，交给原始请求', () => {
  const { core } = setup({ 'a.test': { ttfb: 10, bps: MB } });
  assert.equal(core.request('https://a.test/v/other-1-80.m4s', 0, MB, null), null);
});

test('节点中途卡住会触发救援，结果仍然正确，冗余请求被取消', async () => {
  const { net, core, urls, ctx } = setup(
    { 'slow.test': { ttfb: 20, bps: 8 * MB, stallAfter: 64 * 1024 }, 'good.test': { ttfb: 30, bps: 4 * MB } },
    { playback: { bufferedAhead: 0.5 }, config: { coldStartNodes: 1 } },
  );
  const t0 = Date.now();
  const info = await core.request(urls[0], 0, 2 * MB - 1, null);
  const bytes = await readAll(info.body);
  const took = Date.now() - t0;
  assert.equal(firstMismatch(bytes, 0), -1);
  const s = core.snapshot();
  assert.ok(s.stats.rescues >= 1, '应该至少救援一次');
  const slow = ctx.nodes.get('slow.test');
  assert.ok(slow.score < 0.5, '触发救援的节点要降级，实际 ' + slow.score);
  assert.ok(slow.rescued >= 1);
  assert.ok(took < 4000, '救援应该比 4 秒卡死超时更早介入，实际 ' + took + 'ms');
  await settle(net);
  assert.equal(net.inflight, 0, '卡住的请求在分块完成后应被取消');
});

test('返回 403 的节点被判失效，其余节点完成下载', async () => {
  const { net, core, urls, ctx } = setup({ 'deny.test': { ttfb: 10, status: 403 }, 'ok.test': { ttfb: 20, bps: 5 * MB } });
  const info = await core.request(urls[0], 0, MB - 1, null);
  const bytes = await readAll(info.body);
  assert.equal(firstMismatch(bytes, 0), -1);
  const deny = ctx.nodes.get('deny.test');
  assert.equal(deny.permanentDead, true);
  assert.equal(deny.score, 0);
  await settle(net);
});

test('所有节点都失败时请求被拒绝，方便调用方回退', async () => {
  const { core, urls } = setup({ 'x.test': { ttfb: 5, status: 403 }, 'y.test': { ttfb: 5, status: 404 } });
  await assert.rejects(core.request(urls[0], 0, MB - 1, null));
});

test('冷启动只用前两个节点', async () => {
  const spec = {};
  for (const h of ['n1.test', 'n2.test', 'n3.test', 'n4.test']) spec[h] = { ttfb: 20, bps: 4 * MB };
  const { net, core, urls } = setup(spec, { playback: { bufferedAhead: 0 } });
  const info = await core.request(urls[0], 0, 2 * MB - 1, null);
  await readAll(info.body);
  const used = new Set(net.log.map(e => e.host));
  assert.deepEqual([...used].sort(), ['n1.test', 'n2.test']);
  await settle(net);
});

test('冷启动：B 站首选节点慢时，抢跑由 upos 赢下，慢节点只拿到很少数据', async () => {
  const { net, core, urls } = setup(
    { 'pcdn.test:4483': { ttfb: 20, bps: 0.3 * MB }, 'mid.test': { ttfb: 20, bps: 4 * MB }, 'upos-a.test': { ttfb: 20, bps: 4 * MB } },
    { playback: { bufferedAhead: 0 } },
  );
  const info = await core.request(urls[0], 0, 2 * MB - 1, null);
  const bytes = await readAll(info.body);
  assert.equal(firstMismatch(bytes, 0), -1);
  const first = net.log.filter(e => e.a === 0);
  assert.deepEqual(first.map(e => e.host).sort(), ['pcdn.test:4483', 'upos-a.test'], '整段由首选节点和 upos 抢跑');
  assert.equal(first.find(e => e.host === 'pcdn.test:4483').aborted, true, '慢的首选节点输掉抢跑后被取消');
  assert.ok(!net.log.some(e => e.host === 'mid.test'), '其余节点不进入冷启动');
  const pcdnBytes = net.log.filter(e => e.host === 'pcdn.test:4483').reduce((s, e) => s + e.bytes, 0);
  assert.ok(pcdnBytes < 256 * 1024, '慢节点只应拿到少量数据，实际 ' + pcdnBytes);
  await settle(net);
});

test('冷启动：B 站首选节点很快时赢下抢跑', async () => {
  const { net, core, urls, ctx } = setup(
    { 'mcdn.test:8082': { ttfb: 10, bps: 12 * MB }, 'upos-a.test': { ttfb: 200, bps: 2 * MB } },
    { playback: { bufferedAhead: 0 } },
  );
  const info = await core.request(urls[0], 0, 2 * MB - 1, null);
  await readAll(info.body);
  const first = net.log.filter(e => e.a === 0);
  assert.equal(first.find(e => e.host === 'upos-a.test').aborted, true, '输掉抢跑的 upos 被取消');
  const mcdn = ctx.nodes.get('mcdn.test:8082');
  assert.ok(mcdn.onTime >= 1 && mcdn.score > 0.5, '快的首选节点交付第一块并加分');
  await settle(net);
});

test('抢跑比的是谁先下完：首包慢一点但下载快得多的节点赢', async () => {
  const { net, core, urls, ctx } = setup(
    { 'quickstart.test': { ttfb: 10, bps: 1.5 * MB }, 'fastdl.test': { ttfb: 60, bps: 10 * MB } },
    { playback: { bufferedAhead: 0 } },
  );
  const info = await core.request(urls[0], 0, 3 * MB - 1, null);
  const bytes = await readAll(info.body);
  assert.equal(firstMismatch(bytes, 0), -1);
  const qs = net.log.find(e => e.host === 'quickstart.test' && e.a === 0);
  assert.equal(qs.aborted, true, '先出首包、但下载慢的节点应输掉抢跑');
  assert.ok(ctx.nodes.get('fastdl.test').onTime >= 1, '下载快的节点交付整段');
  assert.ok(ctx.nodes.get('quickstart.test').ewmaBps != null, '输家也要留下速度样本');
  await settle(net);
});

test('紧急请求优先 B 站首选节点；别的节点在大传输里可靠地快很多才换', async () => {
  const { net, core, urls, ctx } = setup(
    { 'home.test': { ttfb: 20, bps: 3 * MB }, 'alt.test': { ttfb: 20, bps: 15 * MB } },
    { playback: { bufferedAhead: 0 }, config: { coldRace: false, maxSplitWays: 1 } },
  );
  const home = ctx.nodes.get('home.test');
  const alt = ctx.nodes.get('alt.test');
  // 只有短样本说 alt 更快：不换
  alt.ewmaBps = 15 * MB; alt.tested = true;
  await readAll((await core.request(urls[0], 0, MB - 1, null)).body);
  assert.equal(net.log[0].host, 'home.test', '没有可靠证据时用首选节点');
  await settle(net);
  // alt 在两次大传输里都明显更快：换
  alt.bigSamples = 2; alt.ewmaTtfb = 20;   // 做过大传输的节点一定也测过首包时间
  home.bigSamples = 1; home.ewmaBps = 3 * MB;
  net.log.length = 0;
  await readAll((await core.request(urls[0], 2 * MB, 3 * MB - 1, null)).body);
  assert.equal(net.log[0].host, 'alt.test', '可靠地快很多时换节点');
  await settle(net);
});

test('赢家太快、对手首包还没来得及回来，不算对手"没到场"', async () => {
  const { net, core, urls, ctx } = setup(
    { 'rocket.test': { ttfb: 5, bps: 40 * MB }, 'normal.test': { ttfb: 80, bps: 6 * MB } },
    { playback: { bufferedAhead: 0 } },
  );
  await readAll((await core.request(urls[0], 0, MB - 1, null)).body);
  await settle(net);
  const normal = ctx.nodes.get('normal.test');
  assert.equal(normal.noShow, 0);
  assert.equal(normal.permanentDead, false);
});

test('冷启动时紧急分块让两个节点抢跑，慢的被取消', async () => {
  const { net, core, urls, ctx } = setup(
    { 'a.test': { ttfb: 800, bps: 4 * MB }, 'b.test': { ttfb: 30, bps: 4 * MB } },
    { playback: { bufferedAhead: 0 } },
  );
  const t0 = Date.now();
  const info = await core.request(urls[0], 0, 512 * 1024 - 1, null);
  await readAll(info.body);
  const took = Date.now() - t0;
  const firstHosts = net.log.filter(e => e.a === 0).map(e => e.host).sort();
  assert.deepEqual(firstHosts, ['a.test', 'b.test'], '第一块应同时发给两个节点');
  assert.ok(took < 700, '应该由快的节点交付，实际 ' + took + 'ms');
  assert.equal(ctx.nodes.get('a.test').rescued, 0, '抢跑输了不算被救援');
  await settle(net);
  assert.equal(net.inflight, 0);
});

test('播放稳定后用远端分块探索未测过的节点', async () => {
  const spec = {};
  for (const h of ['n1.test', 'n2.test', 'n3.test', 'n4.test']) spec[h] = { ttfb: 20, bps: 4 * MB };
  const { net, core, urls, ctx } = setup(spec, { playback: { bufferedAhead: 30 } });
  await warm(core, urls, 2 * MB);   // 第一段是冷启动抢跑，不同时探索
  await settle(net);
  const info = await core.request(urls[0], 4 * MB, 7 * MB - 1, null);
  const bytes = await readAll(info.body);
  assert.equal(firstMismatch(bytes, 4 * MB), -1);
  assert.ok(core.snapshot().stats.explores >= 1, '应该至少探索一次');
  const tested = [...ctx.nodes.values()].filter(n => n.tested).map(n => n.host);
  assert.ok(tested.includes('n3.test') || tested.includes('n4.test'), '冷启动之外的节点应被测过：' + tested.join(','));
  await settle(net);
});

test('播放器约 2 秒就会超时重发：缓冲再多，慢节点也要在 1.5 秒内被拆分兜底', async () => {
  const { net, core, urls, ctx } = setup(
    { 'slow.test': { ttfb: 20, bps: 1 * MB }, 'fast.test': { ttfb: 20, bps: 8 * MB } },
    { playback: { bufferedAhead: 30 }, config: { explore: false, coldRace: false } },
  );
  const fast = ctx.nodes.get('fast.test');
  fast.tested = true; fast.ewmaBps = 8 * MB; fast.ewmaTtfb = 20; fast.bigSamples = 2;
  const t0 = Date.now();
  const bytes = await readAll((await core.request(urls[0], 0, 4 * MB - 1, null)).body);
  const took = Date.now() - t0;
  assert.equal(firstMismatch(bytes, 0), -1);
  assert.equal(net.log[0].host, 'slow.test', '首选节点先拿到这一段');
  assert.ok(core.snapshot().stats.splits >= 1, '应在播放器超时前拆分');
  assert.ok(took < 1800, '慢节点单独要 4 秒，拆分后应赶在播放器 2 秒超时前完成，实际 ' + took + 'ms');
  await settle(net);
});

test('首选节点出过问题（被救援/失败/没到场）后，不再享受"给一次机会"', async () => {
  const { net, core, urls, ctx } = setup(
    { 'home.test': { ttfb: 20, bps: 3 * MB }, 'alt.test': { ttfb: 20, bps: 15 * MB } },
    { playback: { bufferedAhead: 0 }, config: { coldRace: false, maxSplitWays: 1 } },
  );
  const home = ctx.nodes.get('home.test');
  const alt = ctx.nodes.get('alt.test');
  alt.tested = true; alt.ewmaBps = 15 * MB; alt.ewmaTtfb = 20; alt.bigSamples = 2;
  home.rescued = 1;   // 没做过大传输，但之前被救援过
  await readAll((await core.request(urls[0], 0, MB - 1, null)).body);
  assert.equal(net.log[0].host, 'alt.test', '出过问题的首选节点不再优先');
  await settle(net);
});

test('探索采用陪跑：未测节点不通时，这一段照样由已知节点按时完成', async () => {
  const spec = { 'known.test': { ttfb: 20, bps: 6 * MB }, 'n2.test': { ttfb: 20, bps: 6 * MB }, 'dead.test': { ttfb: 60000, bps: 6 * MB } };
  const { net, core, urls, ctx } = setup(spec, { playback: { bufferedAhead: 30 } });
  for (const h of ['known.test', 'n2.test']) {
    const n = ctx.nodes.get(h);
    n.tested = true; n.ewmaBps = 6 * MB; n.ewmaTtfb = 20; n.bigSamples = 2;
  }
  const t0 = Date.now();
  const bytes = await readAll((await core.request(urls[0], 0, 3 * MB - 1, null)).body);
  const took = Date.now() - t0;
  assert.equal(firstMismatch(bytes, 0), -1);
  assert.ok(net.log.some(e => e.host === 'dead.test'), '应该派出探测请求');
  assert.ok(core.snapshot().stats.explores >= 1);
  assert.ok(took < 1200, '探测节点不通不应拖慢这一段，实际 ' + took + 'ms');
  assert.equal(net.log.find(e => e.host === 'dead.test').aborted, true, '探测请求在判定后被取消');
  assert.equal(ctx.nodes.get('dead.test').tested, false, '不通的节点不能算作已测');
  await settle(net);
});

test('外部取消会中止所有在途请求', async () => {
  const { net, core, urls } = setup({ 'a.test': { ttfb: 20, bps: 0.5 * MB }, 'b.test': { ttfb: 20, bps: 0.5 * MB } });
  const ac = new AbortController();
  const p = core.request(urls[0], 0, 4 * MB - 1, ac.signal);
  setTimeout(() => ac.abort(), 150);
  await assert.rejects(p.then(info => readAll(info.body)), e => e.name === 'AbortError');
  await settle(net);
  assert.equal(net.inflight, 0);
});

test('播放卡顿会惩罚正在拖后腿的节点', async () => {
  const { net, core, urls, ctx } = setup({ 'a.test': { ttfb: 20, bps: 0.3 * MB } }, { playback: { bufferedAhead: 5 } });
  const ac = new AbortController();
  const p = core.request(urls[0], 0, 2 * MB - 1, ac.signal);
  await sleep(200);
  core.notifyStall();
  assert.equal(core.snapshot().stats.stalls, 1);
  assert.ok(ctx.nodes.get('a.test').score < 0.5);
  assert.ok(ctx.nodes.get('a.test').stalled >= 1);
  ac.abort();
  await p.then(i => readAll(i.body)).catch(() => {});
  await settle(net);
});

test('浏览器钩子：从 playurl 登记节点池并接管 fetch 的 Range 请求', async () => {
  const net = makeNet({ 'a.test': { ttfb: 20, bps: 5 * MB }, 'b.test': { ttfb: 20, bps: 5 * MB }, 'c.test': { ttfb: 10, bps: 5 * MB } }, 8 * MB);
  const playJson = {
    code: 0,
    data: {
      dash: {
        video: [{ id: 80, bandwidth: 2000000, baseUrl: 'https://a.test/' + FILE + '?s=1', backupUrl: ['https://b.test/' + FILE + '?s=2'] }],
        audio: [{ id: 30280, bandwidth: 128000, base_url: 'https://a.test/v/1234-1-30280.m4s', backup_url: [] }],
      },
    },
  };
  const win = {
    fetch: (url, init) => String(url).includes('/playurl')
      ? Promise.resolve(new Response(JSON.stringify(playJson), { headers: { 'Content-Type': 'application/json' } }))
      : String(url).includes('data.bilibili.com') ? Promise.resolve(new Response('ok'))
      : net.fetch(String(url), init),
    performance, console, Response, Blob, Event,
    localStorage: { getItem() { return null; }, setItem() {} },
    location: { href: 'https://www.bilibili.com/video/BV1xx' },
    document: { querySelector: () => null, addEventListener() {} },
    addEventListener() {}, setInterval, clearInterval,
  };
  const api = installBrowser(win, { panel: false, persist: false });
  await (await win.fetch('https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1xx')).json();
  await sleep(20);
  assert.ok(api.core.knows('https://a.test/' + FILE + '?s=1'));
  assert.ok(api.core.knows('https://b.test/v/1234-1-30280.m4s?anything'), '按文件名匹配，换节点也认得');

  const res = await win.fetch('https://a.test/' + FILE + '?s=1', { headers: { Range: 'bytes=1000-2098151' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 1000-2098151/' + 8 * MB);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(bytes.length, 2097152);
  assert.equal(firstMismatch(bytes, 1000), -1);
  assert.deepEqual([...new Set(net.log.map(e => e.host))].sort(), ['a.test', 'b.test']);

  // 太小的请求（初始化段）不接管
  net.log.length = 0;
  const small = await win.fetch('https://a.test/' + FILE + '?s=1', { headers: { Range: 'bytes=0-999' } });
  assert.equal((await small.arrayBuffer()).byteLength, 1000);
  assert.equal(net.log.length, 1);

  // 没登记的文件直接放行
  net.log.length = 0;
  await (await win.fetch('https://c.test/v/9999-1-16.m4s', { headers: { Range: 'bytes=0-1048575' } })).arrayBuffer();
  assert.equal(net.log.length, 1);
  assert.equal(net.log[0].host, 'c.test');

  // 统计上报的查询参数里带着视频地址，不应被当成视频请求
  await (await win.fetch('https://data.bilibili.com/log/web?url=https%3A%2F%2Fa.test%2Fv%2F1234-1-80.m4s')).text();

  // 诊断信息：记录每个视频请求的处理结果，且不带链接参数
  const d = api.diagnostics();
  assert.ok(!d.recentRequests.some(r => r.u.includes('data.bilibili.com')), '统计上报不应出现在视频请求记录里');
  assert.equal(d.requestDecisions['fetch:intercepted'], 1);
  assert.equal(d.requestDecisions['fetch:small'], 1);
  assert.equal(d.requestDecisions['fetch:unknown-file'], 1);
  assert.ok(d.playinfo.some(x => x.source === 'fetch' && x.reps === 2));
  assert.equal(d.streams.length, 2);
  const text = JSON.stringify(d);
  assert.ok(!text.includes('?s=1') && !text.includes('s=2'), '诊断里不应出现链接参数');
  assert.ok(d.logs.some(l => l.includes('接管')) && d.logs.some(l => l.includes('完成')));
  await settle(net);
});

test('浏览器钩子：节点全部失败时回退到原始请求', async () => {
  const net = makeNet({ 'd.test': { ttfb: 5, status: 403 } }, 4 * MB);
  const win = {
    fetch: (url, init) => net.fetch(String(url), init),
    performance, console, Response, Blob, Event,
    localStorage: { getItem() { return null; }, setItem() {} },
    location: { href: 'https://www.bilibili.com/video/BV1xx' },
    document: { querySelector: () => null, addEventListener() {} },
    addEventListener() {}, setInterval, clearInterval,
  };
  const api = installBrowser(win, { panel: false, persist: false });
  api.ingest({ data: { dash: { video: [{ bandwidth: 1e6, baseUrl: 'https://d.test/' + FILE }] } } });
  const res = await win.fetch('https://d.test/' + FILE, { headers: { Range: 'bytes=0-1048575' } });
  assert.equal(res.status, 403, '回退后播放器拿到的是原始响应');
  assert.equal(api.core.snapshot().stats.fallbacks, 1);
});
