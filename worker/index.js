// Cloudflare Worker: only runs for requests that are not static assets. The aircraft
// GLBs are excluded from the assets (web/.assetsignore) and live in the R2 bucket under
// the same path, so the game loads them from /models/<key>.glb as in local development.
// /api/rooms/... is the online mode: each room is a Durable Object (room.js).

import { Room, cleanName } from './room.js';

export { Room };

/** Room codes: no 0/O or 1/I, so they survive being read out loud. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const ROOM_PATH = /^\/api\/rooms(?:\/([A-Z0-9]{6})(?:\/(ws))?)?$/;

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** POST /api/rooms creates a room; GET /api/rooms/<code> describes it; /ws joins it. */
async function rooms(request, env, match) {
  const [, code, ws] = match;
  if (!code) {
    if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
    let body = {};
    try {
      body = await request.json();
    } catch {}
    const id = randomCode();
    const settings = {
      id,
      night: !!body.night,
      gunsOnly: !!body.gunsOnly,
      seed: crypto.getRandomValues(new Uint32Array(1))[0] || 1,
      hostName: cleanName(body.name),
      hostToken: crypto.randomUUID(),
      created: Date.now(),
    };
    const stub = env.ROOMS.get(env.ROOMS.idFromName(id));
    return stub.fetch(new Request(`https://room/${id}/setup`, { method: 'POST', body: JSON.stringify(settings) }));
  }
  const stub = env.ROOMS.get(env.ROOMS.idFromName(code));
  const url = new URL(request.url);
  return stub.fetch(new Request(`https://room/${code}/${ws ? 'ws' : 'info'}${url.search}`, request));
}

const MODEL_PATH = /^\/models\/[\w-]+\.(glb|gltf|bin|ktx2)$/;

const CONTENT_TYPES = {
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  bin: 'application/octet-stream',
  ktx2: 'image/ktx2',
};

// Requests with a ?v= version (models.json "version", bumped on every upload) never change
// under that URL. Unversioned ones are revalidated with the ETag after a day.
const CACHE_VERSIONED = 'public, max-age=31536000, immutable';
const CACHE_DEFAULT = 'public, max-age=86400, stale-while-revalidate=604800';

/** Content-Range for an R2 range, which is either {offset, length} or {suffix}. */
function contentRange(range, size) {
  const offset = 'suffix' in range ? Math.max(0, size - range.suffix) : (range.offset ?? 0);
  const length = 'suffix' in range ? size - offset : (range.length ?? size - offset);
  return `bytes ${offset}-${offset + length - 1}/${size}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = ROOM_PATH.exec(url.pathname);
    if (room) return rooms(request, env, room);
    const match = MODEL_PATH.exec(url.pathname);
    if (!match) return env.ASSETS.fetch(request);
    const head = request.method === 'HEAD';
    if (request.method !== 'GET' && !head) {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    const key = url.pathname.slice(1);
    // HEAD needs only the metadata; don't stream the object out of R2 for it.
    const object = head
      ? await env.MODELS.head(key)
      : await env.MODELS.get(key, { onlyIf: request.headers, range: request.headers });
    if (!object) return new Response('Not found', { status: 404 });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('accept-ranges', 'bytes');
    headers.set('cache-control', url.searchParams.has('v') ? CACHE_VERSIONED : CACHE_DEFAULT);
    // Objects uploaded without a content type would otherwise go out as octet-stream.
    if (!headers.has('content-type')) headers.set('content-type', CONTENT_TYPES[match[1]]);

    if (head) {
      headers.set('content-length', String(object.size));
      return new Response(null, { headers });
    }
    // A failed precondition returns the object without a body: If-None-Match matched
    // (304), otherwise If-Match / If-Unmodified-Since failed (412).
    if (!('body' in object)) {
      const notModified = request.headers.has('if-none-match') || request.headers.has('if-modified-since');
      return new Response(null, { status: notModified ? 304 : 412, headers });
    }
    if (object.range && request.headers.has('range')) {
      headers.set('content-range', contentRange(object.range, object.size));
      return new Response(object.body, { status: 206, headers });
    }
    return new Response(object.body, { headers });
  },
};
