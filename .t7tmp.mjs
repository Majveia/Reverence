import { Universe } from './src/universe/Universe.js';
import { Celestial } from './src/world/Celestial.js';
import { RNG, hashCombine } from './src/core/rng.js';
import * as THREE from 'three';
const U = new Universe(1);
const [si, pref, upA] = process.argv.slice(2);
const sys = U.system(0, +si); const body = U.body(sys, pref);
const cel = new Celestial(sys, body);
const up = new THREE.Vector3(...upA.split(',').map(Number)).normalize();
const star = sys.star;
const r = new RNG(hashCombine(star.seed >>> 0, 0x5a7e));
const incl = r.range(0.45, 1.25);
const qGal = new THREE.Quaternion().setFromEuler(new THREE.Euler(r.range(-0.4, 0.4), r.range(0, Math.PI * 2), 0, 'YXZ')).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), incl)).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), r.range(0, Math.PI * 2)));
const gc = new THREE.Vector3(-star.position.x, -star.position.y, -star.position.z).normalize().applyQuaternion(qGal.clone().invert()); // inertial
const tod = +(process.argv[5] ?? 0.02);
const giant = body.isMoon ? sys.planets[body.parent] : null;
for (let t = 0; t < 44000; t += 1000) {
  cel.phaseOffset = 0; cel.update(t); cel.setLocalTime(up, tod);
  const g = cel.toLocalDir(gc.clone());
  let gs = '';
  if (giant) { const gl = cel.bodyLocal(giant).normalize(); const rn = new THREE.Vector3(0,1,0).applyQuaternion(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), giant.axialTilt + (giant.rings?.tilt||0) + Math.sign(giant.rings?.tilt||1)*0.42)).applyQuaternion(cel.qInv); const op = Math.asin(Math.abs(rn.dot(gl)))*57.3; gs = `ringOpen ${op.toFixed(0)} giant elev ${(Math.asin(gl.dot(up))*57.3).toFixed(0)} sep ${(Math.acos(gl.dot(g))*57.3).toFixed(0)} phaseAng ${(Math.acos(gl.dot(cel.sunDir))*57.3).toFixed(0)}`; }
  // other planets
  const pl = sys.planets.map((p,i)=>{ if (p===body|| (giant&&p===giant)) return ''; const l = cel.bodyLocal(p); const d=l.length(); l.normalize(); const e=Math.asin(l.dot(up))*57.3; return e>5? `P${i}:${e.toFixed(0)}/${(2*Math.atan(p.radius/d)*57.3).toFixed(2)}°` : ''; }).filter(Boolean).join(' ');
  console.log(t, 'gc elev', (Math.asin(g.dot(up))*57.3).toFixed(0), gs, pl);
}
