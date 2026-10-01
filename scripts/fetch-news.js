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
const SUMMARY_MIN = 20;       // 이보다 짧게 남으면 요약이 없는 것으로 본다 (연합 속보는 "(" 한 글자가 온다)
const PER_CATEGORY = 14;      // 카테고리당 보관 건수
const TIMEOUT_MS = 15000;

/* 대시보드는 넓은 화면에서 한 줄에 5칸이다. 돈 이야기(경제·글로벌 경제·투자·부동산)를 첫 줄에 모았다.
 * note 는 칼럼 제목 아래에 작게 붙는 안내, wide 는 대시보드에서 한 줄을 통째로 쓰는 띠로 그리라는 표시다(둘 다 선택).
 * 주요 속보를 띠로 두면 나머지 10칸이 5칸씩 두 줄로 맞는다 (11칸이면 5·5·1 로 한 칸이 외따로 남는다).
 * 목업 data/mock-news.js 의 목록과 같아야 한다(테스트가 본다). */
const CATEGORIES = [
  { key: 'breaking',   name: '주요 속보',   color: '#ff4b4b', wide: true },
  /* rank: 시각이 아니라 순위(rank)대로 보여 주는 칸. 맨 위 줄에서 속보 옆에 번호 목록으로 선다.
   * "주요 뉴스" 가 아니라 "많이 찾는 뉴스" 로 부른다 — 바로 옆 "주요 속보" 와 헷갈려 시선이 갈렸던 적이 있다. */
  { key: 'popular',    name: '많이 찾는 뉴스', color: '#e5e7eb', wide: true, rank: true,
    note: '구글에서 지금 많이 검색되는 주제와 그 기사입니다. 검색량 순.' },
  { key: 'it',         name: 'IT·개발·AI',  color: '#5b9cff' },
  { key: 'econ',       name: '경제·증시',   color: '#2fbf71' },
  { key: 'globalecon', name: '글로벌 경제', color: '#38bdf8' },
  { key: 'invest',     name: '투자',        color: '#c3e04a',
    note: '투자 권유가 아닙니다. 공시 풀이는 이 사이트가 붙인 일반 설명입니다.' },
  { key: 'estate',     name: '부동산',      color: '#22c9c9' },
  { key: 'politics',   name: '정치',        color: '#e879f9' },
  { key: 'society',    name: '사회',        color: '#ff8a4c' },
  { key: 'world',      name: '해외·글로벌', color: '#a78bfa' },
  { key: 'sports',     name: '스포츠',      color: '#ff5d8f' },
  { key: 'ent',        name: '연예',        color: '#f7b731' },
];

/* 실제로 응답하는지 curl 로 하나씩 확인한 주소만 넣었다.
 * 추측으로 넣으면 배포 후에 조용히 빈 화면이 된다. */
/* 부동산 기사를 골라내는 키워드.
 * 부동산 전용 피드 중 요약을 제공하는 곳을 찾지 못해서, 요약이 있는 연합 경제
 * 피드에서 키워드로 뽑아낸다. 한국경제 부동산 피드는 제목만 보조로 쓴다. */
const ESTATE_WORDS = /아파트|전세|월세|분양|청약|부동산|집값|매매가|재건축|재개발|임대|주택|오피스|상가|토지|공시지가|LH|전셋값/;

/* 글로벌 경제 — 뉴시스 국제 피드는 전쟁·선거·사건이 절반 이상이라 경제 기사만 골라낸다.
 * '위안' 이 아니라 '위안화' 다. '위안' 으로 두면 "위안부" 기사가 글로벌 경제에 올라온다(미리보기에서 겪음). */
const GLOBAL_ECON_WORDS = /경제|증시|주가|지수|나스닥|다우|S&P|금리|연준|Fed|FOMC|ECB|BOJ|日銀|일본은행|인민은행|중앙은행|환율|달러|엔화|위안화|유로화|국채|채권|물가|인플레|CPI|PCE|고용|실업|GDP|성장률|관세|무역|수출|수입|유가|원유|OPEC|금값|가상자산|비트코인|반도체|실적|매출|투자|IMF|세계은행|PMI|경기|재정|부채|신용등급|증권|은행|펀드|M&A|인수|합병|재고|소비/;

/* 통신사가 제목에 다는 속보 표시. [2보]·[3보] 는 같은 소식의 이어 쓰기라 넣지 않는다.
 * 제목은 clean() 을 거친 뒤라 &lt;속보&gt; 도 <속보> 로 온다. */
