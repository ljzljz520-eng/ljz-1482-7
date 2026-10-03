'use strict';
// 确定性服务端渲染器：从同一份场景清单（模型/材质/相机/灯光/纹理版本锁定）
// 重建每一帧；字幕与卖点标注按渠道安全区合成。相同输入 => 相同字节 => 相同哈希。
const { q } = require('./db');
const storage = require('./storage');
const { sha256, stable, nowIso, uid } = require('./common');

const F1 = (x) => Number(x.toFixed(1));
const F3 = (x) => Number(x.toFixed(3));

// ---------- 三维数学（与浏览器端 app.js 保持一致）----------
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm = (a) => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const rotY = (p, c, s) => [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];

function viewMatrix(cam) {
  const f = norm(sub3(cam.target, cam.position));
  const r = norm(cross(f, cam.up));
  const u = cross(r, f);
  return { eye: cam.position, r, u, f };
}
function toView(p, V) {
  const d = sub3(p, V.eye);
  return [dot(d, V.r), dot(d, V.u), -dot(d, V.f)];
}
function project(v, fovY, aspect, W, H) {
  const fh = 1 / Math.tan((fovY * Math.PI / 180) / 2);
  const x = (v[0] * fh / aspect) / -v[2];
  const y = (v[1] * fh) / -v[2];
  return [F1((x * 0.5 + 0.5) * W), F1((1 - (y * 0.5 + 0.5)) * H)];
}
function hexRgb(hex) { return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]; }
function rgbHex(r, g, b) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return '#' + c(r) + c(g) + c(b);
}
function shade(albedoHex, emissiveHex, emissiveIntensity, n, lightsCfg) {
  const al = hexRgb(albedoHex);
  let r = 0, g = 0, b = 0;
  const amb = lightsCfg.ambient, ac = hexRgb(amb.color);
  r += al[0] * (ac[0] / 255) * amb.intensity; g += al[1] * (ac[1] / 255) * amb.intensity; b += al[2] * (ac[2] / 255) * amb.intensity;
  for (const L of lightsCfg.lights) {
    const d = norm(L.dir.map((v) => -v));
    const diff = Math.max(0, dot(n, d));
    const lc = hexRgb(L.color);
    r += al[0] * (lc[0] / 255) * L.intensity * diff;
    g += al[1] * (lc[1] / 255) * L.intensity * diff;
    b += al[2] * (lc[2] / 255) * L.intensity * diff;
  }
  if (emissiveHex) {
    const e = hexRgb(emissiveHex), k = emissiveIntensity || 1;
    r += e[0] * k; g += e[1] * k; b += e[2] * k;
  }
  return rgbHex(r, g, b);
}

// ---------- 文本度量（确定性）----------
function charUnits(ch) {
  const c = ch.codePointAt(0);
  if (c >= 0x2e80) return 1.0;
  if (ch === ' ') return 0.30;
  if (/[0-9A-Za-z]/.test(ch)) return 0.56;
  return 0.5;
}
const textUnits = (t) => [...t].reduce((s, ch) => s + charUnits(ch), 0);
function wrapText(text, maxUnits) {
  const lines = []; let cur = '', curU = 0;
  for (const ch of text) {
    const u = charUnits(ch);
    if (curU + u > maxUnits && cur) { lines.push(cur); cur = ch; curU = u; }
    else { cur += ch; curU += u; }
  }
  if (cur) lines.push(cur);
  return lines;
}

