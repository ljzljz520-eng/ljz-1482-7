'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const OBJ_DIR = path.join(DATA_DIR, 'objects');    // 对象存储（内容寻址）
const UP_DIR = path.join(DATA_DIR, 'uploads');     // 分片上传暂存
const EXP_DIR = path.join(DATA_DIR, 'exports');    // 公开包导出

for (const d of [DATA_DIR, OBJ_DIR, UP_DIR, EXP_DIR]) fs.mkdirSync(d, { recursive: true });

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const uid = (p) => p + '_' + crypto.randomBytes(6).toString('hex');
const nowIso = () => new Date().toISOString();
// 稳定序列化：键排序，保证哈希确定性
const stable = (v) => JSON.stringify(v, (k, val) =>
  (val && typeof val === 'object' && !Array.isArray(val))
    ? Object.keys(val).sort().reduce((o, key) => (o[key] = val[key], o), {}) : val);

module.exports = { ROOT, DATA_DIR, OBJ_DIR, UP_DIR, EXP_DIR, sha256, uid, nowIso, stable };
