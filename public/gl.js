'use strict';
// 浏览器三维预览：从场景清单解析出的同一份资产（模型/材质/相机/灯光/纹理）重建场景。
// 与服务端渲染器使用相同的相机投影与 Lambert 光照公式；截图对比用于验证一致性。
window.GL = (() => {
  const VS = `
attribute vec3 aPos; attribute vec3 aNrm; attribute vec2 aUv;
uniform mat4 uProj, uView, uModel;
varying vec3 vNrm; varying vec2 vUv;
void main(){ vec4 w = uModel * vec4(aPos,1.0); vNrm = mat3(uModel)*aNrm; vUv = aUv;
  gl_Position = uProj * uView * w; }`;
  const FS = `
precision mediump float;
varying vec3 vNrm; varying vec2 vUv;
uniform vec3 uAlbedo, uEmissive, uAmbColor; uniform float uEmissiveK, uAmbK;
uniform vec3 uL0Dir, uL0Color, uL1Dir, uL1Color;
uniform sampler2D uTex; uniform float uUseTex, uTexMissing;
void main(){
  vec3 n = normalize(vNrm);
  vec3 c = uAlbedo * uAmbColor * uAmbK;
  c += uAlbedo * uL0Color * max(0.0, dot(n, normalize(-uL0Dir)));
  c += uAlbedo * uL1Color * max(0.0, dot(n, normalize(-uL1Dir)));
  c += uEmissive * uEmissiveK;
  if (uTexMissing > 0.5) { c = vec3(1.0, 0.0, 1.0); }        // 缺纹理：显式品红警示，绝不静默
  else if (uUseTex > 0.5) { c = texture2D(uTex, vUv).rgb + uEmissive * uEmissiveK; }
  gl_FragColor = vec4(c, 1.0);
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  // 与服务端一致的矩阵数学
  const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  const dot = (a, b) => a[0]*b[0]+a[1]*b[1]+a[2]*b[2];
  const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map(v => v / l); };
  function lookAt(eye, target, up) {
    const f = norm(sub3(target, eye)), r = norm(cross(f, up)), u = cross(r, f);
    return [r[0],u[0],-f[0],0, r[1],u[1],-f[1],0, r[2],u[2],-f[2],0,
      -dot(r,eye), -dot(u,eye), dot(f,eye), 1];
  }
  function perspective(fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY * Math.PI / 360), nf = 1 / (near - far);
    return [f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0];
  }
  function rotY(a) { const c=Math.cos(a), s=Math.sin(a); return [c,0,-s,0, 0,1,0,0, s,0,c,0, 0,0,0,1]; }
  function hex(h){ return [parseInt(h.slice(1,3),16)/255, parseInt(h.slice(3,5),16)/255, parseInt(h.slice(5,7),16)/255]; }

  function create(canvas, resolved) {
    const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true });
    if (!gl) return { error: 'WebGL 不可用' };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog); gl.useProgram(prog);
    const U = {}; ['uProj','uView','uModel','uAlbedo','uEmissive','uEmissiveK','uAmbColor','uAmbK','uL0Dir','uL0Color','uL1Dir','uL1Color','uTex','uUseTex','uTexMissing']
      .forEach(n => U[n] = gl.getUniformLocation(prog, n));
    const A = { pos: gl.getAttribLocation(prog, 'aPos'), nrm: gl.getAttribLocation(prog, 'aNrm'), uv: gl.getAttribLocation(prog, 'aUv') };

    const mats = resolved.materials.materials;
    const missingTexSlots = new Set(resolved.missingTextures || []);
    const parts = resolved.model.parts.map(part => {
      const buf = (data, attr, size) => {
        const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
        return { b, attr, size };
      };
      const ib = gl.createBuffer(); gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(part.indices), gl.STATIC_DRAW);
      let tex = null, texMissing = false;
      if (part.textureSlot) {
        if (missingTexSlots.includes(part.textureSlot)) texMissing = true;
        else if (resolved.textureBlobs && resolved.textureBlobs[part.textureSlot]) {
          tex = gl.createTexture();
          const img = new Image();
          img.onload = () => {
            gl.bindTexture(gl.TEXTURE_2D, tex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          };
          img.src = resolved.textureBlobs[part.textureSlot];
        }
      }
      return {
        pos: buf(part.positions, A.pos, 3), nrm: buf(part.normals, A.nrm, 3),
        uv: buf(part.uvs || part.positions.map(() => 0), A.uv, 2),
        ib, count: part.indices.length, mat: mats[part.material] || { color: '#888888' },
        tex, texMissing
      };
    });

    const cam = resolved.camera, lights = resolved.lights;
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE);
    function render(t, motion) {
      const w = canvas.width = canvas.clientWidth * devicePixelRatio;
      const h = canvas.height = canvas.clientHeight * devicePixelRatio;
      gl.viewport(0, 0, w, h);
      const grad = [0.11, 0.14, 0.20];
      gl.clearColor(grad[0], grad[1], grad[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.uniformMatrix4fv(U.uProj, false, perspective(cam.fovY, w / h, 0.05, 100));
      gl.uniformMatrix4fv(U.uView, false, lookAt(cam.position, cam.target, cam.up));
      const rpm = (motion && motion.rpm) || 0;
      gl.uniformMatrix4fv(U.uModel, false, rotY(rpm * Math.PI * 2 * t / 60));
      const amb = lights.ambient, L0 = lights.lights[0], L1 = lights.lights[1] || L0;
      gl.uniform3fv(U.uAmbColor, hex(amb.color)); gl.uniform1f(U.uAmbK, amb.intensity);
      gl.uniform3fv(U.uL0Dir, L0.dir); gl.uniform3fv(U.uL0Color, hex(L0.color).map(v => v * L0.intensity));
      gl.uniform3fv(U.uL1Dir, L1.dir); gl.uniform3fv(U.uL1Color, hex(L1.color).map(v => v * L1.intensity));
      for (const p of parts) {
        for (const b of [p.pos, p.nrm, p.uv]) {
          gl.bindBuffer(gl.ARRAY_BUFFER, b.b);
          gl.enableVertexAttribArray(b.attr);
          gl.vertexAttribPointer(b.attr, b.size, gl.FLOAT, false, 0, 0);
        }
        gl.uniform3fv(U.uAlbedo, hex(p.mat.color));
        gl.uniform3fv(U.uEmissive, p.mat.emissive ? hex(p.mat.emissive) : [0, 0, 0]);
        gl.uniform1f(U.uEmissiveK, p.mat.emissiveIntensity || 0);
        gl.uniform1f(U.uTexMissing, p.texMissing ? 1 : 0);
        if (p.tex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, p.tex); gl.uniform1i(U.uTex, 0); gl.uniform1f(U.uUseTex, 1); }
        else gl.uniform1f(U.uUseTex, 0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, p.ib);
        gl.drawElements(gl.TRIANGLES, p.count, gl.UNSIGNED_SHORT, 0);
      }
    }
    return { render };
  }
  return { create };
})();
