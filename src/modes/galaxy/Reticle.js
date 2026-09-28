// Reticle — a thin, softly pulsing selection ring drawn around the selected star (one point sprite).
import * as THREE from 'three';

export class Reticle {
  constructor() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(3), 3));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uA: { value: 0 }, uT: { value: 0 } },
      vertexShader: /* glsl */ `
        uniform float uT;
        void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); gl_PointSize = 34.0 + 3.0 * sin(uT * 3.0); }`,
      fragmentShader: /* glsl */ `
        uniform float uA;
        void main(){
          vec2 q = gl_PointCoord * 2.0 - 1.0;
          float r = length(q);
          float ring = smoothstep(0.08, 0.0, abs(r - 0.82)) ;
          float gap = smoothstep(0.1, 0.22, min(abs(q.x), abs(q.y)));
          gl_FragColor = vec4(vec3(0.75, 0.88, 1.0) * ring * gap * uA * 0.9, 1.0);
        }`,
      transparent: true, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.object = new THREE.Points(g, this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 10;
    this.object.visible = false;
    this._a = 0;
  }
  show(worldPos) {
    this.object.geometry.attributes.position.array.set([worldPos.x, worldPos.y, worldPos.z]);
    this.object.geometry.attributes.position.needsUpdate = true;
    this.object.visible = true;
    this._a = Math.min(1, this._a + 0.08);
    this.mat.uniforms.uA.value = this._a;
    this.mat.uniforms.uT.value += 0.016;
  }
  hide() { this._a = 0; this.object.visible = false; }
  dispose() { this.object.geometry.dispose(); this.mat.dispose(); }
}
