// STUB — replaced by the space module.  Star + bodies as plain spheres so the realm is navigable.
import * as THREE from 'three';
export default function createSpace(ctx) {
  const meshes = new Map(); let starMesh = null;
  return {
    name: 'space',
    onSystemEnter(sys) {
      starMesh = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color(...sys.star.color).multiplyScalar(40) }));
      starMesh.scale.setScalar(sys.star.radius); ctx.spaceRoot.add(starMesh);
      for (const b of sys.bodies) {
        const col = b.palette ? new THREE.Color(b.palette.grass) : new THREE.Color(b.giantData?.bands[0] || '#888');
        const m = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.MeshStandardMaterial({ color: col, roughness: 1 }));
        m.scale.setScalar(b.radius); ctx.spaceRoot.add(m); meshes.set(b.id, m);
      }
    },
    update(dt, frame) {
      if (!starMesh) return;
      starMesh.position.copy(frame.star.scenePos);
      for (const rt of frame.bodies) { const m = meshes.get(rt.id); if (!m) continue; m.position.copy(rt.scenePos); m.quaternion.copy(rt.sceneQuat); m.visible = !(frame.world && frame.world.body === rt.desc && ctx.features.terrain); }
    },
    onSystemExit() { ctx.spaceRoot.clear(); meshes.clear(); starMesh = null; },
  };
}
