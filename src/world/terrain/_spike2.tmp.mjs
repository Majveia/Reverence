import { SurfaceGen } from '../planet/SurfaceGen.js';
const U = await import('../../universe/Universe.js');
const uni = new (U.Universe||U.default)(1);
const key = process.argv[2] || 'W1';
const W = {W1:[6,'1'],W2:[11,'0'],W3:[9,'2'],W12:[9,'5'],M1:[0,'2.0'],W5:[1,'2']}[key];
const g = new SurfaceGen(uni.body(uni.system(0,W[0]),W[1]));
if (process.env.SET) Object.assign(g.st, JSON.parse(process.env.SET));
// sample random points in mountains: slope stats at 50 m spacing
let n=0, over2=0, over5=0, maxS=0; const sp=50; const lod=sp*1.5;
for (let i=0;i<30000 && n<3000;i++){ const y=1-2*((i*0.6180339)%1), r=Math.sqrt(1-y*y), t=i*2.39996; const x=Math.cos(t)*r, z=Math.sin(t)*r;
  const info={}; const h=g.evaluate(x,y,z,lod,info); if (info.mtn<0.3) continue; n++;
  const e=sp/g.R; const ex=-z, ez=x; const l=Math.hypot(ex,ez)||1;
  const h1=g.evaluate(x+ex/l*e,y,z+ez/l*e,lod,null), h2=g.evaluate(x-ex/l*e,y,z-ez/l*e,lod,null);
  const curv=Math.abs(h1+h2-2*h)/sp; const s=Math.abs(h1-h2)/(2*sp);
  if (curv>2) over2++; if (curv>5) over5++; if (s>maxS) maxS=s; }
console.log(key, 'mtn samples',n,'curv>2',(over2/n*100).toFixed(1)+'%','curv>5',(over5/n*100).toFixed(1)+'%','maxSlope',maxS.toFixed(1));
