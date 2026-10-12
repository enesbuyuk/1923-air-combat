// Aircraft selection menu: roster list and spec panel.

import { AIRCRAFT } from './aircraft.js';

const $ = (id) => document.getElementById(id);
const capitalize = (s) => s[0].toUpperCase() + s.slice(1);

export class Menu {
  /**
   * @param {AircraftModels} models aircraft model registry (models.js), for the model source label
   * @param {(i: number) => void} onSelect
   * @param {() => void} onStart
   */
  constructor(models, onSelect, onStart) {
    this.models = models;
    this.list = $('aircraft-list');
    this.spec = $('spec');
    this.list.innerHTML = '';
    AIRCRAFT.forEach((a, i) => {
      const item = document.createElement('button');
      item.className = 'roster-item';
      item.innerHTML = `
        <span class="key">${i + 1}</span>
        <span class="name">${a.name}</span>
        <span class="role">${a.role}</span>`;
      item.onclick = () => onSelect(i);
      item.ondblclick = onStart;
      this.list.appendChild(item);
    });
  }

  show(i) {
    [...this.list.children].forEach((c, j) => c.classList.toggle('selected', j === i));
    this.renderSpec(i);
  }

  renderSpec(i) {
    const a = AIRCRAFT[i];
    const entry = this.models.entries[a.key];
    const source = entry.status === 'loading' ? '3D model: loading GLB…'
      : entry.template.userData.source === 'glb' ? '3D model: GLB' : '3D model: procedural';
    const stat = ([name, value]) => {
      const n = Math.round(value * 10);
      const cells = Array.from({ length: 10 }, (_, j) => `<i${j < n ? ' class="on"' : ''}></i>`).join('');
      return `<div class="stat">
        <div class="stat-head"><span>${capitalize(name)}</span><b>${n}/10</b></div>
        <div class="meter">${cells}</div>
      </div>`;
    };
    this.spec.innerHTML = `
      <h3>${a.name}</h3>
      <div class="role">${a.role}</div>
      ${Object.entries(a.bars).map(stat).join('')}
      <div class="spec-facts">
        <div><span>Missiles</span><b>${a.missiles}</b></div>
        <div><span>Length</span><b>${a.length.toFixed(1)} m</b></div>
      </div>
      <div class="src">${source}</div>`;
  }
}
