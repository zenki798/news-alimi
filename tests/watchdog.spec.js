// 수집 지킴이(scripts/watchdog.js) — 장애를 흉내 내어 판단·복구·한도가 예상대로인지 본다.
// 가짜 GitHub API·가짜 사이트를 이 테스트 안에 띄워 실제 HTTP 요청이 오가게 한다(네트워크 밖으로 나가지 않는다).
const { test, expect } = require('@playwright/test');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { decide, runWatchdog, RULES } = require('../scripts/watchdog');

const MIN = 60000;
const NOW = Date.parse('2026-10-06T00:00:00Z');
const iso = ms => new Date(ms).toISOString();
const hb = (agoMin, extra) => Object.assign({ last_success_at: iso(NOW - agoMin * MIN), run_id: '1', sources_ok: 28, sources_failed: 0,
  sources_total: 28, articles: 160, new_articles: 3, carried_over: [] }, extra);
const run = (id, status, conclusion, updatedAgoMin, createdAgoMin) => ({ id, status, conclusion,
  created_at: iso(NOW - (createdAgoMin == null ? updatedAgoMin : createdAgoMin) * MIN), updated_at: iso(NOW - updatedAgoMin * MIN) });

/* ---------- 판단 (순수 함수) ---------- */

test.describe('판단 — decide()', () => {
  test('heartbeat 가 15분 안이면 정상: 실패한 피드가 없으면 HEALTHY, 있으면 DEGRADED. 아무것도 하지 않는다', () => {
    expect(decide({ now: NOW, heartbeat: hb(4), runs: [] })).toMatchObject({ status: 'HEALTHY', action: { type: 'none' } });
    expect(decide({ now: NOW, heartbeat: hb(14), runs: [] }).status).toBe('HEALTHY');
    const d = decide({ now: NOW, heartbeat: hb(4, { sources_failed: 2 }), runs: [] });
    expect(d).toMatchObject({ status: 'DEGRADED', action: { type: 'none' } });
    expect(d.reason).toContain('피드 2개 실패');
  });

  test('heartbeat 가 15분 넘게 멈췄고 차례가 없으면(사슬 끊김) 새로 부른다', () => {
    const d = decide({ now: NOW, heartbeat: hb(16), runs: [run(1, 'completed', 'success', 16)] });
    expect(d).toMatchObject({ status: 'DEGRADED', action: { type: 'dispatch' } });
    expect(d.reason).toContain('16분째 수집 멈춤');
  });

  test('돌고 있는 차례가 최근에 움직였으면 겹쳐 실행하지 않고 기다린다 (중복 실행 방지)', () => {
    for (const status of ['queued', 'in_progress', 'waiting', 'pending']) {
      const d = decide({ now: NOW, heartbeat: hb(18), runs: [run(2, status, null, 3)] });
      expect(d.action.type, status).toBe('none');
      expect(d.reason).toContain('겹쳐 실행하지 않고');
    }
  });

  test('2026-10-05 장애: 차례가 대기열에서 7시간 그대로면 취소하고 새로 부른다', () => {
    const d = decide({ now: NOW, heartbeat: hb(7 * 60), runs: [run(37345927640, 'queued', null, 7 * 60)] });
    expect(d).toMatchObject({ status: 'DEGRADED', action: { type: 'cancel-dispatch', runIds: [37345927640] } });
  });

  test('멈춘 차례 뒤에 기다리는 차례가 있으면 취소만 한다 (그 차례가 이어 돈다 — 새로 부르면 겹친다)', () => {
    const d = decide({ now: NOW, heartbeat: hb(7 * 60), runs: [run(10, 'queued', null, 7 * 60), run(11, 'pending', null, 5 * 60)] });
    expect(d.action).toEqual({ type: 'cancel', runIds: [10] });
  });

  test('최근 차례가 실패·시간 초과·취소면 그 차례를 다시 실행한다. 1시간 넘은 실패는 새로 부른다', () => {
    for (const c of ['failure', 'timed_out', 'cancelled', 'startup_failure']) {
      expect(decide({ now: NOW, heartbeat: hb(20), runs: [run(5, 'completed', c, 8)] }).action, c).toEqual({ type: 'rerun', runId: 5 });
    }
    expect(decide({ now: NOW, heartbeat: hb(90), runs: [run(5, 'completed', 'failure', 80)] }).action.type).toBe('dispatch');
  });

  test('자동 복구는 1시간에 3번까지 — 넘으면 CRITICAL 로 남기고 더 하지 않는다', () => {
    const rec = [5, 15, 25].map(m => ({ at: NOW - m * MIN }));
    const d = decide({ now: NOW, heartbeat: hb(60), runs: [], recoveries: rec });
    expect(d).toMatchObject({ status: 'CRITICAL', action: { type: 'none' }, used: 3 });
    expect(RULES.LIMIT).toBe(3);
  });

  test('수집이 다시 성공하면 복구 횟수는 저절로 0 이 된다 (마지막 성공 이후의 복구만 센다)', () => {
    const rec = [40, 45, 50].map(m => ({ at: NOW - m * MIN }));          // 30분 전 성공보다 앞선 복구들
    expect(decide({ now: NOW, heartbeat: hb(30), runs: [], recoveries: rec })).toMatchObject({ used: 0, action: { type: 'dispatch' } });
    expect(decide({ now: NOW, heartbeat: hb(3), runs: [], recoveries: rec })).toMatchObject({ status: 'HEALTHY', used: 0 });
  });

  test('한 시간이 지나면 다시 복구를 시도한다 (영영 멈추지 않되, 시간당 3번을 넘지 않는다)', () => {
    const rec = [65, 70, 75].map(m => ({ at: NOW - m * MIN }));
    expect(decide({ now: NOW, heartbeat: hb(120), runs: [], recoveries: rec })).toMatchObject({ used: 0, action: { type: 'dispatch' } });
  });

  test('heartbeat 를 못 읽으면 성공한 실행 기록으로 대신 본다 — 사이트만 잠깐 안 보일 때 멀쩡한 수집을 건드리지 않는다', () => {
    const d = decide({ now: NOW, heartbeat: null, runs: [run(3, 'completed', 'success', 4), run(4, 'waiting', null, 1)] });
    expect(d).toMatchObject({ status: 'DEGRADED', basis: 'runs', action: { type: 'none' } });
    expect(decide({ now: NOW, heartbeat: null, runs: [] }).action.type).toBe('dispatch');
  });
});

