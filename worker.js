// Pátio · ponto de entrada do Worker: /api/* vai para o servidor; o resto é o site.
import { onRequestPost, onRequestGet } from './functions/api/[fn].js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/api\/([a-z_]+)\/?$/);
    if (m) {
      if (request.method === 'GET' && m[1] === 'manifest') return onRequestGet({ request, env, params: { fn: m[1] } });
      if (request.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, erro: 'use POST' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
      }
      return onRequestPost({ request, env, params: { fn: m[1] }, waitUntil: p => ctx.waitUntil(p) });
    }
    return env.ASSETS.fetch(request);
  },
};
