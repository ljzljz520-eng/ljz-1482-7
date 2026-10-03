'use strict';
// 公开包导出：仅公开字段、已解禁且已发布型号、公开授权素材；
// 绝不包含内部评审备注与未解禁模型。
const fs = require('fs');
const path = require('path');
const { q, audit } = require('./db');
const storage = require('./storage');
const { EXP_DIR, nowIso, sha256, uid } = require('./common');
const { publicSpecs } = require('./policy');

function exportPublicPackage(productId, actor, now) {
  now = now || nowIso();
  const product = q.get('SELECT * FROM products WHERE id=?', productId);
  if (!product) throw new Error('product not found');
  const exportId = uid('exp');
  const dir = path.join(EXP_DIR, exportId);
  fs.mkdirSync(path.join(dir, 'frames'), { recursive: true });

  // 型号：仅已发布；规格仅公开字段
  const models = q.all('SELECT * FROM models WHERE product_id=? AND status=?', productId, 'released')
    .map(m => ({ code: m.code, name: m.name, tier: m.tier, specs: publicSpecs(m) }));

  // 卖点：仅有效证据且状态 active；不带任何内部字段
  const sps = q.all(`SELECT * FROM selling_points WHERE product_id=? AND status='active'`, productId)
    .filter(sp => {
      const ev = q.get('SELECT * FROM evidence WHERE id=? AND version=?', sp.evidence_id, sp.evidence_version);
      const latest = q.get('SELECT MAX(version) v FROM evidence WHERE id=?', sp.evidence_id).v;
      return ev && ev.status === 'approved' && sp.evidence_version === latest;
    })
    .map(sp => ({
      title: sp.title, claim: sp.claim,
      models: q.all('SELECT model_id FROM selling_point_models WHERE sp_id=?', sp.id).map(r => r.model_id)
    }));

  // 已发布候选 => 各渠道预览成果（跳过占位产物、内部授权素材、未解禁素材）
  const pubs = q.all(`SELECT c.* FROM candidates c WHERE c.product_id=? AND c.status='published'`, productId);
  const channels = [];
  const skipped = [];
  for (const c of pubs) {
    const job = q.get('SELECT * FROM render_jobs WHERE id=?', c.render_job_id);
    const asset = job && q.get('SELECT * FROM assets WHERE id=?', job.output_asset_id);
    if (!asset) { skipped.push({ candidate: c.id, reason: 'NO_ARTIFACT' }); continue; }
    const meta = JSON.parse(asset.meta_json || '{}');
    if (meta.placeholder) { skipped.push({ candidate: c.id, reason: 'PLACEHOLDER' }); continue; }
    // 输入素材授权与保密期复核
    let blocked = false;
    const scene = q.get('SELECT * FROM scenes WHERE id=?', meta.inputs.sceneId);
    const m = JSON.parse(scene.manifest_json);
    for (const aid of [m.model.assetId, m.materials.assetId, m.camera.assetId, m.lights.assetId, ...(m.textures || []).map(t => t.assetId)]) {
      const a = q.get('SELECT * FROM assets WHERE id=?', aid);
      if (a && (a.license === 'internal' || (a.embargo_until && a.embargo_until > now))) {
        skipped.push({ candidate: c.id, reason: 'ASSET_NOT_PUBLIC', assetId: aid }); blocked = true; break;
      }
    }
    if (blocked) continue;
    const chDir = path.join('channels', c.channel_code);
    fs.mkdirSync(path.join(dir, chDir, 'frames'), { recursive: true });
    for (const f of meta.frames) {
      fs.writeFileSync(path.join(dir, chDir, 'frames', f + '.svg'), storage.getObject(f));
    }
    fs.writeFileSync(path.join(dir, chDir, 'preview.html'), storage.getObject(asset.sha256));
    channels.push({ channel: c.channel_code, model: c.model_id, frames: meta.frames.length, hash: meta.hash });
  }

  const manifest = {
    exportId, generatedAt: now,
    product: { code: product.code, name: product.name },
    models, sellingPoints: sps, channels, skipped,
    guarantees: [
      '仅包含 status=released 的型号，规格字段经公开白名单过滤',
      '不包含任何内部批注与评审意见',
      '不包含内部授权(internal)或仍在保密期的素材对象',
      '不包含占位(placeholder)渲染产物'
    ]
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const checksums = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(dir)) {
    const rel = path.relative(dir, f);
    if (rel === 'checksums.txt') continue;
    checksums.push(`${sha256(fs.readFileSync(f))}  ${rel}`);
  }
  fs.writeFileSync(path.join(dir, 'checksums.txt'), checksums.sort().join('\n') + '\n');
  audit(actor, 'export', { productId, exportId, channels: channels.length, skipped: skipped.length });
  return { exportId, dir, manifest };
}

module.exports = { exportPublicPackage };
