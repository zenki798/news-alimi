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
     앱에는 주소창·새로고침 버튼이 없으므로 화면에 새로고침 버튼을 내고, 앱으로 돌아올 때 뉴스를 다시 받는다. */
  const APP_MODE = (() => {
    try {
      return global.matchMedia('(display-mode: standalone)').matches ||
        global.matchMedia('(display-mode: fullscreen)').matches ||
        navigator.standalone === true ||
        new URL(location.href).searchParams.get('source') === 'pwa';
    } catch (e) { return false; }
  })();
  document.documentElement.classList.toggle('app-mode', APP_MODE);

  const STALE_MS = 10 * 60 * 1000;   // 앱으로 돌아왔을 때 이보다 오래됐으면 다시 받는다
  let loadedAt = Date.now();

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

  /** 카테고리까지 적용한 최종 목록 */
  function filtered() {
    return byOrder(base().filter(a =>
      state.category === 'all' || a.category === state.category));
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

    /* 언제 수집된 데이터인지 밝힌다. 30분마다 갱신되므로 최신인지 알 수 있어야 한다. */
    const up = $('updated');
    if (NewsData.generatedAt) {
      up.hidden = false;
      up.textContent = relTime(NewsData.generatedAt) + ' 수집';
      up.title = new Date(NewsData.generatedAt).toLocaleString('ko-KR');
    } else {
      up.hidden = true;
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

  /* ---- 주요 뉴스 스트립 — 대시보드 맨 위에서 가장 중요한 것만 먼저 보여준다 ---- */
  function renderHeadlines() {
    const el = $('headline');
    if (state.view !== 'dashboard') { el.hidden = true; el.innerHTML = ''; return; }

    const top = byOrder(base().filter(a => a.importance >= 3)).slice(0, 5);
    if (!top.length) { el.hidden = true; el.innerHTML = ''; return; }

    el.hidden = false;
    el.innerHTML = '<div class="hl-label">주요</div><ul>' + top.map(a => {
      const cat = NewsData.category(a.category);
      return '<li data-id="' + a.id + '" style="--c:' + (cat ? cat.color : '#8b95a6') + '">' +
        '<a href="' + esc(a.url) + '" target="_blank" rel="noopener noreferrer">' + esc(a.title) + '</a>' +
        '<time>' + relTime(a.publishedAt) + '</time></li>';
    }).join('') + '</ul>';
  }

  /* ---- 대시보드 — 카테고리를 나란히, 칼럼마다 상위 N건 ---- */
  function dashboardHtml() {
    const list = base();
    const cats = state.category === 'all'
      ? NewsData.categories
      : NewsData.categories.filter(c => c.key === state.category);

    const cols = cats.map(c => {
      const mine = byOrder(list.filter(a => a.category === c.key));
      const shown = mine.slice(0, state.perCat);
      const rest = mine.length - shown.length;

      const items = shown.length
        ? '<ol>' + shown.map(a =>
            '<li data-id="' + a.id + '"' + (state.read.has(a.id) ? ' class="read"' : '') + '>' +
              '<a href="' + esc(a.url) + '" target="_blank" rel="noopener noreferrer">' + esc(a.title) + '</a>' +
              '<time>' + relTime(a.publishedAt) + '</time>' +
            '</li>').join('') + '</ol>'
        : '<p class="none">해당 기사가 없습니다.</p>';

      return '<section class="col" data-col="' + c.key + '" style="--c:' + c.color + '">' +
        '<header><h3>' + esc(c.name) + '</h3><span class="n">' + mine.length + '</span></header>' +
        items +
        (rest > 0
          ? '<button class="more" data-more="' + c.key + '">+' + rest + '건 더 보기</button>'
          : '') +
      '</section>';
    }).join('');

    return cols;
  }

  function cardHtml(a) {
    const cat = NewsData.category(a.category);
    return '<article class="card' + (state.read.has(a.id) ? ' read' : '') + '"' +
             ' data-id="' + a.id + '" style="--c:' + (cat ? cat.color : '#8b95a6') + '">' +
      '<div class="meta">' +
        '<span class="cat">' + esc(cat ? cat.name : a.category) + '</span>' +
        (a.importance >= 3 ? '<span class="hot">주요</span>' : '') +
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

    /* 제목을 클릭하면 읽음으로 남긴다 (대시보드·주요 스트립·카드·목록 공통) */
    document.querySelectorAll('#headline [data-id] a, #list [data-id] a').forEach(el => {
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
    renderHeadlines();
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
    document.addEventListener('visibilitychange', () => {
      if (APP_MODE && document.visibilityState === 'visible' && Date.now() - loadedAt > STALE_MS) refreshData();
    });

    initInstall();
    render();
  }

  /* ---------- 뉴스 다시 받기 ----------
     data/news.js 를 script 로 다시 싣는다 (file:// 과 같은 방식). 페이지를 통째로 새로 열지 않으므로
     검색어·카테고리·보기 방식이 그대로 남는다. ?t= 는 브라우저 캐시를 피하려고 붙인다. */
  function refreshData() {
    const btn = $('btnRefresh');
    if (btn.getAttribute('aria-busy') === 'true') return Promise.resolve(false);
    btn.setAttribute('aria-busy', 'true');
    btn.textContent = '새로고침 중…';
    return new Promise(resolve => {
      const s = document.createElement('script');
      s.src = 'data/news.js?t=' + Date.now();
      const done = ok => {
        s.remove();
        btn.removeAttribute('aria-busy');
        /* 오프라인이면 서비스 워커가 마지막으로 받은 뉴스를 돌려준다. 그 사실을 알린다. */
        btn.textContent = ok && navigator.onLine !== false ? '새로고침' : '연결 안 됨 · 다시 시도';
        if (ok) { loadedAt = Date.now(); renderBanner(); render(); }
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
  global.__app = { state, base, filtered, relTime, matches, render, init, PAGE, APP_MODE, refreshData };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window);
