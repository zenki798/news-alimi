/* ===========================================================
   목업 뉴스 데이터
   ---------------------------------------------------------
   실제 뉴스가 아니다. 화면과 구조를 잡기 위한 견본이다.

   출처명도 일부러 가상으로 지었다. 실제 언론사 이름을 붙이면 없는 기사를
   그 언론사가 쓴 것처럼 보이게 되므로 그렇게 하지 않는다.

   나중에 실제 뉴스로 교체할 때는 이 파일만 갈아끼운다.
   window.NewsData.articles 가 아래 형태를 지키면 화면 코드는 그대로 동작한다.

     {
       id,          고유 문자열
       category,    CATEGORIES 의 key
       source,      출처 이름
       title,       제목
       summary,     2~3줄 요약
       points,      핵심 포인트 배열 (없으면 빈 배열)
       keywords,    키워드 배열
       url,         원문 주소
       importance,  1~3 (3이 가장 중요, 상단 하이라이트에 올라간다)
       publishedAt, ISO 8601 문자열
     }

   목업은 publishedAt 대신 minutesAgo(분 단위 경과)로 적어둔다.
   언제 열어도 방금 들어온 뉴스처럼 보이게 하려는 것이고,
   로드 시점에 ISO 문자열로 변환된다.
   =========================================================== */
