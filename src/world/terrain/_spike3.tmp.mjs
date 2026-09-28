import { SurfaceGen } from '../planet/SurfaceGen.js';
import { cubeDir } from './chunkBuild.js';
const U = await import('../../universe/Universe.js');
const uni = new (U.Universe||U.default)(1);
const g = new SurfaceGen(uni.body(uni.system(0,6),'1'));
const size=2/32, t=2, u0=-0.2+t*size*1.3, v0=-0.1+t*size*0.7; const step=size/64;
// monkeypatch n3d to log octave values
const n = g.nM; const orig = n.n3d.bind(n); let log = null;
n.n3d = (x,y,z,d) => { const v = orig(x,y,z,d); if (log) log.push([v.toFixed(3), Math.hypot(d[0],d[1],d[2]).toFixed(2)]); return v; };
const gg=new Float64Array(3);
for (const di of [0, 0.5]) { const d=new Float64Array(3); cubeDir(0,u0+(22+di)*step,v0+41*step,d); log=[]; const m=g._mountain(d[0],d[1],d[2],78,gg); console.log(di, m.toFixed(3), JSON.stringify(log)); }
