import { SurfaceGen } from '../planet/SurfaceGen.js';
const U = await import('../../universe/Universe.js');
const uni = new (U.Universe||U.default)(1);
const key=process.argv[2]; const W = {W1:[6,'1'],W2:[11,'0'],W3:[9,'2'],W4:[2,'0'],W5:[1,'2'],W6:[1,'3'],W7:[3,'2'],W8:[2,'1'],W9:[2,'2.1'],W10:[17,'0'],W11:[0,'0'],W12:[9,'5'],M1:[0,'2.0']}[key];
const g = new SurfaceGen(uni.body(uni.system(0,W[0]),W[1]));
let land=0, cliff=0, best=[]; const N=20000;
for (let i=0;i<N;i++){ const y=1-2*(i+.5)/N, r=Math.sqrt(1-y*y), t=2.39996*i; const x=Math.cos(t)*r, z=Math.sin(t)*r; const info={}; const h=g.evaluate(x,y,z,50,info); if (g.hasOcean && h<0) continue; land++; if (info.cliff>0.4) { cliff++; best.push([Math.asin(y)*57.3, Math.atan2(x,z)*57.3, h]); } }
console.log(key, 'land',land,'cliff%',(cliff/land*100).toFixed(1), best.slice(0,8).map(b=>b.map(v=>v.toFixed(1)).join(',')).join(' | '));
