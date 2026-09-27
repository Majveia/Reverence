// Terrain subsystem (order 10). OWNED BY THE TERRAIN TRACK.
// Baseline: quadtree cube-sphere LOD, chunks built on the main thread under a time budget,
// horizon culling, skirts to hide cracks, vertex-colored biomes. The terrain track should
// upgrade this (web workers, geomorphing, triplanar detail materials, erosion, etc.).
import * as THREE from 'three';

const FACES = [
  { n: new THREE.Vector3(1, 0, 0), u: new THREE.Vector3(0, 0, -1), v: new THREE.Vector3(0, 1, 0) },
  { n: new THREE.Vector3(-1, 0, 0), u: new THREE.Vector3(0, 0, 1), v: new THREE.Vector3(0, 1, 0) },
  { n: new THREE.Vector3(0, 1, 0), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, -1) },
  { n: new THREE.Vector3(0, -1, 0), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 0, 1) },
  { n: new THREE.Vector3(0, 0, 1), u: new THREE.Vector3(1, 0, 0), v: new THREE.Vector3(0, 1, 0) },
  { n: new THREE.Vector3(0, 0, -1), u: new THREE.Vector3(-1, 0, 0), v: new THREE.Vector3(0, 1, 0) },
];
const RES = 32;          // quads per chunk side
const _d = new THREE.Vector3();

// Cube → sphere with tangent warp (more uniform cell size than naive normalize)
function cubeToDir(face, u, v, out) {
  const tu = Math.tan(u * Math.PI / 4), tv = Math.tan(v * Math.PI / 4);
  return out.copy(face.n).addScaledVector(face.u, tu).addScaledVector(face.v, tv).normalize();
}

class Node {
  constructor(face, level, u0, v0, size, parent = null) {
    this.face = face; this.level = level; this.u0 = u0; this.v0 = v0; this.size = size; this.parent = parent;
    this.children = null; this.mesh = null; this.building = false;
    this.center = cubeToDir(FACES[face], u0 + size / 2, v0 + size / 2, new THREE.Vector3());
    this.key = `${face}:${level}:${u0.toFixed(6)}:${v0.toFixed(6)}`;
  }
}

