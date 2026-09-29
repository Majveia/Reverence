// Pause menu: glass panel with resume, map, photo mode, share link, settings (quality tier,
// look sensitivity, invert Y, volume) and a controls reference that adapts to the device.
// Settings persist in localStorage ('rv.settings'); quality changes reload at the same place.
import { icon } from './icons.js';
import { glyphFor, escapeHtml } from './glyphs.js';
import { buildQuery, Params } from '../core/Params.js';

const KEY = 'rv.settings';
const TIERS = ['low', 'med', 'high', 'ultra'];

export function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (_) { s = {}; }
  return { sens: 1, invertY: false, volume: 0.8, ...s };
}
export function saveSettings(s) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (_) { /* private mode */ } }

const HELP = {
  keyboard: [
    ['Move', ['up', 'left', 'down', 'right']], ['Look', 'mouse'], ['Jump · glide', ['jump']], ['Sprint · boost', ['sprint']],
    ['Slide · descend', ['descend']], ['Interact', ['interact']], ['Vehicle · hold to summon', ['vehicle']], ['Camera view', ['view']],
    ['Map · scale travel', ['map']], ['Photo mode', ['photo']], ['Menu', ['menu']],
  ],
  gamepad: [
    ['Move · look', 'sticks'], ['Jump · glide', ['jump']], ['Sprint', ['sprint']], ['Boost', ['boost']], ['Slide · descend', ['descend']],
    ['Interact', ['interact']], ['Vehicle', ['vehicle']], ['Camera view', ['view']], ['Map', ['map']], ['Menu', ['menu']],
  ],
  touch: [
    ['Move', 'left thumb anywhere'], ['Look', 'drag right side'], ['Zoom', 'pinch'], ['Sprint', 'push stick to the edge'],
    ['Jump · glide', ['jump']], ['Vehicle', ['vehicle']], ['Map · menu', 'top-right buttons'],
  ],
};

export class Menu {
  constructor(ui, parent) {
    this.ui = ui;
    this.engine = ui.engine;
    this.input = ui.engine.input;
    this.settings = loadSettings();
    this.open = false;
    this.a = 0;
    this.page = 'main';
    this.helpDevice = null;
    this.focusIdx = -1;
    this.wrap = document.createElement('div');
    this.wrap.className = 'rv-panel-wrap';
    this.wrap.style.display = 'none';
    this.wrap.innerHTML = `<div class="rv-scrim"></div><div class="rv-menu-pos" style="position:absolute;inset:0;display:flex;align-items:center;pointer-events:none"><div class="rv-menu" style="pointer-events:auto"></div></div>`;
    parent.appendChild(this.wrap);
    this.scrim = this.wrap.querySelector('.rv-scrim');
    this.panel = this.wrap.querySelector('.rv-menu');
    this.scrim.addEventListener('pointerdown', (e) => { e.preventDefault(); this.close(); });
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.apply();
  }

  // ---------------------------------------------------------------- settings
  apply() {
    const s = this.settings, st = this.input.settings;
    if (!this._base) this._base = { mouse: st.mouseSens, touch: st.touchSens, stick: st.stickSens };
    st.mouseSens = this._base.mouse * s.sens;
    st.touchSens = this._base.touch * s.sens;
    st.stickSens = this._base.stick * s.sens;
    st.invertY = !!s.invertY;
    const a = this.engine.audio;
    try {
      if (a?.setVolume) a.setVolume(s.volume);
      else { a?.setParam?.('volume', s.volume); if (a?.master?.gain) a.master.gain.value = 0.75 * s.volume; }
    } catch (_) { /* audio optional */ }
    this.volumeApplied = s.volume;
  }
  set(k, v) { this.settings[k] = v; saveSettings(this.settings); this.apply(); }

