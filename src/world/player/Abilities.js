// Player track — the cosmic mystic's abilities (season 2, the creator: "I should also have cosmic mystic abilities").
//
//   Drift      hold jump in the air (or jump again high up): she levitates and glides on a ring of light under her
//              feet (the glide physics: banking, thermals, ridge lift); holding jump while drifting lifts her a
//              little (aether, refills on the ground). Replaces the jetpack and the paraglider.
//   Lumen      a small orb of light that follows at her shoulder, lights the ground (a real point light) and can be
//              sent ahead (L / gamepad RT): it flies to where you look, hovers, comes back.
//   Resonance  R / gamepad X: a ring of light runs out over the land (conformed to the heightfield); nearby life,
//              paths and sacred sites can glow (`player:pulse` {pos, radius}); her woven stars and the blade light up.
//   Blink      Q / gamepad LT: a short step through light (~7 m), a stardust trail (`player:blink` {from, to}).
//   Commune    sit (X / hold C) then hold C → she meditates, floating a hand's breadth above a ring of light;
//              `world.player.meditating` (0..1) lets the sky answer; motes of light rise around her.
//
// All effects are pooled and allocation-free per frame; the only light is the Lumen's point light (off on `low`).
import * as THREE from 'three';
import { G } from '../../core/Uniforms.js';
import { clamp, smoothstep, lerp, dampF, Spring3, tangentBasis } from './util.js';

const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _d = new THREE.Vector3();
const _col = new THREE.Color();

