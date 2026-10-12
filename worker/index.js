// Cloudflare Worker: only runs for requests that are not static assets. The aircraft
// GLBs are excluded from the assets (web/.assetsignore) and live in the R2 bucket under
// the same path, so the game loads them from /models/<key>.glb as in local development.

const MODEL_PATH = /^\/models\/[\w-]+\.glb$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!MODEL_PATH.test(url.pathname)) return env.ASSETS.fetch(request);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
    }

    const object = await env.MODELS.get(url.pathname.slice(1), {
      onlyIf: request.headers,
      range: request.headers,
    });
    if (!object) return new Response('Not found', { status: 404 });

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set('etag', object.httpEtag);
    headers.set('accept-ranges', 'bytes');
    headers.set('cache-control', 'public, max-age=86400');
    if (!headers.has('content-type')) headers.set('content-type', 'model/gltf-binary');

    // A failed precondition (If-None-Match matched) returns the object without a body.
    if (!('body' in object)) return new Response(null, { status: 304, headers });
    if (object.range && request.headers.has('range')) {
      const { offset, length } = object.range;
      headers.set('content-range', `bytes ${offset}-${offset + length - 1}/${object.size}`);
      return new Response(request.method === 'HEAD' ? null : object.body, { status: 206, headers });
    }
    return new Response(request.method === 'HEAD' ? null : object.body, { headers });
  },
};