  // ---------------------------------------------------------------- open / close
  toggle() { if (this.open) this.close(); else this.show(); }
  show(page = 'main') {
    if (!this.open) {
      this.open = true;
      this.wrap.classList.add('open');
      this.wrap.style.display = '';
      this.ui.onPanel(true, 'menu');
    }
    this.page = page;
    this.render();
  }
  close() {
    if (!this.open) return;
    this.open = false;
    this.wrap.classList.remove('open');
    this.ui.onPanel(false, 'menu');
  }
  // ---------------------------------------------------------------- render
  render() {
    const loc = this.ui.locationInfo();
    const uiDev = this.ui.device || this.input.lastDevice || 'keyboard';
    const dev = this.helpDevice || uiDev;
    const kb = (a) => uiDev === 'touch' ? '' : `<span class="kb">${glyphFor(this.input, a, uiDev)}</span>`;
    let html = `<div class="rv-mn-brand">REVERENCE</div>
      <div class="rv-mn-loc">${escapeHtml(loc.title)}</div>
      <div class="rv-mn-sub">${escapeHtml(loc.subtitle)}</div>`;
    if (this.page === 'main') {
      const s = this.settings;
      const q = this.engine.quality?.tier ?? 'high';
      html += `<div class="rv-mn-list">
        <button class="rv-row" data-act="resume" data-sfx="ui.back"><span class="ic">${icon('resume')}</span><span class="lbl">Resume</span>${kb('menu')}</button>
        <button class="rv-row" data-act="map" data-sfx="ui.open"><span class="ic">${icon('map')}</span><span class="lbl">Map &amp; scale travel</span>${kb('map')}</button>
        ${loc.up ? `<button class="rv-row" data-act="up" data-sfx="ui.open"><span class="ic">${icon('up')}</span><span class="lbl">${escapeHtml(loc.up.label)}</span></button>` : ''}
        <button class="rv-row" data-act="photo" data-sfx="ui.open"><span class="ic">${icon('photo')}</span><span class="lbl">Photo mode</span>${kb('photo')}</button>
        <button class="rv-row" data-act="share"><span class="ic">${icon('share')}</span><span class="lbl">Share this place</span><span class="val" data-share></span></button>
        <button class="rv-row" data-act="controls" data-sfx="ui.open"><span class="ic">${icon('controls')}</span><span class="lbl">Controls</span><span class="ic">${icon('chevron')}</span></button>
        <div class="rv-sep"></div>
        <div class="rv-mn-sec" style="margin:4px 10px 6px">Settings</div>
        <div class="rv-set" style="flex-direction:column;align-items:stretch;gap:8px;padding-top:4px;padding-bottom:6px"><div style="display:flex;justify-content:space-between"><span class="lbl">Quality</span><span class="val" style="font-size:10px;color:var(--ui-faint)">${this.engine.quality?.mobile ? 'mobile' : ''}</span></div>
          <div class="rv-seg" data-seg="q">${TIERS.map((t) => `<button data-q="${t}" class="${t === q ? 'on' : ''}">${t}</button>`).join('')}</div></div>
        <div class="rv-set"><span class="lbl">Look sensitivity</span><input class="rv-range" type="range" min="0.3" max="2.5" step="0.05" value="${s.sens}" data-set="sens" style="--p:${((s.sens - 0.3) / 2.2) * 100}%"></div>
        <div class="rv-set"><span class="lbl">Invert look Y</span><button class="rv-tog ${s.invertY ? 'on' : ''}" data-tog="invertY"><i></i></button></div>
        <div class="rv-set"><span class="lbl">Volume</span><input class="rv-range" type="range" min="0" max="1" step="0.02" value="${s.volume}" data-set="volume" style="--p:${s.volume * 100}%"></div>
      </div>
      <div class="rv-mn-foot"><span>${escapeHtml(loc.coords || '')}</span><span>seed ${this.engine.universe?.seed ?? Params.seed}</span></div>`;
    } else if (this.page === 'controls') {
      const d = dev === 'touch' || dev === 'gamepad' ? dev : 'keyboard';
      html += `<div class="rv-mn-list">
        <button class="rv-row" data-act="main" data-sfx="ui.back"><span class="ic">${icon('back')}</span><span class="lbl">Controls</span></button>
        <div class="rv-seg rv-devtabs">${['keyboard', 'gamepad', 'touch'].map((x) => `<button data-dev="${x}" class="${x === d ? 'on' : ''}">${x}</button>`).join('')}</div>
        <div class="rv-help">${HELP[d].map(([lbl, v]) => `<span>${lbl}</span><span class="kb">${
          Array.isArray(v) ? v.map((a) => glyphFor(this.input, a, d === 'touch' ? 'touch' : d)).join('') : `<span style="font-size:10px;letter-spacing:.08em;color:var(--ui-faint)">${v}</span>`}</span>`).join('')}</div>
      </div>`;
    }
    this.panel.innerHTML = html;
    this._wire();
    this.focusIdx = -1;
  }

