import { SurfaceGen } from '../planet/SurfaceGen.js';
import { buildChunk } from './chunkBuild.js';
const U = await import('../../universe/Universe.js');
const uni = new (U.Universe||U.default)(1);
const g = new SurfaceGen(uni.body(uni.system(0,6),'1'));
// face for lon 95 lat 0 -> dir (sin95, 0, cos95) ~ +X => face 0 (n=+x, u=-z, v=+y)
const RES=64;
let worst = 0;
for (const size of [2/32, 2/64, 2/128, 2/256]) {
  for (let t=0;t<6;t++){
    const u0 = -0.2 + t*size*1.3, v0 = -0.1 + t*size*0.7;
    const r = buildChunk(g, {face:0,u0,v0,size,RES,Dp: 1000});
    const N=RES+1; let mx=0, at=-1, mm=0;
    for (let j=1;j<N-1;j++) for (let i=1;i<N-1;i++){ const v=j*N+i; const L=(k)=>Math.hypot(r.pos[k*3]+r.center[0],r.pos[k*3+1]+r.center[1],r.pos[k*3+2]+r.center[2]);
      const h=L(v), avg=(L(v-1)+L(v+1)+L(v-N)+L(v+N))/4; const dev=Math.abs(h-avg)/r.spacing; if(dev>mx){mx=dev;at=v;}
      const m=Math.hypot(r.morph[v*4],r.morph[v*4+1],r.morph[v*4+2])/r.spacing; if (m>mm) mm=m; }
    console.log('size',size.toFixed(4),'spacing',r.spacing.toFixed(1),'maxDev/spacing',mx.toFixed(2),'at',at%N,Math.floor(at/N),'maxMorph/spacing',mm.toFixed(2));
  }
}
import { cubeDir } from './chunkBuild.js';
{
  const size=2/32, t=2, u0=-0.2+t*size*1.3, v0=-0.1+t*size*0.7; const step=size/64;
  const d=new Float64Array(3); cubeDir(0,u0+22*step,v0+41*step,d);
  const lod = 52.6*1.5;
  for (const L of [lod, lod*2, 30, 5, 0.3]) console.log('lod',L.toFixed(1),'h',g.evaluate(d[0],d[1],d[2],L,null).toFixed(1));
  const nb=new Float64Array(3); cubeDir(0,u0+23*step,v0+41*step,nb); console.log('neighbor', g.evaluate(nb[0],nb[1],nb[2],lod,null).toFixed(1));
  const base=g.evaluate(d[0],d[1],d[2],lod,null);
  for (const k of Object.keys(g.st)) { const v=g.st[k]; if (typeof v!=='number'||v===0) continue; g.st[k]=0; const h=g.evaluate(d[0],d[1],d[2],lod,null); const hn=g.evaluate(nb[0],nb[1],nb[2],lod,null); g.st[k]=v; if (Math.abs(h-hn) < 300) console.log('culprit?',k,h.toFixed(1),hn.toFixed(1)); }
}
{
  const size=2/32, t=2, u0=-0.2+t*size*1.3, v0=-0.1+t*size*0.7; const step=size/64;
  const gg=new Float64Array(3);
  for (let di=-3; di<=3; di++){ const d=new Float64Array(3); cubeDir(0,u0+(22+di*0.25)*step,v0+41*step,d); const m=g._mountain(d[0],d[1],d[2],78,gg); console.log(di*0.25, 'mv', m.toFixed(4), 'h', g.evaluate(d[0],d[1],d[2],78,null).toFixed(0)); }
}
