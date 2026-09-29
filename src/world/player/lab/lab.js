// Player track — Explorer Lab (dev only, never imported by the game).
//
// Runs the real Player (controller, animator, cloth, glider, FX, camera) inside a tiny fake world:
// a flat-ish planet of radius R with a test terrain around the north pole —
//   meadow at the origin · a 26 m cliff to the east (x > 18) · a 30° dune to the west (x < -15)
//   · a sea shelf to the south (z < -25, sea level 0).
// Lighting: sun + procedural sky environment (PMREM), ACES. Deterministic stepping through __rv so
// tools/shoot.mjs can capture it in seconds instead of minutes:
//   node tools/shoot.mjs --url "/src/world/player/lab/?camyaw=150&zoom=0.5" --out x.jpg --steps '[{"advance":1}]'
// URL: x, z (spawn, m), yaw, camyaw, pitch, zoom, fov, view, act, alt, climbh, sunel, sunaz (deg), exp.
import * as THREE from 'three';
import { Player } from '../Player.js';
import { G } from '../../../core/Uniforms.js';
import '../../../shaders/chunks.js';

const qs = new URLSearchParams(location.search);
const num = (k, d) => (qs.has(k) ? +qs.get(k) : d);
const R = 200000;
const SEA = 0;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ test terrain (tangent coords)
function terrainXZ(x, z) {
  let h = 2 + 0.6 * Math.sin(x * 0.13) * Math.cos(z * 0.11) + 0.25 * Math.sin(x * 0.5 + z * 0.3);
  const cx = x + 0.8 * Math.sin(z * 0.7) + 0.45 * Math.sin(z * 1.9 + 1.3);
  const c = smooth(18, 21.5, cx);
  h += c * (26 + 1.5 * Math.sin(z * 0.4)) + c * 0.35 * Math.sin(z * 3.1 + x * 2.3);
  if (x < -15) h += Math.min(-15 - x, 45) * 0.6 * (1 - smooth(-60, -75, x) * 0) + 0.3 * Math.sin(z * 0.9 + x * 0.2);
  if (z < -25) h -= Math.min(-25 - z, 30) * 0.36;
  return h;
}
const dirToXZ = (x, y, z) => [x / y * R, z / y * R];
const surface = {
  seaLevel: SEA,
  amp: 60,
  maxHeight: 60,
  BIOMES: { GRASS: 0, DESERT: 1, ROCK: 2, BEACH: 3 },
  height(x, y, z) { const [a, b] = dirToXZ(x, y, z); return terrainXZ(a, b); },
  sample(x, y, z, out = {}) {
    const [a, b] = dirToXZ(x, y, z);
    out.height = terrainXZ(a, b);
    out.sand = a < -15 ? 1 : 0; out.dune = out.sand;
    const e = 0.5, gx = (terrainXZ(a + e, b) - terrainXZ(a - e, b)) / (2 * e), gz = (terrainXZ(a, b + e) - terrainXZ(a, b - e)) / (2 * e);
    const slope = Math.hypot(gx, gz);
    out.rock = slope > 1.2 ? 1 : 0; out.slope = slope;
    out.biome = out.sand ? 1 : out.rock ? 2 : out.height < 0.6 ? 3 : 0;
    out.moisture = 0.5; out.temperature = 0.5; out.snow = 0;
    return out;
  },
  normal(dir, out, eps = 1) {
    const d = dir.clone().normalize();
    const [a, b] = dirToXZ(d.x, d.y, d.z);
    const gx = (terrainXZ(a + eps, b) - terrainXZ(a - eps, b)) / (2 * eps), gz = (terrainXZ(a, b + eps) - terrainXZ(a, b - eps)) / (2 * eps);
    return out.set(-gx, 1, -gz).normalize();
  },
  biomeColor(b, out) { return out.set(b === 1 ? 0xc9ad7f : b === 2 ? 0x7d7468 : 0x5d7a3a); },
};

