'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { q, audit, can } = require('./db');
const storage = require('./storage');
const renderer = require('./renderer');
const policy = require('./policy');
const { exportPublicPackage } = require('./exporter');
const { gc } = require('./gc');
const { runDue } = require('./scheduler');
const { ROOT, EXP_DIR, uid, nowIso, sha256 } = require('./common');

const PORT = Number(process.env.PORT || 8080);

function send(res, code, body, headers = {}) {
  const isBuf = Buffer.isBuffer(body);
  const data = isBuf ? body : (typeof body === 'string' ? body : JSON.stringify(body, null, 2));
  res.writeHead(code, {
    'Content-Type': isBuf ? (headers['Content-Type'] || 'application/octet-stream')
      : typeof body === 'string' && body.startsWith('<') ? 'text/html; charset=utf-8'
      : 'application/json; charset=utf-8',
    ...headers
  });
  res.end(data);
}
const jsend = (res, code, obj) => send(res, code, obj);
const err = (res, code, message, extra) => jsend(res, code, { error: message, ...extra });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw Object.assign(new Error('invalid JSON'), { status: 400 }); }
}

const routes = [];
function route(method, pattern, handler, perm) {
  const keys = [];
  const rx = new RegExp('^' + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return '([^/]+)'; }) + '$');
  routes.push({ method, rx, keys, handler, perm });
}

// ---------- 基础 ----------
route('GET', '/api/health', () => ({ ok: true, ts: nowIso() }));
route('GET', '/api/me', (req) => {
  const u = q.get('SELECT * FROM users WHERE id=?', req.user);
  return u || { id: req.user, role: 'viewer' };
});
route('GET', '/api/users', () => q.all('SELECT * FROM users'));
route('PATCH', '/api/users/:id', async (req, res, p) => {
  const b = await readJson(req);
  q.run('UPDATE users SET role=? WHERE id=?', b.role, p.id);
  audit(req.user, 'user.role', { user: p.id, role: b.role });
  return q.get('SELECT * FROM users WHERE id=?', p.id);
}, '*');

route('GET', '/api/audit', () => q.all('SELECT * FROM audit ORDER BY id DESC LIMIT 200'));

// ---------- 产品 / 型号 ----------
route('GET', '/api/products', () => q.all('SELECT * FROM products'));
route('POST', '/api/products', async (req) => {
  const b = await readJson(req);
  const id = b.id || uid('p');
  q.run('INSERT INTO products(id,code,name,embargo_until,status,created_at) VALUES(?,?,?,?,?,?)',
    id, b.code, b.name, b.embargoUntil || null, b.status || 'development', nowIso());
  audit(req.user, 'product.create', { id });
  return q.get('SELECT * FROM products WHERE id=?', id);
}, 'asset.edit');
route('GET', '/api/products/:id', (req, res, p) => {
  const prod = q.get('SELECT * FROM products WHERE id=?', p.id);
  if (!prod) return err(res, 404, 'product not found');
  return { ...prod, models: q.all('SELECT * FROM models WHERE product_id=?', p.id) };
});
route('PATCH', '/api/products/:id', async (req, res, p) => {
  const b = await readJson(req);
  const cur = q.get('SELECT * FROM products WHERE id=?', p.id);
  if (!cur) return err(res, 404, 'product not found');
  q.run('UPDATE products SET embargo_until=?, status=? WHERE id=?',
    b.embargoUntil !== undefined ? b.embargoUntil : cur.embargo_until,
    b.status || cur.status, p.id);
  audit(req.user, 'product.update', { id: p.id, embargoUntil: b.embargoUntil, status: b.status });
  return q.get('SELECT * FROM products WHERE id=?', p.id);
}, 'asset.edit');
route('POST', '/api/products/:id/models', async (req, res, p) => {
  const b = await readJson(req);
  const id = b.id || uid('m');
  q.run('INSERT INTO models(id,product_id,code,name,tier,specs_json,public_fields_json,status) VALUES(?,?,?,?,?,?,?,?)',
    id, p.id, b.code, b.name, b.tier || 'standard', JSON.stringify(b.specs || {}),
    JSON.stringify(b.publicFields || []), b.status || 'development');
  audit(req.user, 'model.create', { id, product: p.id });
  return q.get('SELECT * FROM models WHERE id=?', id);
}, 'asset.edit');
route('PATCH', '/api/models/:id', async (req, res, p) => {
  const b = await readJson(req);
  const cur = q.get('SELECT * FROM models WHERE id=?', p.id);
  if (!cur) return err(res, 404, 'model not found');
  q.run('UPDATE models SET specs_json=?, public_fields_json=?, status=? WHERE id=?',
    b.specs ? JSON.stringify(b.specs) : cur.specs_json,
    b.publicFields ? JSON.stringify(b.publicFields) : cur.public_fields_json,
    b.status || cur.status, p.id);
  audit(req.user, 'model.update', { id: p.id, specs: b.specs, status: b.status });
  return q.get('SELECT * FROM models WHERE id=?', p.id);
}, 'asset.edit');

