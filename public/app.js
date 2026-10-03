'use strict';
/* 新品发布素材控制台 SPA：全部数据来自真实 API（SQLite 关系库 + 对象存储） */
const $ = (s, el) => (el || document).querySelector(s);
const $$ = (s, el) => [...(el || document).querySelectorAll(s)];
const state = { me: localStorage.getItem('me') || 'admin', users: [], highlight: null, cache: {} };

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'x-user': state.me, ...(opts.body && !(opts.body instanceof Blob) ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
    body: opts.body && !(opts.body instanceof Blob) && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) { const e = new Error(data.error || res.statusText); e.status = res.status; e.data = data; throw e; }
  return data;
}
function toast(msg, isErr) {
  const d = document.createElement('div');
  d.className = 'toast' + (isErr ? ' err' : '');
  d.textContent = msg;
  $('#toast').appendChild(d);
  setTimeout(() => d.remove(), 5000);
}
const ok = (p, msg) => p.then(r => { toast(msg || '成功'); return r; }).catch(e => { toast(e.message + (e.data && e.data.reasons ? '：' + e.data.reasons.map(r => r.type).join(',') : ''), true); throw e; });
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(9)) {
    if (c == null) continue;
    el.append(c.nodeType ? c : document.createTextNode(c));
  }
  return el;
}
const tag = (txt, cls) => h('span', { class: 'tag ' + (cls || '') }, txt);
const fmtT = (s) => s ? new Date(s).toLocaleString('zh-CN', { hour12: false }) : '—';
const esc = (s) => String(s ?? '');

// 依赖定位：点击阻塞项跳转到对应页面并高亮实体
function locateRef(ref) {
  if (!ref) return;
  const map = { asset: '#/assets', 'selling-point': '#/selling-points', cue: '#/timeline', evidence: '#/selling-points' };
  state.highlight = ref.id;
  location.hash = map[ref.kind] || '#/jobs';
}
const chip = (label, ref, cls) => h('span', { class: 'chip ' + (cls || ''), onclick: () => locateRef(ref), title: ref ? '点击定位依赖' : '' }, label);

async function boot() {
  state.users = await api('/api/users');
  const sel = $('#me');
  sel.innerHTML = '';
  for (const u of state.users) sel.append(h('option', { value: u.id, selected: u.id === state.me ? '' : null }, `${u.name}（${u.role}）`));
  sel.value = state.me;
  sel.onchange = () => { state.me = sel.value; localStorage.setItem('me', sel.value); route(); };
  window.addEventListener('hashchange', route);
  route();
}
function navActive(tab) { $$('#nav a').forEach(a => a.classList.toggle('active', a.getAttribute('href') === '#' + tab)); }

async function route() {
  const [tab, arg] = (location.hash.slice(1) || '/products').split('/').filter(Boolean);
  const main = $('#main'); main.innerHTML = '';
  const tabs = { products: tabProducts, 'selling-points': tabSP, assets: tabAssets, scenes: tabScenes, timeline: tabTimeline, jobs: tabJobs, publish: tabPublish, exports: tabExports };
  navActive('/' + (tab || 'products'));
  try { await (tabs[tab] || tabProducts)(main, arg); }
  catch (e) { main.append(h('div', { class: 'panel' }, tag('加载失败: ' + e.message, 'bad'))); }
  const hl = state.highlight; state.highlight = null;
  if (hl) { const el = $(`[data-eid="${hl}"]`); if (el) { el.scrollIntoView({ block: 'center' }); el.style.outline = '2px solid var(--warn)'; setTimeout(() => el.style.outline = '', 4000); } }
}

