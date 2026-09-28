const { test, expect } = require('@playwright/test');
const { open, waitReady, setView, shownCount, logicalCount } = require('./helpers');

test.describe('읽음 표시', () => {
  test('제목을 클릭하면 읽음으로 남고 새로고침 후에도 유지된다', async ({ page, context }) => {
    await open(page);
    await setView(page, 'card');
    await expect(page.locator('#readCount')).toHaveText('0');

    const first = page.locator('#list .card').first();
    const id = await first.getAttribute('data-id');
    await first.locator('h3 a').click();

    await expect(page.locator('#readCount')).toHaveText('1');
    await expect(page.locator('#list [data-id="' + id + '"]')).toHaveClass(/read/);

    await page.reload();
    await waitReady(page);
    await expect(page.locator('#readCount')).toHaveText('1');

    /* 같은 브라우저의 새 탭에서도 유지된다 */
    const p2 = await context.newPage();
    await p2.goto('/');
    await waitReady(p2);
    await expect(p2.locator('#readCount')).toHaveText('1');
    await p2.close();
  });

  test('대시보드에서 클릭해도 읽음으로 남는다', async ({ page }) => {
    await open(page);   // 기본값이 대시보드

    const first = page.locator('.col li[data-id]').first();
    const id = await first.getAttribute('data-id');
    await first.locator('a').click();

    await expect(page.locator('#readCount')).toHaveText('1');
    await expect(page.locator('.col li[data-id="' + id + '"]')).toHaveClass(/read/);
  });

  test('읽지 않은 것만 보기가 읽은 기사를 감춘다', async ({ page }) => {
    await open(page);
    await setView(page, 'card');
    const before = await logicalCount(page);

    const first = page.locator('#list .card').first();
    const id = await first.getAttribute('data-id');
    await first.locator('h3 a').click();

    await page.locator('#btnUnread').click();
    await expect(page.locator('#btnUnread')).toHaveAttribute('aria-pressed', 'true');

    expect(await logicalCount(page)).toBe(before - 1);
    await expect(page.locator('#list [data-id="' + id + '"]')).toHaveCount(0);
  });

  test('읽음 초기화를 누르면 전부 되돌아온다', async ({ page }) => {
    await open(page);
    await setView(page, 'card');
    const before = await logicalCount(page);

    await page.locator('#list .card').nth(0).locator('h3 a').click();
    await page.locator('#list .card').nth(1).locator('h3 a').click();
    await expect(page.locator('#readCount')).toHaveText('2');

    await page.locator('#btnReset').click();
    await expect(page.locator('#readCount')).toHaveText('0');
    expect(await logicalCount(page)).toBe(before);
    await expect(page.locator('#list .read')).toHaveCount(0);
  });

  test('보기 방식과 칼럼당 건수가 새로고침 후에도 유지된다', async ({ page }) => {
    await open(page);

    await setView(page, 'compact');
    await page.reload();
    await waitReady(page);
    await expect(page.locator('#list')).toHaveClass(/compact/);

    await setView(page, 'dashboard');
    await page.locator('#perCat').selectOption('3');
    await page.reload();
    await waitReady(page);
    await expect(page.locator('#perCat')).toHaveValue('3');
  });

  test('칼럼의 더보기를 누르면 그 카테고리 카드 보기로 넘어간다', async ({ page }) => {
    await open(page);

    const more = page.locator('.col .more').first();
    if (await more.count() === 0) {
      /* 견본 데이터가 칼럼당 제한보다 적으면 버튼이 없다 — 제한을 줄여 만든다 */
      await page.locator('#perCat').selectOption('3');
    }
    const btn = page.locator('.col .more').first();
    const cat = await btn.getAttribute('data-more');
    await btn.click();

    await expect(page.locator('#list')).toHaveClass(/cards/);
    await expect(page.locator('#chips .chip[data-cat="' + cat + '"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await shownCount(page)).toBeGreaterThan(0);
  });
});
