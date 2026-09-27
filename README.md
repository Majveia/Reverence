# Reverence

A living, procedurally generated universe you can explore in the browser — from the cosmic
web of dark matter filaments down to the grass under your feet. Built with Three.js (WebGL2).

* **Cosmic web** — structure formation under gravity and cosmic expansion; tap a light to descend.
* **Galaxies** — spiral, barred, elliptical, ring and irregular galaxies; dive toward any star.
* **Star systems** — Keplerian orbits, moons, rings, belts, comets.
* **Living worlds** — every planet is art-directed (inspired by great directors, painters and
  games), with biomes, weather, life, and civilizations with towns, cities and monuments.
* **Explore** — third/first person on foot, hoverbike, rover and starship; desktop, gamepad
  and touch controls.

```bash
npm install
npm run dev        # open http://localhost:5173
```

Controls (desktop): drag/mouse to look · WASD move · Space jump/ascend · Shift sprint/boost ·
E interact · F vehicle · V first/third person · M map · Esc back up a scale · H hide UI.
Touch: left thumb moves (floating stick), right thumb looks, pinch zooms, tap to select.

Deep links: `?mode=system&galaxy=0&star=7&planet=2&view=surface&tod=0.3` — see
[ARCHITECTURE.md](ARCHITECTURE.md) for all parameters, the engine design and contracts.
