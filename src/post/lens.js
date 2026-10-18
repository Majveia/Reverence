// Lens model: sun occlusion probe (depth + luminance, temporally smoothed on the GPU) and a
// procedural lens-dirt texture. The flare itself (ghosts, halo, starburst, anamorphic streak,
// screen-space ghosts of every bright light, dirt glints) is drawn inside the composite shader.
import * as THREE from 'three';
import { makeFullscreenMaterial } from './common.js';

const VIS_FRAG = /* glsl */ `
#include <rv_common>
#include <rv_post>
uniform sampler2D tDepth, tColor, tPrev;
uniform vec2 uSun, uRadius;       // sun uv, probe radius in uv (x,y)
uniform float uDt, uSnap, uOnScreen, uLumRef;
varying vec2 vUv;
void main(){
  float vis = 0.0, disc = 0.0, ring = 0.0, n = 0.0;
  // 16-tap Vogel disk over the solar disc (depth + luminance), 12 taps on a surrounding ring
  for (int i = 0; i < 16; i++) {
    float r = sqrt((float(i) + 0.5) / 16.0);
    float th = float(i) * 2.39996323;
    vec2 uv = uSun + vec2(cos(th), sin(th)) * r * uRadius;
    float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    float d = texture2D(tDepth, clamp(uv, 0.0, 1.0)).r;
    vis += inside * (rvp_isSky(d) ? 1.0 : 0.0);
    disc += inside * rv_luma(texture2D(tColor, clamp(uv, 0.0, 1.0)).rgb);
    n += inside;
  }
  float nr = 0.0;
  for (int i = 0; i < 12; i++) {
    float th = float(i) * 0.5235988 + 0.26;
    vec2 uv = uSun + vec2(cos(th), sin(th)) * uRadius * 3.5;
    float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
    ring += inside * rv_luma(texture2D(tColor, clamp(uv, 0.0, 1.0)).rgb);
    nr += inside;
  }
  vis /= 16.0; disc /= max(n, 1.0); ring /= max(nr, 1.0);
  // clouds / thick haze in front of the sun are drawn over far-plane depth: require the disc to
  // stand out from its surroundings (a visible sun is far brighter than the sky next to it)
  float contrast = disc / max(ring, 1e-5);
  float lumVis = max(smoothstep(1.03, 1.35, contrast), smoothstep(0.25, 1.0, disc / max(uLumRef, 1e-3)));
  float target = uOnScreen * vis * lumVis;
  float prev = texture2D(tPrev, vec2(0.5)).r;
  float a = uSnap > 0.5 ? 1.0 : 1.0 - exp(-uDt * 14.0);
  gl_FragColor = vec4(mix(prev, target, a), disc, ring, 1.0);
}`;

export class Lens {
  constructor() {
    const opt = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false };
    this.visA = new THREE.WebGLRenderTarget(1, 1, opt);
    this.visB = new THREE.WebGLRenderTarget(1, 1, opt);
    this.visMat = makeFullscreenMaterial(VIS_FRAG, {
      tDepth: { value: null }, tColor: { value: null }, tPrev: { value: null },
      uSun: { value: new THREE.Vector2(0.5, 0.5) }, uRadius: { value: new THREE.Vector2(0.01, 0.01) },
      uDt: { value: 0.016 }, uSnap: { value: 1 }, uOnScreen: { value: 0 }, uLumRef: { value: 20 },
    });
    this.snap = true;
    this.dirt = makeDirtTexture();
  }

  get visTexture() { return this.visB.texture; }

  /** sun: { uv: Vector2, onScreen: 0..1, radiusPx } */
  update(renderer, quad, depthTex, colorTex, sun, dt, w, h, lumRef) {
    const u = this.visMat.uniforms;
    u.tDepth.value = depthTex; u.tColor.value = colorTex; u.tPrev.value = this.visB.texture;
    u.uSun.value.copy(sun.uv);
    const rpx = Math.max(2.5, Math.min(sun.radiusPx, 40));
    u.uRadius.value.set(rpx / w, rpx / h);
    u.uDt.value = Math.min(Math.max(dt, 0), 0.25); u.uSnap.value = this.snap ? 1 : 0;
    u.uOnScreen.value = sun.onScreen; u.uLumRef.value = lumRef;
    quad.draw(renderer, this.visMat, this.visA);
    const t = this.visA; this.visA = this.visB; this.visB = t;
    this.snap = false;
  }

  dispose() { this.visA.dispose(); this.visB.dispose(); this.visMat.dispose(); this.dirt?.dispose(); }
}

// Procedural lens dirt: soft bokeh blobs of dust, a few rings, fingerprint-ish smudge streaks.
// Deterministic (fixed seed) so captures are reproducible.
function makeDirtTexture() {
  const W = 512, H = 288;
  let c;
  try {
    c = document.createElement('canvas'); c.width = W; c.height = H;
  } catch (_) { return null; }
  const g = c.getContext('2d');
  if (!g) return null;
  let seed = 1337;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'lighter';
  // smudges (large, very faint)
  for (let i = 0; i < 14; i++) {
    const x = rnd() * W, y = rnd() * H, r = 40 + rnd() * 110;
    const gr = g.createRadialGradient(x, y, 0, x, y, r);
    const a = 0.05 + rnd() * 0.07;
    gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.save(); g.translate(x, y); g.rotate(rnd() * Math.PI); g.scale(1, 0.35 + rnd() * 0.5); g.translate(-x, -y);
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill(); g.restore();
  }
  // dust bokeh
  for (let i = 0; i < 220; i++) {
    const x = rnd() * W, y = rnd() * H, r = 1.5 + Math.pow(rnd(), 3) * 16;
    const a = 0.08 + rnd() * 0.22;
    const gr = g.createRadialGradient(x, y, r * 0.2, x, y, r);
    gr.addColorStop(0, `rgba(255,255,255,${a})`); gr.addColorStop(0.65, `rgba(255,255,255,${a * 0.75})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  // a few hair-thin scratches
  g.lineWidth = 0.7;
  for (let i = 0; i < 10; i++) {
    const x = rnd() * W, y = rnd() * H, l = 20 + rnd() * 80, t = rnd() * Math.PI;
    g.strokeStyle = `rgba(255,255,255,${0.05 + rnd() * 0.08})`;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(t) * l * 0.5 + (rnd() - 0.5) * 20, y + Math.sin(t) * l * 0.5, x + Math.cos(t) * l, y + Math.sin(t) * l); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter; tex.magFilter = THREE.LinearFilter; tex.generateMipmaps = false;
  return tex;
}