/* ---------- 실제로 돌려 보기 — 가짜 GitHub API·사이트 ---------- */

function fakeGitHub(initial) {
  const s = Object.assign({ heartbeat: null, runs: [], statuses: [], posts: [], rerunFails: false, cancelFails: false }, initial);
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const p = req.url.split('?')[0];
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      if (req.method === 'GET') {
        if (p === '/site/data/status.json') return s.heartbeat ? send(200, s.heartbeat) : send(404, { message: 'Not Found' });
        if (p === '/repos/o/r/actions/workflows/fetch-news.yml/runs') return send(200, { workflow_runs: s.runs });
        if (p === '/repos/o/r/commits/main/status') {
          const latest = {};
          s.statuses.forEach(x => { if (!latest[x.context]) latest[x.context] = x; });
          return send(200, { sha: 'sha1', statuses: Object.values(latest) });
        }
        if (p === '/repos/o/r/commits/sha1/statuses') return send(200, s.statuses);
        return send(404, { message: 'no route ' + p });
      }
      const json = body ? JSON.parse(body) : null;
      s.posts.push({ path: p, body: json });
      if (/\/actions\/runs\/\d+\/cancel$/.test(p)) return s.cancelFails ? send(409, { message: 'Cannot cancel' }) : send(202, {});
      if (/\/actions\/runs\/\d+\/force-cancel$/.test(p)) return send(202, {});
      if (/\/rerun-failed-jobs$/.test(p)) return s.rerunFails ? send(403, { message: 'too old' }) : send(201, {});
      if (p === '/repos/o/r/actions/workflows/fetch-news.yml/dispatches') return send(204);
      if (p === '/repos/o/r/statuses/sha1') {
        s.statuses.unshift(Object.assign({ created_at: iso(s.now || NOW) }, json));
        return send(201, {});
      }
      return send(404, { message: 'no route ' + p });
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => {
    const base = 'http://127.0.0.1:' + server.address().port;
    resolve({ s, base, close: () => new Promise(r => server.close(r)) });
  }));
}

