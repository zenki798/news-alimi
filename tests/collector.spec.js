// 수집기의 글자 정리 — 피드에서 받은 제목·요약이 화면에 깨끗하게 나오는지 (네트워크 없이 본다)
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
const {
  clean, stripByline, scrubSummary, spaceSentences, parseItems, dedupeWithin, makeId,
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

test('공시는 중요한 종류만 골라 쉬운 이름과 풀이를 붙이고, 무게가 큰 것부터 건수를 지킨다', () => {
  const xml = '<rss><channel>' +
    kindItem('코', '견본전자', '임원ㆍ주요주주특정증권등소유상황보고서', '11:00') +   // 가장 최근이지만 무게 1
    kindItem('코', '견본전자', '주식등의대량보유상황보고서(일반)', '10:30') +
    kindItem('유', '견본중공업', '현금ㆍ현물 배당 결정', '10:00') +                    // 띄어쓴 변형
    kindItem('유', '가상화학', '[정정]최대주주변경', '09:30') +                        // 정정은 뺀다
    kindItem('코', '테스트바이오', '반기보고서(일반법인)(2026.06)', '09:20') +         // 고르지 않는 종류
    kindItem('유', '가상화학', '최대주주변경', '09:00') +                              // 오래됐지만 무게 5
    '</channel></rss>';

  const out = parseItems(xml, { category: 'invest', source: '한국거래소 공시', disclosure: true, limit: 3 });

  expect(out.map(a => a.title)).toEqual([
    '[공시] 가상화학 · 최대주주 변경',
    '[공시] 견본중공업 · 배당 결정',
    '[공시] 견본전자 · 5% 이상 지분 신고',
  ]);
  const top = out[0];
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