const RING_VERT = /* glsl */`
  attribute vec2 aT; varying vec2 vT;
  void main() { vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

/** A disc of light under her feet (drift / meditation / light jump): concentric fine rings, slowly turning. */
function makeFootRing() {
  const g = new THREE.PlaneGeometry(2, 2);
  g.rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uA: { value: 0 }, uT: G.uTime, uCol: { value: new THREE.Color(3.0, 2.0, 0.85) }, uCol2: { value: new THREE.Color(0.8, 1.3, 2.8) } },
    vertexShader: /* glsl */`varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform float uA; uniform float uT; uniform vec3 uCol; uniform vec3 uCol2; varying vec2 vP;
      void main(){
        float r = length(vP);
        float ang = atan(vP.y, vP.x);
        float ring = exp(-pow((r - 0.82) / 0.03, 2.0)) * 1.35;                      // the bright rim
        ring += exp(-pow((r - 0.82) / 0.11, 2.0)) * 0.3;                             // its soft halo (reads at a distance)
        ring += exp(-pow((r - 0.9) / 0.008, 2.0)) * 0.35 * (0.7 + 0.3 * sin(ang * 3.0 - uT * 0.9)); // a fine outer thread
        ring += exp(-pow((r - 0.62) / 0.012, 2.0)) * 0.55 * (0.6 + 0.4 * sin(ang * 12.0 + uT * 1.5));
        ring += exp(-pow((r - 0.42) / 0.01, 2.0)) * 0.35 * (0.5 + 0.5 * sin(-ang * 7.0 + uT * 2.2));
        float glyph = step(0.92, fract(ang / 6.2831 * 24.0 + uT * 0.05)) * smoothstep(0.74, 0.7, r) * smoothstep(0.66, 0.7, r);
        float inner = exp(-r * r * 6.0) * 0.12;
        float a = (ring + glyph * 0.6 + inner) * uA * smoothstep(1.0, 0.92, r);
        if (a < 0.002) discard;
        gl_FragColor = vec4(mix(uCol2, uCol, smoothstep(0.5, 0.85, r)) * a, a);
      }`,
  });
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false; m.renderOrder = 11; m.name = 'drift-ring';
  return m;
}

/**
 * The aureole (Commune, and a flash on Resonance): a ring of light standing behind her — the sign of the source —
 * billboarded in view space and pushed a little behind her so her silhouette sits inside it. A bright gold-white
 * ring, a fine inner ring of glyph ticks, a beaded outer thread, a faint sunburst of rays and a warm core glow. The
 * ring draws itself around (uReveal) as the meditation deepens and breathes at ~0.4 Hz.
 */
function makeAureole() {
  const g = new THREE.PlaneGeometry(2, 2);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uA: { value: 0 }, uReveal: { value: 0 }, uT: G.uTime, uR: { value: 3.6 }, uBack: { value: 0.55 } },
    vertexShader: /* glsl */`
      uniform float uR; uniform float uBack; varying vec2 vP;
      void main(){
        vP = position.xy;
        vec4 mv = modelViewMatrix * vec4(0.0, 0.0, 0.0, 1.0);
        mv.xyz += normalize(mv.xyz) * uBack;            // a little behind her, along the view ray
        mv.xy += position.xy * uR;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: /* glsl */`
      uniform float uA; uniform float uReveal; uniform float uT; uniform float uR; varying vec2 vP;
      void main(){
        float r = length(vP) * uR;                       // metres from the centre
        float ang = atan(vP.x, vP.y);                    // 0 at the top, clockwise
        float a01 = fract(ang / 6.2831853 + 1.0);
        float rev = smoothstep(uReveal * 1.02, uReveal * 1.02 - 0.04, a01);   // the ring draws itself around
        float br = 0.86 + 0.14 * sin(uT * 2.513);        // breathing ~0.4 Hz
        float R0 = 1.18 * (1.0 + 0.025 * sin(uT * 2.513));
        float ring = exp(-pow((r - R0) / 0.022, 2.0)) * 2.4 + exp(-pow((r - R0) / 0.2, 2.0)) * 0.32;
        float inner = exp(-pow((r - R0 * 0.8) / 0.008, 2.0)) * 0.9;
        float tick = smoothstep(0.75, 0.9, fract(a01 * 48.0 + uT * 0.03)) * smoothstep(1.0, 0.9, fract(a01 * 48.0 + uT * 0.03)) * smoothstep(R0 * 0.86, R0 * 0.84, r) * smoothstep(R0 * 0.8, R0 * 0.82, r);
        float beads = exp(-pow((r - R0 * 1.32) / 0.012, 2.0)) * (0.5 + 0.5 * sin(a01 * 6.2831853 * 36.0 - uT * 0.3));
        float rays = pow(abs(sin(ang * 9.0 + 0.6 * sin(ang * 3.0 + uT * 0.2))), 30.0) * smoothstep(R0, R0 * 1.15, r) * exp(-(r - R0) * 1.1) * 0.5;
        float core = exp(-r * r * 1.1) * 0.22;
        float edge = smoothstep(uR, uR * 0.85, r);
        float a = ((ring + inner * 0.5 + tick * 0.3 + beads * 0.35) * rev + rays * uReveal + core) * uA * br * edge;
        if (a < 0.002) discard;
        vec3 gold = vec3(3.2, 2.5, 1.45), cosm = vec3(0.85, 1.15, 2.6);
        vec3 c = mix(cosm, gold, clamp(exp(-pow((r - R0) / 0.09, 2.0)) + core * 3.0, 0.0, 1.0));
        gl_FragColor = vec4(c * a, a);
      }`,
  });
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false; m.renderOrder = 10; m.name = 'aureole'; m.visible = false;
  return m;
}

/**
 * A pillar of light from the sky onto her (the sky answers Commune; a flash on Resonance): a camera-facing column
 * around the planet's up axis, narrow at her feet and widening into the sky, faint and slowly streaming.
 */
