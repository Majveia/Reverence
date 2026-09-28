import { SurfaceGen } from '../planet/SurfaceGen.js';
import { buildChunk, cubeDir } from './chunkBuild.js';
const U = await import('../../universe/Universe.js');
const uni = new (U.Universe||U.default)(1);
const g = new SurfaceGen(uni.body(uni.system(0,6),'1'));
const RES=64;
const size=+(process.env.SZ||2/64), t=+(process.env.T||4); const u0=-0.2+t*size*1.3, v0=-0.1+t*size*0.7;
const r = buildChunk(g, {face:0,u0,v0,size,RES,Dp:1000}); const N=65; const step=size/64;
let mx=0, at=0; const L=(k)=>Math.hypot(r.pos[k*3]+r.center[0],r.pos[k*3+1]+r.center[1],r.pos[k*3+2]+r.center[2]);
for (let j=1;j<N-1;j++) for (let i=1;i<N-1;i++){ const v=j*N+i; const dev=Math.abs(L(v)-(L(v-1)+L(v+1)+L(v-N)+L(v+N))/4)/r.spacing; if(dev>mx){mx=dev;at=v;} }
const i=at%N, j=Math.floor(at/N); console.log('worst',mx.toFixed(2),i,j,'spacing',r.spacing.toFixed(1));
const lod=r.spacing*1.5; const P=(di,dj)=>{ const d=new Float64Array(3); cubeDir(0,u0+(i+di)*step,v0+(j+dj)*step,d); return d; };
const dev=()=>{ const h=(a,b)=>{ const d=P(a,b); return g.evaluate(d[0],d[1],d[2],lod,null); }; return Math.abs(h(0,0)-(h(-1,0)+h(1,0)+h(0,-1)+h(0,1))/4)/r.spacing; };
console.log('dev', dev().toFixed(2));
for (const k of Object.keys(g.st)) { const v=g.st[k]; if (typeof v!=='number'||v===0) continue; g.st[k]=0; const dd=dev(); g.st[k]=v; if (dd<mx*0.5) console.log('culprit',k,dd.toFixed(2)); }
// profile the gully term along i
const gg=new Float64Array(3);
for (let di=-2; di<=2; di+=0.25){ const d=P(di,0); const info={}; const h=g.evaluate(d[0],d[1],d[2],lod,info); g.st.erosion=0; const h0=g.evaluate(d[0],d[1],d[2],lod,null); g.st.erosion=1.25; console.log(di.toFixed(2),'h',h.toFixed(0),'noErosion',h0.toFixed(0),'gully',(h-h0).toFixed(0)); }
{
const orig = g._eroCell.bind(g); let rec=null;
g._eroCell = (qx,qy,qz,dx,dy,dz,out) => { const v = orig(qx,qy,qz,dx,dy,dz,out); if (rec) rec.push(v.toFixed(2)+'/'+Math.hypot(dx,dy,dz).toFixed(2)); return v; };
for (let di=-0.5; di<=0.26; di+=0.25){ const d=P(di,0); rec=[]; g.evaluate(d[0],d[1],d[2],lod,null); console.log(di.toFixed(2), rec.join(' ')); }
rec=null;
}
