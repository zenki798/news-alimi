// 수집 파이프라인의 장애 대응 — 장애를 일부러 일으켜(네트워크 없이) 수집기가 견디는지 본다.
// 지킴이(watchdog)의 판단·복구는 tests/watchdog.spec.js 에서 본다.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const fn = require('../scripts/fetch-news');

const NOW = Date.now();

/** 기사 n 건짜리 정상 RSS */
function rss(prefix, n) {
  let items = '';
  for (let i = 0; i < n; i++) {
    items += '<item><title>' + prefix + ' 기사 ' + i + '</title><link>https://example.com/' + prefix + '/' + i + '</link>' +
      '<description>' + prefix + ' 기사 ' + i + ' 의 요약입니다. 스무 글자를 넘도록 조금 길게 씁니다.</description>' +
      '<pubDate>' + new Date(NOW - (i + 1) * 60000).toUTCString() + '</pubDate></item>';
  }
  return '<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>' + prefix + '</title>' + items + '</channel></rss>';
}

/** global.fetch 를 바꿔 끼워 출처마다 다른 장애를 흉내 낸다. calls 에 주소별 요청 시각을 모은다 */
function fakeNetwork(routes) {
  const real = global.fetch;
  const calls = {};
  global.fetch = (url, opts) => {
    (calls[url] = calls[url] || []).push(Date.now());
    const r = routes[url];
    if (r === 'hang') {
      /* 답이 오지 않는다 — 수집기의 시간 제한(AbortController)이 끊어야 한다 */
      return new Promise((_, reject) => opts.signal.addEventListener('abort', () => {
        const e = new Error('aborted'); e.name = 'AbortError'; reject(e);
      }));
    }
    if (typeof r === 'function') return Promise.resolve(r(calls[url].length));
    if (typeof r === 'number') return Promise.resolve({ ok: false, status: r, text: async () => '' });
    if (r === 'reset') return Promise.reject(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }));
    return Promise.resolve({ ok: true, status: 200, text: async () => r });
  };
  return { calls, restore() { global.fetch = real; } };
}

function withEnv(env, body) {
  const old = {};
  Object.keys(env).forEach(k => { old[k] = process.env[k]; process.env[k] = env[k]; });
  return Promise.resolve().then(body).finally(() => {
    Object.keys(env).forEach(k => { if (old[k] === undefined) delete process.env[k]; else process.env[k] = old[k]; });
  });
}

const FAST = { NEWS_TIMEOUT_MS: '60', NEWS_RETRY_MS: '5', NEWS_ATTEMPTS: '3' };

const FEEDS = [
  { category: 'it', source: '정상A', url: 'https://a.example/rss' },
  { category: 'it', source: '응답없음', url: 'https://slow.example/rss' },
  { category: 'econ', source: '서버오류', url: 'https://e500.example/rss' },
  { category: 'econ', source: '점검화면', url: 'https://html.example/rss' },
  { category: 'politics', source: '정상B', url: 'https://b.example/rss' },
];

test('출처 하나가 시간 초과·500·RSS 아님이어도 나머지로 수집하고, 실패한 출처와 까닭을 남긴다', async () => {
  const net = fakeNetwork({
    'https://a.example/rss': rss('A', 3),
    'https://slow.example/rss': 'hang',
    'https://e500.example/rss': 500,
    'https://html.example/rss': '<!DOCTYPE html><html><body>서비스 점검 중입니다</body></html>',
    'https://b.example/rss': rss('B', 2),
  });
  try {
    await withEnv(FAST, async () => {
      const { payload, report } = await fn.collect({ feeds: FEEDS });
      expect(payload.articles.map(a => a.source).sort()).toEqual(['정상A', '정상A', '정상A', '정상B', '정상B']);
      expect([report.sources_ok, report.sources_failed]).toEqual([2, 3]);
      const why = Object.fromEntries(report.failed_sources.map(s => [s.source, s.reason]));
      expect(why['응답없음']).toMatch(/시간 초과.*3번 시도/);        // 시간 제한으로 끊고, 다시 받아 봤다
      expect(why['서버오류']).toMatch(/HTTP 500.*3번 시도/);
      expect(why['점검화면']).toMatch(/RSS 형식이 아님/);              // 200 이어도 RSS 가 아니면 실패로 센다
      /* 다시 받는 것은 잠깐의 장애뿐 — RSS 가 아닌 응답은 다시 받아도 같다 */
      expect(net.calls['https://slow.example/rss']).toHaveLength(3);
      expect(net.calls['https://e500.example/rss']).toHaveLength(3);
      expect(net.calls['https://html.example/rss']).toHaveLength(1);
    });
  } finally { net.restore(); }
});

