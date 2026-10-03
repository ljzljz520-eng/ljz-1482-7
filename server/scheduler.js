'use strict';
// 定时发布：到点重新校验权限与全部发布门禁（权限变更即时生效）
const { q, audit } = require('./db');
const { canPublishCandidate } = require('./policy');
const { nowIso } = require('./common');

function runDue(now) {
  now = now || nowIso();
  const due = q.all(`SELECT * FROM schedules WHERE status='pending' AND run_at<=?`, now);
  const results = [];
  for (const s of due) {
    const cand = q.get('SELECT * FROM candidates WHERE id=?', s.candidate_id);
    const check = canPublishCandidate(cand, s.actor, now);
    if (!check.ok) {
      q.run(`UPDATE schedules SET status='blocked', block_reason=? WHERE id=?`,
        JSON.stringify(check.reasons), s.id);
      audit(s.actor, 'schedule.blocked', { schedule: s.id, candidate: s.candidate_id, reasons: check.reasons });
      results.push({ id: s.id, status: 'blocked', reasons: check.reasons });
      continue;
    }
    q.run(`UPDATE candidates SET status='published' WHERE id=?`, s.candidate_id);
    q.run(`UPDATE schedules SET status='done' WHERE id=?`, s.id);
    audit(s.actor, 'publish', { candidate: s.candidate_id, schedule: s.id, channel: cand.channel_code });
    results.push({ id: s.id, status: 'published' });
  }
  return results;
}

module.exports = { runDue };
