#!/usr/bin/env node
/* ===========================================================
   수집 지킴이 (watchdog) — 수집 사슬이 멈추면 사람 없이 찾아서 되살린다
   ---------------------------------------------------------
   왜 필요한가 (2026-10-05 실제 장애)
   수집(fetch-news.yml)의 배포 작업이 GitHub 서버를 배정받지 못해 대기열에 7시간 멈췄다.
   "한 번에 하나만" 규칙(concurrency)이라 뒤의 차례·예비 예약도 모두 줄만 섰고, GitHub 는 대기열 작업을
   24시간이 지나야 취소한다. 같은 시각 GitHub 에 "Incident with Actions"(19:11~22:49 UTC)가 기록돼 있다.
   그래서 수집과 따로 도는 지킴이가 "마지막 성공"을 보고, 멈췄으면 되살린다.

   무엇을 보나
   - heartbeat: 수집기가 성공할 때마다 사이트에 함께 올리는 data/status.json 의 last_success_at.
     사이트에서 읽으므로 "수집했는데 배포가 멈춘" 경우(이번 장애)도 잡힌다.
   - 수집 실행 기록(GitHub Actions REST API).
   - 자동 복구 기록: main 의 최신 커밋에 남기는 상태(commit status) news/recovery.

   판단 (decide — 순수 함수, tests/watchdog.spec.js)
   - heartbeat 가 15분 안이면 정상. 피드 일부가 실패했으면 DEGRADED, 아니면 HEALTHY.
   - 15분 넘게 멈췄으면 장애 후보:
     A. 자동 복구를 최근 1시간에(마지막 성공 이후) 3번 했으면 더 하지 않고 CRITICAL.
     B. 돌고 있는 차례가 있고 최근 20분 안에 움직였으면 겹쳐 실행하지 않고 기다린다.
     C. 돌고 있는데 20분 넘게 아무 변화가 없으면(이번 장애) 그 차례를 취소하고 새로 부른다.
        (뒤에 기다리던 차례가 있으면 취소만 한다 — 그 차례가 이어 돈다)
     D. 돌고 있는 차례가 없고 최근 차례가 실패·시간 초과·취소면 그 차례를 다시 실행한다.
     E. 돌고 있는 차례도, 다시 실행할 차례도 없으면(사슬이 끊김) 새로 부른다(workflow_dispatch).
   - 다음 지킴이 차례가 heartbeat 를 다시 본다. 성공하면 자동 복구 횟수는 저절로 0 이 된다
     (마지막 성공 이후의 복구만 센다).

   상태 기록: main 의 최신 커밋 상태 news/health — HEALTHY(초록)·DEGRADED(노랑)·CRITICAL(빨강).
   바뀔 때만 남긴다. 저장소 첫 화면의 커밋 옆 표시와 `npm run health` 로 본다.

   실행: node scripts/watchdog.js          (Actions: 판단하고 필요하면 복구)
         node scripts/watchdog.js --dry-run (판단만, 아무것도 바꾸지 않는다)
   =========================================================== */
'use strict';

const fs = require('fs');

const MIN = 60 * 1000;
const RULES = {
  STALE_MS: 15 * MIN,        // heartbeat 가 이보다 오래되면 장애 후보 (정상 주기는 약 5분)
  STUCK_MS: 20 * MIN,        // 돌고 있는 차례가 이만큼 아무 변화가 없으면 멈춘 것
  WINDOW_MS: 60 * MIN,       // 자동 복구 횟수를 세는 기간
  LIMIT: 3,                  // 그 기간에 할 수 있는 자동 복구 횟수
  RERUN_WITHIN_MS: 60 * MIN, // 이보다 오래된 실패 차례는 다시 실행하지 않고 새로 부른다
};
const WORKFLOW = 'fetch-news.yml';
const CTX_HEALTH = 'news/health';
const CTX_RECOVERY = 'news/recovery';
const ACTIVE = ['queued', 'in_progress', 'waiting', 'pending', 'requested'];
const MOVING_CHECK = ['queued', 'in_progress', 'waiting'];        // 이 셋은 오래 변화가 없으면 멈춘 것
const FAILED = ['failure', 'timed_out', 'cancelled', 'startup_failure'];
const STATE = { HEALTHY: 'success', DEGRADED: 'pending', CRITICAL: 'failure' };