// ---------- 场景解析（版本锁定 + 依赖诊断）----------
function loadAssetRef(assetId, version, missing, kindLabel) {
  const a = q.get('SELECT * FROM assets WHERE id=?', assetId);
  if (!a) { missing.push({ type: 'DEP_ASSET_NOT_FOUND', assetId, version, kind: kindLabel }); return null; }
  if (a.version !== version) { missing.push({ type: 'DEP_VERSION_MISMATCH', assetId, version, have: a.version, kind: kindLabel }); return null; }
  if (a.status !== 'ready') { missing.push({ type: 'DEP_ASSET_NOT_READY', assetId, version, status: a.status, kind: kindLabel }); return null; }
  return a;
}
function resolveScene(sceneRow) {
  const m = JSON.parse(sceneRow.manifest_json);
  const missing = [];
  const modelA = loadAssetRef(m.model.assetId, m.model.version, missing, 'model3d');
  const matA = loadAssetRef(m.materials.assetId, m.materials.version, missing, 'material');
  const camA = loadAssetRef(m.camera.assetId, m.camera.version, missing, 'camera');
  const lightA = loadAssetRef(m.lights.assetId, m.lights.version, missing, 'light');
  const textures = {};
  for (const t of (m.textures || [])) {
    const a = loadAssetRef(t.assetId, t.version, missing, 'texture');
    if (a) textures[t.slot] = a;
  }
  const resolved = { manifest: m, missing, refs: { model: modelA, materials: matA, camera: camA, lights: lightA, textures } };
  // 逐项解析可用资产：纹理缺失时仍可渲染占位预览（模型/材质/相机/灯光必须就绪）
  if (modelA) resolved.model = JSON.parse(storage.getObject(modelA.sha256).toString('utf8'));
  if (matA) resolved.materials = JSON.parse(storage.getObject(matA.sha256).toString('utf8'));
  if (camA) resolved.camera = JSON.parse(storage.getObject(camA.sha256).toString('utf8'));
  if (lightA) resolved.lights = JSON.parse(storage.getObject(lightA.sha256).toString('utf8'));
  resolved.textureData = {};
  for (const [slot, a] of Object.entries(textures)) resolved.textureData[slot] = storage.getObject(a.sha256);
  return resolved;
}

// ---------- 卖点校验（型号绑定 + 证据版本）----------
function checkCallouts(doc, modelId) {
  const issues = []; const snapshots = [];
  for (const c of (doc.tracks.callouts || [])) {
    const sp = q.get('SELECT * FROM selling_points WHERE id=?', c.spId);
    if (!sp) { issues.push({ type: 'SP_NOT_FOUND', calloutId: c.id, spId: c.spId }); continue; }
    if (sp.status !== 'active') { issues.push({ type: 'SP_INACTIVE', calloutId: c.id, spId: sp.id }); continue; }
    const link = q.get('SELECT model_id FROM selling_point_models WHERE sp_id=? AND model_id=?', sp.id, modelId);
    if (!link) { issues.push({ type: 'SP_MODEL_MISMATCH', calloutId: c.id, spId: sp.id, modelId, detail: '卖点未绑定该型号，禁止把高配参数带入低配视频' }); continue; }
    const ev = q.get('SELECT * FROM evidence WHERE id=? AND version=?', sp.evidence_id, sp.evidence_version);
    if (!ev) { issues.push({ type: 'EVIDENCE_MISSING', calloutId: c.id, spId: sp.id }); continue; }
    if (ev.status !== 'approved') { issues.push({ type: 'EVIDENCE_NOT_APPROVED', calloutId: c.id, spId: sp.id, evidenceStatus: ev.status }); continue; }
    const latest = q.get('SELECT MAX(version) v FROM evidence WHERE id=?', sp.evidence_id).v;
    if (sp.evidence_version !== latest) {
      issues.push({ type: 'EVIDENCE_STALE', calloutId: c.id, spId: sp.id, spEvidenceVersion: sp.evidence_version, latestEvidenceVersion: latest, detail: '证据已有新版本（参数订正），需更新卖点后再渲染' }); continue;
    }
    snapshots.push({ calloutId: c.id, spId: sp.id, spVersion: sp.version, claim: sp.claim, evidenceId: ev.id, evidenceVersion: sp.evidence_version });
  }
  return { issues, snapshots };
}

