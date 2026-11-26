// Pátio · o que buscadores, WhatsApp e IAs leem sem rodar o JavaScript da página:
//   /l/<loja> (ou a raiz do domínio próprio da loja): título, descrição, prévia de compartilhamento e endereço canônico já no HTML
//   /robots.txt, /sitemap.xml e /llms.txt de verdade
//   /og/<loja>.jpg: a foto do primeiro carro da loja, para a prévia no WhatsApp e nas redes
// Só lê o banco; nada aqui grava.

const PRINCIPAL = 'patio.useatendeja.com.br';
const ehPrincipal = h => /(^|\.)(pages\.dev|workers\.dev)$|^(localhost|127\.0\.0\.1|\[::1\])$/.test(h) || h === PRINCIPAL;
const limpaDominio = v => String(v || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/[\/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
const ativa = l => !!l.liberado || l.expira > Date.now();
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const brl = v => 'R$ ' + Math.round(+v || 0).toLocaleString('pt-BR');
const texto = (corpo, tipo, extra = {}) => new Response(corpo, { headers: { 'Content-Type': tipo, 'Cache-Control': 'public, max-age=600', ...extra } });

async function lojaPor(env, { codigo, dominio }) {
  if (!env.DB) return null;
  try {
    const l = codigo
      ? await env.DB.prepare('SELECT codigo, nome, dados, expira, liberado, dominio FROM lojas WHERE codigo = ?').bind(codigo).first()
      : await env.DB.prepare('SELECT codigo, nome, dados, expira, liberado, dominio FROM lojas WHERE dominio = ?').bind(dominio).first();
    if (!l || !ativa(l)) return null;
    return { ...l, d: JSON.parse(l.dados) };
  } catch (e) { return null; }
}

function resumoLoja(l, base) {
  const L = (l.d && l.d.loja) || {}, cid = String(L.cid || '').split('/')[0];
  const pub = ((l.d && l.d.carros) || []).filter(c => c && (c.status === 'Disponível' || c.status === 'Reservado') && c.canal !== 'repasse');
  const nome = L.nome || l.nome || 'Loja';
  const titulo = `${nome}${cid ? ' · Seminovos em ' + cid : ''}`;
  const desc = `${nome}: ${pub.length} ${pub.length === 1 ? 'carro seminovo' : 'carros seminovos'}${cid ? ' em ' + cid : ''}. ${L.slogan ? String(L.slogan).replace(/[.!?]?$/, '.') : ''} Simule o financiamento, avalie seu carro na troca e agende um test drive pelo site.`.replace(/\s+/g, ' ').trim();
  const temFoto = pub.some(c => (c.fotos || []).some(f => /^ref:[0-9a-f-]{36}$/.test(f)));
  return { L, nome, cid, pub, titulo, desc, url: base, imagem: temFoto ? `https://${PRINCIPAL}/og/${l.codigo}.jpg` : '' };
}

// Troca o cabeçalho do index.html pelo da loja (o resto da página segue igual; o JavaScript monta o site como sempre).
function comCabecalho(resp, r) {
  const metas = [
    ['name', 'description', r.desc], ['property', 'og:title', r.titulo], ['property', 'og:description', r.desc],
    ['property', 'og:type', 'website'], ['property', 'og:url', r.url], ['property', 'og:locale', 'pt_BR'],
    ['name', 'twitter:card', r.imagem ? 'summary_large_image' : 'summary'],
    ...(r.imagem ? [['property', 'og:image', r.imagem], ['property', 'og:image:width', '1000'], ['property', 'og:image:height', '625']] : []),
  ];
  const extra = metas.map(([k, n, v]) => `<meta ${k}="${n}" content="${esc(v)}">`).join('') + `<link rel="canonical" href="${esc(r.url)}">`;
  return new HTMLRewriter()
    .on('title', { element(e) { e.setInnerContent(r.titulo); } })
    .on('meta[name="description"]', { element(e) { e.remove(); } })
    .on('head', { element(e) { e.append(extra, { html: true }); } })
    .transform(resp);
}

async function paginaDaLoja(request, env, loja, base) {
  const r = resumoLoja(loja, base);
  const idx = await env.ASSETS.fetch(new Request(new URL('/', request.url), request));
  return comCabecalho(idx, r);
}

async function fotoDaLoja(env, codigo) {
  const l = await lojaPor(env, { codigo });
  if (!l) return null;
  const pub = ((l.d && l.d.carros) || []).filter(c => c && c.status === 'Disponível' && c.canal !== 'repasse');
  const ref = pub.flatMap(c => c.fotos || []).find(f => /^ref:[0-9a-f-]{36}$/.test(f));
  if (!ref) return null;
  const f = await env.DB.prepare('SELECT dados FROM fotos WHERE id = ? AND loja_id = (SELECT id FROM lojas WHERE codigo = ?)').bind(ref.slice(4), codigo).first();
  const m = f && String(f.dados).match(/^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!m) return null;
  const bytes = Uint8Array.from(atob(m[2]), c => c.charCodeAt(0));
  return new Response(bytes, { headers: { 'Content-Type': m[1], 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' } });
}

function robots(host) {
  return texto([
    'User-agent: *', 'Allow: /',
    'Disallow: /api/', 'Disallow: /admin', 'Disallow: /teste', 'Disallow: /painel', 'Disallow: /lojistas',
    'Disallow: /l/*/painel', 'Disallow: /l/*/lojistas',
    '', `Sitemap: https://${host}/sitemap.xml`, '',
  ].join('\n'), 'text/plain; charset=utf-8');
}

async function sitemap(env, host, lojaDoDominio) {
  let urls = [];
  if (lojaDoDominio) urls = [`https://${host}/`];
  else if (env.DB) {
    try {
      const { results } = await env.DB.prepare('SELECT codigo FROM lojas WHERE liberado = 1 OR expira > ? ORDER BY codigo LIMIT 5000').bind(Date.now()).all();
      urls = (results || []).map(l => `https://${PRINCIPAL}/l/${l.codigo}`);
    } catch (e) { urls = []; }
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${esc(u)}</loc></url>`).join('\n')}\n</urlset>\n`;
  return texto(xml, 'application/xml; charset=utf-8');
}

async function llms(env, host, lojaDoDominio) {
  if (lojaDoDominio) {
    const r = resumoLoja(lojaDoDominio, `https://${host}/`), L = r.L;
    const linhas = [
      `# ${r.nome}`, '', `> ${r.desc}`, '',
      '## Contato',
      ...(L.end ? [`- Endereço: ${L.end}${L.cid ? ' · ' + L.cid : ''}`] : []),
      ...(L.wpp ? [`- WhatsApp: ${L.wpp}`] : []),
      ...(L.hor ? [`- Horário: ${L.hor}`] : []),
      '', '## Carros disponíveis',
      ...r.pub.slice(0, 80).map(c => `- ${[c.marca, c.modelo, c.versao, c.ano].filter(Boolean).join(' ')}: ${brl(c.preco)}${c.km ? ', ' + Math.round(c.km).toLocaleString('pt-BR') + ' km' : ''}`),
      '', `Site: https://${host}/`, '',
    ];
    return texto(linhas.join('\n'), 'text/plain; charset=utf-8');
  }
  let lojas = [];
  if (env.DB) {
    try {
      const { results } = await env.DB.prepare('SELECT codigo, nome, dados FROM lojas WHERE liberado = 1 OR expira > ? ORDER BY nome LIMIT 500').bind(Date.now()).all();
      lojas = (results || []).map(l => { let cid = ''; try { cid = (JSON.parse(l.dados).loja || {}).cid || ''; } catch (e) { /* sem cidade */ } return `- [${l.nome || l.codigo}](https://${PRINCIPAL}/l/${l.codigo})${cid ? ': ' + cid : ''}`; });
    } catch (e) { lojas = []; }
  }
  return texto([
    '# Pátio', '',
    '> Sistema e site para lojas de veículos, feito pela Atende Já. Cada loja tem um site com o estoque atualizado, simulação de financiamento, avaliação do carro na troca e agendamento de test drive.', '',
    '## Lojas', ...lojas, '', 'Mais sobre a Atende Já: https://useatendeja.com.br', '',
  ].join('\n'), 'text/plain; charset=utf-8');
}

// Devolve a resposta quando a rota é de SEO; senão null (o Worker segue o caminho normal).
export async function seo(request, env) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url), host = url.hostname, p = url.pathname.replace(/\/+$/, '') || '/';
  const principal = ehPrincipal(host);
  const lojaDom = principal ? null : await lojaPor(env, { dominio: limpaDominio(host) });

  if (p === '/robots.txt') return robots(host);
  if (p === '/sitemap.xml') return sitemap(env, host, lojaDom);
  if (p === '/llms.txt') return llms(env, host, lojaDom);
  const og = p.match(/^\/og\/([a-z0-9-]+)\.jpg$/);
  if (og) return (await fotoDaLoja(env, og[1])) || new Response('Sem foto', { status: 404 });

  const l = p.match(/^\/l\/([a-z0-9-]+)$/);
  if (l && principal) {
    const loja = await lojaPor(env, { codigo: l[1] });
    if (loja) return paginaDaLoja(request, env, loja, `https://${PRINCIPAL}/l/${loja.codigo}`);
  }
  if (p === '/' && lojaDom) return paginaDaLoja(request, env, lojaDom, `https://${host}/`);
  return null;
}