const BREAKING_WORDS = /^\s*[\[<]\s*(속보|1보|긴급)\s*[\]>]/;

/* 거래소 오늘의 공시. 기본은 50건(약 1시간치)이라 페이지 크기를 늘려 그날 것을 전부 받는다. */
const KIND_URL = 'https://kind.krx.co.kr/disclosure/rsstodaydistribute.do?method=searchRssTodayDistribute' +
  '&repIsuSrtCd=&mktTpCd=0&searchCorpName=&currentPageSize=1000';

const FEEDS = [
  /* 주요 속보 — 연합뉴스가 제목에 [속보]·[1보]·[긴급] 을 달아 내보낸 기사만 모은다. "급하다"는 판단은
   * 이 프로그램이 아니라 통신사 편집국의 것이다. 속보 전용 피드는 쓸 만한 것이 없었다(AGENTS.md 4항 표).
   * 뉴시스는 같은 소식을 거의 같은 제목으로 내보내 칸이 같은 소식으로 두 번씩 차서 넣지 않았다.
   * 분야 피드는 하루~엿새치를 담고 있으므로 하루 지난 속보는 뺀다(maxAgeHours).
   * news.xml(전 분야 최신 약 1시간치)은 전용 피드가 없는 분야(문화·지역 등)의 속보를 잡는다. */
  ...['news', 'politics', 'northkorea', 'economy', 'society', 'international'].map(s => ({
    category: 'breaking', source: '연합뉴스', url: 'https://www.yna.co.kr/rss/' + s + '.xml',
    titleFilter: BREAKING_WORDS, maxAgeHours: 24,
  })),

  /* 많이 찾는 뉴스 — 구글 트렌드(한국) "지금 많이 검색되는 주제" 10개. 주제마다 검색량과 관련 기사(언론사 원문 주소)가 온다.
   * 사람들이 무엇에 관심이 많은지를 보여 주는 공개 자료다. 언론사 "많이 본 뉴스" RSS 는 연합·한경 404, 뉴시스는 비어 있었고,
   * 네이버·다음 순위는 RSS 가 없어 긁어 와야 하므로 쓰지 않는다(2026-10-01). */
  { category: 'popular',  source: '구글 트렌드', url: 'https://trends.google.com/trending/rss?geo=KR', trends: true },

  /* IT — 전용 매체만 쓴다.
   * 연합 industry.xml 은 대체로 IT·과학이지만 지역·행정 기사가 섞여서 제외했다.
   * (실제로 "해경청 체력증진 프로그램"이 IT 칸에 올라왔다)
   * 전자신문 피드는 이름 없이 번호만 있다. 20 은 과학·의료·바이오라 뺐다 — 한 시간에 14건씩 올라오는
   * 제약 기사가 IT 칸을 통째로 차지했다(2026-10-01). 내용을 보고 03(통신·인터넷·게임)·04(SW·보안)를 골랐다.
   * 출처마다 건수(limit)를 나눈다. ZDNet 피드는 두 시간가량 늦게 갱신돼 최신순으로만 뽑으면 0건이 된다. */
  { category: 'it',       source: 'ZDNet Korea', url: 'https://feeds.feedburner.com/zdkorea', limit: 6 },
  { category: 'it',       source: '전자신문',    url: 'https://rss.etnews.com/03.xml', limit: 4 },  // 통신·인터넷·게임
  { category: 'it',       source: '전자신문',    url: 'https://rss.etnews.com/04.xml', limit: 4 },  // SW·보안 (지자체 인사가 가끔 섞인다)
  /* 한국경제 it 피드는 이름만 IT 다. 실제로는 바이오·제약·건강·연예가 대부분이라 뺐다.
   * ("담배 끊어도 이것 쓰면 심혈관질환 위험 70%" 가 IT 대표 기사로 올라왔다) */

  { category: 'econ',     source: '연합뉴스',    url: 'https://www.yna.co.kr/rss/economy.xml' },
  { category: 'econ',     source: '한국경제',    url: 'https://www.hankyung.com/feed/economy' },

  /* 글로벌 경제 — 연합인포맥스는 증권사·운용사 실무자가 보는 금융 전문 통신이다. S1N23 이 국제 섹션
   * (뉴욕 선물·미 국채·일본 PMI 등). 뉴시스 국제는 경제 기사만 골라 보조로 쓴다. */
  { category: 'globalecon', source: '연합인포맥스', url: 'https://news.einfomax.co.kr/rss/S1N23.xml' },
  { category: 'globalecon', source: '뉴시스',      url: 'https://www.newsis.com/RSS/international.xml',
    titleFilter: GLOBAL_ECON_WORDS },

  /* 투자 — 포털 첫 화면에는 잘 안 오르는 '시장 안쪽' 소식. 섹션마다 건수(limit)를 나눠
   * 한 섹션이 칼럼을 다 차지하지 않게 했다. 합이 PER_CATEGORY(14) 를 넘지 않게 맞춘다.
   * 섹션 번호는 내용을 보고 확인했다. S1N1~6 은 2017년에 멈춘 옛 섹션이라 쓰지 않는다. */
  { category: 'invest', source: '연합인포맥스', url: 'https://news.einfomax.co.kr/rss/S1N9.xml',  limit: 3 },  // 채권·외환 분석, 뉴욕 시황
  { category: 'invest', source: '연합인포맥스', url: 'https://news.einfomax.co.kr/rss/S1N16.xml', limit: 2 },  // 채권·외환 시장
  { category: 'invest', source: '연합인포맥스', url: 'https://news.einfomax.co.kr/rss/S1N21.xml', limit: 3 },  // 해외주식 (투자의견·실적)
  { category: 'invest', source: '연합인포맥스', url: 'https://news.einfomax.co.kr/rss/S1N2.xml',  limit: 2 },  // 자본시장·IB·펀드
  /* 공시는 기사가 나오기 전의 1차 정보다. 하루 150건 넘게 나오므로 중요한 종류만 골라
   * 무게가 큰 것부터 4건을 올리고, 공시명은 쉬운 말로 풀어 쓴다 (DISCLOSURES). */
  { category: 'invest', source: '한국거래소 공시', url: KIND_URL, disclosure: true, limit: 4 },

  /* 정치·사회 — 예전 '국내 종합' 칸(연합 정치+사회 피드를 합친 것)을 둘로 나눴다.
   * 빠지는 피드 없이 칸만 갈렸다. 통신사 두 곳(연합·뉴시스)을 쓴다. */
  { category: 'politics', source: '연합뉴스',    url: 'https://www.yna.co.kr/rss/politics.xml' },
  { category: 'politics', source: '뉴시스',      url: 'https://www.newsis.com/RSS/politics.xml' },
  { category: 'society',  source: '연합뉴스',    url: 'https://www.yna.co.kr/rss/society.xml' },
  { category: 'society',  source: '뉴시스',      url: 'https://www.newsis.com/RSS/society.xml' },

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
const TITLE_BLOCK = /^\[(게시판|부고|인사|동향|표|영상|포토|사진|알림|기고|카드뉴스|주요 일정)\]|선발투수|매물마당|주요 뉴스|이 시각 헤드라인|오늘의 날씨|환율\s*=|증시\s*=/;

/* 공시 — 투자자에게 의미 있는 종류만 고르고, 공시명을 쉬운 말로 푼다.
 * [공시명 패턴, 무게, 쉬운 이름, 풀이]. 패턴은 공시명에서 띄어쓰기를 지운 글자에 건다
 * ("현금ㆍ현물 배당 결정" 과 "현금ㆍ현물배당 결정" 이 둘 다 온다).
 * 무게가 큰 것부터 올린다. 임원 지분 변동처럼 하루 수십 건 나오는 것은 무게를 낮춰
 * 합병·최대주주 변경 같은 드문 공시를 밀어내지 않게 했다.
 * 반기보고서·투자설명서·ETF 안내처럼 자주 나오지만 읽을 게 없는 것은 목록에 없어서 빠진다.
 * 풀이는 공시 종류의 일반적인 뜻만 적는다. 이 공시가 호재인지 악재인지는 말하지 않는다. */
const DISCLOSURES = [
  [/최대주주변경/, 5, '최대주주 변경', '회사의 최대주주가 바뀌었거나 바뀌게 된다는 공시입니다. 경영권이 함께 넘어가는 경우가 많습니다.'],
  [/공개매수/, 5, '공개매수', '정해진 값과 기간에 장 밖에서 주식을 사들이겠다고 공개적으로 알리는 것입니다. 경영권 확보나 상장폐지가 목적인 경우가 흔합니다.'],
  [/^회사(분할)?합병결정/, 5, '합병 결정', '다른 회사와 하나로 합치기로 했다는 공시입니다. 합병 비율과 일정이 원문에 나옵니다.'],
  [/^회사분할결정/, 5, '회사 분할', '회사를 둘 이상으로 나누기로 했다는 공시입니다. 기존 주주가 새 회사 주식을 받는지(인적분할), 새 회사를 자회사로 두는지(물적분할)가 원문에 나옵니다.'],
  [/상장폐지/, 5, '상장폐지 관련', '상장폐지 결정·절차·이의 제기처럼 주식이 거래소에서 빠지는 일과 관련된 공시입니다. 사유와 일정이 원문에 나옵니다.'],
  [/횡령|배임/, 5, '횡령·배임 혐의', '경영진 등의 횡령·배임 혐의가 드러났다는 공시입니다. 금액이 크면 거래 정지나 상장 적격성 심사로 이어질 수 있습니다.'],
  [/유상증자결정/, 4, '유상증자', '새 주식을 팔아 돈을 모으기로 했다는 공시입니다. 주식 수가 늘어 기존 주주의 지분 비율이 낮아질 수 있습니다.'],
  [/무상증자결정/, 4, '무상증자', '주주에게 돈을 받지 않고 새 주식을 나눠주는 결정입니다. 주식 수는 늘지만 회사 가치 자체가 바뀌는 것은 아닙니다.'],
  [/자기주식취득결정|자기주식취득신탁계약체결/, 4, '자사주 매입', '회사가 자기 회사 주식을 사들이기로 했다는 공시입니다. 흔히 주주환원 정책으로 분류됩니다.'],
  [/주식소각결정/, 4, '주식 소각', '회사가 가진 자기 주식을 없애 전체 주식 수를 줄이기로 했다는 공시입니다. 흔히 주주환원 정책으로 분류됩니다.'],
  [/영업양수|영업양도/, 4, '영업 양수도', '사업 부문을 다른 회사에 넘기거나 넘겨받기로 했다는 공시입니다.'],
  [/매출액또는손익구조/, 3, '실적 크게 변동', '매출이나 손익이 지난해보다 크게(대규모법인 15%, 그 밖에는 30% 이상) 달라졌다는 공시입니다.'],
  [/영업\(잠정\)실적/, 3, '잠정 실적', '결산이 끝나기 전에 실적을 먼저 알리는 공시입니다.'],
  [/단일판매ㆍ?공급계약/, 3, '대규모 공급계약', '매출 규모에 비해 큰 판매·공급 계약을 맺었다는 공시입니다. 계약 금액이 최근 매출의 몇 %인지 원문에 나옵니다.'],
  [/타법인주식및출자증권(취득|처분)결정/, 3, '다른 회사 지분 취득·처분', '다른 회사 주식을 사거나 팔기로 했다는 공시입니다. 인수·투자 목적인지 원문에 나옵니다.'],
  [/전환사채권발행결정/, 3, '전환사채(CB) 발행', '나중에 주식으로 바꿀 수 있는 회사채를 발행한다는 공시입니다. 주식으로 바뀌면 주식 수가 늘어납니다.'],
  [/신주인수권부사채권발행결정/, 3, '신주인수권부사채(BW) 발행', '정해진 값에 새 주식을 살 권리가 붙은 회사채를 발행한다는 공시입니다. 권리를 쓰면 주식 수가 늘어납니다.'],
  [/현금ㆍ?현물배당결정/, 3, '배당 결정', '주주에게 줄 배당을 정했다는 공시입니다. 주당 배당금과 기준일이 원문에 나옵니다.'],
  [/기업가치제고계획/, 3, '밸류업 계획', '주주가치를 높이기 위한 회사의 중장기 계획(이른바 밸류업 공시)입니다.'],
  [/자기주식처분결정/, 2, '자사주 처분', '회사가 가진 자기 주식을 팔거나 나눠주기로 했다는 공시입니다. 시장에 풀리는 주식이 늘 수 있습니다.'],
  [/주식등의대량보유상황보고서/, 2, '5% 이상 지분 신고', '누군가 이 회사 주식을 5% 넘게 갖게 됐거나, 이미 5% 이상 가진 쪽의 지분이 1%p 이상 바뀌었다는 신고입니다. 경영 참여 목적인지도 원문에 적힙니다.'],
  [/특정증권등거래계획보고서/, 2, '임원·대주주 매매 예고', '임원이나 주요주주가 일정 규모 이상의 주식을 사거나 팔 계획을 미리 알리는 신고입니다.'],
  [/특정증권등소유상황보고서/, 1, '임원·대주주 지분 변동', '임원이나 지분 10% 이상 주요주주가 이 회사 주식을 사거나 팔았다는 신고입니다. 산 것인지 판 것인지는 원문에서 확인하세요.'],
];

/* KIND 제목 앞의 시장 표시. [유]=유가증권시장 */
const MARKETS = { '유': '코스피', '코': '코스닥', '넥': '코넥스' };

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

/** 통신사 머리말을 떼어낸다. 짧은 요약 자리를 잡아먹는다.
 *  연합은 "(서울=연합뉴스) 홍길동 기자 = ", 뉴시스는 "[서울=뉴시스] 홍길동 김철수 기자 = " 처럼
 *  괄호 모양이 다르다. 기자 외에 특파원·통신원·앵커 표기도 쓰인다. */
function stripByline(s) {
  return String(s)
    .replace(/^[(\[][^)\]]{2,40}[)\]]\s*[^=]{0,25}?(기자|특파원|통신원|앵커)\s*=\s*/, '')
    .replace(/^[(\[][^)\]]{2,40}[)\]]\s*=\s*/, '')
    .trim();
}

