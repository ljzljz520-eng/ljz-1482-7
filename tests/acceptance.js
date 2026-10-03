'use strict';
/* 验收场景：
 * S1 模型上传中断与续传
 * S2 纹理晚到：渲染阻塞 -> 依赖定位 -> 纹理到达 -> 重试成功；占位产物禁止发布
 * S3 产品参数订正：证据新版本 -> 旧卖点/旧产物失效；高配卖点不得进入低配视频
 * S4 渠道字幕安全区冲突：检测、定位、修复后可发布
 * S5 定时发布前权限变更：到点重检权限，阻塞与恢复
 * S6 素材回收：保留仍被候选发布引用的对象
 * S7 公开包净化：无内部评审备注、无未解禁模型、规格仅公开字段
 * S8 渲染确定性与场景版本锁定
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const PORT = 18090;
const BASE = `http://127.0.0.1:${PORT}`;
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

let passed = 0, failed = 0;
function ok(cond, name, extra) {
  if (cond) { passed++; console.log(`  ✔ ${name}`); }
  else { failed++; console.error(`  ✘ ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`); }
}
async function api(user, method, p, body, raw) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'x-user': user, ...(body && !raw ? { 'Content-Type': 'application/json' } : {}) },
    body: raw ? body : body ? JSON.stringify(body) : undefined
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}
const J = (r, name) => { if (r.status >= 400) { console.error(`  ✘ ${name} HTTP ${r.status}`, r.data); failed++; throw new Error(name); } return r.data; };

async function waitHealth() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lac-'));
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')],
    { env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir }, stdio: 'pipe' });
  srv.stderr.on('data', d => process.stderr.write('[srv] ' + d));
  process.on('exit', () => srv.kill());
  await waitHealth();
  console.log('server up @' + BASE + ' data=' + dataDir);

  /* ---------- S1+S2 上传中断续传 & 纹理晚到 ---------- */
  console.log('\nS1/S2 上传中断续传 & 纹理晚到');
  const texSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="112"><rect width="256" height="112" fill="#222"/><text x="20" y="60" font-size="30" fill="#f0c">LATE-LOGO</text></svg>`;
  const texBuf = Buffer.from(texSvg);
  const texSha = sha256(texBuf);
  const c1 = texBuf.subarray(0, 60), c2 = texBuf.subarray(60, 140), c3 = texBuf.subarray(140);
  const up = J(await api('editor1', 'POST', '/api/uploads',
    { kind: 'texture', name: 'late-logo', version: 1, license: 'public', sha256: texSha, size: texBuf.length, chunks: 3 }), 'create upload');
  // 中断前：只传 0、1 两片
  await api('editor1', 'PUT', `/api/uploads/${up.uploadId}/chunks/0`, c1, true);
  await api('editor1', 'PUT', `/api/uploads/${up.uploadId}/chunks/1`, c2, true);
  const st1 = J(await api('editor1', 'GET', `/api/uploads/${up.uploadId}`), 'upload status');
  ok(st1.received.join(',') === '0,1', '中断后服务端记录已收分片 [0,1]', st1.received);
  const assetMid = J(await api('editor1', 'GET', `/api/assets/${up.assetId}`), 'asset mid');
  ok(assetMid.status === 'uploading', '上传未完成时资产状态 uploading');
  const doneEarly = await api('editor1', 'POST', `/api/uploads/${up.uploadId}/complete`);
  ok(doneEarly.status === 409, '分片不齐时 complete 被拒绝');

  // 纹理晚到：场景引用未就绪纹理 => 渲染阻塞且可定位
  const scLate = J(await api('editor1', 'POST', '/api/scenes', {
    productId: 'p_aurora', name: '晚到纹理场景',
    manifest: {
      model: { assetId: 'ast_model', version: 1 }, materials: { assetId: 'ast_mat', version: 1 },
      camera: { assetId: 'ast_cam', version: 1 }, lights: { assetId: 'ast_light', version: 1 },
      textures: [{ slot: 'logo', assetId: up.assetId, version: 1 }]
    }
  }), 'create scene late');
  const resolveLate = J(await api('editor1', 'GET', `/api/scenes/${scLate.id}/resolve`), 'resolve late');
  ok(!resolveLate.ok && resolveLate.missing[0].type === 'DEP_ASSET_NOT_READY', '场景解析报告纹理未就绪', resolveLate.missing);
  const tlLate = J(await api('editor1', 'POST', '/api/timelines', {
    productId: 'p_aurora', modelId: 'm_pro', sceneId: scLate.id, name: '晚到纹理视频',
    doc: { duration: 2, tracks: { scene: [{ id: 's1', start: 0, end: 2, sceneId: scLate.id, motion: { rpm: 9 } }], subtitles: [], callouts: [] } }
  }), 'create timeline late');
  const jobBlocked = J(await api('editor1', 'POST', '/api/render-jobs', { timelineId: tlLate.id, channel: 'web' }), 'render blocked');
  ok(jobBlocked.status === 'blocked', '纹理未就绪 => 渲染阻塞');
  const diag = J(await api('editor1', 'GET', `/api/render-jobs/${jobBlocked.id}/diagnose`), 'diagnose');
  ok(diag.blockers.some(b => b.ref && b.ref.kind === 'asset' && b.ref.id === up.assetId), '诊断可定位到具体纹理资产', diag.blockers);
  // 显式占位：可渲染但禁止发布
  const jobPh = J(await api('editor1', 'POST', '/api/render-jobs', { timelineId: tlLate.id, channel: 'web', allowPlaceholder: true }), 'render placeholder');
  ok(jobPh.status === 'done' && jobPh.placeholder === 1, '显式允许占位 => 内部预览产物生成');
  const candPh = await api('editor1', 'POST', '/api/candidates', { renderJobId: jobPh.id });
  ok(candPh.status === 422, '占位产物禁止进入候选发布');
  // 续传：客户端查询已收分片后补传缺失片
  const st2 = J(await api('viewer1', 'GET', `/api/uploads/${up.uploadId}`), 'resume query');
  ok(st2.received.join(',') === '0,1', '续传客户端可查询已收分片');
  await api('editor1', 'PUT', `/api/uploads/${up.uploadId}/chunks/2`, c3, true);
  const upDone = J(await api('editor1', 'POST', `/api/uploads/${up.uploadId}/complete`), 'complete upload');
  ok(upDone.status === 'ready' && upDone.sha256 === texSha, '续传完成 sha256 校验一致');
  const jobRetry = J(await api('editor1', 'POST', `/api/render-jobs/${jobBlocked.id}/retry`), 'retry job');
  ok(jobRetry.status === 'done' && jobRetry.placeholder === 0, '纹理到达后重试渲染成功（非占位）');

  /* ---------- S3 参数订正 & 高低配隔离 ---------- */
  console.log('\nS3 产品参数订正 & 高低配隔离');
  const jobPro = J(await api('editor1', 'POST', '/api/render-jobs', { timelineId: 'tl_main', channel: 'web' }), 'render pro v1');
  ok(jobPro.status === 'done', '订正前 Pro 视频渲染成功');
  const candV1 = J(await api('editor1', 'POST', '/api/candidates', { renderJobId: jobPro.id, reviewNotes: '内部评审：首批物料' }), 'candidate v1');
  J(await api('legal1', 'POST', `/api/evidence/ev_battery/correct`, { body: '订正：Pro 续航为 18h（原 20h 系实验室样机数据）。报告编号 LAB-2610-201。' }), 'evidence v2');
  const spVal = J(await api('editor1', 'GET', '/api/selling-points/sp_battery_pro/validate'), 'sp validate');
  ok(spVal.issues.some(i => i.type === 'EVIDENCE_STALE'), '证据订正后卖点标记 EVIDENCE_STALE');
  const chkV1 = J(await api('pub1', 'GET', `/api/candidates/${candV1.id}/check`), 'check stale candidate');
  ok(chkV1.reasons.some(r => r.type === 'EVIDENCE_STALE'), '旧产物因证据订正失效，禁止发布');
  const jobStale = J(await api('editor1', 'POST', '/api/render-jobs', { timelineId: 'tl_main', channel: 'web' }), 'render stale');
  ok(jobStale.status === 'blocked' && JSON.parse(jobStale.blockers_json).some(b => b.type === 'EVIDENCE_STALE'), '卖点未升级前重渲染被阻塞');
  J(await api('editor1', 'PATCH', '/api/selling-points/sp_battery_pro', { claim: '18 小时超长续航，周末出行不用充电', evidenceVersion: 2 }), 'sp upgrade');
  const jobPro2 = J(await api('editor1', 'POST', '/api/render-jobs', { timelineId: 'tl_main', channel: 'web' }), 'render pro v2');
  ok(jobPro2.status === 'done', '卖点升级后渲染恢复');
  // 高配卖点不得进入低配视频
  const tlStd = J(await api('editor1', 'POST', '/api/timelines', {
    productId: 'p_aurora', modelId: 'm_std', sceneId: 'sc_main', name: '标准版视频',
    doc: { duration: 2, tracks: { scene: [{ id: 's1', start: 0, end: 2, sceneId: 'sc_main', motion: { rpm: 9 } }], subtitles: [], callouts: [{ id: 'k1', start: 0, end: 2, spId: 'sp_battery_pro', anchor: 'top-right' }] } }
  }), 'create std timeline');
  const jobStd = J(await api('editor1', 'POST', '/api/render-jobs', { timelineId: tlStd.id, channel: 'web' }), 'render std with pro sp');
  ok(jobStd.status === 'blocked' && JSON.parse(jobStd.blockers_json).some(b => b.type === 'SP_MODEL_MISMATCH'), '高配卖点带入低配视频被阻塞', jobStd.blockers_json);
  J(await api('editor1', 'PATCH', '/api/selling-points/sp_battery_std', { claim: '8 小时日常续航，满足一天通勤', evidenceVersion: 2 }), 'std sp upgrade');
  const tlStdOk = J(await api('editor1', 'POST', '/api/timelines', {
    productId: 'p_aurora', modelId: 'm_std', sceneId: 'sc_main', name: '标准版视频-合规',
    doc: { duration: 2, tracks: { scene: [{ id: 's1', start: 0, end: 2, sceneId: 'sc_main', motion: { rpm: 9 } }], subtitles: [], callouts: [{ id: 'k1', start: 0, end: 2, spId: 'sp_battery_std', anchor: 'top-right' }] } }
  }), 'create std timeline ok');
  const jobStdOk = J(await api('editor1', 'POST', '/api/render-jobs', { timelineId: tlStdOk.id, channel: 'web' }), 'render std ok');
  ok(jobStdOk.status === 'done', '低配型号使用本型号卖点渲染成功');

  /* ---------- S4 字幕安全区冲突 ---------- */
  console.log('\nS4 渠道字幕安全区冲突');
  const longText = 'Aurora S1 Pro 智能音箱采用全新一代声学架构与空间音频算法支持全屋互联语音助手长续航快充'.repeat(2);
  const tlConflict = J(await api('editor1', 'POST', '/api/timelines', {
    productId: 'p_aurora', modelId: 'm_pro', sceneId: 'sc_main', name: '长字幕视频',
    doc: { duration: 3, tracks: { scene: [{ id: 's1', start: 0, end: 3, sceneId: 'sc_main', motion: { rpm: 9 } }], subtitles: [{ id: 'c1', start: 0.2, end: 2.8, text: longText }], callouts: [] } }
  }), 'create conflict timeline');
  const valShort = J(await api('editor1', 'GET', `/api/timelines/${tlConflict.id}/validate?channel=short`), 'validate short');
  ok(valShort.conflicts.length > 0 && valShort.conflicts[0].cueId === 'c1', '竖屏渠道检出字幕安全区冲突并可定位到字幕块', valShort.conflicts);
  const jobConflict = J(await api('editor1', 'POST', '/api/render-jobs', { timelineId: tlConflict.id, channel: 'short' }), 'render conflict');
  ok(jobConflict.status === 'done' && JSON.parse(jobConflict.conflicts_json).length > 0, '冲突被记录在渲染产物中');
  const candConflict = J(await api('editor1', 'POST', '/api/candidates', { renderJobId: jobConflict.id }), 'candidate conflict');
  J(await api('legal1', 'POST', `/api/candidates/${candConflict.id}/approve`), 'approve conflict');
  const pubConflict = await api('pub1', 'POST', `/api/candidates/${candConflict.id}/publish`);
  ok(pubConflict.status === 422 && pubConflict.data.reasons.some(r => r.type === 'SAFEZONE_CONFLICT'), '安全区冲突未解决禁止发布');
  // 修复字幕
  const tlDoc = JSON.parse(J(await api('editor1', 'GET', `/api/timelines/${tlConflict.id}`), 'get tl').doc_json);
  tlDoc.tracks.subtitles[0].text = 'Aurora S1 Pro，声临其境';
  J(await api('editor1', 'PATCH', `/api/timelines/${tlConflict.id}`, { doc: tlDoc }), 'fix subtitle');
  const valFixed = J(await api('editor1', 'GET', `/api/timelines/${tlConflict.id}/validate?channel=short`), 'validate fixed');
  ok(valFixed.conflicts.length === 0, '修复后安全区冲突消除');
  const jobFixed = J(await api('editor1', 'POST', '/api/render-jobs', { timelineId: tlConflict.id, channel: 'short' }), 'render fixed');
  const candFixed = J(await api('editor1', 'POST', '/api/candidates', { renderJobId: jobFixed.id, reviewNotes: '内部评审：竖版字幕已收敛' }), 'candidate fixed');
  J(await api('legal1', 'POST', `/api/candidates/${candFixed.id}/approve`), 'approve fixed');

  /* ---------- S5 定时发布前权限变更 + 保密期门禁 ---------- */
  console.log('\nS5 定时发布前权限变更 & 保密期');
  // 保密期门禁：临时把产品保密期改到未来
  J(await api('admin', 'PATCH', '/api/products/p_aurora', { embargoUntil: '2027-01-01T00:00:00Z' }), 'set embargo future');
  const chkEmb = J(await api('pub1', 'GET', `/api/candidates/${candFixed.id}/check`), 'check embargo');
  ok(chkEmb.reasons.some(r => r.type === 'EMBARGO'), '保密期内禁止发布');
  J(await api('admin', 'PATCH', '/api/products/p_aurora', { embargoUntil: '2026-10-01T00:00:00Z' }), 'restore embargo');
  const runAt = new Date(Date.now() + 3600e3).toISOString();
  const sch = J(await api('pub1', 'POST', `/api/candidates/${candFixed.id}/schedule`, { runAt }), 'schedule');
  // 权限变更：发布员被降级
  J(await api('admin', 'PATCH', '/api/users/pub1', { role: 'viewer' }), 'revoke publisher');
  const due1 = J(await api('admin', 'POST', '/api/schedules/run-due', { now: new Date(Date.now() + 3601e3).toISOString() }), 'run due 1');
  ok(due1[0].status === 'blocked' && due1[0].reasons.some(r => r.type === 'PERMISSION_DENIED'), '定时发布前权限被撤 => 到点阻塞', due1);
  const schAfter = J(await api('viewer1', 'GET', '/api/schedules'), 'schedules');
  ok(schAfter.find(s => s.id === sch.id).status === 'blocked', '计划状态为 blocked');
  // 恢复权限后重新执行
  J(await api('admin', 'PATCH', '/api/users/pub1', { role: 'publisher' }), 'restore publisher');
  J(await api('admin', 'PATCH', `/api/users/pub1`, { role: 'publisher' }), 'idempotent');
  await api('admin', 'POST', `/api/schedules/${sch.id}/cancel`);
  // 重新排期（blocked 计划不可重跑，创建新计划）
  const sch2 = J(await api('pub1', 'POST', `/api/candidates/${candFixed.id}/schedule`, { runAt }), 'reschedule');
  const due2 = J(await api('admin', 'POST', '/api/schedules/run-due', { now: new Date(Date.now() + 3601e3).toISOString() }), 'run due 2');
  ok(due2.some(d => d.id === sch2.id && d.status === 'published'), '权限恢复后定时发布成功', due2);
  const candPub = J(await api('viewer1', 'GET', '/api/candidates'), 'candidates');
  ok(candPub.find(c => c.id === candFixed.id).status === 'published', '候选状态 published');

  /* ---------- S6 素材回收保留候选引用 ---------- */
  console.log('\nS6 素材回收');
  const pubCand = candPub.find(c => c.id === candFixed.id);
  const pubJob = J(await api('viewer1', 'GET', `/api/render-jobs/${pubCand.render_job_id}`), 'pub job');
  const artMeta = J(await api('viewer1', 'GET', `/api/artifacts/${pubJob.output_asset_id}/meta`), 'artifact meta');
  const frameSha = artMeta.frames[0];
  // 退役产物资产：对象仍被候选发布引用，GC 必须保留
  J(await api('admin', 'PATCH', `/api/assets/${pubJob.output_asset_id}`, { status: 'retired' }), 'retire artifact asset');
  // 制造孤儿对象：上传后标记失败
  const orphanBuf = Buffer.from('orphan texture bytes ' + Date.now());
  const upOrphan = J(await api('editor1', 'POST', '/api/uploads', { kind: 'texture', name: 'orphan', version: 1, sha256: sha256(orphanBuf), size: orphanBuf.length, chunks: 1 }), 'orphan upload');
  await api('editor1', 'PUT', `/api/uploads/${upOrphan.uploadId}/chunks/0`, orphanBuf, true);
  const orphanAsset = J(await api('editor1', 'POST', `/api/uploads/${upOrphan.uploadId}/complete`), 'orphan complete');
  J(await api('admin', 'PATCH', `/api/assets/${orphanAsset.id}`, { status: 'failed' }), 'orphan failed');
  const gcDry = J(await api('admin', 'POST', '/api/gc', { dryRun: true }), 'gc dry');
  ok(gcDry.deleted.includes(sha256(orphanBuf)), '预演：孤儿对象可回收');
  ok(!gcDry.deleted.includes(frameSha), '预演：候选发布引用的帧对象被保留');
  const gcRun = J(await api('admin', 'POST', '/api/gc', {}), 'gc run');
  ok(gcRun.deleted.includes(sha256(orphanBuf)), '执行：孤儿对象已删除');
  const frameGet = await fetch(BASE + '/api/objects/' + frameSha);
  ok(frameGet.status === 200, '执行后候选引用的帧对象仍可访问');
  const orphanGet = await fetch(BASE + '/api/objects/' + sha256(orphanBuf));
  ok(orphanGet.status === 404, '孤儿对象已不可访问');

  /* ---------- S7 公开包净化 ---------- */
  console.log('\nS7 公开包净化');
  J(await api('admin', 'POST', '/api/products/p_aurora/models', { code: 'DEV', name: '内部工程机', tier: 'dev', specs: { cost: '999' }, publicFields: ['cost'], status: 'development' }), 'create dev model');
  J(await api('admin', 'PATCH', '/api/models/m_pro', { specs: { battery: '18h', charge: '30W', driver: '50mm', codec: 'LHDC', weight: '610g', cost_price: '699' } }), 'add secret spec');
  const exp = J(await api('legal1', 'POST', '/api/products/p_aurora/export'), 'export');
  const man = exp.manifest;
  ok(!man.models.some(m => m.code === 'DEV'), '公开包不含未发布型号');
  ok(man.models.every(m => !('cost_price' in m.specs)), '公开包规格仅含公开字段白名单');
  ok(man.channels.length >= 1, '公开包含已发布渠道成果');
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const allText = walk(exp.dir).filter(f => f.endsWith('.json') || f.endsWith('.html') || f.endsWith('.svg') || f.endsWith('.txt'))
    .map(f => fs.readFileSync(f, 'utf8')).join('\n');
  ok(!allText.includes('首批物料') && !allText.includes('竖版字幕已收敛') && !allText.includes('review_notes'), '公开包不含内部评审备注');
  ok(!allText.includes('LAB-2609') && !allText.includes('证据'), '公开包不含内部证据编号');
  ok(!allText.includes('成本') && !allText.includes('cost_price'), '公开包不含内部成本字段');

  /* ---------- S8 确定性 & 场景版本锁定 ---------- */
  console.log('\nS8 渲染确定性 & 版本锁定');
  const j1 = J(await api('editor1', 'POST', '/api/render-jobs', { timelineId: 'tl_main', channel: 'web' }), 'det j1');
  const j2 = J(await api('editor1', 'POST', '/api/render-jobs', { timelineId: 'tl_main', channel: 'web' }), 'det j2');
  ok(j1.input_hash === j2.input_hash, '相同输入 => 相同输入哈希（确定性）');
  const m1 = J(await api('viewer1', 'GET', `/api/artifacts/${j1.output_asset_id}/meta`), 'meta1');
  const m2 = J(await api('viewer1', 'GET', `/api/artifacts/${j2.output_asset_id}/meta`), 'meta2');
  ok(JSON.stringify(m1.frames) === JSON.stringify(m2.frames), '两次渲染帧对象逐字节一致');
  const verify = J(await api('editor1', 'POST', `/api/render-jobs/${j1.id}/verify`), 'verify');
  ok(verify.match && verify.deterministicInputsPresent, '确定性校验端点通过');
  // 上传模型 v2，场景清单仍锁 v1 => 输出不变
  const modelObj = await (await fetch(BASE + '/api/assets/ast_model/object')).text();
  const modelBuf = Buffer.from(modelObj);
  const upV2 = J(await api('editor1', 'POST', '/api/uploads', { kind: 'model3d', name: 'aurora-speaker', version: 2, license: 'public', sha256: sha256(modelBuf), size: modelBuf.length, chunks: 1 }), 'upload model v2');
  await api('editor1', 'PUT', `/api/uploads/${upV2.uploadId}/chunks/0`, modelBuf, true);
  J(await api('editor1', 'POST', `/api/uploads/${upV2.uploadId}/complete`), 'complete v2');
  const j3 = J(await api('editor1', 'POST', '/api/render-jobs', { timelineId: 'tl_main', channel: 'web' }), 'det j3');
  ok(j3.input_hash === j1.input_hash, '模型 v2 上传后，锁定 v1 的场景输出不变（版本锁定）');
  // 新场景清单锁 v2 => 输入哈希变化
  const scV2 = J(await api('editor1', 'POST', '/api/scenes/sc_main/versions', {
    manifest: {
      model: { assetId: upV2.assetId, version: 2 }, materials: { assetId: 'ast_mat', version: 1 },
      camera: { assetId: 'ast_cam', version: 1 }, lights: { assetId: 'ast_light', version: 1 },
      textures: [{ slot: 'logo', assetId: 'ast_tex_logo', version: 1 }]
    }
  }), 'scene v2');
  const tlV2 = J(await api('editor1', 'POST', '/api/timelines', {
    productId: 'p_aurora', modelId: 'm_pro', sceneId: scV2.id, name: 'v2场景视频',
    doc: { duration: 2, tracks: { scene: [{ id: 's1', start: 0, end: 2, sceneId: scV2.id, motion: { rpm: 9 } }], subtitles: [], callouts: [] } }
  }), 'timeline v2');
  const j4 = J(await api('editor1', 'POST', '/api/render-jobs', { timelineId: tlV2.id, channel: 'web' }), 'det j4');
  ok(j4.status === 'done' && j4.input_hash !== j1.input_hash, '切换场景清单版本 => 输入哈希变化（可追溯）');

  console.log(`\n========== ${passed} passed, ${failed} failed ==========`);
  srv.kill();
  process.exit(failed ? 1 : 0);
}
main().catch(e => { console.error(e); process.exit(1); });
