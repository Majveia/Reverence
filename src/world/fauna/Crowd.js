// Crowd — renders every visible individual of one species with 1–2 instanced draw calls
// (LOD0 near + LOD1 far) and GPU skinning from a per-frame bone texture.
// Rows [0, n0) are LOD0 instances, rows [n0, n0+n1) LOD1 instances.
import * as THREE from 'three';
import { createLookUniforms, createCreatureMaterials } from './material.js';

function instanced(g) {
  const ig = new THREE.InstancedBufferGeometry();
  ig.index = g.index;
  for (const [k, a] of Object.entries(g.attributes)) ig.setAttribute(k, a);
  ig.instanceCount = 0;
  ig.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  return ig;
}

export class Crowd {
  /**
   * @param parent THREE.Object3D (fauna root, positioned at the floating origin)
   * @param o { name, bones: number, pivots: Float32Array(nb*3), lods: [BufferGeometry, BufferGeometry?], look, castShadow, transparent }
   */
  constructor(parent, o) {
    this.name = o.name;
    this.nb = o.bones;
    this.pivots = o.pivots;
    this.width = 1 + 2 * this.nb;
    this.capacity = 0;
    this.tex = null;
    this.data = null;
    this._grow(o.capacity ?? 16);
    this.look = createLookUniforms(this.tex, o.look);
    this.meshes = [];
    this.rowOffsets = [];
    this.lists = [];
    this.geoms = o.lods.filter(Boolean);
    this.geoms.forEach((g, i) => {
      const off = { value: 0 };
      const { material, depth } = createCreatureMaterials(this.look, off, { transparent: !!o.transparent, opacity: o.opacity });
      const mesh = new THREE.Mesh(instanced(g), material);
      mesh.name = `fauna:${o.name}:lod${i}`;
      mesh.frustumCulled = false;
      mesh.castShadow = !!o.castShadow && i === 0;
      mesh.receiveShadow = !o.transparent;
      mesh.customDepthMaterial = depth;
      mesh.visible = false;
      mesh.matrixAutoUpdate = false;
      if (o.renderOrder) mesh.renderOrder = o.renderOrder;
      parent.add(mesh);
      this.meshes.push(mesh);
      this.rowOffsets.push(off);
      this.lists.push([]);
    });
    this.lodCount = this.meshes.length;
    this.drawn = 0;
  }

  _grow(n) {
    let cap = Math.max(8, this.capacity);
    while (cap < n) cap *= 2;
    if (cap === this.capacity) return;
    const old = this.tex;
    this.capacity = cap;
    this.data = new Float32Array(this.width * cap * 4);
    this.tex = new THREE.DataTexture(this.data, this.width, cap, THREE.RGBAFormat, THREE.FloatType);
    this.tex.minFilter = THREE.NearestFilter; this.tex.magFilter = THREE.NearestFilter;
    this.tex.generateMipmaps = false;
    this.tex.needsUpdate = true;
    if (this.look) this.look.uBones.value = this.tex;
    old?.dispose();
  }

  begin() { for (const l of this.lists) l.length = 0; }
  /** queue a creature for drawing at a LOD (clamped to available LODs) */
  add(c, lod) { this.lists[Math.min(lod, this.lodCount - 1)].push(c); }

  /** Write rows & set instance counts. origin: planet-local floating origin (Vector3). */
  commit(origin) {
    let total = 0;
    for (const l of this.lists) total += l.length;
    if (total > this.capacity) this._grow(total);
    const d = this.data, W = this.width, piv = this.pivots, nb = this.nb;
    const ox = origin.x, oy = origin.y, oz = origin.z;
    let row = 0;
    for (let li = 0; li < this.lodCount; li++) {
      const list = this.lists[li];
      this.rowOffsets[li].value = row;
      for (let k = 0; k < list.length; k++, row++) {
        const c = list[k];
        let o = row * W * 4;
        d[o] = c.seed; d[o + 1] = c.glow; d[o + 2] = c.fade; d[o + 3] = c.alert;
        o += 4;
        const wq = c.wq, wp = c.wp, s0 = c.scale, bs = c.bs;
        // pose may be a few frames old (LOD update rate): shift it to the current root position
        const pr = c.poseRoot;
        const sx = pr ? c.pos[0] - pr[0] - ox : -ox, sy = pr ? c.pos[1] - pr[1] - oy : -oy, sz = pr ? c.pos[2] - pr[2] - oz : -oz;
        for (let b = 0; b < nb; b++, o += 8) {
          const qx = wq[b * 4], qy = wq[b * 4 + 1], qz = wq[b * 4 + 2], qw = wq[b * 4 + 3];
          const s = bs ? s0 * bs[b] : s0;
          const px = piv[b * 3] * s, py = piv[b * 3 + 1] * s, pz = piv[b * 3 + 2] * s;
          // rotate pivot by q
          const tx = 2 * (qy * pz - qz * py), ty = 2 * (qz * px - qx * pz), tz = 2 * (qx * py - qy * px);
          const rx = px + qw * tx + (qy * tz - qz * ty), ry = py + qw * ty + (qz * tx - qx * tz), rz = pz + qw * tz + (qx * ty - qy * tx);
          d[o] = qx; d[o + 1] = qy; d[o + 2] = qz; d[o + 3] = qw;
          d[o + 4] = wp[b * 3] + sx - rx; d[o + 5] = wp[b * 3 + 1] + sy - ry; d[o + 6] = wp[b * 3 + 2] + sz - rz; d[o + 7] = s;
        }
      }
      const mesh = this.meshes[li];
      mesh.geometry.instanceCount = list.length;
      mesh.visible = list.length > 0;
    }
    this.drawn = total;
    if (total > 0) this.tex.needsUpdate = true;   // capacity tracks demand (pow2) → small uploads
  }

  dispose() {
    for (const m of this.meshes) {
      m.removeFromParent();
      m.geometry.dispose();
      m.material.dispose();
      m.customDepthMaterial?.dispose();
    }
    for (const g of this.geoms) g.dispose();
    this.tex?.dispose();
  }
}