// ------------------------------------------------------------------ renderer + scene
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(1);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = num('exp', 1.0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
const root = new THREE.Group();
root.position.set(0, -R, 0);
scene.add(root);
const camera = new THREE.PerspectiveCamera(58, innerWidth / innerHeight, 0.05, 20000);
root.add(camera);

// sun
const sunEl = num('sunel', 22) * Math.PI / 180, sunAz = num('sunaz', 210) * Math.PI / 180;
const sunDir = new THREE.Vector3(Math.cos(sunEl) * Math.sin(sunAz), Math.sin(sunEl), Math.cos(sunEl) * Math.cos(sunAz)).normalize();
const warm = 1 - smooth(10, 45, num('sunel', 22));
const sunCol = new THREE.Color(1, 0.94 - 0.14 * warm, 0.86 - 0.3 * warm);
G.uSunDir.value.copy(sunDir);
G.uSunColor.value.copy(sunCol).multiplyScalar(3.2);
G.uSunIntensity.value = 3.2;
G.uAmbientSky.value.setRGB(0.32, 0.45, 0.68);
G.uAmbientGround.value.setRGB(0.16, 0.14, 0.1);
G.uWindDir.value.set(1, 0, 0.3).normalize();
G.uWindStrength.value = 0.35;

// sky (background + environment)
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  uniforms: { uSun: { value: sunDir }, uWarm: { value: warm } },
  vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
  fragmentShader: `varying vec3 vD; uniform vec3 uSun; uniform float uWarm;
    void main(){
      float h = vD.y;
      vec3 zen = vec3(0.13, 0.3, 0.62), hor = mix(vec3(0.62, 0.74, 0.88), vec3(0.95, 0.72, 0.5), uWarm * 0.8);
      vec3 grd = vec3(0.18, 0.16, 0.13);
      vec3 c = mix(hor, zen, pow(clamp(h, 0., 1.), 0.55));
      c = mix(grd, c, smoothstep(-0.04, 0.02, h));
      float s = max(dot(vD, uSun), 0.);
      c += vec3(1.0, 0.8, 0.55) * (pow(s, 8.) * 0.35 + pow(s, 64.) * 0.6) * (0.6 + uWarm);
      c += vec3(40.) * smoothstep(0.9994, 0.9997, s);
      gl_FragColor = vec4(c, 1.);
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(9000, 48, 24), skyMat);
scene.add(sky);
{
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), skyMat));
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = num('env', 0.9);
}
const sun = new THREE.DirectionalLight(sunCol, 3.2);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.left = sun.shadow.camera.bottom = -7;
sun.shadow.camera.right = sun.shadow.camera.top = 7;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 80;
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);

// terrain mesh (0.5 m grid, 140 m square) + sea
{
  const N = 280, S = 140, pos = [], col = [], idx = [];
  const c = new THREE.Color();
  for (let j = 0; j <= N; j++) for (let i = 0; i <= N; i++) {
    const x = -S / 2 + (i / N) * S, z = -S / 2 + (j / N) * S;
    const h = terrainXZ(x, z);
    const d = new THREE.Vector3(x, R, z).normalize().multiplyScalar(R + h);
    pos.push(d.x, d.y - R, d.z);
    const e = 0.5, gx = (terrainXZ(x + e, z) - terrainXZ(x - e, z)) / (2 * e), gz = (terrainXZ(x, z + e) - terrainXZ(x, z - e)) / (2 * e);
    const sl = Math.hypot(gx, gz);
    const n = Math.sin(x * 1.7) * Math.sin(z * 1.3) * 0.5 + Math.sin(x * 0.37 + z * 0.51) * 0.5;
    if (sl > 1.1) c.setHex(0x8a8173).multiplyScalar(0.85 + 0.2 * n);
    else if (x < -15) c.setHex(0xd4b687).multiplyScalar(0.95 + 0.06 * n);
    else if (h < 0.8) c.setHex(0xcdb892);
    else c.setHex(0x5f7d38).lerp(new THREE.Color(0x7d8a3c), 0.5 + 0.5 * n);
    col.push(c.r, c.g, c.b);
  }
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
    const a = j * (N + 1) + i, b = a + 1, cc = a + N + 1, d = cc + 1;
    idx.push(a, cc, b, b, cc, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92 }));
  m.receiveShadow = true; m.castShadow = true;
  scene.add(m);
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshStandardMaterial({ color: 0x1d4a66, roughness: 0.08, metalness: 0, transparent: true, opacity: 0.82 }));
  sea.rotation.x = -Math.PI / 2; sea.position.y = SEA - 0.02;
  sea.receiveShadow = true;
  scene.add(sea);
}

// ------------------------------------------------------------------ fake input (scripted)
const KEYMAP = { Space: 'jump', KeyC: 'descend', ShiftLeft: 'sprint', ShiftRight: 'sprint', KeyV: 'view', KeyE: 'interact' };
const input = {
  _move: new THREE.Vector2(), _look: new THREE.Vector2(), _mv: null, _holds: [], _prev: new Set(), _cur: new Set(),
  zoom: 0,
  axis(name) { return name === 'move' ? this._move : this._look; },
  held(a) { return this._cur.has(a); },
  down(a) { return this._cur.has(a) && !this._prev.has(a); },
  up(a) { return !this._cur.has(a) && this._prev.has(a); },
  setScheme() {},
  step(dt) {
    this._prev = this._cur; this._cur = new Set();
    for (const h of this._holds) if (h.t > 0) { this._cur.add(h.a); h.t -= dt; }
    this._holds = this._holds.filter((h) => h.t > 0);
    if (this._mv && this._mv.t > 0) { this._move.set(this._mv.x, this._mv.y); this._mv.t -= dt; } else this._move.set(0, 0);
  },
};

// ------------------------------------------------------------------ fake engine + world
const quality = { tier: qs.get('q') || 'high', particleScale: 1, floraDensity: 1, drawDistance: 1, shadows: true, mobile: false };
const engine = { renderer, quality, input, audio: null, ui: null, events: { emit() {} } };
const params = Object.fromEntries(qs.entries());
{
  const x = num('x', 0), z = num('z', 0);
  const d = new THREE.Vector3(x, R, z).normalize();
  params.lat = String(Math.asin(d.y) * 180 / Math.PI);
  params.lon = String(Math.atan2(d.x, d.z) * 180 / Math.PI);
  if (!qs.has('yaw')) params.yaw = '0';
  if (!qs.has('flat')) params.flat = '0';
  delete params.tod;
}
const world = {
  engine, input, camera, root, scene, params, quality,
  body: { radius: R, gravity: 9.81, seed: 7, ocean: { present: true, level: 0, liquid: 'water' }, atmosphere: { present: true, density: 1 }, art: { key: qs.get('art') || 'bierstadt', palette: { grass: '#5f7d38', grass2: '#7d8a3c', sand: '#d4b687', rock: '#8a8173' } } },
  surface, colliders: [], pois: [], time: 0,
  celestial: { sunDir: sunDir.clone(), setLocalTime() {} },
  events: { emit() {} },
  get: () => null,
  setController(c) { this.controller = c; },
};

let player = null;
try { player = new Player(world); } catch (e) { console.error('[lab] player failed', e); }

function render() {
  if (player) {
    const p = player.pos;
    sun.target.position.set(p.x, p.y - R, p.z);
    sun.position.copy(sun.target.position).addScaledVector(sunDir, 40);
    sky.position.copy(camera.position).add(root.position);
  }
  try { renderer.render(scene, camera); } catch (e) { console.error('[lab] render', e); }
}
function step(dt) {
  input.step(dt);
  world.time += dt;
  G.uTime.value += dt;
  try { player?.update(dt); } catch (e) { console.error('[lab] update', e); }
  input._look.set(0, 0);
}

window.__rv = {
  ready: false,
  world,
  advance(sec) { const n = Math.max(1, Math.round(sec * 60)); for (let i = 0; i < n; i++) step(1 / 60); render(); },
  move(x, y, sec = 1) { input._mv = { x, y, t: sec }; },
  hold(code, sec = 1) { input._holds.push({ a: KEYMAP[code] || code, t: sec }); },
  press(code) { input._holds.push({ a: KEYMAP[code] || code, t: 1 / 60 }); },
  look(dx, dy) { input._look.set(dx * Math.PI / 180, dy * Math.PI / 180); step(1 / 60); render(); },
  click() {},
  state() { return { mode: 'lab', player: player?.getState?.(), draw: { calls: renderer.info.render.calls, tris: renderer.info.render.triangles } }; },
  render,
};
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); render(); });
step(1 / 60); render();
window.__rv.ready = true;
if (!qs.has('shot')) {
  const loop = () => { step(1 / 60); render(); requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}