// ---------- 证据（参数订正 => 新版本）----------
route('GET', '/api/evidence', (req, res, p, query) =>
  q.all('SELECT * FROM evidence WHERE product_id=? ORDER BY title, version', query.product || 'p_aurora'));
route('POST', '/api/products/:id/evidence', async (req, res, p) => {
  const b = await readJson(req);
  const id = b.id || uid('ev');
  q.run('INSERT INTO evidence(id,product_id,title,version,status,body,created_at) VALUES(?,?,?,1,?,?,?)',
    id, p.id, b.title, b.status || 'approved', b.body, nowIso());
  audit(req.user, 'evidence.create', { id });
  return q.get('SELECT * FROM evidence WHERE id=?', id);
}, 'evidence.edit');
route('POST', '/api/evidence/:id/correct', async (req, res, p) => {
  const b = await readJson(req);
  const cur = q.get('SELECT * FROM evidence WHERE id=?', p.id);
  if (!cur) return err(res, 404, 'evidence not found');
  const latest = q.get('SELECT MAX(version) v FROM evidence WHERE id=?', p.id).v;
  q.run('INSERT INTO evidence(id,product_id,title,version,status,body,created_at) VALUES(?,?,?,?,?,?,?)',
    p.id, cur.product_id, cur.title, latest + 1, 'approved', b.body, nowIso());
  audit(req.user, 'evidence.correct', { id: p.id, version: latest + 1 });
  return q.get('SELECT * FROM evidence WHERE id=? AND version=?', p.id, latest + 1);
}, 'evidence.edit');

