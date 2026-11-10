// STUB — replaced by the terrain module.  A coarse globe plus an exact high-resolution patch around the camera,
// so other modules can be developed against true ground heights (field.height) before the real LOD terrain lands.
import * as THREE from 'three';
export default function createTerrain(ctx) {
  let globe = null, patch = null, mat = null, world = null; const center = new THREE.Vector3(1e9, 0, 0); const N = 192, SIZE = 1400;
  function build(w, geo, fn) {
    const p = geo.attributes.position, col = new Float32Array(p.count * 3), s = {}, v = new THREE.Vector3();
    for (let i = 0; i < p.count; i++) { fn(i, v); v.normalize(); w.field.surface(v.x, v.y, v.z, s); const r = w.radius + s.h; p.setXYZ(i, v.x * r, v.y * r, v.z * r); col[i * 3] = s.r; col[i * 3 + 1] = s.g; col[i * 3 + 2] = s.b; }
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3)); p.needsUpdate = true; geo.computeVertexNormals(); geo.computeBoundingSphere();
  }
  function rebuildPatch(cam) {
    const { east, north, up } = world.basis(cam); center.copy(cam);
    const g = patch.geometry, R = world.radius;
    build(world, g, (i, v) => { const x = (i % (N + 1)) / N - 0.5, y = Math.floor(i / (N + 1)) / N - 0.5; v.copy(up).multiplyScalar(R).addScaledVector(east, x * SIZE).addScaledVector(north, y * SIZE); });
  }
  return {
    name: 'terrain',
    onPlanetEnter(w) {
      world = w; mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 });
      const g = new THREE.IcosahedronGeometry(1, 48), src = g.attributes.position.clone();
      build(w, g, (i, v) => v.fromBufferAttribute(src, i));
      // sink the coarse globe a little so the exact patch always wins near the camera
      const p = g.attributes.position; for (let i = 0; i < p.count; i++) { const l = Math.hypot(p.getX(i), p.getY(i), p.getZ(i)); const k = (l - 60) / l; p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k); }
      globe = new THREE.Mesh(g, mat); globe.receiveShadow = true; ctx.worldRoot.add(globe);
      patch = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, N, N), mat); patch.receiveShadow = true; patch.castShadow = true; patch.frustumCulled = false; ctx.worldRoot.add(patch);
      center.set(1e9, 0, 0);
    },
    onPlanetExit() { for (const m of [globe, patch]) if (m) { ctx.worldRoot.remove(m); m.geometry.dispose(); } mat?.dispose(); globe = patch = mat = world = null; },
    update(dt, frame) { if (world && patch && frame.altitude < 4000 && frame.camPos.distanceTo(center) > SIZE * 0.22) rebuildPatch(frame.camPos); },
  };
}
