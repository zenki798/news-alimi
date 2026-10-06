#!/usr/bin/env node
/* 수집 상태 확인 — `npm run health`
   지킴이(scripts/watchdog.js)와 같은 기준으로 지금 상태를 판단해 보여 준다. 아무것도 바꾸지 않는다.
   - HEALTHY  : 최근 heartbeat 정상 (15분 안에 수집 성공, 실패한 피드 없음)
   - DEGRADED : 일부 피드 실패, 또는 수집이 멈춰 자동 복구 중
   - CRITICAL : 수집이 멈췄고 자동 복구 한도(1시간 3번)를 넘음 — 사람 확인 필요
   공개 저장소라 토큰 없이도 된다(GitHub API 시간당 60번). GITHUB_TOKEN 이 있으면 쓴다.
   종료 코드: HEALTHY 0, DEGRADED 1, CRITICAL 2 (다른 스크립트에서 쓸 수 있게) */
'use strict';

const { runWatchdog, RULES } = require('./watchdog');

runWatchdog({ dryRun: true, log: () => {} }).then(r => {
  const d = r.decision;
  const hb = r.heartbeat;
  const lines = [
    '뉴스 수집 상태: ' + d.status,
    '  판단: ' + d.reason,
    '  마지막 수집 성공: ' + (d.lastSuccess ? new Date(d.lastSuccess).toLocaleString('ko-KR') + ' (' + d.ageMin + '분 전)' : '기록 없음') +
      (r.heartbeatError ? '  — heartbeat 못 읽음(' + r.heartbeatError + '), 실행 기록으로 봄' : ''),
  ];
  if (hb) {
    lines.push('  heartbeat: run ' + hb.run_id + ' · 피드 ' + hb.sources_ok + '/' + hb.sources_total + ' 성공 · 기사 ' + hb.articles + '건 (새 기사 ' + hb.new_articles + '건)');
    (hb.failed_sources || []).forEach(s => lines.push('    실패: ' + s.source + ' ' + s.url + ' — ' + s.reason));
  }
  lines.push('  자동 복구: 최근 1시간(마지막 성공 이후) ' + d.used + '/' + RULES.LIMIT + '번');
  if (r.health) lines.push('  지킴이가 마지막으로 남긴 상태: ' + r.health.description + ' (' + new Date(r.health.created_at).toLocaleString('ko-KR') + ')');
  if (d.action.type !== 'none') lines.push('  지킴이가 다음 차례에 할 일: ' + d.action.type);
  console.log(lines.join('\n'));
  /* process.exit() 로 바로 끝내면 Windows 에서 열린 HTTP 연결 때문에 비정상 종료(0xC0000409)한다.
     종료 코드만 정해 두고 연결이 정리되면 저절로 끝나게 둔다 */
  process.exitCode = { HEALTHY: 0, DEGRADED: 1, CRITICAL: 2 }[d.status];
}).catch(e => {
  console.error('상태를 확인하지 못했습니다:', e.message);
  process.exitCode = 3;
});
