/* ===========================================================
   뉴스알리미 — 화면 로직
   ---------------------------------------------------------
   이 파일은 window.NewsData 의 계약만 알고 있다.
   데이터가 목업인지 실제 RSS 인지는 신경 쓰지 않는다.

   ES 모듈을 쓰지 않는 이유: type="module" 은 file:// 에서 CORS 에 막힌다.
   사용자가 index.html 을 더블클릭해서 여는 것이 기본 사용법이다.

   보기 방식이 셋인 이유는 "스크롤 길이" 때문이다.
   - dashboard : 카테고리를 나란히 놓고 칼럼마다 상위 N건만. 스크롤 없이 전체 흐름 파악.
   - card      : 요약과 핵심 포인트까지 읽는 정독용. 초기 표시를 제한하고 더보기로 늘린다.
   - compact   : 한 줄 목록. 많은 건수를 빠르게 훑는다.
   기사가 수백 건이 되면 card 를 기본값으로 두는 순간 페이지가 10화면을 넘는다.
   =========================================================== */
(function (global) {
  'use strict';

  const $ = id => document.getElementById(id);

  const PAGE = 12;          // card·compact 보기에서 한 번에 늘리는 건수

  /* 앱 모드: 홈 화면에 설치해서 실행한 경우. manifest 의 start_url 에 ?source=pwa 를 붙여 두었다.
     앱에는 주소창·새로고침 버튼이 없으므로 화면에 새로고침 버튼을 낸다. */
  const APP_MODE = (() => {
    try {
      return global.matchMedia('(display-mode: standalone)').matches ||
        global.matchMedia('(display-mode: fullscreen)').matches ||
        navigator.standalone === true ||
        new URL(location.href).searchParams.get('source') === 'pwa';
    } catch (e) { return false; }
  })();
  document.documentElement.classList.toggle('app-mode', APP_MODE);

  /* 띠(주요 속보)는 칼럼당 건수와 상관없이 넓은 화면 한 줄(5건)·휴대폰 3건까지만 그린다.
     띠가 길어지면 맨 위에서 시선을 다 잡아먹고 분야 칸이 첫 화면 밖으로 밀린다. */
  const BAND_WIDE = 5;
  const BAND_NARROW = 3;
  const narrow = global.matchMedia ? global.matchMedia('(max-width: 560px)') : null;
  const bandSize = () => (narrow && narrow.matches ? BAND_NARROW : BAND_WIDE);

  /* ---------- 열어 둔 화면에서 새 뉴스 자동 확인 ----------
     수집은 약 5분마다 돈다. 화면을 열어 둔 채로도 새 속보가 들어오게, 화면이 보이는 동안 서버에 "바뀌었나"만 묻는다.
     휴대폰 배터리를 아끼는 규칙 (AGENTS.md 5항):
     - 화면이 안 보이면(다른 앱·다른 탭·화면 꺼짐) 묻지 않는다. 다시 보이면 그때 묻는다.
     - 묻는 것은 HEAD 요청 하나다. 본문 없이 머리글만 오간다. 바뀌었을 때만 뉴스(압축 약 22KB)를 받는다.
     - 다음 수집·배포가 끝났을 즈음(수집 시각 + 5분 30초)에 묻는다. 아직이면 1·2·4·5분으로 간격을 늘린다.
     - 인터넷이 끊겼으면 묻지 않는다. file:// 로 열었으면 물을 서버가 없으므로 하지 않는다.
     - 끝없이 도는 애니메이션을 쓰지 않는다. 화면을 계속 다시 그리면 배터리를 쓴다. */
  const WATCH = /^https?:$/.test(location.protocol);
  const CHECK_MIN = 60 * 1000;            // 가장 짧은 간격
  const CHECK_MAX = 5 * 60 * 1000;        // 가장 긴 간격
  const NEXT_DATA = 5.5 * 60 * 1000;      // 수집 시각 + 이만큼이면 다음 차례가 배포돼 있다 (대기 4분 + 수집·배포 약 1분)
  const NEWER_GAP = 3 * 60 * 1000;        // 서버 파일이 보이는 수집보다 이만큼 늦게 올라왔으면 그 사이 새로 수집한 것
  const FRESH_MS = 10 * 60 * 1000;        // 새로 들어온 속보에 "새" 표시를 붙여 두는 시간
  const watch = { timer: null, lastCheck: Date.now(), backoff: CHECK_MIN, tag: null };
  const fresh = new Map();                // 새로 들어온 속보 id → 들어온 시각

  /* ---------- 상태 ---------- */
  const state = {
    category: 'all',
    query: '',
    sort: 'latest',        // latest | importance
    view: 'dashboard',     // dashboard | card | compact
    perCat: 4,             // dashboard 칼럼당 표시 건수
    limit: PAGE,           // card·compact 현재 표시 건수
    unreadOnly: false,
    read: new Set(),
  };

  /* ---------- localStorage — file:// 나 사생활 보호 모드에서 막힐 수 있으므로 전부 감싼다 ---------- */
  const KEY_READ = 'newsalimi.read';
  const KEY_VIEW = 'newsalimi.view';
  const KEY_PER  = 'newsalimi.perCat';

  function loadPrefs() {
    try {
      const r = localStorage.getItem(KEY_READ);
      if (r) JSON.parse(r).forEach(id => state.read.add(id));
      const v = localStorage.getItem(KEY_VIEW);
      if (v === 'dashboard' || v === 'card' || v === 'compact') state.view = v;
      const p = Number(localStorage.getItem(KEY_PER));
      if ([3, 4, 5, 10].indexOf(p) >= 0) state.perCat = p;
    } catch (e) { /* 저장소를 못 써도 화면은 정상 동작해야 한다 */ }
  }

  function savePrefs() {
    try {
      localStorage.setItem(KEY_READ, JSON.stringify(Array.from(state.read)));
      localStorage.setItem(KEY_VIEW, state.view);
      localStorage.setItem(KEY_PER, String(state.perCat));
    } catch (e) { /* 무시 */ }
  }

  /* ---------- 유틸 ---------- */

  function relTime(iso) {
    const diff = Math.max(0, Date.now() - new Date(iso).getTime());
    const m = Math.floor(diff / 60000);
    if (m < 1) return '방금';
    if (m < 60) return m + '분 전';
    const h = Math.floor(m / 60);
    if (h < 24) return h + '시간 전';
    return Math.floor(h / 24) + '일 전';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }

  function matches(a, q) {
    if (!q) return true;
    const hay = (a.title + ' ' + a.summary + ' ' + a.keywords.join(' ') + ' ' + a.source).toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every(t => hay.indexOf(t) >= 0);
  }

  function byOrder(list) {
    const out = list.slice();
    if (state.sort === 'importance') {
      out.sort((x, y) =>
        (y.importance - x.importance) || (new Date(y.publishedAt) - new Date(x.publishedAt)));
    } else {
      out.sort((x, y) => new Date(y.publishedAt) - new Date(x.publishedAt));
    }
    return out;
  }

  /** 검색·읽음 조건만 적용 (카테고리는 제외) — 대시보드는 모든 카테고리를 다 써야 한다 */
  function base() {
    return NewsData.articles.filter(a =>
      matches(a, state.query) && (!state.unreadOnly || !state.read.has(a.id)));
  }

  /** 순위가 있는 칸(rank — 많이 찾는 뉴스)은 정렬 기준과 상관없이 순위대로 둔다 */
  function inOrder(list, cat) {
    return cat && cat.rank ? list.slice().sort((x, y) => x.rank - y.rank) : byOrder(list);
  }

  /** 카테고리까지 적용한 최종 목록 */
  function filtered() {
    return inOrder(base().filter(a =>
      state.category === 'all' || a.category === state.category),
      state.category === 'all' ? null : NewsData.category(state.category));
  }

  /* ---------- 렌더링 ---------- */

  function renderBanner() {
    const el = $('mockBanner');
    if (NewsData.isMock) {
      el.hidden = false;
      el.textContent = '견본 데이터입니다 — 실제 뉴스가 아닙니다. 화면 골격을 확인하기 위한 가상의 기사이고, 출처명도 실제 언론사가 아닙니다.';
    } else {
      el.hidden = true;
    }

    /* 언제 수집된 데이터인지 밝힌다. 예약 수집은 늦어지거나 건너뛸 때가 있으므로 최신인지 알 수 있어야 한다. */
    const up = $('updated');
    if (NewsData.generatedAt) {
      up.hidden = false;
      up.textContent = relTime(NewsData.generatedAt) + ' 수집';
      up.title = new Date(NewsData.generatedAt).toLocaleString('ko-KR');
    } else {
      up.hidden = true;
    }

    /* 아래쪽 안내. 견본이면 견본이라고, 실제 수집물이면 저작권과 출처를 밝힌다.
       예전에는 "데이터 계층만 교체하면…" 이라는 만드는 사람용 문구가 실제 뉴스 화면에도 남아 있었다. */
    const foot = $('foot');
    if (NewsData.isMock) {
      foot.textContent = '견본 데이터입니다. 화면을 확인하기 위한 가상의 기사이며 실제 뉴스가 아닙니다.';
    } else {
      /* 순위 칸(많이 찾는 뉴스)은 기사마다 언론사가 달라 따로 적는다 */
      const rankCat = NewsData.categories.filter(c => c.rank);
      const srcs = Array.from(new Set(NewsData.articles
        .filter(a => !rankCat.some(c => c.key === a.category)).map(a => a.source)));
      foot.textContent = '기사 제목과 발췌의 저작권은 각 언론사에 있습니다. 제목을 누르면 원문으로 이동합니다. ' +
        '출처: ' + srcs.join(', ') +
        (rankCat.length ? '. ' + rankCat.map(c => c.name).join('·') + ': 구글 트렌드(검색량)와 각 언론사' : '') + '.';
    }
  }

  function renderChips() {
    const list = base();
    const counts = { all: list.length };
    NewsData.categories.forEach(c => { counts[c.key] = 0; });
    list.forEach(a => { if (counts[a.category] != null) counts[a.category]++; });

    const chip = (key, name, color, n) =>
      '<button class="chip" data-cat="' + key + '"' +
        ' aria-pressed="' + (state.category === key) + '"' +
        ' style="--c:' + color + '">' + esc(name) + '<span class="n">' + n + '</span></button>';

    $('chips').innerHTML =
      chip('all', '전체', '#8b95a6', counts.all) +
      NewsData.categories.map(c => chip(c.key, c.name, c.color, counts[c.key])).join('');

    $('chips').querySelectorAll('.chip').forEach(el => {
      el.onclick = () => { state.category = el.dataset.cat; state.limit = PAGE; render(); };
    });
  }

  /* 예전에는 대시보드 맨 위에 "주요" 칸(분야마다 최신 기사 하나씩)을 따로 두었다. 바로 아래 주요 속보 띠와
     빨간 상자 둘이 붙어 시선이 갈렸고, 내용도 각 칸 맨 위 기사와 겹쳐서 없앴다(2026-10-01).
     맨 위에서 빨갛게 눈을 끄는 것은 통신사가 급하다고 표시한 속보 띠 하나뿐이다. 그 옆의 "많이 찾는 뉴스"는
     실제 관심도(구글 검색량) 순위라 따로 두되, 빨간색을 쓰지 않고 번호 목록으로 모양을 달리했다. */

  const isFresh = id => fresh.has(id) && Date.now() - fresh.get(id) < FRESH_MS && !state.read.has(id);

  /* ---- 대시보드 — 카테고리를 나란히, 칼럼마다 상위 N건 ----
     wide 칸(주요 속보·많이 찾는 뉴스)은 맨 위 한 줄(.toprow)에 나란히 선다. 넓은 화면에서 3:2 로 나누고,
     좁으면 위아래로 쌓인다. 나머지 10칸은 그 아래 5칸씩 두 줄로 맞아떨어진다. */
  function dashboardHtml() {
    const list = base();
    const cats = state.category === 'all'
      ? NewsData.categories
      : NewsData.categories.filter(c => c.key === state.category);

    const colHtml = c => {
      const mine = inOrder(list.filter(a => a.category === c.key), c);
      const shown = mine.slice(0, c.wide ? bandSize() : state.perCat);
      const rest = mine.length - shown.length;

      const items = shown.length
        ? '<ol>' + shown.map(a =>
            '<li data-id="' + a.id + '"' + (state.read.has(a.id) ? ' class="read"' : '') + '>' +
              /* 순위 칸: 번호 + 제목 + "주제 · 검색량 · 언론사" (시각 대신) */
              (c.rank ? '<span class="no">' + a.rank + '</span>' : '') +
              '<a href="' + esc(a.url) + '" target="_blank" rel="noopener noreferrer">' +
                /* 열어 둔 사이 새로 들어온 속보. 깜빡이지 않는 표시다(배터리). 순위 칸은 자주 바뀌어 붙이지 않는다 */
                (c.wide && !c.rank && isFresh(a.id) ? '<b class="new">새</b>' : '') + esc(a.title) + '</a>' +
              (c.rank
                ? '<span class="topic">' + esc(a.topic || '') + ' · ' + esc(a.source) + '</span>'
                : '<time>' + relTime(a.publishedAt) + '</time>') +
            '</li>').join('') + '</ol>'
        : '<p class="none">해당 기사가 없습니다.</p>';

      return '<section class="col' + (c.wide ? ' wide' : '') + (c.rank ? ' rank' : '') + '" data-col="' + c.key + '" style="--c:' + c.color + '">' +
        '<header><h3>' + esc(c.name) + '</h3><span class="n">' + mine.length + '</span></header>' +
        /* 칼럼 안내(선택) — 투자 칸의 "투자 권유 아님" 같은 것. 없는 카테고리는 아무것도 그리지 않는다 */
        (c.note ? '<p class="note">' + esc(c.note) + '</p>' : '') +
        items +
        (rest > 0
          ? '<button class="more" data-more="' + c.key + '">+' + rest + '건 더 보기</button>'
          : '') +
      '</section>';
    };

    const top = cats.filter(c => c.wide);
    return (top.length ? '<div class="toprow">' + top.map(colHtml).join('') + '</div>' : '') +
      cats.filter(c => !c.wide).map(colHtml).join('');
  }

  function cardHtml(a) {
    const cat = NewsData.category(a.category);
    return '<article class="card' + (state.read.has(a.id) ? ' read' : '') + '"' +
             ' data-id="' + a.id + '" style="--c:' + (cat ? cat.color : '#8b95a6') + '">' +
      '<div class="meta">' +
        /* "주요" 딱지는 없앴다. 분야마다 최신 기사에 붙던 규칙 결과라 주요 속보와 헷갈렸다 */
        '<span class="cat">' + esc(cat ? cat.name : a.category) + '</span>' +
        '<span class="src">' + esc(a.source) + '</span>' +
        '<time datetime="' + a.publishedAt + '">' + relTime(a.publishedAt) + '</time>' +
      '</div>' +
      '<h3><a href="' + esc(a.url) + '" target="_blank" rel="noopener noreferrer">' + esc(a.title) + '</a></h3>' +
      /* 요약을 제공하지 않는 피드가 있다. 빈 문단을 그리면 어색한 여백만 남는다. */
      (a.summary ? '<p class="sum">' + esc(a.summary) + '</p>' : '') +
      (a.points.length ? '<ul class="pts">' + a.points.map(p => '<li>' + esc(p) + '</li>').join('') + '</ul>' : '') +
      (a.keywords.length ? '<div class="kw">' + a.keywords.map(k => '<span>#' + esc(k) + '</span>').join('') + '</div>' : '') +
    '</article>';
  }

  function compactHtml(a) {
    const cat = NewsData.category(a.category);
    return '<li class="row' + (state.read.has(a.id) ? ' read' : '') + '"' +
             ' data-id="' + a.id + '" style="--c:' + (cat ? cat.color : '#8b95a6') + '">' +
      '<time>' + relTime(a.publishedAt) + '</time>' +
      '<span class="cat">' + esc(cat ? cat.name : a.category) + '</span>' +
      '<a href="' + esc(a.url) + '" target="_blank" rel="noopener noreferrer">' + esc(a.title) + '</a>' +
      '<span class="src">' + esc(a.source) + '</span>' +
    '</li>';
  }

  function renderList() {
    const wrap = $('list');
    const total = filtered().length;

    if (state.view === 'dashboard') {
      wrap.className = 'dash';
      wrap.innerHTML = dashboardHtml();
      $('empty').hidden = total > 0;
      $('btnMore').hidden = true;
    } else {
      const page = filtered().slice(0, state.limit);
      if (!page.length) {
        wrap.innerHTML = '';
        $('btnMore').hidden = true;
      } else {
        wrap.className = state.view === 'compact' ? 'compact' : 'cards';
        wrap.innerHTML = state.view === 'compact'
          ? '<ul>' + page.map(compactHtml).join('') + '</ul>'
          : page.map(cardHtml).join('');

        const rest = total - page.length;
        $('btnMore').hidden = rest <= 0;
        $('btnMore').textContent = '남은 ' + rest + '건 더 보기';
      }
      $('empty').hidden = total > 0;
    }

    if (!total) {
      $('empty').textContent = state.query
        ? '"' + state.query + '" 와 맞는 기사가 없습니다.'
        : '조건에 맞는 기사가 없습니다.';
    }

    $('count').textContent = total;
    $('totalCount').textContent = NewsData.articles.length;
    $('readCount').textContent = state.read.size;

    /* 제목을 클릭하면 읽음으로 남긴다 (대시보드·카드·목록 공통) */
    document.querySelectorAll('#list [data-id] a').forEach(el => {
      el.addEventListener('click', () => {
        state.read.add(el.closest('[data-id]').dataset.id);
        savePrefs();
        render();
      });
    });

    /* 칼럼의 "더 보기" — 그 카테고리로 좁히고 정독용 카드 보기로 넘어간다 */
    wrap.querySelectorAll('.more').forEach(el => {
      el.onclick = () => {
        state.category = el.dataset.more;
        state.view = 'card';
        state.limit = PAGE;
        savePrefs();
        render();
      };
    });
  }

  function renderControls() {
    document.querySelectorAll('#views button').forEach(el => {
      el.setAttribute('aria-pressed', String(el.dataset.view === state.view));
    });
    $('perCatWrap').hidden = state.view !== 'dashboard';
    $('perCat').value = String(state.perCat);
    $('btnUnread').setAttribute('aria-pressed', String(state.unreadOnly));
  }

  function render() {
    renderControls();
    renderChips();
    renderList();
  }

  /* ---------- 초기화 ---------- */
  function init() {
    loadPrefs();
    renderBanner();

    $('today').textContent = new Date().toLocaleDateString('ko-KR', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
    });

    $('q').addEventListener('input', e => {
      state.query = e.target.value.trim();
      state.limit = PAGE;
      render();
    });
    $('sort').addEventListener('change', e => { state.sort = e.target.value; render(); });
    $('perCat').addEventListener('change', e => {
      state.perCat = Number(e.target.value);
      savePrefs();
      render();
    });
    document.querySelectorAll('#views button').forEach(el => {
      el.addEventListener('click', () => {
        state.view = el.dataset.view;
        state.limit = PAGE;
        savePrefs();
        render();
      });
    });
    $('btnMore').addEventListener('click', () => { state.limit += PAGE; render(); });
    $('btnUnread').addEventListener('click', () => {
      state.unreadOnly = !state.unreadOnly;
      state.limit = PAGE;
      render();
    });
    $('btnReset').addEventListener('click', () => {
      state.read.clear();
      savePrefs();
      render();
    });

    $('btnRefresh').addEventListener('click', refreshData);

    /* 화면을 돌리거나 창 크기를 바꿔 넓은·좁은 화면이 바뀌면 띠 건수(5·3)를 다시 맞춘다 */
    if (narrow && narrow.addEventListener) narrow.addEventListener('change', () => { if (state.view === 'dashboard') render(); });

    /* 자동 확인: 화면이 안 보이면 멈추고, 다시 보이면 마지막으로 물은 지 1분이 지났을 때 바로 묻는다 */
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') { clearTimeout(watch.timer); watch.timer = null; return; }
      scheduleCheck(CHECK_MIN - (Date.now() - watch.lastCheck));
    });
    global.addEventListener('online', () => scheduleCheck(0));

    initInstall();
    render();
    scheduleCheck(nextDelay(false));
  }

  /* ---------- 자동 확인 (위의 "열어 둔 화면에서 새 뉴스 자동 확인" 규칙) ---------- */
  function scheduleCheck(delay) {
    clearTimeout(watch.timer);
    watch.timer = null;
    if (!WATCH || document.visibilityState !== 'visible') return;
    watch.timer = setTimeout(checkForNews, Math.max(0, delay));
  }

  /** 다음에 물을 때까지의 시간. 다음 수집이 끝났을 즈음으로 맞추고, 그때도 없으면 간격을 늘린다 */
  function nextDelay(changed) {
    if (changed) watch.backoff = CHECK_MIN;
    const due = (Date.parse(NewsData.generatedAt || '') || 0) + NEXT_DATA - Date.now();
    if (due > CHECK_MIN) return Math.min(due, CHECK_MAX);
    const d = watch.backoff;
    watch.backoff = Math.min(watch.backoff * 2, CHECK_MAX);
    return d;
  }

  /** 서버에 "바뀌었나"만 묻는다 (HEAD — 본문 없음). 바뀌었으면 그때 받는다 */
  function checkForNews() {
    watch.timer = null;
    if (!WATCH || document.visibilityState !== 'visible') return Promise.resolve(false);
    if (navigator.onLine === false) return Promise.resolve(false);   // 연결되면 'online' 에서 다시 시작한다
    watch.lastCheck = Date.now();
    return fetch('data/news.js', { method: 'HEAD', cache: 'no-store' })
      .then(r => {
        const tag = r.ok && (r.headers.get('etag') || r.headers.get('last-modified'));
        if (!tag || tag === watch.tag) return false;
        if (watch.tag === null) {
          /* 처음 물을 때는 지금 보이는 뉴스가 서버 것과 같은지 모른다. 서버 파일이 보이는 수집보다
             한참 뒤에 올라왔으면(그 사이 새로 수집) 받고, 아니면 이 값을 기준으로 삼는다 */
          const newer = Date.parse(r.headers.get('last-modified') || '') - Date.parse(NewsData.generatedAt || '');
          if (!(newer > NEWER_GAP)) { watch.tag = tag; return false; }
        }
        return refreshData().then(ok => { if (ok) watch.tag = tag; return ok; });
      })
      .catch(() => false)
      .then(changed => {
        renderBanner();   // "N분 전 수집" 글자만 고친다 (다시 그리지 않는다)
        scheduleCheck(nextDelay(changed));
        return changed;
      });
  }

  /** 이번에 새로 들어온 속보(띠로 그리는 칸)에 "새" 표시를 붙인다. 처음 열 때는 붙이지 않는다 */
  function markFresh(before) {
    const now = Date.now();
    NewsData.articles.forEach(a => {
      const cat = NewsData.category(a.category);
      if (cat && cat.wide && !cat.rank && !before.has(a.id)) fresh.set(a.id, now);
    });
  }

  /* ---------- 뉴스 다시 받기 ----------
     data/news.js 를 script 로 다시 싣는다 (file:// 과 같은 방식). 페이지를 통째로 새로 열지 않으므로
     검색어·카테고리·보기 방식이 그대로 남는다. ?t= 는 브라우저 캐시를 피하려고 붙인다. */
  function refreshData() {
    const btn = $('btnRefresh');
    if (btn.getAttribute('aria-busy') === 'true') return Promise.resolve(false);
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = '새로고침 중…';
    const before = new Set(NewsData.articles.map(a => a.id));
    return new Promise(resolve => {
      const s = document.createElement('script');
      s.src = 'data/news.js?t=' + Date.now();
      const done = ok => {
        s.remove();
        btn.removeAttribute('aria-busy');
        /* 오프라인이면 서비스 워커가 마지막으로 받은 뉴스를 돌려준다. 그 사실을 알린다. */
        btn.textContent = ok && navigator.onLine !== false ? '새로고침' : '연결 안 됨 · 다시 시도';
        if (ok) {
          markFresh(before);
          /* 손으로 받은 경우 서버 값과 맞춰 둔 기준을 버린다. 다음 확인 때 다시 잡는다 */
          watch.tag = null;
          watch.lastCheck = Date.now();
          renderBanner();
          render();
        }
        resolve(ok);
      };
      s.onload = () => done(true);
      s.onerror = () => done(false);
      document.head.appendChild(s);
    });
  }

  /* ---------- 앱 설치 안내 ----------
     안드로이드 크롬: 설치 가능하면 beforeinstallprompt 가 온다 → "앱으로 설치" 버튼.
     아이폰 사파리: 설치 API 가 없다 → 공유 메뉴에서 추가하는 방법을 글로 안내한다. */
  const KEY_INSTALL = 'newsalimi.installHint';
  let installEvent = null;

  function initInstall() {
    const bar = $('install-bar');
    const dismissed = () => { try { return localStorage.getItem(KEY_INSTALL) === 'off'; } catch (e) { return false; } };
    const show = (text, withButton) => {
      if (APP_MODE || dismissed()) return;
      $('install-text').textContent = text;
      $('install-btn').hidden = !withButton;
      bar.hidden = false;
    };

    global.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      installEvent = e;
      show('홈 화면에 설치하면 주소창 없이 앱처럼 볼 수 있어요.', true);
    });
    global.addEventListener('appinstalled', () => { bar.hidden = true; });
    $('install-btn').addEventListener('click', () => {
      if (!installEvent) return;
      installEvent.prompt();
      installEvent.userChoice.finally(() => { installEvent = null; bar.hidden = true; });
    });
    $('install-close').addEventListener('click', () => {
      bar.hidden = true;
      try { localStorage.setItem(KEY_INSTALL, 'off'); } catch (e) { /* 무시 */ }
    });
    if (/iPhone|iPad|iPod/.test(navigator.userAgent) && location.protocol === 'https:') {
      show('앱처럼 보려면: 사파리 아래쪽 공유 버튼(□↑) → "홈 화면에 추가"', false);
    }

    /* 서비스 워커: 설치 조건을 채우고 오프라인에서도 마지막 뉴스를 띄운다. file:// 에서는 쓸 수 없다. */
    if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* 실패해도 페이지는 동작한다 */ });
    }
  }

  /* 테스트에서 내부 상태를 확인할 수 있도록 노출한다 */
  global.__app = {
    state, base, filtered, relTime, matches, render, init, PAGE, APP_MODE, refreshData,
    WATCH, watch, fresh, checkForNews, BAND_WIDE, BAND_NARROW,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
