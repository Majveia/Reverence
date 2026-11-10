// World themes — the shared art-direction table.  Every landable world has `body.theme` naming one of these.
// Modules (terrain, atmosphere, ocean, flora, civ, fauna, audio, …) key their own per-theme tables off the same
// names and may read the shared fields below.  Colours are sRGB hex strings.
//
// Each theme is a love letter: `homage` credits the film-makers / artists whose *feeling* it reaches for.
// Homage means mood, light and composition — never copied characters, designs or names.

export const THEMES = {
  pastoral: {
    label: 'Pastoral', homage: 'Hayao Miyazaki · Terrence Malick · Planet Earth',
    mood: 'golden wind-combed meadows, white hill-towns, towering cumulus, endless afternoon',
    palette: { deep: '#07263f', shallow: '#1f8f96', sand: '#dccfa6', grass: '#5f9a3c', grass2: '#9bb552', forest: '#2c5a2e', rock: '#77716a', rock2: '#4c4843', snow: '#f5f8fc', soil: '#5d4732', accent: '#f2b33d' },
    terrain: { amplitude: 2400, seaLevel: 0.36, continents: 0.9, ridged: 0.55, hills: 0.7, dunes: 0, mesas: 0, terraces: 0.08, craters: 0, karst: 0, roughness: 0.5, snowLine: 0.78 },
    atmosphere: { height: 0.085, rayleigh: [0.175, 0.409, 1.0], rayleighStrength: 1.0, mieStrength: 1.0, mieG: 0.78, fog: { density: 0.022, color: '#cfe1f5' }, clouds: { cover: 0.42, type: 'cumulus', color: '#ffffff' }, weather: 'clear', aurora: 0 },
    ocean: { color: '#0b4f72', scatter: '#27b3a7', waves: 1.0, clarity: 0.7 },
    life: { flora: 1.0, fauna: 1.0, glow: 0.05 },
    grade: { exposure: 1.0, contrast: 1.04, saturation: 1.08, temperature: 0.12 },
  },
  desert: {
    label: 'Desert', homage: 'Denis Villeneuve · David Lean · Moebius',
    mood: 'oceanic dunes, monolithic shade, heat-haze, two long shadows at dusk',
    palette: { deep: '#3b2415', shallow: '#8a5a2e', sand: '#e0b176', grass: '#c08a4e', grass2: '#d7a565', forest: '#8d6a3a', rock: '#a0623a', rock2: '#6b3d26', snow: '#f3e3c8', soil: '#8a5a36', accent: '#3fd0c9' },
    terrain: { amplitude: 1900, seaLevel: 0.0, continents: 0.5, ridged: 0.35, hills: 0.3, dunes: 1.0, mesas: 0.75, terraces: 0.5, craters: 0.05, karst: 0, roughness: 0.4, snowLine: 2 },
    atmosphere: { height: 0.09, rayleigh: [0.42, 0.44, 0.52], rayleighStrength: 0.75, mieStrength: 2.6, mieG: 0.72, mieColor: '#ffd9a8', fog: { density: 0.035, color: '#e9c79a' }, clouds: { cover: 0.06, type: 'cirrus', color: '#ffe9cf' }, weather: 'dust', aurora: 0 },
    ocean: null,
    life: { flora: 0.12, fauna: 0.3, glow: 0.0 },
    grade: { exposure: 0.95, contrast: 1.08, saturation: 0.96, temperature: 0.3 },
  },
  jungle: {
    label: 'Bioluminescent Jungle', homage: 'Roger Dean · James Cameron · Nausicaä',
    mood: 'cathedral trees, floating stone, spores drifting through violet dusk, everything softly alive',
    palette: { deep: '#06222b', shallow: '#0f6b66', sand: '#b8b089', grass: '#2f8f5b', grass2: '#58b56a', forest: '#134a3a', rock: '#56606a', rock2: '#333a44', snow: '#e8f6ff', soil: '#3a2f36', accent: '#39f0d0' },
    terrain: { amplitude: 3000, seaLevel: 0.3, continents: 1.1, ridged: 0.8, hills: 0.8, dunes: 0, mesas: 0.2, terraces: 0.2, craters: 0, karst: 0.55, roughness: 0.65, snowLine: 0.92 },
    atmosphere: { height: 0.10, rayleigh: [0.20, 0.50, 0.90], rayleighStrength: 1.15, mieStrength: 1.9, mieG: 0.8, mieColor: '#d8ffe9', fog: { density: 0.06, color: '#9fd8c4' }, clouds: { cover: 0.6, type: 'stratus', color: '#eafff6' }, weather: 'spores', aurora: 0.25 },
    ocean: { color: '#06404a', scatter: '#19c9b0', waves: 0.6, clarity: 0.5 },
    life: { flora: 1.6, fauna: 1.2, glow: 1.0 },
    grade: { exposure: 1.0, contrast: 1.02, saturation: 1.15, temperature: -0.08 },
  },
  mist: {
    label: 'Mist Mountains', homage: 'Akira Kurosawa · Hokusai · Andrei Tarkovsky',
    mood: 'karst pillars in cloud, red gates, lantern light, pines combed by rain',
    palette: { deep: '#0c1f2a', shallow: '#3a7f86', sand: '#b9b29c', grass: '#5c8757', grass2: '#86a06a', forest: '#234a3c', rock: '#6c7375', rock2: '#3f4749', snow: '#f1f4f6', soil: '#4b4238', accent: '#e2452f' },
    terrain: { amplitude: 3400, seaLevel: 0.28, continents: 0.8, ridged: 1.0, hills: 0.5, dunes: 0, mesas: 0.1, terraces: 0.25, craters: 0, karst: 1.0, roughness: 0.75, snowLine: 0.7 },
    atmosphere: { height: 0.09, rayleigh: [0.24, 0.42, 0.80], rayleighStrength: 0.9, mieStrength: 3.2, mieG: 0.7, fog: { density: 0.13, color: '#c9d5d8' }, clouds: { cover: 0.78, type: 'stratus', color: '#eef2f4' }, weather: 'mist', aurora: 0 },
    ocean: { color: '#123c48', scatter: '#4aa39b', waves: 0.5, clarity: 0.4 },
    life: { flora: 1.2, fauna: 0.7, glow: 0.1 },
    grade: { exposure: 1.02, contrast: 0.98, saturation: 0.88, temperature: -0.1 },
  },
  ice: {
    label: 'Aurora Ice', homage: 'Stanley Kubrick · Caspar David Friedrich',
    mood: 'blue-hour glaciers, crystal spires, a sky on fire with aurora',
    palette: { deep: '#061a2e', shallow: '#3d8fb5', sand: '#b9c6cf', grass: '#8fa7b0', grass2: '#c5d6dc', forest: '#4d6f80', rock: '#59646e', rock2: '#333c46', snow: '#f4fbff', soil: '#56606b', accent: '#56f0c0' },
    terrain: { amplitude: 2600, seaLevel: 0.22, continents: 0.7, ridged: 0.9, hills: 0.4, dunes: 0.15, mesas: 0, terraces: 0.1, craters: 0.05, karst: 0.1, roughness: 0.6, snowLine: 0.12 },
    atmosphere: { height: 0.08, rayleigh: [0.16, 0.38, 1.0], rayleighStrength: 0.9, mieStrength: 0.7, mieG: 0.8, fog: { density: 0.03, color: '#d5e8f5' }, clouds: { cover: 0.25, type: 'cirrus', color: '#f2fbff' }, weather: 'snow', aurora: 1.0 },
    ocean: { color: '#072b45', scatter: '#3ea6c6', waves: 0.4, clarity: 0.9, ice: 0.6 },
    life: { flora: 0.25, fauna: 0.4, glow: 0.5 },
    grade: { exposure: 1.0, contrast: 1.05, saturation: 0.95, temperature: -0.28 },
  },
  volcanic: {
    label: 'Volcanic', homage: 'Zdzisław Beksiński · FromSoftware',
    mood: 'basalt cathedrals, rivers of slow fire, ash like snow, a red sun through smoke',
    palette: { deep: '#1a0603', shallow: '#ff5a12', sand: '#3a3330', grass: '#2b2726', grass2: '#4a3f3a', forest: '#1c1a1b', rock: '#2a2729', rock2: '#151416', snow: '#8d8884', soil: '#231f1e', accent: '#ff7a1a' },
    terrain: { amplitude: 3200, seaLevel: 0.16, continents: 0.6, ridged: 1.0, hills: 0.4, dunes: 0, mesas: 0.3, terraces: 0.3, craters: 0.4, karst: 0.2, roughness: 0.85, snowLine: 2, lava: 1 },
    atmosphere: { height: 0.10, rayleigh: [0.55, 0.36, 0.30], rayleighStrength: 0.8, mieStrength: 4.0, mieG: 0.65, mieColor: '#ff9b6a', fog: { density: 0.09, color: '#5a3a33' }, clouds: { cover: 0.7, type: 'storm', color: '#4a3c3a' }, weather: 'ash', aurora: 0 },
    ocean: { color: '#ff4a00', scatter: '#ffb347', waves: 0.15, clarity: 0.0, lava: true },
    life: { flora: 0.05, fauna: 0.15, glow: 0.8 },
    grade: { exposure: 0.92, contrast: 1.12, saturation: 1.02, temperature: 0.2 },
  },
  neon: {
    label: 'Neon Twilight', homage: 'Ridley Scott · Wong Kar-wai · Syd Mead · Katsuhiro Otomo',
    mood: 'endless rain-slick city under a ringed giant, signage glow in fog, quiet rooftops',
    palette: { deep: '#05070f', shallow: '#12314a', sand: '#3b3f4a', grass: '#263238', grass2: '#34424a', forest: '#1c2a30', rock: '#3a3d46', rock2: '#1f2128', snow: '#aab4c2', soil: '#2a2c33', accent: '#ff2fa0' },
    terrain: { amplitude: 1400, seaLevel: 0.25, continents: 0.6, ridged: 0.4, hills: 0.4, dunes: 0, mesas: 0.3, terraces: 0.6, craters: 0.1, karst: 0, roughness: 0.45, snowLine: 2 },
    atmosphere: { height: 0.09, rayleigh: [0.22, 0.30, 0.62], rayleighStrength: 0.7, mieStrength: 3.6, mieG: 0.74, mieColor: '#b9c8ff', fog: { density: 0.11, color: '#3b3f66' }, clouds: { cover: 0.85, type: 'stratus', color: '#8f96b8' }, weather: 'rain', aurora: 0 },
    ocean: { color: '#050b1c', scatter: '#274a7a', waves: 0.5, clarity: 0.3 },
    life: { flora: 0.2, fauna: 0.2, glow: 0.6 },
    grade: { exposure: 1.08, contrast: 1.1, saturation: 1.12, temperature: -0.15 },
  },
  barren: {
    label: 'Airless', homage: 'Stanley Kubrick · Chesley Bonestell',
    mood: 'razor shadows, silence, a monolith and a planet hanging in a black sky',
    palette: { deep: '#2a2a2d', shallow: '#4a4a4f', sand: '#8f8c88', grass: '#7c7975', grass2: '#99958f', forest: '#6a6763', rock: '#77736f', rock2: '#4a4744', snow: '#d9d6d2', soil: '#66625e', accent: '#ffffff' },
    terrain: { amplitude: 2200, seaLevel: 0.0, continents: 0.5, ridged: 0.5, hills: 0.4, dunes: 0, mesas: 0, terraces: 0, craters: 1.0, karst: 0, roughness: 0.7, snowLine: 2 },
    atmosphere: null,
    ocean: null,
    life: { flora: 0, fauna: 0, glow: 0 },
    grade: { exposure: 1.0, contrast: 1.15, saturation: 0.9, temperature: 0 },
  },
  ocean: {
    label: 'Archipelago', homage: 'Hokusai · Hiroshi Yoshida · J. M. W. Turner',
    mood: 'a thousand green islands, great slow swells, light breaking through squalls',
    palette: { deep: '#052440', shallow: '#18a5a8', sand: '#efe2b8', grass: '#58a24a', grass2: '#8fc15a', forest: '#1f6038', rock: '#6b6a66', rock2: '#3f3e3b', snow: '#f7fbff', soil: '#5a4630', accent: '#ff7b54' },
    terrain: { amplitude: 1700, seaLevel: 0.62, continents: 1.3, ridged: 0.6, hills: 0.6, dunes: 0, mesas: 0, terraces: 0.05, craters: 0, karst: 0.3, roughness: 0.5, snowLine: 0.95 },
    atmosphere: { height: 0.085, rayleigh: [0.175, 0.409, 1.0], rayleighStrength: 1.05, mieStrength: 1.4, mieG: 0.8, fog: { density: 0.03, color: '#cfe6f2' }, clouds: { cover: 0.55, type: 'cumulus', color: '#ffffff' }, weather: 'clear', aurora: 0 },
    ocean: { color: '#06456e', scatter: '#22c3b4', waves: 1.5, clarity: 0.8 },
    life: { flora: 1.1, fauna: 1.1, glow: 0.15 },
    grade: { exposure: 1.0, contrast: 1.04, saturation: 1.1, temperature: 0.05 },
  },
  crystal: {
    label: 'Crystal Canyons', homage: 'Moebius · Eyvind Earle',
    mood: 'pastel canyons, prismatic spires, long clean horizons drawn in a single line',
    palette: { deep: '#2b1640', shallow: '#7b4fb0', sand: '#f0c9a8', grass: '#e58f8a', grass2: '#f2b8a0', forest: '#7a4f86', rock: '#b06a78', rock2: '#5f3a5c', snow: '#fdf0ff', soil: '#8a5a6a', accent: '#7af0ff' },
    terrain: { amplitude: 2600, seaLevel: 0.12, continents: 0.6, ridged: 0.5, hills: 0.3, dunes: 0.4, mesas: 1.0, terraces: 0.9, craters: 0, karst: 0.4, roughness: 0.4, snowLine: 2 },
    atmosphere: { height: 0.09, rayleigh: [0.55, 0.36, 0.78], rayleighStrength: 0.9, mieStrength: 1.3, mieG: 0.76, mieColor: '#ffd9f0', fog: { density: 0.03, color: '#f2cfe2' }, clouds: { cover: 0.2, type: 'cirrus', color: '#fff0fa' }, weather: 'clear', aurora: 0.1 },
    ocean: { color: '#3a1f6a', scatter: '#b07af0', waves: 0.3, clarity: 0.6 },
    life: { flora: 0.5, fauna: 0.5, glow: 0.7 },
    grade: { exposure: 1.0, contrast: 1.03, saturation: 1.1, temperature: 0.05 },
  },
};

