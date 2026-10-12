// Head-up display drawn on a 2D canvas overlay.

import { GEAR_HEIGHT } from './sim.js';
import { MODE } from './layout.js';

const PRIMARY = '#ff7466'; // symbology and good news
const DANGER = '#ff2a2a';
const WARN = '#ff6a2b';
const TEXT = '#f7eeee';
const TEXT_DIM = 'rgba(247,238,238,0.75)';
const PANEL = 'rgba(30,12,14,0.62)';
const EDGE = 'rgba(255,116,102,0.22)';
const DISPLAY = '"Chakra Petch", ui-monospace, Menlo, monospace';
const BODY = '"Barlow Semi Condensed", system-ui, sans-serif';
const font = (weight, size, fam = DISPLAY) => `${weight} ${size}px ${fam}`;
const FRIENDLY = '#7fd6ff';
/** Below this share of the tank the HUD calls BINGO (time to head home). */
const BINGO_FUEL = 0.2;

/** Bearing from the nose (rad, clockwise) as a clock position: 12 ahead, 6 behind. */
function clock(bearing) {
  const h = Math.round(bearing / (Math.PI / 6));
  return `${((h % 12) + 12) % 12 || 12} O'CLOCK`;
}

// Panel with clipped top-right and bottom-left corners, matching the menu.
function panel(g, x, y, w, h, cut = 10) {
  g.save();
  g.shadowBlur = 0;
  g.beginPath();
  g.moveTo(x, y);
  g.lineTo(x + w - cut, y);
  g.lineTo(x + w, y + cut);
  g.lineTo(x + w, y + h);
  g.lineTo(x + cut, y + h);
  g.lineTo(x, y + h - cut);
  g.closePath();
  g.fillStyle = PANEL;
  g.fill();
  g.strokeStyle = EDGE;
  g.lineWidth = 1;
  g.stroke();
  g.restore();
}

export class Hud {
  constructor(canvas) {
    this.c = canvas;
    this.g = canvas.getContext('2d');
    this.messages = [];
    this.flash = 0;
    this.showKeys = true;
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.sw = innerWidth;
    this.sh = innerHeight;
    this.c.width = Math.round(this.sw * dpr);
    this.c.height = Math.round(this.sh * dpr);
    // UI scale: layout is authored for ~1440x860 and scaled to the real
    // viewport so the HUD fills a 4K fullscreen as well as a small window.
    this.k = Math.min(1.8, Math.max(0.7, Math.min(this.sw / 1440, this.sh / 860)));
    this.w = this.sw / this.k;
    this.h = this.sh / this.k;
  }

  message(text, color = PRIMARY, ttl = 3) {
    this.messages.push({ text, color, ttl, max: ttl });
    if (this.messages.length > 4) this.messages.shift();
  }

  hit(amount) {
    this.flash = Math.min(1, this.flash + amount);
  }

  clear() {
    this.g.setTransform(1, 0, 0, 1, 0, 0);
    this.g.shadowBlur = 0;
    this.g.clearRect(0, 0, this.c.width, this.c.height);
  }