const t = s => Date.parse(s || '') || 0;
const minutes = ms => Math.round(ms / MIN);

/**
 * 무엇을 할지 정한다 — 아무것도 바꾸지 않는 순수 함수.
 * @param now        지금(ms)
 * @param heartbeat  사이트의 data/status.json (못 읽었으면 null)
 * @param runs       수집 실행 기록 [{ id, status, conclusion, created_at, updated_at }]
 * @param recoveries 자동 복구 기록 [{ at(ms) }]
 */
function decide({ now, heartbeat, runs = [], recoveries = [] }) {
  /* 마지막 성공. heartbeat 를 못 읽었으면(사이트 장애 등) 성공한 실행 기록으로 대신한다 —
     사이트만 잠깐 안 보일 때 멀쩡한 수집을 "복구"하지 않으려는 것이다 */
  let basis = 'heartbeat';
  let lastSuccess = heartbeat ? t(heartbeat.last_success_at) : 0;
  if (!lastSuccess) {
    const ok = runs.filter(r => r.conclusion === 'success').sort((a, b) => t(b.updated_at) - t(a.updated_at))[0];
    lastSuccess = ok ? t(ok.updated_at) : 0;
    basis = ok ? 'runs' : 'none';
  }
  const age = lastSuccess ? now - lastSuccess : Infinity;
  const used = recoveries.filter(r => r.at > lastSuccess && now - r.at <= RULES.WINDOW_MS).length;
  const out = (status, reason, action) =>
    ({ status, reason, action: action || { type: 'none' }, lastSuccess, ageMin: age === Infinity ? null : minutes(age), used, basis });

  if (age <= RULES.STALE_MS) {
    if (basis !== 'heartbeat') return out('DEGRADED', '상태 파일(heartbeat)을 못 읽어 실행 기록으로 봄 — 수집은 정상');
    const failed = Number(heartbeat.sources_failed) || 0;
    const carried = (heartbeat.carried_over || []).length;
    if (failed || carried) return out('DEGRADED', '수집 정상, 피드 ' + failed + '개 실패' + (carried ? ' (지난 데이터로 채운 칸 ' + carried + '개)' : ''));
    return out('HEALTHY', '수집 정상');
  }

  const since = lastSuccess ? minutes(age) + '분째 수집 멈춤' : '수집 성공 기록 없음';
  if (used >= RULES.LIMIT) {
    return out('CRITICAL', since + ' — 최근 1시간 자동 복구 ' + used + '번을 다 써서 더 하지 않음. 사람 확인 필요');
  }

  const active = runs.filter(r => ACTIVE.indexOf(r.status) >= 0);
  const stuck = active.filter(r => MOVING_CHECK.indexOf(r.status) >= 0 && now - t(r.updated_at) > RULES.STUCK_MS);
  if (stuck.length) {
    const waitingBehind = active.some(r => stuck.indexOf(r) < 0);
    const ids = stuck.map(r => r.id);
    return out('DEGRADED', since + ' — 차례 ' + ids.join(',') + ' 가 ' + minutes(now - t(stuck[0].updated_at)) + '분째 그대로라 취소' +
      (waitingBehind ? '(뒤에 기다리던 차례가 이어 돈다)' : '하고 새로 부름'),
      { type: waitingBehind ? 'cancel' : 'cancel-dispatch', runIds: ids });
  }
  if (active.length) {
    return out('DEGRADED', since + ' — 수집 차례가 돌고 있어 겹쳐 실행하지 않고 기다림');
  }

  const latest = runs.filter(r => r.status === 'completed').sort((a, b) => t(b.created_at) - t(a.created_at))[0];
  if (latest && FAILED.indexOf(latest.conclusion) >= 0 && now - t(latest.updated_at) <= RULES.RERUN_WITHIN_MS) {
    return out('DEGRADED', since + ' — 최근 차례 ' + latest.id + ' 가 ' + latest.conclusion + ' 라 다시 실행', { type: 'rerun', runId: latest.id });
  }
  return out('DEGRADED', since + ' — 돌고 있는 수집 차례가 없어(사슬 끊김) 새로 부름', { type: 'dispatch' });
}

