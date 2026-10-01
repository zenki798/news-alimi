const { test, expect } = require('@playwright/test');
const { open, setView, shownCount, logicalCount } = require('./helpers');

/*
 * 이 파일의 목적은 "스크롤이 길어지지 않는지"를 지키는 것이다.
 *
 * 기사가 늘어나면 목록을 그냥 다 뿌리는 화면은 순식간에 10화면을 넘어간다.
 * 한눈에 보자는 취지와 정면으로 어긋나므로, 다음 두 장치를 테스트로 못 박는다.
 *  1. 대시보드는 칼럼당 표시 건수를 제한한다.
 *  2. 카드·간결 보기는 처음에 PAGE 건만 그리고 더보기로 늘린다.
 *
 * 기사 수가 늘어도 깨지지 않도록, 실제 기사를 대량으로 주입해서 확인한다.
 */

/** 기사를 n건으로 불려서 다시 그린다 (데이터 계층을 건드리지 않고 화면만 시험)
 *  카테고리를 돌아가며 고르게 복제한다. 실제 수집본은 분야별 건수가 크게 치우칠 수 있어서
 *  (예: IT 1건, 나머지 14건씩) 그대로 복제하면 100건으로 불려도 작은 칼럼이 상한까지 차지 않는다.
 *  복제본은 원본보다 하루씩 오래된 것으로 둔다. 발행 시각이 같으면 1000건일 때 칼럼 맨 위가
 *  "가장 최신 기사의 복제본들"로 바뀌어, 기사 수가 아니라 제목 길이 차이로 높이가 달라진다. */
async function inflate(page, n) {
  await page.evaluate((count) => {
    const byCat = {};
    window.NewsData.articles.forEach(a => (byCat[a.category] = byCat[a.category] || []).push(a));
    const keys = Object.keys(byCat);
    const out = [];
    for (let i = 0; out.length < count; i++) {
      const list = byCat[keys[i % keys.length]];
      const j = Math.floor(i / keys.length);
      const a = list[j % list.length];
      const pass = Math.floor(j / list.length);   // 0 이면 원본 그대로, 1 부터 복제본
      const copy = Object.assign({}, a, { id: a.id + '-x' + i });
      if (pass > 0) copy.publishedAt = new Date(new Date(a.publishedAt).getTime() - pass * 86400000).toISOString();
      out.push(copy);
    }
    window.NewsData.articles = out;
    window.__app.render();
  }, n);
}

