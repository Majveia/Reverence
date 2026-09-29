// Flora track — Flora Lab (dev only, never imported by the game).
//
// Runs the REAL flora subsystem (styles, generators, placement workers, streaming bands, LODs,
// impostors, grass) on a REAL showcase planet surface (Universe + PlanetSurface), but renders it
// with a light-weight stand-in for the rest of the world: a biome-coloured ground mesh from
// surface.height/sample, a gradient sky + PMREM environment, one sun (or moon) shadow map and
// exponential fog. Captures take seconds instead of minutes:
//   node tools/shoot.mjs --url "/src/world/flora/lab/?star=11&planet=0&lat=-25.292&lon=-104.202" --out x.png
// URL: galaxy, star, planet, seed, lat, lon, yaw (0 = north, 90 = east), pitch, h (camera height
// above ground, m), fov, sunel, sunaz (deg; sunel < -4 = night with moonlight), wind, exp, full
// (1 = full flora density, else the software capture profile's 0.45), q (low|med|high).
import * as THREE from 'three';
import '../../../shaders/chunks.js';
import { G, updateCameraUniforms } from '../../../core/Uniforms.js';
import { Universe } from '../../../universe/Universe.js';
import { PlanetSurface } from '../../planet/PlanetSurface.js';
import { latLonToDir } from '../../../core/math.js';
import floraMod from '../index.js';

const qs = new URLSearchParams(location.search);
const num = (k, d) => (qs.has(k) ? +qs.get(k) : d);
const DEG = Math.PI / 180;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

// ------------------------------------------------------------------ planet
const U = new Universe(num('seed', 1));
const sys = U.system(num('galaxy', 0), num('star', 11));
const body = U.body(sys, qs.get('planet') ?? '0');
const surface = new PlanetSurface(body);
const R = body.radius;
const sea = Number.isFinite(surface.seaLevel) ? surface.seaLevel : -1e9;

const up = latLonToDir(num('lat', -25.292), num('lon', -104.202), new THREE.Vector3()).normalize();
const east = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), up).normalize();
const north = new THREE.Vector3().crossVectors(up, east).normalize();
const gH = Math.max(surface.height(up.x, up.y, up.z), sea);
const origin = up.clone().multiplyScalar(R + gH);           // planet-local ground point under the camera

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
root.position.copy(origin).negate();
scene.add(root);
const camera = new THREE.PerspectiveCamera(num('fov', 60), innerWidth / innerHeight, 0.05, 40000);
root.add(camera);
G.uPlanetCenter.value.copy(root.position);
G.uPlanetRadius.value = R;
G.uSeaLevel.value = sea;

// sun / moon
const sunEl = num('sunel', 28) * DEG, sunAz = num('sunaz', 120) * DEG;
const night = num('sunel', 28) < -4;
const sunDir = up.clone().multiplyScalar(Math.sin(sunEl))
  .addScaledVector(north, Math.cos(sunEl) * Math.cos(sunAz)).addScaledVector(east, Math.cos(sunEl) * Math.sin(sunAz)).normalize();
const keyDir = night ? up.clone().multiplyScalar(0.6).addScaledVector(north, -0.5).addScaledVector(east, 0.4).normalize() : sunDir;
const warm = night ? 0 : 1 - smooth(8, 45, num('sunel', 28));
const keyCol = night ? new THREE.Color(0.35, 0.45, 0.75) : new THREE.Color(1, 0.93 - 0.16 * warm, 0.84 - 0.34 * warm);
const keyI = night ? 0.08 : 3.2;
G.uSunDir.value.copy(keyDir);
G.uSunColor.value.copy(keyCol).multiplyScalar(keyI);
G.uSunIntensity.value = keyI;
G.uNight.value = night ? 1 : smooth(8, -6, num('sunel', 28));
G.uAmbientSky.value.setRGB(0.32, 0.45, 0.68).multiplyScalar(night ? 0.04 : 1);
G.uAmbientGround.value.setRGB(0.16, 0.14, 0.1).multiplyScalar(night ? 0.04 : 1);
G.uWindDir.value.copy(east).multiplyScalar(0.9).addScaledVector(north, 0.4).normalize();
G.uWindStrength.value = num('wind', 0.4);