// Gas / ice giant looks (not landable; rendered by the space module).
export const GIANTS = {
  jovian: { label: 'Gas Giant', bands: ['#c9a27a', '#e8d2b0', '#a8683f', '#f1e4cf', '#8c5a3c', '#d9b48a'], storms: 0.8, turbulence: 0.7, haze: '#ffe0b8' },
  saturnine: { label: 'Ringed Giant', bands: ['#e9d8a6', '#d4bb82', '#f4ead0', '#c9a96a', '#efe0b4'], storms: 0.3, turbulence: 0.4, haze: '#fff0c8' },
  azure: { label: 'Ice Giant', bands: ['#4fb0d8', '#7fd4ea', '#3a8fc0', '#a8e8f2'], storms: 0.4, turbulence: 0.3, haze: '#bff2ff' },
  viridian: { label: 'Methane Giant', bands: ['#3fae9a', '#8fe0c8', '#2a8a80', '#c8f5e4'], storms: 0.5, turbulence: 0.5, haze: '#c8ffe8' },
  crimson: { label: 'Hot Giant', bands: ['#7a1f2a', '#d8582a', '#3a0f1c', '#ff9a4a', '#5a1420'], storms: 1.0, turbulence: 1.0, haze: '#ff9a6a' },
  amethyst: { label: 'Storm Giant', bands: ['#5a3f9a', '#9a7fe0', '#3a2a6a', '#d0b8ff', '#6f4fb8'], storms: 0.9, turbulence: 0.8, haze: '#e0d0ff' },
};

export const LANDABLE_THEMES = Object.keys(THEMES);
export const theme = (name) => THEMES[name] || THEMES.barren;
