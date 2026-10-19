// Ground targets of the strike mission (SAM sites): a launcher that turns toward the
// player, a spinning search radar, and a scorch mark once destroyed.

import * as THREE from 'three';
import { GROUND } from './layout.js';

const OLIVE = 0x5b6140;
const DARK = 0x2d3024;

function samSite() {
  const site = new THREE.Group();
  const olive = new THREE.MeshStandardMaterial({ color: OLIVE, roughness: 0.85 });
  const dark = new THREE.MeshStandardMaterial({ color: DARK, roughness: 0.9 });

  // Launcher: tracked chassis, turntable and four canisters.
  const chassis = new THREE.Mesh(new THREE.BoxGeometry(7, 2, 11), olive);
  chassis.position.y = 1;
  site.add(chassis);
  const turret = new THREE.Group();
  turret.position.y = 2.2;
  const rail = new THREE.Group();
  rail.rotation.x = 0.55;
  for (let i = 0; i < 4; i++) {
    const tube = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.2, 8), dark);
    tube.position.set((i % 2 ? 0.7 : -0.7), 0.7 + Math.floor(i / 2) * 1.3, 0);
    rail.add(tube);
  }
  turret.add(rail);
  site.add(turret);

  // Search radar on a mast, a little off to the side.
  const radar = new THREE.Group();
  radar.position.set(14, 0, 4);
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.4, 7, 6), dark);
  mast.position.y = 3.5;
  radar.add(mast);
  const dish = new THREE.Mesh(new THREE.BoxGeometry(6, 2.2, 0.4), olive);
  dish.position.y = 7.5;
  radar.add(dish);
  site.add(radar);

  // Sandbag berm around the launcher.
  const berm = new THREE.Mesh(new THREE.TorusGeometry(10, 1.2, 4, 16), new THREE.MeshStandardMaterial({ color: 0x8a7a5a, roughness: 1 }));
  berm.rotation.x = Math.PI / 2;
  berm.position.y = 0.4;
  site.add(berm);

  const scorch = new THREE.Mesh(
    new THREE.CircleGeometry(16, 20),
    new THREE.MeshBasicMaterial({ color: 0x141210, transparent: true, opacity: 0.75, depthWrite: false }),
  );
  scorch.rotation.x = -Math.PI / 2;
  scorch.position.y = 0.3;
  scorch.visible = false;
  site.add(scorch);

  site.traverse((o) => { o.castShadow = o !== scorch; });
  return { site, turret, dish, scorch, live: [chassis, turret, radar, berm] };
}

export class GroundTargets {
  constructor(scene, count) {
    this.sites = [];
    for (let i = 0; i < count; i++) {
      const s = samSite();
      s.site.visible = false;
      scene.add(s.site);
      this.sites.push(s);
    }
    this._d = new THREE.Vector3();
  }

  /**
   * @param {Float32Array} buf ground records (layout.js GROUND)
   * @param {{x: number, z: number}} player  launchers track it
   */
  update(buf, player, dt) {
    for (let i = 0; i < this.sites.length; i++) {
      const s = this.sites[i];
      const o = i * GROUND.STRIDE;
      const alive = buf[o + GROUND.ALIVE] > 0;
      const hp = buf[o + GROUND.HP];
      // A slot never used this stage has no position; a destroyed site keeps its scorch.
      const used = alive || (hp <= 0 && (buf[o + GROUND.POS] !== 0 || buf[o + GROUND.POS + 2] !== 0));
      s.site.visible = used;
      if (!used) continue;
      s.site.position.set(buf[o + GROUND.POS], buf[o + GROUND.POS + 1] - 3, buf[o + GROUND.POS + 2]);
      for (let k = 0; k < s.live.length; k++) s.live[k].visible = alive;
      s.scorch.visible = !alive;
      if (!alive) continue;
      s.dish.parent.rotation.y += dt * 1.5;
      this._d.set(player.x - s.site.position.x, 0, player.z - s.site.position.z);
      s.turret.rotation.y = Math.atan2(-this._d.x, -this._d.z);
    }
  }
}
