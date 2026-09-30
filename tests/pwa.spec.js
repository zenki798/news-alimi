// 앱(PWA) 설치 — 홈 화면에 추가하면 주소창·툴바 없이 뜨는지, 앱 안에서 뉴스를 다시 받을 수 있는지
// (배포에 앱 파일이 들어가는지는 workflows.spec.js 에서 본다)
const { test, expect } = require('@playwright/test');
const { open, waitReady, setView } = require('./helpers');

async function openApp(page) {
  await page.goto('/?source=pwa');
  await waitReady(page);
}

/** 새로고침 때 내려줄 가짜 수집 결과. 기존 카테고리는 그대로 두고 기사만 바꾼다. */
function freshNewsJs(title) {
  return `(function (g) {
    var d = {
      isMock: false,
      generatedAt: new Date().toISOString(),
      categories: g.NewsData.categories,
      articles: [{
        id: 'fresh-1', category: g.NewsData.categories[0].key, source: '테스트출처',
        title: ${JSON.stringify(title)}, summary: '새로고침 확인용 기사', points: [], keywords: ['테스트'],
        url: 'https://example.com/fresh', importance: 3, publishedAt: new Date().toISOString()
      }]
    };
    d.category = function (k) { return d.categories.filter(function (c) { return c.key === k; })[0] || null; };
    g.NewsData = d;
  })(window);`;
}

test('manifest: 단독 실행(standalone), 시작 주소·범위, 아이콘 3종(일반 192·512, 마스커블)', async ({ request }) => {
  const res = await request.get('/manifest.webmanifest');
  expect(res.ok()).toBe(true);
  expect(res.headers()['content-type']).toContain('application/manifest+json');
  const m = await res.json();
  expect(m.display).toBe('standalone');
  expect(m.start_url).toBe('./?source=pwa');
  expect(m.scope).toBe('./');
  expect(m.name).toBeTruthy();
  expect(m.short_name.length).toBeLessThanOrEqual(12); // 홈 화면 아이콘 아래 잘리지 않게
  expect(m.background_color).toBe('#0f1319');         // 앱이 뜰 때 흰 화면이 번쩍이지 않게 화면 배경과 같게
  const has = (size, purpose) => m.icons.some(i => i.sizes === size && i.type === 'image/png' && (i.purpose || 'any').includes(purpose));
  expect(has('192x192', 'any')).toBe(true);
  expect(has('512x512', 'any')).toBe(true);
  expect(has('512x512', 'maskable')).toBe(true);
});

test('아이콘 파일이 실제로 있고 적힌 크기와 같다 (apple-touch-icon 포함)', async ({ page }) => {
  await open(page);
  const sizes = await page.evaluate(async () => {
    const m = await (await fetch('manifest.webmanifest')).json();
    const list = m.icons.map(i => ({ src: i.src, want: Number(i.sizes.split('x')[0]) }))
      .concat({ src: document.querySelector('link[rel="apple-touch-icon"]').getAttribute('href'), want: 180 });
    return Promise.all(list.map(({ src, want }) => new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve({ src, want, w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => resolve({ src, want, w: 0, h: 0 });
      img.src = src;
    })));
  });
  for (const s of sizes) expect(s, s.src).toMatchObject({ w: s.want, h: s.want });
});

test('크롬이 설치 가능한 앱으로 인정한다 (설치 불가 사유 0건)', async ({ page }) => {
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(e.message));
  await open(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  const cdp = await page.context().newCDPSession(page);
  const manifest = await cdp.send('Page.getAppManifest');
  expect(manifest.errors).toEqual([]);
  await expect.poll(async () => (await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, { timeout: 10000 })
    .toEqual([]);
  expect(errors).toEqual([]);
});

test('한 번 연 뒤에는 인터넷이 끊겨도 마지막으로 받은 뉴스가 뜬다 (서비스 워커 캐시)', async ({ page, context }) => {
  await openApp(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();                                   // 서비스 워커가 페이지를 맡은 상태로
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  const total = await page.evaluate(() => window.NewsData.articles.length);

  await context.setOffline(true);
  await page.goto('/?source=pwa');
  await waitReady(page);
  await expect(page.locator('#totalCount')).toHaveText(String(total));
  expect(await page.evaluate(() => window.NewsData.isMock)).toBe(false);   // 목업이 아니라 수집 결과
  await context.setOffline(false);
});

test('새로고침으로 ?t= 를 붙여 받아도 캐시 항목이 쌓이지 않는다', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);
  for (let i = 0; i < 3; i++) await page.evaluate(() => window.__app.refreshData());
  const keys = await page.evaluate(async () => {
    const c = await caches.open((await caches.keys())[0]);
    return (await c.keys()).map(r => r.url).filter(u => u.includes('news.js'));
  });
  expect(keys.every(u => !u.includes('?'))).toBe(true);
  expect(keys.filter(u => u.endsWith('/data/news.js'))).toHaveLength(1);
});

