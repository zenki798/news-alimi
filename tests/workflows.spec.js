// 수집·배포 워크플로 설정 — 사이트의 뉴스가 멈추지 않게 하는 구조를 지킨다 (AGENTS.md 4항)
// 설정 글자만 볼 수 있다. 실제로 약 15분마다 도는지는 Actions 탭의 실행 기록으로 확인한다.
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');

const DIR = path.join(__dirname, '..', '.github', 'workflows');
const read = name => fs.readFileSync(path.join(DIR, name), 'utf8').replace(/\r\n/g, '\n');
const WF = 'fetch-news.yml';

/** jobs 아래 작업을 { 이름: 본문 } 으로 나눈다 (작업 이름은 들여쓰기 2칸) */
function jobsOf(yml) {
  const out = {};
  let name = null;
  for (const line of yml.split(/^jobs:\s*$/m)[1].split('\n')) {
    const m = /^ {2}([\w-]+):\s*$/.exec(line);
    if (m) { name = m[1]; out[name] = ''; } else if (name) out[name] += line + '\n';
  }
  return out;
}

/** 작업의 if: 조건 한 줄 */
const ifOf = job => ((/^ {4}if:\s*(.+)$/m.exec(job) || [])[1] || '').trim();

/** cron 의 분(minute) 칸을 숫자 목록으로 편다. 쉼표 목록과 '*\/N' 만 다룬다. */
function minutesOf(field) {
  if (field === '*') return Array.from({ length: 60 }, (_, i) => i);
  const step = /^\*\/(\d+)$/.exec(field);
  if (step) return Array.from({ length: Math.ceil(60 / Number(step[1])) }, (_, i) => i * Number(step[1]));
  const list = field.split(',').map(Number);
  if (list.some(n => !Number.isInteger(n) || n < 0 || n > 59)) throw new Error('해석할 수 없는 분 칸: ' + field);
  return list;
}

test('사이트를 올리는 워크플로는 하나다 — 방금 모은 뉴스를 같은 실행에서 배포한다', async () => {
  const deployers = fs.readdirSync(DIR).filter(f => /\.ya?ml$/.test(f) && read(f).includes('actions/deploy-pages'));
  expect(deployers).toEqual([WF]);

  const jobs = jobsOf(read(WF));
  const build = jobs.build;
  expect(build.indexOf('node scripts/fetch-news.js')).toBeGreaterThan(-1);
  expect(build.indexOf('node scripts/fetch-news.js')).toBeLessThan(build.indexOf('actions/upload-pages-artifact'));
  expect(build).toContain('cp index.html app.js manifest.webmanifest sw.js _site/');
  expect(build).toContain('cp icons/*.png _site/icons/');
  expect(build).toContain('cp data/mock-news.js data/news.js _site/data/');
  // 기다리는 사이 올라온 커밋까지 배포하도록 실행 시점의 main 최신본을 받는다
  expect(build).toMatch(/ref: main/);

  expect(jobs.deploy).toMatch(/needs: build/);
  expect(ifOf(jobs.deploy)).toBe("${{ !cancelled() && needs.build.result == 'success' }}");
  expect(jobs.deploy).toContain('name: github-pages');
  expect(jobs.deploy).toContain('actions/deploy-pages');
});

test('기다리기(wait)를 건너뛴 실행에서도 뒤 작업이 모두 돈다 — wait 뒤의 작업은 조건을 직접 적는다', async () => {
  /* GitHub 는 if 에 상태 함수(!cancelled() 등)가 없으면 success() 를 붙이고, success() 는 앞선 작업
     "전부"를 본다. 푸시·수동·예약 실행은 wait 를 건너뛰므로 조건이 없는 작업은 줄줄이 건너뛴다.
     2026-09-30 첫 적용 때 이 때문에 수집은 했는데 배포(deploy)가 건너뛰어졌다. */
  const jobs = jobsOf(read(WF));
  for (const [name, body] of Object.entries(jobs)) {
    if (name === 'wait') continue;
    expect(ifOf(body), name + ' 의 if').toContain('!cancelled()');
  }
});