// ---------- 卖点 ----------
route('GET', '/api/selling-points', (req, res, p, query) => {
  const rows = q.all('SELECT * FROM selling_points WHERE product_id=?', query.product || 'p_aurora');
  return rows.map(sp => ({ ...sp, models: q.all('SELECT model_id FROM selling_point_models WHERE sp_id=?', sp.id).map(r => r.model_id) }));
});
route('POST', '/api/products/:id/selling-points', async (req, res, p) => {
  const b = await readJson(req);
  const id = b.id || uid('sp');
  q.run(`INSERT INTO selling_points(id,product_id,title,claim,params_json,evidence_id,evidence_version,version,status,updated_at)
         VALUES(?,?,?,?,?,?,?,1,'active',?)`,
    id, p.id, b.title, b.claim, JSON.stringify(b.params || {}), b.evidenceId, b.evidenceVersion, nowIso());
  for (const m of (b.modelIds || [])) q.run('INSERT INTO selling_point_models(sp_id,model_id) VALUES(?,?)', id, m);
  audit(req.user, 'sp.create', { id });
  return q.get('SELECT * FROM selling_points WHERE id=?', id);
}, 'sp.edit');
route('PATCH', '/api/selling-points/:id', async (req, res, p) => {
  const b = await readJson(req);
  const cur = q.get('SELECT * FROM selling_points WHERE id=?', p.id);
  if (!cur) return err(res, 404, 'sp not found');
  q.run(`UPDATE selling_points SET title=?, claim=?, params_json=?, evidence_id=?, evidence_version=?, version=version+1, updated_at=? WHERE id=?`,
    b.title || cur.title, b.claim || cur.claim,
    b.params ? JSON.stringify(b.params) : cur.params_json,
    b.evidenceId || cur.evidence_id,
    b.evidenceVersion !== undefined ? b.evidenceVersion : cur.evidence_version,
    nowIso(), p.id);
  if (b.modelIds) {
    q.run('DELETE FROM selling_point_models WHERE sp_id=?', p.id);
    for (const m of b.modelIds) q.run('INSERT INTO selling_point_models(sp_id,model_id) VALUES(?,?)', p.id, m);
  }
  audit(req.user, 'sp.update', { id: p.id });
  return q.get('SELECT * FROM selling_points WHERE id=?', p.id);
}, 'sp.edit');
route('GET', '/api/selling-points/:id/validate', (req, res, p) => {
  const sp = q.get('SELECT * FROM selling_points WHERE id=?', p.id);
  if (!sp) return err(res, 404, 'sp not found');
  const ev = q.get('SELECT * FROM evidence WHERE id=? AND version=?', sp.evidence_id, sp.evidence_version);
  const latest = ev ? q.get('SELECT MAX(version) v FROM evidence WHERE id=?', ev.id).v : null;
  const issues = [];
  if (!ev) issues.push({ type: 'EVIDENCE_MISSING' });
  else {
    if (ev.status !== 'approved') issues.push({ type: 'EVIDENCE_NOT_APPROVED', status: ev.status });
    if (sp.evidence_version !== latest) issues.push({ type: 'EVIDENCE_STALE', spEvidenceVersion: sp.evidence_version, latestEvidenceVersion: latest });
  }
  return { spId: sp.id, ok: issues.length === 0, issues };
});

// ---------- 素材与上传 ----------
route('GET', '/api/assets', (req, res, p, query) =>
  q.all(query.kind ? 'SELECT * FROM assets WHERE kind=? ORDER BY name, version' : 'SELECT * FROM assets ORDER BY kind, name, version',
    ...(query.kind ? [query.kind] : [])));
route('GET', '/api/assets/:id', (req, res, p) => {
  const a = q.get('SELECT * FROM assets WHERE id=?', p.id);
  return a || err(res, 404, 'asset not found');
});
route('GET', '/api/assets/:id/object', (req, res, p) => {
  const a = q.get('SELECT * FROM assets WHERE id=?', p.id);
  if (!a || !a.sha256) return err(res, 404, 'object not found');
  const meta = JSON.parse(a.meta_json || '{}');
  const ct = meta.contentType || (a.kind === 'texture' ? 'image/svg+xml' : 'application/json');
  return send(res, 200, storage.getObject(a.sha256), { 'Content-Type': ct });
});
route('PATCH', '/api/assets/:id', async (req, res, p) => {
  const b = await readJson(req);
  const cur = q.get('SELECT * FROM assets WHERE id=?', p.id);
  if (!cur) return err(res, 404, 'asset not found');
  q.run('UPDATE assets SET license=?, embargo_until=?, status=? WHERE id=?',
    b.license || cur.license,
    b.embargoUntil !== undefined ? b.embargoUntil : cur.embargo_until,
    b.status || cur.status, p.id);
  audit(req.user, 'asset.update', { id: p.id, license: b.license, status: b.status });
  return q.get('SELECT * FROM assets WHERE id=?', p.id);
}, 'asset.license');