(function (global) {
  'use strict';

  /* scripts/fetch-news.js 의 CATEGORIES 와 같아야 한다 (tests/collector.spec.js 가 비교한다) */
  const CATEGORIES = [
    { key: 'breaking',   name: '주요 속보',   color: '#ff4b4b', wide: true },
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

  /* 견본 기사. 실제 사건이 아니다. */
  const RAW = [
    /* ---------- 많이 찾는 뉴스 ----------
       실제 수집물처럼 순위(rank)와 "주제 · 검색량"(topic)이 붙는다. 요약은 없다 */
    {
      id: 'pop-01', category: 'popular', source: '견본일보', importance: 3, minutesAgo: 15, rank: 1,
      topic: '단풍 절정 · 검색 1만+', title: '올가을 단풍 절정 다음 주…지역별 예상 시기',
      summary: '', keywords: ['단풍'],
      url: 'https://example.com/news/pop-01',
    },
    {
      id: 'pop-02', category: 'popular', source: '가상경제', importance: 2, minutesAgo: 50, rank: 2,
      topic: '배당주 · 검색 5천+', title: '찬바람 불면 배당주? 연말 배당 일정 정리',
      summary: '', keywords: ['배당'],
      url: 'https://example.com/news/pop-02',
    },
    {
      id: 'pop-03', category: 'popular', source: '견본스포츠', importance: 1, minutesAgo: 90, rank: 3,
      topic: '아시아선수권 · 검색 2천+', title: '대표팀 결승 상대 확정…경기 일정은',
      summary: '', keywords: ['스포츠'],
      url: 'https://example.com/news/pop-03',
    },

    /* ---------- 주요 속보 ----------
       실제 수집물처럼 통신사의 [속보] 표시가 붙은 제목만 두고, 요약은 비운다 (속보는 제목만 먼저 나온다) */
    {
      id: 'brk-01', category: 'breaking', source: '속보데스크', importance: 3, minutesAgo: 6,
      title: '[속보] 국회 본회의, 데이터 기본법 개정안 가결',
      summary: '', keywords: ['국회', '법안'],
      url: 'https://example.com/news/brk-01',
    },
    {
      id: 'brk-02', category: 'breaking', source: '속보데스크', importance: 2, minutesAgo: 41,
      title: '[속보] 기상청, 남해안 일대 호우경보로 상향',
      summary: '', keywords: ['날씨', '호우'],
      url: 'https://example.com/news/brk-02',
    },
    {
      id: 'brk-03', category: 'breaking', source: '속보데스크', importance: 1, minutesAgo: 180,
      title: '[1보] 대표팀, 아시아선수권 결승 진출',
      summary: '', keywords: ['스포츠'],
      url: 'https://example.com/news/brk-03',
    },

    /* ---------- IT·개발·AI ---------- */
    {
      id: 'it-01', category: 'it', source: '테크브리핑', importance: 3, minutesAgo: 24,
      title: '국내 클라우드 3사, AI 추론 전용 요금제 동시 출시',
      summary: '주요 클라우드 사업자들이 AI 모델 추론에 특화된 요금제를 내놓았다. 기존 GPU 시간제 과금 대신 처리한 토큰 수로 계산하는 방식이다. 소규모 서비스의 초기 비용 부담이 줄어들 것으로 보인다.',
      points: ['GPU 시간제 → 토큰 기반 과금으로 전환', '최소 약정 물량 폐지', '스타트업 대상 첫 3개월 할인'],
      keywords: ['클라우드', 'AI 추론', '요금제'],
      url: 'https://example.com/news/it-01',
    },
    {
      id: 'it-02', category: 'it', source: '테크브리핑', importance: 2, minutesAgo: 78,
      title: '오픈소스 웹 프레임워크 메이저 버전 공개, 빌드 속도 40% 개선',
      summary: '널리 쓰이는 웹 프레임워크가 메이저 업데이트를 내놓았다. 번들러를 교체해 빌드 시간을 크게 줄였고, 설정 파일 구조가 단순해졌다. 다만 일부 플러그인은 호환이 깨져 마이그레이션이 필요하다.',
      points: ['빌드 시간 평균 40% 단축', '설정 파일 항목 절반으로 축소', '구 버전 플러그인 일부 호환 불가'],
      keywords: ['오픈소스', '프론트엔드', '빌드'],
      url: 'https://example.com/news/it-02',
    },
    {
      id: 'it-03', category: 'it', source: '디지털리포트', importance: 2, minutesAgo: 155,
      title: '사내 AI 도구 도입 기업 62%, "가장 큰 걸림돌은 데이터 정리"',
      summary: '국내 기업 실무자 설문에서 AI 도입의 최대 장애물로 데이터 품질이 꼽혔다. 모델 성능이나 비용보다 사내 문서와 데이터가 정리되지 않은 문제가 더 크다는 응답이 많았다.',
      points: ['1위 데이터 품질(62%), 2위 보안 규정(41%)', '모델 성능 불만은 18%에 그침', '전담 인력 부재가 공통 애로'],
      keywords: ['기업 AI', '데이터 품질', '설문'],
      url: 'https://example.com/news/it-03',
    },
    {
      id: 'it-04', category: 'it', source: '테크브리핑', importance: 1, minutesAgo: 320,
      title: '브라우저 오디오 API 사양 개정안 논의 시작',
      summary: '웹 표준화 기구가 오디오 처리 API의 개정 논의를 시작했다. 워크릿 로딩 제약과 오프라인 렌더링 성능이 주요 안건에 올랐다.',
      points: ['워크릿 로딩 제약 완화 검토', '오프라인 렌더링 성능 지표 표준화'],
      keywords: ['웹 표준', '오디오'],
      url: 'https://example.com/news/it-04',
    },

    /* ---------- 경제·증시 ---------- */
    {
      id: 'econ-01', category: 'econ', source: '마켓데일리', importance: 3, minutesAgo: 12,
      title: '코스피 2,900선 회복, 외국인 8일 연속 순매수',
      summary: '지수가 장중 상승 전환해 2,900선을 회복했다. 외국인이 8거래일 연속 순매수를 이어갔고 반도체와 2차전지가 상승을 주도했다. 거래대금은 전일보다 늘었다.',
      points: ['외국인 8일 연속 순매수', '반도체·2차전지 주도', '거래대금 전일 대비 증가'],
      keywords: ['코스피', '외국인', '반도체'],
      url: 'https://example.com/news/econ-01',
    },
    {
      id: 'econ-02', category: 'econ', source: '마켓데일리', importance: 3, minutesAgo: 47,
      title: '원·달러 환율 1,340원대 진입, 3개월 만에 최저',
      summary: '달러 약세와 수출 개선 기대가 겹치며 환율이 1,340원대로 내려왔다. 3개월 만의 최저 수준이다. 수입 물가 부담이 완화될 것으로 전망된다.',
      points: ['3개월 만에 1,340원대', '달러 인덱스 하락 영향', '수입 물가 부담 완화 기대'],
      keywords: ['환율', '달러', '물가'],
      url: 'https://example.com/news/econ-02',
    },
    {
      id: 'econ-03', category: 'econ', source: '경제관측', importance: 2, minutesAgo: 190,
      title: '8월 소비자물가 상승률 2.1%, 넉 달째 둔화',
      summary: '소비자물가 상승률이 넉 달 연속 둔화했다. 농산물 가격 안정이 주된 요인으로 꼽혔으나 외식과 공공요금은 여전히 오름세를 유지했다.',
      points: ['전년 동월 대비 2.1% 상승', '농산물 안정이 둔화 견인', '외식·공공요금은 상승 지속'],
      keywords: ['물가', '소비자물가', '통계'],
      url: 'https://example.com/news/econ-03',
    },

    /* ---------- 글로벌 경제 ---------- */
    {
      id: 'gec-01', category: 'globalecon', source: '해외시장노트', importance: 3, minutesAgo: 18,
      title: '미국 장기 국채금리 오름세, 달러 강세 사흘째',
      summary: '미국 10년물 국채금리가 사흘 연속 올랐다. 소비 지표가 예상보다 강하게 나오면서 금리 인하 기대가 줄어든 영향이다. 달러도 주요 통화 대비 강세를 이어갔다.',
      points: ['10년물 금리 사흘 연속 상승', '강한 소비 지표가 배경', '달러 주요 통화 대비 강세'],
      keywords: ['미국 국채', '금리', '달러'],
      url: 'https://example.com/news/gec-01',
    },
    {
      id: 'gec-02', category: 'globalecon', source: '해외시장노트', importance: 2, minutesAgo: 95,
      title: '유럽 제조업 경기지수 석 달 만에 반등',
      summary: '유로존 제조업 구매관리자지수(PMI)가 석 달 만에 올랐다. 신규 주문이 늘었지만 기준선인 50에는 아직 못 미친다.',
      points: ['석 달 만에 반등', '신규 주문 증가', '기준선 50 아래'],
      keywords: ['유럽', 'PMI', '제조업'],
      url: 'https://example.com/news/gec-02',
    },
    {
      id: 'gec-03', category: 'globalecon', source: '글로벌머니', importance: 1, minutesAgo: 260,
      title: '국제유가, 공급 우려에 주간 상승 마감',
      summary: '산유국 감산 연장 가능성이 거론되며 국제유가가 한 주 동안 올랐다.',
      points: ['감산 연장 가능성 거론', '주간 기준 상승'],
      keywords: ['유가', '원유'],
      url: 'https://example.com/news/gec-03',
    },

    /* ---------- 투자 ---------- */
    {
      id: 'inv-01', category: 'invest', source: '투자관측', importance: 3, minutesAgo: 26,
      title: '[채권분석] 단기물 금리 하락, 시장은 연내 인하에 무게',
      summary: '국고채 단기물 금리가 내려가며 장단기 금리 차가 벌어졌다. 채권 시장 참가자들은 연내 기준금리 인하 가능성을 더 높게 보고 있다.',
      points: ['단기물 중심 금리 하락', '장단기 금리 차 확대', '연내 인하 기대 반영'],
      keywords: ['채권', '국고채', '금리'],
      url: 'https://example.com/news/inv-01',
    },
    {
      id: 'inv-02', category: 'invest', source: '투자관측', importance: 2, minutesAgo: 70,
      title: '해외 대체투자 운용사, 국내 기관 대상 사모대출 펀드 설명회',
      summary: '해외 대체투자 운용사가 국내 연기금과 보험사를 대상으로 사모대출 펀드 설명회를 열었다. 분산투자 수요를 겨냥했다.',
      points: ['연기금·보험사 대상', '사모대출 펀드 소개'],
      keywords: ['사모대출', '대체투자'],
      url: 'https://example.com/news/inv-02',
    },
    {
      /* 공시를 기사 모양으로 바꾼 견본. 실제 수집물처럼 요약은 비우고 풀이를 points 에 둔다 */
      id: 'inv-03', category: 'invest', source: '공시알림(견본)', importance: 1, minutesAgo: 150,
      title: '[공시] 견본전자 · 자사주 매입',
      summary: '',
      points: ['회사가 자기 회사 주식을 사들이기로 했다는 공시입니다. 흔히 주주환원 정책으로 분류됩니다.', '공시명: 자기주식취득결정'],
      keywords: ['공시', '자사주 매입'],
      url: 'https://example.com/news/inv-03',
    },

    /* ---------- 정치 ---------- */
    {
      id: 'pol-01', category: 'politics', source: '정치관측', importance: 3, minutesAgo: 30,
      title: '국회 상임위, 데이터 기본법 개정안 의결',
      summary: '국회 상임위원회가 데이터 기본법 개정안을 의결했다. 공공 데이터 개방 범위를 넓히고 개인정보 가명처리 기준을 구체화하는 내용이다. 본회의 표결은 다음 달로 예정됐다.',
      points: ['공공 데이터 개방 범위 확대', '가명처리 기준 구체화', '본회의 표결 다음 달'],
      keywords: ['국회', '데이터', '법안'],
      url: 'https://example.com/news/pol-01',
    },
    {
      id: 'pol-02', category: 'politics', source: '정치관측', importance: 2, minutesAgo: 120,
      title: '여야, 내년도 예산안 심사 일정 합의',
      summary: '여야가 내년도 예산안 심사 일정에 합의했다. 상임위 예비심사를 이달 안에 마치고 예결위 심사에 들어간다.',
      points: ['상임위 예비심사 이달 마무리', '이후 예결위 심사'],
      keywords: ['예산안', '국회'],
      url: 'https://example.com/news/pol-02',
    },
    {
      id: 'pol-03', category: 'politics', source: '국회노트', importance: 1, minutesAgo: 280,
      title: '선거구 획정 논의 착수, 인구 기준일 쟁점',
      summary: '다음 선거를 앞두고 선거구 획정 논의가 시작됐다. 인구 산정 기준일을 언제로 잡을지가 첫 쟁점이다.',
      points: ['획정 논의 착수', '인구 기준일이 쟁점'],
      keywords: ['선거구', '획정'],
      url: 'https://example.com/news/pol-03',
    },

    /* ---------- 사회 ---------- */
    {
      id: 'soc-01', category: 'society', source: '종합뉴스', importance: 3, minutesAgo: 35,
      title: '전국 초중고 디지털 교과서 전면 도입 일정 확정',
      summary: '교육 당국이 디지털 교과서 도입 일정을 확정했다. 내년 1학기부터 수학과 영어에 우선 적용하고 단계적으로 과목을 확대한다. 기기 보급과 교사 연수가 선행 과제로 지적됐다.',
      points: ['내년 1학기 수학·영어 우선 적용', '3년에 걸쳐 전 과목 확대', '기기 보급률과 교사 연수가 과제'],
      keywords: ['교육', '디지털 교과서'],
      url: 'https://example.com/news/soc-01',
    },
    {
      id: 'soc-02', category: 'society', source: '종합뉴스', importance: 2, minutesAgo: 112,
      title: '수도권 광역버스 준공영제 확대 시행',
      summary: '수도권 광역버스 노선에 준공영제가 추가 적용된다. 출퇴근 시간대 배차 간격이 줄어들고 입석 운행이 제한된다. 재정 부담 분담 방식은 지자체 간 협의가 남았다.',
      points: ['출퇴근 배차 간격 축소', '입석 운행 단계적 제한', '재정 분담 협의 진행 중'],
      keywords: ['교통', '광역버스'],
      url: 'https://example.com/news/soc-02',
    },
    {
      id: 'soc-03', category: 'society', source: '시민리포트', importance: 1, minutesAgo: 265,
      title: '가을 태풍 영향권, 주말 전국 비바람',
      summary: '남해상을 지나는 태풍의 영향으로 주말 전국에 비와 강풍이 예상된다. 해안 지역은 높은 물결에 주의가 필요하다.',
      points: ['토요일 밤부터 전국 강수', '해안가 강풍·높은 물결 주의'],
      keywords: ['날씨', '태풍'],
      url: 'https://example.com/news/soc-03',
    },

    /* ---------- 해외·글로벌 ---------- */
    {
      id: 'wld-01', category: 'world', source: '글로벌와치', importance: 3, minutesAgo: 58,
      title: '주요국 중앙은행, 기준금리 동결 기조 유지',
      summary: '이번 주 회의를 연 주요국 중앙은행들이 금리를 동결했다. 물가가 목표 범위에 접근했으나 인하를 논의할 단계는 아니라는 입장을 반복했다. 시장은 연내 인하 가능성을 낮춰 잡았다.',
      points: ['주요국 일제히 동결', '"인하 논의는 시기상조" 기조', '시장의 연내 인하 기대 축소'],
      keywords: ['중앙은행', '금리', '통화정책'],
      url: 'https://example.com/news/wld-01',
    },
    {
      id: 'wld-02', category: 'world', source: '글로벌와치', importance: 2, minutesAgo: 140,
      title: '반도체 공급망 재편, 동남아 생산 비중 확대',
      summary: '글로벌 반도체 기업들이 후공정 생산 기지를 동남아로 옮기고 있다. 인건비와 정책 지원이 주요 배경으로 꼽힌다. 국내 후공정 업계의 경쟁 구도에도 영향이 예상된다.',
      points: ['후공정 중심으로 이전 가속', '세제 혜택과 인건비가 배경', '국내 후공정 업계 경쟁 심화 우려'],
      keywords: ['반도체', '공급망', '동남아'],
      url: 'https://example.com/news/wld-02',
    },
    {
      id: 'wld-03', category: 'world', source: '인터내셔널', importance: 1, minutesAgo: 400,
      title: '국제 항공 운임 하락세, 여행 수요 회복 영향',
      summary: '장거리 노선 공급이 늘면서 국제 항공 운임이 내려가고 있다. 연말 성수기 예약은 전년보다 이른 시점에 시작됐다.',
      points: ['장거리 노선 공급 증가', '연말 예약 개시 시점 앞당겨짐'],
      keywords: ['항공', '여행'],
      url: 'https://example.com/news/wld-03',
    },

    /* ---------- 스포츠 ---------- */
    {
      id: 'spo-01', category: 'sports', source: '스포츠라인', importance: 3, minutesAgo: 20,
      title: '프로야구 정규시즌 1위 확정, 한국시리즈 직행',
      summary: '선두 팀이 잔여 경기 결과와 무관하게 정규시즌 1위를 확정했다. 한국시리즈에 직행하며 2주가량 휴식을 얻는다. 불펜 재정비가 관건으로 꼽힌다.',
      points: ['잔여 경기 무관 1위 확정', '한국시리즈 직행, 약 2주 휴식', '불펜 소모 회복이 과제'],
      keywords: ['프로야구', '한국시리즈'],
      url: 'https://example.com/news/spo-01',
    },
    {
      id: 'spo-02', category: 'sports', source: '스포츠라인', importance: 2, minutesAgo: 95,
      title: '유럽 축구 리그 국내 선수 3명 동시 선발 출전',
      summary: '주말 유럽 리그에서 국내 선수 3명이 같은 라운드에 선발 출전했다. 이 중 2명이 공격 포인트를 기록했다.',
      points: ['같은 라운드 3명 선발', '공격 포인트 2명 기록'],
      keywords: ['축구', '유럽리그'],
      url: 'https://example.com/news/spo-02',
    },
    {
      id: 'spo-03', category: 'sports', source: '경기속보', importance: 1, minutesAgo: 300,
      title: '국내 마라톤 대회 참가 신청 역대 최다',
      summary: '가을 마라톤 대회 참가 신청이 역대 최다를 기록했다. 10km 부문 신청자가 전년의 두 배로 늘었다.',
      points: ['전체 신청 역대 최다', '10km 부문 신청 2배 증가'],
      keywords: ['마라톤', '러닝'],
      url: 'https://example.com/news/spo-03',
    },

    /* ---------- 연예 ---------- */
    {
      id: 'ent-01', category: 'ent', source: '엔터투데이', importance: 2, minutesAgo: 40,
      title: '가을 개봉 국내 영화 3편 동시 100만 관객 돌파',
      summary: '추석 연휴에 개봉한 국내 영화 3편이 모두 100만 관객을 넘겼다. 장르가 겹치지 않아 관객층이 분산된 것이 흥행 요인으로 분석된다.',
      points: ['3편 동시 100만 돌파', '장르 분산이 흥행 요인', '연휴 좌석판매율 평균 상회'],
      keywords: ['영화', '박스오피스'],
      url: 'https://example.com/news/ent-01',
    },
    {
      id: 'ent-02', category: 'ent', source: '엔터투데이', importance: 2, minutesAgo: 130,
      title: '음원 차트 집계 방식 개편안 공개',
      summary: '음원 플랫폼들이 차트 집계 방식 개편안을 공개했다. 재생 시간 가중치를 높이고 심야 시간대 반영 비율을 낮추는 내용이다.',
      points: ['재생 시간 가중치 상향', '심야 시간대 반영 축소', '내년 1월부터 적용'],
      keywords: ['음원차트', '플랫폼'],
      url: 'https://example.com/news/ent-02',
    },
    {
      id: 'ent-03', category: 'ent', source: '컬처위크', importance: 1, minutesAgo: 355,
      title: '연말 콘서트 예매 시작, 대형 공연장 일정 조정',
      summary: '연말 공연 예매가 시작됐다. 대형 공연장 일정이 겹쳐 일부 공연은 날짜를 옮겼다.',
      points: ['연말 공연 예매 개시', '공연장 일정 중복으로 일부 변경'],
      keywords: ['콘서트', '공연'],
      url: 'https://example.com/news/ent-03',
    },

    /* ---------- 부동산 ---------- */
    {
      id: 'est-01', category: 'estate', source: '부동산관측', importance: 3, minutesAgo: 66,
      title: '수도권 아파트 거래량 4개월 연속 증가',
      summary: '수도권 아파트 매매 거래량이 넉 달째 늘었다. 대출 규제 완화 기대와 전세가 상승이 매수 전환을 이끈 것으로 분석된다. 다만 지역별 온도차가 크다.',
      points: ['4개월 연속 거래량 증가', '전세가 상승이 매수 전환 유도', '지역별 편차 확대'],
      keywords: ['아파트', '거래량', '수도권'],
      url: 'https://example.com/news/est-01',
    },
    {
      id: 'est-02', category: 'estate', source: '부동산관측', importance: 2, minutesAgo: 170,
      title: '올해 하반기 입주 물량 전년 대비 18% 감소',
      summary: '하반기 신규 입주 물량이 전년보다 줄어든다. 착공 지연이 누적된 결과로, 전세 시장에 상승 압력이 될 수 있다는 관측이 나온다.',
      points: ['하반기 입주 물량 18% 감소', '착공 지연 누적이 원인', '전세 상승 압력 우려'],
      keywords: ['입주물량', '전세'],
      url: 'https://example.com/news/est-02',
    },
    {
      id: 'est-03', category: 'estate', source: '리빙데일리', importance: 1, minutesAgo: 420,
      title: '오피스 공실률 하락, 업무 복귀 확대 영향',
      summary: '주요 업무지구 오피스 공실률이 소폭 내려갔다. 사무실 복귀가 늘어난 영향으로 분석된다.',
      points: ['주요 업무지구 공실률 하락', '사무실 복귀 확대가 배경'],
      keywords: ['오피스', '공실률'],
      url: 'https://example.com/news/est-03',
    },
  ];

  /* minutesAgo 를 실제 시각으로 바꿔 둔다. 언제 열어도 방금 들어온 뉴스처럼 보인다. */
  const now = Date.now();
  const articles = RAW.map(a => {
    const out = Object.assign({}, a);
    out.publishedAt = new Date(now - a.minutesAgo * 60000).toISOString();
    out.keywords = a.keywords || [];
    out.points = a.points || [];
    delete out.minutesAgo;
    return out;
  });

  global.NewsData = {
    /** true 이면 화면에 "목업 데이터" 배너를 띄운다 */
    isMock: true,
    categories: CATEGORIES,
    articles: articles,
    category: key => CATEGORIES.find(c => c.key === key) || null,
  };
})(window);