// ---------- 安全区冲突检测 ----------
function layoutSubtitles(doc, channel) {
  const W = channel.width, H = channel.height;
  const safe = JSON.parse(channel.safe_json), sub = JSON.parse(channel.subtitle_json);
  const safeW = (1 - safe.l - safe.r) * W;
  const conflicts = [];
  const laid = [];
  for (const cue of (doc.tracks.subtitles || [])) {
    const fontSize = sub.fontSize, lineHeight = Math.round(fontSize * 1.35);
    const maxUnits = safeW / fontSize;
    const lines = wrapText(cue.text, maxUnits);
    const blockH = lines.length * lineHeight;
    const bottom = H * (1 - safe.b) - 10;
    const top = bottom - blockH;
    if (lines.length > sub.maxLines) {
      conflicts.push({ cueId: cue.id, type: 'SUBTITLE_LINES', detail: `字幕 ${lines.length} 行超出渠道上限 ${sub.maxLines} 行`, lines: lines.length, maxLines: sub.maxLines });
    }
    if (top < H * safe.t) {
      conflicts.push({ cueId: cue.id, type: 'SAFE_ZONE_TOP', detail: `字幕块顶部侵入安全区上边距 ${F1(H * safe.t - top)}px`, neededPx: F1(blockH), availPx: F1(H * (1 - safe.b - safe.t) - 10) });
    }
    laid.push({ ...cue, lines, fontSize, lineHeight, bottom });
  }
  const callouts = [];
  for (const c of (doc.tracks.callouts || [])) {
    const fontSize = Math.round(sub.fontSize * 0.8);
    const maxUnits = (safeW * 0.45) / fontSize;
    const lines = wrapText(c.__claim || '', maxUnits);
    if (lines.length > 3) conflicts.push({ cueId: c.id, type: 'CALLOUT_OVERFLOW', detail: `卖点标注 ${lines.length} 行超出 3 行上限`, lines: lines.length });
    callouts.push({ ...c, lines, fontSize });
  }
  return { conflicts, subtitles: laid, callouts, safe, sub };
}

// ---------- 单帧渲染 ----------
function renderFrameSvg(resolved, channel, t, motion, overlays, opts) {
  const W = channel.width, H = channel.height, aspect = W / H;
  const cam = resolved.camera, lights = resolved.lights, mats = resolved.materials.materials;
  const V = viewMatrix(cam);
  const angle = (motion && motion.rpm ? motion.rpm : 0) * Math.PI * 2 * t / 60;
  const c = Math.cos(angle), s = Math.sin(angle);
  const faces = [];
  for (const part of resolved.model.parts) {
    const mat = mats[part.material] || { color: '#888888' };
    const pos = part.positions, idx = part.indices;
    for (let i = 0; i < idx.length; i += 3) {
      const tri = [idx[i], idx[i + 1], idx[i + 2]];
      const wp = tri.map(k => rotY([pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]], c, s));
      const vp = tri.map((k, j) => toView(wp[j], V));
      if (vp.some(v => v[2] > -0.05)) continue; // 近裁剪
      const e1 = sub3(vp[1], vp[0]), e2 = sub3(vp[2], vp[0]);
      const fn = cross(e1, e2);
      if (fn[2] <= 0) continue; // 背面剔除
      const wn = norm(cross(sub3(wp[1], wp[0]), sub3(wp[2], wp[0])));
      const depth = (vp[0][2] + vp[1][2] + vp[2][2]) / 3;
      const pts = vp.map(v => project(v, cam.fovY, aspect, W, H));
      faces.push({ depth, pts, wn, mat, part });
    }
  }
  faces.sort((a, b) => a.depth - b.depth);
  const partImages = new Map();
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  out.push(`<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#1c2434"/><stop offset="1" stop-color="#0a0d13"/></linearGradient></defs>`);
  out.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`);
  out.push(`<ellipse cx="${F1(W / 2)}" cy="${F1(H * 0.86)}" rx="${F1(W * 0.18)}" ry="${F1(H * 0.03)}" fill="#000" opacity="0.45"/>`);
  for (const f of faces) {
    const pts = f.pts.map(p => p.join(',')).join(' ');
    const isTexPart = f.part.textureSlot;
    const texBuf = isTexPart && resolved.textureData ? resolved.textureData[f.part.textureSlot] : null;
    if (isTexPart && !texBuf && opts.allowPlaceholder) {
      out.push(`<polygon points="${pts}" fill="#ff00ff"/>`); // 显式占位：绝不静默
      continue;
    }
    const fill = shade(f.mat.color, f.mat.emissive, f.mat.emissiveIntensity, f.wn, lights);
    out.push(`<polygon points="${pts}" fill="${fill}"/>`);
    if (isTexPart && texBuf) {
      const key = f.part.name;
      if (!partImages.has(key)) partImages.set(key, { pts: [], buf: texBuf });
      partImages.get(key).pts.push(...f.pts);
    }
  }
  for (const { pts, buf } of partImages.values()) {
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const x = F1(Math.min(...xs)), y = F1(Math.min(...ys));
    const w = F1(Math.max(...xs) - x), h = F1(Math.max(...ys) - y);
    out.push(`<image x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none" href="data:image/svg+xml;base64,${buf.toString('base64')}"/>`);
  }
  // 字幕
  for (const cue of overlays.subtitles) {
    const cx = W / 2;
    const blockH = cue.lines.length * cue.lineHeight;
    const y0 = cue.bottom - blockH;
    const maxW = Math.max(...cue.lines.map(l => textUnits(l) * cue.fontSize));
    out.push(`<rect x="${F1(cx - maxW / 2 - 14)}" y="${F1(y0 - 6)}" width="${F1(maxW + 28)}" height="${F1(blockH + 12)}" rx="10" fill="#000" opacity="0.55"/>`);
    cue.lines.forEach((line, i) => {
      out.push(`<text x="${F1(cx)}" y="${F1(y0 + (i + 1) * cue.lineHeight - cue.lineHeight * 0.28)}" font-family="DejaVu Sans, Noto Sans CJK SC, sans-serif" font-size="${cue.fontSize}" fill="#fff" text-anchor="middle">${escapeXml(line)}</text>`);
    });
  }
  // 卖点标注
  const safe = overlays.safe;
  for (const co of overlays.callouts) {
    const boxW = Math.max(...co.lines.map(l => textUnits(l) * co.fontSize), 1) + 28;
    const boxH = co.lines.length * co.fontSize * 1.4 + 20;
    const x = F1(W * (1 - safe.r) - boxW - 16), y = F1(H * safe.t + 16);
    out.push(`<rect x="${x}" y="${y}" width="${F1(boxW)}" height="${F1(boxH)}" rx="12" fill="#0e1420" opacity="0.88" stroke="#3fd2e6" stroke-width="2"/>`);
    co.lines.forEach((line, i) => {
      out.push(`<text x="${F1(x + 14)}" y="${F1(y + 26 + i * co.fontSize * 1.4)}" font-family="DejaVu Sans, Noto Sans CJK SC, sans-serif" font-size="${co.fontSize}" fill="#bfeffb">${escapeXml(line)}</text>`);
    });
  }
  out.push('</svg>');
  return out.join('\n');
}
function escapeXml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

