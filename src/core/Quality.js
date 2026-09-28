// Quality tiers. Every track must scale its cost with these knobs so the universe
// runs on phones (low/med) and shines on desktops (high/ultra).
//
// Read via engine.quality: { tier, pixelRatio, msaa, particleScale, shadows, shadowMapSize,
//   terrainDetail, drawDistance, volumetrics, floraDensity, ssao, maxFPS }

export const TIERS = {
  low: {
    tier: 'low', pixelRatioCap: 1.0, msaa: 0, particleScale: 0.25, shadows: false, shadowMapSize: 1024,
    terrainDetail: 0.5, drawDistance: 0.5, volumetrics: false, floraDensity: 0.3, ssao: false, bloomLevels: 3,
  },
  med: {
    tier: 'med', pixelRatioCap: 1.25, msaa: 0, particleScale: 0.5, shadows: true, shadowMapSize: 2048,
    terrainDetail: 0.75, drawDistance: 0.75, volumetrics: false, floraDensity: 0.6, ssao: false, bloomLevels: 4,
  },
  high: {
    tier: 'high', pixelRatioCap: 1.5, msaa: 4, particleScale: 1.0, shadows: true, shadowMapSize: 2048,
    terrainDetail: 1.0, drawDistance: 1.0, volumetrics: true, floraDensity: 1.0, ssao: true, bloomLevels: 5,
  },
  ultra: {
    tier: 'ultra', pixelRatioCap: 2.0, msaa: 4, particleScale: 2.0, shadows: true, shadowMapSize: 4096,
    terrainDetail: 1.35, drawDistance: 1.4, volumetrics: true, floraDensity: 1.5, ssao: true, bloomLevels: 5,
  },
};

export function isTouchDevice() {
  return (typeof navigator !== 'undefined') && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window);
}

export function isMobile() {
  const ua = navigator.userAgent || '';
  return /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua) || (isTouchDevice() && Math.min(screen.width, screen.height) < 900);
}

export function detectQuality(requested, renderer) {
  let name = requested;
  let gpu = '';
  try {
    const gl = renderer?.getContext();
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
  } catch (_) { /* ignore */ }
  const software = /SwiftShader|llvmpipe|Software/i.test(gpu);
  if (!TIERS[name]) {
    if (isMobile()) name = 'med';
    else if (software) name = 'high'; // headless capture: keep visuals honest
    else if (/Intel|Mali|Adreno [1-5]|PowerVR/i.test(gpu)) name = 'med';
    else if (/RTX|RX 6|RX 7|RX 9|Apple M[2-9]|M[1-9] (Pro|Max|Ultra)/i.test(gpu)) name = 'ultra';
    else name = 'high';
  }
  const q = { ...TIERS[name] };
  q.pixelRatio = Math.min(window.devicePixelRatio || 1, q.pixelRatioCap);
  // Software GL (headless capture): MSAA roughly doubles frame cost; use the FXAA path instead.
  q.software = software;
  if (software) {
    q.msaa = 0;
    // Software-capture profile: CPU rasterization makes multi-million-triangle frames take minutes.
    // Keep the look but thin geometry-heavy systems. ?full=1 forces the real tier (hero shots).
    let full = false;
    try { full = new URL(window.location.href).searchParams.get('full') === '1'; } catch (_) { /* ignore */ }
    if (!full) {
      q.floraDensity = Math.min(q.floraDensity, 0.45);
      q.terrainDetail = Math.min(q.terrainDetail, 0.85);
      q.shadowMapSize = Math.min(q.shadowMapSize, 1024);
      q.captureProfile = true;
    }
  }
  q.mobile = isMobile();
  q.touch = isTouchDevice();
  return q;
}