function makeSkyBeam() {
  const g = new THREE.BufferGeometry();
  const pos = [], idx = [], N = 24;
  for (let j = 0; j <= N; j++) { const y = j / N; pos.push(-1, y, 0, 1, y, 0); if (j < N) { const a = j * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); } }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  const mat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uA: { value: 0 }, uT: G.uTime, uUp: { value: new THREE.Vector3(0, 1, 0) }, uH: { value: 90 }, uW0: { value: 0.9 }, uW1: { value: 7 } },
    vertexShader: /* glsl */`
      uniform vec3 uUp; uniform float uH; uniform float uW0; uniform float uW1; varying vec2 vB;
      void main(){
        vB = position.xy;
        vec3 base = (modelMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
        vec3 side = cross(uUp, cameraPosition - base);
        side = length(side) > 1e-4 ? normalize(side) : vec3(1.0, 0.0, 0.0);
        float y = position.y, w = mix(uW0, uW1, pow(y, 0.8));
        vec3 wp = base + uUp * (y * uH) + side * position.x * w;
        gl_Position = projectionMatrix * viewMatrix * vec4(wp, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform float uA; uniform float uT; varying vec2 vB;
      void main(){
        float x = abs(vB.x), y = vB.y;
        float core = exp(-x * x * 4.0), veil = (1.0 - x) * (1.0 - x);
        float stream = 0.75 + 0.25 * sin(y * 60.0 - uT * 1.6 + vB.x * 4.0) * sin(y * 23.0 - uT * 0.7);
        float a = (core * 0.9 + veil * 0.45) * stream * smoothstep(0.0, 0.02, y) * pow(1.0 - y, 1.6) * uA;
        if (a < 0.002) discard;
        vec3 c = mix(vec3(2.6, 2.1, 1.35), vec3(0.8, 1.05, 2.0), smoothstep(0.0, 0.6, y) * 0.7 + x * 0.3);
        gl_FragColor = vec4(c * a, a);
      }`,
  });
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false; m.renderOrder = 9; m.name = 'sky-beam'; m.visible = false;
  return m;
}