/* ================= 产品与型号 ================= */
async function tabProducts(main) {
  const products = await api('/api/products');
  const prod = products[0];
  const detail = await api('/api/products/' + prod.id);
  main.append(h('h2', null, '产品与型号'),
    h('div', { class: 'panel' },
      h('div', { class: 'row' },
        h('b', null, prod.name), tag('code: ' + prod.code, 'dim'),
        tag('保密期至: ' + (prod.embargo_until || '无'), prod.embargo_until && prod.embargo_until > new Date().toISOString() ? 'bad' : 'ok'),
        tag('状态: ' + prod.status, 'acc')),
      h('div', { class: 'row', style: 'margin-top:8px' },
        h('label', { class: 'small dim' }, '调整保密期 '),
        h('input', { type: 'datetime-local', id: 'emb' }),
        h('button', { onclick: async () => { const v = $('#emb').value; if (!v) return; await ok(api('/api/products/' + prod.id, { method: 'PATCH', body: { embargoUntil: new Date(v).toISOString() } }), '保密期已更新'); route(); } }, '保存'))));

  main.append(h('h3', null, '型号（卖点与参数按型号隔离，高配参数不会流入低配视频）'));
  const tbl = h('table', null, h('tr', null, ['型号', '名称', '层级', '状态', '规格(内部全量)', '公开字段白名单', '操作'].map(x => h('th', null, x))));
  for (const m of detail.models) {
    const specs = JSON.parse(m.specs_json), pub = JSON.parse(m.public_fields_json);
    tbl.append(h('tr', { 'data-eid': m.id },
      h('td', { class: 'mono' }, m.code), h('td', null, m.name), h('td', null, tag(m.tier, m.tier === 'pro' ? 'acc' : 'dim')),
      h('td', null, tag(m.status, m.status === 'released' ? 'ok' : 'warn')),
      h('td', { class: 'mono small' }, esc(JSON.stringify(specs))),
      h('td', null, pub.map(k => tag(k, 'dim'))),
      h('td', null, h('button', {
        onclick: async () => {
          const v = prompt('修改规格 JSON（参数订正应同步订正证据版本）', JSON.stringify(specs));
          if (!v) return;
          await ok(api('/api/models/' + m.id, { method: 'PATCH', body: { specs: JSON.parse(v) } }), '规格已更新');
          route();
        }
      }, '订正规格'))));
  }
  main.append(h('div', { class: 'panel' }, tbl));
}

/* ================= 卖点与证据 ================= */
async function tabSP(main) {
  const [sps, evs, products] = await Promise.all([api('/api/selling-points?product=p_aurora'), api('/api/evidence?product=p_aurora'), api('/api/products')]);
  const models = (await api('/api/products/p_aurora')).models;
  main.append(h('h2', null, '卖点与证据版本'));
  const evByTitle = {};
  for (const e of evs) (evByTitle[e.title] = evByTitle[e.title] || []).push(e);
  main.append(h('h3', null, '证据库（参数订正 => 新版本，旧卖点自动标记失效）'));
  const evt = h('table', null, h('tr', null, ['证据', '版本', '状态', '内容', '操作'].map(x => h('th', null, x))));
  for (const title of Object.keys(evByTitle)) {
    for (const e of evByTitle[title].sort((a, b) => b.version - a.version)) {
      const isLatest = e.version === Math.max(...evByTitle[title].map(x => x.version));
      evt.append(h('tr', { 'data-eid': e.id },
        h('td', null, e.title), h('td', null, 'v' + e.version + (isLatest ? ' (最新)' : '')),
        h('td', null, tag(e.status, e.status === 'approved' ? 'ok' : 'bad')),
        h('td', { class: 'small' }, e.body),
        h('td', null, isLatest ? h('button', {
          onclick: async () => {
            const body = prompt('参数订正：输入订正后的证据内容（将生成 v' + (e.version + 1) + '）', e.body);
            if (!body) return;
            await ok(api(`/api/evidence/${e.id}/correct`, { method: 'POST', body: { body } }), '已生成新版本证据，引用旧版的卖点已标记失效');
            route();
          }
        }, '订正参数') : '')));
    }
  }
  main.append(h('div', { class: 'panel' }, evt));

  main.append(h('h3', null, '卖点（绑定具体型号 + 证据版本）'));
  const spt = h('table', null, h('tr', null, ['卖点', '话术', '适用型号', '证据', '校验', '操作'].map(x => h('th', null, x))));
  for (const sp of sps) {
    const v = await api('/api/selling-points/' + sp.id + '/validate');
    spt.append(h('tr', { 'data-eid': sp.id },
      h('td', null, h('b', null, sp.title), h('div', { class: 'small dim' }, sp.id)),
      h('td', null, sp.claim),
      h('td', null, sp.models.map(m => tag(m, m === 'm_pro' ? 'acc' : 'dim'))),
      h('td', { class: 'mono small' }, `${sp.evidence_id}@v${sp.evidence_version}`),
      h('td', null, v.ok ? tag('有效', 'ok') : v.issues.map(i => tag(i.type, 'bad'))),
      h('td', null, h('button', {
        onclick: async () => {
          const latest = Math.max(...evByTitle[evs.find(e => e.id === sp.evidence_id).title].map(x => x.version));
          const claim = prompt('更新话术（同步到证据 v' + latest + '）', sp.claim);
          if (!claim) return;
          await ok(api('/api/selling-points/' + sp.id, { method: 'PATCH', body: { claim, evidenceVersion: latest } }), '卖点已更新到最新证据版本');
          route();
        }
      }, '订正并升级'))));
  }
  main.append(h('div', { class: 'panel' }, spt));
}

