// Player track — first-person body: the explorer's own hands at the edges of the frame.
//
//   right hand : holds the small lantern by its bail, low right in the frame (the warm accent, a real light)
//   left hand  : grips the walking staff, whose ring of light stands in the upper left of the frame
//   reach      : hold R / primary (mouse / RB) — the staff is lowered out of frame and the open left hand reaches
//                out toward the view, fingers spread (the creator's "the body in frame tells the scale and the
//                intent" frames)
// Sleeves of the wool coat run in from the frame corners. Everything hangs off the camera (camera space:
// -Z forward, +X right, +Y up), lit by the scene's sun / sky like the rest of the world; gait bob, breathing,
// and a soft lag behind fast looks keep it a body rather than a sticker. ~26 small draw calls, FP only.
import * as THREE from 'three';
import { clamp, lerp, damp, smoothstep, Spring } from './util.js';
import { getTextures } from './textures.js';
import { box } from './geo.js';

const _v = new THREE.Vector3();

function segment(a, b, r0, r1, seg = 12) {
  // cylinder from point a to point b (camera space)
  const d = new THREE.Vector3().subVectors(b, a);
  const g = new THREE.CylinderGeometry(r1, r0, d.length(), seg, 1, false);
  g.translate(0, d.length() / 2, 0);
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.clone().normalize());
  g.applyQuaternion(q); g.translate(a.x, a.y, a.z);
  return g;
}

/** A gloved fist gripping a rod along local Y: back of the hand, four curled finger rolls, thumb across. */
function makeFist(add, leather, skin, side) {
  const g = new THREE.Group();
  const back = box(0.066, 0.08, 0.052, 0.022, 3); back.translate(0, 0, 0.014); add(g, back, leather);
  for (let i = 0; i < 4; i++) {
    const y = 0.03 - i * 0.02, len = [0.044, 0.05, 0.048, 0.038][i];
    const f = new THREE.CapsuleGeometry(0.0115, len, 4, 10); f.rotateZ(Math.PI / 2); f.translate(side * 0.004, y, -0.022 - (i === 0 || i === 3 ? 0 : 0.003)); add(g, f, leather);
    const tip = new THREE.SphereGeometry(0.0085, 8, 6); tip.translate(-side * (len * 0.5 + 0.004), y, -0.006); add(g, tip, skin);
  }
  const th = new THREE.CapsuleGeometry(0.0125, 0.04, 4, 10); th.rotateZ(Math.PI / 2 - side * 0.5); th.translate(side * 0.012, 0.042, -0.026); add(g, th, leather);
  return g;
}