// sky (background + environment)
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false, fog: false,
  uniforms: { uSun: { value: sunDir }, uUp: { value: up }, uWarm: { value: warm }, uNightK: { value: night ? 1 : 0 } },
  vertexShader: 'varying vec3 vD; void main(){ vD = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
  fragmentShader: `varying vec3 vD; uniform vec3 uSun; uniform vec3 uUp; uniform float uWarm; uniform float uNightK;
    void main(){
      float h = dot(vD, uUp);
      vec3 zen = vec3(0.13, 0.3, 0.62), hor = mix(vec3(0.62, 0.74, 0.88), vec3(0.95, 0.7, 0.48), uWarm * 0.85);
      vec3 grd = vec3(0.18, 0.16, 0.13);
      vec3 c = mix(hor, zen, pow(clamp(h, 0., 1.), 0.55));
      c = mix(grd, c, smoothstep(-0.04, 0.02, h));
      float s = max(dot(vD, uSun), 0.);
      c += vec3(1.0, 0.8, 0.55) * (pow(s, 8.) * 0.35 + pow(s, 64.) * 0.6) * (0.6 + uWarm);
      c += vec3(40.) * smoothstep(0.9994, 0.9997, s);
      c = mix(c, vec3(0.004, 0.006, 0.014) + vec3(0.01, 0.014, 0.03) * (1.0 - h), uNightK);
      gl_FragColor = vec4(c, 1.);
    }`,
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(30000, 48, 24), skyMat);
scene.add(sky);
{
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(100, 48, 24), skyMat));
  const pm = new THREE.PMREMGenerator(renderer);
  scene.environment = pm.fromScene(envScene, 0.02).texture;
  scene.environmentIntensity = num('env', night ? 0.25 : 0.9);
}
const fogC = night ? new THREE.Color(0.004, 0.006, 0.012) : new THREE.Color(0.62, 0.72, 0.84).lerp(new THREE.Color(0.9, 0.72, 0.52), warm * 0.6);
scene.fog = new THREE.FogExp2(fogC, num('fog', 1 / 1800));
const sun = new THREE.DirectionalLight(keyCol, keyI);
sun.castShadow = true;
sun.shadow.mapSize.set(4096, 4096);
const SH = num('shadow', 45);
sun.shadow.camera.left = sun.shadow.camera.bottom = -SH;
sun.shadow.camera.right = sun.shadow.camera.top = SH;
sun.shadow.camera.near = 1; sun.shadow.camera.far = 400;
sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.04;
scene.add(sun, sun.target);

