// Quality tiers. Every track must scale its cost with these knobs so the universe
// runs on phones (low/med) and shines on desktops (high/ultra).
//
// Read via engine.quality: { tier, pixelRatio, msaa, particleScale, shadows, shadowMapSize,
//   terrainDetail, drawDistance, volumetrics, floraDensity, ssao, maxFPS }
// plus the device: { mobile (phones and tablets), tablet, touch, software, gpu, deviceMemory (GB),
//   memBudget (rough MB the page may use, GPU + JS, before the browser is likely to kill it),
//   cosmicN (cosmic web lattice: 128 or 64), safe (booted after a crash: smallest memory footprint) }
//
// Tier policy (auto-detected; ?q= overrides):
//   phones and tablets (iPads too, whatever their UA)   'med'; 'low' with little memory (deviceMemory <= 4,
//                                                       where the browser says) or a weak GPU (older Adreno,
//                                                       Mali, PowerVR …)
//   desktops                                            Intel / older mobile-class GPUs 'med', big discrete GPUs
//                                                       and Apple Pro/Max 'ultra', everything else 'high'
//   software GL (headless captures)                     'high' with the capture profile below
// The tier can drop at run time (engine.degrade(): GPU reset, failed allocation) and at boot after the page
// was killed (core/Sentinel.js); quality objects are then rebuilt in place with applyTier().

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

export const TIER_ORDER = ['low', 'med', 'high', 'ultra'];
/** The next tier down ('low' stays 'low'; unknown names count as 'low'). */
export function lowerTier(name) { return TIER_ORDER[Math.max(0, TIER_ORDER.indexOf(name) - 1)]; }
/** The lower of two tiers (an unknown name is ignored). */
export function minTier(a, b) {
  const ia = TIER_ORDER.indexOf(a), ib = TIER_ORDER.indexOf(b);
  if (ia < 0) return b; if (ib < 0) return a;
  return TIER_ORDER[Math.min(ia, ib)];
}

const ua = () => (typeof navigator !== 'undefined' && navigator.userAgent) || '';

export function isTouchDevice() {
  return (typeof navigator !== 'undefined') && (navigator.maxTouchPoints > 0 || 'ontouchstart' in window);
}

/** iPadOS 13+ Safari (and app web views) report a desktop Mac UA; a Mac itself never reports touch points. */
export function isIPad() {
  return /iPad/.test(ua()) || (/Macintosh/.test(ua()) && isTouchDevice());
}

/** Tablets: iPads, Android tablets (no "Mobile" token), Kindle / Silk / PlayBook. Mobile-class, big screen. */
export function isTablet() {
  const u = ua();
  return isIPad() || (/Android/i.test(u) && !/Mobile/i.test(u)) || /Tablet|Silk|Kindle|PlayBook/i.test(u);
}

/** Phones and tablets: battery-powered, shared memory, a browser that kills big pages. */
export function isMobile() {
  return /Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua()) || isIPad() || (isTouchDevice() && Math.min(screen.width, screen.height) < 900);
}

// mobile GPUs too weak for 'med': Adreno 2xx-5xx and 60x/61x, Mali-4xx / T-series / G31-G72, every PowerVR,
// Vivante, VideoCore, old Tegra
const WEAK_MOBILE_GPU = /Adreno[^0-9]*([2-5]\d\d|6[01]\d)\b|Mali-(4\d\d|T\d|G(31|51|52|57|71|72)\b)|PowerVR|SGX|Vivante|VideoCore|Tegra [2-4]\b/i;

/** What the device is (GPU string, memory, form factor). Computed once at boot; tier changes keep it. */
export function detectDevice(renderer) {
  let gpu = '';
  try {
    const gl = renderer?.getContext();
    const dbg = gl?.getExtension('WEBGL_debug_renderer_info');
    gpu = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : '';
  } catch (_) { /* ignore */ }
  const software = /SwiftShader|llvmpipe|Software/i.test(gpu);
  let full = false;
  try { full = new URL(window.location.href).searchParams.get('full') === '1'; } catch (_) { /* ignore */ }
  const mobile = isMobile(), tablet = mobile && isTablet(), touch = isTouchDevice();
  // navigator.deviceMemory (GB, Chromium only, capped at 8). A desktop that does not say counts as 8, a
  // phone or tablet as 4 (iPhones and iPads: 4-8 GB, and the tab gets a fraction of it)
  const dmRaw = typeof navigator !== 'undefined' && Number.isFinite(navigator.deviceMemory) && navigator.deviceMemory > 0 ? navigator.deviceMemory : null;
  const deviceMemory = dmRaw ?? (mobile ? 4 : 8);
  return { gpu, software, full, mobile, tablet, touch, dmRaw, deviceMemory };
}

