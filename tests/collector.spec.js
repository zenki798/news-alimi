// 수집기의 글자 정리 — 피드에서 받은 제목·요약이 화면에 깨끗하게 나오는지 (네트워크 없이 본다)
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const {
  clean, stripByline, scrubSummary, spaceSentences, parseItems, dedupeWithin, makeId,
  parseTrends, trafficLabel, fillCategories, why, download,
  CATEGORIES, FEEDS, PER_CATEGORY, GLOBAL_ECON_WORDS, BREAKING_WORDS,
} = require('../scripts/fetch-news');

/** RSS 항목 하나 (발행 시각은 지금으로부터 몇 시간 전) */
function rssItem(title, desc, hoursAgo, n) {
  return '<item><title>' + title + '</title>' +
    '<link>https://www.yna.co.kr/view/AKR2026100100' + String(n || 0).padStart(4, '0') + '</link>' +
    '<description><![CDATA[' + (desc || '') + ']]></description>' +
    '<pubDate>' + new Date(Date.now() - (hoursAgo || 0) * 3600000).toUTCString() + '</pubDate></item>';
}

test('두 번 감싼 이스케이프도 푼다 (연합뉴스 요약: E&amp;amp;S)', () => {
  /* 요약은 HTML 을 XML 로 한 번 더 감싸 오는 피드가 있다. 한 번만 풀면 화면에 E&amp;S 가 보인다. */
  expect(clean('SK이노베이션 E&amp;amp;S가 호주에서')).toBe('SK이노베이션 E&S가 호주에서');
  expect(clean('연구·개발(R&amp;amp;D) 투자')).toBe('연구·개발(R&D) 투자');
  expect(clean('&amp;quot;수출 주도 지속 불가능&amp;quot;')).toBe('"수출 주도 지속 불가능"');
});

test('한 번 감싼 것·CDATA·태그는 전처럼 정리한다', () => {
  expect(clean('SK이노 E&amp;S, 호주LNG')).toBe('SK이노 E&S, 호주LNG');
  expect(clean('<![CDATA[<p>AT&amp;T 와 <b>협력</b></p>]]>')).toBe('AT&T 와 협력');
  expect(clean('  줄바꿈과\n\n  공백이   많은 글  ')).toBe('줄바꿈과 공백이 많은 글');
  expect(clean('')).toBe('');
});

test('제목 앞의 <속보> 같은 꺾쇠 머리표는 지우지 않는다', () => {
  expect(clean('&lt;속보&gt; 코스피 2,500 돌파')).toBe('<속보> 코스피 2,500 돌파');
});

test('통신사 머리말을 괄호 모양과 상관없이 떼어낸다 (연합 소괄호, 뉴시스 대괄호)', () => {
  expect(stripByline('(서울=연합뉴스) 홍길동 기자 = 본문이다.')).toBe('본문이다.');
  expect(stripByline('(뉴욕=연합뉴스) 홍길동 특파원 = 본문이다.')).toBe('본문이다.');
  /* 뉴시스는 대괄호에, 기자 이름이 여럿 붙고, 괄호 뒤를 띄우지 않기도 한다 */
  expect(stripByline('[서울=뉴시스] 홍길동 김철수 이영희 기자 = 본문이다.')).toBe('본문이다.');
  expect(stripByline('[서울=뉴시스]홍길동 기자 = 본문이다.')).toBe('본문이다.');
  /* 머리말이 아닌 괄호는 남긴다 */
  expect(stripByline('(종합) 본문이다.')).toBe('(종합) 본문이다.');
  expect(stripByline('[파이낸셜뉴스] 본문이다.')).toBe('[파이낸셜뉴스] 본문이다.');
});

test('줄바꿈이 지워져 붙은 문장을 띄운다 (연합인포맥스: "세웠다.한국은행이")', () => {
  expect(spaceSentences('신기록을 세웠다.한국은행이 발표했다.')).toBe('신기록을 세웠다. 한국은행이 발표했다.');
  expect(spaceSentences('늘었다."이번에는"')).toBe('늘었다. "이번에는"');
  /* 숫자·말줄임·이미 띄운 문장은 그대로 */
  expect(spaceSentences('금리가 1.5%다. 다음')).toBe('금리가 1.5%다. 다음');
  expect(spaceSentences('그렇다...')).toBe('그렇다...');
});

