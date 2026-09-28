import { SurfaceGen } from '../planet/SurfaceGen.js';
const U = await import('../../universe/Universe.js');
const uni = new (U.Universe||U.default)(1);
const body = uni.body(uni.system(0,6),'1');
const g = new SurfaceGen(body);
const lat=12*Math.PI/180, lon=28*Math.PI/180;
const up=[Math.cos(lat)*Math.sin(lon),Math.sin(lat),Math.cos(lat)*Math.cos(lon)], east=[Math.cos(lon),0,-Math.sin(lon)];
const north=[up[1]*east[2]-up[2]*east[1], up[2]*east[0]-up[0]*east[2], up[0]*east[1]-up[1]*east[0]];
const gg=new Float64Array(3);
let prev=null;
for (let n=16000;n<=24000;n+=40){ const e=-16000; const d=[0,1,2].map(i=>up[i]+(east[i]*e+north[i]*n)/g.R); const l=Math.hypot(...d); const x=d[0]/l,y=d[1]/l,z=d[2]/l;
  const mv=g._mountain(x,y,z,140,gg); const h=g.evaluate(x,y,z,140,null);
  if (prev!==null && Math.abs(h-prev)>25) console.log('jump at n',n,'h',h.toFixed(1),'prev',prev.toFixed(1),'mv',mv.toFixed(3));
  prev=h; }
const P=(n)=>{ const e=-16000; const d=[0,1,2].map(i=>up[i]+(east[i]*e+north[i]*n)/g.R); const l=Math.hypot(...d); return d.map(v=>v/l); };
const a=P(16800), b=P(16960);
console.log('base', g.evaluate(...a,140,null).toFixed(1), g.evaluate(...b,140,null).toFixed(1));
for (const k of Object.keys(g.st)) { const v=g.st[k]; if (typeof v!=='number' || v===0) continue; g.st[k]=0; const ha=g.evaluate(...a,140,null), hb=g.evaluate(...b,140,null); g.st[k]=v; console.log(k, ha.toFixed(1), hb.toFixed(1)); }
