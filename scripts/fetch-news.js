#!/usr/bin/env node
/* ===========================================================
   RSS 수집기 — GitHub Actions 가 주기적으로 실행한다
   ---------------------------------------------------------
   왜 이런 구조인가

   1. 브라우저에서 RSS 를 직접 받으면 CORS 에 막힌다. 그래서 수집은 서버 측
      (= Actions 런너)에서 하고, 결과만 정적 파일로 떨어뜨린다.
   2. 결과를 JSON 이 아니라 .js 파일로 쓴다. file:// 로 페이지를 열면 fetch 가
      CORS 에 막히지만, <script src> 는 막히지 않기 때문이다.
      더블클릭으로 열어도 동작해야 한다는 요구를 지키려는 선택이다.
   3. 외부 라이브러리를 쓰지 않는다. Node 내장 fetch 만 쓰므로 Actions 에서
      npm install 단계가 필요 없다. 실패할 수 있는 지점을 하나 줄인다.

   저작권에 대해
   - 제목, 원문 링크, RSS 가 스스로 제공하는 짧은 발췌, 출처명, 발행시각만 담는다.
   - 기사 본문을 긁어오거나 저장하지 않는다. 발췌도 길이를 잘라낸다.
   - 화면에서는 항상 출처를 표기하고 원문으로 링크한다.
   =========================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

/* ---------- 설정 ---------- */

const SUMMARY_MAX = 180;      // 발췌 최대 길이(글자)
const PER_CATEGORY = 14;      // 카테고리당 보관 건수
const TIMEOUT_MS = 15000;

const CATEGORIES = [
  { key: 'it',       name: 'IT·개발·AI', color: '#5b9cff' },
  { key: 'econ',     name: '경제·증시',  color: '#2fbf71' },
  { key: 'domestic', name: '국내 종합',  color: '#ff8a4c' },
  { key: 'world',    name: '해외·글로벌', color: '#a78bfa' },
  { key: 'sports',   name: '스포츠',     color: '#ff5d8f' },
  { key: 'ent',      name: '연예',       color: '#f7b731' },
  { key: 'estate',   name: '부동산',     color: '#22c9c9' },
];

/* 실제로 응답하는지 curl 로 하나씩 확인한 주소만 넣었다.
 * 추측으로 넣으면 배포 후에 조용히 빈 화면이 된다. */
/* 부동산 기사를 골라내는 키워드.
 * 부동산 전용 피드 중 요약을 제공하는 곳을 찾지 못해서, 요약이 있는 연합 경제
 * 피드에서 키워드로 뽑아낸다. 한국경제 부동산 피드는 제목만 보조로 쓴다. */
const ESTATE_WORDS = /아파트|전세|월세|분양|청약|부동산|집값|매매가|재건축|재개발|임대|주택|오피스|상가|토지|공시지가|LH|전셋값/;

const FEEDS = [
  /* IT — 전용 매체만 쓴다.
   * 연합 industry.xml 은 대체로 IT·과학이지만 지역·행정 기사가 섞여서 제외했다.
   * (실제로 "해경청 체력증진 프로그램"이 IT 칸에 올라왔다) */
  { category: 'it',       source: 'ZDNet Korea', url: 'https://feeds.feedburner.com/zdkorea' },
  { category: 'it',       source: '전자신문',    url: 'https://rss.etnews.com/20.xml' },
  /* 한국경제 it 피드는 이름만 IT 다. 실제로는 바이오·제약·건강·연예가 대부분이라 뺐다.
   * ("담배 끊어도 이것 쓰면 심혈관질환 위험 70%" 가 IT 대표 기사로 올라왔다) */

  { category: 'econ',     source: '연합뉴스',    url: 'https://www.yna.co.kr/rss/economy.xml' },
  { category: 'econ',     source: '한국경제',    url: 'https://www.hankyung.com/feed/economy' },

  { category: 'domestic', source: '연합뉴스',    url: 'https://www.yna.co.kr/rss/politics.xml' },
  { category: 'domestic', source: '연합뉴스',    url: 'https://www.yna.co.kr/rss/society.xml' },

  { category: 'world',    source: '연합뉴스',    url: 'https://www.yna.co.kr/rss/international.xml' },
  { category: 'sports',   source: '연합뉴스',    url: 'https://www.yna.co.kr/rss/sports.xml' },
  { category: 'ent',      source: '연합뉴스',    url: 'https://www.yna.co.kr/rss/entertainment.xml' },

  /* 부동산 — 요약이 있는 연합 경제에서 키워드로 뽑고, 한경 부동산을 보조로 둔다 */
  { category: 'estate',   source: '연합뉴스',    url: 'https://www.yna.co.kr/rss/economy.xml',
    titleFilter: ESTATE_WORDS },
  { category: 'estate',   source: '한국경제',    url: 'https://www.hankyung.com/feed/realestate' },
];

/* 목록·공지성 기사는 요약해도 읽을 게 없어서 걸러낸다.
 * "[프로야구] 29일 선발투수" 가 스포츠 대표 기사로 올라온 적이 있다. */