test('요약에서 이메일 주소와 속보 안내 문구를 지운다 (뉴시스는 기자 이메일을 붙여 보낸다)', () => {
  expect(scrubSummary('후속기사가 이어집니다 ◎공감언론 뉴시스 hong@example.com')).toBe('');
  expect(scrubSummary('본문 내용이다. ◎공감언론 뉴시스 hong.gildong@example.co.kr')).toBe('본문 내용이다.');
  expect(scrubSummary('문의는 test+news@example.com 으로')).toBe('문의는 으로');
});

test('요약이라 부를 수 없는 찌꺼기는 빈 요약으로 둔다 (연합 속보 "(" · 뉴시스 "[서울=뉴시스]")', () => {
  const xml = '<rss><channel>' +
    rssItem('[속보] 첫째', '(', 1, 1) +
    rssItem('[속보] 둘째', '[서울=뉴시스]', 1, 2) +
    rssItem('[속보] 셋째', '[세종=뉴시스] 홍길동 기자 = ◎공감언론 뉴시스 hong@example.com', 1, 3) +
    rssItem('[속보] 넷째', '후속기사가 이어집니다 ◎공감언론 뉴시스 hong@example.com', 1, 4) +
    rssItem('보통 기사', '(서울=연합뉴스) 홍길동 기자 = 요약이 제대로 있는 기사는 그대로 남아야 한다.', 1, 5) +
    '</channel></rss>';
  const out = parseItems(xml, { category: 'politics', source: '연합뉴스' });
  expect(out.map(a => a.summary)).toEqual(['', '', '', '', '요약이 제대로 있는 기사는 그대로 남아야 한다.']);
});

test('주요 속보: 통신사 속보 표시가 붙은 하루 안의 기사만 고른다', () => {
  const xml = '<rss><channel>' +
    rssItem('[속보] 국회 본회의 개의', '', 2, 1) +
    rssItem('[1보] 대표팀 결승 진출', '', 3, 2) +
    rssItem('&lt;속보&gt; 꺾쇠로 단 속보', '', 1, 3) +
    rssItem('[긴급] 긴급 표시', '', 1, 4) +
    rssItem('[2보] 같은 소식의 이어 쓰기', '', 1, 5) +       // 이어 쓰기는 뺀다
    rssItem('[단독] 단독은 속보가 아니다', '', 1, 6) +
    rssItem('제목 중간의 [속보] 는 표시가 아니다', '', 1, 7) +
    rssItem('[속보] 하루 넘게 지난 속보', '', 30, 8) +        // 오래된 것은 뺀다
    '</channel></rss>';
  const out = parseItems(xml, { category: 'breaking', source: '연합뉴스', titleFilter: BREAKING_WORDS, maxAgeHours: 24 });
  expect(out.map(a => a.title)).toEqual(['[속보] 국회 본회의 개의', '[1보] 대표팀 결승 진출', '<속보> 꺾쇠로 단 속보', '[긴급] 긴급 표시']);
});

test('주요 속보 칸의 피드는 모두 속보 표시로 거르고 지난 것을 뺀다', () => {
  const feeds = FEEDS.filter(f => f.category === 'breaking');
  expect(feeds.length).toBeGreaterThan(0);
  /* 거르지 않은 피드가 하나라도 섞이면 그 분야 기사 전부가 속보 칸에 올라온다 */
  feeds.forEach(f => {
    expect(f.titleFilter, f.url).toBe(BREAKING_WORDS);
    expect(f.maxAgeHours, f.url).toBeGreaterThan(0);
  });
  expect(CATEGORIES[0].key, '주요 속보는 맨 앞 띠').toBe('breaking');
  expect(CATEGORIES[0].wide).toBe(true);
});

