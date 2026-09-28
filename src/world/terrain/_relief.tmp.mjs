// scratch tool (not shipped): hillshade relief maps of SurfaceGen regions → PNG
import zlib from 'node:zlib'; import fs from 'node:fs';
import { SurfaceGen } from '../planet/SurfaceGen.js';
const U = await import('../../universe/Universe.js');
const uni = new (U.Universe||U.default)(1);
const [,, key, latS, lonS, spanS, outS, NS] = process.argv;
const W = {W1:[6,'1'],W2:[11,'0'],W3:[9,'2'],W4:[2,'0'],W5:[1,'2'],W6:[1,'3'],W7:[3,'2'],W8:[2,'1'],W9:[2,'2.1'],W10:[17,'0'],W11:[0,'0'],W12:[9,'5'],M1:[0,'2.0']}[key];
const body = uni.body(uni.system(0,W[0]),W[1]);
const g = new SurfaceGen(body); if (process.env.OFF) for (const k of process.env.OFF.split(',')) g.st[k] = 0; if (process.env.SET) Object.assign(g.st, JSON.parse(process.env.SET)); if (process.env.SHOWST) console.log(JSON.stringify(g.st));
const N = +(NS||400), span = +spanS; const lat = +latS*Math.PI/180, lon = +lonS*Math.PI/180;
const up = [Math.cos(lat)*Math.sin(lon), Math.sin(lat), Math.cos(lat)*Math.cos(lon)];
const east = [Math.cos(lon), 0, -Math.sin(lon)];
const north = [up[1]*east[2]-up[2]*east[1], up[2]*east[0]-up[0]*east[2], up[0]*east[1]-up[1]*east[0]];
const H = new Float64Array(N*N); const I = new Array(N*N);
const px = span/N; const info={};
for (let j=0;j<N;j++) for (let i=0;i<N;i++){ const x=(i-N/2)*px/g.R, y=(N/2-j)*px/g.R; const d=[up[0]+east[0]*x+north[0]*y, up[1]+east[1]*x+north[1]*y, up[2]+east[2]*x+north[2]*y]; const l=Math.hypot(...d); H[j*N+i]=g.evaluate(d[0]/l,d[1]/l,d[2]/l, px*0.7, info); I[j*N+i]=[info.rock,info.sand,info.river,info.lake]; }
const img = Buffer.alloc(N*N*3); let mn=1e9,mx=-1e9; for (const h of H){ if(h<mn)mn=h; if(h>mx)mx=h; }
for (let j=0;j<N;j++) for (let i=0;i<N;i++){ const k=j*N+i; const hx=(H[j*N+Math.min(N-1,i+1)]-H[j*N+Math.max(0,i-1)])/(2*px), hy=(H[Math.max(0,j-1)*N+i]-H[Math.min(N-1,j+1)*N+i])/(2*px);
  const nl=Math.hypot(hx,hy,1); const sh=Math.max(0,(-hx*-0.6 + -hy*0.5 + 0.62)/nl);
  const h=H[k]; let c; if (g.hasOcean && h<0) c=[30,60,110].map(v=>v*(1+h/2000)); else { const t=(h-Math.max(0,mn))/(mx-Math.max(0,mn)+1); c=[90+120*t,120+80*t,70+120*t]; if (I[k][0]>0.5) c=[140,130,120]; if (I[k][1]>0.5) c=[220,200,150]; if (I[k][2]>0.3||I[k][3]>0.3) c=[60,90,160]; }
  img[k*3]=Math.min(255,c[0]*sh); img[k*3+1]=Math.min(255,c[1]*sh); img[k*3+2]=Math.min(255,c[2]*sh); }
const raw=Buffer.alloc((N*3+1)*N); for(let j=0;j<N;j++){ raw[j*(N*3+1)]=0; img.copy(raw,j*(N*3+1)+1,j*N*3,(j+1)*N*3); }
const chunk=(t,d)=>{ const b=Buffer.alloc(8+d.length+4); b.writeUInt32BE(d.length,0); b.write(t,4); d.copy(b,8); const crc=zlib.crc32?zlib.crc32(Buffer.concat([Buffer.from(t),d])):0; b.writeUInt32BE(crc>>>0,8+d.length); return b; };
const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(N,0); ihdr.writeUInt32BE(N,4); ihdr[8]=8; ihdr[9]=2;
fs.writeFileSync(outS, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND',Buffer.alloc(0))]));
console.log(key, body.type, body.art.key, 'h range', mn|0, mx|0);
