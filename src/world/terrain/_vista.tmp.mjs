// scratch: find mountain vistas. usage: node _vista.tmp.mjs W1 [n]
import { SurfaceGen } from '../planet/SurfaceGen.js';
const U = await import('../../universe/Universe.js');
const uni = new (U.Universe||U.default)(1);
const key = process.argv[2]; const NC = +(process.argv[3]||400);
const W = {W1:[6,'1'],W2:[11,'0'],W3:[9,'2'],W4:[2,'0'],W5:[1,'2'],W6:[1,'3'],W7:[3,'2'],W8:[2,'1'],W9:[2,'2.1'],W10:[17,'0'],W11:[0,'0'],W12:[9,'5'],M1:[0,'2.0']}[key];
const g = new SurfaceGen(uni.body(uni.system(0,W[0]),W[1]));
const R=g.R, D=Math.PI/180;
const dirOf=(lat,lon)=>[Math.cos(lat)*Math.sin(lon),Math.sin(lat),Math.cos(lat)*Math.cos(lon)];
function score(lat,lon){
  const up=dirOf(lat,lon); const east=[Math.cos(lon),0,-Math.sin(lon)];
  const north=[up[1]*east[2]-up[2]*east[1], up[2]*east[0]-up[0]*east[2], up[0]*east[1]-up[1]*east[0]];
  const h0=g.heightLod(...up,30); if (g.hasOcean && h0<3) return null;
  const eye=h0+2;
  let best=null;
  for (let yi=0;yi<16;yi++){ const yaw=yi*22.5*D; const f=[0,1,2].map(i=>north[i]*Math.cos(yaw)+east[i]*Math.sin(yaw));
    let maxAng=-1, water=0, near=0, mid=0, drop=0, feat=0;
    for (let d=150; d<30000; d*=1.25){ const p=[0,1,2].map(i=>up[i]+f[i]*d/R); const l=Math.hypot(...p); const info={}; const h=g.evaluate(p[0]/l,p[1]/l,p[2]/l, d*0.02, info); if (d>600 && d<9000 && (info.cliff>0.4||info.rock>0.6)) feat++;
      const curv=d*d/(2*R); const ang=Math.atan2(h-eye-curv,d);
      if (d>2500 && ang>maxAng) maxAng=ang;
      if (g.hasOcean && h<0 && d<8000) water+=1;
      if (d<1500 && ang< -0.05) drop++;
      if (d<1500 && ang> 0.12) near++; }
    // want: tall mountains mid-far, open foreground (drop = elevated viewpoint), some water, no wall in front
    const s = 14 - Math.abs(maxAng*57.3 - 13)*0.8 + Math.min(water,4)*1.5 + drop*0.8 - near*6 + Math.min(feat,8)*(+process.env.FW||0);
    if (!best || s>best.s) best={s, yaw:yi*22.5, maxAng:maxAng*57.3, water, drop, near, feat};
  }
  best.lat=lat/D; best.lon=lon/D; best.h=h0; return best;
}
const res=[];
for (let i=0;i<NC;i++){ const y=1-2*(i+0.5)/NC; const lat=Math.asin(y*0.8); const lon=((i*137.508)%360-180)*D; const s=score(lat,lon); if (s) res.push(s); }
res.sort((a,b)=>b.s-a.s);
for (const r of res.slice(0,8)) console.log(`lat=${r.lat.toFixed(2)}&lon=${r.lon.toFixed(2)}&yaw=${r.yaw}`, 'score',r.s.toFixed(1),'mtnAng',r.maxAng.toFixed(1),'water',r.water,'drop',r.drop,'feat',r.feat,'h',r.h|0);