  /**
   * s: {
   *   p (Sim.player()), stats (Sim.stats()), dt, pitchDeg, bankDeg, headingDeg, fovDeg,
   *   targets: [{x, y, onScreen, dist, locked, b2}] (CSS px), lockProgress,
   *   radar: [{dx, dz, locked, b2}], base: {dx, dz}, cockpit, invert,
   *   maxMissiles, aircraftName, gearDown, airbrake, gStress
   * }
   */
  draw(s) {
    const g = this.g;
    this.clear();
    g.setTransform(this.dpr * this.k, 0, 0, this.dpr * this.k, 0, 0);
    const { w, h } = this;
    const cx = w / 2;
    const cy = h / 2;
    const p = s.p;
        g.lineWidth = 1.5;
    g.font = font(600, 14);
    g.textBaseline = 'middle';

    if (this.flash > 0) {
      const grad = g.createRadialGradient(cx, cy, Math.min(w, h) * 0.3, cx, cy, Math.max(w, h) * 0.7);
      grad.addColorStop(0, 'rgba(255,0,0,0)');
      grad.addColorStop(1, `rgba(255,0,0,${this.flash * 0.55})`);
      g.fillStyle = grad;
      g.fillRect(0, 0, w, h);
      this.flash = Math.max(0, this.flash - s.dt * 1.8);
    }

    if (s.cockpit) this.canopyFrame(g, w, h);
    // Dark halo keeps the symbology readable against bright sky.
    g.shadowColor = 'rgba(16,2,3,0.95)';
    g.shadowBlur = 4;

    if (p.alive) {
      this.ladder(g, cx, cy, s);
      this.headingTape(g, cx, s.headingDeg);
      this.tapes(g, w, h, cx, cy, p);
      this.reticle(g, cx, cy);
      if (!p.onGround) this.flightPathMarker(g, cx, cy, p, s);
      this.targets(g, w, h, s);
      this.weapons(g, w, h, p, s);
      this.warnings(g, cx, cy, p, s);
    } else {
      g.textAlign = 'center';
      g.fillStyle = DANGER;
      g.font = font(700, 44);
      // The kill cam keeps the view clear: its caption sits low on the screen.
      const ty = s.killcam ? h - 110 : cy - 22;
      g.fillText(s.killcam ? 'KILL CAM' : 'SHOT DOWN', cx, ty);
      g.font = font(500, 18, BODY);
      g.fillStyle = TEXT;
      g.fillText(`Respawning on the runway in ${Math.ceil(p.respawn)} s`, cx, ty + 40);
    }
    this.scoreboard(g, s);
    this.mission(g, w, s);
    this.keyHelp(g);
    this.radar(g, w, h, s);
    this.drawMessages(g, cx, s.dt);
  }

  canopyFrame(g, w, h) {
    g.save();
    g.strokeStyle = 'rgba(30,14,16,0.9)';
    g.lineWidth = 10;
    g.beginPath();
    g.moveTo(w * 0.12, h);
    g.quadraticCurveTo(w * 0.18, h * 0.25, w * 0.02, -10);
    g.moveTo(w * 0.88, h);
    g.quadraticCurveTo(w * 0.82, h * 0.25, w * 0.98, -10);
    g.stroke();
    // Instrument panel coaming
    g.fillStyle = 'rgba(26,12,14,0.92)';
    g.beginPath();
    g.moveTo(0, h);
    g.lineTo(0, h * 0.9);
    g.quadraticCurveTo(w / 2, h * 0.8, w, h * 0.9);
    g.lineTo(w, h);
    g.fill();
    g.restore();
  }

  ladder(g, cx, cy, s) {
    const pxPerDeg = (this.h / 2) / (s.fovDeg / 2);
    g.save();
    g.beginPath();
    g.rect(cx - 220, cy - 200, 440, 400);
    g.clip();
    g.translate(cx, cy);
    g.rotate((-s.bankDeg * Math.PI) / 180);
    g.strokeStyle = PRIMARY;
    g.fillStyle = PRIMARY;
    g.textAlign = 'left';
    g.font = font(600, 12);
    const base = Math.round(s.pitchDeg / 5) * 5;
    for (let a = base - 30; a <= base + 30; a += 5) {
      if (a < -90 || a > 90) continue;
      const y = (s.pitchDeg - a) * pxPerDeg;
      const half = a === 0 ? 180 : 70;
      g.setLineDash(a < 0 ? [8, 6] : []);
      g.beginPath();
      if (a === 0) {
        g.moveTo(-half, y); g.lineTo(-40, y);
        g.moveTo(40, y); g.lineTo(half, y);
      } else {
        const tick = a > 0 ? 8 : -8;
        g.moveTo(-half, y + tick); g.lineTo(-half, y); g.lineTo(-30, y);
        g.moveTo(30, y); g.lineTo(half, y); g.lineTo(half, y + tick);
      }
      g.stroke();
      if (a !== 0) {
        g.fillText(String(a), half + 6, y);
        g.textAlign = 'right';
        g.fillText(String(a), -half - 6, y);
        g.textAlign = 'left';
      }
    }
    g.setLineDash([]);
    g.restore();
  }

