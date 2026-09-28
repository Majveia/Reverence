import zlib from 'node:zlib'; import fs from 'node:fs';
import { bakeDetail, DETAIL_SIZE, DETAIL_LAYERS } from './detailTex.js';
const S=DETAIL_SIZE, d=bakeDetail(S); const NW=S*DETAIL_LAYERS, NH=S*2; const img=Buffer.alloc(NW*NH*3);
for (let l=0;l<DETAIL_LAYERS;l++) for (let y=0;y<S;y++) for (let x=0;x<S;x++){ const o=(l*S*S+y*S+x)*4; const gx=(d[o]-128)/127, gy=(d[o+1]-128)/127; const sh=Math.max(0,Math.min(1,0.6+(-gx*0.6+gy*0.5)*1.5)); const a=d[o+3]/255;
  const k1=(y*NW+l*S+x)*3; img[k1]=img[k1+1]=img[k1+2]=Math.round(255*sh*(0.5+a*0.7)*0.8);
  const k2=((y+S)*NW+l*S+x)*3; img[k2]=d[o+2]; img[k2+1]=d[o+3]; img[k2+2]=d[o+2]; }
const raw=Buffer.alloc((NW*3+1)*NH); for(let j=0;j<NH;j++){ raw[j*(NW*3+1)]=0; img.copy(raw,j*(NW*3+1)+1,j*NW*3,(j+1)*NW*3); }
const chunk=(t,dd)=>{ const b=Buffer.alloc(8+dd.length+4); b.writeUInt32BE(dd.length,0); b.write(t,4); dd.copy(b,8); b.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(t),dd]))>>>0,8+dd.length); return b; };
const ihdr=Buffer.alloc(13); ihdr.writeUInt32BE(NW,0); ihdr.writeUInt32BE(NH,4); ihdr[8]=8; ihdr[9]=2;
fs.writeFileSync(process.argv[2], Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR',ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND',Buffer.alloc(0))]));
