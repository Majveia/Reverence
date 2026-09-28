import { SurfaceGen } from '../planet/SurfaceGen.js';
const U = await import('../../universe/Universe.js');
const uni = new (U.Universe||U.default)(1);
const g = new SurfaceGen(uni.body(uni.system(0,6),'1'));
g.st.canyons = 0;
const [lat0,lon0,e0,n0,n1] = process.argv.slice(2).map(Number);
const lat=lat0*Math.PI/180, lon=lon0*Math.PI/180;
const up=[Math.cos(lat)*Math.sin(lon),Math.sin(lat),Math.cos(lat)*Math.cos(lon)], east=[Math.cos(lon),0,-Math.sin(lon)];
const north=[up[1]*east[2]-up[2]*east[1], up[2]*east[0]-up[0]*east[2], up[0]*east[1]-up[1]*east[0]];
const P=(e,n)=>{ const d=[0,1,2].map(i=>up[i]+(east[i]*e+north[i]*n)/g.R); const l=Math.hypot(...d); return d.map(v=>v/l); };
let prev=null, best=0, bn=0;
for (let n=n0;n<=n1;n+=20){ const h=g.evaluate(...P(e0,n),60,null); if(prev!==null&&Math.abs(h-prev)>best){best=Math.abs(h-prev);bn=n;} prev=h; }
console.log('max step', best.toFixed(1), 'at', bn);
const a=P(e0,bn-20), b=P(e0,bn);
console.log('base', g.evaluate(...a,60,null).toFixed(1), g.evaluate(...b,60,null).toFixed(1));
for (const k of Object.keys(g.st)) { const v=g.st[k]; if (typeof v!=='number' || v===0) continue; g.st[k]=0; const ha=g.evaluate(...a,60,null), hb=g.evaluate(...b,60,null); g.st[k]=v; if (Math.abs((hb-ha))<best*0.5) console.log(k, ha.toFixed(1), hb.toFixed(1)); }
const gg=new Float64Array(3);
for (let n=bn-40;n<=bn+20;n+=4){ const d=P(e0,n); console.log(n, g.evaluate(...d,60,null).toFixed(1), g._mountain(...d,60,gg).toFixed(4)); }
