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
  if (!TIERS[name]) {
    if (isMobile()) name = 'med';
    else {
      name = 'high';
      try {
        const gl = renderer?.getContext();
        const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
        const r = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
        if (/SwiftShader|llvmpipe|Software/i.test(r)) name = 'high'; // headless capture: keep visuals honest
        else if (/Intel|Mali|Adreno [1-5]|PowerVR/i.test(r)) name = 'med';
        else if (/RTX|RX 6|RX 7|RX 9|Apple M[2-9]|M[1-9] (Pro|Max|Ultra)/i.test(r)) name = 'ultra';
      } catch (_) { /* ignore */ }
    }
  }
  const q = { ...TIERS[name] };
  q.pixelRatio = Math.min(window.devicePixelRatio || 1, q.pixelRatioCap);
  q.mobile = isMobile();
  q.touch = isTouchDevice();
  return q;
}