const TITLE_BLOCK = /^\[(게시판|부고|인사|동향|표|영상|포토|사진|알림|기고|카드뉴스|주요 일정)\]|선발투수|매물마당|주요 뉴스|오늘의 날씨|환율\s*=|증시\s*=/;

/* ---------- XML / HTML 다루기 ---------- */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  hellip: '…', middot: '·', ndash: '–', mdash: '—',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => {
      const v = ENTITIES[name.toLowerCase()];
      return v === undefined ? m : v;
    });
}

function safeChar(code) {
  if (!isFinite(code) || code < 0 || code > 0x10ffff) return '';
  try { return String.fromCodePoint(code); } catch (e) { return ''; }
}

/** CDATA 를 벗기고 태그를 없애고 공백을 정리한다.
 *  이스케이프는 두 번 푼다. 요약(description)을 HTML 로 이스케이프한 뒤 XML 로 한 번 더 감싸 보내는
 *  피드가 있다 — 연합뉴스는 E&S 를 E&amp;amp;S 로 보낸다. 한 번만 풀면 화면에 E&amp;S 가 그대로 남는다.
 *  한 번만 감싼 글은 두 번째에 바뀔 것이 없다. */
function clean(raw) {
  if (!raw) return '';
  let s = String(raw);
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  s = s.replace(/<[^>]*>/g, ' ');
  s = decodeEntities(decodeEntities(s));
  return s.replace(/\s+/g, ' ').trim();
}

/** <tag>...</tag> 안쪽을 꺼낸다 */
function pick(block, tag) {
  const m = block.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
  return m ? m[1] : '';
}