const go = (g, now) => { g.s.now = now; g.s.posts = []; return runWatchdog({ base: g.base, repo: 'o/r', token: 't', site: g.base + '/site/', now, log: () => {}, summaryFile: '' }); };
const paths = g => g.s.posts.map(x => x.path.replace('/repos/o/r', ''));

test.describe('실제로 돌려 보기 — runWatchdog()', () => {
  test('정상이면 아무것도 하지 않고, 상태는 바뀔 때만 남긴다', async () => {
    const g = await fakeGitHub({ heartbeat: hb(3), runs: [run(1, 'waiting', null, 1)] });
    try {
      const r1 = await go(g, NOW);
      expect(r1.decision.status).toBe('HEALTHY');
      expect(paths(g)).toEqual(['/statuses/sha1']);                    // 처음이라 상태 한 번
      expect(g.s.posts[0].body).toMatchObject({ context: 'news/health', state: 'success' });
      await go(g, NOW + MIN);
      expect(paths(g), '그대로면 다시 남기지 않는다').toEqual([]);
    } finally { await g.close(); }
  });

  test('2026-10-05 장애 재현: 7시간 멈춘 차례를 취소하고 새로 부르고, 복구 기록과 DEGRADED 를 남긴다', async () => {
    const g = await fakeGitHub({ heartbeat: hb(7 * 60), runs: [run(37345927640, 'queued', null, 7 * 60)] });
    try {
      const r = await go(g, NOW);
      expect(r.done).toContain('취소');
      expect(paths(g)).toEqual(['/actions/runs/37345927640/cancel', '/actions/workflows/fetch-news.yml/dispatches', '/statuses/sha1', '/statuses/sha1']);
      expect(g.s.posts[1].body).toEqual({ ref: 'main', inputs: { chain: 'false', reason: 'watchdog' } });
      expect(g.s.posts[2].body).toMatchObject({ context: 'news/recovery', description: expect.stringContaining('자동 복구 1/3') });
      expect(g.s.posts[3].body).toMatchObject({ context: 'news/health', state: 'pending', description: 'DEGRADED: 수집 멈춤 — 자동 복구 중' });
    } finally { await g.close(); }
  });

  test('취소가 안 되면 강제 취소(force-cancel)한다', async () => {
    const g = await fakeGitHub({ heartbeat: hb(60), runs: [run(9, 'in_progress', null, 50)], cancelFails: true });
    try {
      await go(g, NOW);
      expect(paths(g).slice(0, 3)).toEqual(['/actions/runs/9/cancel', '/actions/runs/9/force-cancel', '/actions/workflows/fetch-news.yml/dispatches']);
    } finally { await g.close(); }
  });

  test('수집 워크플로가 실패했으면 다시 실행하고, 다시 실행이 안 되면 새로 부른다', async () => {
    const g = await fakeGitHub({ heartbeat: hb(20), runs: [run(7, 'completed', 'failure', 6)] });
    try {
      await go(g, NOW);
      expect(paths(g)[0]).toBe('/actions/runs/7/rerun-failed-jobs');
      g.s.rerunFails = true;
      g.s.statuses = [];
      const r = await go(g, NOW);
      expect(paths(g).slice(0, 2)).toEqual(['/actions/runs/7/rerun-failed-jobs', '/actions/workflows/fetch-news.yml/dispatches']);
      expect(r.done).toContain('다시 실행 실패(403)');
    } finally { await g.close(); }
  });

  test('중복 실행 요청: 돌고 있는 차례가 있으면 heartbeat 가 멈춰도 새로 부르지 않는다', async () => {
    const g = await fakeGitHub({ heartbeat: hb(17), runs: [run(8, 'in_progress', null, 1)] });
    try {
      const r = await go(g, NOW);
      expect(r.done).toBeNull();
      expect(paths(g).filter(p => !p.startsWith('/statuses'))).toEqual([]);
    } finally { await g.close(); }
  });

  test('연속 복구 실패: 복구해도 heartbeat 가 안 돌아오면 3번까지만 하고 CRITICAL, 성공하면 HEALTHY 로 돌아온다', async () => {
    const g = await fakeGitHub({ heartbeat: hb(20), runs: [] });
    try {
      const actions = [];
      for (let i = 0; i < 5; i++) {
        const r = await go(g, NOW + i * 10 * MIN);                    // 지킴이는 약 10분마다
        actions.push(r.decision.status + ':' + r.decision.action.type);
      }
      expect(actions).toEqual(['DEGRADED:dispatch', 'DEGRADED:dispatch', 'DEGRADED:dispatch', 'CRITICAL:none', 'CRITICAL:none']);
      expect(g.s.statuses.find(x => x.context === 'news/health')).toMatchObject({ state: 'failure', description: expect.stringContaining('CRITICAL') });

      /* 수집이 다시 성공(heartbeat 갱신) → HEALTHY, 복구 횟수 0 */
      g.s.heartbeat = hb(-49);                                          // 지금(NOW+50분)보다 1분 전 성공
      const ok = await go(g, NOW + 50 * MIN);
      expect(ok.decision).toMatchObject({ status: 'HEALTHY', used: 0 });
      expect(g.s.statuses[0]).toMatchObject({ context: 'news/health', state: 'success' });
    } finally { await g.close(); }
  });

  test('사이트의 heartbeat 를 못 읽어도(404) 수집 기록이 정상이면 건드리지 않는다', async () => {
    const g = await fakeGitHub({ heartbeat: null, runs: [run(3, 'completed', 'success', 3), run(4, 'waiting', null, 1)] });
    try {
      const r = await go(g, NOW);
      expect(r.decision).toMatchObject({ basis: 'runs', action: { type: 'none' } });
      expect(r.heartbeatError).toBe('HTTP 404');
    } finally { await g.close(); }
  });

  test('npm run health: 같은 기준으로 상태를 보여 주고, 종료 코드로도 알린다 (HEALTHY 0 · DEGRADED 1 · CRITICAL 2)', async () => {
    const g = await fakeGitHub({ heartbeat: hb(-1, { last_success_at: new Date(Date.now() - 2 * MIN).toISOString() }), runs: [] });
    const health = () => new Promise(resolve => {
      const env = Object.assign({}, process.env, { GITHUB_API_URL: g.base, GITHUB_REPOSITORY: 'o/r', SITE_URL: g.base + '/site/', GITHUB_TOKEN: '' });
      const c = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'health.js')], { env });
      let out = '';
      c.stdout.on('data', d => { out += d; });
      c.on('close', code => resolve({ code, out }));
    });
    try {
      let r = await health();
      expect(r.code).toBe(0);
      expect(r.out).toContain('뉴스 수집 상태: HEALTHY');
      expect(r.out).toContain('피드 28/28 성공');

      g.s.heartbeat.last_success_at = new Date(Date.now() - 3 * 3600000).toISOString();
      g.s.statuses = [1, 2, 3].map(i => ({ context: 'news/recovery', state: 'success', created_at: new Date(Date.now() - i * 5 * MIN).toISOString() }));
      r = await health();
      expect(r.code).toBe(2);
      expect(r.out).toContain('뉴스 수집 상태: CRITICAL');
      expect(g.s.posts, '상태 확인은 아무것도 바꾸지 않는다').toEqual([]);
    } finally { await g.close(); }
  });
});
