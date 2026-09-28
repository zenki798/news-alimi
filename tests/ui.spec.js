const { test, expect } = require('@playwright/test');
const { open, setView, shownCount, logicalCount, chipCount } = require('./helpers');

test.describe('화면과 조작', () => {
  test('콘솔 에러 없이 뜨고 기사가 그려진다', async ({ page }) => {
    const errors = [];
    page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', e => errors.push(e.message));

    await open(page);

    await expect(page.locator('h1')).toContainText('뉴스알리미');
    expect(await shownCount(page)).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test('견본 데이터일 때 실제 뉴스가 아니라고 알린다', async ({ page }) => {
    await open(page);

    const isMock = await page.evaluate(() => window.NewsData.isMock);
    if (isMock) {
      await expect(page.locator('#mockBanner')).toBeVisible();
      await expect(page.locator('#mockBanner')).toContainText('실제 뉴스가 아닙니다');
    } else {
      await expect(page.locator('#mockBanner')).toBeHidden();
    }
  });

  test('오늘 날짜와 건수가 표시된다', async ({ page }) => {
    await open(page);

    await expect(page.locator('#today')).not.toBeEmpty();
    const total = await page.evaluate(() => window.NewsData.articles.length);
    await expect(page.locator('#totalCount')).toHaveText(String(total));
    await expect(page.locator('#count')).toHaveText(String(total));   // 처음엔 전부 대상
  });

  test('카테고리 칩이 전체 + 모든 카테고리만큼 그려진다', async ({ page }) => {
    await open(page);

    const catCount = await page.evaluate(() => window.NewsData.categories.length);
    await expect(page.locator('#chips .chip')).toHaveCount(catCount + 1);
    await expect(page.locator('#chips .chip[data-cat="all"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('칩을 누르면 해당 카테고리만 남고 배지 숫자와 일치한다', async ({ page }) => {
    await open(page);
    await setView(page, 'card');

    const cats = await page.evaluate(() => window.NewsData.categories.map(c => c.key));
    for (const key of cats) {
      await page.locator('#chips .chip[data-cat="' + key + '"]').click();

      const badge = await chipCount(page, key);
      expect(await logicalCount(page), key + ' 의 논리 건수가 배지와 다르다').toBe(badge);
      await expect(page.locator('#count')).toHaveText(String(badge));

      const allSame = await page.evaluate((k) => {
        const ids = Array.from(document.querySelectorAll('#list [data-id]')).map(el => el.dataset.id);
        return ids.length > 0 && ids.every(id =>
          window.NewsData.articles.find(a => a.id === id).category === k);
      }, key);
      expect(allSame, key + ' 외의 카테고리가 섞였거나 비었다').toBe(true);
    }
  });

  test('검색이 제목·요약·키워드에서 걸린다', async ({ page }) => {
    await open(page);
    await setView(page, 'compact');

    const word = await page.evaluate(() => {
      const t = window.NewsData.articles[0].title;
      return t.split(/[\s,·]+/).filter(w => w.length >= 3)[0];
    });

    await page.locator('#q').fill(word);
    expect(await logicalCount(page)).toBeGreaterThan(0);
    expect(await shownCount(page)).toBe(await logicalCount(page));
  });

  test('결과가 없으면 빈 상태를 안내한다', async ({ page }) => {
    await open(page);

    await page.locator('#q').fill('절대로없을단어zzzqqq');
    await expect(page.locator('#empty')).toBeVisible();
    await expect(page.locator('#empty')).toContainText('없습니다');
    await expect(page.locator('#count')).toHaveText('0');
  });

  test('중요도순으로 바꾸면 주요 기사가 앞으로 온다', async ({ page }) => {
    await open(page);
    await page.locator('#sort').selectOption('importance');

    const order = await page.evaluate(() => window.__app.filtered().map(a => a.importance));
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeLessThanOrEqual(order[i - 1]);
    }
    expect(order[0]).toBe(3);
  });

  test('보기 방식 세 가지가 서로 다른 레이아웃을 그린다', async ({ page }) => {
    await open(page);

    await expect(page.locator('#list')).toHaveClass(/dash/);          // 기본값은 대시보드
    await expect(page.locator('#views button[data-view="dashboard"]')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.col').first()).toBeVisible();

    await setView(page, 'card');
    await expect(page.locator('#list')).toHaveClass(/cards/);
    await expect(page.locator('.card').first()).toBeVisible();

    await setView(page, 'compact');
    await expect(page.locator('#list')).toHaveClass(/compact/);
    await expect(page.locator('#list ul li.row').first()).toBeVisible();
  });
});
