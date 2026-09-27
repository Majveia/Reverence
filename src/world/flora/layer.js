// InstanceLayer — one draw call: a model geometry drawn N times via InstancedBufferGeometry.
// The mesh sits at an "anchor" (planet-local, float64 on the CPU); instance offsets are stored
// relative to it (small float32 numbers) so there is no precision loss anywhere on the planet.
// Buffers are rebuilt in bulk (begin → push… → end); nothing is allocated per frame.
import * as THREE from 'three';

const _v = new THREE.Vector3();

export class InstanceLayer {
  /**
   * @param {THREE.BufferGeometry} geometry model geometry (shared, not owned)
   * @param {THREE.Material} material
   * @param {THREE.Material|null} depthMaterial
   * @param {object} o { capacity, name, castShadow, receiveShadow, parent, renderOrder, boundsPad }
   */
  constructor(geometry, material, depthMaterial, o = {}) {
    this.name = o.name || 'flora-layer';
    this.capacity = Math.max(16, o.capacity || 256);
    this.maxCapacity = o.maxCapacity || 1 << 20;
    this.src = geometry;
    this.boundsPad = o.boundsPad ?? (geometry.boundingSphere ? geometry.boundingSphere.radius : 10);
    this.geometry = null;
    this.material = material;
    this.depthMaterial = depthMaterial;
    this.anchor = new THREE.Vector3();
    this.count = 0;
    this._alloc(this.capacity);
    this.mesh = new THREE.Mesh(this.geometry, material);
    this.mesh.name = this.name;
    this.mesh.castShadow = !!o.castShadow;
    this.mesh.receiveShadow = o.receiveShadow !== false;
    this.mesh.frustumCulled = true;
    this.mesh.matrixAutoUpdate = true;
    if (depthMaterial) this.mesh.customDepthMaterial = depthMaterial;
    this.mesh.visible = false;
    if (o.renderOrder !== undefined) this.mesh.renderOrder = o.renderOrder;
    o.parent?.add(this.mesh);
    this._min = [0, 0, 0]; this._max = [0, 0, 0];
  }

  _alloc(cap) {
    const g = new THREE.InstancedBufferGeometry();
    g.index = this.src.index;
    for (const [k, a] of Object.entries(this.src.attributes)) g.setAttribute(k, a);
    this.pos = new Float32Array(cap * 4);
    this.rot = new Float32Array(cap * 4);
    this.dat = new Float32Array(cap * 4);
    this.aPos = new THREE.InstancedBufferAttribute(this.pos, 4).setUsage(THREE.DynamicDrawUsage);
    this.aRot = new THREE.InstancedBufferAttribute(this.rot, 4).setUsage(THREE.DynamicDrawUsage);
    this.aDat = new THREE.InstancedBufferAttribute(this.dat, 4).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('iPos', this.aPos);
    g.setAttribute('iRot', this.aRot);
    g.setAttribute('iData', this.aDat);
    g.instanceCount = 0;
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);
    g.boundingBox = new THREE.Box3();
    const old = this.geometry;
    this.geometry = g;
    this.capacity = cap;
    if (old) {
      // shared model attributes/index must survive: detach them before disposing the old wrapper
      old.index = null;
      for (const k of Object.keys(this.src.attributes)) old.deleteAttribute(k);
      old.dispose();
      if (this.mesh) this.mesh.geometry = g;
    }
  }

  /** start a rebuild around a new anchor (planet-local) */
  begin(ax, ay, az) {
    this.anchor.set(ax, ay, az);
    this.count = 0;
    this._min[0] = this._min[1] = this._min[2] = Infinity;
    this._max[0] = this._max[1] = this._max[2] = -Infinity;
  }

  /** px,py,pz planet-local; q quaternion array/typed slot; s scale; d0..d3 data */
  push(px, py, pz, qx, qy, qz, qw, s, d0, d1, d2, d3) {
    if (this.count >= this.capacity) {
      if (this.capacity >= this.maxCapacity) return false;
      this._grow();
    }
    const i = this.count * 4;
    const x = px - this.anchor.x, y = py - this.anchor.y, z = pz - this.anchor.z;
    const P = this.pos, R = this.rot, D = this.dat;
    P[i] = x; P[i + 1] = y; P[i + 2] = z; P[i + 3] = s;
    R[i] = qx; R[i + 1] = qy; R[i + 2] = qz; R[i + 3] = qw;
    D[i] = d0; D[i + 1] = d1; D[i + 2] = d2; D[i + 3] = d3;
    if (x < this._min[0]) this._min[0] = x; if (x > this._max[0]) this._max[0] = x;
    if (y < this._min[1]) this._min[1] = y; if (y > this._max[1]) this._max[1] = y;
    if (z < this._min[2]) this._min[2] = z; if (z > this._max[2]) this._max[2] = z;
    this.count++;
    return true;
  }

  _grow() {
    const n = Math.min(this.maxCapacity, Math.ceil(this.capacity * 1.6));
    const P = this.pos, R = this.rot, D = this.dat;
    this._alloc(n);
    this.pos.set(P); this.rot.set(R); this.dat.set(D);
  }

  /** finish a rebuild: upload used range, update bounds + draw count */
  end(maxScale = 1) {
    const g = this.geometry;
    g.instanceCount = this.count;
    this.mesh.position.copy(this.anchor);
    this.mesh.visible = this.count > 0;
    if (this.count > 0) {
      const n = this.count * 4;
      for (const a of [this.aPos, this.aRot, this.aDat]) {
        a.clearUpdateRanges();
        a.addUpdateRange(0, n);
        a.needsUpdate = true;
      }
      const pad = this.boundsPad * maxScale;
      g.boundingBox.min.set(this._min[0] - pad, this._min[1] - pad, this._min[2] - pad);
      g.boundingBox.max.set(this._max[0] + pad, this._max[1] + pad, this._max[2] + pad);
      g.boundingBox.getBoundingSphere(g.boundingSphere);
    }
  }

  /** copy another layer's content (used for double-buffered background rebuilds) */
  clear() { this.count = 0; this.geometry.instanceCount = 0; this.mesh.visible = false; }

  dispose() {
    const g = this.geometry;
    g.index = null;
    for (const k of Object.keys(this.src.attributes)) g.deleteAttribute(k);
    g.dispose();
    this.mesh.removeFromParent();
  }
}

export { _v as _layerTmp };
