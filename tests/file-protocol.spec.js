const path = require('path');
const { pathToFileURL } = require('url');
const { test, expect } = require('@playwright/test');
const { waitReady, shownCount } = require('./helpers');

/*
 * 사용자는 index.html 을 더블클릭해서 연다. 그때 주소는 http:// 가 아니라 file:// 이다.
 * 이 환경에서는 ES 모듈(type="module")이 CORS 로 차단되고, localStorage 도
 * 브라우저 설정에 따라 막힐 수 있다. 로컬 서버로만 테스트하면 이 경로를 못 밟으므로
 * 여기서 따로 검증한다.
 */
const FILE_URL = pathToFileURL(path.resolve(__dirname, '..', 'index.html')).href;

test.describe('file:// 로 직접 열었을 때', () => {
  test('스크립트가 모두 로드되고 기사가 그려진다', async ({ page }) => {
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(FILE_URL);
    await waitReady(page);

    expect(await shownCount(page)).toBeGreaterThan(0);

    /* 목업이든 실제 수집물이든 무엇이 실렸는지는 화면에 밝혀져야 한다 */
    if (await page.evaluate(() => window.NewsData.isMock)) {
      await expect(page.locator('#mockBanner')).toBeVisible();
    } else {
      await expect(page.locator('#updated')).toBeVisible();
    }

    /* 모듈 차단이나 스크립트 로드 실패가 있으면 여기서 걸린다 */
    const fatal = errors.filter(e => /module|CORS|Failed to load|is not defined/i.test(e));
    expect(fatal, 'file:// 에서 스크립트 로드 문제: ' + fatal.join(' | ')).toEqual([]);
  });

  test('필터와 검색이 file:// 에서도 동작한다', async ({ page }) => {
    await page.goto(FILE_URL);
    await waitReady(page);

    const key = await page.evaluate(() => window.NewsData.categories[0].key);
    await page.locator('#chips .chip[data-cat="' + key + '"]').click();
    const shown = await shownCount(page);
    expect(shown).toBeGreaterThan(0);

    await page.locator('#q').fill('절대로없을단어zzzqqq');
    await expect(page.locator('#empty')).toBeVisible();
  });

  test('localStorage 를 못 써도 화면이 죽지 않는다', async ({ page }) => {
    /* 사생활 보호 모드나 사이트 데이터 차단 상황을 흉내낸다 */
    await page.addInitScript(() => {
      const boom = () => { throw new Error('localStorage blocked'); };
      try {
        Object.defineProperty(window, 'localStorage', {
          configurable: true,
          get: boom,
        });
      } catch (e) { /* 정의를 못 바꿔도 테스트는 계속한다 */ }
    });

    const errors = [];
    page.on('pageerror', e => errors.push(e.message));

    await page.goto(FILE_URL);
    await waitReady(page);

    expect(await shownCount(page)).toBeGreaterThan(0);
    expect(errors, '저장소 차단 시 예외가 화면까지 터졌다: ' + errors.join(' | ')).toEqual([]);

    /* 클릭해도 죽지 않아야 한다 (읽음은 저장되지 않지만 화면은 살아있다) */
    await page.locator('#list .col li[data-id] a').first().click();
    expect(await shownCount(page)).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });
});