test('잠깐의 장애는 간격을 두 배씩 늘려 다시 받고(지수 백오프), 4xx 는 다시 받지 않는다', async () => {
  const net = fakeNetwork({
    'https://flaky.example/rss': n => (n < 3 ? { ok: false, status: 503, text: async () => '' } : { ok: true, status: 200, text: async () => rss('F', 1) }),
    'https://gone.example/rss': 404,
    'https://reset.example/rss': 'reset',
  });
  try {
    await withEnv(Object.assign({}, FAST, { NEWS_RETRY_MS: '40' }), async () => {
      expect(await fn.download('https://flaky.example/rss')).toContain('<rss');
      const t = net.calls['https://flaky.example/rss'];
      expect(t).toHaveLength(3);
      /* 대기는 40ms·80ms (±25%). PC 가 바쁘면 타이머가 늦게 울릴 수는 있어도 일찍 울리지는 않으므로
         "적어도 이만큼은 기다렸다"로 본다 (두 간격을 서로 비교하면 바쁠 때 뒤집혀 실패한 적이 있다) */
      expect(t[1] - t[0], '첫 대기').toBeGreaterThanOrEqual(28);       // 40 × 0.75 = 30
      expect(t[2] - t[1], '둘째 대기는 두 배').toBeGreaterThanOrEqual(58); // 80 × 0.75 = 60

      await expect(fn.download('https://gone.example/rss')).rejects.toThrow('HTTP 404');
      expect(net.calls['https://gone.example/rss']).toHaveLength(1);

      await expect(fn.download('https://reset.example/rss')).rejects.toThrow('fetch failed');
      expect(net.calls['https://reset.example/rss']).toHaveLength(3);
    });
  } finally { net.restore(); }
});

test('출처가 모두 실패한 칸은 지난번 정상 데이터로 채운다 — 6시간 넘게 지난 데이터는 쓰지 않는다', async () => {
  const net = fakeNetwork({
    'https://a.example/rss': rss('A', 2), 'https://slow.example/rss': rss('S', 1),
    'https://e500.example/rss': 500, 'https://html.example/rss': 502,       // 경제 칸 출처가 모두 실패
    'https://b.example/rss': rss('B', 1),
  });
  const prevArticle = { id: 'econ-old-1', category: 'econ', source: '지난번', title: '지난번 경제 기사', summary: '',
    points: [], keywords: [], url: 'https://example.com/old/1', importance: 3, publishedAt: new Date(NOW - 3600000).toISOString() };
  try {
    await withEnv(FAST, async () => {
      const fresh = { generatedAt: new Date(NOW - 10 * 60000).toISOString(), articles: [prevArticle] };
      const r1 = await fn.collect({ feeds: FEEDS, previous: fresh });
      expect(r1.report.carried_over).toEqual(['econ']);
      expect(r1.payload.articles.filter(a => a.category === 'econ').map(a => a.id)).toEqual(['econ-old-1']);

      const stale = { generatedAt: new Date(NOW - 7 * 3600000).toISOString(), articles: [prevArticle] };
      const r2 = await fn.collect({ feeds: FEEDS, previous: stale });
      expect(r2.report.carried_over).toEqual([]);
      expect(r2.payload.articles.filter(a => a.category === 'econ')).toHaveLength(0);
    });
  } finally { net.restore(); }
});

