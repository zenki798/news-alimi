/* 테스트 공용 헬퍼 */

async function waitReady(page) {
  await page.waitForFunction(
    () => !!window.NewsData && !!window.__app && document.querySelectorAll('#chips .chip').length > 0,
    null,
    { timeout: 15000 },
  );
}

async function open(page) {
  await page.goto('/');
  await waitReady(page);
}

/** 보기 방식을 바꾼다 (dashboard | card | compact) */
async function setView(page, view) {
  await page.locator('#views button[data-view="' + view + '"]').click();
  await page.waitForFunction(v => window.__app.state.view === v, view);
}

/** 현재 화면에 실제로 그려진 기사 수 (목록 영역만, 주요 스트립은 제외) */
async function shownCount(page) {
  return page.locator('#list [data-id]').count();
}

/** 필터를 통과한 논리 건수 — 표시 제한과 무관하다 */
async function logicalCount(page) {
  return page.evaluate(() => window.__app.filtered().length);
}

/** 칩의 건수 배지 값 */
async function chipCount(page, catKey) {
  const t = await page.locator('#chips .chip[data-cat="' + catKey + '"] .n').textContent();
  return Number(t);
}

module.exports = { open, waitReady, setView, shownCount, logicalCount, chipCount };
