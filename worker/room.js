// Online rooms: one Durable Object per room relays messages between its pilots over
// WebSockets. It does not simulate anything; every client flies its own aircraft (see
// web/js/online.js). The room keeps the host's settings and the scoreboard, and uses the
// hibernation API so an idle room costs nothing between messages.

import { DurableObject } from 'cloudflare:workers';

export const MAX_PILOTS = 8;
/** A room nobody has been in for this long is deleted. */
const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
/** Largest message a client may send (a state snapshot is ~200 bytes). */
const MAX_MESSAGE = 2048;
/** Most cannon damage one hit report may carry (about 9 per burst, 20 reports a second). */
const MAX_HIT = 60;
const NAME_LENGTH = 16;

/** Printable name, trimmed and shortened; "Pilot" when nothing is left. */
export function cleanName(raw) {
  const name = String(raw ?? '').replace(/[^\p{L}\p{N} ._-]/gu, '').trim().slice(0, NAME_LENGTH);
  return name || 'Pilot';
}

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});

export class Room extends DurableObject {
  /** Pilots in the room: one accepted socket each, their details in its attachment. */
  pilots() {
    return this.ctx.getWebSockets().map((ws) => ({ ws, me: ws.deserializeAttachment() })).filter((p) => p.me);
  }

  publicPilot(me) {
    return { id: me.id, name: me.name, index: me.index, kills: me.kills, deaths: me.deaths, host: me.host };
  }

  send(ws, msg) {
    try {
      ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    } catch {
      // The socket closed under us; webSocketClose cleans up.
    }
  }

  /** Send to every pilot but `except` (a socket). */
  broadcast(msg, except = null) {
    const text = JSON.stringify(msg);
    for (const { ws } of this.pilots()) if (ws !== except) this.send(ws, text);
  }

  scores() {
    return this.pilots().map(({ me }) => this.publicPilot(me));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.pathname.split('/').pop();

    if (action === 'setup' && request.method === 'POST') {
      const settings = await request.json();
      await this.ctx.storage.put('settings', settings);
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return json(settings);
    }

    const settings = await this.ctx.storage.get('settings');
    if (!settings) return json({ error: 'Room not found' }, 404);
    const { hostToken, ...room } = settings;

    if (action !== 'ws') {
      return json({ ...room, pilots: this.pilots().length, max: MAX_PILOTS });
    }
    if (request.headers.get('upgrade') !== 'websocket') return json({ error: 'Expected a WebSocket' }, 426);

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    const pilots = this.pilots();
    if (pilots.length >= MAX_PILOTS) {
      this.send(server, { t: 'error', reason: 'full' });
      server.close(4001, 'Room full');
      return new Response(null, { status: 101, webSocket: client });
    }
    // Lowest free index: it picks the pilot's spot on the runway.
    const taken = new Set(pilots.map((p) => p.me.index));
    let index = 0;
    while (taken.has(index)) index++;
    const me = {
      id: crypto.randomUUID().slice(0, 8),
      name: cleanName(url.searchParams.get('name')),
      index,
      kills: 0,
      deaths: 0,
      // The creator's browser proves it with the token it got when making the room.
      host: !!hostToken && url.searchParams.get('host') === hostToken,
    };
    server.serializeAttachment(me);
    this.send(server, { t: 'welcome', me: this.publicPilot(me), room, pilots: pilots.map((p) => this.publicPilot(p.me)) });
    this.broadcast({ t: 'join', pilot: this.publicPilot(me) }, server);
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== 'string' || data.length > MAX_MESSAGE) return;
    const me = ws.deserializeAttachment();
    if (!me) return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    switch (msg?.t) {
      // Aircraft state, relayed as is to everyone else.
      case 's':
        if (!Array.isArray(msg.d) || msg.d.length > 32 || !msg.d.every(Number.isFinite)) return;
        this.broadcast({ t: 's', id: me.id, d: msg.d }, ws);
        break;
      // Cannon damage the sender dealt to pilot `to`: only they need it.
      case 'hit': {
        const dmg = Number(msg.dmg);
        if (!(dmg > 0)) return;
        const target = this.pilots().find((p) => p.me.id === msg.to);
        if (target) this.send(target.ws, { t: 'hit', from: me.id, dmg: Math.min(dmg, MAX_HIT) });
        break;
      }
      case 'missile':
        if (!Array.isArray(msg.d) || msg.d.length !== 6 || !msg.d.every(Number.isFinite)) return;
        this.broadcast({ t: 'missile', from: me.id, d: msg.d, target: typeof msg.target === 'string' ? msg.target : null }, ws);
        break;
      case 'flare':
        this.broadcast({ t: 'flare', from: me.id }, ws);
        break;
      // The sender was shot down (`by` the pilot credited, or none for a crash).
      case 'down': {
        me.deaths++;
        ws.serializeAttachment(me);
        const killer = msg.by && msg.by !== me.id ? this.pilots().find((p) => p.me.id === msg.by) : null;
        if (killer) {
          killer.me.kills++;
          killer.ws.serializeAttachment(killer.me);
        }
        this.broadcast({ t: 'down', id: me.id, by: killer ? killer.me.id : null, pilots: this.scores() });
        break;
      }
      case 'ping':
        this.send(ws, { t: 'pong', c: msg.c });
        break;
    }
  }

  async webSocketClose(ws, code) {
    this.leave(ws);
    try {
      ws.close(code === 1005 ? 1000 : code, 'Bye');
    } catch {}
  }

  async webSocketError(ws) {
    this.leave(ws);
  }

  leave(ws) {
    const me = ws.deserializeAttachment();
    if (!me) return;
    // Clear it so pilots() no longer lists the closing socket.
    ws.serializeAttachment(null);
    this.broadcast({ t: 'leave', id: me.id }, ws);
  }

  async alarm() {
    if (this.pilots().length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
      return;
    }
    await this.ctx.storage.deleteAll();
  }
}
