// Online room screens: create a room, accept an invitation, share the link, and the
// pilot lists (room screen, pause box, Tab scoreboard). The networking is in online.js.

import { createRoom, roomInfo, inviteLink, roomFromUrl, clearRoomFromUrl, savedCallsign, saveCallsign } from './online.js';

const $ = (id) => document.getElementById(id);

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The room's settings as short labels. */
function facts(room, pilots, max) {
  const out = [room.night ? 'Night' : 'Day', room.gunsOnly ? 'Guns only' : 'Guns + missiles', 'Free for all'];
  if (pilots !== undefined) out.push(`${pilots}/${max} pilots`);
  return out.map((f) => `<span>${escape(f)}</span>`).join('');
}

/** Wires a segmented radio group; returns a getter for the chosen value (0 / 1). */
function radio(group) {
  const buttons = [...group.querySelectorAll('button')];
  buttons.forEach((b) => {
    b.onclick = () => buttons.forEach((o) => o.setAttribute('aria-checked', String(o === b)));
  });
  return () => Number(buttons.find((b) => b.getAttribute('aria-checked') === 'true')?.dataset.v ?? 0);
}

export class Lobby {
  /**
   * @param {Online} online
   * @param {object} hooks onRoom() after joining (or creating) a room and after leaving one
   */
  constructor(online, hooks) {
    this.online = online;
    this.hooks = hooks;
    this.inviteCode = null;
    this.busy = false;
    this.el = $('online');
    this.name = $('online-name');
    this.name.value = savedCallsign();
    this.name.addEventListener('change', () => saveCallsign(this.name.value.trim()));
    // Typing a callsign must not pick aircraft or take off (menu keys in main.js).
    this.el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Escape') this.close();
    });
    this.time = radio($('room-time'));
    this.weapons = radio($('room-weapons'));

    $('online-btn').onclick = () => this.open();
    $('online-status').onclick = () => this.open();
    $('online-close').onclick = () => this.close();
    $('room-create').onclick = () => this.create();
    $('invite-accept').onclick = () => this.join(this.inviteCode);
    $('invite-decline').onclick = () => {
      this.inviteCode = null;
      clearRoomFromUrl();
      this.render();
    };
    $('room-ready').onclick = () => this.close();
    $('room-leave').onclick = () => this.leave();
    $('pause-leave').onclick = () => this.leave();
    $('room-copy').onclick = () => this.copy();
    $('room-share').onclick = () => this.share();
    if (!navigator.share) $('room-share').classList.add('hidden');
  }

  get isOpen() {
    return !this.el.classList.contains('hidden');
  }

  open() {
    this.error('');
    this.el.classList.remove('hidden');
    this.render();
    (this.online.active ? $('room-ready') : this.inviteCode ? $('invite-accept') : this.name).focus();
  }

  close() {
    this.el.classList.add('hidden');
  }

  error(text) {
    $('online-error').textContent = text;
  }

  callsign() {
    const name = this.name.value.trim();
    saveCallsign(name);
    return name || 'Pilot';
  }

  /** An invite link opened this page: show the invitation. */
  async checkInvite() {
    const code = roomFromUrl();
    if (!code) return;
    this.inviteCode = code;
    this.open();
    const host = this.el.querySelector('[data-invite-host]');
    host.textContent = 'A pilot';
    this.el.querySelector('[data-invite-code]').textContent = code;
    try {
      const room = await roomInfo(code);
      host.textContent = room.hostName;
      this.el.querySelector('[data-invite-facts]').innerHTML = facts(room, room.pilots, room.max);
    } catch (e) {
      this.inviteCode = null;
      clearRoomFromUrl();
      this.render();
      this.error(e.message === 'Room not found' ? `Room ${code} no longer exists` : e.message);
    }
  }

  async create() {
    if (this.busy) return;
    this.busy = true;
    this.error('');
    try {
      const room = await createRoom({ name: this.callsign(), night: this.time() === 1, gunsOnly: this.weapons() === 1 });
      await this.online.connect(room.id, this.callsign());
      this.hooks.onRoom?.();
    } catch (e) {
      this.error(e.message);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  async join(code) {
    if (this.busy || !code) return;
    this.busy = true;
    this.error('');
    try {
      await this.online.connect(code, this.callsign());
      this.inviteCode = null;
      clearRoomFromUrl();
      this.hooks.onRoom?.();
    } catch (e) {
      this.error(e.message);
    } finally {
      this.busy = false;
      this.render();
    }
  }

  leave() {
    this.online.leave();
    this.hooks.onRoom?.();
    this.render();
  }

  async copy() {
    const input = $('room-link');
    try {
      await navigator.clipboard.writeText(input.value);
      $('room-copy').textContent = 'Copied';
      setTimeout(() => { $('room-copy').textContent = 'Copy'; }, 1500);
    } catch {
      input.select();
    }
  }

  async share() {
    const { room } = this.online;
    if (!room) return;
    try {
      await navigator.share({
        title: '1923 Air Combat',
        text: `Join my 1923 Air Combat room ${room.id} (${room.night ? 'night' : 'day'})`,
        url: inviteLink(room.id),
      });
    } catch {
      // Cancelled, or not allowed here: the link is still there to copy.
    }
  }

  /** Bring every online view up to date (room screen, status chip, pilot lists). */
  render() {
    const { online } = this;
    const inRoom = online.active;
    document.body.classList.toggle('online', inRoom);
    $('online-create').classList.toggle('hidden', inRoom || !!this.inviteCode);
    $('online-invite').classList.toggle('hidden', inRoom || !this.inviteCode);
    $('online-room').classList.toggle('hidden', !inRoom);
    $('pause-online').classList.toggle('hidden', !inRoom);
    $('online-btn').classList.toggle('hidden', inRoom);
    $('online-status').classList.toggle('hidden', !inRoom);
    this.name.disabled = inRoom || this.busy;
    $('room-create').disabled = $('invite-accept').disabled = this.busy;
    if (!inRoom) return;

    const { room } = online;
    const count = online.pilots.size + 1;
    document.querySelector('[data-room-chip]').textContent = `Online · room ${room.id}`;
    document.querySelector('[data-room-sub]').textContent =
      `${count} pilot${count === 1 ? '' : 's'} · ${room.night ? 'Night' : 'Day'} · invite friends`;
    this.el.querySelector('[data-room-code]').textContent = room.id;
    this.el.querySelector('[data-room-facts]').innerHTML = facts(room);
    $('room-link').value = inviteLink(room.id);
    document.querySelectorAll('[data-room-title]').forEach((el) => {
      el.textContent = `Room ${room.id} · ${room.night ? 'Night' : 'Day'}`;
    });
    const rows = online.scoreboard().map((p, i) => `
      <li class="${p === online.me ? 'me' : ''}">
        <span class="rank">${i + 1}</span>
        <span class="who">${escape(p.name)}${p.host ? '<small>HOST</small>' : ''}${p === online.me ? '<small>YOU</small>' : ''}</span>
        <span class="kd"><b>${p.kills}</b> K · ${p.deaths} D</span>
      </li>`).join('');
    document.querySelectorAll('[data-pilots]').forEach((el) => { el.innerHTML = rows; });
  }
}