  headingTape(g, cx, hdg) {
    g.save();
    g.strokeStyle = PRIMARY;
    g.fillStyle = PRIMARY;
    g.textAlign = 'center';
    const y = 34;
    const span = 60;
    const scale = 6;
    g.beginPath();
    g.rect(cx - (span / 2) * scale, y - 20, span * scale, 44);
    g.clip();
    for (let d = Math.floor(hdg - span / 2); d <= hdg + span / 2; d++) {
      if (d % 5) continue;
      const x = cx + (d - hdg) * scale;
      const n = ((d % 360) + 360) % 360;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x, y + (n % 10 === 0 ? 10 : 5));
      g.stroke();
      if (n % 10 === 0) {
        const lbl = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[n] ?? String(n / 10).padStart(2, '0');
        g.fillText(lbl, x, y - 8);
      }
    }
    g.restore();
    g.fillStyle = PRIMARY;
    g.beginPath();
    g.moveTo(cx, y + 14);
    g.lineTo(cx - 6, y + 24);
    g.lineTo(cx + 6, y + 24);
    g.fill();
    g.textAlign = 'center';
    g.fillText(String(Math.round(((hdg % 360) + 360) % 360)).padStart(3, '0'), cx, y + 36);
  }

  tapes(g, w, h, cx, cy, p) {
    const kmh = Math.round(p.speed * 3.6);
    const alt = Math.round(p.y - GEAR_HEIGHT);
    const vs = p.verticalSpeed;
    g.strokeStyle = PRIMARY;
    g.fillStyle = PRIMARY;
    const box = (x, label, value, sub, right) => {
      // Bracket box opening toward the screen centre.
      const bw = 110;
      const x0 = x - bw / 2;
      g.beginPath();
      if (right) {
        g.moveTo(x0 + 12, cy - 18); g.lineTo(x0, cy - 18); g.lineTo(x0, cy + 18); g.lineTo(x0 + 12, cy + 18);
        g.moveTo(x0, cy); g.lineTo(x0 - 8, cy);
      } else {
        g.moveTo(x0 + bw - 12, cy - 18); g.lineTo(x0 + bw, cy - 18); g.lineTo(x0 + bw, cy + 18); g.lineTo(x0 + bw - 12, cy + 18);
        g.moveTo(x0 + bw, cy); g.lineTo(x0 + bw + 8, cy);
      }
      g.stroke();
      g.textAlign = 'center';
      g.font = font(700, 24);
      g.fillText(value, x, cy + 1);
      g.font = font(600, 12);
      g.fillText(label, x, cy - 32);
      if (sub) g.fillText(sub, x, cy + 32);
    };
    const lx = cx - Math.min(320, w * 0.3);
    const rx = cx + Math.min(320, w * 0.3);
    box(lx, 'SPD km/h', String(kmh), `M ${p.mach.toFixed(2)}`, false);
    box(rx, 'ALT m', String(alt), `${vs >= 0 ? '▲' : '▼'} ${Math.abs(vs).toFixed(0)} m/s`, true);
    g.font = font(600, 13);
    g.textAlign = 'center';
    g.fillText(`G ${p.gLoad.toFixed(1)}`, lx, cy + 52);
    g.fillText(`α ${((p.alpha * 180) / Math.PI).toFixed(1)}°`, lx, cy + 70);
    // Wind: the direction it blows from, like a METAR.
    const [wx, , wz] = p.wind;
    const wspd = Math.hypot(wx, wz);
    const wfrom = Math.round(((Math.atan2(-wx, wz) * 180) / Math.PI + 360) % 360);
    g.fillText(`WIND ${String(wfrom).padStart(3, '0')}° ${wspd.toFixed(0)} m/s`, rx, cy + 52);
  }

  /** Flight path marker: where the aircraft is actually going, offset from the nose by AoA and sideslip. */
  flightPathMarker(g, cx, cy, p, s) {
    const pxPerDeg = (this.h / 2) / (s.fovDeg / 2);
    const deg = 180 / Math.PI;
    const x = cx + Math.max(-160, Math.min(160, p.beta * deg * pxPerDeg));
    const y = cy + Math.max(-160, Math.min(160, p.alpha * deg * pxPerDeg));
    g.save();
    g.strokeStyle = p.stall ? DANGER : PRIMARY;
    g.beginPath();
    g.arc(x, y, 7, 0, Math.PI * 2);
    g.moveTo(x - 20, y); g.lineTo(x - 7, y);
    g.moveTo(x + 7, y); g.lineTo(x + 20, y);
    g.moveTo(x, y - 7); g.lineTo(x, y - 14);
    g.stroke();
    g.restore();
  }

  reticle(g, cx, cy) {
    g.strokeStyle = PRIMARY;
    g.beginPath();
    g.arc(cx, cy, 14, 0, Math.PI * 2);
    g.moveTo(cx - 28, cy); g.lineTo(cx - 16, cy);
    g.moveTo(cx + 16, cy); g.lineTo(cx + 28, cy);
    g.moveTo(cx, cy - 16); g.lineTo(cx, cy - 22);
    g.stroke();
    g.fillStyle = PRIMARY;
    g.fillRect(cx - 1.5, cy - 1.5, 3, 3);
  }

  targets(g, w, h, s) {
    const margin = 48;
    const k = this.k;
    let nearestOff = null;
    for (const t0 of s.targets) {
      // Target positions arrive in CSS pixels; convert to HUD units.
      const t = { ...t0, x: t0.x / k, y: t0.y / k };
      if (t.onScreen) {
        const size = Math.max(14, Math.min(60, 9000 / t.dist));
        g.strokeStyle = t.friendly ? FRIENDLY : t.locked ? (s.lockProgress >= 1 ? DANGER : WARN) : DANGER;
        g.lineWidth = t.locked ? 2.5 : 1.5;
        // Corner brackets instead of a closed box.
        const hs = size / 2;
        const c = Math.max(5, size * 0.28);
        g.beginPath();
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          g.moveTo(t.x + sx * hs, t.y + sy * (hs - c));
          g.lineTo(t.x + sx * hs, t.y + sy * hs);
          g.lineTo(t.x + sx * (hs - c), t.y + sy * hs);
        }
        g.stroke();
        g.fillStyle = g.strokeStyle;
        g.font = font(600, 12);
        g.textAlign = 'center';
        g.fillText(`${(t.dist / 1000).toFixed(1)} km`, t.x, t.y + size / 2 + 11);
        if (t.label) g.fillText(t.label, t.x, t.y - size / 2 - 9);
        if (t.locked) {
          g.beginPath();
          g.arc(t.x, t.y, size * 0.9, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * s.lockProgress);
          g.stroke();
          if (s.lockProgress >= 1) g.fillText('LOCK', t.x, t.y - size / 2 - (t.label ? 22 : 9));
        }
        g.lineWidth = 1.5;
      } else if (!t.friendly && (!nearestOff || t.dist < nearestOff.dist)) {
        nearestOff = t;
      }
    }
    if (nearestOff) {
      // Arrow on the screen edge toward the nearest off-screen enemy.
      const dx = nearestOff.x - w / 2;
      const dy = nearestOff.y - h / 2;
      const a = Math.atan2(dy, dx);
      const r = Math.min(w, h) / 2 - margin;
      const x = w / 2 + Math.cos(a) * r;
      const y = h / 2 + Math.sin(a) * r;
      g.save();
      g.translate(x, y);
      g.rotate(a);
      g.fillStyle = DANGER;
      g.beginPath();
      g.moveTo(16, 0); g.lineTo(-8, -10); g.lineTo(-8, 10);
      g.fill();
      g.restore();
      g.fillStyle = DANGER;
      g.textAlign = 'center';
      g.font = font(600, 12);
      g.fillText(`${(nearestOff.dist / 1000).toFixed(1)} km`, x - Math.cos(a) * 26, y - Math.sin(a) * 26);
    }
  }

  weapons(g, w, h, p, s) {
    const pw = 300;
    const ph = 178;
    const x = 20;
    const y = h - ph - 20;
    panel(g, x, y, pw, ph);
    g.textAlign = 'left';
    g.font = font(600, 12);
    // Throttle
    const tx = x + 16;
    const ty = y + 28;
    // Bar: engine output (spools up/down); tick: throttle lever.
    const th = p.engine;
    const lever = p.throttle;
    const tH = ph - 46;
    g.fillStyle = PRIMARY;
    g.fillText('THR', tx, y + 16);
    g.strokeStyle = EDGE;
    g.strokeRect(tx, ty, 14, tH);
    g.fillStyle = th > 0.95 ? WARN : PRIMARY;
    g.fillRect(tx + 2, ty + tH - 2 - th * (tH - 4), 10, th * (tH - 4));
    const ly = ty + tH - 2 - lever * (tH - 4);
    g.fillStyle = TEXT;
    g.fillRect(tx - 3, ly - 1, 20, 2);
    g.fillStyle = th > 0.95 ? WARN : PRIMARY;
    g.fillText(`${Math.round(th * 100)}`, tx + 20, ty + tH - th * (tH - 4));
    if (th > 0.95) g.fillText('AB', tx + 20, ty + tH - th * (tH - 4) + 14);

    const hx = x + 76;
    const bw = pw - 92;
    // Hull
    const hp = p.hp / p.maxHp;
    g.fillStyle = PRIMARY;
    g.fillText('HULL', hx, y + 16);
    g.textAlign = 'right';
    g.fillText(`${Math.round(hp * 100)}%`, hx + bw, y + 16);
    g.textAlign = 'left';
    const segs = 20;
    const on = Math.ceil(hp * segs);
    const sw = (bw - (segs - 1) * 2) / segs;
    for (let i = 0; i < segs; i++) {
      g.fillStyle = i < on ? (hp > 0.5 ? PRIMARY : hp > 0.25 ? WARN : DANGER) : 'rgba(255,116,102,0.12)';
      g.fillRect(hx + i * (sw + 2), y + 26, sw, 8);
    }
    // Weapons
    g.fillStyle = PRIMARY;
    g.font = font(600, 12);
    g.fillText('GUN', hx, y + 54);
    g.fillText('MSL', hx, y + 76);
    g.font = font(700, 16);
    g.fillStyle = p.ammo > 0 ? TEXT : WARN;
    g.fillText(String(p.ammo), hx + 40, y + 54);
    const mx = hx + 40;
    for (let i = 0; i < s.maxMissiles; i++) {
      const filled = i < p.missiles;
      const px = mx + (i % 8) * 18;
      const py = y + 70 + Math.floor(i / 8) * 8;
      g.fillStyle = filled ? TEXT : 'rgba(255,116,102,0.15)';
      g.fillRect(px, py, 14, s.maxMissiles > 8 ? 5 : 12);
    }
    // Flares
    g.fillStyle = PRIMARY;
    g.font = font(600, 12);
    g.fillText('FLR', hx, y + 96);
    g.font = font(700, 16);
    g.fillStyle = p.flares > 0 ? TEXT : WARN;
    g.fillText(String(p.flares), hx + 40, y + 96);
    // Systems: engine, flight controls, fuel tank.
    const sys = [['ENG', p.engineHealth], ['CTL', p.controlHealth], ['TNK', p.fuelLeak > 0 ? 0.4 : 1]];
    g.font = font(600, 11);
    sys.forEach(([label, health], i) => {
      g.fillStyle = health >= 0.99 ? 'rgba(255,116,102,0.35)' : health > 0.5 ? WARN : DANGER;
      g.fillText(label, hx + 92 + i * 38, y + 96);
    });
    // Fuel
    const fuel = Math.max(0, p.fuel);
    const low = fuel < BINGO_FUEL;
    g.fillStyle = PRIMARY;
    g.font = font(600, 12);
    g.fillText('FUEL', hx, y + 118);
    g.textAlign = 'right';
    g.fillStyle = low ? WARN : PRIMARY;
    g.fillText(`${Math.round(fuel * 100)}%`, hx + bw, y + 118);
    g.textAlign = 'left';
    g.fillStyle = 'rgba(255,116,102,0.12)';
    g.fillRect(hx + 40, y + 114, bw - 80, 8);
    g.fillStyle = fuel < 0.1 ? DANGER : low ? WARN : PRIMARY;
    g.fillRect(hx + 40, y + 114, (bw - 80) * fuel, 8);
    // Status line
    g.font = font(500, 13, BODY);
    g.fillStyle = TEXT_DIM;
    g.fillText(`${s.cockpit ? 'Cockpit' : 'Chase'} cam${s.invert ? ' · Inverted pitch' : ''}`, hx, y + 144);
    g.fillStyle = s.gearDown ? WARN : TEXT_DIM;
    g.fillText(`Gear ${s.gearDown ? 'down' : 'up'}${s.airbrake ? ' · Airbrake' : ''}`, hx, y + 162);
  }

  warnings(g, cx, cy, p, s) {
    const items = [];
    const blink = (performance.now() / 300) % 2 < 1;
    const st = s.stats;
    if (st.missileWarn > 0) {
      if (blink) items.push([`MISSILE ${clock(st.missileBearing)} · ${(st.missileDist / 1000).toFixed(1)} km · FLARES (C)`, DANGER]);
    } else if (st.rwrLock >= 0.999) {
      items.push(['RADAR LOCK', DANGER]);
    }
    if (p.fuel <= 0 && !p.onGround) items.push(['FLAMEOUT · OUT OF FUEL', DANGER]);
    else if (p.fuel < BINGO_FUEL) items.push(['BINGO FUEL · RETURN TO BASE', WARN]);
    if (p.fuelLeak > 0) items.push(['FUEL LEAK', WARN]);
    if (p.engineHealth < 0.8) items.push([`ENGINE DAMAGED · ${Math.round(30 + 70 * p.engineHealth)}% THRUST`, p.engineHealth < 0.5 ? DANGER : WARN]);
    if (p.controlHealth < 0.8) items.push(['FLIGHT CONTROLS DAMAGED', p.controlHealth < 0.5 ? DANGER : WARN]);
    if (p.onGround) {
      const vr = Math.round(p.rotateSpeed * 3.6);
      const nearBase = Math.hypot(s.base.dx, s.base.dz) < 1200;
      if (p.service > 0 && p.service < 1) items.push([`Ground crew · rearm, refuel, repair ${Math.round(p.service * 100)}%`, PRIMARY]);
      else if (nearBase && p.speed > 3 && p.speed < 60 && p.throttle < 0.3) items.push(['Stop with B to rearm and refuel', PRIMARY]);
      else items.push([p.speed < p.rotateSpeed ? `Throttle up (Shift) · rotate with S at ${vr} km/h` : 'ROTATE · pull up with S', p.speed < p.rotateSpeed ? PRIMARY : WARN]);
    } else {
      if (p.stall && blink) items.push(['STALL', DANGER]);
      if (s.gStress > 0.25 && blink) items.push([p.gLoad < 0 ? 'NEGATIVE G' : 'OVER-G', s.gStress > 0.6 ? DANGER : WARN]);
      const agl = p.y;
      const vs = p.verticalSpeed;
      if (agl < 300 && vs < -15 && blink) items.push(['PULL UP', DANGER]);
      if (p.outOfBounds) items.push(['LEAVING COMBAT AREA · RETURN TO BASE', WARN]);
      if (p.ammo <= 0) items.push(['GUN EMPTY', WARN]);
      // Approach advice when low near the airfield.
      const nearBase = Math.hypot(s.base.dx, s.base.dz) < 6000;
      if (nearBase && agl < 400 && vs < 0 && p.speed * 3.6 > 400) items.push(['Approach: cut throttle (Ctrl), airbrake (B), below 350 km/h', PRIMARY]);
    }
    g.textAlign = 'center';
    items.slice(0, 5).forEach(([t, c], i) => {
      const y = cy + 130 + i * 32;
      g.font = font(700, 18);
      const tw = g.measureText(t).width + 32;
      panel(g, cx - tw / 2, y - 14, tw, 28, 8);
      g.fillStyle = c;
      g.fillText(t, cx, y + 1);
    });
  }

  scoreboard(g, s) {
    const st = s.stats;
    const x = 20;
    const y = 20;
    panel(g, x, y, 230, 104);
    g.textAlign = 'left';
    g.fillStyle = TEXT;
    g.font = font(700, 30);
    g.fillText(String(Math.round(st.score)), x + 16, y + 28);
    g.font = font(600, 12);
    g.fillStyle = PRIMARY;
    g.textAlign = 'right';
    g.fillText(`WAVE ${st.wave}`, x + 214, y + 22);
    g.fillStyle = st.botsAlive > 0 ? DANGER : PRIMARY;
    g.fillText(`${st.botsAlive} HOSTILE`, x + 214, y + 38);
    g.textAlign = 'left';
    g.fillStyle = TEXT_DIM;
    g.font = font(500, 14, BODY);
    g.fillText(`Kills ${st.kills}   Losses ${st.deaths}`, x + 16, y + 62);
    g.textAlign = 'right';
    g.fillStyle = WARN;
    g.font = font(600, 12);
    g.fillText(`${s.rank} · ${s.careerKills}`, x + 214, y + 62);
    g.textAlign = 'left';
    g.font = font(500, 14, BODY);
    g.fillStyle = PRIMARY;
    if (st.botsAlive === 0 && st.waveTimer > 0) g.fillText(`Next wave in ${Math.ceil(st.waveTimer)} s`, x + 16, y + 84);
    else g.fillText(s.aircraftName, x + 16, y + 84);
  }

  /** Mission objective (strike / escort modes), top right. */
  mission(g, w, s) {
    const st = s.stats;
    let title;
    let line;
    let color = PRIMARY;
    if (st.mode === MODE.STRIKE) {
      title = `STRIKE · AREA ${st.stage}`;
      line = st.objectivesLeft > 0
        ? `${st.objectivesLeft} SAM site${st.objectivesLeft === 1 ? '' : 's'} left · fly low to hide`
        : `Next target area in ${Math.ceil(st.missionTimer)} s`;
    } else if (st.mode === MODE.ESCORT) {
      title = `ESCORT · BOMBER ${st.stage}`;
      if (st.escortHp >= 0) {
        line = `Hull ${Math.round(st.escortHp * 100)}% · ${st.objectivesLeft} legs to go`;
        if (st.escortHp < 0.4) color = DANGER;
      } else {
        line = `Next bomber in ${Math.ceil(st.missionTimer)} s`;
      }
    } else {
      return;
    }
    const pw = 270;
    const x = w - pw - 20;
    const y = 20;
    panel(g, x, y, pw, 56);
    g.textAlign = 'left';
    g.font = font(700, 14);
    g.fillStyle = WARN;
    g.fillText(title, x + 14, y + 19);
    g.font = font(500, 14, BODY);
    g.fillStyle = color;
    g.fillText(line, x + 14, y + 40);
  }

  // Key reference under the scoreboard; H toggles it.
  keyHelp(g) {
    const x = 20;
    const y = 136;
    const kbd = (k, kx, ky) => {
      g.font = font(600, 11);
      const kw = Math.max(20, g.measureText(k).width + 12);
      g.strokeStyle = 'rgba(255,116,102,0.45)';
      g.lineWidth = 1;
      g.strokeRect(kx + 0.5, ky - 9.5, kw, 19);
      g.fillStyle = TEXT;
      g.textAlign = 'center';
      g.fillText(k, kx + kw / 2, ky);
      return kw;
    };
    if (!this.showKeys) {
      panel(g, x, y, 150, 32, 8);
      const kw = kbd('H', x + 12, y + 16);
      g.textAlign = 'left';
      g.font = font(500, 13, BODY);
      g.fillStyle = TEXT_DIM;
      g.fillText('Show controls', x + 20 + kw, y + 16);
      return;
    }
    const rows = [
      [['S', 'W'], 'Pitch up / down'],
      [['A', 'D'], 'Roll'],
      [['Q', 'E'], 'Rudder'],
      [['Shift'], 'Throttle up'],
      [['Ctrl'], 'Throttle down'],
      [['Space'], 'Cannon'],
      [['X'], 'Missile'],
      [['C'], 'Flares'],
      [['B'], 'Brake / airbrake'],
      [['V'], 'Camera'],
      [['I'], 'Invert pitch'],
      [['M'], 'Mute'],
      [['Esc'], 'Pause'],
      [['H'], 'Hide controls'],
    ];
    const lh = 24;
    panel(g, x, y, 230, rows.length * lh + 18);
    rows.forEach(([keys, label], i) => {
      const ry = y + 9 + lh / 2 + i * lh;
      let kx = x + 12;
      for (const k of keys) kx += kbd(k, kx, ry) + 4;
      g.textAlign = 'left';
      g.font = font(500, 13, BODY);
      g.fillStyle = 'rgba(247,238,238,0.85)';
      g.fillText(label, x + 96, ry);
    });
  }

  radar(g, w, h, s) {
    const r = 86;
    const x = w - r - 28;
    const y = h - r - 34;
    const range = 8000;
    g.save();
    g.fillStyle = PANEL;
    g.strokeStyle = 'rgba(255,116,102,0.35)';
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.beginPath();
    g.arc(x, y, r / 2, 0, Math.PI * 2);
    g.moveTo(x - r, y); g.lineTo(x + r, y);
    g.moveTo(x, y - r); g.lineTo(x, y + r);
    g.stroke();
    // Heading-up: rotate world by -heading.
    const hr = (s.headingDeg * Math.PI) / 180;
    const cos = Math.cos(hr);
    const sin = Math.sin(hr);
    const plot = (dx, dz) => {
      // dx east, dz south in world; screen up = player heading.
      const east = dx;
      const north = -dz;
      const rx = east * cos - north * sin;
      const ry = east * sin + north * cos;
      return [x + (rx / range) * r, y - (ry / range) * r, Math.hypot(rx, ry) / range];
    };
    // Airfield
    const [bx, by, bd] = plot(s.base.dx, s.base.dz);
    if (bd < 1) {
      g.fillStyle = '#fff';
      g.fillRect(bx - 3, by - 3, 6, 6);
    }
    for (const t of s.radar) {
      const [px, py, d] = plot(t.dx, t.dz);
      if (d > 1) continue;
      g.fillStyle = t.friendly ? FRIENDLY : t.locked ? WARN : DANGER;
      if (t.ground) {
        g.fillRect(px - 3.5, py - 3.5, 7, 7);
        continue;
      }
      g.beginPath();
      g.arc(px, py, t.b2 ? 4.5 : 3, 0, Math.PI * 2);
      g.fill();
    }
    // Missile warning: a spoke toward the nearest missile tracking us.
    const st = s.stats;
    if (st.missileWarn > 0) {
      const a = st.missileBearing;
      const len = Math.min(1, st.missileDist / range) * r;
      g.strokeStyle = DANGER;
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(x + Math.sin(a) * Math.max(len, 18), y - Math.cos(a) * Math.max(len, 18));
      g.stroke();
      g.lineWidth = 1.5;
    }
    // Radar warning ring: brightens as an enemy radar builds its lock.
    if (st.rwrLock > 0 || st.missileWarn > 0) {
      g.strokeStyle = st.missileWarn > 0 || st.rwrLock >= 0.999 ? DANGER : WARN;
      g.globalAlpha = st.missileWarn > 0 ? 1 : 0.35 + 0.65 * st.rwrLock;
      g.lineWidth = 3;
      g.beginPath();
      g.arc(x, y, r + 4, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 1;
      g.lineWidth = 1.5;
    }
    g.fillStyle = PRIMARY;
    g.beginPath();
    g.moveTo(x, y - 7); g.lineTo(x - 5, y + 5); g.lineTo(x + 5, y + 5);
    g.fill();
    g.font = font(600, 11);
    g.textAlign = 'center';
    g.fillText('8 km', x, y + r + 14);
    g.restore();
  }

  drawMessages(g, cx, dt) {
    g.textAlign = 'center';
    g.font = font(600, 18);
    this.messages = this.messages.filter((m) => (m.ttl -= dt) > 0);
    this.messages.forEach((m, i) => {
      const y = 112 + i * 34;
      g.globalAlpha = Math.min(1, m.ttl / 0.5);
      const tw = g.measureText(m.text).width + 36;
      panel(g, cx - tw / 2, y - 15, tw, 30, 8);
      g.fillStyle = m.color;
      g.fillText(m.text, cx, y + 1);
    });
    g.globalAlpha = 1;
  }
}

export const COLORS = { PRIMARY, DANGER, WARN };