test('글 번호가 쿼리에 있는 주소도 기사마다 따로 남고 id 가 안정적이다 (ZDNet 이 1건만 남던 문제)', () => {
  const a = (url, title) => ({ category: 'it', title, url });
  const list = dedupeWithin([
    a('https://zdnet.co.kr/view/?no=20261001000001', '첫 기사'),
    a('https://zdnet.co.kr/view/?no=20261001000002', '둘째 기사'),
    a('https://zdnet.co.kr/view/?no=20261001000001&utm_source=rss', '같은 기사, 추적 꼬리만 다름'),
    a('https://news.einfomax.co.kr/news/articleView.html?idxno=4437361', '인포맥스 1'),
    a('https://news.einfomax.co.kr/news/articleView.html?idxno=4437359', '인포맥스 2'),
  ]);
  expect(list.map(x => x.title)).toEqual(['첫 기사', '둘째 기사', '인포맥스 1', '인포맥스 2']);
  expect(list.map(makeId)).toEqual(['it-20261001000001', 'it-20261001000002', 'it-4437361', 'it-4437359']);

  /* 경로에 번호가 있는 주소의 id 는 전과 같다 — 바꾸면 이미 읽은 표시가 사라진다 */
  expect(makeId({ category: 'society', url: 'https://www.yna.co.kr/view/AKR20261001000100001' }))
    .toBe('society-AKR20261001000100001');
  expect(makeId({ category: 'econ', url: 'https://www.hankyung.com/article/202610017776i' }))
    .toBe('econ-202610017776i');
});

/* 거래소 공시 RSS 모양을 본뜬 견본 (회사명은 가상) */
function kindItem(market, company, name, time) {
  return '<item><title><![CDATA[[' + market + ']' + company + ' ' + name + ']]></title>' +
    '<link><![CDATA[http://kind.krx.co.kr:80/common/disclsviewer.do?method=searchInitInfo&acptNo=' +
    '2026100100' + String(time).replace(':', '') + '&docno=]]></link>' +
    '<pubDate>Thu, 01 Oct 2026 ' + time + ':00 +0900</pubDate>' +
    '<author><![CDATA[[' + market + ']' + company + ']]></author><category>수시공시</category></item>';
}

test('공시는 중요한 종류만 골라 쉬운 이름과 풀이를 붙이고, 무게가 큰 것부터 몫(limit)을 채우고 나머지는 예비로 둔다', () => {
  const xml = '<rss><channel>' +
    kindItem('코', '견본전자', '임원ㆍ주요주주특정증권등소유상황보고서', '11:00') +   // 가장 최근이지만 무게 1
    kindItem('코', '견본전자', '주식등의대량보유상황보고서(일반)', '10:30') +
    kindItem('유', '견본중공업', '현금ㆍ현물 배당 결정', '10:00') +                    // 띄어쓴 변형
    kindItem('유', '가상화학', '[정정]최대주주변경', '09:30') +                        // 정정은 뺀다
    kindItem('코', '테스트바이오', '반기보고서(일반법인)(2026.06)', '09:20') +         // 고르지 않는 종류
    kindItem('유', '가상화학', '최대주주변경', '09:00') +                              // 오래됐지만 무게 5
    '</channel></rss>';

  const out = parseItems(xml, { category: 'invest', source: '한국거래소 공시', disclosure: true, limit: 3 });

  const kept = out.filter(a => !a.spare);
  expect(kept.map(a => a.title)).toEqual([
    '[공시] 가상화학 · 최대주주 변경',
    '[공시] 견본중공업 · 배당 결정',
    '[공시] 견본전자 · 5% 이상 지분 신고',
  ]);
  /* 몫 밖의 것은 버리지 않고 예비로 남긴다 — 다른 피드가 실패하면 빈자리를 채운다 */
  expect(out.filter(a => a.spare).map(a => a.title)).toEqual(['[공시] 견본전자 · 임원·대주주 지분 변동']);
  const top = kept[0];
  /* 요약은 비운다 — 요약이 있으면 카테고리 대표(주요) 자리를 공시가 차지한다 */
  expect(top.summary).toBe('');
  expect(top.points[0]).toContain('최대주주');
  expect(top.points[1]).toBe('공시명: 최대주주변경');
  expect(top.keywords).toEqual(['공시', '코스피', '최대주주 변경']);
  expect(top.url).toBe('https://kind.krx.co.kr/common/disclsviewer.do?method=searchInitInfo&acptNo=20261001000900&docno=');
  expect(top.publishedAt).toBe('2026-10-01T00:00:00.000Z');
  expect(out.every(a => !('weight' in a))).toBe(true);
});