// ---------- 渲染阻塞项 ----------
function computeBlockers(timeline, channel, resolved, spCheck) {
  const blockers = [];
  for (const m of resolved.missing) {
    blockers.push(m.kind === 'texture'
      ? { ...m, type: m.type, hint: '纹理未就绪：可等待上传完成后重试；内部预览可显式允许占位（不可发布）' }
      : m);
  }
  for (const i of spCheck.issues) blockers.push(i);
  return blockers;
}

// ---------- 渲染任务 ----------
function renderJob(jobId) {
  const job = q.get('SELECT * FROM render_jobs WHERE id=?', jobId);
  if (!job) throw new Error('job not found');
  const timeline = q.get('SELECT * FROM timelines WHERE id=?', job.timeline_id);
  const channel = q.get('SELECT * FROM channels WHERE code=?', job.channel_code);
  const scene = q.get('SELECT * FROM scenes WHERE id=?', timeline.scene_id);
  const doc = JSON.parse(timeline.doc_json);
  const resolved = resolveScene(scene);
  const spCheck = checkCallouts(doc, timeline.model_id);
  const blockers = computeBlockers(timeline, channel, resolved, spCheck);
  const onlyTextureMissing = blockers.length > 0 && blockers.every(b => b.kind === 'texture');
  const allowPlaceholder = !!job.allow_placeholder;

  if (blockers.length && !(allowPlaceholder && onlyTextureMissing)) {
    q.run(`UPDATE render_jobs SET status='blocked', blockers_json=?, updated_at=? WHERE id=?`,
      JSON.stringify(blockers), nowIso(), jobId);
    return q.get('SELECT * FROM render_jobs WHERE id=?', jobId);
  }
  const placeholder = blockers.length > 0; // 仅纹理缺失且显式允许占位

  // 卖点快照注入 callouts（用于布局与帧合成）
  const claimBySp = {};
  for (const s of spCheck.snapshots) claimBySp[s.calloutId] = s.claim;
  for (const c of (doc.tracks.callouts || [])) c.__claim = claimBySp[c.id] || '';

  const layout = layoutSubtitles(doc, channel);
  const conflicts = layout.conflicts;

  const fps = channel.fps, frames = [];
  const nFrames = Math.max(1, Math.round(doc.duration * fps));
  const seg = (doc.tracks.scene || [])[0] || { motion: { rpm: 0 } };
  const inputs = {
    sceneId: scene.id, sceneVersion: scene.version,
    assetShas: {
      model: resolved.refs.model && resolved.refs.model.sha256,
      materials: resolved.refs.materials && resolved.refs.materials.sha256,
      camera: resolved.refs.camera && resolved.refs.camera.sha256,
      lights: resolved.refs.lights && resolved.refs.lights.sha256,
      textures: Object.fromEntries(Object.entries(resolved.refs.textures).map(([k, v]) => [k, v.sha256]))
    },
    timelineId: timeline.id, timelineVersion: timeline.version, doc,
    channel: { code: channel.code, width: channel.width, height: channel.height, fps, safe: JSON.parse(channel.safe_json), subtitle: JSON.parse(channel.subtitle_json) },
    callouts: spCheck.snapshots
  };
  const inputHash = sha256(stable(inputs));

  for (let i = 0; i < nFrames; i++) {
    const t = i / fps;
    const activeSubs = layout.subtitles.filter(cue => t >= cue.start && t < cue.end);
    const activeCallouts = layout.callouts.filter(co => t >= co.start && t < co.end);
    const svg = renderFrameSvg(resolved, channel, t, seg.motion, { subtitles: activeSubs, callouts: activeCallouts, safe: layout.safe }, { allowPlaceholder });
    frames.push(storage.putObject(Buffer.from(svg)));
  }
  const previewHtml = buildPreviewHtml(frames, fps, channel);
  const previewSha = storage.putObject(Buffer.from(previewHtml));
  const meta = {
    contentType: 'text/html', frames, fps, previewSha,
    width: channel.width, height: channel.height, channel: channel.code,
    hash: inputHash, placeholder, conflicts, inputs,
    timelineId: timeline.id, timelineVersion: timeline.version,
    modelId: timeline.model_id, productId: timeline.product_id
  };
  const assetId = uid('ast_preview');
  const pvName = `${timeline.name}@${channel.code}`;
  const pvVer = q.get('SELECT COALESCE(MAX(version),0) v FROM assets WHERE kind=? AND name=?', 'preview', pvName).v + 1;
  q.run(`INSERT INTO assets(id,kind,name,version,sha256,size,status,license,meta_json,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?)`,
    assetId, 'preview', pvName, pvVer, previewSha, previewHtml.length,
    'ready', 'internal', JSON.stringify(meta), nowIso());
  q.run(`UPDATE render_jobs SET status='done', output_asset_id=?, input_hash=?, placeholder=?, conflicts_json=?, blockers_json='[]', updated_at=? WHERE id=?`,
    assetId, inputHash, placeholder ? 1 : 0, JSON.stringify(conflicts), nowIso(), jobId);
  return q.get('SELECT * FROM render_jobs WHERE id=?', jobId);
}