/* ================= 素材库（分片上传/续传） ================= */
const upState = {};
async function tabAssets(main) {
  const assets = await api('/api/assets');
  main.append(h('h2', null, '素材库（对象存储 + 授权/保密期/公开字段）'));
  // 上传面板
  const file = h('input', { type: 'file' });
  const kind = h('select', null, ['model3d', 'texture', 'material', 'camera', 'light', 'doc'].map(k => h('option', null, k)));
  const name = h('input', { placeholder: '资产名', value: 'aurora-speaker' });
  const ver = h('input', { type: 'number', value: 2, style: 'width:70px' });
  const license = h('select', null, ['internal', 'licensed', 'public'].map(k => h('option', null, k)));
  const bar = h('div', { class: 'progress', style: 'width:260px' }, h('i', { style: 'width:0%' }));
  const log = h('div', { class: 'small dim mono' }, '选择文件后可模拟上传中断并续传');
  let aborted = false, current = null;
  async function sha256Hex(buf) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map(b => b.toString(16).padStart(2, '0')).join(''); }
  async function doUpload() {
    const f = file.files[0]; if (!f) return toast('请选择文件', true);
    const buf = await f.arrayBuffer();
    const CH = 256 * 1024, n = Math.max(1, Math.ceil(buf.byteLength / CH));
    const sha = await sha256Hex(buf);
    const up = await api('/api/uploads', { method: 'POST', body: { kind: kind.value, name: name.value, version: +ver.value, license: license.value, sha256: sha, size: buf.byteLength, chunks: n } });
    current = { ...up, buf, CH, n };
    log.textContent = `上传 ${up.uploadId} 共 ${n} 片 sha=${sha.slice(0, 12)}…`;
    await sendChunks();
  }
  async function sendChunks() {
    aborted = false;
    const st = await api('/api/uploads/' + current.uploadId);
    const have = new Set(st.received);
    for (let i = 0; i < current.n; i++) {
      if (aborted) { log.textContent = `已中断（${have.size}/${current.n}），可点击“续传”`; return; }
      if (have.has(i)) continue;
      await api(`/api/uploads/${current.uploadId}/chunks/${i}`, { method: 'PUT', body: new Blob([current.buf.slice(i * current.CH, (i + 1) * current.CH)]), headers: { 'Content-Type': 'application/octet-stream' } });
      bar.firstChild.style.width = Math.round((i + 1) / current.n * 100) + '%';
    }
    const done = await api('/api/uploads/' + current.uploadId + '/complete', { method: 'POST' });
    log.textContent = `完成：资产 ${done.id} 状态 ${done.status}`;
    toast('上传完成'); route();
  }
  main.append(h('div', { class: 'panel' },
    h('div', { class: 'row' }, file, kind, name, h('label', { class: 'small dim' }, '版本'), ver, license,
      h('button', { class: 'primary', onclick: () => ok(doUpload()) }, '开始上传'),
      h('button', { onclick: () => { aborted = true; } }, '模拟中断'),
      h('button', { onclick: () => current ? ok(sendChunks()) : toast('无进行中的上传', true) }, '续传')),
    h('div', { class: 'row', style: 'margin-top:8px' }, bar), log));

  const tbl = h('table', null, h('tr', null, ['资产', '类型', '版本', '状态', '授权', '保密期至', '对象', '操作'].map(x => h('th', null, x))));
  for (const a of assets) {
    tbl.append(h('tr', { 'data-eid': a.id },
      h('td', null, h('b', null, a.name), h('div', { class: 'mono small dim' }, a.id)),
      h('td', null, tag(a.kind, 'acc')), h('td', null, 'v' + a.version),
      h('td', null, tag(a.status, a.status === 'ready' ? 'ok' : a.status === 'uploading' ? 'warn' : 'bad')),
      h('td', null, tag(a.license, a.license === 'public' ? 'ok' : a.license === 'internal' ? 'bad' : 'warn')),
      h('td', { class: 'small' }, a.embargo_until || '—'),
      h('td', { class: 'mono small dim' }, a.sha256 ? a.sha256.slice(0, 12) + '…' : '—'),
      h('td', null,
        h('button', { onclick: async () => { const l = prompt('授权 internal/licensed/public', a.license); if (l) { await ok(api('/api/assets/' + a.id, { method: 'PATCH', body: { license: l } }), '已更新'); route(); } } }, '授权'),
        ' ',
        h('button', { onclick: async () => { await ok(api('/api/assets/' + a.id, { method: 'PATCH', body: { status: 'retired' } }), '已退役（GC 将回收未被引用的对象）'); route(); } }, '退役'))));
  }
  main.append(h('div', { class: 'panel' }, tbl));
}

