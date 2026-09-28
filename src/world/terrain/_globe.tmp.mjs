import zlib from 'node:zlib'; import fs from 'node:fs';
import { SurfaceGen } from '../planet/SurfaceGen.js';
const U = await import('../../universe/Universe.js');
const uni = new (U.Universe||U.default)(1);
const [,, key, outS] = process.argv;
const W = {W1:[6,'1'],W2:[11,'0'],W3:[9,'2'],W4:[2,'0'],W5:[1,'2'],W6:[1,'3'],W7:[3,'2'],W8:[2,'1'],W9:[2,'2.1'],W10:[17,'0'],W11:[0,'0'],W12:[9,'5'],M1:[0,'2.0']}[key];
const g = new SurfaceGen(uni.body(uni.system(0,W[0]),W[1]));
const NW=360, NH=180; const img=Buffer.alloc(NW*NH*3); let mx=0;
const H=new Float64Array(NW*NH);
for (let j=0;j<NH;j++) for (let i=0;i<NW;i++){ const lat=(90-(j+0.5))*Math.PI/180, lon=(i+0.5-180)*Math.PI/180; H[j*NW+i]=g.evaluate(Math.cos(lat)*Math.sin(lon),Math.sin(lat),Math.cos(lat)*Math.cos(lon),1500,null); if(H[j*NW+i]>mx)mx=H[j*NW+i]; }
for (let k=0;k<NW*NH;k++){ const h=H[k]; let c; if (g.hasOcean&&h<0) c=[20,50,110]; else { const t=Math.max(0,h)/mx; c=t<0.3?[60+200*t,140,60]:[120+135*t,120+135*t,110+145*t]; } img[k*3]=c[0];img[k*3+1]=c[1];img[k*3+2]=c[2]; }
// grid every 30deg
for (let j=0;j<NH;j++) for (let i=0;i<NW;i++) if (i%30===0||j%30===0){ const k=j*NW+i; img[k*3]=img[k*3+1]=img[k*3+2]=0; }
const raw=Buffer.alloc((NW*3+1)*NH); for(let j=0;j<NH;j++){ raw[j*(NW*3+1)]=0; img.copy(raw,j*(NW*3+1)+1,j*NW*3,(j+1)*NW*3); }
const chunk=(t,d)=>{ const b=Buffer.alloc(8+d.length+4); b.writeUInt32BE(d.length,0); b.write(t,4); d.copy(b,8); b.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(t),d]))>>>0,8+d.length); return b; };
const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(NW,0); ihdr.writeUInt32BE(NH,4); ihdr[8]=8; ihdr[9]=2;
fs.writeFileSync(outS, Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND',Buffer.alloc(0))]));
// report top peaks
const peaks=[]; for (let j=5;j<NH-5;j+=3) for (let i=0;i<NW;i+=3){ peaks.push([H[j*NW+i], 90-(j+0.5), i+0.5-180]); } peaks.sort((a,b)=>b[0]-a[0]); console.log(key,'max',mx|0,'peaks',peaks.slice(0,6).map(p=>`${p[0]|0}@${p[1].toFixed(0)},${p[2].toFixed(0)}`).join(' '));