test.describe('스크롤 길이 제어', () => {
  test('대시보드는 칼럼당 표시 건수를 지킨다', async ({ page }) => {
    await open(page);
    await inflate(page, 300);

    const per = await page.evaluate(() => window.__app.state.perCat);
    /* 주요 속보 띠(.wide)는 칼럼당 건수가 아니라 자기 상한(5·3건)을 따른다 — 아래 '주요 속보 띠' 에서 본다 */
    const cols = page.locator('.col:not(.wide)');
    const n = await cols.count();
    expect(n).toBeGreaterThan(0);

    for (let i = 0; i < n; i++) {
      const items = await cols.nth(i).locator('li[data-id]').count();
      expect(items, (i + 1) + '번째 칼럼이 칼럼당 제한을 넘었다').toBeLessThanOrEqual(per);
    }
  });

  test('대시보드 높이가 기사 수에 비례해 늘지 않는다', async ({ page }) => {
    /*
     * 이게 이 화면의 핵심 성질이다. 절대 높이는 화면 폭에 따라 달라지지만
     * (좁은 화면에서는 칼럼이 세로로 쌓인다), 기사가 24건이든 300건이든
     * 높이는 거의 같아야 한다. 늘어난다면 표시 제한이 새는 것이다.
     */
    await open(page);

    /* 먼저 모든 칼럼이 상한까지 차도록 충분히 불린다.
     * 견본 24건에서는 일부 카테고리가 상한보다 적어 칼럼이 짧다. 거기서 재면
     * "칼럼이 상한까지 채워지는 정상 동작"까지 증가로 잡혀 버린다. */
    await inflate(page, 100);
    const filled = await page.evaluate(() => document.body.scrollHeight);

    /* 여기서 10배로 늘려도 높이는 그대로여야 한다 */
    await inflate(page, 1000);
    const flooded = await page.evaluate(() => document.body.scrollHeight);

    /* 5% 여유를 두는 이유: 기사 수가 늘면 "+96건 더 보기" 가 "+996건 더 보기" 로
     * 길어져서, 좁은 칼럼에서 버튼 글자가 한 줄 더 감길 수 있다. 목록 자체가
     * 늘어나는 것과는 성격이 다르므로 이 정도는 허용한다. */
    expect(flooded, '100건 ' + filled + 'px → 1000건 ' + flooded + 'px')
      .toBeLessThan(filled * 1.05);
  });

  test('넓은 화면에서는 대시보드가 두 화면을 넘지 않는다', async ({ page }) => {
    const vw = page.viewportSize().width;
    test.skip(vw < 700, '좁은 화면은 칼럼이 세로로 쌓이므로 절대 높이 기준을 적용하지 않는다');

    await open(page);
    await inflate(page, 300);

    const vh = page.viewportSize().height;
    const h = await page.evaluate(() => document.body.scrollHeight);
    expect(h, '본문 높이 ' + h + 'px, 화면 ' + vh + 'px').toBeLessThan(vh * 2);
  });

  test('칼럼당 건수를 바꾸면 실제로 반영된다', async ({ page }) => {
    await open(page);
    await inflate(page, 300);

    await page.locator('#perCat').selectOption('3');
    let max = await page.evaluate(() =>
      Math.max.apply(null, Array.from(document.querySelectorAll('.col:not(.wide)'))
        .map(c => c.querySelectorAll('li[data-id]').length)));
    expect(max).toBe(3);

    await page.locator('#perCat').selectOption('10');
    max = await page.evaluate(() =>
      Math.max.apply(null, Array.from(document.querySelectorAll('.col:not(.wide)'))
        .map(c => c.querySelectorAll('li[data-id]').length)));
    expect(max).toBe(10);
  });

  test('카드 보기는 처음에 한 페이지만 그리고 더보기로 늘린다', async ({ page }) => {
    await open(page);
    await inflate(page, 300);
    await setView(page, 'card');

    const PAGE = await page.evaluate(() => window.__app.PAGE);

    expect(await shownCount(page)).toBe(PAGE);
    await expect(page.locator('#btnMore')).toBeVisible();
    await expect(page.locator('#btnMore')).toContainText('더 보기');

    await page.locator('#btnMore').click();
    expect(await shownCount(page)).toBe(PAGE * 2);

    // 논리 건수는 그대로 300건이어야 한다 (표시만 제한된 것)
    expect(await logicalCount(page)).toBe(300);
    await expect(page.locator('#count')).toHaveText('300');
  });

  test('간결 보기도 표시 제한을 받는다', async ({ page }) => {
    await open(page);
    await inflate(page, 300);
    await setView(page, 'compact');

    const PAGE = await page.evaluate(() => window.__app.PAGE);
    expect(await shownCount(page)).toBe(PAGE);
    await expect(page.locator('#btnMore')).toBeVisible();
  });

  test('전부 표시된 상태면 더보기 버튼이 사라진다', async ({ page }) => {
    await open(page);
    await setView(page, 'compact');

    const total = await logicalCount(page);
    const PAGE = await page.evaluate(() => window.__app.PAGE);

    // 견본 데이터는 PAGE 보다 많으므로 처음엔 버튼이 보인다
    expect(total).toBeGreaterThan(PAGE);
    await expect(page.locator('#btnMore')).toBeVisible();

    // 끝까지 누르면 사라진다. 누를 횟수는 실제 건수로 정한다 (10개 분야 × 14건이면 열 번으로 모자란다)
    for (let i = 0; i < Math.ceil(total / PAGE); i++) {
      if (await page.locator('#btnMore').isHidden()) break;
      await page.locator('#btnMore').click();
    }
    await expect(page.locator('#btnMore')).toBeHidden();
    expect(await shownCount(page)).toBe(total);
  });

  test('검색이나 카테고리를 바꾸면 표시 건수가 처음으로 돌아간다', async ({ page }) => {
    await open(page);
    await inflate(page, 300);
    await setView(page, 'card');

    const PAGE = await page.evaluate(() => window.__app.PAGE);
    await page.locator('#btnMore').click();
    expect(await shownCount(page)).toBe(PAGE * 2);

    /* 조건을 바꿨는데 늘려둔 표시 건수가 남아 있으면, 좁혔는데도 화면이 길게 남는다 */
    await page.locator('#chips .chip[data-cat="it"]').click();
    expect(await page.evaluate(() => window.__app.state.limit)).toBe(PAGE);
  });
});

