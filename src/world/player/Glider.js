// Player track — paraglider (BotW-style compact wing): arched cellular canopy (upper + lower skins,
// scalloped cells, colour-blocked panels), riser lines to the control bar in the explorer's hands,
// deploy/stow animation with elastic overshoot, trailing-edge flutter (vertex shader) and a
// backlit-fabric translucency term so the wing glows when the sun is behind it.
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';
import { clamp, easeOutBack } from './util.js';

const SPAN = 3.3, CHORD = 1.0, ARC = 0.8, CELLS = 11;

function buildCanopy(P, lod) {
  const ns = Math.round(44 * lod), nc = Math.round(12 * lod);
  const pos = [], nor = [], col = [], uv = [], idx = [];
  const Rarc = (SPAN / 2) / Math.sin(ARC);
  const c = new THREE.Color();
  const surf = (s, t, upper, out) => {
    const th = s * ARC;
    const chord = CHORD * (1 - 0.38 * s * s);
    const sweep = -0.12 * s * s;
    // airfoil (NACA-ish) thickness, scalloped cells on the lower skin & leading edge
    const cellT = 0.5 - 0.5 * Math.cos(s * CELLS * Math.PI);
    const thick = 0.13 * chord * (1 - 0.22 * cellT * (upper ? 0.35 : 1)) * (2.4 * Math.sqrt(Math.max(t, 0)) * (1 - t) + 0.02);
    const camber = 0.06 * chord * Math.sin(Math.PI * t);
    const z = chord * (0.42 - t) + sweep;
    const rr = Rarc + camber + (upper ? thick * 0.55 : -thick * 0.45);
    out.set(Math.sin(th) * rr, Math.cos(th) * rr - Rarc, z);
    return out;
  };
  const p = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3();
  for (const upper of [true, false]) {
    const base = pos.length / 3;
    for (let j = 0; j <= nc; j++) for (let i = 0; i <= ns; i++) {
      const s = -1 + 2 * i / ns, t = j / nc;
      surf(s, t, upper, p);
      surf(s + 1e-3, t, upper, a).sub(p); surf(s, Math.min(1, t + 1e-3), upper, b).sub(p);
      if (t >= 1) surf(s, t - 1e-3, upper, b).sub(p).negate();
      n.crossVectors(a, b).normalize();
      // upper skin normals point away from the arc center (up), lower skin toward it
      const cx = p.x, cy = p.y + Rarc;
      const outward = n.x * cx + n.y * cy > 0;
      if (upper !== outward) n.negate();
      pos.push(p.x, p.y, p.z); nor.push(n.x, n.y, n.z);
      // colour blocking: leading-edge band in accent, alternating cell panels, scarf-coloured wingtips
      const cell = Math.floor((s + 1) * 0.5 * CELLS);
      const tip = Math.abs(s) > 0.8;
      if (tip) c.copy(P.scarf);
      else if (t < 0.16) c.copy(P.dark).lerp(P.accent, 0.35);
      else if (cell === Math.floor(CELLS / 2)) c.copy(P.shell);
      else if (cell % 3 === 0) c.copy(P.accent);
      else if (cell % 3 === 1) c.copy(P.shell).lerp(P.accent, 0.15);
      else c.copy(P.scarf2).lerp(P.shell, 0.35);
      if (t > 0.86) c.lerp(P.dark, 0.25); // trailing-edge band
      if (!upper) c.multiplyScalar(0.82);
      // rib seams
      const rib = 1 - 0.12 * Math.pow(Math.abs(Math.cos(s * CELLS * Math.PI * 0.5)), 24);
      c.multiplyScalar(rib);
      col.push(c.r, c.g, c.b);
      uv.push((s + 1) / 2, t);
    }
    const W = ns + 1;
    for (let j = 0; j < nc; j++) for (let i = 0; i < ns; i++) {
      const q = base + j * W + i, r = q + 1, s2 = q + W, u = s2 + 1;
      if (upper) idx.push(q, r, s2, r, u, s2); else idx.push(q, s2, r, r, s2, u);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeBoundingSphere();
  // attachment points on the lower skin (for lines)
  const attach = [];
  for (const s of [-0.9, -0.62, -0.32, 0.32, 0.62, 0.9]) for (const t of [0.15, 0.55]) attach.push(surf(s, t, false, new THREE.Vector3()));
  return { geo: g, attach };
}

export class Glider {
  constructor(palette, quality) {
    const lod = quality?.tier === 'low' ? 0.6 : 1;
    this.group = new THREE.Group();
    this.group.name = 'glider';
    this.canopyHeight = 0.62; // canopy center above the bar
    const { geo, attach } = buildCanopy(palette, lod);
    this.attach = attach;
    const hi = quality?.tier !== 'low';
    this.material = new (hi ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial)({ vertexColors: true, roughness: 0.72, side: THREE.DoubleSide });
    if (hi) { this.material.sheen = 0.5; this.material.sheenRoughness = 0.5; this.material.sheenColor = new THREE.Color(0.9, 0.9, 0.9); }
    this.uniforms = { uFlutter: { value: 0 }, uGT: { value: 0 } };
    const U = this.uniforms;
    this.material.onBeforeCompile = (sh) => {
      sh.uniforms.uFlutter = U.uFlutter; sh.uniforms.uGT = U.uGT;
      sh.uniforms.uSunDirW = G.uSunDir; sh.uniforms.uSunColW = G.uSunColor;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uFlutter; uniform float uGT;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float te = clamp(-position.z / ${CHORD.toFixed(2)} + 0.42, 0.0, 1.0);
          float fl = sin(position.x * 7.0 + uGT * 23.0) * 0.6 + sin(position.x * 13.0 - uGT * 31.0) * 0.4;
          transformed += normal * fl * uFlutter * te * te * 0.035;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform vec3 uSunDirW; uniform vec3 uSunColW;')
        .replace('#include <opaque_fragment>', `
          {
            vec3 Lv = normalize((viewMatrix * vec4(uSunDirW, 0.0)).xyz);
            float back = max(0.0, -dot(normal, Lv));
            outgoingLight += diffuseColor.rgb * uSunColW * back * 0.32;
          }
          #include <opaque_fragment>`);
    };
    this.material.customProgramCacheKey = () => 'rv-glider';
    this.canopy = new THREE.Mesh(geo, this.material);
    this.canopy.castShadow = true; this.canopy.receiveShadow = false;
    this.canopy.frustumCulled = false;
    this.canopy.position.y = this.canopyHeight;
    this.group.add(this.canopy);
    // control bar
    const barMat = new THREE.MeshStandardMaterial({ color: palette.dark, roughness: 0.35, metalness: 0.8 });
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.56, 8), barMat);
    bar.rotation.z = Math.PI / 2;
    bar.castShadow = true;
    this.bar = bar; this.barMat = barMat;
    this.group.add(bar);
    // lines: from canopy attachment points to bar ends
    const lg = new THREE.BufferGeometry();
    this.linePos = new Float32Array(attach.length * 2 * 3);
    lg.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3));
    this.lineMat = new THREE.LineBasicMaterial({ color: 0x8a8680, transparent: true, opacity: 0.45 });
    this.lines = new THREE.LineSegments(lg, this.lineMat);
    this.lines.frustumCulled = false;
    this.group.add(this.lines);
    this.deploy = 0;
    this.open = false;
    this.group.visible = false;
    this.t = 0;
  }

  /** @param openTarget boolean; airspeed m/s; dt */
  update(dt, openTarget, airspeed) {
    this.open = openTarget;
    const rate = openTarget ? 3.2 : 5.5;
    this.deploy = clamp(this.deploy + (openTarget ? 1 : -1) * rate * dt, 0, 1);
    this.t += dt;
    this.group.visible = this.deploy > 0.001;
    if (!this.group.visible) return;
    const d = openTarget ? easeOutBack(this.deploy) : this.deploy * this.deploy;
    const sx = Math.max(0.05, d), sy = Math.max(0.05, 0.4 + 0.6 * d);
    this.canopy.scale.set(sx, sy, Math.max(0.1, 0.5 + 0.5 * d));
    this.canopy.position.y = this.canopyHeight * (0.35 + 0.65 * d);
    this.canopy.rotation.x = (1 - d) * 0.6;
    this.uniforms.uFlutter.value = clamp(airspeed / 14, 0.15, 1.5) * d;
    this.uniforms.uGT.value = this.t;
    // lines
    const L = this.linePos;
    const c = this.canopy;
    for (let i = 0; i < this.attach.length; i++) {
      const a = this.attach[i];
      const x = a.x * c.scale.x, y = a.y * c.scale.y + c.position.y, z = a.z * c.scale.z;
      const o = i * 6;
      L[o] = x; L[o + 1] = y; L[o + 2] = z;
      L[o + 3] = a.x < 0 ? -0.26 : 0.26; L[o + 4] = 0; L[o + 5] = 0;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lineMat.opacity = 0.45 * d;
    this.bar.scale.set(1, Math.max(0.05, d), 1);
  }

  dispose() {
    this.canopy.geometry.dispose(); this.material.dispose();
    this.bar.geometry.dispose(); this.barMat.dispose();
    this.lines.geometry.dispose(); this.lineMat.dispose();
  }
}
