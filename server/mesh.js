'use strict';
// 自有示例模型生成器：Aurora 智能音箱（旋转体机身 + 氛围灯环 + LOGO 铭牌）
// 输出为自定义 JSON 网格格式 own-mesh@1，浏览器 WebGL 与服务端渲染器共用同一份资产。

function round4(x) { return Math.round(x * 10000) / 10000; }

// 旋转体：profile = [[r, y], ...] 自下而上
function lathe(profile, segments) {
  const pos = [], norm = [], idx = [];
  const n = profile.length;
  const n2 = profile.map((p, i) => {
    const a = profile[Math.max(0, i - 1)], b = profile[Math.min(n - 1, i + 1)];
    const dr = b[0] - a[0], dy = b[1] - a[1];
    let nr = dy, ny = -dr;
    const l = Math.hypot(nr, ny) || 1;
    return [nr / l, ny / l];
  });
  for (let i = 0; i < n; i++) {
    const [r, y] = profile[i]; const [nr, ny] = n2[i];
    for (let s = 0; s <= segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      const ca = Math.cos(a), sa = Math.sin(a);
      pos.push(round4(r * ca), round4(y), round4(r * sa));
      norm.push(round4(nr * ca), round4(ny), round4(nr * sa));
    }
  }
  const ring = segments + 1;
  for (let i = 0; i < n - 1; i++) for (let s = 0; s < segments; s++) {
    const a = i * ring + s, b = a + ring;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  return { positions: pos, normals: norm, indices: idx };
}

function torus(R, r, y0, segU, segV) {
  const pos = [], norm = [], idx = [];
  for (let i = 0; i <= segU; i++) {
    const u = (i / segU) * Math.PI * 2, cu = Math.cos(u), su = Math.sin(u);
    for (let j = 0; j <= segV; j++) {
      const v = (j / segV) * Math.PI * 2, cv = Math.cos(v), sv = Math.sin(v);
      pos.push(round4((R + r * cv) * cu), round4(y0 + r * sv), round4((R + r * cv) * su));
      norm.push(round4(cv * cu), round4(sv), round4(cv * su));
    }
  }
  const ring = segV + 1;
  for (let i = 0; i < segU; i++) for (let j = 0; j < segV; j++) {
    const a = i * ring + j, b = a + ring;
    idx.push(a, b, a + 1, b, b + 1, a + 1);
  }
  return { positions: pos, normals: norm, indices: idx };
}

// 前置铭牌（带 UV，引用纹理槽 logo）
function plate() {
  const w = 0.46, h = 0.2, y = 0.62, z = 0.748;
  return {
    positions: [-w / 2, y - h / 2, z, w / 2, y - h / 2, z, w / 2, y + h / 2, z, -w / 2, y + h / 2, z],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
    textureSlot: 'logo'
  };
}

function buildSpeakerModel() {
  const bodyProfile = [
    [0.001, 0.0], [0.55, 0.0], [0.66, 0.05], [0.72, 0.16], [0.74, 0.35],
    [0.74, 0.95], [0.71, 1.12], [0.62, 1.26], [0.46, 1.35], [0.24, 1.4], [0.001, 1.42]
  ];
  const topProfile = [[0.001, 1.401], [0.2, 1.405], [0.24, 1.4], [0.001, 1.4]];
  const body = lathe(bodyProfile, 44);
  const top = lathe(topProfile, 44);
  const ring = torus(0.766, 0.03, 1.02, 44, 12); // 完全浮于机身表面（该高度机身半径≈0.728）
  return {
    format: 'own-mesh@1',
    name: 'aurora-speaker',
    parts: [
      { name: 'body', material: 'body', ...body },
      { name: 'top', material: 'top', ...top },
      { name: 'ring', material: 'ring', ...ring },
      { name: 'plate', material: 'plate', ...plate() }
    ]
  };
}

const MATERIALS = {
  format: 'own-mat@1',
  materials: {
    body: { color: '#8d97a5', roughness: 0.92 },
    top: { color: '#22262d', roughness: 0.6 },
    ring: { color: '#0c1014', emissive: '#3fd2e6', emissiveIntensity: 1.35 },
    plate: { color: '#14181d', roughness: 0.5 }
  }
};

const CAMERA = { format: 'own-cam@1', position: [2.5, 1.65, 3.1], target: [0, 0.72, 0], up: [0, 1, 0], fovY: 34 };

const LIGHTS = {
  format: 'own-light@1',
  ambient: { color: '#8a93a3', intensity: 0.5 },
  lights: [
    { dir: [-0.55, -1.0, -0.4], color: '#fff1de', intensity: 1.0 },
    { dir: [0.7, -0.35, 0.65], color: '#cfe2ff', intensity: 0.55 }
  ]
};

// 自制 LOGO 纹理（SVG）
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="112" viewBox="0 0 256 112">
<rect width="256" height="112" rx="14" fill="#10141a"/>
<text x="128" y="52" font-family="DejaVu Sans, Arial" font-size="34" fill="#3fd2e6" text-anchor="middle" letter-spacing="6">AURORA</text>
<text x="128" y="86" font-family="DejaVu Sans, Arial" font-size="16" fill="#8d97a5" text-anchor="middle" letter-spacing="3">SOUND LAB</text>
</svg>`;

module.exports = { buildSpeakerModel, MATERIALS, CAMERA, LIGHTS, LOGO_SVG };
