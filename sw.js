/* 서비스 워커 — 앱 설치 조건을 채우고, 오프라인에서도 마지막으로 받은 뉴스가 뜨게 한다.
   네트워크 우선: 뉴스는 약 15분마다 바뀌므로 연결이 있으면 항상 새로 받고, 없을 때만 캐시를 쓴다.
   언론사(다른 출처) 요청은 건드리지 않는다. */
const CACHE = 'newsalimi-v1';
const SHELL = [
  './', 'index.html', 'app.js', 'data/mock-news.js', 'manifest.webmanifest',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
];
// 수집 결과는 아직 없을 수도 있다(그때는 목업으로 뜬다). 없다고 설치가 실패하면 안 되므로 따로 담는다.
const OPTIONAL = ['data/news.js'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).then(() => Promise.all(OPTIONAL.map(u => c.add(u).catch(() => {})))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  // 뉴스 데이터는 브라우저 HTTP 캐시(Pages 는 10분)도 거치지 않고 서버에 확인한다
  const isData = url.pathname.endsWith('/data/news.js');
  // ?t=… 로 새로고침할 때마다 캐시 항목이 쌓이지 않도록 주소 뒤를 떼고 저장한다
  const key = url.origin + url.pathname;
  event.respondWith(
    fetch(req, isData ? { cache: 'no-cache' } : undefined)
      .then(res => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(key, copy));
        }
        return res;
      })
      .catch(() => caches.match(key).then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined))
        .then(hit => hit || Response.error()))
  );
});