/*
 * 예전에는 대시보드 맨 위에 "주요" 칸(분야마다 최신 기사 하나씩)을 두었다. 바로 아래 주요 속보 띠와
 * 빨간 상자 둘이 붙어 시선이 갈리고, 내용도 각 칸 맨 위 기사와 겹쳐서 없앴다(2026-10-01).
 * 이제 맨 위에서 눈을 끄는 것은 속보 띠 하나이고, 띠가 길어져 분야 칸을 밀어내지 않게 상한을 둔다.
 */
test.describe('주요 속보 띠', () => {
  test('빨간 상자는 속보 띠 하나뿐이다 — "주요" 칸·딱지를 따로 두지 않는다', async ({ page }) => {
    await open(page);

    await expect(page.locator('#headline')).toHaveCount(0);
    /* 맨 위 줄은 속보 띠와 많이 찾는 뉴스(번호 목록, 빨간색 아님) 둘뿐이고, 빨간 띠는 하나다 */
    await expect(page.locator('#list .toprow .col')).toHaveCount(2);
    await expect(page.locator('#list .col.wide:not(.rank)')).toHaveCount(1);
    await expect(page.locator('#list .col').first()).toHaveClass(/wide/);

    /* 카드 보기의 "주요" 딱지도 같은 규칙(분야마다 최신 기사)에서 나와 속보와 헷갈렸다 */
    await setView(page, 'card');
    await expect(page.locator('.card').first()).toBeVisible();
    await expect(page.locator('.card .hot')).toHaveCount(0);
  });

  test('띠는 칼럼당 건수와 상관없이 넓은 화면 5건·좁은 화면 3건까지만 보인다', async ({ page }) => {
    await open(page);
    await inflate(page, 300);
    const want = page.viewportSize().width <= 560 ? 3 : 5;

    for (const [per, key] of [['3', 'breaking'], ['10', 'breaking'], ['3', 'popular'], ['10', 'popular']]) {
      await page.locator('#perCat').selectOption(per);
      const band = page.locator('#list .col.wide[data-col="' + key + '"]');
      await expect(band.locator('li[data-id]'), key + ', 칼럼당 ' + per + '건일 때').toHaveCount(want);
      /* 다 못 보인 만큼 "더 보기" 로 넘긴다 */
      const total = Number(await band.locator('header .n').textContent());
      await expect(band.locator('.more')).toHaveText('+' + (total - want) + '건 더 보기');
    }
  });

  test('띠의 긴 제목은 두 줄까지만 보인다 (한 건 때문에 띠 전체가 높아지지 않게)', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const top = window.__app.base().filter(a => a.category === 'breaking')
        .sort((x, y) => new Date(y.publishedAt) - new Date(x.publishedAt))[0];
      top.title = '[속보] ' + '아주 긴 속보 제목이 이어진다 '.repeat(20);
      window.__app.render();
    });
    const h = await page.locator('#list .col.wide[data-col="breaking"] li a').first().evaluate(el => {
      const s = getComputedStyle(el);
      return { height: el.getBoundingClientRect().height, line: parseFloat(s.lineHeight) };
    });
    expect(h.height, JSON.stringify(h)).toBeLessThanOrEqual(h.line * 2 + 2);
  });
});