/* ================= 场景与三维预览 ================= */
async function loadResolvedScene(sceneId) {
  const s = await api('/api/scenes/' + sceneId);
  const m = JSON.parse(s.manifest_json);
  const getJson = async (id) => JSON.parse(await (await fetch('/api/assets/' + id + '/object', { headers: { 'x-user': state.me } })).text());
  const missingTextures = [];
  const textureBlobs = {};
  for (const t of (m.textures || [])) {
    const a = await api('/api/assets/' + t.assetId);
    if (a.status !== 'ready' || a.version !== t.version) { missingTextures.push(t.slot); continue; }
    const blob = await (await fetch('/api/assets/' + t.assetId + '/object', { headers: { 'x-user': state.me } })).blob();
    textureBlobs[t.slot] = URL.createObjectURL(blob);
  }
  return {
    manifest: m,
    model: await getJson(m.model.assetId),
    materials: await getJson(m.materials.assetId),
    camera: await getJson(m.camera.assetId),
    lights: await getJson(m.lights.assetId),
    missingTextures, textureBlobs
  };
}
async function tabScenes(main) {
  const scenes = await api('/api/scenes?product=p_aurora');
  const sel = h('select', null, scenes.map(s => h('option', { value: s.id }, `${s.name} v${s.version} (${s.id})`)));
  const box = h('div', null);
  main.append(h('h2', null, '场景与三维预览'),
    h('div', { class: 'panel row' }, h('label', { class: 'dim small' }, '场景 '), sel), box);
  async function show() {
    box.innerHTML = '';
    const sceneId = sel.value;
    const res = await api('/api/scenes/' + sceneId + '/resolve');
    const tSlider = h('input', { type: 'range', min: 0, max: 6, step: 0.05, value: 1.2, style: 'width:220px' });
    const rpmIn = h('input', { type: 'number', value: 9, style: 'width:64px' });
    const canvas = h('canvas', { class: 'gl', width: 960, height: 600 });
    const shot = h('div', { class: 'framebox', style: 'aspect-ratio:16/9' });
    const depPanel = h('div', { class: 'panel' });
    depPanel.append(h('h3', null, '场景清单解析（固定模型/材质/相机/灯光/纹理版本）'),
      res.ok ? h('div', null, tag('依赖完整', 'ok'), Object.entries(res.resolved).map(([k, v]) =>
        h('div', { class: 'mono small dim' }, `${k}: ${typeof v === 'object' ? JSON.stringify(v).slice(0, 26) : String(v).slice(0, 26)}…`)))
        : h('div', null, tag('依赖缺失', 'bad'), res.missing.map(m2 => h('div', null, chip(`${m2.type}: ${m2.kind} ${m2.assetId}@${m2.version}`, { kind: 'asset', id: m2.assetId }, 'bad')))));
    box.append(h('div', { class: 'grid two' },
      h('div', { class: 'panel' }, h('h3', null, '浏览器实时预览（WebGL，同一场景清单重建）'),
        res.ok ? canvas : h('div', null, tag('依赖缺失，无法预览', 'bad')),
        h('div', { class: 'row', style: 'margin-top:8px' }, h('label', { class: 'small dim' }, '时间 t'), tSlider, h('label', { class: 'small dim' }, '转速 rpm'), rpmIn)),
      h('div', { class: 'panel' }, h('h3', null, '服务端截图（同一清单确定性重建）'), shot,
        h('div', { class: 'small dim', style: 'margin-top:6px' }, '两侧均由场景清单 v' + (scenes.find(s => s.id === sceneId) || {}).version + ' 重建；缺纹理时浏览器端品红警示、服务端阻塞，绝不静默占位。'))),
      depPanel);
    if (!res.ok) return;
    const resolved = await loadResolvedScene(sceneId);
    if (resolved.missingTextures.length) {
      box.prepend(h('div', { class: 'panel' }, tag('缺纹理: ' + resolved.missingTextures.join(','), 'bad'),
        h('span', { class: 'small dim' }, ' 浏览器端以品红显式警示；服务端渲染将被阻塞（可显式占位但禁止发布）。')));
    }
    const glView = GL.create(canvas, resolved);
    if (glView.error) { box.prepend(tag(glView.error, 'bad')); return; }
    let raf;
    const draw = () => { glView.render(+tSlider.value, { rpm: +rpmIn.value }); };
    const animate = () => { draw(); raf = requestAnimationFrame(animate); };
    animate();
    const refreshShot = () => { shot.innerHTML = ''; shot.append(h('img', { src: `/api/scenes/${sceneId}/frame.svg?t=${tSlider.value}&rpm=${rpmIn.value}&channel=web`, style: 'width:100%' })); };
    tSlider.oninput = refreshShot; rpmIn.onchange = refreshShot;
    refreshShot();
    // 离开页面停止动画
    const mo = new MutationObserver(() => { if (!document.contains(canvas)) { cancelAnimationFrame(raf); mo.disconnect(); } });
    mo.observe(document.body, { childList: true, subtree: true });
  }
  sel.onchange = show;
  await show();
}