/** 요약에서 읽을거리가 아닌 것을 지운다.
 *  - 이메일 주소: 뉴시스는 요약 끝에 기자 이메일을 붙여 보낸다. 저장소에 이메일을 넣지 않는다(AGENTS.md 2항).
 *  - 속보에 붙는 안내 문구: "후속기사가 이어집니다", "◎공감언론 뉴시스"
 *  자르기(truncate) 전에 지워야 한다. 잘린 뒤에는 "kje1321@news…" 처럼 이메일 모양이 깨져 안 걸린다. */
function scrubSummary(s) {
  return String(s)
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, ' ')
    .replace(/◎\s*공감언론\s*뉴시스/g, ' ')
    .replace(/후속\s*기사가\s*이어집니다\.?/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 문단 사이 줄바꿈을 그냥 지워 보내는 피드가 있다 — 연합인포맥스는 "세웠다.한국은행이" 로 온다.
 *  문장 끝 "다." 뒤에 글자가 바로 붙으면 한 칸 띄운다. 숫자(1.5)·말줄임은 건드리지 않는다. */
function spaceSentences(s) {
  return String(s).replace(/다\.(?=[가-힣A-Za-z"'“‘(\[])/g, '다. ');
}

/** 주소의 쿼리에 들어 있는 글 번호 (zdnet.co.kr/view/?no=…, articleView.html?idxno=…, disclsviewer.do?acptNo=…).
 *  이런 주소는 ? 앞이 그 매체의 모든 기사에서 같다. ? 앞만 보면 전부 같은 기사로 보여 하나만 남는다
 *  — ZDNet 이 실제로 IT 칸에 늘 1건만 남았고 id 가 it-view 였다. */
function articleNo(url) {
  try {
    for (const v of new URL(url).searchParams.values()) if (/^\d{5,}$/.test(v)) return v;
  } catch (e) { /* 주소가 이상하면 번호 없음으로 본다 */ }
  return '';
}

/** 중복 판단에 쓰는 주소. 추적용 쿼리는 버리고 글 번호만 남긴다 */
function canonicalUrl(url) {
  const base = url.split('#')[0].split('?')[0];
  const no = articleNo(url);
  return no ? base + '?' + no : base;
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

/* 같은 주소를 여러 칸이 나눠 쓴다 (연합 경제 → 경제·부동산·속보, 연합 정치 → 정치·속보).
 * 한 번 실행에서 주소마다 한 번만 받는다. 언론사 서버에 같은 요청을 거듭 보내지 않는다. */
const downloads = new Map();
function fetchFeed(feed) {
  if (!downloads.has(feed.url)) downloads.set(feed.url, download(feed.url));
  return downloads.get(feed.url);
}

/* 연결이 끊기거나 서버가 5xx 로 답하면 잠깐 쉬고 한 번 더 받는다. 전자신문은 GitHub 서버에서 가끔
 * 연결이 끊긴다(2026-10-01, 최근 6번 중 3번 "fetch failed"). 4xx 는 다시 받아도 같으므로 바로 실패로 둔다. */
const retryMs = () => Number(process.env.NEWS_RETRY_MS) || 3000;   // 테스트는 짧게 줄여 쓴다
async function download(url) {
  try {
    return await downloadOnce(url);
  } catch (e) {
    if (/^HTTP 4/.test(e.message)) throw e;
    await new Promise(r => setTimeout(r, retryMs()));
    return downloadOnce(url);
  }
}

/** 실패 까닭. Node fetch 는 "fetch failed" 만 말하고 진짜 까닭(ECONNRESET 등)은 cause 에 넣는다 */
function why(e) {
  if (!e) return '알 수 없음';
  const c = e.cause && (e.cause.code || e.cause.message);
  return (e.message || String(e)) + (c ? ' (' + c + ')' : '');
}

async function downloadOnce(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
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
  if (feed.trends) return parseTrends(xml, feed);
  const blocks = xml.match(/<(item|entry)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi) || [];
  const out = [];

  for (const b of blocks) {
    const title = truncate(clean(pick(b, 'title')), 120);
    const link = pickLink(b);
    if (!title || !/^https?:\/\//.test(link)) continue;

    const dateStr = clean(pick(b, 'pubDate') || pick(b, 'published') || pick(b, 'updated') || pick(b, 'dc:date'));
    const t = new Date(dateStr);
    const publishedAt = isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString();

    if (feed.disclosure) {
      const d = parseDisclosure(title, clean(pick(b, 'author')), link);
      if (d) out.push(Object.assign({ category: feed.category, source: feed.source, publishedAt }, d));
      continue;
    }

    /* 목록·공지성 기사 제외 */
    if (TITLE_BLOCK.test(title)) continue;

    /* 이 피드가 키워드 조건을 걸어둔 경우 (부동산처럼 전용 피드가 없는 분야) */
    if (feed.titleFilter && !feed.titleFilter.test(title)) continue;

    /* 지난 소식을 빼는 피드 (속보: 분야 피드는 며칠치를 담고 있다) */
    if (feed.maxAgeHours && Date.now() - new Date(publishedAt).getTime() > feed.maxAgeHours * 3600000) continue;

    const rawSum = pick(b, 'description') || pick(b, 'summary') || pick(b, 'content:encoded') || pick(b, 'content');
    let summary = stripByline(truncate(spaceSentences(scrubSummary(clean(rawSum))), SUMMARY_MAX));
    /* "(" 나 "[서울=뉴시스]" 만 남은 것은 요약이 아니다. 요약이 있는 척하면 칸의 대표 기사로 뽑힌다 */
    if (summary.length < SUMMARY_MIN) summary = '';

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

  /* 한 칼럼을 여러 피드가 나눠 쓸 때 피드마다 몫(limit)을 정해 둔다. 무게(공시)가 큰 것, 그다음 최신 것부터 몫을 채운다.
   * 몫 밖의 기사는 버리지 않고 spare(예비)로 남긴다. 다른 피드가 실패하거나 모자라면 빈자리를 채운다(fillCategories).
   * 예전에는 잘라 버려서, 전자신문이 실패한 차례에 IT 칸이 ZDNet 몫 6건만 남았다. */
  if (feed.limit) {
    out.sort((a, b) => ((b.weight || 0) - (a.weight || 0)) || (new Date(b.publishedAt) - new Date(a.publishedAt)));
    out.forEach((a, i) => { if (i >= feed.limit) a.spare = true; });
  }
  out.forEach(a => { delete a.weight; });
  return out;
}

/**
 * 구글 트렌드(한국) — 주제마다 검색량(ht:approx_traffic, "10000+")과 관련 기사(ht:news_item) 몇 건이 온다.
 * 주제의 첫 기사를 올리고, 검색량이 많은 순(같으면 최근 순)으로 순위(rank)를 매긴다.
 * 출처는 그 기사를 쓴 언론사다. 주소도 언론사 원문이다. 요약은 오지 않는다.
 */
function parseTrends(xml, feed) {
  const out = [];
  for (const b of xml.match(/<item>[\s\S]*?<\/item>/gi) || []) {
    const topic = clean(pick(b, 'title'));
    if (!topic) continue;

    /* 주제마다 기사가 세 건쯤 온다. 한국어 기사만 남기고, 그중 국내 매체를 먼저 고른다.
     * - 한글이 없는 기사는 뺀다. 미국 서버(Actions)에서 받으면 한국 목록에 다른 나라 주제가 섞여 올 때가 있다
     *   (2026-10-01 태국 "ตรวจหวย"(복권 확인)·Sanook.com 이 10위로 올라왔다. 이 PC 에서 받은 목록에는 없었다).
     *   한국어 기사가 하나도 없는 주제는 통째로 뺀다.
     * - 한국이 아닌 나라 주소(.vn·.th 등)는 뒤로 미룬다. 베트남 매체의 한국어판(ko.laodong.vn)이 첫 기사로 와서
     *   다음·스포츠조선 대신 뽑힌 적이 있다. */
    const news = (b.match(/<ht:news_item>[\s\S]*?<\/ht:news_item>/gi) || []).map(n => {
      const source = clean(pick(n, 'ht:news_item_source'));
      let title = clean(pick(n, 'ht:news_item_title'));
      /* 제목 끝에 "- 머니투데이" 처럼 언론사 이름이 붙어 오기도 한다. 출처 칸에 따로 있으므로 뗀다 */
      if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3)).trim();
      return { source, title, url: clean(pick(n, 'ht:news_item_url')) };
    }).filter(n => n.title && /^https?:\/\//.test(n.url) && HANGUL.test(n.title));
    if (!news.length) continue;
    const { source, title, url } = news.find(n => !foreignHost(n.url)) || news[0];

    const traffic = Number(clean(pick(b, 'ht:approx_traffic')).replace(/[^\d]/g, '')) || 0;
    const t = new Date(clean(pick(b, 'pubDate')));
    out.push({
      category: feed.category,
      source: source || feed.source,
      title: truncate(title, 120),
      summary: '',
      url,
      publishedAt: isNaN(t.getTime()) ? new Date().toISOString() : t.toISOString(),
      topic: topic + ' · 검색 ' + trafficLabel(traffic),
      keywords: [topic],
      points: [],
      traffic,
    });
  }
  out.sort((a, b) => (b.traffic - a.traffic) || (new Date(b.publishedAt) - new Date(a.publishedAt)));
  out.forEach((a, i) => { a.rank = i + 1; delete a.traffic; });
  return out;
}

const HANGUL = /[가-힣]/;

/** 한국이 아닌 나라 주소인가 (끝이 두 글자 나라 이름이고 kr 이 아님: .vn .th .jp …). .com·.net 은 아니다 */
function foreignHost(url) {
  try {
    const tld = new URL(url).hostname.split('.').pop();
    return /^[a-z]{2}$/.test(tld) && tld !== 'kr';
  } catch (e) { return true; }
}

/** 10000 → "1만+", 2000 → "2천+", 500 → "500+" (구글이 주는 어림값이다) */
function trafficLabel(n) {
  if (n >= 10000) return (n / 10000) + '만+';
  if (n >= 1000) return (n / 1000) + '천+';
  return n + '+';
}

/**
 * KIND 공시 한 건을 기사 모양으로 바꾼다. 고르지 않는 종류면 null.
 *
 * 제목 "[코]벡트 주식등의대량보유상황보고서(일반)" → "[공시] 벡트 · 5% 이상 지분 신고"
 * 공시는 요약(description)을 주지 않는다. 풀이는 summary 가 아니라 points 에 넣는다.
 * summary 에 넣으면 카테고리 대표(주요) 자리를 공시가 차지한다 — 대표는 요약이 있는 기사 중에서 뽑기 때문이다.
 */
function parseDisclosure(title, author, link) {
  /* author 가 "[코]벡트" 로 회사명을 정확히 준다. 없으면 제목 첫 덩어리를 회사명으로 본다 */
  let m = author && title.indexOf(author) === 0 ? [null, author, title.slice(author.length)] : title.match(/^(\[[^\]]+\]\S+)\s+(.*)$/);
  if (!m) return null;
  const tag = m[1].match(/^\[([^\]]+)\](.+)$/);
  if (!tag) return null;
  const company = tag[2].trim();
  const name = m[2].trim();

  /* 정정 공시는 같은 내용을 고쳐 낸 것이라 뺀다 ([정정], [기재정정], [첨부정정]) */
  if (!company || !name || /정정/.test(name)) return null;

  const key = name.replace(/\s+/g, '');
  const rule = DISCLOSURES.find(r => r[0].test(key));
  if (!rule) return null;

  /* KIND 는 http://kind.krx.co.kr:80/… 으로 준다. https 로도 같은 화면이 열린다 */
  let url = link;
  try {
    const u = new URL(link);
    if (u.hostname === 'kind.krx.co.kr') { u.protocol = 'https:'; u.port = ''; url = u.toString(); }
  } catch (e) { /* 그대로 둔다 */ }

  return {
    title: '[공시] ' + company + ' · ' + rule[2],
    summary: '',
    points: [rule[3], '공시명: ' + name],
    keywords: ['공시', MARKETS[tag[1]], rule[2]].filter(Boolean),
    url,
    weight: rule[1],
  };
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
    const key = a.category + '|' + canonicalUrl(a.url);
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
  /* 링크에서 안정적인 조각을 뽑아 id 로 쓴다. 읽음 표시가 갱신 후에도 유지되게 하려는 것.
   * 글 번호가 쿼리에 있는 주소는 경로 끝(view, articleView.html)이 모두 같으므로 번호를 쓴다. */
  const tail = articleNo(a.url) || a.url.split('?')[0].split('/').filter(Boolean).pop() || String(i);
  return a.category + '-' + tail.replace(/[^A-Za-z0-9._-]/g, '').slice(-40);
}

/**
 * 기사를 칸에 나눠 담는다. 칸마다 PER_CATEGORY 건까지.
 * 몫 안의 기사(spare 가 아닌 것)를 최신 순으로 먼저 담고, 남는 자리를 몫 밖의 기사로 채운다.
 * 중복을 지울 때도 몫 안의 것을 남긴다. 순위가 있는 칸(rank)은 순위대로 놓고 번호를 1부터 다시 매긴다.
 */
function fillCategories(list) {
  const byCat = {};
  CATEGORIES.forEach(c => { byCat[c.key] = []; });
  const newest = (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt);

  dedupeWithin(list.slice().sort((a, b) => (Number(!!a.spare) - Number(!!b.spare)) || newest(a, b)))
    .forEach(a => {
      if (byCat[a.category] && byCat[a.category].length < PER_CATEGORY) byCat[a.category].push(a);
    });

  CATEGORIES.forEach(c => {
    const l = byCat[c.key];
    l.forEach(a => { delete a.spare; });
    if (c.rank) l.sort((a, b) => a.rank - b.rank).forEach((a, i) => { a.rank = i + 1; });
    else l.sort(newest);
  });
  return byCat;
}

async function main() {
  const results = await Promise.allSettled(FEEDS.map(async f => {
    const xml = await fetchFeed(f);
    const items = parseItems(xml, f);
    const spare = items.filter(a => a.spare).length;
    console.log('  ok   ' + f.category.padEnd(9) + f.source.padEnd(12) + (items.length - spare) + '건' +
      (spare ? ' (+예비 ' + spare + ')' : '') + '  ' + f.url);
    return items;
  }));

  const collected = [];
  let failed = 0;
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') collected.push.apply(collected, r.value);
    else {
      failed++;
      console.warn('  FAIL ' + FEEDS[i].category.padEnd(9) + FEEDS[i].source.padEnd(12) +
        why(r.reason) + '  ' + FEEDS[i].url);
    }
  });

  /* 피드 하나가 죽어도 나머지로 계속한다. 다만 전부 실패면 빈 파일을 쓰지 않는다. */
  if (!collected.length) {
    console.error('\n기사를 하나도 못 받았습니다. 기존 데이터를 유지하고 종료합니다.');
    process.exit(1);
  }

  const byCat = fillCategories(collected);

  assignImportance(byCat);

  const articles = [];
  CATEGORIES.forEach(c => {
    byCat[c.key].forEach((a, i) => {
      a.id = makeId(a, i);
      a.keywords = a.keywords || [];   // 공시는 시장·종류를, 풀이는 points 로 넣어 둔다
      a.points = a.points || [];
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

  /* Actions 에 실패한 피드 수를 알린다. 저장소 사본은 실패 없는 차례에만 하루 한 번 커밋한다(fetch-news.yml).
   * 실패한 순간의 사본이 저장소에 남으면 그 칸이 비거나 한 출처만 남아 저장소의 테스트가 실패한다. */
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, 'failed=' + failed + '\n');

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

module.exports = {
  clean, decodeEntities, stripByline, scrubSummary, spaceSentences, articleNo, canonicalUrl, parseItems,
  parseTrends, trafficLabel, fillCategories, dedupeWithin, makeId, why, download,
  CATEGORIES, FEEDS, PER_CATEGORY, GLOBAL_ECON_WORDS, BREAKING_WORDS,
};
