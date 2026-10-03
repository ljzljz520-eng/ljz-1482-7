'use strict';
// 发布门禁：保密期 + 素材授权 + 公开字段 + 证据版本 + 安全区 + 权限 共同约束导出/发布
const { q, can } = require('./db');
const { artifactStaleReasons } = require('./renderer');
const { nowIso } = require('./common');

function jobOutput(jobId) {
  const job = q.get('SELECT * FROM render_jobs WHERE id=?', jobId);
  if (!job || !job.output_asset_id) return { job, asset: null, meta: null };
  const asset = q.get('SELECT * FROM assets WHERE id=?', job.output_asset_id);
  return { job, asset, meta: asset ? JSON.parse(asset.meta_json || '{}') : null };
}

// 返回 { ok, reasons:[{type, detail, ref?}] }
function canPublishCandidate(candidate, actor, now) {
  now = now || nowIso();
  const reasons = [];
  if (!can(actor, 'publish')) reasons.push({ type: 'PERMISSION_DENIED', detail: `账号 ${actor} 当前无发布权限` });
  if (candidate.status !== 'approved') reasons.push({ type: 'NOT_APPROVED', detail: '候选发布未通过法务审批' });

  const { job, asset, meta } = jobOutput(candidate.render_job_id);
  if (!job || job.status !== 'done' || !asset) reasons.push({ type: 'NO_ARTIFACT', detail: '渲染产物缺失' });
  if (meta) {
    if (meta.placeholder) reasons.push({ type: 'PLACEHOLDER_ARTIFACT', detail: '产物含占位纹理，禁止发布' });
    const conflicts = (meta.conflicts || []).filter(c => c.channel === undefined); // 全部冲突均属本渠道
    if ((meta.conflicts || []).length) reasons.push({ type: 'SAFEZONE_CONFLICT', detail: `存在 ${meta.conflicts.length} 处字幕安全区冲突`, conflicts: meta.conflicts });
    for (const r of artifactStaleReasons(asset)) reasons.push({ ...r, detail: '产物引用的卖点/证据已被订正，需重新渲染' });
  }
  // 保密期
  const product = q.get('SELECT * FROM products WHERE id=?', candidate.product_id);
  if (product.embargo_until && product.embargo_until > now) {
    reasons.push({ type: 'EMBARGO', detail: `产品保密期至 ${product.embargo_until}`, embargoUntil: product.embargo_until });
  }
  // 素材授权 + 素材级保密期（沿产物输入清单逐项核查）
  if (meta && meta.inputs) {
    const shas = meta.inputs.assetShas || {};
    const ids = [];
    if (meta.inputs.sceneId) {
      const scene = q.get('SELECT * FROM scenes WHERE id=?', meta.inputs.sceneId);
      if (scene) {
        const m = JSON.parse(scene.manifest_json);
        ids.push(m.model.assetId, m.materials.assetId, m.camera.assetId, m.lights.assetId, ...(m.textures || []).map(t => t.assetId));
      }
    }
    for (const aid of ids) {
      const a = q.get('SELECT * FROM assets WHERE id=?', aid);
      if (!a) continue;
      if (a.license === 'internal') reasons.push({ type: 'LICENSE_INTERNAL', detail: `素材 ${a.name} v${a.version} 为内部授权，禁止公开发布`, assetId: aid });
      if (a.embargo_until && a.embargo_until > now) reasons.push({ type: 'ASSET_EMBARGO', detail: `素材 ${a.name} 保密期至 ${a.embargo_until}`, assetId: aid });
    }
  }
  return { ok: reasons.length === 0, reasons };
}

// 公开字段过滤：型号规格仅导出白名单字段
function publicSpecs(modelRow) {
  const specs = JSON.parse(modelRow.specs_json || '{}');
  const allow = JSON.parse(modelRow.public_fields_json || '[]');
  const out = {};
  for (const k of allow) if (k in specs) out[k] = specs[k];
  return out;
}

module.exports = { canPublishCandidate, publicSpecs, jobOutput };
