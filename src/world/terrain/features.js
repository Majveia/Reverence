// Landmark features that a heightfield cannot hold. OWNED BY THE TERRAIN TRACK.
//
//  • Floating isles at the 'floating' sacred site: grassy tops, tapering rock undersides with strata ledges,
//    hanging roots and stalactites, a slow bob. They recede in a line from the spawn, so each further one
//    reads paler in the atmosphere's aerial perspective (the creator's "land that floats free").
//  • A natural rock arch at the 'arch' sacred site, opening toward the great mountain (rule 11: wonders are
//    framed by an arch). Legs buried into the terrain, strata ledges, moss on up-facing rock.
//
// Geometry is generated once on the main thread (deterministic from the landmark seeds, a few ms), one
// draw call per object, shared rock material (MeshStandard / Lambert on software GL) with world-anchored
// triplanar detail from the terrain's baked detail texture. Colliders: walkable boxes on the isle tops,
// boxes on the arch legs and lintel.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { SNoise } from '../planet/noise.js';

const _v = new THREE.Vector3(), _q = new THREE.Quaternion(), _m = new THREE.Matrix4();

function rngf(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}
function sstep(a, b, x) { const t = Math.max(0, Math.min(1, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

/** Season ramp colour (linear) — the same palette as the terrain shader's season regions. */
export function seasonColor(s, out = new THREE.Color()) {
  const P = [[0.08, 0.19, 0.032], [0.55, 0.3, 0.36], [0.46, 0.32, 0.09], [0.36, 0.13, 0.045]];
  const q = Math.max(0, Math.min(0.9999, s)) * 3, i = Math.floor(q), f = sstep(0, 1, q - i);
  const a = P[i], b = P[Math.min(3, i + 1)];
  return out.setRGB(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
}

function rockMaterial(terrainMat, lite) {
  const U = terrainMat?.userData?.uniforms || {};
  const mat = lite ? new THREE.MeshLambertMaterial({ vertexColors: true }) : new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, metalness: 0 });
  mat.name = 'rv-terrain-feature';
  mat.side = THREE.DoubleSide;
  const uniforms = { uRvDetail: U.uRvDetail || { value: null }, uRvOriginMod: U.uRvOriginMod || { value: new THREE.Vector3() } };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vRvFP; varying vec3 vRvFN;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvRvFP = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz; vRvFN = normalize( mat3( modelMatrix ) * objectNormal );');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
precision highp sampler2DArray;
uniform sampler2DArray uRvDetail; uniform vec3 uRvOriginMod;
varying vec3 vRvFP; varying vec3 vRvFN;
vec4 rvFT( vec3 p, vec3 w, float s ) {
  return textureLod( uRvDetail, vec3( p.zy * s, 0.0 ), 0.0 ) * w.x + textureLod( uRvDetail, vec3( p.xz * s + 0.37, 0.0 ), 0.0 ) * w.y + textureLod( uRvDetail, vec3( p.xy * s + 0.71, 0.0 ), 0.0 ) * w.z;
}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
{
  vec3 P = vRvFP + uRvOriginMod; vec3 Nw = normalize( vRvFN );
  vec3 w = pow( abs( Nw ), vec3( 4.0 ) ); w /= dot( w, vec3( 1.0 ) );
  float d = length( vRvFP - cameraPosition );
  // (implicit derivatives: mip-filtered at every distance, no aliasing "mesh" pattern)
  vec4 a = texture( uRvDetail, vec3( P.zy / 48.0, 0.0 ) ) * w.x + texture( uRvDetail, vec3( P.xz / 48.0 + 0.37, 0.0 ) ) * w.y + texture( uRvDetail, vec3( P.xy / 48.0 + 0.71, 0.0 ) ) * w.z;
  vec4 b = texture( uRvDetail, vec3( P.zy / 9.0, 0.0 ) ) * w.x + texture( uRvDetail, vec3( P.xz / 9.0 + 0.37, 0.0 ) ) * w.y + texture( uRvDetail, vec3( P.xy / 9.0 + 0.71, 0.0 ) ) * w.z;
  float fb = 1.0 - smoothstep( 60.0, 400.0, d );
  diffuseColor.rgb *= ( 0.84 + 0.32 * a.a ) * mix( 1.0, 0.86 + 0.28 * b.a, fb ) * ( 0.88 + 0.24 * a.b );
}`);
  };
  mat.customProgramCacheKey = () => 'rv-terrain-feature-v2' + (lite ? 'L' : '');
  return mat;
}

/** Push a lathe-like ring grid into arrays. rows: [{y, r(theta) fn}] → indexed grid (closed in theta). */
function ringGrid(rows, seg, colorFn) {
  const pos = [], col = [], idx = [];
  const c = new THREE.Color();
  for (let j = 0; j < rows.length; j++) {
    for (let i = 0; i <= seg; i++) {
      const th = (i / seg) * Math.PI * 2;
      const p = rows[j](th, i);
      pos.push(p[0], p[1], p[2]);
      colorFn(j, th, p, c);
      col.push(c.r, c.g, c.b);
    }
  }
  const W = seg + 1;
  for (let j = 0; j < rows.length - 1; j++) for (let i = 0; i < seg; i++) {
    const a = j * W + i, b = a + 1, d = a + W, e = d + 1;
    idx.push(a, b, d, b, e, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function coneGeo(r, len, seg, color, bend = [0, 0]) {
  const g = new THREE.ConeGeometry(r, len, seg, 3, true);
  g.rotateX(Math.PI);          // apex down
  g.translate(0, -len / 2, 0); // base at y = 0, tip at y = -len
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const t = Math.max(0, -p.getY(i)) / len; p.setX(i, p.getX(i) + bend[0] * t * t * len); p.setZ(i, p.getZ(i) + bend[1] * t * t * len); }
  g.computeVertexNormals();
  const n = p.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const k = 0.8 + 0.3 * (1 + p.getY(i) / len); col[i * 3] = color.r * k; col[i * 3 + 1] = color.g * k; col[i * 3 + 2] = color.b * k; }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return g;
}

function tubeGeo(points, r0, r1, seg, color) {
  const curve = new THREE.CatmullRomCurve3(points);
  const tub = new THREE.TubeGeometry(curve, Math.max(6, points.length * 4), 1, seg, false);
  // taper: scale each ring around the curve
  const p = tub.attributes.position, N = tub.parameters.tubularSegments, S = seg + 1;
  const frames = curve.computeFrenetFrames(N, false);
  for (let j = 0; j <= N; j++) {
    const t = j / N, rr = r0 + (r1 - r0) * t, c = curve.getPointAt(t);
    for (let i = 0; i < S; i++) {
      const k = j * S + i;
      _v.set(p.getX(k), p.getY(k), p.getZ(k)).sub(c).multiplyScalar(rr).add(c);
      p.setXYZ(k, _v.x, _v.y, _v.z);
    }
  }
  void frames;
  tub.computeVertexNormals();
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { col[i * 3] = color.r; col[i * 3 + 1] = color.g; col[i * 3 + 2] = color.b; }
  tub.setAttribute('color', new THREE.BufferAttribute(col, 3));
  tub.deleteAttribute('uv');
  return tub;
}

function stripUV(g) { if (g.attributes.uv) g.deleteAttribute('uv'); if (g.attributes.uv1) g.deleteAttribute('uv1'); return g.index ? g.toNonIndexed() : g; }

/** One floating isle (local frame: +Y up, top surface near y = 0). */
function buildIsle(o, pal, grassC) {
  const rnd = rngf(o.seed);
  const n = new SNoise(o.seed ^ 0x51a7);
  const r = o.radius, depth = r * (1.5 + rnd() * 0.8);
  const seg = 56;
  const rock = pal.rock.clone(), rockD = pal.rock.clone().multiplyScalar(0.55), soil = pal.soil.clone();
  const edgeR = (th) => r * (1 + 0.16 * n.n3(Math.cos(th) * 1.3, Math.sin(th) * 1.3, 0.5) + 0.06 * n.n3(Math.cos(th) * 4, Math.sin(th) * 4, 2.1));
  const rows = [];
  const topRings = 9;
  for (let j = 0; j <= topRings; j++) {
    const u = j / topRings;
    rows.push((th) => {
      const er = edgeR(th) * (j === 0 ? 0.0001 : u);
      const x = Math.cos(th) * er, z = Math.sin(th) * er;
      const y = r * 0.07 * (1 - u * u) + r * 0.03 * n.n3(x / r * 2.2, 3.3, z / r * 2.2) - (u > 0.85 ? (u - 0.85) * r * 0.25 : 0);
      return [x, y, z];
    });
  }
  // rim lip + underside: radius tapers to a point with strata ledges and lumps
  const under = 26;
  for (let j = 1; j <= under; j++) {
    const t = j / under;
    rows.push((th) => {
      const ledge = 1 + 0.07 * Math.sign(Math.sin(t * 34 + n.n3(th, t * 3, 7.7) * 3)) * Math.pow(Math.abs(Math.sin(t * 34 + n.n3(th, t * 3, 7.7) * 3)), 0.3);
      const lump = 1 + 0.28 * n.n3(Math.cos(th) * 1.8, t * 2.6, Math.sin(th) * 1.8) + 0.1 * n.n3(Math.cos(th) * 5, t * 7, Math.sin(th) * 5);
      const prof = Math.pow(1 - t, 0.85) * (t < 0.08 ? 1 - 0.1 * (t / 0.08) : 0.9) ;
      const er = edgeR(th) * prof * lump * ledge * (j === under ? 0.02 : 1);
      const ox = 0.12 * r * Math.sin(t * 2.1 + o.seed % 7) * t, oz = 0.1 * r * Math.cos(t * 1.7 + o.seed % 5) * t;
      return [Math.cos(th) * er + ox, -r * 0.03 - depth * Math.pow(t, 0.92), Math.sin(th) * er + oz];
    });
  }
  const body = ringGrid(rows, seg, (j, th, p, c) => {
    if (j <= topRings - 1) { c.copy(grassC).multiplyScalar(0.8 + 0.35 * (0.5 + 0.5 * n.n3(p[0] / 9, 1.1, p[2] / 9))); return; }
    if (j <= topRings + 1) { c.copy(soil); return; }
    const t = -p[1] / depth;
    const band = 0.85 + 0.25 * Math.sin(p[1] * 0.45 + n.n3(p[0] / 30, p[1] / 30, p[2] / 30) * 2);
    c.copy(rock).lerp(rockD, Math.min(1, t * 1.1)).multiplyScalar(band);
    const moss = Math.max(0, n.n3(p[0] / 14, p[1] / 22, p[2] / 14)) * (1 - t) * 0.8;
    c.lerp(grassC.clone().multiplyScalar(0.6), moss);
  });
  const parts = [stripUV(body)];
  // stalactites
  const ns = 6 + Math.floor(rnd() * 8);
  for (let i = 0; i < ns; i++) {
    const th = rnd() * Math.PI * 2, t = 0.25 + rnd() * 0.55;
    const er = edgeR(th) * Math.pow(1 - t, 0.85) * 0.75;
    const len = r * (0.25 + rnd() * 0.6) * (1 - t * 0.5);
    const g = coneGeo(r * (0.05 + rnd() * 0.07), len, 7, rockD, [(rnd() - 0.5) * 0.15, (rnd() - 0.5) * 0.15]);
    g.translate(Math.cos(th) * er, -r * 0.03 - depth * Math.pow(t, 0.92) + len * 0.1, Math.sin(th) * er);
    parts.push(stripUV(g));
  }
  // hanging roots: from the rim and the underside, swaying down past the tip
  const root = new THREE.Color(0.11, 0.075, 0.045);
  const nr = 10 + Math.floor(rnd() * 10);
  for (let i = 0; i < nr; i++) {
    const th = rnd() * Math.PI * 2, t0 = rnd() * 0.5;
    const er = edgeR(th) * Math.pow(1 - t0, 0.85) * 0.97;
    const x0 = Math.cos(th) * er, z0 = Math.sin(th) * er, y0 = -r * 0.03 - depth * Math.pow(t0, 0.92);
    const L = r * (0.5 + rnd() * 1.4);
    const pts = [];
    const sw = (rnd() - 0.5) * 0.4;
    for (let k = 0; k <= 5; k++) {
      const f = k / 5;
      pts.push(new THREE.Vector3(x0 * (1 - 0.25 * f) + Math.sin(f * 3 + i) * sw * r * 0.2, y0 - L * f, z0 * (1 - 0.25 * f) + Math.cos(f * 2.5 + i) * sw * r * 0.2));
    }
    parts.push(stripUV(tubeGeo(pts, r * (0.012 + rnd() * 0.012), r * 0.002, 4, root)));
  }
  const g = mergeGeometries(parts.map((p) => { const q = p.index ? p.toNonIndexed() : p; for (const k of Object.keys(q.attributes)) if (!['position', 'normal', 'color'].includes(k)) q.deleteAttribute(k); return q; }), false);
  for (const p of parts) p.dispose();
  return { geo: g, depth };
}

/** Natural rock arch (local frame: X across the span, +Y up, Z = opening axis). */
function buildArch(o, pal, grassC, seed) {
  const n = new SNoise(seed ^ 0xa4c);
  const W = o.span || 58, Hh = o.rise || 50, T = W * 0.3, D = W * 0.46;
  const a = W / 2 + T / 2, b = Hh + T / 2;
  const NR = 170, seg = 48, bury = 18;
  const pos = [], col = [], idx = [];
  const rock = pal.rock.clone(), rockD = pal.rock.clone().multiplyScalar(0.5), rockP = pal.rock.clone().lerp(new THREE.Color(0.85, 0.8, 0.72), 0.35);
  const c = new THREE.Color();
  const ridged = (x, y, z) => 0.5 - Math.abs(n.n3(x, y, z));
  // centreline: buried leg (straight, slightly splayed) → semi-ellipse → buried leg; the crown is offset
  // a little toward one leg (natural arches are never symmetric)
  const skew = 0.12 * n.n3(3.3, 1.1, 0.4);
  const center = (s) => {
    const legF = 0.1;
    if (s < legF) { const t = s / legF; return { p: [-a - 0.15 * T * (1 - t), -bury * (1 - t), 0], tn: [0.15 * T / bury, 1, 0], phi: 0 }; }
    if (s > 1 - legF) { const t = (s - (1 - legF)) / legF; return { p: [a + 0.15 * T * t, -bury * t, 0], tn: [0.15 * T / bury, -1, 0], phi: Math.PI }; }
    const u = (s - legF) / (1 - 2 * legF);
    const phi = (u + skew * Math.sin(u * Math.PI)) * Math.PI;
    const x = -a * Math.cos(phi), y = b * Math.sin(phi);
    const tx = a * Math.sin(phi), ty = b * Math.cos(phi), tl = Math.hypot(tx, ty);
    return { p: [x, y, 0], tn: [tx / tl, ty / tl, 0], phi };
  };
  for (let j = 0; j <= NR; j++) {
    const s = j / NR, C = center(s);
    const sp = Math.sin(C.phi);
    const legK = 1 - sp;   // 1 at the legs, 0 at the crown
    // thin, eroded crown; massive flaring legs
    const ht = (T / 2) * (0.62 + 0.38 * legK + 0.9 * Math.pow(legK, 3)) * (1 + 0.16 * n.n3(s * 5, 1.3, 2.2));
    const hd = (D / 2) * (0.75 + 0.6 * Math.pow(legK, 2)) * (1 + 0.14 * n.n3(s * 4, 4.4, 0.7));
    const nx = -C.tn[1] / Math.hypot(C.tn[0], C.tn[1]), ny = C.tn[0] / Math.hypot(C.tn[0], C.tn[1]);
    for (let i = 0; i <= seg; i++) {
      const th = (i / seg) * Math.PI * 2;
      const ct = Math.cos(th), st = Math.sin(th);
      const e = 0.5;   // superellipse: blocky section with rounded corners
      const sx = Math.sign(ct) * Math.pow(Math.abs(ct), e), sz = Math.sign(st) * Math.pow(Math.abs(st), e);
      let px = C.p[0] + nx * sx * ht, py = C.p[1] + ny * sx * ht, pz = sz * hd;
      const nnx = nx * sx, nny = ny * sx, nnz = sz;
      const nl = Math.hypot(nnx, nny, nnz) || 1;
      // relief: big lumps, ridged crags (sharp), horizontal strata ledges (stepped, altitude-locked)
      let off = 0.16 * T * n.n3(px / 16, py / 16, pz / 16) + 0.09 * T * (ridged(px / 6, py / 6, pz / 6) - 0.2) + 0.03 * T * n.n3(px / 1.8, py / 1.8, pz / 1.8);
      const lv = py / 3.4 + 0.35 * n.n3(px / 40, 0.3, pz / 40), lf = lv - Math.floor(lv);
      off += 0.07 * T * (lf < 0.75 ? lf / 0.75 : (1 - lf) / 0.25) * (0.6 + 0.4 * n.n3(px / 12, 5.5, pz / 12));
      off *= 1 - 0.5 * Math.max(0, -nny / nl) * (1 - legK);   // the soffit of the crown is smoother
      px += (nnx / nl) * off; py += (nny / nl) * off; pz += (nnz / nl) * off;
      pos.push(px, py, pz);
      // colour: strata bands, pale fresh scars, dark varnish streaks down the faces, moss on top
      const band = 0.8 + 0.3 * Math.sin(py * 0.62 + n.n3(px / 25, py / 25, pz / 25) * 2.5) + 0.12 * n.n3(0.2, py / 2.1, 0.7);
      c.copy(rock).multiplyScalar(band);
      c.lerp(rockP, Math.max(0, n.n3(px / 11, py / 7, pz / 11) - 0.25) * 0.9);
      const streak = Math.max(0, n.n3(px / 3.5, py / 26, pz / 3.5) - 0.1) * 1.3;
      c.lerp(rockD, Math.min(0.75, streak * (1 - Math.abs(nny / nl)) + sstep(-bury, 6, -py) * 0.35));
      const up = nny / nl;
      c.lerp(grassC.clone().multiplyScalar(0.62), sstep(0.5, 0.85, up + 0.25 * n.n3(px / 5, py / 5, pz / 5)) * 0.9);
      col.push(c.r, c.g, c.b);
    }
  }
  const Wr = seg + 1;
  for (let j = 0; j < NR; j++) for (let i = 0; i < seg; i++) {
    const p0 = j * Wr + i, p1 = p0 + 1, p2 = p0 + Wr, p3 = p2 + 1;
    idx.push(p0, p1, p2, p1, p3, p2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return { geo: g, a, b, T, D };
}

export class LandmarkFeatures {
  constructor(world, terrain) {
    this.world = world;
    this.group = new THREE.Group();
    this.group.name = 'terrain-landmarks';
    this.isles = [];
    this.colliders = [];
    this.time = 0;
    const L = terrain.landmarks;
    const S = world.surface;
    if (!L || !S) return;
    const pal0 = world.body.art?.palette || {};
    const col = (h, fb) => { const c = new THREE.Color(); try { c.set(h ?? fb); } catch (_) { c.set(fb); } return c; };
    const rock = col(pal0.rock, '#8a7d6c'), sand = col(pal0.sand, '#d9c9a0');
    const pal = { rock, soil: rock.clone().lerp(sand, 0.45).multiplyScalar(0.62) };
    const lite = !!terrain.material?.isMeshLambertMaterial;
    this.material = rockMaterial(terrain.material, lite);
    const grassAt = (d) => {
      const g = col(pal0.grass, '#6f8f45');
      try { const s = S.season(d[0], d[1], d[2]); g.lerp(seasonColor(s), Math.min(1, (S.seasonAmt ?? 0) * 0.85)); } catch (_) { /* */ }
      return g;
    };
    const R = world.body.radius;
    const shadows = world.quality?.shadows !== false;
    // ---- floating isles
    const flo = (L.sacred || []).find((s) => s.kind === 'floating');
    if (flo?.islands?.length) {
      for (const o of flo.islands) {
        try {
          const { geo, depth } = buildIsle(o, pal, grassAt(o.dir));
          const mesh = new THREE.Mesh(geo, this.material);
          mesh.name = 'terrain-floating-isle';
          const up = new THREE.Vector3(o.dir[0], o.dir[1], o.dir[2]);
          mesh.position.copy(up).multiplyScalar(R + o.alt);
          mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), up);
          mesh.rotateY((o.seed % 628) / 100);
          mesh.castShadow = shadows; mesh.receiveShadow = true;
          mesh.userData.base = mesh.position.clone(); mesh.userData.up = up; mesh.userData.ph = (o.seed % 1000) / 159;
          this.group.add(mesh);
          this.isles.push(mesh);
          o.top = o.alt + o.radius * 0.07; o.depth = depth;
          const c = world.addCollider?.({ type: 'box', pos: up.clone().multiplyScalar(R + o.alt - o.radius * 0.02), halfExtents: new THREE.Vector3(o.radius * 0.72, o.radius * 0.07, o.radius * 0.72), quaternion: mesh.quaternion.clone(), tag: 'rock' });
          if (c) this.colliders.push(c);
        } catch (e) { console.warn('[terrain] floating isle', e); }
      }
    }
    // ---- natural arch
    const arch = (L.sacred || []).find((s) => s.kind === 'arch');
    if (arch?.dir) {
      try {
        const up = new THREE.Vector3(arch.dir[0], arch.dir[1], arch.dir[2]);
        // frame: Z = opening axis (toward the mountain, bearing arch.yaw), X across
        const east = new THREE.Vector3(up.z, 0, -up.x).normalize();
        if (east.lengthSq() < 1e-6) east.set(1, 0, 0);
        const north = new THREE.Vector3().crossVectors(up, east).normalize();
        const yaw = (arch.yaw || 0) * Math.PI / 180;
        const fwd = north.clone().multiplyScalar(Math.cos(yaw)).addScaledVector(east, Math.sin(yaw)).normalize();
        const across = new THREE.Vector3().crossVectors(up, fwd).normalize();
        const seed = (L.mountain ? Math.round(L.mountain.lat * 1000) : 7) ^ 0x3a7;
        const A = buildArch(arch, pal, grassAt(arch.dir), seed);
        // base: the lower of the two feet (the legs are buried 18 m)
        const footH = (s) => { const d = up.clone().multiplyScalar(R).addScaledVector(across, s * A.a).normalize(); return S.height(d.x, d.y, d.z); };
        const h0 = Math.min(footH(-1), footH(1), arch.height) - 1.5;
        const mesh = new THREE.Mesh(A.geo, this.material);
        mesh.name = 'terrain-arch';
        _m.makeBasis(across, up, fwd);
        mesh.quaternion.setFromRotationMatrix(_m);
        mesh.position.copy(up).multiplyScalar(R + h0);
        mesh.castShadow = shadows; mesh.receiveShadow = true;
        this.group.add(mesh);
        this.arch = mesh;
        arch.base = h0; arch.top = h0 + A.b + A.T / 2;
        const box = (cx, cy, hx, hy, hz) => {
          const p = mesh.position.clone().addScaledVector(across, cx).addScaledVector(up, cy);
          const c = world.addCollider?.({ type: 'box', pos: p, halfExtents: new THREE.Vector3(hx, hy, hz), quaternion: mesh.quaternion.clone(), tag: 'rock' });
          if (c) this.colliders.push(c);
        };
        box(-A.a, A.b * 0.35, A.T * 0.6, A.b * 0.45, A.D * 0.55);
        box(A.a, A.b * 0.35, A.T * 0.6, A.b * 0.45, A.D * 0.55);
        box(0, A.b, A.a * 0.75, A.T * 0.45, A.D * 0.5);
      } catch (e) { console.warn('[terrain] arch', e); }
    }
    world.root.add(this.group);
  }

  update(dt) {
    this.time += Math.min(dt || 0, 0.1);
    const t = this.time;
    for (const m of this.isles) {
      const u = m.userData;
      m.position.copy(u.base).addScaledVector(u.up, Math.sin(t * 0.21 + u.ph) * 1.6);
    }
  }

  dispose() {
    for (const c of this.colliders) { try { this.world.removeCollider?.(c); } catch (_) { /* */ } }
    this.group.traverse((o) => o.geometry?.dispose?.());
    this.material?.dispose?.();
    this.group.removeFromParent();
  }
}
