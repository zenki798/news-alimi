// 열어 둔 화면에서 새 뉴스 자동 확인 — 속보가 저절로 들어오되 휴대폰 배터리를 닳게 하지 않는다 (AGENTS.md 5항)
//
// 서버(GitHub Pages)를 page.route 로 흉내 낸다. HEAD 에는 ETag·Last-Modified 만, GET 에는 뉴스를 준다.
// 시계는 page.clock 으로 돌린다 — 30분을 몇 초 만에 지나가며 몇 번 물었는지 센다.
const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');
const { waitReady } = require('./helpers');

// 가짜 서버 응답을 page.route 로 내려주려면 서비스 워커가 가로채지 않아야 한다
test.use({ serviceWorkers: 'block' });

const T0 = Date.parse('2026-10-01T03:00:00Z');   // 시험용 "지금"
const MIN = 60 * 1000;

/** 가짜 사이트. publish() 로 새 수집을 올린다. heads·gets 는 받은 요청 수 */
async function fakeSite(page) {
  const srv = {
    v: 1, gen: T0 - MIN, extra: [], heads: 0, gets: 0,
    publish(at, items) { this.v++; this.gen = at; this.extra = items.concat(this.extra); },
  };
  const js = () => {
    const at = iso => JSON.stringify(new Date(iso).toISOString());
    const art = (id, category, title, t) =>
      `{ id: ${JSON.stringify(id)}, category: ${JSON.stringify(category)}, source: '테스트통신', title: ${JSON.stringify(title)},` +
      ` summary: '', points: [], keywords: [], url: 'https://example.com/${id}', importance: 1, publishedAt: ${at(t)} }`;
    const list = srv.extra.map(x => art(x.id, 'breaking', x.title, srv.gen))
      .concat(art('brk-old', 'breaking', '[속보] 아까 들어온 속보', T0 - 30 * MIN), art('it-1', 'it', 'IT 기사', T0 - 20 * MIN));
    return `(function (g) {
      var d = { isMock: false, generatedAt: ${at(srv.gen)},
        categories: [{ key: 'breaking', name: '주요 속보', color: '#ff4b4b', wide: true },
                     { key: 'it', name: 'IT·개발·AI', color: '#5b9cff' }],
        articles: [${list.join(',')}] };
      d.category = function (k) { return d.categories.filter(function (c) { return c.key === k; })[0] || null; };
      g.NewsData = d;
    })(window);`;
  };
  await page.route(/\/data\/news\.js(\?t=\d+)?$/, route => {
    const req = route.request();
    /* Pages 는 올린 시각을 Last-Modified 로 준다. 수집하고 20초 뒤에 올라간 것으로 친다 */
    const headers = { etag: '"v' + srv.v + '"', 'last-modified': new Date(srv.gen + 20000).toUTCString() };
    if (req.method() === 'HEAD') { srv.heads++; return route.fulfill({ status: 200, headers, body: '' }); }
    if (/\?t=/.test(req.url())) srv.gets++;
    return route.fulfill({ status: 200, headers: Object.assign({ 'content-type': 'text/javascript; charset=utf-8' }, headers), body: js() });
  });
  return srv;
}

async function openAt(page) {
  const srv = await fakeSite(page);
  await page.clock.install({ time: T0 });
  await page.goto('/');
  await waitReady(page);
  /* 설치한 시계는 실제 시간만큼 흐르므로, 여는 데 걸린 시간을 넉넉히 넘겨 멈춘다 */
  await page.clock.pauseAt(T0 + 5000);
  return srv;
}

/** 1분씩 n번 시계를 넘긴다. 확인 요청(HEAD)은 진짜 비동기라 매번 잠깐 기다린다 */
async function minutes(page, n) {
  for (let i = 0; i < n; i++) {
    await page.clock.fastForward('01:00');
    await page.waitForTimeout(40);
  }
}

/** 화면을 숨기거나(다른 앱·탭, 화면 꺼짐) 다시 보이게 한다 */
async function setVisible(page, visible) {
  await page.evaluate(v => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (v ? 'visible' : 'hidden') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visible);
}