test('글로벌 경제 필터: 경제 기사만 남기고 "위안부" 는 "위안화" 로 착각하지 않는다', () => {
  const item = (title, desc) => '<item><title>' + title + '</title><link>https://www.newsis.com/view/' +
    encodeURIComponent(title).slice(0, 12) + '</link><description>' + (desc || '') + '</description>' +
    '<pubDate>Thu, 01 Oct 2026 10:00:00 +0900</pubDate></item>';
  const xml = '<rss><channel>' +
    item('엔화, 美 장기금리 상승에 157엔대 하락', '[서울=뉴시스] 홍길동 기자 = 엔화 가치가 미국 장기금리 상승에 내렸다.달러는 주요 통화 대비 올랐다.') +
    item('日銀 9월 회의서 물가 상승 경계감') +
    item('"위안부, 연구대상 넘어 아시아 이해 방법 삼아야"') +
    item('나토 사무총장, 러 核 위협 경고') +
    item('[인사] 견본은행') +
    '</channel></rss>';

  const out = parseItems(xml, { category: 'globalecon', source: '뉴시스', titleFilter: GLOBAL_ECON_WORDS });
  expect(out.map(a => a.title)).toEqual(['엔화, 美 장기금리 상승에 157엔대 하락', '日銀 9월 회의서 물가 상승 경계감']);
  expect(out[0].summary).toBe('엔화 가치가 미국 장기금리 상승에 내렸다. 달러는 주요 통화 대비 올랐다.');
});

test('피드와 카테고리가 서로 맞는다', () => {
  const keys = CATEGORIES.map(c => c.key);
  expect(new Set(keys).size, '카테고리 key 중복').toBe(keys.length);

  /* 없는 카테고리로 가는 피드가 있으면 그 기사는 조용히 버려진다 */
  expect(FEEDS.filter(f => keys.indexOf(f.category) < 0).map(f => f.url)).toEqual([]);
  /* 피드가 없는 카테고리는 화면에 빈 칸으로 남는다 */
  expect(keys.filter(k => !FEEDS.some(f => f.category === k))).toEqual([]);

  /* 피드마다 건수를 정한 카테고리는 합이 칸 수를 넘지 않아야 한다.
   * 넘으면 오래된 것부터 잘려서, 무게로 고른 공시가 최신 기사에 밀려 사라질 수 있다. */
  keys.forEach(k => {
    const feeds = FEEDS.filter(f => f.category === k);
    if (!feeds.every(f => f.limit)) return;
    const sum = feeds.reduce((s, f) => s + f.limit, 0);
    expect(sum, k + ' 피드 limit 합').toBeLessThanOrEqual(PER_CATEGORY);
  });
});

test('목업 데이터의 카테고리가 수집기와 같다', () => {
  /* 수집물이 없을 때는 목업이 뜬다. 둘이 다르면 그때만 칸이 바뀌거나 사라진다 */
  const fake = {};
  new Function('window', fs.readFileSync(path.join(__dirname, '..', 'data', 'mock-news.js'), 'utf8'))(fake);
  expect(fake.NewsData.categories).toEqual(CATEGORIES);
});

/* ---------- 피드가 실패해도 칸이 비지 않게 (2026-10-01 전자신문이 GitHub 서버에서 가끔 끊김) ---------- */

