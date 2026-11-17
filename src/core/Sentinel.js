// Crash sentinel. A page the browser kills — out of memory (iOS "this webpage was reloaded", an Android
// renderer crash) — gets no chance to run code, so the next page in the same tab finds out instead: while the
// game is visible, sessionStorage holds a small "alive" record ('rv-alive': tier, mode, time); it is removed
// when the page is hidden or unloads (pagehide, visibilitychange, before a deliberate reload). A boot that
// still finds it follows a page that died in the foreground, and boots one tier lower (Quality.detectQuality
// crashTier: 64³ cosmic web, `quality.safe`) instead of crashing again at the same quality. The lowered tier
// is remembered for the rest of the tab's session ('rv-cap') unless the player picks a quality in the menu.
//
// Pages hidden in the background are disarmed, so a tab the OS discards while the player is in another app
// does not count. Storage can be missing or throw (private modes, sandboxed iframes): every access is guarded
// and the sentinel then simply does nothing. Shot mode (?shot=1) never uses it.
const ALIVE = 'rv-alive', CAP = 'rv-cap';

function store() { try { return window.sessionStorage || null; } catch (_) { return null; } }
function read(k) { try { const v = store()?.getItem(k); return v ? JSON.parse(v) : null; } catch (_) { return null; } }
function write(k, v) { try { store()?.setItem(k, JSON.stringify(v)); } catch (_) { /* full / blocked */ } }
function remove(k) { try { store()?.removeItem(k); } catch (_) { /* blocked */ } }

export const Sentinel = {
  info: null,         // what the alive record says about this page { tier, mode, t, n }
  armed: false,
  clean: false,       // a deliberate exit (reload at another quality): never re-armed
  _installed: false,

  /**
   * At boot, before the quality is detected: did the previous page in this tab die?
   * Returns { crashed, prev: { tier, mode, t, n } | null, cap: tier | null }.
   */
  check() {
    const prev = read(ALIVE);
    const cap = read(CAP)?.tier ?? null;
    return { crashed: !!(prev && prev.tier), prev: prev || null, cap };
  },

  /** Start watching this page (call once the quality is known). `crashes`: consecutive crashes so far. */
  start(info, crashes = 0) {
    this.info = { tier: info.tier, mode: info.mode ?? null, t: Date.now(), n: crashes };
    if (this._installed) return;
    this._installed = true;
    try {
      window.addEventListener('pagehide', () => this.disarm());
      window.addEventListener('pageshow', () => { if (document.visibilityState !== 'hidden') this.arm(); });
      document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') this.disarm(); else this.arm(); });
    } catch (_) { /* no window */ }
    if (typeof document === 'undefined' || document.visibilityState !== 'hidden') this.arm();
  },

  arm() {
    if (this.clean || !this.info) return;
    this.info.t = Date.now();
    write(ALIVE, this.info);
    this.armed = true;
  },

  disarm() {
    remove(ALIVE);
    this.armed = false;
  },

  /** Keep the record current (tier lowered at run time, mode switched) so a later crash lowers from here. */
  update(fields) {
    if (!this.info) return;
    Object.assign(this.info, fields);
    if (this.armed) write(ALIVE, this.info);
  },

  /** Highest tier for later boots in this tab (auto-detection only; an explicit ?q= wins). */
  setCap(tier) { if (tier) write(CAP, { tier, t: Date.now() }); else remove(CAP); },

  /** A deliberate exit (reload at another quality, navigation): the next boot is not a crash. */
  markCleanExit() {
    this.clean = true;
    this.disarm();
  },
};
