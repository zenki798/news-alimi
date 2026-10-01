const { test, expect } = require('@playwright/test');
const { open } = require('./helpers');

/*
 * 데이터 계층은 목업(data/mock-news.js) 과 실제 수집물(data/news.js) 두 가지가 들어올 수 있다.
 * 어느 쪽이 실려도 화면 코드가 그대로 동작해야 하므로, 여기서는 "계약"만 검사한다.
 * 수집기가 망가져서 이상한 값이 섞이면 배포 전에 여기서 걸린다.
 */
test.describe('데이터 정합성', () => {
  test.beforeEach(async ({ page }) => { await open(page); });

  test('NewsData 계약을 지킨다', async ({ page }) => {
    const shape = await page.evaluate(() => {
      const d = window.NewsData;
      return {
        hasIsMock: typeof d.isMock === 'boolean',
        hasCategoryFn: typeof d.category === 'function',
        catCount: d.categories.length,
        artCount: d.articles.length,
        catKeysOk: d.categories.every(c => c.key && c.name && /^#[0-9a-f]{6}$/i.test(c.color) &&
          (c.note === undefined || (typeof c.note === 'string' && c.note.length > 0)) &&
          (c.wide === undefined || typeof c.wide === 'boolean')),
      };
    });

    expect(shape.hasIsMock).toBe(true);
    expect(shape.hasCategoryFn).toBe(true);
    expect(shape.catCount).toBeGreaterThan(0);
    expect(shape.artCount).toBeGreaterThan(0);
    expect(shape.catKeysOk).toBe(true);
  });

  test('모든 기사가 필수 항목을 갖추고 있다', async ({ page }) => {
    const bad = await page.evaluate(() => {
      const problems = [];
      const keys = new Set(window.NewsData.categories.map(c => c.key));
      const seen = new Set();

      window.NewsData.articles.forEach((a, i) => {
        const at = 'articles[' + i + '] ' + (a.id || '(id 없음)');
        if (!a.id) problems.push(at + ': id 없음');
        if (seen.has(a.id)) problems.push(at + ': id 중복');
        seen.add(a.id);
        if (!keys.has(a.category)) problems.push(at + ': 알 수 없는 category "' + a.category + '"');
        if (!a.title) problems.push(at + ': title 없음');
        if (!a.source) problems.push(at + ': source 없음');
        /* 요약은 비어 있을 수 있다. 제공하지 않는 피드가 있어서 화면에서 문단을 생략한다.
         * 다만 타입은 문자열이어야 한다. */
        if (typeof a.summary !== 'string') problems.push(at + ': summary 가 문자열이 아님');
        if (!Array.isArray(a.points)) problems.push(at + ': points 가 배열이 아님');
        if (!Array.isArray(a.keywords)) problems.push(at + ': keywords 가 배열이 아님');
        if (!(a.importance >= 1 && a.importance <= 3)) problems.push(at + ': importance 가 1~3 아님');
        if (isNaN(new Date(a.publishedAt).getTime())) problems.push(at + ': publishedAt 파싱 불가');
        if (!/^https?:\/\//.test(a.url || '')) problems.push(at + ': url 형식 이상');
      });
      return problems;
    });

    expect(bad).toEqual([]);
  });

  test('발행 시각이 미래가 아니다', async ({ page }) => {
    const future = await page.evaluate(() =>
      window.NewsData.articles
        .filter(a => new Date(a.publishedAt).getTime() > Date.now() + 60 * 60 * 1000)
        .map(a => a.id + ' @ ' + a.publishedAt));
    expect(future).toEqual([]);
  });

  test('카테고리마다 기사가 최소 하나씩 있다', async ({ page }) => {
    const empty = await page.evaluate(() =>
      window.NewsData.categories
        .filter(c => !window.NewsData.articles.some(a => a.category === c.key))
        .map(c => c.key));
    expect(empty).toEqual([]);
  });

  test('카테고리마다 대표 기사(중요도 3)가 정확히 하나씩 있다', async ({ page }) => {
    const bad = await page.evaluate(() =>
      window.NewsData.categories.map(c => {
        const n = window.NewsData.articles.filter(a => a.category === c.key && a.importance === 3).length;
        return n === 1 ? null : c.key + ': ' + n + '건';
      }).filter(Boolean));
    expect(bad).toEqual([]);
  });

  test('제목과 요약에 HTML 태그나 이스케이프가 남아 있지 않다', async ({ page }) => {
    /* RSS 본문에는 태그와 &amp; 같은 이스케이프가 섞여 있다.
     * 수집기가 제대로 벗기지 않으면 화면에 그대로 노출된다. */
    const bad = await page.evaluate(() => {
      const dirty = /<\/?[a-z][^>]*>|&(amp|lt|gt|quot|nbsp|#\d+);|\[CDATA\[/i;
      return window.NewsData.articles
        .filter(a => dirty.test(a.title) || dirty.test(a.summary))
        .map(a => a.id + ' :: ' + a.title.slice(0, 40));
    });
    expect(bad).toEqual([]);
  });

  test('요약에 통신사 머리말이 남아 있지 않다', async ({ page }) => {
    /* "(서울=연합뉴스) 홍길동 기자 = " 를 떼지 않으면 짧은 요약 자리를 통째로 잡아먹는다.
     * 뉴시스는 "[서울=뉴시스] 홍길동 김철수 기자 = " 로 괄호 모양이 다르고 이름이 여럿 붙는다. */
    const bad = await page.evaluate(() =>
      window.NewsData.articles
        .filter(a => /^[(\[][^)\]]{2,40}[)\]]\s*[^=]{0,25}?(기자|특파원|통신원)\s*=/.test(a.summary))
        .map(a => a.id + ' :: ' + a.summary.slice(0, 50)));
    expect(bad).toEqual([]);
  });

  test('제목·요약·풀이에 이메일 주소가 없다 (저장소에 커밋되는 파일이다)', async ({ page }) => {
    /* 뉴시스는 요약 끝에 기자 이메일을 붙여 보낸다. 수집기가 지우지 못하면 data/news.js 로 커밋된다 (AGENTS.md 2항) */
    const bad = await page.evaluate(() =>
      window.NewsData.articles
        .filter(a => /[\w.+-]+@[\w-]+\.[\w.-]+/.test([a.title, a.summary].concat(a.points, a.keywords).join(' ')))
        .map(a => a.id));
    expect(bad).toEqual([]);
  });

  test('주요 속보 칸에는 속보 표시가 붙은 하루 안의 기사만 있다', async ({ page }) => {
    const bad = await page.evaluate(() => {
      const d = window.NewsData;
      /* 수집 시각을 기준으로 본다. 저장소 사본은 며칠 뒤에 열어 볼 수도 있다.
       * 수집기는 피드를 읽을 때 나이를 재고 generatedAt 은 끝날 때 찍으므로 10분 여유를 둔다 */
      const base = d.generatedAt ? new Date(d.generatedAt).getTime() : Date.now();
      return d.articles.filter(a => a.category === 'breaking')
        .filter(a => !/^\s*[\[<]\s*(속보|1보|긴급)\s*[\]>]/.test(a.title) ||
          base - new Date(a.publishedAt).getTime() > 24 * 3600000 + 10 * 60000)
        .map(a => a.id + ' :: ' + a.title.slice(0, 40) + ' @ ' + a.publishedAt);
    });
    expect(bad).toEqual([]);
  });

  test('실제 수집물이면 절반 이상에 요약이 있다', async ({ page }) => {
    const info = await page.evaluate(() => ({
      isMock: window.NewsData.isMock,
      total: window.NewsData.articles.length,
      withSummary: window.NewsData.articles.filter(a => a.summary).length,
    }));

    test.skip(info.isMock, '목업 데이터에서는 의미 없는 검사');

    /* 요약이 대부분 비면 "요약해서 보여준다"는 취지가 무너진다.
     * 피드를 교체했을 때 조용히 품질이 떨어지는 것을 잡으려는 검사다. */
    expect(info.withSummary / info.total,
      info.withSummary + '/' + info.total + '건만 요약이 있다').toBeGreaterThan(0.5);
  });

  test('실제 수집물이면 수집 시각이 표시된다', async ({ page }) => {
    const isMock = await page.evaluate(() => window.NewsData.isMock);
    if (isMock) {
      await expect(page.locator('#updated')).toBeHidden();
    } else {
      await expect(page.locator('#updated')).toBeVisible();
      await expect(page.locator('#updated')).toContainText('수집');
    }
  });
});
