// The system's star: HDR limb-darkened disk with animated granulation, sunspots and faculae,
// chromosphere, prominences, streamer corona and a soft glare halo. OWNED BY THE SPACE TRACK.
// Rendered as a far-plane billboard (background) so planets and terrain occlude it (eclipses).
import * as THREE from 'three';
import { FAR_DIR_POS } from './shaders.js';

const VERT = /* glsl */ `
${FAR_DIR_POS}
uniform vec3 uDir;          // unit direction to the star (scene space)
uniform float uExtent;      // billboard half-size (radians)
varying vec3 vDir;
void main(){
  vec3 up = abs(uDir.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(up, uDir));
  vec3 t2 = cross(uDir, t1);
  vec3 d = uDir + (t1 * position.x + t2 * position.y) * uExtent;
  vDir = d;
  gl_Position = sp_farClip(normalize(d));
}`;

const FRAG = /* glsl */ `
#include <rv_space>
uniform vec3 uDir;
uniform float uAng;         // angular radius of the photosphere (rad)
uniform vec3 uColor;        // photosphere colour (linear, max 1)
uniform float uDisk;        // disk centre radiance (HDR)
uniform float uCorona;      // corona strength
uniform float uGlare;       // glare halo strength
uniform float uActivity;    // 0..1 (spots, prominences)
uniform float uTime;
uniform float uSeed;
uniform float uPixAng;
varying vec3 vDir;
void main(){
  vec3 d = normalize(vDir);
  vec3 up = abs(uDir.y) < 0.95 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
  vec3 t1 = normalize(cross(up, uDir));
  vec3 t2 = cross(uDir, t1);
  vec2 uv = vec2(dot(d, t1), dot(d, t2));          // ≈ angle components (small angles)
  float ang = length(uv);
  // a sub-pixel photosphere is drawn as a ~1.5 px disk with the same flux (never falls between pixel
  // centres: the lens-flare occlusion probe and bloom always see a real bright disc)
  float Rd = max(uAng, uPixAng * 1.5);
  float fluxK = (uAng * uAng) / (Rd * Rd);
  float x = ang / Rd;                               // 1 = limb
  float phi = atan(uv.y, uv.x);
  vec3 col = vec3(0.0);
  float aa = max(uPixAng / Rd, 0.004);           // limb anti-aliasing width (in radii)
  // ---------------- photosphere
  if (x < 1.0 + aa){
    float xc = min(x, 1.0);
    float mu = sqrt(max(1.0 - xc * xc, 0.0));
    // limb darkening (quadratic) with a redder limb
    vec3 ld = vec3(1.0 - 0.52 * (1.0 - mu) - 0.20 * (1.0 - mu) * (1.0 - mu));
    ld *= mix(vec3(1.0, 0.72, 0.5), vec3(1.0), pow(mu, 0.35));
    // point on the visible hemisphere (rotating slowly)
    vec3 sp = vec3(uv / Rd, mu);
    float ca = cos(uTime * 0.004), sa = sin(uTime * 0.004);
    sp.xz = mat2(ca, -sa, sa, ca) * sp.xz;
    // granulation: animated cellular pattern (only resolvable when the disk is large on screen)
    float detail = smoothstep(18.0, 90.0, uAng / uPixAng);
    vec2 w = rv_worley(sp * 38.0 + vec3(0.0, 0.0, uTime * 0.05) + uSeed);
    float gran = smoothstep(0.0, 0.55, w.y - w.x);
    float g2 = rv_snoise(sp * 110.0 + uTime * 0.08) * 0.5 + 0.5;
    float granulation = mix(1.0, 0.78 + 0.3 * gran + 0.06 * g2, detail);
    // sunspots (umbra/penumbra) in the activity belts, faculae near the limb
    float belts = smoothstep(0.55, 0.15, abs(abs(sp.y) - 0.35));
    float sn = rv_fbm(sp * 4.0 + uSeed * 1.7, 4) * 0.5 + 0.5;
    float spot = smoothstep(0.66 - uActivity * 0.1, 0.78, sn) * belts * uActivity;
    float umbra = smoothstep(0.76, 0.82, sn) * belts * uActivity;
    float fac = smoothstep(0.55, 0.7, sn) * belts * (1.0 - mu) * 0.6;
    float spots = (1.0 - spot * 0.55) * (1.0 - umbra * 0.7) * (1.0 + fac);
    col = uColor * ld * granulation * spots * uDisk * fluxK;
    float edge = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, x);
    col *= edge;
  }
  // ---------------- chromosphere, prominences (just outside the limb)
  float above = max(x - 1.0, 0.0);
  if (x > 1.0 - aa){
    vec3 chromo = vec3(1.0, 0.25, 0.28);
    col += chromo * exp(-above * 90.0) * uDisk * 0.03;
    // prominences: bright looping arcs hugging the limb
    float pn = rv_fbm(vec3(phi * 3.0, above * 14.0, uSeed + uTime * 0.01), 5) * 0.5 + 0.5;
    float loops = rv_ridged(vec3(phi * 9.0 + pn * 2.0, above * 26.0 - uTime * 0.02, uSeed * 0.3), 4);
    float prom = smoothstep(0.55, 0.9, pn) * loops * exp(-above * 9.0) * step(0.0, x - 1.0);
    col += vec3(1.0, 0.32, 0.25) * prom * uDisk * 0.02 * (0.4 + uActivity);
    // corona: streamers along magnetic structure, falling off ~ r^-3
    float r = max(x, 1.0);
    float st = rv_fbm(vec3(cos(phi) * 2.5, sin(phi) * 2.5, uSeed + log(r) * 0.35 - uTime * 0.003), 5) * 0.5 + 0.5;
    float rays = rv_fbm(vec3(phi * 14.0, log(r) * 0.8, uSeed * 1.3), 3) * 0.5 + 0.5;
    float streamers = pow(st, 2.2) * (0.55 + 0.9 * rays);
    float corona = (0.35 + 1.6 * streamers) * pow(r, -3.2) * smoothstep(1.0, 1.02, x);
    vec3 ccol = mix(uColor, vec3(1.0), 0.6);
    col += ccol * corona * uCorona;
  }
  // ---------------- glare halo (the eye/lens spreads the light a little)
  col += mix(uColor, vec3(1.0), 0.3) * uGlare * (0.9 * exp(-ang / (uAng * 1.6)) + 0.12 * uAng * uAng / (ang * ang + uAng * uAng * 0.8));
  gl_FragColor = vec4(col, 1.0);
}`;