/** 상태 기록에 남길 짧은 글 (바뀔 때만 남기려고 분 단위 숫자는 넣지 않는다) */
function healthText(d) {
  if (d.status === 'HEALTHY') return 'HEALTHY: 수집 정상';
  if (d.status === 'CRITICAL') return 'CRITICAL: 수집 멈춤, 자동 복구 한도(1시간 ' + RULES.LIMIT + '번) 초과 — 사람 확인 필요';
  if (d.action.type !== 'none' || /멈춤|기록 없음/.test(d.reason)) return 'DEGRADED: 수집 멈춤 — 자동 복구 중';
  return ('DEGRADED: ' + d.reason).slice(0, 140);
}

/* ---------- GitHub REST API ---------- */

function client({ base, repo, token }) {
  return async function gh(method, p, body) {
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'newsalimi-watchdog',
    };
    if (token) headers.Authorization = 'Bearer ' + token;
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch(base + '/repos/' + repo + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    if (!r.ok) {
      const e = new Error(method + ' ' + p + ' → HTTP ' + r.status + ' ' + text.slice(0, 160));
      e.status = r.status;
      throw e;
    }
    return text ? JSON.parse(text) : null;
  };
}

async function readHeartbeat(site, now) {
  try {
    const r = await fetch(site.replace(/\/?$/, '/') + 'data/status.json?t=' + now, { headers: { 'Cache-Control': 'no-cache' } });
    if (!r.ok) return { heartbeat: null, error: 'HTTP ' + r.status };
    return { heartbeat: JSON.parse(await r.text()), error: null };
  } catch (e) {
    return { heartbeat: null, error: e.message };
  }
}

async function gather(gh, site, now) {
  const [{ heartbeat, error }, runsRes, combined] = await Promise.all([
    readHeartbeat(site, now),
    gh('GET', '/actions/workflows/' + WORKFLOW + '/runs?per_page=30'),
    gh('GET', '/commits/main/status'),
  ]);
  const statuses = await gh('GET', '/commits/' + combined.sha + '/statuses?per_page=100');
  const runs = (runsRes.workflow_runs || []).map(r => ({
    id: r.id, status: r.status, conclusion: r.conclusion, event: r.event,
    created_at: r.created_at, updated_at: r.updated_at, run_attempt: r.run_attempt, html_url: r.html_url,
  }));
  const recoveries = (statuses || []).filter(s => s.context === CTX_RECOVERY).map(s => ({ at: t(s.created_at), description: s.description }));
  const health = (combined.statuses || []).find(s => s.context === CTX_HEALTH) || null;
  return { heartbeat, heartbeatError: error, runs, recoveries, health, sha: combined.sha };
}

/** 정한 일을 한다. 한 일을 글로 돌려준다 */
async function act(gh, d, log) {
  const dispatch = async () => {
    await gh('POST', '/actions/workflows/' + WORKFLOW + '/dispatches', { ref: 'main', inputs: { chain: 'false', reason: 'watchdog' } });
    return '수집을 새로 부름';
  };
  const cancel = async id => {
    try { await gh('POST', '/actions/runs/' + id + '/cancel'); }
    catch (e) { log('  취소가 안 돼 강제 취소: ' + e.message); await gh('POST', '/actions/runs/' + id + '/force-cancel'); }
  };
  switch (d.action.type) {
    case 'cancel':
      for (const id of d.action.runIds) await cancel(id);
      return '멈춘 차례 ' + d.action.runIds.join(',') + ' 취소 (뒤 차례가 이어 돈다)';
    case 'cancel-dispatch':
      for (const id of d.action.runIds) await cancel(id);
      return '멈춘 차례 ' + d.action.runIds.join(',') + ' 취소, ' + await dispatch();
    case 'rerun':
      try {
        await gh('POST', '/actions/runs/' + d.action.runId + '/rerun-failed-jobs');
        return '실패한 차례 ' + d.action.runId + ' 다시 실행';
      } catch (e) {
        log('  다시 실행이 안 돼 새로 부름: ' + e.message);
        return '다시 실행 실패(' + e.status + '), ' + await dispatch();
      }
    case 'dispatch':
      return dispatch();
    default:
      return null;
  }
}

