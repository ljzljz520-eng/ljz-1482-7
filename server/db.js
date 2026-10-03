'use strict';
// 关系库：SQLite（better-sqlite3）。schema + 种子数据。
const path = require('path');
const Database = require('better-sqlite3');
const { DATA_DIR, nowIso, sha256 } = require('./common');
const storage = require('./storage');
const mesh = require('./mesh');

const db = new Database(path.join(DATA_DIR, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS products(
  id TEXT PRIMARY KEY, code TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  embargo_until TEXT, status TEXT NOT NULL DEFAULT 'development', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS models(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  code TEXT NOT NULL, name TEXT NOT NULL, tier TEXT NOT NULL DEFAULT 'standard',
  specs_json TEXT NOT NULL DEFAULT '{}', public_fields_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'development', UNIQUE(product_id, code));
CREATE TABLE IF NOT EXISTS evidence(
  id TEXT NOT NULL, product_id TEXT NOT NULL REFERENCES products(id),
  title TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'approved',
  body TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(id, version));
CREATE TABLE IF NOT EXISTS selling_points(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  title TEXT NOT NULL, claim TEXT NOT NULL, params_json TEXT NOT NULL DEFAULT '{}',
  evidence_id TEXT NOT NULL, evidence_version INTEGER NOT NULL,  -- 证据为 (id,version) 复合主键，应用层校验
  version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'active', updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS selling_point_models(
  sp_id TEXT NOT NULL REFERENCES selling_points(id),
  model_id TEXT NOT NULL REFERENCES models(id), PRIMARY KEY(sp_id, model_id));
CREATE TABLE IF NOT EXISTS assets(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  sha256 TEXT, size INTEGER DEFAULT 0, status TEXT NOT NULL DEFAULT 'uploading',
  license TEXT NOT NULL DEFAULT 'internal', embargo_until TEXT,
  public_fields_json TEXT NOT NULL DEFAULT '[]', meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL, UNIQUE(kind, name, version));
CREATE TABLE IF NOT EXISTS uploads(
  id TEXT PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets(id),
  total_chunks INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scenes(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  manifest_json TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(product_id, name, version));
CREATE TABLE IF NOT EXISTS timelines(
  id TEXT PRIMARY KEY, product_id TEXT NOT NULL REFERENCES products(id),
  model_id TEXT NOT NULL REFERENCES models(id), scene_id TEXT NOT NULL REFERENCES scenes(id),
  name TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  doc_json TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS channels(
  code TEXT PRIMARY KEY, name TEXT NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL,
  fps INTEGER NOT NULL, safe_json TEXT NOT NULL, subtitle_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS render_jobs(
  id TEXT PRIMARY KEY, timeline_id TEXT NOT NULL REFERENCES timelines(id),
  channel_code TEXT NOT NULL REFERENCES channels(code),
  status TEXT NOT NULL DEFAULT 'queued', blockers_json TEXT NOT NULL DEFAULT '[]',
  output_asset_id TEXT REFERENCES assets(id), input_hash TEXT, allow_placeholder INTEGER NOT NULL DEFAULT 0,
  placeholder INTEGER NOT NULL DEFAULT 0, conflicts_json TEXT NOT NULL DEFAULT '[]',
  error TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS candidates(
  id TEXT PRIMARY KEY, render_job_id TEXT NOT NULL REFERENCES render_jobs(id),
  product_id TEXT NOT NULL REFERENCES products(id), model_id TEXT NOT NULL REFERENCES models(id),
  channel_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'candidate',
  review_notes TEXT, created_by TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schedules(
  id TEXT PRIMARY KEY, candidate_id TEXT NOT NULL REFERENCES candidates(id),
  actor TEXT NOT NULL, run_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
  block_reason TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS audit(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, detail_json TEXT NOT NULL DEFAULT '{}');
`);

const q = {
  get: (s, ...a) => db.prepare(s).get(...a),
  all: (s, ...a) => db.prepare(s).all(...a),
  run: (s, ...a) => db.prepare(s).run(...a)
};

function audit(actor, action, detail) {
  q.run('INSERT INTO audit(ts,actor,action,detail_json) VALUES(?,?,?,?)',
    nowIso(), actor, action, JSON.stringify(detail || {}));
}

const ROLE_PERMS = {
  admin: ['*'],
  editor: ['asset.upload', 'asset.edit', 'scene.edit', 'timeline.edit', 'render', 'candidate.create', 'evidence.edit', 'sp.edit'],
  legal: ['candidate.approve', 'asset.license', 'evidence.edit', 'export'],
  publisher: ['publish', 'schedule'],
  viewer: []
};
function can(actor, perm) {
  const u = q.get('SELECT * FROM users WHERE id=?', actor);
  if (!u) return false;
  const ps = ROLE_PERMS[u.role] || [];
  return ps.includes('*') || ps.includes(perm);
}

// ---------- 种子数据 ----------
function seedAsset(kind, name, version, buf, opts = {}) {
  const sha = storage.putObject(buf);
  const id = opts.id || ('ast_' + kind + '_' + name.replace(/\W+/g, '_') + '_v' + version);
  q.run(`INSERT OR IGNORE INTO assets(id,kind,name,version,sha256,size,status,license,embargo_until,public_fields_json,meta_json,created_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
    id, kind, name, version, sha, buf.length, 'ready',
    opts.license || 'public', opts.embargoUntil || null,
    JSON.stringify(opts.publicFields || []), JSON.stringify(opts.meta || {}), nowIso());
  return id;
}

function seed() {
  if (q.get('SELECT id FROM products LIMIT 1')) return;
  const ts = nowIso();
  [['admin', '管理员', 'admin'], ['editor1', '编辑小赵', 'editor'], ['legal1', '法务小钱', 'legal'],
   ['pub1', '发布小孙', 'publisher'], ['viewer1', '访客小李', 'viewer']]
    .forEach(u => q.run('INSERT INTO users(id,name,role) VALUES(?,?,?)', u[0], u[1], u[2]));

  q.run(`INSERT INTO products(id,code,name,embargo_until,status,created_at) VALUES(?,?,?,?,?,?)`,
    'p_aurora', 'AURORA-S1', 'Aurora 智能音箱 S1', '2026-10-01T00:00:00Z', 'announced', ts);
  q.run(`INSERT INTO models(id,product_id,code,name,tier,specs_json,public_fields_json,status) VALUES(?,?,?,?,?,?,?,?)`,
    'm_std', 'p_aurora', 'STD', 'Aurora S1 标准版', 'standard',
    JSON.stringify({ battery: '8h', charge: '10W', driver: '40mm', weight: '540g' }),
    JSON.stringify(['battery', 'charge', 'driver', 'weight']), 'released');
  q.run(`INSERT INTO models(id,product_id,code,name,tier,specs_json,public_fields_json,status) VALUES(?,?,?,?,?,?,?,?)`,
    'm_pro', 'p_aurora', 'PRO', 'Aurora S1 Pro', 'pro',
    JSON.stringify({ battery: '20h', charge: '30W', driver: '50mm', codec: 'LHDC', weight: '610g' }),
    JSON.stringify(['battery', 'charge', 'driver', 'codec', 'weight']), 'released');

  q.run(`INSERT INTO evidence(id,product_id,title,version,status,body,created_at) VALUES(?,?,?,?,?,?,?)`,
    'ev_battery', 'p_aurora', '续航实验室报告', 1, 'approved',
    '实验室 50% 音量连续播放：Pro 20h / 标准版 8h。报告编号 LAB-2609-114。', ts);
  q.run(`INSERT INTO evidence(id,product_id,title,version,status,body,created_at) VALUES(?,?,?,?,?,?,?)`,
    'ev_charge', 'p_aurora', '充电测试报告', 1, 'approved',
    'Pro 30W 快充：充电 10 分钟可播放 2 小时。标准版 10W。报告编号 LAB-2609-120。', ts);

  const sp = (id, title, claim, params, ev, evv, models) => {
    q.run(`INSERT INTO selling_points(id,product_id,title,claim,params_json,evidence_id,evidence_version,version,status,updated_at)
           VALUES(?,?,?,?,?,?,?,1,'active',?)`, id, 'p_aurora', title, claim, JSON.stringify(params), ev, evv, ts);
    for (const m of models) q.run('INSERT INTO selling_point_models(sp_id,model_id) VALUES(?,?)', id, m);
  };
  sp('sp_battery_pro', 'Pro 超长续航', '20 小时超长续航，周末出行不用充电', { battery: '20h' }, 'ev_battery', 1, ['m_pro']);
  sp('sp_battery_std', '标准版日常续航', '8 小时日常续航，满足一天通勤', { battery: '8h' }, 'ev_battery', 1, ['m_std']);
  sp('sp_charge_pro', 'Pro 快充', '30W 快充，充电 10 分钟听歌 2 小时', { charge: '30W' }, 'ev_charge', 1, ['m_pro']);

  // 自有示例三维资产
  const modelId = seedAsset('model3d', 'aurora-speaker', 1, Buffer.from(JSON.stringify(mesh.buildSpeakerModel())), { id: 'ast_model' });
  seedAsset('material', 'aurora-materials', 1, Buffer.from(JSON.stringify(mesh.MATERIALS)), { id: 'ast_mat' });
  seedAsset('camera', 'studio-cam', 1, Buffer.from(JSON.stringify(mesh.CAMERA)), { id: 'ast_cam' });
  seedAsset('light', 'studio-lights', 1, Buffer.from(JSON.stringify(mesh.LIGHTS)), { id: 'ast_light' });
  seedAsset('texture', 'aurora-logo', 1, Buffer.from(mesh.LOGO_SVG), { id: 'ast_tex_logo', meta: { contentType: 'image/svg+xml' } });
  seedAsset('doc', '内部评审记录模板', 1, Buffer.from('内部评审记录（机密）：包含未公开定价与渠道策略讨论。'), { id: 'ast_internal_doc', license: 'internal' });

  const manifest = {
    model: { assetId: modelId, version: 1 },
    materials: { assetId: 'ast_mat', version: 1 },
    camera: { assetId: 'ast_cam', version: 1 },
    lights: { assetId: 'ast_light', version: 1 },
    textures: [{ slot: 'logo', assetId: 'ast_tex_logo', version: 1 }]
  };
  q.run(`INSERT INTO scenes(id,product_id,name,version,manifest_json,created_at) VALUES(?,?,?,?,?,?)`,
    'sc_main', 'p_aurora', '主场景', 1, JSON.stringify(manifest), ts);

  const doc = {
    duration: 6,
    tracks: {
      scene: [{ id: 'seg1', start: 0, end: 6, sceneId: 'sc_main', motion: { rpm: 9 } }],
      subtitles: [
        { id: 'c1', start: 0.4, end: 2.8, text: 'Aurora S1 Pro，声临其境' },
        { id: 'c2', start: 3.0, end: 5.6, text: '20 小时超长续航' }
      ],
      callouts: [{ id: 'k1', start: 2.8, end: 5.8, spId: 'sp_battery_pro', anchor: 'top-right' }]
    }
  };
  q.run(`INSERT INTO timelines(id,product_id,model_id,scene_id,name,version,doc_json,updated_at) VALUES(?,?,?,?,?,?,?,?)`,
    'tl_main', 'p_aurora', 'm_pro', 'sc_main', 'Pro 发布主视频', 1, JSON.stringify(doc), ts);

  const ch = (code, name, w, h, fps, safe, sub) =>
    q.run('INSERT INTO channels(code,name,width,height,fps,safe_json,subtitle_json) VALUES(?,?,?,?,?,?,?)',
      code, name, w, h, fps, JSON.stringify(safe), JSON.stringify(sub));
  ch('web', '官网横版', 1920, 1080, 4, { l: 0.05, r: 0.05, t: 0.05, b: 0.08 }, { fontSize: 42, maxLines: 2 });
  ch('short', '短视频竖版', 1080, 1920, 4, { l: 0.08, r: 0.08, t: 0.14, b: 0.20 }, { fontSize: 48, maxLines: 2 });
  ch('tv', '电视端', 1920, 1080, 4, { l: 0.10, r: 0.10, t: 0.10, b: 0.12 }, { fontSize: 46, maxLines: 2 });

  audit('system', 'seed', { product: 'p_aurora' });
}
seed();

module.exports = { db, q, audit, can, ROLE_PERMS };