/* ================= 时间线编辑器 ================= */
async function tabTimeline(main) {
  const [tls, channels, sps] = await Promise.all([
    api('/api/timelines?product=p_aurora'), api('/api/channels'), api('/api/selling-points?product=p_aurora')]);
  const selTl = h('select', null, tls.map(t => h('option', { value: t.id }, `${t.name} (v${t.version})`)));
  const selCh = h('select', null, channels.map(c => h('option', { value: c.code }, `${c.name} ${c.width}x${c.height}`)));
  const head = h('div', { class: 'panel row' }, h('label', { class: 'dim small' }, '时间线 '), selTl,
    h('label', { class: 'dim small' }, '预览渠道 '), selCh,
    h('button', { class: 'primary', onclick: () => ok(save()).then(route) }, '保存时间线'));
  const body = h('div', null);
  main.append(h('h2', null, '时间线编辑器'), head, body);
  let tl, doc;
  async function load() {
    tl = await api('/api/timelines/' + selTl.value);
    doc = JSON.parse(tl.doc_json);
    draw();
  }
  async function save() { return api('/api/timelines/' + tl.id, { method: 'PATCH', body: { doc } }); }
  function draw() {
    body.innerHTML = '';
    const dur = doc.duration;
    const pct = (t) => (t / dur * 100) + '%';
    // 标尺
    const ruler = h('div', { class: 'tl-ruler' });
    for (let s = 0; s <= dur; s++) ruler.append(h('span', { class: 'small dim', style: `position:absolute;left:${pct(s)}` }, s + 's'));
    const mkTrack = (label, items, cls, onClick) => {
      const tr = h('div', { class: 'tl-track' }, h('span', { class: 'small dim', style: 'position:absolute;left:-2px;top:-18px' }, label));
      for (const it of items) {
        tr.append(h('div', {
          class: 'blk ' + cls, 'data-eid': it.id,
          style: `left:${pct(it.start)};width:calc(${pct(it.end - it.start)} - 2px)`,
          onclick: () => onClick(it)
        }, it.text || it.claim || it.id));
      }
      return tr;
    };
    const editCue = (c) => {
      const text = prompt('字幕文本', c.text); if (text == null) return;
      const start = parseFloat(prompt('开始(s)', c.start)), end = parseFloat(prompt('结束(s)', c.end));
      Object.assign(c, { text, start, end }); draw();
    };
    const editCall = (c) => {
      const spId = prompt('卖点ID（仅限绑定当前型号的卖点）', c.spId); if (!spId) return;
      const start = parseFloat(prompt('开始(s)', c.start)), end = parseFloat(prompt('结束(s)', c.end));
      Object.assign(c, { spId, start, end }); draw();
    };
    const tracks = h('div', null,
      mkTrack('场景段', doc.tracks.scene, 'scene', () => {}),
      mkTrack('字幕', doc.tracks.subtitles, 'sub', editCue),
      mkTrack('卖点标注', doc.tracks.callouts.map(c => ({ ...c, claim: c.spId })), 'call', editCall));
    // 校验
    const valBox = h('div', { class: 'panel' });
    const doValidate = async () => {
      await save();
      const v = await api(`/api/timelines/${tl.id}/validate?channel=${selCh.value}`);
      valBox.innerHTML = '';
      valBox.append(h('h3', null, `渠道「${selCh.value}」校验`));
      if (!v.spIssues.length && !v.conflicts.length) valBox.append(tag('无阻塞：可渲染', 'ok'));
      for (const i of v.spIssues) valBox.append(h('div', null, chip(`${i.type} ${i.spId || ''} ${i.detail || ''}`, i.spId ? { kind: 'selling-point', id: i.spId } : null, 'bad')));
      for (const c of v.conflicts) valBox.append(h('div', null, chip(`${c.type} @${c.cueId}: ${c.detail}`, { kind: 'cue', id: c.cueId }, 'bad')));
      // 安全区可视化
      drawPreview(v);
    };
    const pvBox = h('div', { class: 'panel' });
    function drawPreview(v) {
      pvBox.innerHTML = '';
      const ch = channels.find(c => c.code === selCh.value);
      const safe = JSON.parse(ch.safe_json);
      const W = 480, H = W * ch.height / ch.width;
      const wrap = h('div', { style: `position:relative;width:${W}px;height:${H}px;background:#0a0d13;border:1px solid var(--line);border-radius:8px;overflow:hidden` });
      wrap.append(h('img', { src: `/api/scenes/${tl.scene_id}/frame.svg?t=1.2&channel=${ch.code}`, style: 'width:100%;height:100%;object-fit:cover;opacity:.5' }));
      wrap.append(h('div', { class: 'safezone', style: `left:${safe.l * 100}%;right:${safe.r * 100}%;top:${safe.t * 100}%;bottom:${safe.b * 100}%` }));
      for (const c of v.conflicts) {
        const cue = doc.tracks.subtitles.find(x => x.id === c.cueId);
        if (cue) wrap.append(h('div', { style: `position:absolute;left:${safe.l * 100}%;right:${safe.r * 100}%;bottom:${safe.b * 100}%;color:var(--bad);font-size:11px;text-align:center` }, '⚠ ' + cue.text));
      }
      pvBox.append(h('h3', null, '安全区预览（虚线框）'), wrap,
        h('div', { class: 'small dim' }, `渠道安全区 上${safe.t * 100}% 下${safe.b * 100}% 左${safe.l * 100}% 右${safe.r * 100}%`));
    }
    // 添加控件
    const modelId = tl.model_id;
    const validSps = sps.filter(s => s.models.includes(modelId));
    const addSub = h('button', {
      onclick: () => {
        const text = prompt('字幕文本'); if (!text) return;
        doc.tracks.subtitles.push({ id: 'c' + Date.now(), start: 1, end: 3, text }); draw();
      }
    }, '+ 字幕');
    const addCall = h('button', {
      onclick: () => {
        const spId = prompt('卖点ID（当前型号可用：' + validSps.map(s => s.id).join(', ') + '）');
        if (!spId) return;
        doc.tracks.callouts.push({ id: 'k' + Date.now(), start: 1, end: 4, spId, anchor: 'top-right' }); draw();
      }
    }, '+ 卖点标注');
    body.append(
      h('div', { class: 'panel' },
        h('div', { class: 'row', style: 'margin-bottom:8px' },
          tag('型号: ' + modelId, 'acc'), tag('场景: ' + tl.scene_id, 'dim'),
          h('span', { class: 'small dim' }, '本型号可用卖点: '), validSps.map(s => tag(s.id, 'ok')),
          sps.filter(s => !s.models.includes(modelId)).map(s => tag(s.id + '(其他型号)', 'bad'))),
        h('div', { style: 'margin-left:0' }, ruler), tracks,
        h('div', { class: 'row', style: 'margin-top:8px' }, addSub, addCall,
          h('button', { onclick: () => ok(doValidate()) }, '校验安全区与卖点'))),
      h('div', { class: 'grid two' }, valBox, pvBox));
  }
  selTl.onchange = load; selCh.onchange = load;
  await load();
}

