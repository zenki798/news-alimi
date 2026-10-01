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

  test('선택한 보기 버튼은 강조 배경이 칠해져 글자가 보인다', async ({ page }) => {
    await open(page);
    for (const view of ['dashboard', 'card', 'compact']) {
      await setView(page, view);
      const bg = await page.locator('#views button[data-view="' + view + '"]').evaluate(el => getComputedStyle(el).backgroundColor);
      expect(bg, view).toBe('rgb(91, 156, 255)');    // --accent. 투명이면 어두운 글자가 바탕에 묻힌다
    }
  });

  test('안내(note)가 있는 칼럼에만 안내 문구가 붙는다 (투자: 투자 권유 아님)', async ({ page }) => {
    await open(page);

    const cats = await page.evaluate(() => window.NewsData.categories.map(c => ({ key: c.key, note: c.note || '' })));
    expect(cats.find(c => c.key === 'invest').note).toContain('투자 권유가 아닙니다');

    for (const c of cats) {
      const note = page.locator('.col[data-col="' + c.key + '"] .note');
      if (c.note) await expect(note, c.key).toHaveText(c.note);
      else await expect(note, c.key).toHaveCount(0);
    }
  });

  test('주요 속보는 대시보드 맨 위에서 한 줄을 통째로 쓴다', async ({ page }) => {
    await open(page);

    const first = page.locator('#list .col').first();
    await expect(first).toHaveAttribute('data-col', 'breaking');
    await expect(first).toHaveClass(/wide/);
    await expect(first.locator('h3')).toHaveText('주요 속보');

    const list = await page.locator('#list').boundingBox();
    const band = await first.boundingBox();
    expect(Math.abs(band.width - list.width), '띠 폭 ' + band.width + ' / 목록 폭 ' + list.width).toBeLessThanOrEqual(2);

    /* 넓은 화면에서는 나머지 10칸이 5칸씩 두 줄로 맞아떨어진다 (11칸이면 마지막 줄에 한 칸만 남는다) */
    if (page.viewportSize().width >= 1200) {
      const tops = await page.locator('#list .col:not(.wide)').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().top)));
      const rows = {};
      tops.forEach(t => { rows[t] = (rows[t] || 0) + 1; });
      expect(Object.values(rows)).toEqual([5, 5]);
    }
  });

  test('주요 스트립에는 주요 속보 기사를 다시 올리지 않는다 (바로 아래 띠에 이미 보인다)', async ({ page }) => {
    await open(page);
    const cats = await page.locator('#headline li').evaluateAll(els =>
      els.map(li => window.NewsData.articles.find(a => a.id === li.dataset.id).category));
    expect(cats.length).toBeGreaterThan(0);
    expect(cats).not.toContain('breaking');
  });

  test('공시 기사는 카드 보기에서 쉬운 풀이가 보인다', async ({ page }) => {
    await open(page);
    await setView(page, 'card');
    await page.locator('#chips .chip[data-cat="invest"]').click();

    /* 공시는 하루 중 늦게 수집되거나 주말이면 없을 수 있다. 그때는 목업과 같은 모양을 하나 넣어 그린다 */
    const id = await page.evaluate(() => {
      let a = window.NewsData.articles.find(x => x.category === 'invest' && /^\[공시\]/.test(x.title));
      if (!a) {
        a = { id: 'test-disclosure', category: 'invest', source: '공시알림(견본)', importance: 1,
          title: '[공시] 견본전자 · 자사주 매입', summary: '', keywords: ['공시'],
          points: ['회사가 자기 회사 주식을 사들이기로 했다는 공시입니다.', '공시명: 자기주식취득결정'],
          url: 'https://example.com/d', publishedAt: new Date().toISOString() };
        window.NewsData.articles.unshift(a);
      }
      /* 카드 보기는 처음 12건만 그린다. 공시가 오전에 나왔으면 그 뒤에 있으므로 다 펼친다 */
      window.__app.state.limit = window.NewsData.articles.length;
      window.__app.render();
      return a.id;
    });

    const card = page.locator('.card[data-id="' + id + '"]');
    await expect(card).toBeVisible();
    await expect(card.locator('.pts li').first()).toContainText('공시');
    await expect(card.locator('.pts li').nth(1)).toContainText('공시명');
  });

  test('주요 뉴스의 시각이 상자 밖으로 삐져나가지 않는다 (긴 제목은 말줄임)', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const a = window.NewsData.articles.find(x => x.importance >= 3);
      a.title = '아주 긴 제목 '.repeat(30);
      window.__app.render();
    });
    const box = await page.locator('#headline').boundingBox();
    const times = page.locator('#headline time');
    const n = await times.count();
    expect(n).toBeGreaterThan(0);
    for (let i = 0; i < n; i++) {
      const t = await times.nth(i).boundingBox();
      expect(t.x + t.width, (i + 1) + '번째 시각').toBeLessThanOrEqual(box.x + box.width);
    }
  });
});