test('끝날 때마다 다음 차례를 부르고, 다음 차례는 환경의 대기 타이머로 기다린다', async () => {
  const yml = read(WF);
  const jobs = jobsOf(yml);

  // 다음 차례는 chain 입력으로 구분한다
  expect(yml).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+chain:\n(?:\s+.+\n)*?\s+type: boolean/);

  // 기다리기: 앞 차례가 부른 실행만, 환경 news-interval 의 wait timer 로 (러너를 쓰지 않는다)
  expect(ifOf(jobs.wait)).toBe("github.event_name == 'workflow_dispatch' && inputs.chain");
  expect(jobs.wait).toMatch(/^ {4}environment: news-interval$/m);
  // 타이머가 사라져 기다리지 않았으면 실패해서 사슬을 끊는다 (끝없이 도는 것 방지)
  expect(jobs.wait).toMatch(/if \[ "\$waited" -lt 600 \]; then[\s\S]*?exit 1/);

  // 기다리기를 건너뛴 실행(푸시·수동·예약)도 수집하고, 대기 확인이 실패하면 수집하지 않는다
  expect(ifOf(jobs.build)).toBe("${{ !cancelled() && needs.wait.result != 'failure' }}");

  // 다음 차례 부르기: 수집이 실패해도 부르되(!cancelled), 사람이 취소하면 부르지 않는다(always 아님)
  expect(jobs.next).toMatch(/needs: \[wait, build, deploy\]/);
  expect(ifOf(jobs.next)).toBe("${{ !cancelled() && needs.wait.result != 'failure' }}");
  expect(jobs.next).toContain(`gh workflow run ${WF}`);
  expect(jobs.next).toContain('-f chain=true');
  expect(yml).toMatch(/^ {2}actions: write/m);

  // 한 번에 하나만 돌고 대기는 하나만 남아서, 푸시·예약·수동 실행이 끼어도 사슬이 하나로 합쳐진다
  expect(yml).toMatch(/^concurrency:\n\s+group: news\n\s+cancel-in-progress: false$/m);
});

test('예약은 사슬이 끊겼을 때 다시 잇는 예비용이고, 혼잡한 시각(정시·5분 단위)을 피한다', async () => {
  /* GitHub 는 예약 실행을 보장하지 않는다. '*\/30' 은 이틀간 9번(4~8시간 간격)만 돌았고,
     7·22·37·52분으로 옮긴 뒤에도 첫 1시간 동안 한 번도 돌지 않았다. 그래서 예약만 믿지 않는다. */
  const crons = [...read(WF).matchAll(/-\s*cron:\s*'([^']+)'/g)].map(m => m[1].trim().split(/\s+/));
  expect(crons.length).toBeGreaterThan(0);
  const minutes = [];
  for (const [min, hour, dom, mon, dow] of crons) {
    expect([hour, dom, mon, dow], '매시간 도는 예약이어야 한다').toEqual(['*', '*', '*', '*']);
    minutes.push(...minutesOf(min));
  }
  expect(minutes.filter(m => m % 5 === 0), '정시·5분 단위는 예약이 몰리는 시각').toEqual([]);
});

test('저장소 사본(data/news.js)은 하루 한 번만 커밋하고, 커밋이 실패해도 배포는 한다', async () => {
  /* git 은 지난 커밋을 지울 수 없다(이력 재작성 필요). 그래서 애초에 적게 넣는다.
     15분마다 커밋하면 한 해 약 290MB, 하루 한 번이면 약 3MB (커밋당 약 8KB, 2026-09-30 측정). */
  const build = jobsOf(read(WF)).build;
  expect(build).toMatch(/daily=\$\(\[ "\$age" -ge 86400 \]/);
  const step = build.slice(build.indexOf('- name: 저장소 사본 커밋'));
  expect(step).toMatch(/if: steps\.daily\.outputs\.daily == 'true'/);
  expect(step).toMatch(/continue-on-error: true/);
  expect(step).toContain('git push');
  expect(read(WF)).toMatch(/^ {2}contents: write/m);
});

test('15분마다 생기는 기록은 오래되면 지운다 — 배포 산출물 1일, 실행·배포 기록 7일', async () => {
  const yml = read(WF);
  const jobs = jobsOf(yml);
  expect(jobs.build).toMatch(/actions\/upload-pages-artifact@v3\n\s+with:\n\s+path: _site\n\s+retention-days: 1/);

  // 하루 한 번(저장소 사본을 커밋하는 차례에) 돌고, 실패해도 수집·배포·다음 차례에는 영향이 없다
  const cleanup = jobs.cleanup;
  expect(ifOf(cleanup)).toBe("${{ !cancelled() && needs.build.result == 'success' && needs.build.outputs.daily == 'true' }}");
  expect(cleanup).toMatch(/^ {4}continue-on-error: true$/m);
  expect(jobs.next).not.toContain('cleanup');

  expect(cleanup).toContain("date -u -d '7 days ago'");
  expect(cleanup).toContain('-f created="<$cutoff"');
  expect(cleanup).toContain('-X DELETE "repos/$R/actions/runs/$id"');
  expect(cleanup).toContain('for env in news-interval github-pages; do');
  expect(cleanup).toContain('select(.created_at < \\"$cutoff\\")');
  // 배포 기록은 비활성으로 돌린 뒤에야 지울 수 있다
  expect(cleanup.indexOf('state=inactive')).toBeGreaterThan(-1);
  expect(cleanup.indexOf('state=inactive')).toBeLessThan(cleanup.indexOf('-X DELETE "repos/$R/deployments/$id"'));
  expect(yml).toMatch(/^ {2}deployments: write/m);
});
