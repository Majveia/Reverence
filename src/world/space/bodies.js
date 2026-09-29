// Other planets & moons of the system (and the current body itself when it is a gas giant):
// procedural surfaces (rocky / gas), atmosphere limb shells, rings, eclipses, and sub-pixel
// "wandering star" dots for far bodies. OWNED BY THE SPACE TRACK.
import * as THREE from 'three';
import { rockyLook, gasLook, ringTexture } from './bodyLook.js';
import { BODY_VERT, ROCKY_FRAG, GAS_FRAG, SHELL_FRAG, RING_VERT, RING_FRAG } from './bodyShaders.js';
import { FAR_DIR_POS } from './shaders.js';

const Y = new THREE.Vector3(0, 1, 0);
const X = new THREE.Vector3(1, 0, 0);
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _inert = new THREE.Vector3();

const DOT_VERT = /* glsl */ `
attribute vec3 aCol;
uniform float uPR;
varying vec3 vCol;
void main(){
  vCol = aCol;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  float E = max(max(aCol.r, aCol.g), aCol.b);
  gl_PointSize = clamp(2.4 + 2.0 * log2(1.0 + E * 2.0), 2.4, 10.0) * uPR;
}`;
const DOT_FRAG = /* glsl */ `
varying vec3 vCol;
void main(){
  vec2 p = gl_PointCoord - 0.5;
  float r2 = dot(p, p) * 16.0;
  gl_FragColor = vec4(vCol * (exp(-r2 * 1.8) * 1.3 + exp(-sqrt(r2) * 2.0) * 0.05), 1.0);
}`;

