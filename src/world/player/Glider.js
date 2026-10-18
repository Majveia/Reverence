// Player track — paraglider (BotW-style compact ram-air wing).
//
// Canopy: a real airfoil wing — CELLS ribbed cells, each an inflated tube between two ribs (upper skin
// bulges between ribs, lower skin is flatter), NACA-like thickness with camber, elliptical planform with
// sweep, rounded closed tips. Upper + lower skins, analytic normals.
// Look: crisp colour blocking computed per pixel from (span, chord) coordinates (hard-edged, anti-aliased
// with fwidth — never blurry vertex colours), rib seams + chordwise stitching, reinforced leading-edge tape,
// centre emblem, fabric sheen, and a back-lit translucency term (sun through the cloth; ribs and tapes are
// thicker so they read as dark lines in the glow).
// Motion (vertex shader): low-frequency billow along the span scaled by airspeed, trailing-edge flutter,
// trailing-edge brake on the inside of a banked turn.
// Lines: cascaded suspension lines (A/B/C rows → junctions → risers at the hands) drawn as screen-space
// ribbons of constant ~1–1.5 px width with a slight sag, depth tested, anti-aliased.
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';
import { clamp, easeOutBack } from './util.js';

const SPAN = 3.7, CHORD = 1.08, ARC = 0.8, CELLS = 13;
const RARC = (SPAN / 2) / Math.sin(ARC);

/** NACA 4-digit half-thickness (14 %) at chord fraction t. */
const naca = (t) => 0.7 * (0.2969 * Math.sqrt(t) - 0.126 * t - 0.3516 * t * t + 0.2843 * t * t * t - 0.1036 * t * t * t * t);
const chordAt = (s) => CHORD * (1 - 0.3 * s * s - 0.22 * Math.pow(Math.abs(s), 8));

/** Canopy-space point on a skin. s ∈ [-1, 1] span, t ∈ [0, 1] chord (0 = leading edge). */
function surf(s, t, upper, out) {
  const as = Math.abs(s);
  const th = s * ARC;
  const chord = chordAt(s);
  const sweep = -0.13 * s * s;
  const cf = ((s + 1) * 0.5 * CELLS) % 1;
  const bul = Math.sin(Math.PI * cf);                // 0 on the ribs, 1 mid-cell
  const tipF = 1 - 0.9 * Math.pow(as, 7);            // skins close toward the tips
  const yt = naca(Math.min(1, Math.max(0, t))) * chord * tipF;
  const camber = 0.055 * chord * 4 * t * (1 - t);
  const inflate = upper ? yt * (0.86 + 0.3 * bul) + 0.012 * chord * bul * Math.sin(Math.PI * t) : -yt * (0.62 + 0.12 * bul);
  const z = chord * (0.4 - t) + sweep;
  const rr = RARC + camber + inflate;
  return out.set(Math.sin(th) * rr, Math.cos(th) * rr - RARC, z);
}