/** 칸 채우기용 견본 기사. n 분 전 발행 */
const art = (category, source, n, spare) => Object.assign(
  { category, source, title: source + ' ' + n, url: 'https://example.com/' + source + '/' + n,
    publishedAt: new Date(Date.UTC(2026, 9, 1, 12) - n * 60000).toISOString() },
  spare ? { spare: true } : {});

test('한 출처가 실패하면 다른 출처의 예비 기사로 빈자리를 채운다', () => {
  /* ZDNet 몫 6 + 예비 14. 전자신문은 실패해서 없다 */
  const zd = Array.from({ length: 20 }, (_, i) => art('it', 'ZDNet', i + 1, i >= 6));
  const it = fillCategories(zd).it;
  expect(it).toHaveLength(PER_CATEGORY);                       // 예전에는 몫 6건만 남았다
  expect(it.every(a => !('spare' in a))).toBe(true);
});

test('모든 출처가 살아 있으면 몫대로 나눠 담고 예비는 쓰지 않는다', () => {
  /* 예비 기사가 더 최신이어도 몫 안의 기사가 먼저다 */
  const list = []
    .concat(Array.from({ length: 10 }, (_, i) => art('it', 'ZDNet', i + 30, i >= 6)))
    .concat(Array.from({ length: 6 }, (_, i) => art('it', '전자신문03', i + 1, i >= 4)))
    .concat(Array.from({ length: 6 }, (_, i) => art('it', '전자신문04', i + 10, i >= 4)));
  const it = fillCategories(list).it;
  const n = src => it.filter(a => a.source === src).length;
  expect([n('ZDNet'), n('전자신문03'), n('전자신문04')]).toEqual([6, 4, 4]);
  /* 칸 안에서는 최신 순 */
  expect(it.map(a => a.publishedAt)).toEqual(it.map(a => a.publishedAt).slice().sort().reverse());
});

test('같은 기사가 몫 안과 예비에 함께 있으면 몫 안의 것을 남긴다', () => {
  const a = art('it', 'ZDNet', 5, false);
  const b = Object.assign({}, a, { spare: true });
  expect(fillCategories([b, a]).it).toHaveLength(1);
});

test('IT 칸은 출처가 둘 이상이고, 출처마다 몫을 나눠 한 출처가 칸을 통째로 차지하지 못한다', () => {
  /* 전자신문 과학·바이오 피드가 한 시간에 14건씩 올라와 IT 칸이 전부 제약 기사가 된 적이 있다.
   * 예전에는 저장소의 뉴스 사본으로 검사해서, 피드가 잠깐 끊긴 순간의 사본이면 엉뚱하게 실패했다. 설정으로 본다. */
  const feeds = FEEDS.filter(f => f.category === 'it');
  expect(new Set(feeds.map(f => f.source)).size).toBeGreaterThanOrEqual(2);
  feeds.forEach(f => expect(f.limit, f.url).toBeGreaterThan(0));
  const bySrc = {};
  feeds.forEach(f => { bySrc[f.source] = (bySrc[f.source] || 0) + f.limit; });
  Object.entries(bySrc).forEach(([src, n]) => expect(n, src + ' 의 몫').toBeLessThan(PER_CATEGORY));
});

test('연결이 끊기면 한 번 더 받고, 4xx 는 다시 받지 않는다. 실패 까닭(ECONNRESET 등)을 남긴다', async () => {
  const real = global.fetch;
  process.env.NEWS_RETRY_MS = '5';
  let calls = 0;
  try {
    global.fetch = async () => {
      calls++;
      if (calls === 1) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
      return { ok: true, status: 200, text: async () => '<rss/>' };
    };
    expect(await download('https://example.com/a.xml')).toBe('<rss/>');
    expect(calls).toBe(2);

    calls = 0;
    global.fetch = async () => { calls++; return { ok: false, status: 404, text: async () => '' }; };
    await expect(download('https://example.com/b.xml')).rejects.toThrow('HTTP 404');
    expect(calls).toBe(1);
  } finally {
    global.fetch = real;
    delete process.env.NEWS_RETRY_MS;
  }
  expect(why(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))).toBe('fetch failed (ECONNRESET)');
  expect(why(new Error('HTTP 503'))).toBe('HTTP 503');
});