function buildPreviewHtml(frames, fps, channel) {
  return `<!doctype html><meta charset="utf-8"><title>preview ${channel.code}</title>
<body style="margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh">
<img id="f" style="max-width:100vw;max-height:100vh" alt="frame">
<script>var F=${JSON.stringify(frames)},i=0,img=document.getElementById('f');
function tick(){img.src='frames/'+F[i]+'.svg';i=(i+1)%F.length;}tick();setInterval(tick,${Math.round(1000 / fps)});</script>`;
}

// 产物复检：卖点/证据版本是否仍然当前（参数订正后旧产物失效）
function artifactStaleReasons(assetRow) {
  const meta = JSON.parse(assetRow.meta_json || '{}');
  const reasons = [];
  for (const c of (meta.inputs && meta.inputs.callouts || [])) {
    const sp = q.get('SELECT * FROM selling_points WHERE id=?', c.spId);
    if (!sp) { reasons.push({ type: 'SP_DELETED', spId: c.spId }); continue; }
    if (sp.version !== c.spVersion) reasons.push({ type: 'SP_UPDATED', spId: sp.id, rendered: c.spVersion, current: sp.version });
    const latest = q.get('SELECT MAX(version) v FROM evidence WHERE id=?', c.evidenceId).v;
    if (latest !== c.evidenceVersion) reasons.push({ type: 'EVIDENCE_STALE', spId: sp.id, rendered: c.evidenceVersion, current: latest });
  }
  return reasons;
}

module.exports = { resolveScene, renderJob, renderFrameSvg, checkCallouts, layoutSubtitles, artifactStaleReasons, wrapText, textUnits, buildPreviewHtml };