/* ================= 渲染任务 ================= */
async function tabJobs(main) {
  const [jobs, tls, channels] = await Promise.all([api('/api/render-jobs'), api('/api/timelines?product=p_aurora'), api('/api/channels')]);
  const selTl = h('select', null, tls.map(t => h('option', { value: t.id }, t.name)));
  const selCh = h('select', null, channels.map(c => h('option', { value: c.code }, c.name)));
  const allowPh = h('input', { type: 'checkbox' });
  const detail = h('div', null);
  main.append(h('h2', null, '渲染任务（服务端确定性渲染）'),
    h('div', { class: 'panel row' }, selTl, selCh,
      h('label', { class: 'small' }, allowPh, ' 允许占位纹理（仅内部预览，禁止发布）'),
      h('button', {
        class: 'primary', onclick: async () => {
          const j = await ok(api('/api/render-jobs', { method: 'POST', body: { timelineId: selTl.value, channel: selCh.value, allowPlaceholder: allowPh.checked } }), '渲染完成/已入队');
          route();
        }
      }, '发起渲染')),
    h('div', { class: 'grid two' }, h('div', { id: 'joblist' }), detail));
  const list = $('#joblist', main);
  const tbl = h('table', null, h('tr', null, ['任务', '时间线/渠道', '状态', '占位', '输入哈希', '操作'].map(x => h('th', null, x))));
  for (const j of jobs) {
    tbl.append(h('tr', { 'data-eid': j.id },
      h('td', { class: 'mono small' }, j.id),
      h('td', { class: 'small' }, `${tls.find(t => t.id === j.timeline_id)?.name || j.timeline_id} → ${j.channel_code}`),
      h('td', null, tag(j.status, j.status === 'done' ? 'ok' : j.status === 'blocked' ? 'bad' : j.status === 'failed' ? 'bad' : 'warn')),
      h('td', null, j.placeholder ? tag('占位', 'bad') : tag('否', 'dim')),
      h('td', { class: 'mono small dim' }, (j.input_hash || '—').slice(0, 12)),
      h('td', null,
        h('button', { onclick: () => showJob(j, detail) }, '详情'),
        ' ',
        j.status === 'blocked' ? h('button', { onclick: async () => { await ok(api(`/api/render-jobs/${j.id}/retry`, { method: 'POST' }), '已重试'); route(); } }, '重试') : '')));
  }
  list.append(h('div', { class: 'panel' }, tbl));
}
async function showJob(j, detail) {
  detail.innerHTML = '';
  const diag = await api(`/api/render-jobs/${j.id}/diagnose`);
  const box = h('div', { class: 'panel' }, h('h3', null, `任务 ${j.id} 依赖诊断`));
  if (!diag.blockers.length && !diag.conflicts.length) box.append(tag('无依赖问题', 'ok'));
  for (const b of diag.blockers) box.append(h('div', null, chip(`${b.type} ${b.assetId || b.spId || ''} ${b.detail || b.hint || ''}`, b.ref, 'bad')));
  for (const c of diag.conflicts) box.append(h('div', null, chip(`${c.type} @${c.cueId} ${c.detail}`, c.ref, 'bad')));
  if (j.status === 'done') {
    const meta = await api(`/api/artifacts/${j.output_asset_id}/meta`);
    const verify = await api(`/api/render-jobs/${j.id}/verify`, { method: 'POST' }).catch(() => ({ match: null }));
    box.append(
      h('div', { class: 'kv', style: 'margin:8px 0' },
        h('div', null, '产物'), h('div', { class: 'mono small' }, j.output_asset_id),
        h('div', null, '帧数'), h('div', null, String(meta.frames.length)),
        h('div', null, '确定性'), h('div', null, verify.match ? tag('输入哈希一致 ✓', 'ok') : tag('不一致', 'bad')),
        h('div', null, '占位'), h('div', null, meta.placeholder ? tag('是（禁止发布）', 'bad') : tag('否', 'ok'))),
      h('iframe', { src: `/api/artifacts/${j.output_asset_id}/preview.html`, style: 'width:100%;aspect-ratio:16/9;border:1px solid var(--line);border-radius:8px;background:#000' }));
  }
  detail.append(box);
}