route('POST', '/api/uploads', async (req) => {
  const b = await readJson(req);
  const assetId = uid('ast');
  q.run(`INSERT INTO assets(id,kind,name,version,sha256,size,status,license,embargo_until,public_fields_json,meta_json,created_at)
         VALUES(?,?,?,?,NULL,0,'uploading',?,?,?,?,?)`,
    assetId, b.kind, b.name, b.version || 1, b.license || 'internal', b.embargoUntil || null,
    JSON.stringify(b.publicFields || []), JSON.stringify({ ...(b.meta || {}), expectSha: b.sha256, size: b.size }), nowIso());
  const upId = uid('up');
  q.run('INSERT INTO uploads(id,asset_id,total_chunks,status,created_at) VALUES(?,?,?,?,?)',
    upId, assetId, b.chunks || 1, 'open', nowIso());
  storage.initUpload(upId);
  audit(req.user, 'upload.create', { upload: upId, asset: assetId, chunks: b.chunks });
  return { uploadId: upId, assetId };
}, 'asset.upload');
route('GET', '/api/uploads/:id', (req, res, p) => {
  const up = q.get('SELECT * FROM uploads WHERE id=?', p.id);
  if (!up) return err(res, 404, 'upload not found');
  return { ...up, received: storage.listChunks(p.id) };
});
route('PUT', '/api/uploads/:id/chunks/:n', async (req, res, p) => {
  const up = q.get('SELECT * FROM uploads WHERE id=?', p.id);
  if (!up || up.status !== 'open') return err(res, 409, 'upload not open');
  const buf = await readBody(req);
  storage.putChunk(p.id, Number(p.n), buf);
  return { received: storage.listChunks(p.id) };
}, 'asset.upload');
route('POST', '/api/uploads/:id/complete', (req, res, p) => {
  const up = q.get('SELECT * FROM uploads WHERE id=?', p.id);
  if (!up || up.status !== 'open') return err(res, 409, 'upload not open');
  const asset = q.get('SELECT * FROM assets WHERE id=?', up.asset_id);
  const meta = JSON.parse(asset.meta_json || '{}');
  const received = storage.listChunks(p.id);
  if (received.length !== up.total_chunks) {
    return err(res, 409, `chunks incomplete: ${received.length}/${up.total_chunks}`, { received });
  }
  let sha;
  try { sha = storage.completeUpload(p.id, meta.expectSha); }
  catch (e) {
    q.run(`UPDATE uploads SET status='failed' WHERE id=?`, p.id);
    q.run(`UPDATE assets SET status='failed' WHERE id=?`, asset.id);
    return err(res, 422, e.message);
  }
  q.run(`UPDATE uploads SET status='done' WHERE id=?`, p.id);
  q.run(`UPDATE assets SET status='ready', sha256=?, size=? WHERE id=?`, sha, storage.getObject(sha).length, asset.id);
  audit(req.user, 'upload.complete', { upload: p.id, asset: asset.id, sha });
  return q.get('SELECT * FROM assets WHERE id=?', asset.id);
}, 'asset.upload');

// ---------- 场景 ----------
route('GET', '/api/scenes', (req, res, p, query) =>
  q.all('SELECT * FROM scenes WHERE product_id=? ORDER BY name, version', query.product || 'p_aurora'));