test('노치 대응(viewport-fit=cover)·테마 색상·아이폰 앱 설정이 있다', async ({ page }) => {
  await open(page);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/);
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#0f1319');
  await expect(page.locator('meta[name="apple-mobile-web-app-capable"]')).toHaveAttribute('content', 'yes');
  await expect(page.locator('meta[name="apple-mobile-web-app-status-bar-style"]')).toHaveAttribute('content', 'black-translucent');
});

test.describe('앱 모드 (홈 화면에서 실행)', () => {
  // 가짜 수집 결과를 page.route 로 내려주려면 서비스 워커가 가로채지 않아야 한다
  test.use({ serviceWorkers: 'block' });

  test('앱 모드 표시가 붙고, 설치 안내는 숨고 새로고침 버튼이 보인다', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('html')).toHaveClass(/app-mode/);
    await expect(page.locator('#install-bar')).toBeHidden();
    await expect(page.locator('#btnRefresh')).toBeVisible();
  });

  test('브라우저로 볼 때는 새로고침 버튼이 없다 (브라우저 버튼을 쓴다)', async ({ page }) => {
    await open(page);
    await expect(page.locator('html')).not.toHaveClass(/app-mode/);
    await expect(page.locator('#btnRefresh')).toBeHidden();
  });

  test('새로고침을 누르면 새 뉴스를 받고, 검색어·보기 방식은 그대로 남는다', async ({ page }) => {
    await openApp(page);
    await setView(page, 'compact');
    await page.fill('#q', '테스트');

    await page.route(/\/data\/news\.js\?t=\d+$/, r =>
      r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: freshNewsJs('방금 들어온 테스트 기사') }));
    await page.click('#btnRefresh');

    await expect(page.locator('#list [data-id="fresh-1"]')).toContainText('방금 들어온 테스트 기사');
    await expect(page.locator('#totalCount')).toHaveText('1');
    await expect(page.locator('#updated')).toHaveText('방금 수집');
    await expect(page.locator('#q')).toHaveValue('테스트');
    expect(await page.evaluate(() => window.__app.state.view)).toBe('compact');
    await expect(page.locator('#btnRefresh')).toHaveText('새로고침');
  });

  test('연결이 안 되면 알리고, 보던 뉴스는 그대로 둔다', async ({ page }) => {
    await openApp(page);
    const total = await page.locator('#totalCount').textContent();
    await page.route(/\/data\/news\.js\?t=\d+$/, r => r.abort());
    await page.click('#btnRefresh');
    await expect(page.locator('#btnRefresh')).toHaveText('연결 안 됨 · 다시 시도');
    await expect(page.locator('#totalCount')).toHaveText(total);
  });

  test('앱으로 10분 넘게 지나 돌아오면 저절로 새 뉴스를 받는다 (브라우저 탭에서는 안 받는다)', async ({ page }) => {
    let hits = 0;
    await page.route(/\/data\/news\.js\?t=\d+$/, r => {
      hits++;
      r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: freshNewsJs('돌아오니 들어와 있는 기사') });
    });
    const comeBack = async () => {
      await page.clock.fastForward('11:00');
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    };

    await page.clock.install();
    await open(page);                 // 브라우저 탭
    await comeBack();
    await page.waitForTimeout(300);
    expect(hits).toBe(0);

    await openApp(page);              // 앱
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForTimeout(300);
    expect(hits).toBe(0);             // 방금 열었으면 다시 받지 않는다
    await comeBack();
    await expect(page.locator('#list')).toContainText('돌아오니 들어와 있는 기사');
    expect(hits).toBe(1);
  });
});

test.describe('설치 안내 (브라우저로 볼 때)', () => {
  const fire = page => page.evaluate(() => {
    const e = new Event('beforeinstallprompt', { cancelable: true });
    e.prompt = () => { window.__prompted = true; };
    e.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(e);
  });

  test('안드로이드 크롬: 설치 가능 신호가 오면 "앱으로 설치" 버튼을 보이고, 누르면 설치 창을 띄운다', async ({ page }) => {
    await open(page);
    await expect(page.locator('#install-bar')).toBeHidden();
    await fire(page);
    await expect(page.locator('#install-bar')).toBeVisible();
    await page.click('#install-btn');
    expect(await page.evaluate(() => window.__prompted)).toBe(true);
    await expect(page.locator('#install-bar')).toBeHidden();
  });

  test('닫기를 누르면 다음에 다시 열어도 안내하지 않는다', async ({ page }) => {
    await open(page);
    await fire(page);
    await page.click('#install-close');
    await page.reload();
    await waitReady(page);
    await fire(page);
    await expect(page.locator('#install-bar')).toBeHidden();
  });

  test('앱 모드에서는 설치 신호가 와도 안내하지 않는다', async ({ page }) => {
    await openApp(page);
    await fire(page);
    await expect(page.locator('#install-bar')).toBeHidden();
  });
});