/* ---------- 많이 찾는 뉴스 (구글 트렌드) ---------- */

/** 구글 트렌드 RSS 항목 모양 (주제·검색량·관련 기사) */
function trendItem(topic, traffic, minutesAgo, newsTitle, source, url) {
  return '<item><title>' + topic + '</title><ht:approx_traffic>' + traffic + '</ht:approx_traffic>' +
    '<description/><link>https://trends.google.com/trending/rss?geo=KR</link>' +
    '<pubDate>' + new Date(Date.UTC(2026, 9, 1, 8) - minutesAgo * 60000).toUTCString() + '</pubDate>' +
    '<ht:news_item><ht:news_item_title>' + newsTitle + '</ht:news_item_title><ht:news_item_snippet/>' +
    '<ht:news_item_url>' + url + '</ht:news_item_url><ht:news_item_source>' + source + '</ht:news_item_source></ht:news_item>' +
    '<ht:news_item><ht:news_item_title>둘째 기사</ht:news_item_title><ht:news_item_url>https://example.com/second</ht:news_item_url>' +
    '<ht:news_item_source>다른신문</ht:news_item_source></ht:news_item></item>';
}

test('구글 트렌드: 검색량 순으로 순위를 매기고, 주제의 첫 기사를 언론사 원문 주소로 올린다', () => {
  const xml = '<rss xmlns:ht="https://trends.google.com/trending/rss"><channel>' +
    trendItem('단풍', '500+', 10, '단풍 절정 다음 주', '견본일보', 'https://example.com/n1') +
    trendItem('배당', '10000+', 30, '&apos;찬바람 불면 배당주&apos; 올해도 - 가상경제', '가상경제', 'https://example.com/n2') +
    trendItem('코스피', '2000+', 5, '코스피 급락 원인은', '견본방송', 'https://example.com/n3') +
    trendItem('대학 순위', '2000+', 20, '세계 대학 순위 발표', '견본대학신문', 'https://example.com/n4') +
    '</channel></rss>';
  const out = parseItems(xml, { category: 'popular', source: '구글 트렌드', trends: true });

  /* 검색량이 많은 순, 같으면 최근 것이 앞 */
  expect(out.map(a => [a.rank, a.keywords[0]])).toEqual([[1, '배당'], [2, '코스피'], [3, '대학 순위'], [4, '단풍']]);
  const top = out[0];
  expect(top.title).toBe("'찬바람 불면 배당주' 올해도");          // 끝의 "- 언론사" 를 떼고, &apos; 를 푼다
  expect(top.source).toBe('가상경제');                             // 출처는 기사를 쓴 언론사
  expect(top.url).toBe('https://example.com/n2');                  // 언론사 원문 주소
  expect(top.topic).toBe('배당 · 검색 1만+');
  expect(top.summary).toBe('');
  expect(out.every(a => !('traffic' in a))).toBe(true);
});

test('검색량 어림값을 읽기 쉽게 적는다', () => {
  expect([500, 1000, 2000, 5000, 10000, 20000, 100000, 1000000].map(trafficLabel))
    .toEqual(['500+', '1천+', '2천+', '5천+', '1만+', '2만+', '10만+', '100만+']);
});

test('순위 칸은 칸에 담은 뒤 번호를 1부터 빠짐없이 다시 매긴다 (중복이 빠져도)', () => {
  const p = (rank, url) => ({ category: 'popular', source: 's', title: 't' + rank, url, rank,
    publishedAt: '2026-10-01T00:00:00.000Z' });
  /* 2위와 3위가 같은 기사라 하나가 빠진다 */
  const out = fillCategories([p(1, 'https://e.com/1'), p(2, 'https://e.com/x'), p(3, 'https://e.com/x'), p(4, 'https://e.com/4')]).popular;
  expect(out.map(a => [a.rank, a.url])).toEqual([[1, 'https://e.com/1'], [2, 'https://e.com/x'], [3, 'https://e.com/4']]);
});