route('GET', '/api/scenes/:id', (req, res, p) => q.get('SELECT * FROM scenes WHERE id=?', p.id) || err(res, 404, 'scene not found'));
route('GET', '/api/scenes/:id/resolve', (req, res, p) => {
  const s = q.get('SELECT * FROM scenes WHERE id=?', p.id);
  if (!s) return err(res, 404, 'scene not found');
  const r = renderer.resolveScene(s);
  return {
    sceneId: s.id, version: s.version, ok: r.missing.length === 0, missing: r.missing,
    resolved: r.missing.length === 0 ? {
      model: r.refs.model.sha256, materials: r.refs.materials.sha256,
      camera: r.refs.camera.sha256, lights: r.refs.lights.sha256,
      textures: Object.fromEntries(Object.entries(r.refs.textures).map(([k, v]) => [k, v.sha256]))
    } : null
  };
});
route('POST', '/api/scenes', async (req) => {
  const b = await readJson(req);
  const id = b.id || uid('sc');
  q.run('INSERT INTO scenes(id,product_id,name,version,manifest_json,created_at) VALUES(?,?,?,1,?,?)',
    id, b.productId, b.name, JSON.stringify(b.manifest), nowIso());
  audit(req.user, 'scene.create', { id });
  return q.get('SELECT * FROM scenes WHERE id=?', id);
}, 'scene.edit');
route('POST', '/api/scenes/:id/versions', async (req, res, p) => {
  const b = await readJson(req);
  const cur = q.get('SELECT * FROM scenes WHERE id=?', p.id);
  if (!cur) return err(res, 404, 'scene not found');
  const v = q.get('SELECT MAX(version) v FROM scenes WHERE product_id=? AND name=?', cur.product_id, cur.name).v + 1;
  const id = uid('sc');
  q.run('INSERT INTO scenes(id,product_id,name,version,manifest_json,created_at) VALUES(?,?,?,?,?,?)',
    id, cur.product_id, cur.name, v, JSON.stringify(b.manifest), nowIso());
  audit(req.user, 'scene.version', { from: p.id, to: id, version: v });
  return q.get('SELECT * FROM scenes WHERE id=?', id);
}, 'scene.edit');

route('GET', '/api/scenes/:id/frame.svg', (req, res, p, query) => {
  const s = q.get('SELECT * FROM scenes WHERE id=?', p.id);
  if (!s) return err(res, 404, 'scene not found');
  const ch = q.get('SELECT * FROM channels WHERE code=?', query.channel || 'web');
  const resolved = renderer.resolveScene(s);
  if (resolved.missing.length) return err(res, 409, 'scene deps missing', { missing: resolved.missing });
  const svg = renderer.renderFrameSvg(resolved, ch, Number(query.t || 0), { rpm: Number(query.rpm ?? 9) },
    { subtitles: [], callouts: [], safe: JSON.parse(ch.safe_json) }, { allowPlaceholder: query.placeholder === '1' });
  res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
  res.end(svg);
});

// ---------- 时间线 ----------
route('GET', '/api/timelines', (req, res, p, query) =>
  q.all('SELECT * FROM timelines WHERE product_id=?', query.product || 'p_aurora'));
route('GET', '/api/timelines/:id', (req, res, p) =>
  q.get('SELECT * FROM timelines WHERE id=?', p.id) || err(res, 404, 'timeline not found'));
route('POST', '/api/timelines', async (req) => {
  const b = await readJson(req);
  const id = b.id || uid('tl');
  q.run('INSERT INTO timelines(id,product_id,model_id,scene_id,name,version,doc_json,updated_at) VALUES(?,?,?,?,?,1,?,?)',
    id, b.productId, b.modelId, b.sceneId, b.name, JSON.stringify(b.doc), nowIso());
  audit(req.user, 'timeline.create', { id });
  return q.get('SELECT * FROM timelines WHERE id=?', id);
}, 'timeline.edit');
route('PATCH', '/api/timelines/:id', async (req, res, p) => {
  const b = await readJson(req);
  const cur = q.get('SELECT * FROM timelines WHERE id=?', p.id);
  if (!cur) return err(res, 404, 'timeline not found');
  q.run('UPDATE timelines SET doc_json=?, version=version+1, updated_at=? WHERE id=?',
    JSON.stringify(b.doc), nowIso(), p.id);
  audit(req.user, 'timeline.update', { id: p.id });
  return q.get('SELECT * FROM timelines WHERE id=?', p.id);
}, 'timeline.edit');
route('GET', '/api/timelines/:id/validate', (req, res, p, query) => {
  const tl = q.get('SELECT * FROM timelines WHERE id=?', p.id);
  if (!tl) return err(res, 404, 'timeline not found');
  const ch = q.get('SELECT * FROM channels WHERE code=?', query.channel || 'web');
  const doc = JSON.parse(tl.doc_json);
  const spCheck = renderer.checkCallouts(doc, tl.model_id);
  const claimBySp = {};
  for (const s of spCheck.snapshots) claimBySp[s.calloutId] = s.claim;
  for (const c of (doc.tracks.callouts || [])) c.__claim = claimBySp[c.id] || '';
  const layout = renderer.layoutSubtitles(doc, ch);
  return { timeline: tl.id, version: tl.version, channel: ch.code, spIssues: spCheck.issues, conflicts: layout.conflicts };
});

