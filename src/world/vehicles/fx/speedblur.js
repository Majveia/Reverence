// Radial speed blur (vehicle camera effect): samples toward the focus of expansion, strongest at
// the screen edges, zero cost when idle (io.skip). Registered through the public Pipeline API.
import * as THREE from 'three';
import { makeFullscreenMaterial } from '../../../post/Pipeline.js';

const FRAG = /* glsl */`
#include <rv_common>
uniform sampler2D tSrc;
uniform vec2 uCenter;
uniform float uStrength;
uniform vec2 uRes;
varying vec2 vUv;
void main(){
  vec2 d = vUv - uCenter;
  float r = length(d * vec2(uRes.x / uRes.y, 1.0));
  float k = uStrength * smoothstep(0.12, 0.85, r);
  vec3 acc = texture2D(tSrc, vUv).rgb;
  float wsum = 1.0;
  float j = rv_ign(gl_FragCoord.xy);
  for (int i = 1; i <= 8; i++) {
    float t = (float(i) + j - 0.5) / 8.0;
    float w = 1.0 - t * 0.6;
    acc += texture2D(tSrc, vUv - d * k * t * 0.14).rgb * w;
    wsum += w;
  }
  gl_FragColor = vec4(acc / wsum, 1.0);
}`;

export class SpeedBlur {
  constructor(pipeline) {
    this.pipeline = pipeline;
    this.name = 'vehicle-speedblur';
    this.order = 145;
    this.enabled = true;
    this.strength = 0;
    this.center = new THREE.Vector2(0.5, 0.5);
    this.mat = makeFullscreenMaterial(FRAG, {
      tSrc: { value: null }, uCenter: { value: this.center }, uStrength: { value: 0 }, uRes: { value: new THREE.Vector2(1, 1) },
    });
    this._unreg = null;
    try { this._unreg = pipeline.addEffect(this); } catch (e) { console.warn('[vehicles] speed blur unavailable', e); }
  }
  setSize(w, h) { this.mat.uniforms.uRes.value.set(w, h); }
  render(renderer, io) {
    if (this.strength < 0.02) { io.skip = true; return; }
    const u = this.mat.uniforms;
    u.tSrc.value = io.input.texture;
    u.uStrength.value = this.strength;
    const quad = io.pipeline.quad;
    const prev = quad.material;
    quad.material = this.mat;
    quad.render(renderer, io.output);
    quad.material = prev;
  }
  dispose() {
    try { this._unreg?.(); } catch (_) { /* ignore */ }
    this.mat.dispose();
  }
}