/* ================= 发布 ================= */
async function tabPublish(main) {
  const [cands, jobs, schedules] = await Promise.all([api('/api/candidates'), api('/api/render-jobs'), api('/api/schedules')]);
  const doneJobs = jobs.filter(j => j.status === 'done' && !j.placeholder);
  main.append(h('h2', null, '候选发布与定时发布'));
  const selJob = h('select', null, doneJobs.map(j => h('option', { value: j.id }, `${j.id} (${j.channel_code})`)));
  const notes = h('input', { placeholder: '内部评审备注（不会进入公开包）', style: 'width:280px' });
  main.append(h('div', { class: 'panel row' },
    selJob, notes,
    h('button', { class: 'primary', onclick: () => ok(api('/api/candidates', { method: 'POST', body: { renderJobId: selJob.value, reviewNotes: notes.value } }), '已创建候选').then(route) }, '创建候选发布')));
  const tbl = h('table', null, h('tr', null, ['候选', '渠道/型号', '状态', '门禁检查', '操作'].map(x => h('th', null, x))));
  for (const c of cands) {
    const check = await api(`/api/candidates/${c.id}/check`);
    const row = h('tr', { 'data-eid': c.id },
      h('td', { class: 'mono small' }, c.id),
      h('td', null, `${c.channel_code} / ${c.model_id}`),
      h('td', null, tag(c.status, c.status === 'published' ? 'ok' : c.status === 'approved' ? 'acc' : c.status === 'rejected' ? 'bad' : 'warn')),
      h('td', null, check.ok ? tag('可发布', 'ok') : check.reasons.map(r => tag(r.type, 'bad'))),
      h('td', null,
        h('button', { onclick: () => ok(api(`/api/candidates/${c.id}/approve`, { method: 'POST' }), '已审批').then(route) }, '法务审批'),
        ' ',
        h('button', { class: 'primary', onclick: () => ok(api(`/api/candidates/${c.id}/publish`, { method: 'POST' }), '已发布').then(route) }, '立即发布'),
        ' ',
        h('button', {
          onclick: async () => {
            const v = prompt('定时发布时间（ISO，如 2026-10-04T10:00:00Z）');
            if (!v) return;
            await ok(api(`/api/candidates/${c.id}/schedule`, { method: 'POST', body: { runAt: new Date(v).toISOString() } }), '已创建定时发布');
            route();
          }
        }, '定时发布')));
    tbl.append(row);
  }
  main.append(h('div', { class: 'panel' }, tbl));
  main.append(h('h3', null, '定时任务（到点重新校验权限与全部门禁）'));
  const st = h('table', null, h('tr', null, ['计划', '候选', '执行账号', '时间', '状态', '阻塞原因'].map(x => h('th', null, x))));
  for (const s of schedules) {
    st.append(h('tr', null,
      h('td', { class: 'mono small' }, s.id), h('td', { class: 'mono small' }, s.candidate_id),
      h('td', null, s.actor), h('td', { class: 'small' }, fmtT(s.run_at)),
      h('td', null, tag(s.status, s.status === 'done' ? 'ok' : s.status === 'blocked' ? 'bad' : 'warn')),
      h('td', { class: 'small' }, s.block_reason ? JSON.parse(s.block_reason).map(r => tag(r.type, 'bad')) : '—')));
  }
  main.append(h('div', { class: 'panel' }, st,
    h('button', { onclick: () => ok(api('/api/schedules/run-due', { method: 'POST', body: {} }), '已执行到期任务').then(route) }, '立即执行到期任务')));
}