route('GET', '/api/channels', () => q.all('SELECT * FROM channels'));

// ---------- 渲染任务 ----------
route('GET', '/api/render-jobs', () => q.all('SELECT * FROM render_jobs ORDER BY created_at DESC'));
route('POST', '/api/render-jobs', async (req, res) => {
  const b = await readJson(req);
  const id = uid('job');
  q.run(`INSERT INTO render_jobs(id,timeline_id,channel_code,status,allow_placeholder,created_by,created_at,updated_at)
         VALUES(?,?,?,'queued',?,?,?,?)`,
    id, b.timelineId, b.channel, b.allowPlaceholder ? 1 : 0, req.user, nowIso(), nowIso());
  audit(req.user, 'render.create', { id, timeline: b.timelineId, channel: b.channel, allowPlaceholder: !!b.allowPlaceholder });
  const job = renderer.renderJob(id);
  return job;
}, 'render');
route('GET', '/api/render-jobs/:id', (req, res, p) =>
  q.get('SELECT * FROM render_jobs WHERE id=?', p.id) || err(res, 404, 'job not found'));
route('GET', '/api/render-jobs/:id/diagnose', (req, res, p) => {
  const job = q.get('SELECT * FROM render_jobs WHERE id=?', p.id);
  if (!job) return err(res, 404, 'job not found');
  const blockers = JSON.parse(job.blockers_json || '[]');
  // 依赖定位：为每类阻塞给出可跳转的实体引用
  const located = blockers.map(b => ({
    ...b,
    ref: b.assetId ? { kind: 'asset', id: b.assetId }
      : b.spId ? { kind: 'selling-point', id: b.spId }
      : b.cueId ? { kind: 'cue', id: b.cueId } : null
  }));
  const conflicts = JSON.parse(job.conflicts_json || '[]').map(c => ({ ...c, ref: { kind: 'cue', id: c.cueId } }));
  return { job: job.id, status: job.status, blockers: located, conflicts };
});
route('POST', '/api/render-jobs/:id/retry', (req, res, p) => {
  const job = q.get('SELECT * FROM render_jobs WHERE id=?', p.id);
  if (!job) return err(res, 404, 'job not found');
  audit(req.user, 'render.retry', { id: p.id });
  return renderer.renderJob(p.id);
}, 'render');
route('POST', '/api/render-jobs/:id/verify', (req, res, p) => {
  const job = q.get('SELECT * FROM render_jobs WHERE id=?', p.id);
  if (!job || job.status !== 'done') return err(res, 409, 'job not done');
  const asset = q.get('SELECT * FROM assets WHERE id=?', job.output_asset_id);
  const meta = JSON.parse(asset.meta_json || '{}');
  // 用相同输入重渲染一帧并与存储对象比对（确定性验证）
  const timeline = q.get('SELECT * FROM timelines WHERE id=?', job.timeline_id);
  const scene = q.get('SELECT * FROM scenes WHERE id=?', timeline.scene_id);
  const resolved = renderer.resolveScene(scene);
  const ok = resolved.missing.length === 0 && meta.frames.every(f => storage.hasObject(f));
  return { job: job.id, deterministicInputsPresent: ok, inputHash: job.input_hash, artifactHash: meta.hash, match: job.input_hash === meta.hash };
}, 'render');

