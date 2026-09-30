/* 앱 아이콘 PNG 를 만든다 (`npm run make:icons`). 이미지 도구 없이 SVG 를 브라우저로 찍는다.
   - icon-192/512      : 일반 아이콘 (둥근 모서리, 바깥은 투명)
   - icon-maskable-512 : 안드로이드 모양 마스크용 (배경을 끝까지 채우고, 그림은 가운데 안전 영역 안에)
   - apple-touch-icon  : iOS 홈 화면용 180px (배경을 끝까지 채운다. 모서리는 iOS 가 둥글린다) */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'icons');
const BG = '#1a222e';      // 화면의 카드 색
const ACCENT = '#5b9cff';  // 화면의 제목 옆 점 색

// 신문 한 장 + 제목 옆의 파란 알림 점. 100×100 좌표계, scale 로 안전 영역에 맞춘다.
function glyph(scale) {
  const t = (100 - 100 * scale) / 2;
  return `
  <g transform="translate(${t} ${t}) scale(${scale})" fill="none" stroke="#e8eef6" stroke-linecap="round" stroke-linejoin="round">
    <path d="M20 26 h50 v48 a6 6 0 0 0 6 6 h-50 a6 6 0 0 1 -6 -6 z" stroke-width="5" fill="rgba(255,255,255,.06)"/>
    <path d="M70 40 h10 v34 a6 6 0 0 1 -6 6" stroke-width="5"/>
    <rect x="29" y="36" width="16" height="14" rx="2" stroke-width="4" fill="rgba(91,156,255,.35)"/>
    <path d="M52 38 h10 M52 48 h10 M29 60 h33 M29 69 h33" stroke-width="4.5"/>
    <circle cx="76" cy="24" r="10" fill="${ACCENT}" stroke="${BG}" stroke-width="4"/>
  </g>`;
}

function svg({ rounded, scale }) {
  const bg = rounded
    ? `<rect x="4" y="4" width="92" height="92" rx="22" fill="${BG}"/>`
    : `<rect width="100" height="100" fill="${BG}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">${bg}${glyph(scale)}</svg>`;
}

const ICONS = [
  { file: 'icon-192.png', size: 192, rounded: true, scale: 0.86 },
  { file: 'icon-512.png', size: 512, rounded: true, scale: 0.86 },
  { file: 'icon-maskable-512.png', size: 512, rounded: false, scale: 0.72 }, // 안전 영역: 가운데 지름 80%
  { file: 'apple-touch-icon.png', size: 180, rounded: false, scale: 0.8 },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage();
  for (const icon of ICONS) {
    await page.setViewportSize({ width: icon.size, height: icon.size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${icon.size}px;height:${icon.size}px}</style>${svg(icon)}`);
    await page.locator('svg').screenshot({ path: path.join(OUT, icon.file), omitBackground: true });
    console.log('icons/' + icon.file);
  }
  await browser.close();
})();
