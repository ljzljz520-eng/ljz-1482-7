'use strict';
// 对象存储：内容寻址（sha256）+ 分片可续传上传
const fs = require('fs');
const path = require('path');
const { OBJ_DIR, UP_DIR, sha256 } = require('./common');

function objectPath(sha) { return path.join(OBJ_DIR, sha.slice(0, 2), sha); }

function putObject(buf) {
  const sha = sha256(buf);
  const p = objectPath(sha);
  if (!fs.existsSync(p)) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, p); // 原子落盘，半写对象不可见
  }
  return sha;
}
function hasObject(sha) { return fs.existsSync(objectPath(sha)); }
function getObject(sha) {
  const p = objectPath(sha);
  if (!fs.existsSync(p)) { const e = new Error('object not found: ' + sha); e.code = 'NO_OBJECT'; throw e; }
  return fs.readFileSync(p);
}
function deleteObject(sha) {
  const p = objectPath(sha);
  if (fs.existsSync(p)) { fs.unlinkSync(p); return true; }
  return false;
}
function listObjects() {
  const out = [];
  for (const d of fs.readdirSync(OBJ_DIR)) {
    const dir = path.join(OBJ_DIR, d);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) if (!f.includes('.tmp-')) out.push(f); // 文件名即完整 sha256
  }
  return out;
}

// ---- 分片上传（支持中断续传）----
function uploadDir(id) { return path.join(UP_DIR, id); }
function initUpload(id) { fs.mkdirSync(uploadDir(id), { recursive: true }); }
function putChunk(id, n, buf) {
  fs.writeFileSync(path.join(uploadDir(id), 'chunk-' + String(n).padStart(6, '0')), buf);
}
function listChunks(id) {
  const dir = uploadDir(id);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.startsWith('chunk-')).map(f => parseInt(f.slice(6), 10)).sort((a, b) => a - b);
}
// 组装并校验 sha256；成功返回 sha，失败抛错
function completeUpload(id, expectSha) {
  const dir = uploadDir(id);
  const chunks = listChunks(id);
  const parts = chunks.map(n => fs.readFileSync(path.join(dir, 'chunk-' + String(n).padStart(6, '0'))));
  const buf = Buffer.concat(parts);
  const sha = sha256(buf);
  if (expectSha && sha !== expectSha) {
    const e = new Error(`sha256 mismatch: expect ${expectSha} got ${sha}`);
    e.code = 'SHA_MISMATCH'; throw e;
  }
  putObject(buf);
  fs.rmSync(dir, { recursive: true, force: true });
  return sha;
}
function discardUpload(id) { fs.rmSync(uploadDir(id), { recursive: true, force: true }); }

module.exports = { putObject, hasObject, getObject, deleteObject, listObjects, initUpload, putChunk, listChunks, completeUpload, discardUpload };