/* ================= 导出与回收 ================= */
async function tabExports(main) {
  main.append(h('h2', null, '公开包导出与素材回收'));
  const expBox = h('div', { class: 'panel' });
  main.append(h('div', { class: 'panel row' },
    h('button', { class: 'primary', onclick: () => ok(api('/api/products/p_aurora/export', { method: 'POST' }), '公开包已生成').then(route) }, '导出公开包'),
    h('span', { class: 'small dim' }, '仅含已发布型号公开字段、有效卖点、已发布渠道成果；不含内部评审备注与未解禁模型/素材。')), expBox);
  const exports = await api('/api/exports');
  for (const e of exports.slice(-3)) {
    expBox.append(h('div', { class: 'panel', style: 'background:var(--panel2)' },
      h('div', { class: 'row' }, h('b', null, e.exportId), h('span', { class: 'small dim' }, fmtT(e.generatedAt))),
      h('div', { class: 'small' }, `型号: ${(e.models || []).map(m => m.code).join(', ') || '—'}；渠道成果: ${(e.channels || []).map(c => c.channel).join(', ') || '—'}；跳过: ${(e.skipped || []).length}`),
      h('div', { class: 'small dim' }, (e.guarantees || []).map(g => h('div', null, '✓ ' + g)))));
  }
  // GC
  const gcBox = h('div', { class: 'panel' }, h('h3', null, '素材回收（保留仍被候选发布引用的对象）'));
  const gcOut = h('div', { class: 'log mono panel', style: 'background:var(--panel2)' });
  gcBox.append(h('div', { class: 'row' },
    h('button', { onclick: async () => { const r = await api('/api/gc', { method: 'POST', body: { dryRun: true } }); showGc(r); } }, '预演回收'),
    h('button', { class: 'danger', onclick: async () => { const r = await ok(api('/api/gc', { method: 'POST', body: {} }), '回收完成'); showGc(r); } }, '执行回收')), gcOut);
  function showGc(r) {
    gcOut.innerHTML = `对象总数 ${r.total}，可回收 ${r.deleted.length}，保留 ${r.retainedCount}\n` +
      r.retained.filter(x => x.reasons.some(s => s.includes('候选'))).map(x => `保留 ${x.sha.slice(0, 12)}… ← ${x.reasons.join('；')}`).join('\n');
  }
  main.append(gcBox);
  const audit = await api('/api/audit');
  main.append(h('h3', null, '审计日志'),
    h('div', { class: 'panel log mono' }, audit.slice(0, 40).map(a =>
      h('div', null, `${fmtT(a.ts)} ${a.actor} ${a.action} ${a.detail_json}`))));
}

boot();
