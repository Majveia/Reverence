// Cube-sphere cell grid (equal-angle warp) used for deterministic, streamed populations.
// key = face * N * N + j * N + i. The same key always yields the same groups (seeded RNG).

export function cellsPerFace(radius, cellSize) {
  return Math.max(4, Math.round((radius * Math.PI * 0.5) / cellSize));
}

export function dirToCell(x, y, z, N) {
  const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
  let face, u, v;
  if (ax >= ay && ax >= az) { face = x > 0 ? 0 : 1; u = (x > 0 ? -z : z) / ax; v = y / ax; }
  else if (ay >= az) { face = y > 0 ? 2 : 3; u = x / ay; v = (y > 0 ? -z : z) / ay; }
  else { face = z > 0 ? 4 : 5; u = (z > 0 ? x : -x) / az; v = y / az; }
  u = Math.atan(u) * (4 / Math.PI); v = Math.atan(v) * (4 / Math.PI);
  const i = Math.min(N - 1, Math.max(0, Math.floor((u + 1) * 0.5 * N)));
  const j = Math.min(N - 1, Math.max(0, Math.floor((v + 1) * 0.5 * N)));
  return face * N * N + j * N + i;
}

/** unit direction of the cell center (+ optional in-cell offset fu,fv in [0,1)) */
export function cellDir(key, N, out, fu = 0.5, fv = 0.5) {
  const face = Math.floor(key / (N * N));
  const rem = key - face * N * N;
  const j = Math.floor(rem / N), i = rem - j * N;
  let u = ((i + fu) / N) * 2 - 1, v = ((j + fv) / N) * 2 - 1;
  u = Math.tan(u * Math.PI / 4); v = Math.tan(v * Math.PI / 4);
  let x, y, z;
  switch (face) {
    case 0: x = 1; y = v; z = -u; break;
    case 1: x = -1; y = v; z = u; break;
    case 2: x = u; y = 1; z = -v; break;
    case 3: x = u; y = -1; z = v; break;
    case 4: x = u; y = v; z = 1; break;
    default: x = -u; y = v; z = -1; break;
  }
  const l = Math.hypot(x, y, z);
  out[0] = x / l; out[1] = y / l; out[2] = z / l;
  return out;
}

const _e = [0, 0, 0], _n = [0, 0, 0];
/** Collect cell keys whose area intersects a disk of `radius` meters around unit dir (ux,uy,uz). */
export function cellsAround(ux, uy, uz, R, radius, cellSize, N, outSet) {
  // tangent basis
  let ex = uz, ey = 0, ez = -ux;
  let l = Math.hypot(ex, ey, ez); if (l < 1e-6) { ex = 1; ez = 0; l = 1; }
  ex /= l; ey /= l; ez /= l;
  _e[0] = ex; _e[1] = ey; _e[2] = ez;
  _n[0] = uy * ez - uz * ey; _n[1] = uz * ex - ux * ez; _n[2] = ux * ey - uy * ex;
  const step = cellSize * 0.5;
  const r = radius + cellSize * 0.5;
  const n = Math.ceil(r / step);
  outSet.clear();
  for (let a = -n; a <= n; a++) for (let b = -n; b <= n; b++) {
    const x = a * step, y = b * step;
    if (x * x + y * y > r * r) continue;
    const px = ux * R + _e[0] * x + _n[0] * y, py = uy * R + _e[1] * x + _n[1] * y, pz = uz * R + _e[2] * x + _n[2] * y;
    const pl = Math.hypot(px, py, pz);
    outSet.add(dirToCell(px / pl, py / pl, pz / pl, N));
  }
  return outSet;
}
