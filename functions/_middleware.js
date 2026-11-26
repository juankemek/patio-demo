// Pátio no Cloudflare Pages: antes de servir a página, vê se é uma rota de SEO
// (site da loja com título e prévia, robots.txt, sitemap.xml, llms.txt e foto de prévia).
// Quais endereços passam por aqui está no _routes.json; o resto segue direto para os arquivos.
import { seo } from '../seo.js';

export async function onRequest(ctx) {
  const r = await seo(ctx.request, ctx.env).catch(() => null);
  return r || ctx.next();
}