export class Star {
  constructor(world) {
    this.world = world;
    const star = world.star;
    // colour: normalised blackbody (max 1), chromatically softened like the atmosphere track
    const c = star.color ? star.color.clone() : new THREE.Color(1, 1, 1);
    const m = Math.max(c.r, c.g, c.b, 1e-3);
    c.multiplyScalar(1 / m);
    this.color = c;
    this.u = {
      uDir: { value: new THREE.Vector3(0, 1, 0) },
      uExtent: { value: 0.05 },
      uAng: { value: 0.005 },
      uColor: { value: new THREE.Vector3(c.r, c.g, c.b) },
      uDisk: { value: 400 },
      uCorona: { value: 3 },
      uGlare: { value: 1 },
      uActivity: { value: 0.3 + (star.flare ?? 0.5) * 0.7 },
      uTime: { value: 0 },
      uSeed: { value: ((star.seed >>> 0) % 1000) * 0.0731 },
      uPixAng: { value: 0.001 },
    };
    const g = new THREE.PlaneGeometry(2, 2);
    this.mat = new THREE.ShaderMaterial({
      uniforms: this.u, vertexShader: VERT, fragmentShader: FRAG,
      depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.mat.userData.noCSM = true;
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -990;
    this.mesh.name = 'space-star';
    this.mesh.userData.noCSM = true;
    this.angularRadius = 0.005;
  }

  update(dt, t, ctx) {
    const cel = this.world.celestial;
    const u = this.u;
    u.uDir.value.copy(cel.sunDir);
    const ang = THREE.MathUtils.clamp((this.world.star.radius || 7e5) / Math.max(cel.sunDistance, 1), 1e-5, 0.6);
    this.angularRadius = ang;
    u.uAng.value = ang;
    u.uPixAng.value = ctx.pixAng;
    // corona + glare extent: grows in space, the halo stays ~constant on screen
    const ext = Math.min(1.2, Math.max(ang * 14, ctx.pixAng * 160));
    u.uExtent.value = ext;
    // HDR disk radiance: bright enough to bloom, not a white-out (the post track owns glare);
    // tiny disks (distant, sub-pixel) keep their flux by brightening, clamped.
    const pxR = ang / Math.max(ctx.pixAng, 1e-6);
    u.uDisk.value = THREE.MathUtils.clamp(260 * Math.pow(Math.max(3 / Math.max(pxR, 1e-3), 1), 2), 260, 1e9);   // × (ang/Rd)² in the shader
    // corona visible from space / above the air; the atmosphere pass hides it by day anyway
    u.uCorona.value = 2.2 * (1 - 0.85 * ctx.inAtmo);
    u.uGlare.value = 0.9 + 0.6 * (1 - ctx.inAtmo);
    u.uTime.value = t;
  }

  dispose() { this.mesh.geometry.dispose(); this.mat.dispose(); }
}