/** 시험용 폴더에 "기존 정상 데이터"를 깔아 둔다 */
function seedDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsalimi-'));
  fs.writeFileSync(path.join(dir, 'news.js'), '/* 기존 정상 데이터 */', 'utf8');
  fs.writeFileSync(path.join(dir, 'status.json'), '{"last_success_at":"기존"}', 'utf8');
  return dir;
}
const snapshot = dir => fs.readdirSync(dir).sort().map(f => f + '=' + fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');

test('모든 출처가 실패하면 예외로 끝나고, 기존 데이터와 heartbeat 를 건드리지 않는다', async () => {
  const dir = seedDir();
  const before = snapshot(dir);
  await withEnv(FAST, async () => {
    await expect(fn.run({ outDir: dir, fetchText: async () => { throw new Error('fetch failed'); }, log: () => {} }))
      .rejects.toThrow('기사를 하나도 못 받았다');
  });
  expect(snapshot(dir)).toBe(before);
});

test('검증에 실패하면 기존 파일을 바꾸지 않고 임시 파일도 남기지 않는다 (검증 → 임시 파일 → 교체)', () => {
  const dir = seedDir();
  const before = snapshot(dir);
  const a = { id: 'dup', category: 'it', source: 's', title: 't', summary: '', points: [], keywords: [],
    url: 'https://e.com/1', importance: 1, publishedAt: new Date(NOW).toISOString() };
  const broken = { payload: { isMock: false, generatedAt: new Date(NOW).toISOString(), categories: fn.CATEGORIES, articles: [a, Object.assign({}, a)] },
    report: { sources_failed: 0 } };
  expect(() => fn.writeOutputs(broken, { outDir: dir })).toThrow('검증 실패: id');
  expect(snapshot(dir)).toBe(before);
});

/* ---------- 수집기 프로세스 통째로 (명령으로 실행) — 네트워크는 --require 로 바꿔 끼운다 ---------- */

function runCli(dir, env) {
  const stub = path.join(dir, '..', path.basename(dir) + '-net.js');
  fs.writeFileSync(stub, 'global.fetch = async () => ({ ok: true, status: 200, text: async () => ' +
    JSON.stringify(rss('CLI', 2)) + ' });\n', 'utf8');
  const clean = Object.assign({}, process.env);
  ['NEWS_PREVIOUS_URL', 'GITHUB_OUTPUT', 'NEWS_FAULT'].forEach(k => delete clean[k]);
  return spawnSync(process.execPath, ['--require', stub, path.join(__dirname, '..', 'scripts', 'fetch-news.js')], {
    env: Object.assign(clean, FAST, { NEWS_OUT_DIR: dir, GITHUB_RUN_ID: '424242', GITHUB_RUN_ATTEMPT: '1' }, env),
    encoding: 'utf8', timeout: 30000,
  });
}

test('수집기 프로세스가 쓰기 직전에 죽어도(예외) 기존 데이터가 그대로이고 종료 코드는 1이다', () => {
  const dir = seedDir();
  const before = snapshot(dir);
  const r = runCli(dir, { NEWS_FAULT: 'crash-before-write' });
  expect(r.status, r.stderr).toBe(1);
  expect(r.stderr).toContain('시험용 장애');
  expect(snapshot(dir)).toBe(before);
});

test('heartbeat: 수집이 끝나면 성공 시각·run id·출처 성공/실패 수·기사 수를 남기고, 새 뉴스가 없어도 갱신한다', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsalimi-'));
  const r1 = runCli(dir, {});
  expect(r1.status, r1.stderr).toBe(0);
  const hb1 = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  expect(hb1).toMatchObject({ run_id: '424242', run_attempt: 1, status: 'HEALTHY', sources_failed: 0, sources_ok: fn.FEEDS.length });
  expect(hb1.articles).toBeGreaterThan(0);
  expect(hb1.new_articles).toBe(hb1.articles);                       // 처음이니 전부 새 기사
  expect(fn.readNewsJs(fs.readFileSync(path.join(dir, 'news.js'), 'utf8')).articles).toHaveLength(hb1.articles);

  /* 같은 기사만 다시 오면 "새 뉴스 없음"이지 장애가 아니다 — heartbeat 는 갱신된다 */
  const r2 = runCli(dir, {});
  expect(r2.status, r2.stderr).toBe(0);
  const hb2 = JSON.parse(fs.readFileSync(path.join(dir, 'status.json'), 'utf8'));
  expect(hb2.new_articles).toBe(0);
  expect(Date.parse(hb2.last_success_at)).toBeGreaterThan(Date.parse(hb1.last_success_at));
  expect(fs.readdirSync(dir).filter(f => f.includes('.tmp-'))).toEqual([]);
});