/**
 * 지킴이 한 번. dryRun 이면 판단만 하고 아무것도 바꾸지 않는다(npm run health 도 이것을 쓴다).
 */
async function runWatchdog({
  base = process.env.GITHUB_API_URL || 'https://api.github.com',
  repo = process.env.GITHUB_REPOSITORY || 'zenki798/news-alimi',
  token = process.env.GITHUB_TOKEN || '',
  site = process.env.SITE_URL || 'https://zenki798.github.io/news-alimi/',
  runUrl = process.env.RUN_URL || '',
  now = Date.now(),
  dryRun = false,
  log = m => console.log(m),
  summaryFile = process.env.GITHUB_STEP_SUMMARY || '',
} = {}) {
  const gh = client({ base, repo, token });
  const g = await gather(gh, site, now);
  const d = decide({ now, heartbeat: g.heartbeat, runs: g.runs, recoveries: g.recoveries });

  log('상태: ' + d.status + ' — ' + d.reason);
  log('  마지막 수집 성공: ' + (d.lastSuccess ? new Date(d.lastSuccess).toISOString() + ' (' + d.ageMin + '분 전, 근거 ' + d.basis + ')' : '없음') +
    (g.heartbeatError ? ' / heartbeat 못 읽음: ' + g.heartbeatError : ''));
  if (g.heartbeat) log('  heartbeat: run ' + g.heartbeat.run_id + ', 피드 ' + g.heartbeat.sources_ok + '개 성공·' + g.heartbeat.sources_failed + '개 실패, 기사 ' + g.heartbeat.articles + '건');
  log('  자동 복구: 최근 1시간(마지막 성공 이후) ' + d.used + '/' + RULES.LIMIT + '번');

  let done = null;
  const recorded = [];
  if (!dryRun) {
    done = await act(gh, d, log);
    if (done) {
      log('  자동 복구: ' + done);
      await gh('POST', '/statuses/' + g.sha, {
        state: 'success', context: CTX_RECOVERY, target_url: runUrl || undefined,
        description: ('자동 복구 ' + (d.used + 1) + '/' + RULES.LIMIT + ': ' + done).slice(0, 140),
      });
      recorded.push(CTX_RECOVERY);
    }
    const text = healthText(d);
    if (!g.health || g.health.state !== STATE[d.status] || g.health.description !== text) {
      await gh('POST', '/statuses/' + g.sha, { state: STATE[d.status], context: CTX_HEALTH, description: text, target_url: runUrl || undefined });
      recorded.push(CTX_HEALTH);
    }
    if (d.status === 'CRITICAL') log('::error::' + d.reason);
  } else if (d.action.type !== 'none') {
    log('  (확인만 — 실제로는 하지 않음) 할 일: ' + d.action.type);
  }

  if (summaryFile) {
    fs.appendFileSync(summaryFile, [
      '### 수집 지킴이: ' + d.status, '', '| 항목 | 값 |', '|---|---|',
      '| 판단 | ' + d.reason + ' |',
      '| 마지막 수집 성공 | ' + (d.lastSuccess ? new Date(d.lastSuccess).toISOString() + ' (' + d.ageMin + '분 전)' : '없음') + ' |',
      '| 자동 복구(최근 1시간) | ' + d.used + '/' + RULES.LIMIT + ' |',
      '| 한 일 | ' + (done || '없음') + ' |', '',
    ].join('\n'));
  }
  return { decision: d, done, recorded, heartbeat: g.heartbeat, heartbeatError: g.heartbeatError, health: g.health };
}

if (require.main === module) {
  runWatchdog({ dryRun: process.argv.includes('--dry-run') }).catch(e => {
    console.error('지킴이 실패:', e && e.stack ? e.stack : e);
    process.exitCode = 1;   // process.exit() 는 Windows 에서 열린 연결 때문에 비정상 종료할 수 있다
  });
}

module.exports = { decide, healthText, runWatchdog, RULES, STATE, CTX_HEALTH, CTX_RECOVERY, WORKFLOW };
