# 뉴스알리미

여러 분야의 뉴스를 **한 화면에서 훑어보는** 페이지입니다.
카테고리를 나란히 놓고 각 칼럼에 상위 몇 건만 보여주므로, 기사가 늘어도 스크롤이 길어지지 않습니다.

## 보는 방법

| 보기 | 쓰임 |
|---|---|
| **대시보드** (기본) | 7개 분야를 나란히. 칼럼당 3~10건 선택. 스크롤 없이 전체 흐름 파악 |
| **카드** | 요약과 함께 정독. 처음 12건만 그리고 `더 보기`로 늘림 |
| **간결** | 한 줄 목록. 많은 건수를 빠르게 훑기 |

분야는 IT·개발·AI / 경제·증시 / 국내 종합 / 해외·글로벌 / 스포츠 / 연예 / 부동산입니다.
검색, 중요도순 정렬, 읽음 표시(브라우저에 저장)를 지원합니다.

## 뉴스는 어디서 오나

각 언론사가 **공개 배포하는 RSS**를 GitHub Actions가 30분마다 읽어옵니다.
담는 것은 **제목 · 원문 링크 · RSS가 스스로 제공하는 짧은 발췌(180자) · 출처명 · 발행시각**뿐입니다.

- 기사 본문을 긁어오거나 저장하지 않습니다.
- 모든 기사에 **출처를 표기하고 원문으로 링크**합니다. 읽기는 원문에서 이뤄집니다.
- 요약은 **AI가 만든 것이 아니라 RSS가 제공하는 발췌**입니다.

현재 출처: 연합뉴스, 전자신문, ZDNet Korea, 한국경제

> 게재를 원하지 않는 매체가 있으면 `scripts/fetch-news.js`의 `FEEDS`에서 해당 항목을 지우면 즉시 반영됩니다.

## 메일로 받기 (현재 꺼져 있음)

아침 7시·저녁 6시(KST)에 **주요 4건 + 분야별 3건**을 메일로 받을 수 있습니다.
SMTP 자격증명을 저장하지 않습니다. Actions가 다이제스트를 Issue로 올리면
GitHub가 저장소를 지켜보는 사람에게 알림 메일을 보내주는 방식입니다.

### 현재 상태: 둘 다 꺼짐

메일을 받으려면 **두 가지가 모두 켜져 있어야** 합니다. 지금은 둘 다 꺼져 있습니다.

| 스위치 | 현재 | 없으면 |
|---|---|---|
| ① 다이제스트 워크플로 | ⛔ 꺼짐 | 다이제스트가 아예 만들어지지 않음 |
| ② 저장소 Watch | ⛔ 꺼짐 | 다이제스트는 올라가지만 **메일이 안 감** |

### 켜는 방법

**① 워크플로 켜기**

<https://github.com/zenki798/news-alimi/actions/workflows/digest.yml>

위 주소로 들어가면 `This workflow was disabled manually` 안내와 함께
**`Enable workflow`** 버튼이 보입니다. 그걸 누르면 됩니다.

**② Watch 켜기**

<https://github.com/zenki798/news-alimi>

저장소 첫 화면 **우측 상단의 `Watch` 버튼** → **`All Activity`** 선택
(`Participating and @mentions` 로는 안 옵니다. 다이제스트를 올리는 건 봇이고
회원님이 참여한 대화가 아니기 때문입니다.)

지켜보는 저장소 목록은 <https://github.com/watching> 에서 볼 수 있습니다.

**바로 한 통 받아보기**

①을 켠 뒤 같은 Actions 화면에서 **`Run workflow`** 버튼을 누르면 즉시 발송됩니다.

### 끄는 방법

- **①만 끄기** — Actions → 뉴스 다이제스트 메일 → 우측 `···` → `Disable workflow`
  (가장 깔끔합니다. 저장소의 다른 알림은 그대로 받습니다.)
- **②도 끄기** — 저장소 첫 화면 `Watching` 버튼 → `Unwatch`

### 메일은 어디로 오나

GitHub 계정의 **기본 이메일**로 옵니다. 커밋에 찍히는 주소
(`zenki798@users.noreply.github.com`)와는 별개입니다.

- 확인·변경: <https://github.com/settings/emails>
- 이 저장소만 다른 주소로 받기: <https://github.com/settings/notifications> 의 `Custom routing`

**바로 한 번 받아보기**

Actions 탭 → **뉴스 다이제스트 메일** → **Run workflow** (워크플로를 먼저 켜야 보입니다)

**설정 바꾸기**

| 바꿀 것 | 위치 |
|---|---|
| 발송 시각 | `.github/workflows/digest.yml` 의 `cron` (UTC 기준, KST = UTC+9) |
| 분야별 건수 | `DIGEST_PER_CATEGORY` 환경변수 (기본 3) |
| 주요 건수 | `DIGEST_TOP` 환경변수 (기본 4) |

> 다이제스트를 껐더라도 **뉴스 수집과 사이트 갱신은 계속 돌아갑니다.** 웹페이지는 항상 최신입니다.

## 구조

```
index.html                         화면
app.js                             렌더링·필터·검색·정렬·읽음 표시
data/mock-news.js                  견본 데이터 (기본값, 실제 뉴스 아님)
data/news.js                       수집 결과 — 자동 생성물, 직접 수정 금지
scripts/fetch-news.js              RSS 수집기 (의존성 없음)
.github/workflows/fetch-news.yml   30분마다 수집
.github/workflows/pages.yml        Pages 배포
tests/                             Playwright 테스트
```

화면 코드는 `window.NewsData` 라는 **계약**만 알고 있습니다. 데이터가 견본인지 실제 수집물인지
신경 쓰지 않으므로, 수집 방식을 바꿔도 화면을 고칠 필요가 없습니다.

`data/news.js`를 JSON이 아니라 **JS 파일**로 만든 이유는 `file://`에서 `fetch`가 CORS에 막히기
때문입니다. `<script src>`는 막히지 않으므로 **파일을 더블클릭해서 열어도 똑같이 동작**합니다.
수집 결과가 없으면 견본 데이터가 그대로 남습니다.

## 직접 돌려보기

```bash
git clone <이 저장소>
cd <폴더>

# 그냥 index.html 을 열어도 됩니다 (서버 불필요)

# 뉴스를 직접 수집해보려면
node scripts/fetch-news.js

# 테스트
npm install
npx playwright install chromium
npx playwright test
```

Node 18 이상이면 됩니다. 수집기는 외부 라이브러리를 쓰지 않습니다.

## 비용

전부 무료입니다. public 저장소의 Actions는 분 단위 한도가 없고, Pages도 무료입니다.
AI 요약을 쓰지 않으므로 API 비용도 없습니다.

## 라이선스

이 저장소의 **코드**는 MIT 라이선스입니다.
수집된 **기사의 제목과 발췌는 각 언론사에 저작권이 있으며**, 이 라이선스가 적용되지 않습니다.