/** The resonance wave: a band conformed to the heightfield, rebuilt each frame from a lazily filled polar table. */
class PulseRing {
  constructor(seg = 128) {
    this.seg = seg; this.rows = 20; this.dr = 3.5;
    this.table = new Float32Array((this.rows + 1) * seg); this.rowOk = new Uint8Array(this.rows + 1);
    this.center = new THREE.Vector3(); this.up = new THREE.Vector3(); this.e = new THREE.Vector3(); this.n = new THREE.Vector3();
    this.t = 99; this.dur = 3.8; this.maxR = 62;
    const g = new THREE.BufferGeometry();
    // three vertices per spoke: the trailing ground edge, the leading ground edge, and the top of a low CURTAIN of
    // light rising from the leading edge (a flat band on the ground vanished behind the grass from a low lens)
    this.pos = new Float32Array((seg + 1) * 3 * 3); this.at = new Float32Array((seg + 1) * 3 * 2);
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('aT', new THREE.BufferAttribute(this.at, 2).setUsage(THREE.DynamicDrawUsage));
    const idx = [];
    for (let i = 0; i < seg; i++) {
      const a = i * 3, b = a + 1, c = a + 3, d = a + 4; idx.push(a, c, b, b, c, d);      // the band on the ground
      const e = a + 1, f = a + 2, gg = a + 4, h = a + 5; idx.push(e, gg, f, f, gg, h);     // the curtain
    }
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 80);
    this.uA = { value: 0 };
    this.mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
      uniforms: { uA: this.uA, uT: G.uTime },
      vertexShader: RING_VERT,
      fragmentShader: /* glsl */`
        uniform float uA; uniform float uT; varying vec2 vT;
        void main(){
          float x = vT.y;                                   // 0 inner (trailing) .. 1 outer (leading edge), 1..2 curtain
          if (x > 1.0) {                                    // the curtain: bright at its foot, a soft veil upward
            float v = x - 1.0;
            float sc = 0.8 + 0.2 * sin(vT.x * 6.2831 * 90.0 + uT * 2.0 + v * 3.0) * sin(vT.x * 6.2831 * 23.0 - uT * 1.3);
            float ac = (exp(-v * 3.0) * 1.25 + 0.22 * (1.0 - v)) * sc * uA * smoothstep(1.0, 0.9, v);
            vec3 cc = mix(vec3(3.4, 2.6, 1.5), vec3(0.8, 1.3, 3.0), smoothstep(0.05, 0.8, v));
            if (ac < 0.002) discard;
            gl_FragColor = vec4(cc * ac, ac);
            return;
          }
          float lead = exp(-pow((x - 0.86) / 0.07, 2.0));
          float wake = smoothstep(0.0, 0.85, x) * 0.35;
          float sh = 0.75 + 0.25 * sin(vT.x * 6.2831 * 40.0 + uT * 3.0);
          float a = (lead * 1.2 + wake) * sh * uA;
          vec3 c = mix(vec3(0.7, 1.2, 2.6), vec3(2.8, 2.3, 1.5), lead);
          if (a < 0.002) discard;
          gl_FragColor = vec4(c * a, a);
        }`,
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 11; this.mesh.visible = false; this.mesh.name = 'resonance-ring';
  }
  start(center, up) {
    this.center.copy(center); this.up.copy(up).normalize();
    tangentBasis(this.up, this.e, this.n);
    this.t = 0; this.rowOk.fill(0); this.c0 = 0;
  }
  _row(j, H) {
    if (this.rowOk[j]) return;
    const r = j * this.dr, seg = this.seg;
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2;
      _a.copy(this.center).addScaledVector(this.e, Math.cos(a) * r).addScaledVector(this.n, Math.sin(a) * r);
      let h = H.groundR(_a);
      const wl = H.water ? H.water(_a) : -Infinity;           // ride over the sea, not along the seabed
      if (wl > -1e8 && !H.solidSea) h = Math.max(h, H.R + wl);
      // over a drop (an overlook, a cliff edge) the wave does not plunge out of sight down the slope: it runs out
      // level from her feet and settles gently (a shock ring of light over the valley), hugging any rising land
      if (this.c0 > 0) h = Math.max(h, this.c0 - 0.6 - r * 0.07);
      this.table[j * seg + i] = h;
    }
    this.rowOk[j] = 1;
  }
  update(dt, H, origin) {
    if (this.t > this.dur) { this.mesh.visible = false; return; }
    if (!this.c0) this.c0 = H.groundR(this.center);
    this.t += dt;
    const u = clamp(this.t / this.dur, 0, 1);
    const R = 1 + this.maxR * (1 - Math.pow(1 - u, 2.2));
    const W = 0.8 + R * 0.09;
    const r0 = Math.max(0, R - W), r1 = R;
    const CH = 1.5 + 3.1 * Math.min(1, R / 25);           // curtain height: grows as it runs out (reads over grass)
    const j1 = Math.min(this.rows, Math.ceil(r1 / this.dr) + 1);
    for (let j = Math.max(0, Math.floor(r0 / this.dr)); j <= j1; j++) this._row(j, H);
    const seg = this.seg, P = this.pos, T = this.at;
    for (let i = 0; i <= seg; i++) {
      const ii = i % seg;
      const a = (ii / seg) * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
      for (let k = 0; k < 3; k++) {
        const r = k ? r1 : r0;
        const jf = Math.min(this.rows - 0.001, r / this.dr), j = Math.floor(jf), f = jf - j;
        const h = this.table[j * seg + ii] * (1 - f) + this.table[Math.min(this.rows, j + 1) * seg + ii] * f;
        _a.copy(this.center).addScaledVector(this.e, ca * r).addScaledVector(this.n, sa * r).normalize().multiplyScalar(h + 0.25 + r * 0.004 + (k === 2 ? CH : 0));
        const o = (i * 3 + k) * 3;
        P[o] = _a.x - origin.x; P[o + 1] = _a.y - origin.y; P[o + 2] = _a.z - origin.z;
        T[(i * 3 + k) * 2] = i / seg; T[(i * 3 + k) * 2 + 1] = k;
      }
    }
    this.mesh.geometry.attributes.position.needsUpdate = true;
    this.mesh.geometry.attributes.aT.needsUpdate = true;
    this.uA.value = smoothstep(0, 0.04, u) * (1 - smoothstep(0.62, 1, u)) * 1.75; // holds near its peak for ~1.5 s (bloom catches it)
    this.mesh.visible = true;
  }
  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); }
}