// ------------------------------------------------------------------ ground (polar grid around the camera)
{
  const NA = 160, rings = [];
  for (let r = 0.3; r < 4000; r *= 1.045) rings.push(r);
  const pos = [0, 0, 0], col = [], idx = [];
  const s = {}, c = new THREE.Color(), cr = new THREE.Color(), d = new THREE.Vector3(), p = new THREE.Vector3();
  const pal = body.art?.palette || {};
  const grassC = new THREE.Color(pal.grass || '#5d7a3a'), rockC = new THREE.Color(pal.rock || '#8a8173'), sandC = new THREE.Color(pal.sand || '#d4b687');
  const deep = new THREE.Color(pal.deep || '#1c3a48');
  const colorAt = (x, y, z) => {
    surface.sample(x, y, z, s);
    surface.biomeColor(s.biome, c);
    // like the terrain's meadow tint: vegetated ground takes the (light) palette grass colour
    c.lerp(grassC, (s.biome === 4 || s.biome === 3 || s.biome === 5 || s.biome === 6 || s.biome === 7) ? 0.85 : 0);
    c.lerp(rockC, Math.min(1, (s.rock || 0) * 0.9));
    c.lerp(sandC, Math.min(1, (s.sand || 0) * 0.8));
    if (s.height < sea) c.copy(deep);
    return s.height;
  };
  const push = (lx, lz) => {
    d.copy(origin).addScaledVector(east, lx).addScaledVector(north, lz).normalize();
    const h = colorAt(d.x, d.y, d.z);
    p.copy(d).multiplyScalar(R + Math.max(h, sea) - 0.02).sub(origin);
    pos.push(p.x, p.y, p.z); col.push(c.r, c.g, c.b);
  };
  colorAt(up.x, up.y, up.z); col.push(c.r, c.g, c.b);
  for (let i = 0; i < rings.length; i++) for (let a = 0; a < NA; a++) {
    const t = (a / NA) * Math.PI * 2;
    push(Math.cos(t) * rings[i], Math.sin(t) * rings[i]);
  }
  for (let a = 0; a < NA; a++) idx.push(0, 1 + ((a + 1) % NA), 1 + a);
  for (let i = 0; i < rings.length - 1; i++) for (let a = 0; a < NA; a++) {
    const a0 = 1 + i * NA + a, a1 = 1 + i * NA + ((a + 1) % NA), b0 = a0 + NA, b1 = a1 + NA;
    idx.push(a0, a1, b0, a1, b1, b0);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  m.position.copy(origin);
  m.receiveShadow = true;
  root.add(m);
}

// ------------------------------------------------------------------ camera
const camH = num('h', 1.7);
const yaw = num('yaw', 0) * DEG, pitch = num('pitch', 2) * DEG;
const fwd = north.clone().multiplyScalar(Math.cos(yaw)).addScaledVector(east, Math.sin(yaw)).multiplyScalar(Math.cos(pitch)).addScaledVector(up, Math.sin(pitch));
// back=<m>: third-person-like framing (camera pulled back along the horizontal view direction)
const back = num('back', 0);
const camLocal = origin.clone().addScaledVector(up, camH)
  .addScaledVector(north, -Math.cos(yaw) * back).addScaledVector(east, -Math.sin(yaw) * back);
function placeCamera() {
  camera.position.copy(camLocal);
  camera.up.copy(up);
  root.updateMatrixWorld(true);
  camera.lookAt(camLocal.clone().add(fwd).add(root.position));
  camera.updateMatrixWorld(true);
}
placeCamera();

// ------------------------------------------------------------------ world stub + flora
const tier = qs.get('q') || 'high';
const quality = { tier, floraDensity: qs.get('full') === '1' ? 1 : num('dens', 0.45), drawDistance: 1, shadows: true, msaa: 0, mobile: false };
const events = { on() { return () => {}; }, emit() {} };
const engine = { renderer, quality, shot: true, pipeline: null, events, ui: null, audio: null };
const world = {
  engine, quality, body, surface, root, camera, scene, origin, events,
  colliders: [], pois: [], player: { pos: camLocal.clone().addScaledVector(up, -camH) }, controller: null,
  addCollider(c) { this.colliders.push(c); }, addPOI(p) { this.pois.push(p); }, get() { return null; },
};
world.controller = world.player;
let flora = null, t = 0, err = null;
try { flora = await floraMod.create(world); } catch (e) { err = e; console.error('[flora-lab] create failed', e); }

function step(dt) {
  t += dt;
  G.uTime.value = t;
  G.uFrame.value++;
  placeCamera();
  updateCameraUniforms(camera);
  const cs = new THREE.Vector3().setFromMatrixPosition(camera.matrixWorld);
  sun.position.copy(cs).addScaledVector(keyDir, 200);
  sun.target.position.copy(cs).addScaledVector(fwd, SH * 0.6);
  sun.target.updateMatrixWorld();
  try { flora?.update?.(dt, t); } catch (e) { console.error('[flora-lab] update', e); }
}
// ?atlas=1: show the leaf atlas (R shading as grey, A coverage over magenta) instead of the scene
let atlasView = null;
if (qs.get('atlas') && flora?.atlas?.texture) {
  const m = new THREE.ShaderMaterial({
    uniforms: { t: { value: flora.atlas.texture } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }',
    fragmentShader: 'uniform sampler2D t; varying vec2 vUv; void main(){ vec4 x = texture2D(t, vec2(vUv.x, 1.0 - vUv.y)); vec3 c = mix(vec3(0.5, 0.0, 0.5), vec3(x.r, x.r * 0.9 + x.g * 0.1, x.r * 0.8 + x.b * 0.2), x.a); gl_FragColor = vec4(c, 1.0); }',
    depthTest: false,
  });
  atlasView = new THREE.Scene();
  const q = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), m);
  q.frustumCulled = false;
  atlasView.add(q);
}
function render() {
  try { renderer.render(atlasView || scene, camera); } catch (e) { console.error('[flora-lab] render', e); }
}
window.__rv = {
  ready: false,
  advance(sec) { const n = Math.max(1, Math.round(sec * 30)); for (let i = 0; i < n; i++) step(1 / 30); render(); },
  look(dx, dy) { fwd.applyAxisAngle(up, -dx * DEG); step(1 / 30); render(); },
  state() {
    return { mode: 'flora-lab', body: body.name, style: body.art?.flora, err: err ? String(err) : null, flora: flora?.getState?.(),
      draw: { calls: renderer.info.render.calls, tris: renderer.info.render.triangles } };
  },
  render,
  hold() {}, press() {}, move() {}, click() {}, go() {},
};
addEventListener('resize', () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); render(); });
const wait = () => {
  step(1 / 30);
  if (!flora || err || flora.isReady?.()) { step(1 / 30); render(); window.__rv.ready = true; return; }
  setTimeout(wait, 50);
};
wait();