/** The tier this device gets when none is requested. */
export function autoTier(dev) {
  const gpu = dev.gpu;
  if (dev.mobile) {
    // phones/tablets: little memory (where the browser says) or an old GPU → 'low'; the rest — Apple GPUs
    // included — 'med' (a mobile GPU shares the phone's memory and its thermal budget)
    if ((dev.dmRaw !== null && dev.dmRaw <= 4) || WEAK_MOBILE_GPU.test(gpu)) return 'low';
    return 'med';
  }
  if (dev.software) return 'high'; // headless capture: keep visuals honest
  if (/Intel|Mali|Adreno [1-5]|PowerVR/i.test(gpu)) return 'med';
  // (base Apple M chips — MacBook Air class — stay 'high': ultra's 2x Retina buffers swamp them)
  if (/RTX|RX 6|RX 7|RX 9|M[1-9] (Pro|Max|Ultra)/i.test(gpu)) return 'ultra';
  return 'high';
}

/** Build the quality object for tier `name` on device `dev`. `safe`: booted after a crash (see Sentinel). */
export function qualityFor(name, dev, { safe = false } = {}) {
  const q = { ...TIERS[name] };
  q.pixelRatio = Math.min(window.devicePixelRatio || 1, q.pixelRatioCap);
  // Software GL (headless capture): MSAA roughly doubles frame cost; use the FXAA path instead.
  q.software = dev.software;
  if (dev.software) {
    q.msaa = 0;
    // Software-capture profile: CPU rasterization makes multi-million-triangle frames take minutes.
    // Keep the look but thin geometry-heavy systems. ?full=1 forces the real tier (hero shots).
    if (!dev.full) {
      q.floraDensity = Math.min(q.floraDensity, 0.45);
      q.terrainDetail = Math.min(q.terrainDetail, 0.85);
      q.shadowMapSize = Math.min(q.shadowMapSize, 1024);
      q.captureProfile = true;
    }
  }
  q.mobile = dev.mobile;
  q.touch = dev.touch;
  q.tablet = dev.tablet;
  q.gpu = dev.gpu;
  q.deviceMemory = dev.deviceMemory;
  // rough page budget (MB, GPU + JS): iOS kills a page around 1-1.5 GB of footprint, Android Chrome a
  // background-heavy renderer far earlier on small phones; desktops have room
  const dm = dev.deviceMemory;
  q.memBudget = Math.round(dev.mobile ? (dev.tablet ? Math.min(1536, Math.max(512, dm * 256)) : Math.min(1024, Math.max(320, dm * 160)))
    : Math.min(3072, Math.max(768, dm * 320)));
  // cosmic web lattice: 128³ is ~560 MB of float textures + ~100 MB of JS — desktops with a big GPU and RAM
  // only; everything else (phones, tablets, med/low tiers, small-memory PCs, a boot after a crash) runs 64³
  q.cosmicN = !safe && (name === 'high' || name === 'ultra') && !dev.touch && dm >= 8 ? 128 : 64;
  q.safe = !!safe;
  return q;
}

/** Rebuild `q` in place for another tier (same device). Everything that reads engine.quality sees it. */
export function applyTier(q, name, opts = {}) {
  const dev = q.device || detectDevice(null);
  const next = qualityFor(TIERS[name] ? name : 'low', dev, { safe: opts.safe ?? q.safe });
  if (!('captureProfile' in next)) delete q.captureProfile;
  Object.assign(q, next);
  return q;
}

/**
 * @param {string} requested  tier name (?q=) or undefined for auto-detect
 * @param {THREE.WebGLRenderer} renderer
 * @param {object} opts  { crashTier: tier the previous page died at (boot one lower, safe), cap: highest tier
 *                         an earlier crash in this tab left (applies to auto-detection only) }
 */
export function detectQuality(requested, renderer, opts = {}) {
  const dev = detectDevice(renderer);
  let name = TIERS[requested] ? requested : autoTier(dev);
  const crashed = !!opts.crashTier;
  if (crashed) name = lowerTier(TIERS[opts.crashTier] ? opts.crashTier : name);
  else if (!TIERS[requested] && TIERS[opts.cap]) name = minTier(name, opts.cap);
  const q = qualityFor(name, dev, { safe: crashed });
  Object.defineProperty(q, 'device', { value: dev, enumerable: false });
  return q;
}
