// Pátio · ponto de entrada do Worker: /api/* vai para o servidor; o resto é o site.
import { onRequestPost } from './functions/api/[fn].js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/([a-z_]+)\/?$/);
    if (m) {
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, erro: 'use POST' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
      }
      return onRequestPost({ request, env, params: { fn: m[1] } });
    }
    return env.ASSETS.fetch(request);
  },
};