class Terrain {
  constructor(world) {
    this.world = world;
    this.surface = world.surface;
    this.R = world.body.radius;
    this.group = new THREE.Group();
    this.group.name = 'terrain';
    world.root.add(this.group);
    this.material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.92, metalness: 0.0 });
    this.roots = FACES.map((_, f) => new Node(f, 0, -1, -1, 2));
    this.queue = [];
    this.maxLevel = Math.ceil(Math.log2(this.R / 12));  // leaf chunk ~ 12-25 m
    this.splitFactor = 2.2 * (world.quality.terrainDetail ?? 1);
    this.budgetMs = world.engine.shot ? 60 : 6;
    this.meshCount = 0;
    this._camLocal = new THREE.Vector3();
  }

  nodeRadiusMeters(node) { return this.R * node.size * (Math.PI / 4) * 0.75; }

  lateUpdate() {
    if (!this.surface) return;
    this.frame = (this.frame || 0) + 1;
    const cam = this._camLocal.copy(this.world.camera.position);
    const camDist = Math.max(cam.length(), this.R + 1);
    const camDir = _d.copy(cam).normalize();
    // horizon angle from camera + margin for mountains beyond the geometric horizon
    this.horizonAngle = Math.acos(Math.min(1, this.R / camDist)) + Math.acos(Math.min(1, this.R / (this.R + this.surface.maxHeight))) + 0.03;
    // 1. ideal node set by distance
    const desired = [];
    for (const r of this.roots) this._collect(r, cam, camDir, desired);
    // 2. queue missing meshes, find nearest built ancestor as fallback
    const fallback = new Set();
    for (const n of desired) {
      n.lastUsed = this.frame;
      if (!n.mesh) {
        if (!n.building) { n.building = true; this.queue.push(n); }
        let p = n.parent;
        while (p && !p.mesh) p = p.parent;
        if (p) fallback.add(p);
      }
    }
    const draw = new Set(fallback);
    for (const n of desired) if (n.mesh) draw.add(n);
    // 3. never draw a node together with one of its ancestors (overlap)
    for (const n of [...draw]) { for (let p = n.parent; p; p = p.parent) if (draw.has(p)) { draw.delete(n); break; } }
    for (const n of draw) n.lastUsed = this.frame;
    this.desiredSet = new Set(desired);
    this._build();
    this._apply(draw);
  }

  _collect(node, cam, camDir, out) {
    const angR = node.size * (Math.PI / 4) * 0.75;
    const ang = Math.acos(Math.min(1, Math.max(-1, node.center.dot(camDir))));
    if (node.level > 1 && ang - angR > this.horizonAngle) return; // beyond horizon
    const p = node.center.clone().multiplyScalar(this.R + (node.h ?? 0));
    const dist = p.distanceTo(cam);
    node.prio = dist;
    if (node.level < this.maxLevel && dist < this.nodeRadiusMeters(node) * this.splitFactor) {
      if (!node.children) {
        const s = node.size / 2;
        node.children = [
          new Node(node.face, node.level + 1, node.u0, node.v0, s, node),
          new Node(node.face, node.level + 1, node.u0 + s, node.v0, s, node),
          new Node(node.face, node.level + 1, node.u0, node.v0 + s, s, node),
          new Node(node.face, node.level + 1, node.u0 + s, node.v0 + s, s, node),
        ];
      }
      for (const c of node.children) this._collect(c, cam, camDir, out);
    } else {
      out.push(node);
    }
  }

  _build() {
    const t0 = performance.now();
    this.queue = this.queue.filter((n) => { if (this.desiredSet.has(n)) return true; n.building = false; return false; });
    this.queue.sort((a, b) => a.level - b.level || a.prio - b.prio);
    while (this.queue.length && performance.now() - t0 < this.budgetMs) {
      const node = this.queue.shift();
      node.mesh = this._makeMesh(node);
      node.building = false;
      this.group.add(node.mesh);
    }
  }

  _apply(draw) {
    let count = 0;
    const keepFrames = 180;
    const walk = (n) => {
      if (n.mesh) {
        const vis = draw.has(n);
        n.mesh.visible = vis;
        if (vis) count++;
        else if (n.level > 2 && this.frame - (n.lastUsed || 0) > keepFrames) {
          n.mesh.geometry.dispose(); this.group.remove(n.mesh); n.mesh = null;
        }
      }
      if (n.children) {
        for (const c of n.children) walk(c);
        if (n.level > 2 && n.children.every((c) => !c.mesh && !c.children && !c.building && this.frame - (c.lastUsed || 0) > keepFrames)) n.children = null;
      }
    };
    for (const r of this.roots) walk(r);
    this.meshCount = count;
  }

  _makeMesh(node) {
    const S = this.surface, R = this.R, face = FACES[node.face];
    const N = RES + 1;
    const skirt = this.nodeRadiusMeters(node) * 0.08;
    const vCount = N * N + N * 4;
    const pos = new Float32Array(vCount * 3), nor = new Float32Array(vCount * 3), col = new Float32Array(vCount * 3);
    const centerDir = node.center;
    const ch = S.height(centerDir.x, centerDir.y, centerDir.z);
    node.h = ch;
    const center = centerDir.clone().multiplyScalar(R + ch);
    // sample grid with 1-cell border for normals
    const G = N + 2;
    const P = new Float64Array(G * G * 3);
    const H = new Float64Array(G * G);
    const d = new THREE.Vector3();
    const step = node.size / RES;
    for (let j = 0; j < G; j++) for (let i = 0; i < G; i++) {
      cubeToDir(face, node.u0 + (i - 1) * step, node.v0 + (j - 1) * step, d);
      const h = S.height(d.x, d.y, d.z);
      const k = j * G + i;
      H[k] = h;
      P[k * 3] = d.x * (R + h); P[k * 3 + 1] = d.y * (R + h); P[k * 3 + 2] = d.z * (R + h);
    }
    const c = new THREE.Color(), cRock = new THREE.Color(), tmp = {};
    S.biomeColor(10, cRock);
    const idx = (i, j) => (j + 1) * G + (i + 1);
    const nrm = new THREE.Vector3(), a = new THREE.Vector3(), b = new THREE.Vector3();
    let v = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const k = idx(i, j);
      pos[v * 3] = P[k * 3] - center.x; pos[v * 3 + 1] = P[k * 3 + 1] - center.y; pos[v * 3 + 2] = P[k * 3 + 2] - center.z;
      const kl = idx(i - 1, j), kr = idx(i + 1, j), kd = idx(i, j - 1), ku = idx(i, j + 1);
      a.set(P[kr * 3] - P[kl * 3], P[kr * 3 + 1] - P[kl * 3 + 1], P[kr * 3 + 2] - P[kl * 3 + 2]);
      b.set(P[ku * 3] - P[kd * 3], P[ku * 3 + 1] - P[kd * 3 + 1], P[ku * 3 + 2] - P[kd * 3 + 2]);
      nrm.crossVectors(a, b).normalize();
      nor[v * 3] = nrm.x; nor[v * 3 + 1] = nrm.y; nor[v * 3 + 2] = nrm.z;
      // biome color, rock on steep slopes
      const px = P[k * 3], py = P[k * 3 + 1], pz = P[k * 3 + 2];
      const rl = Math.hypot(px, py, pz);
      S.sample(px / rl, py / rl, pz / rl, tmp);
      S.biomeColor(tmp.biome, c);
      const up = (px * nrm.x + py * nrm.y + pz * nrm.z) / rl;
      const steep = Math.min(1, Math.max(0, (0.86 - up) / 0.18));
      c.lerp(cRock, steep);
      col[v * 3] = c.r; col[v * 3 + 1] = c.g; col[v * 3 + 2] = c.b;
      v++;
    }
    // skirts: duplicate edge vertices pushed down
    const edges = [];
    for (let i = 0; i < N; i++) edges.push([i, 0]);
    for (let i = 0; i < N; i++) edges.push([N - 1, i]);
    for (let i = N - 1; i >= 0; i--) edges.push([i, N - 1]);
    for (let i = N - 1; i >= 0; i--) edges.push([0, i]);
    const skirtStart = v;
    for (const [i, j] of edges) {
      const src = j * N + i;
      const k = idx(i, j);
      const px = P[k * 3], py = P[k * 3 + 1], pz = P[k * 3 + 2];
      const rl = Math.hypot(px, py, pz);
      pos[v * 3] = px - (px / rl) * skirt - center.x; pos[v * 3 + 1] = py - (py / rl) * skirt - center.y; pos[v * 3 + 2] = pz - (pz / rl) * skirt - center.z;
      nor[v * 3] = nor[src * 3]; nor[v * 3 + 1] = nor[src * 3 + 1]; nor[v * 3 + 2] = nor[src * 3 + 2];
      col[v * 3] = col[src * 3]; col[v * 3 + 1] = col[src * 3 + 1]; col[v * 3 + 2] = col[src * 3 + 2];
      v++;
    }
    const indices = [];
    for (let j = 0; j < RES; j++) for (let i = 0; i < RES; i++) {
      const a0 = j * N + i, b0 = a0 + 1, c0 = a0 + N, d0 = c0 + 1;
      indices.push(a0, b0, d0, a0, d0, c0);
    }
    const E = edges.length;
    for (let e = 0; e < E - 1; e++) {
      const [i0, j0] = edges[e], [i1, j1] = edges[e + 1];
      const t0 = j0 * N + i0, t1 = j1 * N + i1, s0 = skirtStart + e, s1 = skirtStart + e + 1;
      indices.push(t0, s0, t1, t1, s0, s1);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.setIndex(indices);
    g.computeBoundingSphere();
    const mesh = new THREE.Mesh(g, this.material);
    mesh.position.copy(center);
    mesh.receiveShadow = true;
    mesh.castShadow = node.level >= this.maxLevel - 3;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    return mesh;
  }

  isReady() { return this.queue.length === 0 && this.desiredSet !== undefined; }
  getState() { return { chunks: this.meshCount, queue: this.queue.length, maxLevel: this.maxLevel }; }
  dispose() {
    this.group.traverse((o) => o.geometry?.dispose());
    this.material.dispose();
    this.group.removeFromParent();
  }
}

export default {
  name: 'terrain',
  order: 10,
  async create(world) {
    if (!world.surface) return null;
    return new Terrain(world);
  },
};