/** Atom 의 <link href="..."/> 형태도 처리한다 */
function pickLink(block) {
  const plain = clean(pick(block, 'link'));
  if (/^https?:\/\//.test(plain)) return plain;
  const m = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  return m ? decodeEntities(m[1]) : '';
}

/** 문장 경계를 살려서 자른다 */
function truncate(s, max) {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const dot = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('다.'), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  if (dot > max * 0.5) return cut.slice(0, dot + 1).trim();
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim() + '…';
}

/* ---------- 수집 ---------- */

async function fetchFeed(feed) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(feed.url, {
      signal: ctrl.signal,
      headers: {
        /* 기본 User-Agent 를 막는 서버가 있다 */
        'User-Agent': 'Mozilla/5.0 (compatible; newsalimi/1.0; +https://github.com)',
        'Accept': 'application/rss+xml, application/xml, text/xml, */*',
      },
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function parseItems(xml, feed) {
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
  const out = [];

  for (const b of blocks) {
    const title = truncate(clean(pick(b, 'title')), 120);
    const link = pickLink(b);
    if (!title || !/^https?:\/\//.test(link)) continue;

    /* 목록·공지성 기사 제외 */
    if (TITLE_BLOCK.test(title)) continue;

    /* 이 피드가 키워드 조건을 걸어둔 경우 (부동산처럼 전용 피드가 없는 분야) */
    if (feed.titleFilter && !feed.titleFilter.test(title)) continue;

    const rawSum = pick(b, 'description') || pick(b, 'summary') || pick(b, 'content:encoded') || pick(b, 'content');
    let summary = truncate(clean(rawSum), SUMMARY_MAX);

    /* 연합 기사는 "(서울=연합뉴스) 홍길동 기자 = " 로 시작한다. 요약 자리를 잡아먹으므로 떼어낸다.
     * 기자 외에 특파원·통신원·객원기자 같은 표기도 쓰이므로 함께 처리한다. */
    summary = summary
      .replace(/^\([^)]{2,40}\)\s*[^=]{0,25}?(기자|특파원|통신원|앵커)\s*=\s*/, '')
      .replace(/^\([^)]{2,40}\)\s*=\s*/, '')
      .trim();

    const dateStr = clean(pick(b, 'pubDate') || pick(b, 'published') || pick(b, 'updated') || pick(b, 'dc:date'));
    const t = new Date(dateStr);
    const publishedAt = isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString();

    out.push({
      category: feed.category,
      source: feed.source,
      title,
      /* 요약을 안 주는 피드가 있다(한국경제). 빈 문자열로 두고 화면에서 문단을 생략한다.
       * "(요약 제공되지 않음)" 같은 문구를 채우면 그게 요약인 줄 알고 읽게 된다. */
      summary,
      url: link,
      publishedAt,
    });
  }
  return out;
}

/**
 * 중복을 제거한다. 단 **카테고리 안에서만** 본다.
 *
 * 전역으로 지우면 안 되는 이유: 연합 경제 피드를 경제와 부동산 양쪽에서 쓰는데,
 * 전역 중복 제거를 하면 먼저 처리된 경제가 부동산 기사를 먹어치운다.
 * 부동산 기사는 경제 기사이기도 하므로 양쪽에 보이는 것이 오히려 자연스럽다.
 */
function dedupeWithin(list) {
  const seen = new Set();
  const out = [];
  for (const a of list) {
    const key = a.category + '|' + a.url.split('?')[0];
    const key2 = a.category + '|' + a.title.replace(/\s+/g, '');
    if (seen.has(key) || seen.has(key2)) continue;
    seen.add(key);
    seen.add(key2);
    out.push(a);
  }
  return out;
}

/**
 * importance 를 정한다.
 *
 * 주의 — 이것은 편집자의 판단이 아니라 단순 규칙이다.
 * 기사의 중요도를 알 방법이 없으므로, 카테고리 안에서 가장 최근 것을 대표로 올린다.
 * 화면의 "주요" 표시는 그 규칙의 결과일 뿐 언론사나 이 프로그램의 가치 판단이 아니다.
 */
function assignImportance(byCat) {
  for (const list of Object.values(byCat)) {
    /* 대표 자리(3)에는 요약이 있는 기사를 먼저 올린다.
     * 요약 없는 기사가 대표로 올라가면 "주요" 줄에 제목만 덜렁 남는다. */
    const top = list.findIndex(a => a.summary);
    const lead = top >= 0 ? top : 0;
    list.forEach((a, i) => {
      a.importance = i === lead ? 3 : (i < 3 ? 2 : 1);
    });
  }
}

function makeId(a, i) {
  /* 링크에서 안정적인 조각을 뽑아 id 로 쓴다. 읽음 표시가 갱신 후에도 유지되게 하려는 것. */
  const tail = a.url.split('?')[0].split('/').filter(Boolean).pop() || String(i);
  return a.category + '-' + tail.replace(/[^A-Za-z0-9._-]/g, '').slice(-40);
}

async function main() {
  const results = await Promise.allSettled(FEEDS.map(async f => {
    const xml = await fetchFeed(f);
    const items = parseItems(xml, f);
    console.log('  ok   ' + f.category.padEnd(9) + f.source.padEnd(12) + items.length + '건  ' + f.url);
    return items;
  }));

  const collected = [];
  let failed = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') collected.push.apply(collected, r.value);
    else {
      failed++;
      console.warn('  FAIL ' + FEEDS[i].category.padEnd(9) + FEEDS[i].source.padEnd(12) +
        (r.reason && r.reason.message ? r.reason.message : r.reason) + '  ' + FEEDS[i].url);
    }
  });

  /* 피드 하나가 죽어도 나머지로 계속한다. 다만 전부 실패면 빈 파일을 쓰지 않는다. */
  if (!collected.length) {
    console.error('\n기사를 하나도 못 받았습니다. 기존 데이터를 유지하고 종료합니다.');
    process.exit(1);
  }

  const byCat = {};
  CATEGORIES.forEach(c => { byCat[c.key] = []; });

  dedupeWithin(collected)
    .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt))
    .forEach(a => {
      if (byCat[a.category] && byCat[a.category].length < PER_CATEGORY) byCat[a.category].push(a);
    });

  assignImportance(byCat);

  const articles = [];
  CATEGORIES.forEach(c => {
    byCat[c.key].forEach((a, i) => {
      a.id = makeId(a, i);
      a.keywords = [];
      a.points = [];
      articles.push(a);
    });
  });

  /* id 충돌 방어 */
  const seen = new Set();
  articles.forEach((a, i) => {
    while (seen.has(a.id)) a.id = a.id + '-' + i;
    seen.add(a.id);
  });

  articles.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const payload = {
    isMock: false,
    generatedAt: new Date().toISOString(),
    categories: CATEGORIES,
    articles,
  };

  const out =
    '/* 자동 생성 파일 — 직접 수정하지 마세요.\n' +
    '   scripts/fetch-news.js 가 GitHub Actions 에서 생성합니다.\n' +
    '   제목·링크·짧은 발췌·출처만 담습니다. 기사 본문은 저장하지 않습니다. */\n' +
    '(function (g) {\n' +
    '  var d = ' + JSON.stringify(payload, null, 2).replace(/\n/g, '\n  ') + ';\n' +
    '  d.category = function (key) {\n' +
    '    for (var i = 0; i < d.categories.length; i++) if (d.categories[i].key === key) return d.categories[i];\n' +
    '    return null;\n' +
    '  };\n' +
    '  g.NewsData = d;\n' +
    '})(window);\n';

  const dest = path.join(__dirname, '..', 'data', 'news.js');
  fs.writeFileSync(dest, out, 'utf8');

  const perCat = CATEGORIES.map(c => c.name + ' ' + byCat[c.key].length).join(' / ');
  console.log('\n수집 완료: 총 ' + articles.length + '건 (피드 실패 ' + failed + '개)');
  console.log('카테고리별: ' + perCat);
  console.log('생성: ' + dest);
}

/* `node scripts/fetch-news.js` 로 실행할 때만 수집한다. 테스트가 require 해서 정리 함수만 쓸 수 있게 한다. */
if (require.main === module) {
  main().catch(e => {
    console.error('수집 실패:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
}

module.exports = { clean, decodeEntities };