function buildCanopy(lod) {
  const per = lod < 0.8 ? 4 : 6;
  const ns = CELLS * per, nc = Math.round(18 * lod);
  const pos = [], nor = [], st = [], idx = [];
  const p = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3(), n = new THREE.Vector3(), q = new THREE.Vector3();
  const e = 1e-3;
  for (const upper of [true, false]) {
    const base = pos.length / 3;
    for (let j = 0; j <= nc; j++) for (let i = 0; i <= ns; i++) {
      const s = -1 + 2 * i / ns;
      const t = 0.5 - 0.5 * Math.cos(Math.PI * j / nc); // cosine spacing: dense at the leading edge
      surf(s, t, upper, p);
      // centred differences (averages across the rib crease → soft seam, crisp cell shading)
      surf(Math.min(1, s + e), t, upper, a); surf(Math.max(-1, s - e), t, upper, q); a.sub(q);
      const t0 = Math.max(0.0005, t - e), t1 = Math.min(1, t + e);
      surf(s, t1, upper, b); surf(s, t0, upper, q); b.sub(q);
      n.crossVectors(a, b).normalize();
      const cx = p.x, cy = p.y + RARC;
      const outward = n.x * cx + n.y * cy > 0;
      if (upper !== outward) n.negate();
      if (!Number.isFinite(n.x)) n.set(0, upper ? 1 : -1, 0);
      pos.push(p.x, p.y, p.z); nor.push(n.x, n.y, n.z);
      st.push(s, t, upper ? 1 : 0);
    }
    const W = ns + 1;
    for (let j = 0; j < nc; j++) for (let i = 0; i < ns; i++) {
      const v0 = base + j * W + i, v1 = v0 + 1, v2 = v0 + W, v3 = v2 + 1;
      if (upper) idx.push(v0, v1, v2, v1, v3, v2); else idx.push(v0, v2, v1, v1, v2, v3);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('aST', new THREE.Float32BufferAttribute(st, 3));
  g.setIndex(idx);
  g.computeBoundingSphere();
  return g;
}

// line cascade: per side, rows A/B/C (chord t), four attachment ribs → two junctions → riser at the hand
const ROWS = [0.1, 0.42, 0.78];
const ATT_S = [0.12, 0.36, 0.6, 0.84];

// ------------------------------------------------------------------ shaders
const CANOPY_VERT_HEAD = /* glsl */`
attribute vec3 aST; varying vec3 vST;
uniform float uFlutter; uniform float uGT; uniform float uBillow; uniform float uBrake;`;
const CANOPY_VERT = /* glsl */`
vST = aST;
{
  float s = aST.x, t = aST.y, te = t * t;
  float fl = sin(s * 9.0 + uGT * 23.0) * 0.6 + sin(s * 17.0 - uGT * 31.0) * 0.4;
  transformed += normal * fl * uFlutter * te * 0.028;
  float bw = sin(s * 3.3 + uGT * 2.1) * 0.6 + sin(s * 1.7 - uGT * 1.3) * 0.4;
  transformed.y += bw * uBillow * 0.04 * (0.35 + 0.65 * t);
  transformed.y -= clamp(s * uBrake, 0.0, 1.0) * te * 0.26;
}`;
const CANOPY_FRAG_HEAD = /* glsl */`
varying vec3 vST;
uniform vec3 uCBase; uniform vec3 uCAcc; uniform vec3 uCTip; uniform vec3 uCPin; uniform vec3 uCDark;
uniform vec3 uSunDirW; uniform vec3 uSunColW; uniform float uTrans;
float rvBand(float x, float a, float b) { float w = max(fwidth(x), 1e-4) * 0.8; return smoothstep(a - w, a + w, x) - smoothstep(b - w, b + w, x); }`;
const CANOPY_COLOR = /* glsl */`
float gS = vST.x, gT = vST.y, gAs = abs(vST.x);
vec3 gc = uCBase;
gc = mix(gc, uCAcc, rvBand(gAs, 0.43, 0.6));
gc = mix(gc, uCPin, rvBand(gAs, 0.635, 0.665));
gc = mix(gc, uCTip, rvBand(gAs, 0.7, 2.0));
// chevron flash across the accent band toward the trailing edge
gc = mix(gc, uCPin, rvBand(gAs + gT * 0.22, 0.98, 1.01) * step(gAs, 0.7));
// centre emblem: ring + dot
{
  vec2 em = vec2(gS * ${(SPAN * 0.5).toFixed(3)}, (gT - 0.46) * ${CHORD.toFixed(3)});
  float r = length(em);
  gc = mix(gc, uCDark, max(rvBand(r, 0.115, 0.145), rvBand(r, -1.0, 0.045)) * 0.92);
}
// reinforced leading-edge tape and trailing-edge hem
float gTape = rvBand(gT, -1.0, 0.055);
float gHem = rvBand(gT, 0.955, 2.0);
gc = mix(gc, uCDark, gTape * 0.85);
gc = mix(gc, uCDark * 1.6 + 0.02, gHem * 0.55);
// rib seams + chordwise stitching
float gCs = (gS + 1.0) * 0.5 * ${CELLS.toFixed(1)};
float gFr = abs(fract(gCs + 0.5) - 0.5);
float gSeam = 1.0 - smoothstep(0.0, max(fwidth(gCs) * 1.1, 0.035), gFr);
float gStitch = max(rvBand(gT, 0.325, 0.335), rvBand(gT, 0.655, 0.665));
gc *= 1.0 - 0.3 * gSeam - 0.12 * gStitch;
if (vST.z < 0.5) gc *= vec3(0.74, 0.74, 0.78);
diffuseColor.rgb *= gc;`;
const CANOPY_LIGHT = /* glsl */`
{
  // back-lit translucency: sun through the cloth (seen from the shaded side), strongest looking into the sun
  vec3 Lv = normalize((viewMatrix * vec4(uSunDirW, 0.0)).xyz);
  vec3 Vv = normalize(vViewPosition);
  float shaded = clamp(-dot(normal, Lv), 0.0, 1.0);
  float into = pow(clamp(dot(-Vv, Lv), 0.0, 1.0), 2.0);
  float thin = 1.0 - 0.65 * gSeam - 0.8 * gTape - 0.5 * gHem;
  outgoingLight += diffuseColor.rgb * uSunColW * shaded * (0.16 + 0.55 * into) * thin * uTrans;
}`;

const LINE_VERT = /* glsl */`
attribute vec3 aOther; attribute float aSide;
uniform float uResY; uniform float uAspect; uniform float uRadius;
varying float vEdge; varying float vHW; varying float vA;
void main() {
  vec4 pa = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec4 pb = projectionMatrix * modelViewMatrix * vec4(aOther, 1.0);
  float wa = max(pa.w, 1e-3), wb = max(pb.w, 1e-3);
  vec2 d = (pb.xy / wb - pa.xy / wa) * vec2(uAspect, 1.0);
  float dl = length(d);
  d = dl > 1e-6 ? d / dl : vec2(1.0, 0.0);
  vec2 nn = vec2(-d.y, d.x); nn.x /= uAspect;
  float realPx = uRadius * 2.0 * projectionMatrix[1][1] * uResY * 0.5 / wa;
  float hw = max(realPx, 1.0) * 0.5;
  vHW = hw; vA = clamp(realPx, 0.35, 1.0);
  float ext = hw + 0.75;
  vEdge = aSide * ext;
  pa.xy += nn * aSide * ext * 2.0 / uResY * wa;
  gl_Position = pa;
}`;
const LINE_FRAG = /* glsl */`
uniform vec3 uColor; uniform float uOpacity;
varying float vEdge; varying float vHW; varying float vA;
void main() {
  float a = clamp(vHW + 0.5 - abs(vEdge), 0.0, 1.0) * vA * uOpacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

export class Glider {
  constructor(palette, quality) {
    const lod = quality?.tier === 'low' ? 0.6 : 1;
    const P = palette;
    this.group = new THREE.Group();
    this.group.name = 'glider';
    this.canopyHeight = 0.98; // canopy centre above the bar
    const geo = buildCanopy(lod);
    const hi = quality?.tier !== 'low';
    this.material = new (hi ? THREE.MeshPhysicalMaterial : THREE.MeshStandardMaterial)({ color: 0xffffff, roughness: 0.74, side: THREE.DoubleSide });
    if (hi) { this.material.sheen = 0.45; this.material.sheenRoughness = 0.5; this.material.sheenColor = new THREE.Color(0.42, 0.42, 0.45); }
    const col = (c) => new THREE.Color(c);
    this.uniforms = {
      uFlutter: { value: 0 }, uGT: { value: 0 }, uBillow: { value: 0 }, uBrake: { value: 0 }, uTrans: { value: 1 },
      uCBase: { value: col(P.shell).multiplyScalar(0.8) },
      uCAcc: { value: col(P.accent) },
      uCTip: { value: col(P.scarf) },
      uCPin: { value: col(P.scarf2) },
      uCDark: { value: col(P.dark) },
    };
    const U = this.uniforms;
    this.material.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, U);
      sh.uniforms.uSunDirW = G.uSunDir; sh.uniforms.uSunColW = G.uSunColor;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\n' + CANOPY_VERT_HEAD)
        .replace('#include <begin_vertex>', '#include <begin_vertex>\n' + CANOPY_VERT);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\n' + CANOPY_FRAG_HEAD)
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + CANOPY_COLOR)
        .replace('#include <opaque_fragment>', CANOPY_LIGHT + '\n#include <opaque_fragment>');
    };
    this.material.customProgramCacheKey = () => 'rv-glider2';
    this.canopy = new THREE.Mesh(geo, this.material);
    this.canopy.castShadow = true; this.canopy.receiveShadow = false;
    this.canopy.frustumCulled = false;
    this.canopy.position.y = this.canopyHeight;
    this.group.add(this.canopy);
    // control bar
    const barMat = new THREE.MeshStandardMaterial({ color: P.dark, roughness: 0.35, metalness: 0.8 });
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.56, 8), barMat);
    bar.rotation.z = Math.PI / 2;
    bar.castShadow = true;
    this.bar = bar; this.barMat = barMat;
    this.group.add(bar);
    // ---- suspension lines (cascade)
    const segs = [];
    this.attach = [];   // { s, t, base: Vector3 (undeformed canopy space) }
    this.junction = []; // group space, recomputed per frame
    this.jSide = [];
    for (const side of [1, -1]) {
      for (let r = 0; r < ROWS.length; r++) {
        const j0 = this.junction.length;
        this.junction.push(new THREE.Vector3(), new THREE.Vector3());
        this.jSide.push(side, side);
        for (let k = 0; k < ATT_S.length; k++) {
          const s = side * ATT_S[k], t = ROWS[r];
          const ai = this.attach.length;
          this.attach.push({ s, t, base: surf(s, t, false, new THREE.Vector3()), w: new THREE.Vector3(), row: r, side });
          segs.push(['a', ai, 'j', j0 + (k >> 1)]);
        }
        segs.push(['j', j0, 'r', side], ['j', j0 + 1, 'r', side]);
      }
    }
    this.segs = segs;
    const nSeg = segs.length;
    const lpos = new Float32Array(nSeg * 4 * 3), loth = new Float32Array(nSeg * 4 * 3), lside = new Float32Array(nSeg * 4);
    const lidx = [];
    for (let i = 0; i < nSeg; i++) {
      lside.set([-1, 1, 1, -1], i * 4); // the far end sees the segment reversed
      const b = i * 4;
      lidx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    }
    const lg = new THREE.BufferGeometry();
    lg.setAttribute('position', new THREE.BufferAttribute(lpos, 3));
    lg.setAttribute('aOther', new THREE.BufferAttribute(loth, 3));
    lg.setAttribute('aSide', new THREE.BufferAttribute(lside, 1));
    lg.setIndex(lidx);
    this.linePos = lpos; this.lineOther = loth;
    this.lineMat = new THREE.ShaderMaterial({
      uniforms: {
        uResY: { value: 720 }, uAspect: { value: 16 / 9 }, uRadius: { value: 0.0032 },
        uColor: { value: new THREE.Color(P.dark).lerp(new THREE.Color(0.55, 0.55, 0.58), 0.35) }, uOpacity: { value: 0.85 },
      },
      vertexShader: LINE_VERT, fragmentShader: LINE_FRAG, transparent: true, depthWrite: true, side: THREE.DoubleSide, // depth: post aerial perspective must see the line, not the ground far below
    });
    this.lines = new THREE.Mesh(lg, this.lineMat);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 2;
    this.group.add(this.lines);
    this.deploy = 0;
    this.open = false;
    this.group.visible = false;
    this.t = 0;
    this._riser = [new THREE.Vector3(0.25, 0.04, 0), new THREE.Vector3(-0.25, 0.04, 0)];
  }

  /** Screen size for the screen-space line ribbons (call on resize / each frame, cheap). */
  setViewport(h, aspect) { this.lineMat.uniforms.uResY.value = h; this.lineMat.uniforms.uAspect.value = aspect; }

  /** Wingtip trailing point in glider-group space (s = ±1). */
  tip(s, out) {
    surf(s * 0.985, 0.9, true, out);
    const c = this.canopy;
    return out.set(out.x * c.scale.x, out.y * c.scale.y + c.position.y, out.z * c.scale.z);
  }

  /** @param openTarget boolean; airspeed m/s; bank (rad, + = right); dt */
  update(dt, openTarget, airspeed, bank = 0) {
    this.open = openTarget;
    const rate = openTarget ? 3.2 : 5.5;
    this.deploy = clamp(this.deploy + (openTarget ? 1 : -1) * rate * dt, 0, 1);
    this.t += dt;
    this.group.visible = this.deploy > 0.001;
    if (!this.group.visible) return;
    const d = openTarget ? easeOutBack(this.deploy) : this.deploy * this.deploy;
    const sx = Math.max(0.05, d), sy = Math.max(0.05, 0.4 + 0.6 * d);
    const c = this.canopy;
    c.scale.set(sx, sy, Math.max(0.1, 0.5 + 0.5 * d));
    c.position.y = this.canopyHeight * (0.35 + 0.65 * d);
    c.rotation.x = (1 - d) * 0.6;
    const U = this.uniforms;
    U.uFlutter.value = clamp(airspeed / 14, 0.15, 1.5) * d;
    U.uBillow.value = clamp(0.35 + airspeed / 18, 0.35, 1.6) * d;
    U.uBrake.value = clamp(bank * 1.6, -1, 1) * d;
    U.uGT.value = this.t;
    // ---- lines: deformed attachment points (same billow / brake as the vertex shader)
    c.updateMatrix();
    const gt = this.t, bil = U.uBillow.value, brk = U.uBrake.value;
    const jn = this.junction;
    for (const v of jn) v.set(0, 0, 0);
    for (let i = 0; i < this.attach.length; i++) {
      const A = this.attach[i];
      const w = A.w.copy(A.base);
      const bw = Math.sin(A.s * 3.3 + gt * 2.1) * 0.6 + Math.sin(A.s * 1.7 - gt * 1.3) * 0.4;
      w.y += bw * bil * 0.04 * (0.35 + 0.65 * A.t) - clamp(A.s * brk, 0, 1) * A.t * A.t * 0.26;
      w.applyMatrix4(c.matrix);
    }
    // junctions: 55 % of the way from the riser toward the mean of their two attachment points
    for (let si = 0; si < this.segs.length; si++) {
      const sg = this.segs[si];
      if (sg[0] === 'a') jn[sg[3]].addScaledVector(this.attach[sg[1]].w, 0.5);
    }
    for (let k = 0; k < jn.length; k++) jn[k].lerp(this._riser[this.jSide[k] > 0 ? 0 : 1], 0.45);
    const L = this.linePos, O = this.lineOther;
    for (let si = 0; si < this.segs.length; si++) {
      const sg = this.segs[si];
      const p0 = sg[0] === 'a' ? this.attach[sg[1]].w : jn[sg[1]];
      const p1 = sg[2] === 'j' ? jn[sg[3]] : this._riser[sg[3] > 0 ? 0 : 1];
      const o = si * 12;
      L[o] = p0.x; L[o + 1] = p0.y; L[o + 2] = p0.z; L[o + 3] = p0.x; L[o + 4] = p0.y; L[o + 5] = p0.z;
      L[o + 6] = p1.x; L[o + 7] = p1.y; L[o + 8] = p1.z; L[o + 9] = p1.x; L[o + 10] = p1.y; L[o + 11] = p1.z;
      O[o] = p1.x; O[o + 1] = p1.y; O[o + 2] = p1.z; O[o + 3] = p1.x; O[o + 4] = p1.y; O[o + 5] = p1.z;
      O[o + 6] = p0.x; O[o + 7] = p0.y; O[o + 8] = p0.z; O[o + 9] = p0.x; O[o + 10] = p0.y; O[o + 11] = p0.z;
    }
    this.lines.geometry.attributes.position.needsUpdate = true;
    this.lines.geometry.attributes.aOther.needsUpdate = true;
    this.lineMat.uniforms.uOpacity.value = 0.8 * clamp((d - 0.3) / 0.6, 0, 1);
    this.bar.scale.set(1, Math.max(0.05, d), 1);
  }

  dispose() {
    this.canopy.geometry.dispose(); this.material.dispose();
    this.bar.geometry.dispose(); this.barMat.dispose();
    this.lines.geometry.dispose(); this.lineMat.dispose();
  }
}