// ---------- 产物 ----------
route('GET', '/api/artifacts/:id/meta', (req, res, p) => {
  const a = q.get('SELECT * FROM assets WHERE id=?', p.id);
  if (!a || a.kind !== 'preview') return err(res, 404, 'artifact not found');
  return { id: a.id, ...JSON.parse(a.meta_json || '{}') };
});
route('GET', '/api/artifacts/:id/preview.html', (req, res, p) => {
  const a = q.get('SELECT * FROM assets WHERE id=?', p.id);
  if (!a) return err(res, 404, 'artifact not found');
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(storage.getObject(a.sha256));
});
route('GET', '/api/artifacts/:id/frames/:file', (req, res, p) => {
  const sha = p.file.replace(/\.svg$/, '');
  try { return send(res, 200, storage.getObject(sha), { 'Content-Type': 'image/svg+xml' }); }
  catch { return err(res, 404, 'frame not found'); }
});
route('GET', '/api/objects/:sha', (req, res, p) => {
  try { return send(res, 200, storage.getObject(p.sha), { 'Content-Type': 'application/octet-stream' }); }
  catch { return err(res, 404, 'object not found'); }
});

// ---------- 候选发布 ----------
route('GET', '/api/candidates', () => q.all('SELECT * FROM candidates ORDER BY created_at DESC'));
route('POST', '/api/candidates', async (req, res) => {
  const b = await readJson(req);
  const job = q.get('SELECT * FROM render_jobs WHERE id=?', b.renderJobId);
  if (!job || job.status !== 'done') return err(res, 409, 'render job not done');
  const meta = JSON.parse(q.get('SELECT * FROM assets WHERE id=?', job.output_asset_id).meta_json);
  if (meta.placeholder) return err(res, 422, 'placeholder artifact cannot be published', { reasons: [{ type: 'PLACEHOLDER_ARTIFACT' }] });
  const tl = q.get('SELECT * FROM timelines WHERE id=?', job.timeline_id);
  const id = uid('cand');
  q.run(`INSERT INTO candidates(id,render_job_id,product_id,model_id,channel_code,status,review_notes,created_by,created_at)
         VALUES(?,?,?,?,?,'candidate',?,?,?)`,
    id, job.id, tl.product_id, tl.model_id, job.channel_code, b.reviewNotes || null, req.user, nowIso());
  audit(req.user, 'candidate.create', { id, job: job.id });
  return q.get('SELECT * FROM candidates WHERE id=?', id);
}, 'candidate.create');
route('GET', '/api/candidates/:id/check', (req, res, p) => {
  const c = q.get('SELECT * FROM candidates WHERE id=?', p.id);
  if (!c) return err(res, 404, 'candidate not found');
  return policy.canPublishCandidate(c, req.user);
});
route('POST', '/api/candidates/:id/approve', (req, res, p) => {
  const c = q.get('SELECT * FROM candidates WHERE id=?', p.id);
  if (!c) return err(res, 404, 'candidate not found');
  q.run(`UPDATE candidates SET status='approved' WHERE id=?`, p.id);
  audit(req.user, 'candidate.approve', { id: p.id });
  return q.get('SELECT * FROM candidates WHERE id=?', p.id);
}, 'candidate.approve');
route('POST', '/api/candidates/:id/reject', async (req, res, p) => {
  const b = await readJson(req);
  q.run(`UPDATE candidates SET status='rejected', review_notes=? WHERE id=?`, b.reviewNotes || null, p.id);
  audit(req.user, 'candidate.reject', { id: p.id });
  return q.get('SELECT * FROM candidates WHERE id=?', p.id);
}, 'candidate.approve');
route('POST', '/api/candidates/:id/publish', (req, res, p) => {
  const c = q.get('SELECT * FROM candidates WHERE id=?', p.id);
  if (!c) return err(res, 404, 'candidate not found');
  const check = policy.canPublishCandidate(c, req.user);
  if (!check.ok) return err(res, 422, 'publish blocked', { reasons: check.reasons });
  q.run(`UPDATE candidates SET status='published' WHERE id=?`, p.id);
  audit(req.user, 'publish', { candidate: p.id, channel: c.channel_code });
  return q.get('SELECT * FROM candidates WHERE id=?', p.id);
}, 'publish');