export class Abilities {
  constructor(world, player, quality) {
    this.world = world; this.player = player;
    const hi = quality?.tier !== 'low';
    this.group = new THREE.Group(); this.group.name = 'abilities';
    // ---- Lumen: a small orb with a soft halo and a real light
    this.lumenPos = new THREE.Vector3().copy(player.pos).addScaledVector(player.up, 1.9);
    this.lumenSpring = new Spring3(3.2, 0.75); this.lumenSpring.reset(this.lumenPos);
    this.lumenSent = 0; this.lumenTarget = new THREE.Vector3(); this.lumenOn = player.params?.lumen !== '0';
    this.lumen = new THREE.Group(); this.lumen.name = 'lumen';
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.045, 16, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(3.4, 3.0, 2.3) }));
    core.renderOrder = 12;
    this.lumen.add(core);
    this.halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: haloTexture(), color: new THREE.Color(1.6, 1.4, 1.0), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    this.halo.scale.setScalar(0.7); this.halo.renderOrder = 12;
    this.lumen.add(this.halo);
    this.light = null;
    if (hi) { this.light = new THREE.PointLight(new THREE.Color(1.0, 0.86, 0.62), 0, 9, 2); this.lumen.add(this.light); }
    this.group.add(this.lumen);
    // ---- foot ring (drift / meditation / light jump)
    this.footRing = makeFootRing();
    this.group.add(this.footRing);
    this.ringA = 0; this.ringFlash = 0;
    // ---- resonance
    this.pulse = new PulseRing(hi ? 128 : 64);
    this.group.add(this.pulse.mesh);
    // ---- Commune: the aureole behind her and the pillar of light from the sky (both flash on Resonance)
    this.aureole = makeAureole(); this.group.add(this.aureole);
    this.beam = makeSkyBeam(); this.group.add(this.beam);
    this.aurA = 0; this.aurRev = 0; this.beamA = 0; this.pulseFlash = 0;
    this.aura = 0;        // warm rim on her body while the source answers (read by the Player → SUIT_LIGHT.uAura)
    this.cool = { pulse: 0, blink: 0, lumen: 0 };
    this.glow = 0;        // 0..~1.5: "an ability flows through her" (woven stars, the blade's edge)
    this.aether = 3;      // drift lift reserve (s)
    this.meditating = 0;
    this._moteT = 0;
  }

  // ------------------------------------------------------------------ actions
  pulseNow() {
    const p = this.player;
    if (this.cool.pulse > 0) return false;
    this.cool.pulse = 1.6;
    _a.copy(p.pos);
    this.pulse.start(_a, p.up);
    this.glow = Math.max(this.glow, 1.5);
    this.ringFlash = 1;
    this.pulseFlash = 1;
    this.world.events?.emit?.('player:pulse', { pos: p.pos.clone(), radius: this.pulse.maxR });
    p.engine?.audio?.play?.('pulse', { intensity: 1 });
    const fx = p.fx;
    if (fx) for (let i = 0; i < 40; i++) {
      const a = fx.rand.next() * Math.PI * 2;
      tangentBasis(p.up, _b, _c);
      _d.copy(_b).multiplyScalar(Math.cos(a)).addScaledVector(_c, Math.sin(a));
      _a.copy(p.pos).addScaledVector(_d, 0.4).addScaledVector(p.up, 0.1 + fx.rand.next() * 1.6);
      fx.emit(_a, _d.multiplyScalar(2 + fx.rand.next() * 3).addScaledVector(p.up, 0.4), { kind: 2, size: 0.04, size1: 0.01, life: 1 + fx.rand.next(), color: _col.setRGB(2.6, 2.3, 1.7), alpha: 0.9, drag: 1.4 });
    }
    return true;
  }

  /** Step through light: `dir` tangent (unit). Returns the distance travelled. */
  blink(dir) {
    const p = this.player, H = p.heights;
    if (this.cool.blink > 0) return 0;
    const D = 7.2;
    _a.copy(p.pos);
    const startAgl = p.pos.length() - H.groundR(p.pos);
    let best = 0;
    // walk out along the path: stop before a wall (ground rising > 1.6 m above the start level) or a collider
    for (let d = 0.5; d <= D; d += 0.5) {
      _b.copy(p.pos).addScaledVector(dir, d);
      const g = H.groundR(_b);
      const here = p.pos.length() - (p.grounded ? 0 : startAgl);
      if (g - here > 1.6) break;
      best = d;
    }
    if (best < 1) return 0;
    this.cool.blink = 0.5;
    const from = _c.copy(p.pos);
    _b.copy(p.pos).addScaledVector(dir, best);
    const g = H.groundR(_b);
    if (p.grounded) _b.setLength(g);
    else _b.setLength(Math.max(g + 0.3, _b.length()));
    // stardust: a column where she was, a streak along the path
    const fx = p.fx;
    if (fx) {
      for (let i = 0; i < 46; i++) {
        const t = fx.rand.next();
        _d.copy(from).lerp(_b, t).addScaledVector(p.up, 0.15 + fx.rand.next() * 1.6);
        _a.copy(dir).multiplyScalar(-0.6 - fx.rand.next()).addScaledVector(p.up, (fx.rand.next() - 0.3) * 0.6);
        fx.emit(_d, _a, { kind: 2, size: 0.03 + fx.rand.next() * 0.04, size1: 0.005, life: 0.8 + fx.rand.next() * 1.4, color: _col.setRGB(2.4 + t, 2.2 + t * 0.5, 2.6 - t), alpha: 0.9, drag: 1.2, grav: -0.03 });
      }
    }
    const fromC = from.clone();
    p.pos.copy(_b);
    if (!p.grounded) p.vel.addScaledVector(p.up, Math.max(0, -p.vel.dot(p.up)) * 0.8); // a breath of hang time
    this.glow = Math.max(this.glow, 0.8);
    this.world.events?.emit?.('player:blink', { from: fromC, to: p.pos.clone() });
    p.engine?.audio?.play?.('blink', { intensity: 0.7 });
    return best;
  }

  sendLumen(camFwd) {
    const p = this.player, H = p.heights;
    if (this.cool.lumen > 0) return;
    this.cool.lumen = 0.4;
    if (this.lumenSent > 0) { this.lumenSent = 0; return; } // call it back
    // fly to where the view points: the first ground hit within 26 m, else 18 m ahead
    let hit = 18;
    _a.copy(p.pos).addScaledVector(p.up, 1.7);
    for (let d = 2; d <= 26; d += 1) {
      _b.copy(_a).addScaledVector(camFwd, d);
      if (_b.length() < H.groundR(_b) + 0.6) { hit = d - 1; break; }
    }
    _b.copy(_a).addScaledVector(camFwd, hit);
    const g = H.groundR(_b);
    if (_b.length() < g + 1.4) _b.setLength(g + 1.4);
    this.lumenTarget.copy(_b);
    this.lumenSent = 7;
    this.glow = Math.max(this.glow, 0.4);
    this.world.events?.emit?.('player:lumen', { pos: this.lumenTarget.clone() });
  }

  /** A burst of the foot ring (the light jump). */
  flashRing() { this.ringFlash = 1; }

  // ------------------------------------------------------------------ frame
  update(dt, ctx) {
    const p = this.player;
    for (const k in this.cool) this.cool[k] = Math.max(0, this.cool[k] - dt);
    this.glow = Math.max(0, this.glow - dt * 0.45);
    const origin = p.gpos || p.pos;
    this.group.position.copy(origin); // children are placed relative to the hero (small floats)
    const night = clamp(G.uNight.value || 0, 0, 1);
    // ---- Lumen
    {
      const left = _c.crossVectors(p.up, p.forward).normalize();
      if (this.lumenSent > 0) {
        this.lumenSent -= dt;
        _a.copy(this.lumenTarget).addScaledVector(p.up, Math.sin(p.time * 1.7) * 0.12);
        if (p.pos.distanceTo(this.lumenTarget) > 60) this.lumenSent = 0;
      } else if (ctx.meditate > 0.2) {
        // it circles her slowly while she meditates
        const a = p.time * 0.6;
        _a.copy(p.pos).addScaledVector(p.up, 1.25 + 0.15 * Math.sin(p.time * 0.9)).addScaledVector(left, Math.cos(a) * 0.9).addScaledVector(p.forward, Math.sin(a) * 0.9);
      } else {
        _a.copy(p.pos).addScaledVector(p.up, 1.95 + Math.sin(p.time * 1.3) * 0.07).addScaledVector(left, 0.5).addScaledVector(p.forward, -0.28)
          .addScaledVector(p.vel, 0.12); // a little lead when she moves fast (drift / blink) so it keeps up
        if (ctx.resting > 0.5) _a.copy(p.pos).addScaledVector(p.up, 0.9).addScaledVector(left, -0.55).addScaledVector(p.forward, 0.55);
      }
      if (_a.distanceTo(this.lumenSpring.x) > 40) this.lumenSpring.reset(_a);
      this.lumenSpring.omega = this.lumenSent > 0 ? 2.2 : 3.2 + clamp(_a.distanceTo(this.lumenSpring.x) * 0.8, 0, 6);
      this.lumenSpring.update(_a, dt);
      this.lumenPos.copy(this.lumenSpring.x);
      this.lumen.position.copy(this.lumenPos).sub(origin);
      const k = (this.lumenOn ? 1 : 0) * (0.35 + 0.65 * Math.max(night, ctx.dark || 0));
      const fl = 1 + 0.05 * Math.sin(p.time * 9.1) + 0.03 * Math.sin(p.time * 5.3 + 1);
      this.halo.material.opacity = clamp(k * fl, 0, 1);
      this.halo.scale.setScalar(0.55 + 0.25 * k + this.glow * 0.15);
      this.lumen.visible = this.lumenOn && ctx.visible && !ctx.fp;
      if (this.light) this.light.intensity = this.lumenOn && ctx.visible ? (0.15 + 2.6 * night + 0.6 * this.glow) * fl : 0;
    }
    // ---- foot ring: drift / meditation / light jump
    {
      const want = Math.max(ctx.drift || 0, ctx.meditate || 0, this.ringFlash);
      this.ringFlash = Math.max(0, this.ringFlash - dt * 2.2);
      this.ringA += (want - this.ringA) * dampF(want > this.ringA ? 10 : 3, dt);
      const fr = this.footRing;
      fr.visible = this.ringA > 0.01 && ctx.visible;
      if (fr.visible) {
        _a.copy(ctx.feet).sub(origin);
        fr.position.copy(_a);
        fr.quaternion.copy(ctx.quat);
        fr.rotateY(p.time * 0.35);
        const s = 0.8 + 0.6 * (ctx.drift || 0) + this.ringFlash * 0.5; // larger under a drift (reads from 10+ m)
        fr.scale.setScalar(s);
        fr.material.uniforms.uA.value = this.ringA * (0.8 + 0.2 * Math.sin(p.time * 2.3));
      }
    }
    // ---- resonance wave
    this.pulse.update(dt, p.heights, origin);
    // ---- Commune: the aureole and the pillar of light (and their flash on Resonance)
    {
      const med = ctx.meditate || 0;
      this.pulseFlash = Math.max(0, this.pulseFlash - dt * 0.4);
      const pf = this.pulseFlash * this.pulseFlash;
      const wantA = Math.max(smoothstep(0.25, 0.9, med), pf * 0.9);
      this.aurA += (wantA - this.aurA) * dampF(wantA > this.aurA ? (pf > 0.2 ? 9 : 1.6) : 2.0, dt);
      this.aurRev = med > 0.3 ? Math.min(1, this.aurRev + dt * 0.45) : pf > 0.05 ? 1 : Math.max(0, this.aurRev - dt * 0.8);
      const au = this.aureole;
      au.visible = this.aurA > 0.01 && ctx.visible && !ctx.fp;
      if (au.visible) {
        au.position.copy(ctx.feet).addScaledVector(p.up, med > 0.3 ? 0.78 : 1.0).sub(origin);
        au.material.uniforms.uA.value = this.aurA;
        au.material.uniforms.uReveal.value = this.aurRev;
        au.material.uniforms.uR.value = 3.6 * (1 + (1 - med) * pf * 0.35);
      }
      const wantB = Math.max(smoothstep(0.4, 1, med) * 1.0, pf * 0.8);
      this.beamA += (wantB - this.beamA) * dampF(wantB > this.beamA ? (pf > 0.2 ? 9 : 1.2) : 1.6, dt);
      const bm = this.beam;
      bm.visible = this.beamA > 0.01 && ctx.visible && !ctx.fp;
      if (bm.visible) {
        bm.position.copy(ctx.feet).sub(origin);
        bm.material.uniforms.uUp.value.copy(p.up);
        bm.material.uniforms.uA.value = this.beamA;
      }
      this.aura = Math.max(this.aurA * 0.9, pf * 0.6);
    }
    // ---- meditation: motes of light rise around her
    this.meditating = ctx.meditate || 0;
    if (this.meditating > 0.3 && p.fx) {
      this._moteT += dt;
      while (this._moteT > 0.07) {
        this._moteT -= 0.07;
        const r = p.fx.rand, a = r.next() * Math.PI * 2, rr = 0.6 + r.next() * 2.4;
        tangentBasis(p.up, _b, _c);
        _a.copy(p.pos).addScaledVector(_b, Math.cos(a) * rr).addScaledVector(_c, Math.sin(a) * rr).addScaledVector(p.up, r.next() * 0.4);
        _d.copy(p.up).multiplyScalar(0.35 + r.next() * 0.5);
        p.fx.emit(_a, _d, { kind: 2, size: 0.025 + r.next() * 0.03, size1: 0.01, life: 3 + r.next() * 2, color: _col.setRGB(2.2, 2.0, 1.6), alpha: 0.8, drag: 0.2, grav: 0 });
      }
    }
  }

  dispose() {
    this.lumen.traverse((o) => { if (o.isMesh) { o.geometry.dispose(); o.material.dispose(); } });
    this.halo.material.map?.dispose(); this.halo.material.dispose();
    this.light?.dispose?.();
    this.footRing.geometry.dispose(); this.footRing.material.dispose();
    this.pulse.dispose();
    for (const m of [this.aureole, this.beam]) { m.geometry.dispose(); m.material.dispose(); }
  }
}

function haloTexture() {
  const S = 64;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const ctx = cv.getContext('2d');
  const g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, 'rgba(255,248,230,1)'); g.addColorStop(0.12, 'rgba(255,230,190,0.75)');
  g.addColorStop(0.4, 'rgba(255,200,150,0.18)'); g.addColorStop(1, 'rgba(255,190,140,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, S, S);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