test('다음 수집이 끝났을 즈음 "바뀌었나"만 묻고, 바뀌었으면 받아서 새 속보에 "새" 표시를 붙인다', async ({ page }) => {
  const srv = await openAt(page);

  /* 4분 뒤 서버에 새 수집이 올라온다. 화면은 수집 시각 + 5분 30초(지금으로부터 4분 30초) 즈음에 묻는다 */
  srv.publish(T0 + 4 * MIN, [{ id: 'brk-new', title: '[속보] 방금 들어온 속보' }]);
  await minutes(page, 4);
  expect(srv.heads, '아직 물을 때가 아니다').toBe(0);
  await minutes(page, 1);

  await expect.poll(() => srv.gets).toBe(1);
  expect(srv.heads).toBe(1);
  const item = page.locator('#list .col.wide li[data-id="brk-new"]');
  await expect(item).toBeVisible();
  await expect(item.locator('.new')).toHaveText('새');
  await expect(page.locator('#list .col.wide li[data-id="brk-old"] .new')).toHaveCount(0);   // 원래 있던 것엔 안 붙는다

  /* 배터리: 끝없이 도는 애니메이션이 없다 (화면을 계속 다시 그리지 않는다) */
  const infinite = await page.evaluate(() => document.getAnimations()
    .filter(a => a.effect && a.effect.getComputedTiming().iterations === Infinity).length);
  expect(infinite).toBe(0);

  /* "새" 표시는 10분이 지나면 다음에 그릴 때 빠진다 */
  await page.clock.fastForward('11:00');
  await page.evaluate(() => window.__app.render());
  await expect(item.locator('.new')).toHaveCount(0);
});

test('바뀐 게 없으면 받지도 다시 그리지도 않고, 묻는 간격을 1·2·4·5분으로 늘린다', async ({ page }) => {
  const srv = await openAt(page);
  await page.evaluate(() => { document.querySelector('#list li[data-id]').dataset.mark = 'keep'; });

  await minutes(page, 30);

  /* 30분 동안 5분 간격이면 6번, 1분 간격이면 30번이다. 늘려 가며 물으니 그 사이 */
  expect(srv.heads, '30분 동안 물은 횟수').toBeGreaterThanOrEqual(5);
  expect(srv.heads, '30분 동안 물은 횟수').toBeLessThanOrEqual(8);
  expect(srv.gets, '바뀐 게 없는데 뉴스를 받았다').toBe(0);
  expect(await page.evaluate(() => document.querySelector('#list li[data-id]').dataset.mark),
    '바뀐 게 없는데 화면을 다시 그렸다').toBe('keep');
});

test('화면이 안 보이면 묻지 않고, 다시 보이면 바로 묻는다', async ({ page }) => {
  const srv = await openAt(page);
  srv.publish(T0 + 2 * MIN, [{ id: 'brk-away', title: '[속보] 안 보는 사이 들어온 속보' }]);

  await setVisible(page, false);
  await minutes(page, 30);
  expect(srv.heads, '안 보이는 동안 물었다').toBe(0);

  await setVisible(page, true);
  await page.clock.runFor(100);
  await expect.poll(() => srv.heads).toBe(1);
  await expect(page.locator('#list .col.wide li[data-id="brk-away"] .new')).toHaveText('새');
});

test('인터넷이 끊기면 묻지 않고, 다시 연결되면 묻는다', async ({ page, context }) => {
  const srv = await openAt(page);
  const before = await page.evaluate(() => window.__app.watch.lastCheck);

  await context.setOffline(true);
  await minutes(page, 10);
  expect(await page.evaluate(() => window.__app.watch.lastCheck), '끊긴 동안 묻으려 했다').toBe(before);

  await context.setOffline(false);
  await page.clock.runFor(100);
  await expect.poll(() => srv.heads).toBe(1);
});

test('file:// 로 열면 물을 서버가 없으므로 자동 확인을 하지 않는다', async ({ page }) => {
  await page.goto(pathToFileURL(path.resolve(__dirname, '..', 'index.html')).href);
  await waitReady(page);
  expect(await page.evaluate(() => ({ watch: window.__app.WATCH, timer: window.__app.watch.timer })))
    .toEqual({ watch: false, timer: null });
});