  _wire() {
    const P = this.panel;
    P.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => this._act(b.dataset.act, b)));
    P.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => this._setQuality(b.dataset.q)));
    P.querySelectorAll('[data-dev]').forEach((b) => b.addEventListener('click', () => { this.helpDevice = b.dataset.dev; this.render(); }));
    P.querySelectorAll('[data-tog]').forEach((b) => b.addEventListener('click', () => { const k = b.dataset.tog; this.set(k, !this.settings[k]); b.classList.toggle('on', !!this.settings[k]); }));
    P.querySelectorAll('[data-set]').forEach((r) => r.addEventListener('input', () => {
      const k = r.dataset.set, v = parseFloat(r.value);
      const min = parseFloat(r.min), max = parseFloat(r.max);
      r.style.setProperty('--p', `${((v - min) / (max - min)) * 100}%`);
      this.set(k, v);
    }));
  }

  _act(act, el) {
    if (act === 'resume') this.close();
    else if (act === 'map') { this.close(); this.ui.map.show(); }
    else if (act === 'photo') { this.close(); this.ui.setPhoto(true); }
    else if (act === 'controls') { this.page = 'controls'; this.render(); }
    else if (act === 'main') { this.page = 'main'; this.render(); }
    else if (act === 'up') { const up = this.ui.locationInfo().up; this.close(); up?.go?.(); }
    else if (act === 'share') this._share(el);
  }

  async _share(el) {
    const url = location.origin + location.pathname + buildQuery(this.ui.shareState());
    const out = el?.querySelector('[data-share]');
    let ok = false;
    try {
      if (navigator.share && this.engine.quality?.mobile) { await navigator.share({ title: 'Reverence', text: this.ui.locationInfo().title, url }); ok = true; }
    } catch (_) { /* cancelled */ }
    if (!ok) {
      try { await navigator.clipboard.writeText(url); ok = true; } catch (_) {
        try { const ta = document.createElement('textarea'); ta.value = url; document.body.appendChild(ta); ta.select(); ok = document.execCommand('copy'); ta.remove(); } catch (_) { ok = false; }
      }
    }
    if (out) out.textContent = ok ? 'copied' : '';
    if (!ok) try { history.replaceState(null, '', url); } catch (_) { /* ignore */ }
    this.ui.toast(ok ? 'Link copied' : 'Link is in the address bar', { kind: 'info', eyebrow: 'Share', icon: 'share', ms: 2600 });
  }

  _setQuality(tier) {
    if (tier === this.engine.quality?.tier || this.engine.shot) return;
    const st = this.ui.shareState();
    st.q = tier;
    location.href = location.pathname + buildQuery(st);
  }

  // keyboard / gamepad navigation inside the menu
  nav(dir) {
    const items = [...this.panel.querySelectorAll('.rv-row, .rv-seg button, .rv-range, .rv-tog')];
    if (!items.length) return;
    items.forEach((i) => i.classList.remove('focus'));
    this.focusIdx = (this.focusIdx + dir + items.length) % items.length;
    const it = items[this.focusIdx];
    it.classList.add('focus');
    try { it.focus({ preventScroll: false }); } catch (_) {}
  }
  activate() {
    const items = [...this.panel.querySelectorAll('.rv-row, .rv-seg button, .rv-range, .rv-tog')];
    items[this.focusIdx]?.click?.();
  }

  update(dt) {
    const tgt = this.open ? 1 : 0;
    if (tgt === 0 && this.a <= 0.001) { if (this.wrap.style.display !== 'none') this.wrap.style.display = 'none'; return; }
    this.a += (tgt - this.a) * (1 - Math.exp(-dt * (this.open ? 12 : 14)));
    if (Math.abs(tgt - this.a) < 0.002) this.a = tgt;
    const e = this.a;
    this.scrim.style.opacity = e.toFixed(3);
    this.panel.style.opacity = e.toFixed(3);
    this.panel.style.transform = `translate3d(${((1 - e) * -18).toFixed(2)}px,0,0) scale(${(0.985 + 0.015 * e).toFixed(4)})`;
  }
}
