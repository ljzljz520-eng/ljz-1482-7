'use strict';
// 素材回收：保留仍被候选发布（及其渲染链、场景清单）引用的对象；其余可回收。
const { q } = require('./db');
const storage = require('./storage');

// 计算被引用的对象 sha 集合与原因
function referencedObjects() {
  const refs = new Map(); // sha -> Set(reason)
  const add = (sha, reason) => {
    if (!sha) return;
    if (!refs.has(sha)) refs.set(sha, new Set());
    refs.get(sha).add(reason);
  };
  const keepAssetStatuses = new Set(['ready', 'uploading']); // 失败/已退役资产不天然保留，需看引用
  const assetById = new Map(q.all('SELECT * FROM assets').map(a => [a.id, a]));

  // 1) 候选发布链：candidate -> render_job -> 输出资产 -> 场景清单资产
  const candidates = q.all(`SELECT * FROM candidates WHERE status IN ('candidate','approved','published')`);
  const sceneIds = new Set();
  for (const c of candidates) {
    const job = q.get('SELECT * FROM render_jobs WHERE id=?', c.render_job_id);
    if (!job) continue;
    if (job.output_asset_id) {
      const a = assetById.get(job.output_asset_id);
      if (a) {
        add(a.sha256, `候选发布 ${c.id} 的渲染产物`);
        const meta = JSON.parse(a.meta_json || '{}');
        for (const f of (meta.frames || [])) add(f, `候选发布 ${c.id} 的预览帧`);
        if (meta.inputs && meta.inputs.sceneId) sceneIds.add(meta.inputs.sceneId);
      }
    }
    const tl = job && q.get('SELECT * FROM timelines WHERE id=?', job.timeline_id);
    if (tl) sceneIds.add(tl.scene_id);
  }
  // 2) 所有场景清单引用的资产（固定版本 => 固定对象）
  for (const s of q.all('SELECT * FROM scenes')) {
    const m = JSON.parse(s.manifest_json);
    const ids = [m.model.assetId, m.materials.assetId, m.camera.assetId, m.lights.assetId, ...(m.textures || []).map(t => t.assetId)];
    for (const id of ids) {
      const a = assetById.get(id);
      if (a && a.sha256) add(a.sha256, `场景 ${s.id} v${s.version} 清单引用`);
    }
  }
  // 3) 正常状态资产自身
  for (const a of assetById.values()) {
    if (keepAssetStatuses.has(a.status) && a.sha256) add(a.sha256, `资产 ${a.id} 状态 ${a.status}`);
    const meta = JSON.parse(a.meta_json || '{}');
    if (a.kind === 'preview' && keepAssetStatuses.has(a.status)) {
      for (const f of (meta.frames || [])) add(f, `预览产物 ${a.id} 的帧`);
    }
  }
  return refs;
}

function gc(dryRun) {
  const refs = referencedObjects();
  const all = storage.listObjects();
  const deleted = [], retained = [];
  for (const sha of all) {
    if (refs.has(sha)) retained.push({ sha, reasons: [...refs.get(sha)] });
    else {
      deleted.push(sha);
      if (!dryRun) storage.deleteObject(sha);
    }
  }
  return { dryRun: !!dryRun, total: all.length, deleted, retainedCount: retained.length, retained };
}

module.exports = { gc, referencedObjects };