export class Viewmodel {
  constructor(palette, quality) {
    const P = palette;
    this.group = new THREE.Group();
    this.group.name = 'viewmodel';
    this.group.visible = false;
    const tex = getTextures(null);
    const wool = new THREE.MeshStandardMaterial({ color: P.coat, roughness: 0.95, normalMap: tex.woolNormal || null, normalScale: new THREE.Vector2(0.6, 0.6) });
    if (tex.woolNormal) wool.normalMap.channel = 0;
    const lining = new THREE.MeshStandardMaterial({ color: P.coat2, roughness: 0.95 });
    const leather = new THREE.MeshStandardMaterial({ color: P.leather, roughness: 0.6 });
    const leather2 = new THREE.MeshStandardMaterial({ color: P.strap, roughness: 0.65 });
    const brass = new THREE.MeshStandardMaterial({ color: P.brass, roughness: 0.35, metalness: 0.85 });
    const wood = new THREE.MeshStandardMaterial({ color: P.wood, roughness: 0.7 });
    const skin = new THREE.MeshStandardMaterial({ color: P.skin, roughness: 0.6 });
    const glass = new THREE.MeshBasicMaterial({ color: new THREE.Color(P.lamp).multiplyScalar(5.5) });
    const core = new THREE.MeshBasicMaterial({ color: new THREE.Color(P.glow).multiplyScalar(9.0) });
    const wrap = new THREE.MeshStandardMaterial({ color: P.wrap, roughness: 0.9 });
    this.materials = [wool, lining, leather, leather2, brass, wood, skin, glass, core, wrap];
    const add = (parent, g, m) => { const mesh = new THREE.Mesh(g, m); mesh.castShadow = false; mesh.receiveShadow = false; mesh.frustumCulled = false; parent.add(mesh); return mesh; };

    // ---------------------------------------------------------------- right arm + lantern
    this.right = new THREE.Group(); this.group.add(this.right);
    this.rightRest = new THREE.Vector3(0.29, -0.115, -0.56);
    {
      const R = this.right;
      // sleeve from the lower-right corner to the wrist (hand at the group origin)
      add(R, segment(new THREE.Vector3(0.2, -0.34, 0.24), new THREE.Vector3(0.0, -0.03, 0.045), 0.05, 0.043, 16), wool);
      const cuff = new THREE.TorusGeometry(0.044, 0.01, 6, 18); cuff.rotateX(Math.PI / 2); cuff.rotateZ(0.6); cuff.rotateX(-0.35); cuff.translate(0.012, -0.03, 0.048);
      add(R, cuff, lining);
      for (let i = 0; i < 2; i++) { const t = new THREE.TorusGeometry(0.038, 0.006, 4, 16); t.rotateX(Math.PI / 2); t.rotateZ(0.6); t.rotateX(-0.35); t.translate(0.004 - i * 0.004, -0.016 + i * 0.012, 0.032 - i * 0.01); add(R, t, wrap); }
      // fist gripping the lantern's bail (rod along local X → rotate a Y-rod fist onto it)
      const fr = makeFist(add, leather, skin, -1); fr.rotation.set(0, 0.3, Math.PI / 2); fr.position.set(0, 0.005, 0); R.add(fr);
      // lantern hanging below the fist (swings on its own spring)
      this.lamp = new THREE.Group(); this.lamp.position.set(0.012, -0.035, -0.02); R.add(this.lamp);
      const L = this.lamp;
      const bail = new THREE.TorusGeometry(0.03, 0.0035, 4, 14, Math.PI); bail.rotateZ(Math.PI); bail.translate(0, -0.005, 0); add(L, bail, brass);
      const cap = new THREE.LatheGeometry([new THREE.Vector2(0.006, 0), new THREE.Vector2(0.022, -0.012), new THREE.Vector2(0.044, -0.03), new THREE.Vector2(0.048, -0.036)], 16); cap.translate(0, -0.03, 0); add(L, cap, brass);
      const gl = new THREE.CylinderGeometry(0.036, 0.039, 0.085, 16); gl.translate(0, -0.11, 0); add(L, gl, glass);
      const fl = new THREE.SphereGeometry(0.014, 10, 8); fl.scale(1, 1.6, 1); fl.translate(0, -0.11, 0); add(L, fl, core);
      for (let i = 0; i < 4; i++) { const a = i * Math.PI / 2 + Math.PI / 4; const b = new THREE.BoxGeometry(0.007, 0.09, 0.007); b.translate(Math.sin(a) * 0.041, -0.11, Math.cos(a) * 0.041); add(L, b, brass); }
      const base = new THREE.CylinderGeometry(0.046, 0.042, 0.02, 16); base.translate(0, -0.162, 0); add(L, base, brass);
      this.lightAnchor = new THREE.Object3D(); this.lightAnchor.position.set(0, -0.11, 0.02); L.add(this.lightAnchor);
    }
    // ---------------------------------------------------------------- left arm + staff
    this.left = new THREE.Group(); this.group.add(this.left);
    this.leftRest = new THREE.Vector3(-0.31, -0.2, -0.52);
    this.leftReach = new THREE.Vector3(-0.17, -0.1, -0.47);
    {
      const Lh = this.left;
      add(Lh, segment(new THREE.Vector3(-0.2, -0.36, 0.25), new THREE.Vector3(0.0, -0.03, 0.045), 0.05, 0.043, 16), wool);
      const cuff = new THREE.TorusGeometry(0.044, 0.01, 6, 18); cuff.rotateX(Math.PI / 2); cuff.rotateZ(-0.6); cuff.rotateX(-0.35); cuff.translate(-0.012, -0.03, 0.048);
      add(Lh, cuff, lining);
      // closed fist around the staff
      this.fistL = new THREE.Group(); Lh.add(this.fistL);
      const fl = makeFist(add, leather, skin, 1); fl.rotation.set(-0.5, 0.25, 0.07); this.fistL.add(fl);
      // open hand (reach): palm + spread fingers + thumb; bare fingertips out of fingerless gloves
      this.openL = new THREE.Group(); this.openL.visible = false; this.openL.position.set(0, -0.01, 0.035); Lh.add(this.openL);
      const palm = box(0.078, 0.026, 0.085, 0.012, 2); palm.translate(0.0, 0, -0.03); add(this.openL, palm, leather);
      for (let i = 0; i < 4; i++) {
        const a = -0.32 + i * 0.2; // spread
        const len = [0.07, 0.082, 0.078, 0.062][i];
        const f = new THREE.Group(); f.position.set(-0.03 + i * 0.02, 0.0, -0.072); f.rotation.set(0.12 + i * 0.04, a, 0); this.openL.add(f);
        const g1 = new THREE.CapsuleGeometry(0.0095, len * 0.45, 4, 8); g1.rotateX(Math.PI / 2); g1.translate(0, 0, -len * 0.25); add(f, g1, leather);
        const g2 = new THREE.CapsuleGeometry(0.0085, len * 0.45, 4, 8); g2.rotateX(Math.PI / 2 + 0.25); g2.translate(0, -0.006, -len * 0.7); add(f, g2, skin);
      }
      const tb = new THREE.CapsuleGeometry(0.011, 0.045, 4, 8); tb.rotateX(Math.PI / 2); tb.rotateY(0.9); tb.translate(0.045, -0.006, -0.05); add(this.openL, tb, leather);
      // the staff (its own group so it can be lowered when the hand lets go)
      this.staff = new THREE.Group(); this.group.add(this.staff);
      const dir = new THREE.Vector3(0.07, 1, -0.55).normalize();
      this.staffDir = dir;
      const s0 = new THREE.Vector3().copy(dir).multiplyScalar(-1.1), s1 = new THREE.Vector3().copy(dir).multiplyScalar(0.95);
      add(this.staff, segment(s0, s1, 0.019, 0.016, 10), wood);
      // carved head: brass ring with a glowing core
      const top = s1.clone().addScaledVector(dir, 0.06);
      const ring = new THREE.TorusGeometry(0.055, 0.009, 6, 24);
      const qn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
      ring.applyQuaternion(qn); ring.translate(top.x, top.y, top.z); add(this.staff, ring, brass);
      const c = new THREE.SphereGeometry(0.016, 10, 8); c.translate(top.x, top.y, top.z); add(this.staff, c, core);
      const lash = new THREE.TorusGeometry(0.022, 0.005, 4, 12); lash.applyQuaternion(qn); const lp = dir.clone().multiplyScalar(0.12); lash.translate(lp.x, lp.y, lp.z); add(this.staff, lash, leather2);
    }
    // ---- motion state
    this.bob = 0; this.t = 0;
    this.reach = 0;
    this.lagX = new Spring(0, 9, 0.7); this.lagY = new Spring(0, 9, 0.7);
    this.lampSwing = new Spring(0, 7, 0.25); this.lampSwingZ = new Spring(0, 7, 0.25);
    this.visibleW = 0;
  }

