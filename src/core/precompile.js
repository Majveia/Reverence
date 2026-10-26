// Shader warm-up behind a transition veil.
//
// A planet visit links ~90 programs: the world's scene materials, and ~55 full-screen passes (post-processing,
// atmosphere, clouds, light shafts, reflections) that are drawn with their own quads and so are invisible to
// renderer.compile(scene). Linked one by one on first use, each blocks the GPU process (and with it every
// animation on the page, the warp included) — seconds on some drivers. With KHR_parallel_shader_compile,
// renderer.compileAsync() lets the driver link them all at once in background threads.
//
// precompileAll() compiles the scene, then *harvests* every ShaderMaterial reachable from the given owners
// (pipeline, effects, world subsystems: own properties, arrays and maps, a few levels deep) that has no program
// yet, and compiles those on a full-screen triangle with a render target bound (passes draw into targets, which
// selects the same program variant). A harvested material whose defines change before its first draw just
// compiles twice — never wrong, only wasted work.
import * as THREE from 'three';

const SKIP = new Set(['parent', 'children', 'renderer', 'engine', 'world', 'director', 'ui', 'audio', 'universe', 'input']);

/** ShaderMaterials (and other materials) reachable from `roots` through plain properties, up to `depth` levels. */
export function harvestMaterials(roots, depth = 4) {
  const out = new Set(), seen = new Set();
  const visit = (o, d) => {
    if (!o || typeof o !== 'object' || seen.has(o)) return;
    seen.add(o);
    if (o.isMaterial) { out.add(o); return; }
    if (d <= 0 || o.isObject3D || o.isTexture || o.isBufferGeometry || o.isRenderTarget || o.isWebGLRenderTarget
      || ArrayBuffer.isView(o) || o instanceof ArrayBuffer || (typeof Node !== 'undefined' && o instanceof Node)) return;
    if (Array.isArray(o)) { if (o.length <= 256) for (const v of o) visit(v, d - 1); return; }
    if (o instanceof Map) { for (const v of o.values()) visit(v, d - 1); return; }
    if (o instanceof Set) { for (const v of o) visit(v, d - 1); return; }
    for (const k of Object.keys(o)) { if (!SKIP.has(k)) { let v; try { v = o[k]; } catch (_) { continue; } visit(v, d - 1); } }
  };
  for (const r of roots) visit(r, depth + 1);
  return out;
}

/**
 * Compile `scene` (into `target`: the program variant depends on the bound render target's colour space) and
 * every not-yet-compiled material harvested from `owners`. Resolves when the driver has finished
 * (compileAsync); `sync: true` compiles synchronously (tests, drivers without parallel compile).
 */
export async function precompileAll(renderer, { scene, camera, target = null, owners = [], sync = false } = {}) {
  const stats = { scene: 0, passes: 0, before: renderer.info.programs?.length ?? 0, after: 0 };
  const props = renderer.properties;
  if (scene) {
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    try {
      if (sync) renderer.compile(scene, camera);
      else { const p = renderer.compileAsync(scene, camera); renderer.setRenderTarget(prev); await p; }
    } finally { renderer.setRenderTarget(prev); }
  }
  stats.scene = (renderer.info.programs?.length ?? 0) - stats.before;
  // full-screen passes: one triangle per material, drawn (for program selection) into a render target
  const mats = [...harvestMaterials(owners)].filter((m) => (m.isShaderMaterial || m.isRawShaderMaterial) && !props.get(m).currentProgram);
  if (mats.length) {
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    tri.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    tri.setAttribute('normal', new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    const passes = new THREE.Scene();
    for (const m of mats) { const q = new THREE.Mesh(tri, m); q.frustumCulled = false; passes.add(q); }
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: false });
    const prev = renderer.getRenderTarget();
    try {
      renderer.setRenderTarget(rt);
      if (sync) renderer.compile(passes, cam);
      else { const p = renderer.compileAsync(passes, cam); renderer.setRenderTarget(prev); await p; }
    } finally {
      renderer.setRenderTarget(prev);
      rt.dispose(); tri.dispose();
    }
  }
  stats.after = renderer.info.programs?.length ?? 0;
  stats.passes = stats.after - stats.before - stats.scene;
  return stats;
}