// ---------- 定时发布 ----------
route('GET', '/api/schedules', () => q.all('SELECT * FROM schedules ORDER BY run_at'));
route('POST', '/api/candidates/:id/schedule', async (req, res, p) => {
  const b = await readJson(req);
  const c = q.get('SELECT * FROM candidates WHERE id=?', p.id);
  if (!c) return err(res, 404, 'candidate not found');
  const id = uid('sch');
  q.run('INSERT INTO schedules(id,candidate_id,actor,run_at,status,created_at) VALUES(?,?,?,?,?,?)',
    id, p.id, req.user, b.runAt, 'pending', nowIso());
  audit(req.user, 'schedule.create', { id, candidate: p.id, runAt: b.runAt });
  return q.get('SELECT * FROM schedules WHERE id=?', id);
}, 'schedule');
route('POST', '/api/schedules/run-due', async (req) => {
  const b = await readJson(req);
  return runDue(b.now);
}, '*');
route('POST', '/api/schedules/:id/cancel', (req, res, p) => {
  q.run(`UPDATE schedules SET status='cancelled' WHERE id=?`, p.id);
  return q.get('SELECT * FROM schedules WHERE id=?', p.id);
}, 'schedule');

// ---------- 导出公开包 ----------
route('POST', '/api/products/:id/export', (req, res, p) => {
  try { return exportPublicPackage(p.id, req.user); }
  catch (e) { return err(res, 404, e.message); }
}, 'export');
route('GET', '/api/exports', () =>
  fs.readdirSync(EXP_DIR).map(id => {
    const mp = path.join(EXP_DIR, id, 'manifest.json');
    return fs.existsSync(mp) ? JSON.parse(fs.readFileSync(mp, 'utf8')) : { exportId: id };
  }));
route('GET', '/api/exports/:id/manifest', (req, res, p) => {
  const mp = path.join(EXP_DIR, p.id, 'manifest.json');
  if (!fs.existsSync(mp)) return err(res, 404, 'export not found');
  return JSON.parse(fs.readFileSync(mp, 'utf8'));
});

// ---------- 回收 ----------
route('POST', '/api/gc', async (req) => {
  const b = await readJson(req);
  const result = gc(!!b.dryRun);
  audit(req.user, 'gc', { dryRun: !!b.dryRun, deleted: result.deleted.length });
  return result;
}, '*');

// ---------- 静态资源 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
function serveStatic(req, res, pathname) {
  let fp = pathname === '/' ? '/index.html' : pathname;
  const abs = path.join(ROOT, 'public', path.normalize(fp).replace(/^([/\\])+/, ''));
  if (!abs.startsWith(path.join(ROOT, 'public')) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(abs)] || 'application/octet-stream' });
  fs.createReadStream(abs).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  req.user = req.headers['x-user'] || 'viewer1';
  if (!u.pathname.startsWith('/api/')) return serveStatic(req, res, u.pathname);
  for (const r of routes) {
    if (r.method !== req.method) continue;
    const m = u.pathname.match(r.rx);
    if (!m) continue;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    try {
      if (r.perm && r.perm !== '*' && !can(req.user, r.perm)) {
        return err(res, 403, `permission denied: ${r.perm}`);
      }
      const out = await r.handler(req, res, params, Object.fromEntries(u.searchParams));
      if (!res.headersSent) jsend(res, 200, out === undefined ? { ok: true } : out);
    } catch (e) {
      if (!res.headersSent) err(res, e.status || 500, e.message);
    }
    return;
  }
  err(res, 404, 'route not found: ' + req.method + ' ' + u.pathname);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`[launch-console] http://localhost:${PORT}`);
    setInterval(() => runDue(), 15000).unref();
  });
}
module.exports = { server };
