// 수집·배포 워크플로 설정 — 사이트의 뉴스가 멈추지 않게 하는 연결을 지킨다 (AGENTS.md 4항)
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const read = name => fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', name), 'utf8');

/** cron 의 분(minute) 칸을 숫자 목록으로 편다. 쉼표 목록과 '*\/N' 만 다룬다. */
function minutesOf(field) {
  if (field === '*') return Array.from({ length: 60 }, (_, i) => i);
  const step = /^\*\/(\d+)$/.exec(field);
  if (step) return Array.from({ length: Math.ceil(60 / Number(step[1])) }, (_, i) => i * Number(step[1]));
  const list = field.split(',').map(Number);
  if (list.some(n => !Number.isInteger(n) || n < 0 || n > 59)) throw new Error('해석할 수 없는 분 칸: ' + field);
  return list;
}

test('뉴스 수집 예약이 혼잡한 시각(정시·5분 단위)을 피하고, 15분 넘게 비는 구간이 없다', async () => {
  /* GitHub 는 예약 실행을 보장하지 않는다. 정시처럼 몰리는 시각에는 늦추거나 건너뛴다.
     '*\/30'(매시 0·30분)으로 두었을 때 이틀간 9번, 4~8시간 간격으로만 돌았다. */
  const crons = [...read('fetch-news.yml').matchAll(/-\s*cron:\s*'([^']+)'/g)].map(m => m[1].trim().split(/\s+/));
  expect(crons.length).toBeGreaterThan(0);

  const minutes = [];
  for (const [min, hour, dom, mon, dow] of crons) {
    expect([hour, dom, mon, dow], '매시간 도는 예약이어야 한다').toEqual(['*', '*', '*', '*']);
    minutes.push(...minutesOf(min));
  }
  const sorted = [...new Set(minutes)].sort((a, b) => a - b);

  expect(sorted.filter(m => m % 5 === 0), '정시·5분 단위는 예약이 몰리는 시각').toEqual([]);
  const gaps = sorted.map((m, i) => (i + 1 < sorted.length ? sorted[i + 1] : sorted[0] + 60) - m);
  expect(Math.max(...gaps), '예약 사이 최대 간격(분): ' + sorted.join(',')).toBeLessThanOrEqual(15);
});

test('배포에 앱 파일이 포함되고, 수집이 끝나면 배포가 이어서 돈다', async () => {
  const yml = read('pages.yml');
  expect(yml).toContain('manifest.webmanifest sw.js');
  expect(yml).toContain('icons/*.png');
  // 봇 커밋은 push 이벤트를 만들지 않는다. 이 연결이 없으면 사이트의 뉴스가 멈춘다.
  expect(yml).toMatch(/workflow_run:\s*\n\s*workflows: \['뉴스 수집'\]/);
  expect(read('fetch-news.yml')).toMatch(/^name: 뉴스 수집$/m);
});
