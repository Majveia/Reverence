// Some hosts (embedded previews, static file shares) drop the query string, so the same URL
// parameters may also arrive in the hash: #mode=galaxy&focus=core. Fold them into the query
// before any module reads location.search. A bare #anchor (no '=') is left alone.
try {
  const h = location.hash.slice(1);
  if (h.includes('=')) {
    const q = new URLSearchParams(location.search);
    for (const [k, v] of new URLSearchParams(h)) if (!q.has(k)) q.set(k, v);
    const next = location.pathname + '?' + q.toString();
    try { history.replaceState(history.state, '', next); } catch (_) { location.replace(next); }
  }
} catch (_) { /* no window (worker/tooling) */ }
