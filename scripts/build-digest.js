#!/usr/bin/env node
/* ===========================================================
   메일로 보낼 다이제스트를 만든다
   ---------------------------------------------------------
   왜 Issue 인가

   메일을 직접 보내려면 SMTP 자격증명을 저장해야 한다. 그걸 피하려고
   Actions 가 Issue 를 올리고, GitHub 가 저장소를 지켜보는 사람에게
   알림 메일을 보내주는 경로를 쓴다. 저장할 비밀이 하나도 없다.

   출력은 Issue 본문으로 쓸 마크다운이며 stdout 으로 내보낸다.
   =========================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

const PER_CATEGORY = Number(process.env.DIGEST_PER_CATEGORY || 3);
const TOP_COUNT = Number(process.env.DIGEST_TOP || 4);

/* ---------- 데이터 읽기 ----------
 * data/news.js 는 브라우저용으로 (function(g){...})(window) 형태다.
 * window 를 가짜 객체로 넘겨서 그대로 실행하면 안전하게 값만 꺼낼 수 있다.
 * 정규식으로 JSON 을 파내는 방식은 파일 형식이 조금만 바뀌어도 깨진다. */
function loadData() {
  const p = path.join(__dirname, '..', 'data', 'news.js');
  if (!fs.existsSync(p)) {
    console.error('data/news.js 가 없습니다. 먼저 scripts/fetch-news.js 를 실행하세요.');
    process.exit(1);
  }
  const fake = {};
  new Function('window', fs.readFileSync(p, 'utf8'))(fake);
  if (!fake.NewsData || !Array.isArray(fake.NewsData.articles)) {
    console.error('data/news.js 에서 기사를 읽지 못했습니다.');
    process.exit(1);
  }
  return fake.NewsData;
}

/* ---------- 시각 다루기 ---------- */

const KST_OFFSET = 9 * 60 * 60 * 1000;
const kst = (d) => new Date(new Date(d).getTime() + KST_OFFSET);

function relTime(iso) {
  const m = Math.floor(Math.max(0, Date.now() - new Date(iso).getTime()) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return m + '분 전';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '시간 전';
  return Math.floor(h / 24) + '일 전';
}

/** 아침(4~13시) / 저녁 구분. 제목에 붙여 두 번 오는 메일을 구별한다. */
function slotName(now) {
  const h = kst(now).getUTCHours();
  return (h >= 4 && h < 13) ? '아침' : '저녁';
}

function dateLabel(now) {
  const k = kst(now);
  const days = ['일', '월', '화', '수', '목', '금', '토'];
  return (k.getUTCMonth() + 1) + '/' + k.getUTCDate() + '(' + days[k.getUTCDay()] + ')';
}

/* ---------- 마크다운 만들기 ---------- */

/** 마크다운에서 링크·강조를 깨뜨리는 문자를 막는다 */
function esc(s) {
  return String(s).replace(/([\[\]])/g, '\\$1').replace(/\|/g, '\\|');
}

function line(a, withSummary) {
  let s = '**[' + esc(a.title) + '](' + a.url + ')**\n';
  s += '  <sub>' + esc(a.source) + ' · ' + relTime(a.publishedAt) + '</sub>';
  if (withSummary && a.summary) s += '\n  ' + esc(a.summary);
  return s;
}

function build(data, now) {
  const arts = data.articles.slice()
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const out = [];
  const title = '뉴스 다이제스트 ' + dateLabel(now) + ' ' + slotName(now);

  out.push('<!-- 자동 생성 다이제스트. scripts/build-digest.js -->');
  out.push('');

  /* 주요 — 카테고리 대표 기사 중 최근 것 */
  const top = arts.filter(a => a.importance >= 3).slice(0, TOP_COUNT);
  if (top.length) {
    out.push('## 🔴 주요');
    out.push('');
    top.forEach(a => { out.push('- ' + line(a, true)); out.push(''); });
  }

  /* 분야별 */
  data.categories.forEach(c => {
    const mine = arts.filter(a => a.category === c.key).slice(0, PER_CATEGORY);
    if (!mine.length) return;
    out.push('## ' + c.name);
    out.push('');
    mine.forEach(a => { out.push('- ' + line(a, true)); out.push(''); });
  });

  out.push('---');
  out.push('');
  out.push('전체 보기 → **https://zenki798.github.io/news-alimi/**');
  out.push('');
  const g = data.generatedAt ? kst(data.generatedAt).toISOString().slice(0, 16).replace('T', ' ') : '(알 수 없음)';
  out.push('<sub>수집 시각 ' + g + ' KST · 기사 ' + data.articles.length + '건 · ' +
    '출처 ' + Array.from(new Set(data.articles.map(a => a.source))).join(', ') + '</sub>');
  out.push('');
  out.push('<sub>제목과 짧은 발췌만 담았습니다. 본문은 각 언론사 원문에서 보실 수 있습니다.</sub>');

  return { title, body: out.join('\n') };
}

/* ---------- 실행 ---------- */

function main() {
  const now = new Date();
  const data = loadData();
  const { title, body } = build(data, now);

  const mode = process.argv[2];
  if (mode === '--title') {
    process.stdout.write(title);
    return;
  }

  /* Actions 에서 제목과 본문을 각각 파일로 받아쓰기 쉽게 한다 */
  if (mode === '--out') {
    const dir = process.argv[3] || '.';
    fs.writeFileSync(path.join(dir, 'digest-title.txt'), title, 'utf8');
    fs.writeFileSync(path.join(dir, 'digest-body.md'), body, 'utf8');
    console.log('제목: ' + title);
    console.log('본문 ' + body.length + '자, 기사 ' + data.articles.length + '건');
    return;
  }

  process.stdout.write(body);
}

main();
