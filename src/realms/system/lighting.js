// Sun + sky lighting for the system realm, with cascaded shadow maps.
//
// One physical light source (the star) is represented by the CSM cascade lights; a hemisphere light carries
// sky/ground ambient.  The atmosphere module drives colours each frame through setSun()/setAmbient();
// if it is absent the hub applies plain defaults.
//
// IMPORTANT for module authors: every *lit* built-in material (MeshStandard/Physical/Lambert/Phong/Toon) in the
// system scene must pass through rig.setupMaterial(mat) so the three cascade lights count as ONE sun.
// The hub does this automatically for everything in the scene graph (see autoSetup), so normally you do nothing —
// just don't reassign material.onBeforeCompile after the material has been rendered once.

import * as THREE from 'three';
import { CSM } from 'three/addons/csm/CSM.js';

const LIT = (m) => m && (m.isMeshStandardMaterial || m.isMeshPhysicalMaterial || m.isMeshLambertMaterial || m.isMeshPhongMaterial || m.isMeshToonMaterial);

export class LightingRig {
  constructor({ scene, camera, renderer, quality, shadows = true }) {
    this.scene = scene; this.camera = camera; this.renderer = renderer;
    /** Unit vector from the scene origin toward the star (scene space). */
    this.sunDir = new THREE.Vector3(0.4, 0.8, 0.45).normalize();
    this.sunColor = new THREE.Color(1, 0.96, 0.9);
    this.sunIntensity = 3.2;
    /** 0..1 multiplier applied on top of setSun (horizon occlusion by the planet itself, eclipses). */
    this.sunVisibility = 1;
    this.shadowDistance = 1500;
    this._done = new WeakSet();
    this._scanned = new WeakSet();

    this.hemi = new THREE.HemisphereLight(0x8fb8ff, 0x3a3226, 0.6);
    this.hemi.layers.enableAll();
    scene.add(this.hemi);

    this.csm = new CSM({
      camera, parent: scene, cascades: quality.detail >= 1.5 ? 4 : 3, maxFar: this.shadowDistance, mode: 'practical',
      shadowMapSize: quality.shadowMap, shadowBias: -0.00012, lightDirection: this.sunDir.clone().negate(),
      lightIntensity: this.sunIntensity, lightNear: 1, lightFar: 9000, lightMargin: 900,
    });
    this.csm.fade = true;
    if (renderer.capabilities.reversedDepthBuffer) {
      camera._reversedDepth = true; camera.updateProjectionMatrix();
      this.csm.mainFrustum.zNear = 1; this.csm.mainFrustum.zFar = 0;
    }
    for (const l of this.csm.lights) { l.layers.enableAll(); l.shadow.normalBias = 0.35; l.shadow.radius = 2.2; l.castShadow = shadows; }
    this.shadows = shadows;
    this.csm.updateFrustums();
    this._frame = 0;
  }

  /** @param dir unit vector toward the star (scene space)  @param color linear THREE.Color  @param intensity scalar */
  setSun(dir, color, intensity) {
    if (dir) this.sunDir.copy(dir).normalize();
    if (color) this.sunColor.copy(color);
    if (intensity !== undefined) this.sunIntensity = intensity;
  }

  setAmbient(sky, ground, intensity) {
    if (sky) this.hemi.color.copy(sky);
    if (ground) this.hemi.groundColor.copy(ground);
    if (intensity !== undefined) this.hemi.intensity = intensity;
  }

  /** Local "up" for the hemisphere light (planet radial direction at the camera). */
  setUp(up) { this.hemi.position.copy(up); }

  setShadows(on, distance) {
    if (distance && Math.abs(distance - this.shadowDistance) > 1) { this.shadowDistance = distance; this.csm.maxFar = distance; this.csm.updateFrustums(); }
    if (on !== this.shadows) { this.shadows = on; for (const l of this.csm.lights) l.castShadow = on; }
  }

  /** Make a lit material CSM-aware.  Idempotent; preserves the material's own onBeforeCompile. */
  setupMaterial(mat) {
    if (!LIT(mat) || this._done.has(mat)) return mat;
    this._done.add(mat);
    const userHook = mat.onBeforeCompile;
    const ownKey = Object.prototype.hasOwnProperty.call(mat, 'customProgramCacheKey') ? mat.customProgramCacheKey.bind(mat) : null;
    const userKey = ownKey ? null : String(userHook);
    this.csm.setupMaterial(mat);
    const csmHook = mat.onBeforeCompile;
    mat.onBeforeCompile = function (shader, renderer) { csmHook.call(this, shader, renderer); userHook.call(this, shader, renderer); };
    mat.customProgramCacheKey = () => (ownKey ? ownKey() : userKey) + '|csm';
    mat.needsUpdate = true;
    return mat;
  }

  /** Find lit materials that entered the scene since the last scan and set them up.  Cheap; call every frame. */
  autoSetup(root = this.scene) {
    root.traverse((o) => {
      if (!o.isMesh && !o.isInstancedMesh && !o.isSkinnedMesh) return;
      const m = o.material; if (!m || this._scanned.has(m)) return;
      if (Array.isArray(m)) { for (const mm of m) this.setupMaterial(mm); this._scanned.add(m); return; }
      this._scanned.add(m); this.setupMaterial(m);
    });
  }

  resize() { this.csm.updateFrustums(); }

  update() {
    const csm = this.csm, vis = this.sunVisibility;
    csm.lightDirection.copy(this.sunDir).negate();
    for (const l of csm.lights) { l.color.copy(this.sunColor); l.intensity = this.sunIntensity * vis; }
    if ((this._frame++ & 7) === 0) this.autoSetup();
    if (this._frame === 3) csm.updateFrustums();
    csm.update();
  }

  dispose() { this.csm.remove(); this.csm.dispose?.(); this.scene.remove(this.hemi); }
}
