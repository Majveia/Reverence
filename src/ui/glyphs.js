// Input glyphs that adapt to the last used device (keyboard · gamepad · touch).
//   glyphFor(input, action, device) → HTML string (a keycap, a pad button or a touch icon)
//   parsePrompt(input, text, action) → [{ label, action }]  splits "Dive · Shift   Drop · C"
import { icon } from './icons.js';

const KEY_LABELS = {
  Space: 'Space', ShiftLeft: 'Shift', ShiftRight: 'Shift', ControlLeft: 'Ctrl', ControlRight: 'Ctrl',
  AltLeft: 'Alt', Escape: 'Esc', Tab: 'Tab', Backspace: '⌫', Enter: '↵',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
};
// Xbox-style layout (standard mapping)
const PAD_LABELS = {
  0: 'A', 1: 'B', 2: 'X', 3: 'Y', 4: 'LB', 5: 'RB', 6: 'LT', 7: 'RT', 8: '⧉', 9: '≡',
  10: 'LS', 11: 'RS', 12: '▲', 13: '▼', 14: '◀', 15: '▶',
};
const PAD_FACE = { 0: 'a', 1: 'b', 2: 'x', 3: 'y' };
// Touch icon per action (matches the touch buttons)
const TOUCH_ICON = {
  jump: 'jump', glide: 'glide', ascend: 'ascend', descend: 'descend', sprint: 'sprint', boost: 'boost',
  interact: 'interact', vehicle: 'vehicle', view: 'view', map: 'map', back: 'back', menu: 'menu', photo: 'photo',
};

export function keyLabel(code) {
  if (!code) return '';
  if (KEY_LABELS[code]) return KEY_LABELS[code];
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code === 'Mouse0') return 'LMB';
  if (code === 'Mouse2') return 'RMB';
  return code;
}

function firstCode(input, action, pad) {
  const list = input?.bindings?.[action] || [];
  for (const c of list) if (pad ? c.startsWith('Pad') : !c.startsWith('Pad')) return c;
  return null;
}

export function glyphFor(input, action, device) {
  if (!action) return '';
  if (device === 'touch') {
    const ic = TOUCH_ICON[action];
    return ic ? `<span class="rv-g rv-g-touch">${icon(ic)}</span>` : '';
  }
  if (device === 'gamepad') {
    const c = firstCode(input, action, true);
    if (!c) return '';
    const n = +c.slice(3);
    const face = PAD_FACE[n];
    return `<span class="rv-g rv-g-pad${face ? ' rv-g-face rv-g-' + face : ' rv-g-shoulder'}">${PAD_LABELS[n] ?? n}</span>`;
  }
  const c = firstCode(input, action, false);
  if (!c) return '';
  if (c === 'Mouse0' || c === 'Mouse2') {
    return `<span class="rv-g rv-g-mouse${c === 'Mouse2' ? ' r' : ''}"><i></i></span>`;
  }
  const l = keyLabel(c);
  return `<span class="rv-g rv-g-key${l.length > 1 ? ' wide' : ''}">${l}</span>`;
}

/** Glyph for a raw key name as written in prompt text ("Shift", "C", "Space"). */
function glyphForKeyName(input, name, device) {
  const act = actionForKeyName(input, name);
  if (act && device !== 'keyboard') return glyphFor(input, act, device);
  const l = name.length > 7 ? name.slice(0, 7) : name;
  return `<span class="rv-g rv-g-key${l.length > 1 ? ' wide' : ''}">${escapeHtml(l)}</span>`;
}

const NAME_TO_ACTION_PREF = ['jump', 'sprint', 'descend', 'interact', 'vehicle', 'view', 'map', 'boost', 'photo', 'time'];
function actionForKeyName(input, name) {
  const n = name.toLowerCase();
  for (const a of NAME_TO_ACTION_PREF) {
    for (const c of input?.bindings?.[a] || []) if (keyLabel(c).toLowerCase() === n) return a;
  }
  return null;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * Turn a prompt (text, action) into HTML chips. Handles compound prompts written by other tracks
 * such as "Dive · Shift   Drop · C" (segments split by 2+ spaces, "Label · Key").
 */
export function promptHTML(input, text, action, device) {
  const segs = String(text ?? '').split(/\s{2,}/).filter(Boolean);
  const out = [];
  segs.forEach((seg, i) => {
    const m = seg.match(/^(.*?)\s*·\s*([A-Za-z0-9↑↓←→]{1,7})$/);
    if (m) {
      out.push(`<span class="rv-pchip">${glyphForKeyName(input, m[2], device)}<span class="rv-plabel">${escapeHtml(m[1])}</span></span>`);
    } else {
      const g = i === 0 ? glyphFor(input, action, device) : '';
      out.push(`<span class="rv-pchip">${g}<span class="rv-plabel">${escapeHtml(seg)}</span></span>`);
    }
  });
  return out.join('<span class="rv-psep"></span>');
}