  /**
   * @param ctx { visible, speed, phase (gait 0..1), lookX, lookY (rad this frame), reach (bool), state, aspect }
   */
  update(dt, ctx) {
    const show = !!ctx.visible;
    this.group.visible = show;
    if (!show || dt <= 0) return;
    this.t += dt;
    const sp = ctx.speed || 0;
    const walk = smoothstep(0.2, 2, sp), run = smoothstep(4, 9, sp);
    const ph = (ctx.phase || 0) * Math.PI * 2;
    const swim = ctx.state === 'swim' ? 1 : 0, air = ctx.state === 'glide' || ctx.state === 'air' ? 1 : 0;
    // look lag: the hands trail a fast turn a little, then settle
    this.lagX.update(clamp(-(ctx.lookX || 0) * 2.2, -0.06, 0.06), dt);
    this.lagY.update(clamp(-(ctx.lookY || 0) * 2.2, -0.05, 0.05), dt);
    const bobY = -Math.abs(Math.sin(ph)) * 0.018 * walk * (1 + run) + Math.sin(this.t * 1.7) * 0.004;
    const bobX = Math.sin(ph) * 0.012 * walk;
    this.reach = damp(this.reach, ctx.reach ? 1 : 0, ctx.reach ? 2.4 : 3.2, dt);
    const rc = smoothstep(0, 1, this.reach);
    // wide screens push the hands toward the frame edges
    const wide = clamp((ctx.aspect || 1.78) / 1.78, 0.75, 1.3);
    // right hand + lantern
    this.right.position.copy(this.rightRest); this.right.position.x *= wide;
    this.right.position.x += bobX + this.lagX.x; this.right.position.y += bobY + this.lagY.x - 0.08 * swim - 0.05 * air;
    this.right.rotation.set(0.15 + run * 0.1, -0.25, 0.05);
    this.lampSwing.update(clamp(this.lagX.x * 6 + Math.sin(ph) * 0.12 * walk, -0.5, 0.5), dt);
    this.lampSwingZ.update(clamp(-this.lagY.x * 5 + Math.cos(ph * 2) * 0.06 * walk, -0.4, 0.4), dt);
    this.lamp.rotation.set(this.lampSwingZ.x - 0.1 - run * 0.1, 0.25, this.lampSwing.x);
    // left hand: staff grip ↔ reach toward the view
    _v.copy(this.leftRest); _v.x *= wide; // grip position
    this.left.position.lerpVectors(_v, this.leftReach, rc);
    this.left.position.x += -bobX * 0.8 + this.lagX.x; this.left.position.y += bobY * 0.9 + this.lagY.x - 0.08 * swim + Math.sin(this.t * 0.9) * 0.006 * rc;
    this.left.rotation.set(lerp(0.1, 0.12, rc), lerp(0.2, -0.1, rc), lerp(0.0, -0.5, rc));
    const open = rc > 0.45;
    this.fistL.visible = !open; this.openL.visible = open;
    // the staff stays in the fist; when the hand lets go it is lowered out of frame to the left
    this.staff.position.copy(_v);
    this.staff.position.x += -bobX * 0.8 + this.lagX.x - 0.25 * rc; this.staff.position.y += bobY * 0.9 + this.lagY.x - 0.08 * swim - 0.55 * rc;
    this.staff.rotation.set(0, 0, 0.35 * rc);
    // swimming / gliding: the staff is stowed
    this.staff.visible = swim < 0.5 && air < 0.5;
    this.left.visible = true;
  }

  dispose() {
    this.group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    for (const m of this.materials) m.dispose();
  }
}