export class Bodies {
  constructor(world, space) {
    this.world = world;
    this.space = space;
    this.group = new THREE.Group();
    this.group.name = 'space-bodies';
    const q = world.quality || {};
    const tier = q.tier || 'high';
    const seg = tier === 'low' ? 48 : tier === 'med' ? 72 : 112;
    this.sphereGeo = new THREE.SphereGeometry(1, seg, Math.round(seg * 0.6));
    this.shellGeo = new THREE.SphereGeometry(1, Math.round(seg * 0.7), Math.round(seg * 0.4));
    this.entries = [];
    this.dotsMax = 0;
    const sys = world.system;
    const cur = world.body;
    const all = [];
    for (const p of sys.planets) { all.push(p); for (const m of p.moons || []) all.push(m); }
    for (const b of all) {
      const isCurrent = b === cur || b.id === cur.id;
      if (isCurrent && !b.isGas && !b.rings) continue;
      try { this.entries.push(this._makeEntry(b, isCurrent)); }
      catch (e) { console.error('[space] body entry failed', b.id, e); }
    }
    // dots for far bodies
    const n = this.entries.length;
    this.dotPos = new Float32Array(n * 3);
    this.dotCol = new Float32Array(n * 3);
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(this.dotPos, 3).setUsage(THREE.DynamicDrawUsage));
    dg.setAttribute('aCol', new THREE.BufferAttribute(this.dotCol, 3).setUsage(THREE.DynamicDrawUsage));
    dg.setDrawRange(0, 0);
    this.dotMat = new THREE.ShaderMaterial({
      uniforms: { uPR: { value: 1 } },
      vertexShader: DOT_VERT, fragmentShader: DOT_FRAG,
      depthTest: true, depthWrite: false, blending: THREE.AdditiveBlending, transparent: true,
    });
    this.dotMat.userData.noCSM = true;
    this.dots = new THREE.Points(dg, this.dotMat);
    this.dots.frustumCulled = false;
    this.dots.renderOrder = -500;
    this.dots.name = 'space-body-dots';
    this.group.add(this.dots);
  }

  _commonUniforms(b) {
    return {
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunIll: { value: new THREE.Vector3(6, 6, 6) },
      uSunAng: { value: 0.005 },
      uCenter: { value: new THREE.Vector3() },
      uRadius: { value: b.radius },
      uOcc: { value: [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()] },
      uOccN: { value: 0 },
      uRingP: { value: new THREE.Vector4(0, 1, 0, 1) },
      uRingN: { value: new THREE.Vector3(0, 1, 0) },
      uRingTex: { value: null },
      uTime: { value: 0 },
      uDetail: { value: 1 },
    };
  }

  _makeEntry(b, isCurrent) {
    const e = { b, isCurrent, pivot: new THREE.Group(), spin: new THREE.Group(), local: new THREE.Vector3(), scene: new THREE.Vector3() };
    e.pivot.name = 'space-body-' + b.id;
    e.pivot.add(e.spin);
    this.group.add(e.pivot);
    // ringed bodies seen from outside: the ring plane's own tilt is folded into the (visual) spin axis
    // so the rings stay equatorial and open up more (the current body keeps its true frame)
    // (+ from a moon of a ringed giant, the rings are opened further for spectacle: real moons orbit in
    // the ring plane and would only ever see them edge-on)
    const cur = this.world.body;
    const fromMoon = b.rings && !isCurrent && cur.isMoon && !b.isMoon && b.index === cur.parent;
    const ringTilt = b.rings && !isCurrent ? (b.rings.tilt || 0) + (fromMoon ? Math.sign(b.rings.tilt || 1) * 0.42 : 0) : 0;
    e.tiltQ = new THREE.Quaternion().setFromAxisAngle(X, (b.axialTilt || 0) + ringTilt);
    const U = this._commonUniforms(b);
    e.u = U;
    // ---- rings (texture used by both the ring mesh and the planet's ring-shadow lookup)
    if (b.rings) {
      e.ringTex = ringTexture(b);
      U.uRingTex.value = e.ringTex;
      U.uRingP.value.set(b.rings.inner, b.rings.outer, 1, 1);
    }
    // ---- surface
    if (!isCurrent || b.isGas) {
      let mat;
      if (b.isGas) {
        const G = gasLook(b);
        e.look = G;
        Object.assign(U, {
          uBands: { value: G.tex }, uStorm: { value: G.storms.concat(Array(6 - G.storms.length).fill(0).map(() => new THREE.Vector4())) },
          uStormN: { value: G.storms.length }, uStormCol: { value: G.stormCol }, uJets: { value: G.jets }, uFlow: { value: G.flow },
          uTurb: { value: G.turb }, uSeedOff: { value: G.seedOff }, uHaze: { value: G.haze }, uFest: { value: G.fest },
        });
        mat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: BODY_VERT, fragmentShader: GAS_FRAG });
      } else {
        const L = rockyLook(b);
        e.look = L;
        Object.assign(U, {
          uSeedOff: { value: L.seedOff }, uFreq: { value: L.freq }, uSeaT: { value: L.seaT }, uOcean: { value: L.ocean }, uLiquid: { value: L.liquid },
          uDeep: { value: L.deep }, uShallow: { value: L.shallow }, uSand: { value: L.sand }, uGrass: { value: L.grass }, uGrass2: { value: L.grass2 },
          uRock: { value: L.rock }, uSnow: { value: L.snow }, uVeg: { value: L.veg }, uAccent: { value: L.accent },
          uVegAmt: { value: L.vegAmt }, uIce: { value: L.ice }, uCraters: { value: L.craters }, uLava: { value: L.lava }, uCrystal: { value: L.crystal }, uDesert: { value: L.desert },
          uCloudCov: { value: L.cloudCov }, uCloudStreak: { value: L.cloudStreak }, uCloudSoft: { value: L.cloudSoft }, uStorm: { value: L.storm }, uCloudCol: { value: L.cloudCol }, uCyclone: { value: L.cyclones },
          uCity: { value: L.city }, uCityCol: { value: L.cityCol }, uCityCol2: { value: L.cityCol2 },
          uAtmo: { value: L.atmo }, uAtmoCol: { value: L.atmoCol },
        });
        mat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: BODY_VERT, fragmentShader: ROCKY_FRAG });
      }
      mat.extensions = { derivatives: true };
      mat.userData.noCSM = true;
      e.mat = mat;
      e.mesh = new THREE.Mesh(this.sphereGeo, mat);
      // the current body as a gas giant has no ground: its visible "surface" is the cloud-top deck, drawn
      // just above the air shell so the rocky-planet cloud/aerial passes of the atmosphere track don't
      // cover the bands (unless that track declares it renders gas giants itself)
      e.visR = b.radius;
      if (isCurrent && b.isGas && !this.world.atmosphere?.gasGiantSurface) e.visR = b.radius + (b.atmosphere?.height || 0) * 1.02 + b.radius * 0.002;
      U.uRadius.value = e.visR;
      e.mesh.scale.setScalar(e.visR);
      e.mesh.frustumCulled = false;
      e.mesh.userData.noCSM = true;
      e.mesh.name = 'space-surface-' + b.id;
      e.spin.add(e.mesh);
      // ---- atmosphere limb shell (not for the current body: the atmosphere track owns that)
      const atm = b.atmosphere;
      if ((!isCurrent || e.visR > b.radius) && atm?.present) {
        const top = b.isGas ? 1.025 : 1.045;
        const tint = new THREE.Color(b.isGas ? (e.look.haze ? new THREE.Color(e.look.haze.x, e.look.haze.y, e.look.haze.z) : 0xa0c8ff) : (b.art?.palette?.sky || '#7ab8ff'));
        const m = Math.max(tint.r, tint.g, tint.b, 1e-3);
        const hScale = b.isGas ? 0.22 : 0.28;
        const H = (top - 1) * hScale;
        const dens = THREE.MathUtils.clamp(atm.density ?? 1, 0.1, 2);
        const tauV = (b.isGas ? 0.1 : 0.13) * dens;
        // scattering colour = art sky tint with a physical blue bias
        const br = new THREE.Vector3(tint.r / m * 0.55 + 0.08, tint.g / m * 0.75 + 0.1, tint.b / m + 0.12).multiplyScalar(tauV / H);
        e.shellU = {
          uSunDir: U.uSunDir, uSunIll: U.uSunIll, uCenter: U.uCenter, uRadius: U.uRadius, uOcc: U.uOcc, uOccN: U.uOccN, uSunAng: U.uSunAng,
          uTop: { value: top }, uBetaR: { value: br }, uBetaM: { value: (0.008 + (atm.haze ?? 0) * 0.04 + (b.isGas ? 0.035 : 0)) * dens / H },
          uMieG: { value: b.isGas ? 0.84 : (atm.mieG ?? 0.76) }, uHScale: { value: hScale },
        };
        const sm = new THREE.ShaderMaterial({
          uniforms: e.shellU, vertexShader: 'varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
          fragmentShader: SHELL_FRAG, transparent: true, depthWrite: false, depthTest: true,
          blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor,
          blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
        });
        sm.userData.noCSM = true;
        e.shellMat = sm;
        e.shell = new THREE.Mesh(this.shellGeo, sm);
        e.shell.scale.setScalar(e.visR * top);
        e.shell.frustumCulled = false;
        e.shell.renderOrder = 2;
        e.shell.name = 'space-atmo-' + b.id;
        e.shell.userData.noCSM = true;
        e.pivot.add(e.shell);
      }
    }
    // ---- rings mesh
    if (b.rings) {
      const R = b.radius;
      const inner = b.rings.inner / R, outer = b.rings.outer / R;
      const rg = new THREE.RingGeometry(inner, outer, 384, 6);
      e.ringU = {
        uRingTex: { value: e.ringTex }, uIn: { value: inner }, uOut: { value: outer },
        uCenter: U.uCenter, uN: U.uRingN, uPR: U.uRadius, uSunDir: U.uSunDir, uSunIll: U.uSunIll, uSunAng: U.uSunAng,
        uOpacity: { value: 1 }, uTime: U.uTime,
      };
      const rm = new THREE.ShaderMaterial({
        uniforms: e.ringU, vertexShader: RING_VERT, fragmentShader: RING_FRAG,
        transparent: true, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      });
      rm.extensions = { derivatives: true };
      rm.userData.noCSM = true;
      e.ringMat = rm;
      e.ring = new THREE.Mesh(rg, rm);
      e.ring.rotation.x = -Math.PI / 2;
      e.ring.scale.setScalar(R);
      e.ring.frustumCulled = false;
      e.ring.renderOrder = 3;
      e.ring.name = 'space-rings-' + b.id;
      e.ring.userData.noCSM = true;
      e.pivot.add(e.ring);
    }
    // occluder candidates: the same family (planet + its moons), plus the current body
    e.family = [];
    return e;
  }

  _bodyInertial(b, t, out) { return this.world.celestial.bodyInertial(b, t, out); }

  update(dt, t, ctx) {
    const w = this.world, cel = w.celestial, sys = w.system, cur = w.body;
    const camLocal = ctx.camLocal;
    const origin = w.origin;
    const E0 = ctx.sunIll;          // illuminance at the current body (scene units)
    const dCur = Math.max(cel.sunDistance, 1);
    let nd = 0;
    const pixAng = ctx.pixAng;
    // positions first (occluders need them)
    const focus = w.params?.spacefocus;
    for (const e of this.entries) {
      if (e.isCurrent) e.local.set(0, 0, 0);
      else cel.bodyLocal(e.b, e.local);
      // debug/inspection: ?spacefocus=<bodyId>&focusdist=3 puts that body in front of the camera
      if (focus && e.b.id === focus && !e.isCurrent) {
        w.camera.getWorldDirection(_v2);
        e.local.copy(camLocal).addScaledVector(_v2, e.b.radius * (+w.params.focusdist || 3));
      }
      e.scene.copy(e.local).sub(origin);
    }
    for (const e of this.entries) {
      const b = e.b;
      const U = e.u;
      // orientation: body frame (tilt · spin) → inertial → local
      if (e.isCurrent) { e.pivot.quaternion.identity(); e.spin.quaternion.identity(); }
      else {
        e.pivot.quaternion.copy(cel.qInv).multiply(e.tiltQ);
        const ang = (b.rotationPhase0 || 0) + (Math.PI * 2 * t) / (b.dayLength || 1800);
        e.spin.quaternion.setFromAxisAngle(Y, ang);
      }
      e.pivot.position.copy(e.local);
      // star direction & illuminance at the body
      let dStar;
      if (e.isCurrent) { U.uSunDir.value.copy(cel.sunDir); dStar = dCur; }
      else {
        this._bodyInertial(b, t, _inert);
        dStar = Math.max(_inert.length(), 1);
        cel.toLocalDir(_v.copy(_inert).multiplyScalar(-1 / dStar), U.uSunDir.value);
      }
      const fall = THREE.MathUtils.clamp(dCur / dStar, 0.2, 3);
      U.uSunIll.value.set(E0.x, E0.y, E0.z).multiplyScalar(fall);
      U.uSunAng.value = (w.star.radius || 7e5) / dStar;
      U.uCenter.value.copy(e.scene);
      U.uTime.value = t;
      U.uRingN.value.set(0, 1, 0).applyQuaternion(e.pivot.quaternion);
      // screen size → LOD / dot
      const dist = Math.max(_v.copy(e.local).sub(camLocal).length(), 1);
      const outerR = b.rings ? b.rings.outer : b.radius;
      const px = (b.radius / dist) / pixAng;
      const pxOuter = (outerR / dist) / pixAng;
      U.uDetail.value = THREE.MathUtils.clamp((px - 20) / 300, 0, 1);
      const showMesh = e.isCurrent || px > 0.9 || pxOuter > 2.5;
      if (e.mesh) e.mesh.visible = showMesh;
      if (e.shell) e.shell.visible = showMesh && px > 3;
      if (e.ring) e.ring.visible = pxOuter > 2.0;
      // occluders: family bodies + the current body (eclipses, moon shadows on the giant)
      let n = 0;
      if (showMesh && !e.isCurrent) {
        for (const o of this.entries) {
          if (o === e || n >= 4) continue;
          const ob = o.b;
          const related = (ob.isMoon && (ob.parent === b.index && !b.isMoon)) || (b.isMoon && (!ob.isMoon ? ob.index === b.parent : ob.parent === b.parent));
          if (!related) continue;
          U.uOcc.value[n++].set(o.scene.x, o.scene.y, o.scene.z, ob.radius);
        }
        // the camera's own body shadows its parent / moons (current body is not in entries unless gas)
        if (n < 4 && !this.entries.some((o) => o.isCurrent)) {
          const related = (cur.isMoon && !b.isMoon && b.index === cur.parent) || (!cur.isMoon && b.isMoon && b.parent === cur.index) || (cur.isMoon && b.isMoon && b.parent === cur.parent);
          if (related) U.uOcc.value[n++].set(-origin.x, -origin.y, -origin.z, cur.radius);
        }
      } else if (e.isCurrent) {
        for (const o of this.entries) {
          if (o === e || n >= 4) continue;
          if (o.b.isMoon && o.b.parent === b.index) U.uOcc.value[n++].set(o.scene.x, o.scene.y, o.scene.z, o.b.radius);
        }
      }
      U.uOccN.value = n;
      // far body → dot (a "wandering star"): flux of a lit disk spread over one pixel
      if (!showMesh || (px < 1.5 && !e.isCurrent)) {
        _v2.copy(e.local).sub(camLocal).normalize();                                 // view direction
        const phase = 0.5 + 0.5 * (-_v2.dot(U.uSunDir.value));                        // 1 = full
        const alb = e.look?.albedo ?? 0.3;
        const rad = alb / Math.PI * phase * phase;
        const cover = Math.PI * Math.pow(Math.max(b.radius / dist, (outerR / dist) * 0.35), 2) / (pixAng * pixAng);
        const I = Math.min(rad * cover * 6, 40);
        if (I > 0.004) {
          const c = e.b.isGas && e.look?.haze ? e.look.haze : null;
          this.dotPos[nd * 3] = e.local.x; this.dotPos[nd * 3 + 1] = e.local.y; this.dotPos[nd * 3 + 2] = e.local.z;
          this.dotCol[nd * 3] = I * U.uSunIll.value.x / 6 * (c ? c.x : 1);
          this.dotCol[nd * 3 + 1] = I * U.uSunIll.value.y / 6 * (c ? c.y : 0.95);
          this.dotCol[nd * 3 + 2] = I * U.uSunIll.value.z / 6 * (c ? c.z : 0.88);
          nd++;
        }
      }
    }
    this.dotMat.uniforms.uPR.value = ctx.pixelRatio;
    const dg = this.dots.geometry;
    dg.setDrawRange(0, nd);
    if (nd) { dg.attributes.position.needsUpdate = true; dg.attributes.aCol.needsUpdate = true; }
  }

  /** Fraction (0..1) of the star disk visible from a planet-local point, past the system's bodies. */
  sunVisibility(localPos, cel) {
    let v = 1;
    const L = cel.sunDir;
    const ang = (this.world.star.radius || 7e5) / Math.max(cel.sunDistance, 1);
    for (const e of this.entries) {
      if (e.isCurrent) continue;
      _v.copy(e.local).sub(localPos);
      const d = _v.length();
      const along = _v.dot(L);
      if (along <= 0) continue;
      const sep = Math.acos(THREE.MathUtils.clamp(along / d, -1, 1));
      const ro = Math.asin(Math.min(1, e.b.radius / d));
      if (sep > ro + ang) continue;
      let x = THREE.MathUtils.clamp((sep - Math.abs(ro - ang)) / Math.max(ro + ang - Math.abs(ro - ang), 1e-9), 0, 1);
      x = x * x * (3 - 2 * x);
      const full = ro >= ang ? 0 : 1 - (ro * ro) / (ang * ang);
      v *= full + (1 - full) * x;
    }
    return v;
  }

  dispose() {
    this.sphereGeo.dispose(); this.shellGeo.dispose();
    for (const e of this.entries) {
      e.mat?.dispose(); e.shellMat?.dispose(); e.ringMat?.dispose(); e.ring?.geometry.dispose();
      e.ringTex?.dispose(); e.look?.tex?.dispose?.();
    }
    this.dots.geometry.dispose(); this.dotMat.dispose();
  }
}
