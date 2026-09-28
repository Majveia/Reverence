// Minimal line icons (24×24, currentColor, 1.6 stroke). Inline SVG strings — no assets.
const S = (d, extra = '') =>
  `<svg viewBox="0 0 24 24" width="100%" height="100%" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;

export const ICONS = {
  jump: S('<path d="M6 14l6-6 6 6"/><path d="M12 8v11" opacity=".45"/>'),
  ascend: S('<path d="M6 15l6-6 6 6"/>'),
  descend: S('<path d="M6 9l6 6 6-6"/>'),
  glide: S('<path d="M3 11c3-4 15-4 18 0"/><path d="M5 11l7 8 7-8"/><path d="M12 19v-8" opacity=".5"/>'),
  slide: S('<path d="M5 8l9 9"/><path d="M8 17h7v-7"/>'),
  sprint: S('<path d="M6 7l5 5-5 5"/><path d="M13 7l5 5-5 5"/>'),
  boost: S('<path d="M4 7l5 5-5 5"/><path d="M11 7l5 5-5 5"/><path d="M18 7v10" opacity=".55"/>'),
  interact: S('<circle cx="12" cy="12" r="7.5"/><circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none"/>'),
  vehicle: S('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M4.5 10.5h5M14.5 10.5h5M12 14v5.5"/>'),
  exit: S('<path d="M14 5h4.5a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5H14"/><path d="M10 8l-4 4 4 4"/><path d="M6 12h9"/>'),
  view: S('<path d="M2.5 12s3.6-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.6 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.6"/>'),
  map: S('<path d="M12 3l8 4.5-8 4.5-8-4.5z"/><path d="M4 12l8 4.5 8-4.5" opacity=".7"/><path d="M4 16.5L12 21l8-4.5" opacity=".4"/>'),
  menu: S('<path d="M5 9h14M5 15h14"/>'),
  close: S('<path d="M6 6l12 12M18 6L6 18"/>'),
  share: S('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  photo: S('<circle cx="12" cy="12" r="8"/><path d="M12 4l3.5 6M20 12h-7M16 18.9L12.5 13M8 19.5L11.5 13.5M4 12h7M8 4.6l3.5 6.1" opacity=".7"/>'),
  resume: S('<path d="M8 5.5v13l10-6.5z"/>'),
  controls: S('<rect x="3" y="7" width="18" height="10" rx="5"/><path d="M8 10v4M6 12h4"/><circle cx="15.5" cy="11" r=".9" fill="currentColor"/><circle cx="17.5" cy="13" r=".9" fill="currentColor"/>'),
  pinch: S('<path d="M7 7l3.5 3.5M17 17l-3.5-3.5"/><path d="M7 11V7h4M17 13v4h-4"/>'),
  back: S('<path d="M14 6l-6 6 6 6"/>'),
  chevron: S('<path d="M9 6l6 6-6 6"/>'),
  up: S('<path d="M6 14l6-6 6 6"/>'),
  // scale glyphs (breadcrumb / map)
  cosmic: S('<circle cx="6" cy="8" r="1.3" fill="currentColor"/><circle cx="17" cy="6" r="1" fill="currentColor"/><circle cx="12" cy="13" r="1.6" fill="currentColor"/><circle cx="18" cy="17" r="1.1" fill="currentColor"/><circle cx="6" cy="18" r=".9" fill="currentColor"/><path d="M6 8l6 5 5-7M12 13l6 4M12 13l-6 5" opacity=".45"/>'),
  galaxy: S('<path d="M12 12c0-3 3-4.5 5.5-3.5M12 12c0 3-3 4.5-5.5 3.5M12 12c3 0 4.5 3 3.5 5.5M12 12c-3 0-4.5-3-3.5-5.5"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/>'),
  star: S('<circle cx="12" cy="12" r="3.2" fill="currentColor" stroke="none"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1" opacity=".6"/>'),
  planet: S('<circle cx="12" cy="12" r="5.5"/><path d="M3.5 14.5c2 2 15 -1 17 -5" opacity=".6"/>'),
  // discovery kinds
  creature: S('<path d="M5 14c1.5-4 5-6 9-5.5 2.5.3 4.5 2 5 4.5"/><path d="M7 14.5c-.5 2-.3 3.5.5 4.5M11 15v4M15 14.5l1 4.5"/><circle cx="17" cy="11" r=".8" fill="currentColor"/>'),
  city: S('<path d="M4 20V11l4-2v11M8 20V6l5-2v16M13 20V9l6 2v9"/><path d="M3 20h18"/>'),
  village: S('<path d="M4 20v-7l5-4 5 4v7"/><path d="M14 20v-5l3.5-3 3.5 3v5"/><path d="M3 20h19"/>'),
  monument: S('<path d="M12 3l2 3v14h-4V6z"/><path d="M7 20h10"/>'),
  ruin: S('<path d="M5 20V9h3v11M10 20v-6h3v6M15 20V7h3v13"/><path d="M4 7l2-2M16 5h3" opacity=".6"/><path d="M3 20h18"/>'),
  wonder: S('<path d="M12 21V11"/><path d="M12 11c-5 0-7-3-6-6 3-.5 5 1 6 3 1-2 3-3.5 6-3 1 3-1 6-6 6z"/>'),
  landing: S('<circle cx="12" cy="12" r="8"/><path d="M12 7v10M7 12h10" opacity=".7"/>'),
  discovery: S('<path d="M12 4l2.2 5.8L20 12l-5.8 2.2L12 20l-2.2-5.8L4 12l5.8-2.2z"/>'),
};

export function icon(name) { return ICONS[name] || ICONS.discovery; }
