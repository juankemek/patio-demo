// Pátio · servidor do test drive (Cloudflare Pages Functions + D1)
// Cada chamada é POST /api/<função> com JSON. O banco D1 precisa estar ligado com o nome DB.

const H48 = 48 * 3600 * 1000;
const MAX_DADOS = 3000000;
const RESERVADOS = ['admin', 'teste', 'painel', 'videos', 'api', 'l'];

let pronto = false;
async function prepara(db) {
  if (pronto) return;
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS lojas(id TEXT PRIMARY KEY, codigo TEXT UNIQUE NOT NULL, nome TEXT, dados TEXT NOT NULL,
      versao INTEGER NOT NULL DEFAULT 1, criado INTEGER NOT NULL, expira INTEGER NOT NULL, liberado INTEGER NOT NULL DEFAULT 0,
      contato TEXT, visto INTEGER)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessoes(token TEXT PRIMARY KEY, loja_id TEXT NOT NULL, pessoa_id INTEGER NOT NULL, papel TEXT,
      criado INTEGER NOT NULL, visto INTEGER)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS fotos(id TEXT PRIMARY KEY, loja_id TEXT NOT NULL, dados TEXT NOT NULL, criado INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS feedbacks(id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id TEXT NOT NULL, nota INTEGER, gostou TEXT,
      faltou TEXT, continuar TEXT, quem TEXT, criado INTEGER NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS sessoes_loja ON sessoes(loja_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS fotos_loja ON fotos(loja_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS feedbacks_loja ON feedbacks(loja_id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS config(chave TEXT PRIMARY KEY, valor TEXT NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS inscricoes(endpoint TEXT PRIMARY KEY, loja_id TEXT NOT NULL, pessoa_id INTEGER NOT NULL, criado INTEGER NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS inscricoes_loja ON inscricoes(loja_id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS avisos(id INTEGER PRIMARY KEY AUTOINCREMENT, loja_id TEXT NOT NULL, titulo TEXT, corpo TEXT, url TEXT, criado INTEGER NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS avisos_loja ON avisos(loja_id, criado)`),
  ]);
  try { await db.prepare('ALTER TABLE lojas ADD COLUMN dominio TEXT').run(); } catch (e) { /* já existe */ }
  await db.prepare('CREATE INDEX IF NOT EXISTS lojas_dominio ON lojas(dominio)').run();
  pronto = true;
}

const agora = () => Date.now();
const token = () => (crypto.randomUUID() + crypto.randomUUID()).replace(/-/g, '');
const ativa = l => !!l.liberado || l.expira > agora();
const resumo = l => ({ versao: l.versao, expira: l.expira, liberado: !!l.liberado, ativa: ativa(l), codigo: l.codigo });
const semSenhas = d => ({ ...d, equipe: (d.equipe || []).map(({ senha, ...e }) => e) });
// ---- senhas embaralhadas (PBKDF2) ----
const ITER = 5000;
const b64 = u8 => btoa(String.fromCharCode(...u8));
const deB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
async function derivar(senha, sal, iter) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(senha)), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: sal, iterations: iter }, k, 256));
}
const ehHash = h => typeof h === 'string' && h.startsWith('pbkdf2$');
async function hashSenha(senha) {
  const sal = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITER}$${b64(sal)}$${b64(await derivar(senha, sal, ITER))}`;
}
async function confere(senha, guardada) {
  if (!guardada) return false;
  if (!ehHash(guardada)) return guardada === senha; // senhas antigas, de antes do embaralhamento
  const [, it, sal, h] = guardada.split('$');
  const x = b64(await derivar(senha, deB64(sal), +it));
  let dif = x.length ^ h.length;
  for (let i = 0; i < Math.min(x.length, h.length); i++) dif |= x.charCodeAt(i) ^ h.charCodeAt(i);
  return dif === 0;
}
async function embaralhaEquipe(eq) {
  return Promise.all((eq || []).map(async e => (e.senha && !ehHash(e.senha)) ? { ...e, senha: await hashSenha(e.senha) } : e));
}
// ---- o que o vendedor não vê (custo, mínimo, financeiro, parceiros) ----
const PRIV_CARRO = ['compra', 'gastos', 'parc'];
const PRIV_LISTAS = ['contas', 'despesas', 'parceiros'];
const PRIV_CAMPOS = ['saldoIni', 'hist'];
function semPrivado(d) {
  const o = { ...d };
  PRIV_LISTAS.forEach(k => { o[k] = []; });
  PRIV_CAMPOS.forEach(k => { delete o[k]; });
  const limpa = c => { const x = { ...c }; PRIV_CARRO.forEach(k => delete x[k]); return x; };
  o.carros = (d.carros || []).map(limpa);
  o.removidos = (d.removidos || []).map(limpa);
  return o;
}
function juntaVendedor(guardado, novo) {
  // o vendedor não recebeu os dados privados: mantém os guardados e só acrescenta o que ele criou
  const o = { ...novo, equipe: guardado.equipe };
  PRIV_CAMPOS.forEach(k => { if (k in guardado) o[k] = guardado[k]; else delete o[k]; });
  PRIV_LISTAS.forEach(k => {
    const g = guardado[k] || [], ids = new Set(g.map(x => String(x.id)));
    o[k] = g.concat((novo[k] || []).filter(x => !ids.has(String(x.id))));
  });
  // repasse lançado numa venda feita pelo vendedor: o valor vem do custo guardado
  const todosG = (guardado.carros || []).concat(guardado.removidos || []);
  o.contas = (o.contas || []).map(x => {
    if (x.cat !== 'Repasse a parceiro' || x.carro == null || (guardado.contas || []).some(g => String(g.id) === String(x.id))) return x;
    const c = todosG.find(q => String(q.id) === String(x.carro));
    if (!c) return x;
    const parc = (guardado.parceiros || []).find(q => String(q.id) === String(c.parc));
    return { ...x, valor: +c.compra || 0, desc: `Repasse ${c.modelo} · ${parc ? parc.nome : 'dono do carro'}` };
  });
  const volta = (lista, antigos) => (lista || []).map(c => {
    const a = (antigos || []).find(x => String(x.id) === String(c.id));
    if (!a) return c;
    const x = { ...c };
    PRIV_CARRO.forEach(k => { if (k in a) x[k] = a[k]; else delete x[k]; });
    return x;
  });
  const todos = (guardado.carros || []).concat(guardado.removidos || []);
  o.carros = volta(novo.carros, todos);
  o.removidos = volta(novo.removidos, todos);
  return o;
}
const pessoa = (d, id) => (d.equipe || []).find(e => +e.id === +id && !e.removido && e.ativo !== false) || null;
const hojeBR = () => new Date(agora() - 3 * 3600 * 1000).toISOString().slice(0, 10);
const dormir = ms => new Promise(r => setTimeout(r, ms));
const txt = (v, n) => String(v == null ? '' : v).trim().slice(0, n);

// endereço próprio da loja (ex.: sualoja.com.br): o site manda "@sualoja.com.br" no lugar do código
const limpaDominio = v => String(v || '').toLowerCase().trim().replace(/^https?:\/\//, '').replace(/[\/?#].*$/, '').replace(/:\d+$/, '').replace(/^www\./, '');
async function lojaPorCodigo(db, codigo) {
  const c = String(codigo || '').toLowerCase().trim();
  if (c.startsWith('@')) {
    const dom = limpaDominio(c.slice(1));
    return dom ? db.prepare('SELECT * FROM lojas WHERE dominio = ?').bind(dom).first() : null;
  }
  return db.prepare('SELECT * FROM lojas WHERE codigo = ?').bind(c).first();
}

// ---- avisos no celular (notificação do navegador, padrão Web Push com chaves VAPID) ----
const b64url = u8 => b64(u8).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const PUSH_HOSTS = /(^|\.)(fcm\.googleapis\.com|googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.apple\.com)$/;
function endpointOk(env, ep) {
  try {
    const u = new URL(String(ep || ''));
    if (env && env.PUSH_LIVRE && /^https?:$/.test(u.protocol)) return true; // só nos testes locais
    return u.protocol === 'https:' && PUSH_HOSTS.test(u.hostname);
  } catch (e) { return false; }
}
async function chavesVapid(db) {
  let r = await db.prepare("SELECT valor FROM config WHERE chave = 'vapid'").first();
  if (!r) {
    const k = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const pub = new Uint8Array(await crypto.subtle.exportKey('raw', k.publicKey));
    const priv = await crypto.subtle.exportKey('jwk', k.privateKey);
    await db.prepare("INSERT OR IGNORE INTO config(chave, valor) VALUES('vapid', ?)").bind(JSON.stringify({ pub: b64url(pub), priv })).run();
    r = await db.prepare("SELECT valor FROM config WHERE chave = 'vapid'").first();
  }
  return JSON.parse(r.valor);
}
async function jwtVapid(ch, aud) {
  const enc = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const corpo = enc({ typ: 'JWT', alg: 'ES256' }) + '.' + enc({ aud, exp: Math.floor(agora() / 1000) + 12 * 3600, sub: 'https://juankemek.pages.dev' });
  const k = await crypto.subtle.importKey('jwk', { kty: ch.priv.kty, crv: ch.priv.crv, x: ch.priv.x, y: ch.priv.y, d: ch.priv.d }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, k, new TextEncoder().encode(corpo)));
  return corpo + '.' + b64url(sig);
}
// grava o aviso e cutuca os celulares inscritos; o celular busca o texto em aviso_ultimo
async function enviaAvisos(db, env, lojaId, pessoas, av, guarda = true) {
  const t = agora();
  if (guarda) {
    await db.batch([
      db.prepare('INSERT INTO avisos(loja_id,titulo,corpo,url,criado) VALUES(?,?,?,?,?)').bind(lojaId, av.titulo, av.corpo, av.url, t),
      db.prepare('DELETE FROM avisos WHERE loja_id = ? AND criado < ?').bind(lojaId, t - 7 * 86400000),
    ]);
  }
  const todas = (await db.prepare('SELECT * FROM inscricoes WHERE loja_id = ?').bind(lojaId).all()).results || [];
  const ins = todas.filter(i => !pessoas || pessoas.includes(+i.pessoa_id));
  if (!ins.length) return 0;
  const ch = await chavesVapid(db);
  let n = 0;
  await Promise.all(ins.map(async i => {
    try {
      if (!endpointOk(env, i.endpoint)) return;
      const r = await fetch(i.endpoint, { method: 'POST', headers: {
        TTL: '86400', Urgency: 'high', 'Content-Length': '0',
        Authorization: `vapid t=${await jwtVapid(ch, new URL(i.endpoint).origin)}, k=${ch.pub}`,
      } });
      if (r.status === 404 || r.status === 410) await db.prepare('DELETE FROM inscricoes WHERE endpoint = ?').bind(i.endpoint).run();
      else if (r.ok) n++;
    } catch (e) { /* um celular fora do ar não atrapalha os outros */ }
  }));
  return n;
}
async function sessao(db, tk) {
  if (!tk) return null;
  const s = await db.prepare('SELECT * FROM sessoes WHERE token = ?').bind(String(tk)).first();
  if (!s) return null;
  const l = await db.prepare('SELECT * FROM lojas WHERE id = ?').bind(s.loja_id).first();
  if (!l) return null;
  const d = JSON.parse(l.dados);
  return { s, l, d, p: pessoa(d, s.pessoa_id) };
}
const dadosPara = (p, d) => (p && p.papel === 'Dono' ? semSenhas(d) : semSenhas(semPrivado(d)));

// ------------------------------------------------------------------
const F = {
  async criar(db, a) {
    const d = a.p_dados;
    if (!d || !Array.isArray(d.equipe) || !d.equipe.length) return { ok: false, erro: 'dados' };
    d.equipe = await embaralhaEquipe(d.equipe);
    const json = JSON.stringify(d);
    if (json.length > MAX_DADOS) return { ok: false, erro: 'grande' };
    const recentes = await db.prepare('SELECT COUNT(*) n FROM lojas WHERE criado > ?').bind(agora() - 3600000).first();
    if (recentes.n >= 40) return { ok: false, erro: 'limite' };
    let base = String(a.p_codigo || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '').slice(0, 24);
    if (base.length < 3) base = 'loja' + base;
    if (RESERVADOS.includes(base)) base += 'loja';
    let cod = base, n = 1;
    while (await lojaPorCodigo(db, cod)) { n++; cod = base + n; }
    const dono = d.equipe[0], id = crypto.randomUUID(), t = agora(), tk = token();
    const l = { id, codigo: cod, versao: 1, criado: t, expira: t + H48, liberado: 0 };
    await db.batch([
      db.prepare('INSERT INTO lojas(id,codigo,nome,dados,versao,criado,expira,liberado,contato,visto) VALUES(?,?,?,?,1,?,?,0,?,?)')
        .bind(id, cod, txt(d.loja && d.loja.nome, 120), json, t, t + H48, txt(a.p_contato, 120), t),
      db.prepare('INSERT INTO sessoes(token,loja_id,pessoa_id,papel,criado,visto) VALUES(?,?,?,?,?,?)').bind(tk, id, +dono.id, dono.papel || 'Dono', t, t),
    ]);
    return { ok: true, token: tk, pessoa: { id: +dono.id, nome: dono.nome, papel: dono.papel }, ...resumo(l) };
  },

  async entrar(db, a) {
    const l = await lojaPorCodigo(db, a.p_codigo);
    if (!l) { await dormir(400); return { ok: false, erro: 'loja' }; }
    const d = JSON.parse(l.dados), u = String(a.p_usuario || '').toLowerCase().trim();
    const c = (d.equipe || []).find(x => String(x.usuario || '').toLowerCase() === u && !x.removido);
    const e = c && await confere(String(a.p_senha || ''), c.senha) ? c : null;
    if (!e) { await dormir(400); return { ok: false, erro: 'senha' }; }
    if (e.ativo === false) return { ok: false, erro: 'bloqueado' };
    if (!ativa(l)) return { ok: false, erro: 'expirado', nome: l.nome };
    const tk = token(), t = agora();
    await db.batch([
      db.prepare('INSERT INTO sessoes(token,loja_id,pessoa_id,papel,criado,visto) VALUES(?,?,?,?,?,?)').bind(tk, l.id, +e.id, e.papel, t, t),
      db.prepare('UPDATE lojas SET visto = ? WHERE id = ?').bind(t, l.id),
    ]);
    return { ok: true, token: tk, pessoa: { id: +e.id, nome: e.nome, papel: e.papel }, dados: dadosPara(e, d), ...resumo(l) };
  },

  async carregar(db, a) {
    const x = await sessao(db, a.p_token);
    if (!x || !x.p) return { ok: false, erro: 'sessao' };
    if (!ativa(x.l)) return { ok: false, erro: 'expirado', nome: x.l.nome, ...resumo(x.l) };
    const t = agora();
    await db.batch([
      db.prepare('UPDATE sessoes SET visto = ? WHERE token = ?').bind(t, x.s.token),
      db.prepare('UPDATE lojas SET visto = ? WHERE id = ?').bind(t, x.l.id),
    ]);
    return { ok: true, pessoa: { id: +x.p.id, nome: x.p.nome, papel: x.p.papel }, dados: dadosPara(x.p, x.d), ...resumo(x.l) };
  },

  async versao(db, a) {
    const x = await sessao(db, a.p_token);
    if (!x || !x.p) return { ok: false, erro: 'sessao' };
    return { ok: true, ...resumo(x.l) };
  },

  async salvar(db, a) {
    const x = await sessao(db, a.p_token);
    if (!x || !x.p) return { ok: false, erro: 'sessao' };
    if (!ativa(x.l)) return { ok: false, erro: 'expirado', ...resumo(x.l) };
    const nd = a.p_dados;
    if (!nd || !Array.isArray(nd.equipe)) return { ok: false, erro: 'dados' };
    if (x.l.versao !== +a.p_base) return { ok: false, conflito: true, dados: dadosPara(x.p, x.d), ...resumo(x.l) };
    let dados = nd;
    if (x.p.papel === 'Dono') {
      // quem não mandou a senha de alguém mantém a que estava guardada; senha nova é embaralhada
      nd.equipe = await embaralhaEquipe(nd.equipe.map(e => e.senha ? e : (() => { const { senha, ...r } = e; const o = (x.d.equipe || []).find(q => String(q.id) === String(e.id)); return o && o.senha ? { ...r, senha: o.senha } : r; })()));
    } else {
      dados = juntaVendedor(x.d, nd); // vendedor não muda a equipe nem os dados privados
    }
    if (dados.loja) dados.loja.site = { ...(dados.loja.site || {}), dominio: x.l.dominio || '' }; // o endereço próprio só muda pela administração
    const json = JSON.stringify(dados);
    if (json.length > MAX_DADOS) return { ok: false, erro: 'grande' };
    const t = agora();
    const r = await db.prepare('UPDATE lojas SET dados = ?, versao = versao + 1, nome = ?, visto = ? WHERE id = ? AND versao = ?')
      .bind(json, txt(dados.loja && dados.loja.nome, 120), t, x.l.id, x.l.versao).run();
    if (!r.meta || !r.meta.changes) {
      const l2 = await db.prepare('SELECT * FROM lojas WHERE id = ?').bind(x.l.id).first();
      return { ok: false, conflito: true, dados: dadosPara(x.p, JSON.parse(l2.dados)), ...resumo(l2) };
    }
    await db.prepare('UPDATE sessoes SET visto = ? WHERE token = ?').bind(t, x.s.token).run();
    return { ok: true, ...resumo({ ...x.l, versao: x.l.versao + 1 }) };
  },

  async foto(db, a) {
    const x = await sessao(db, a.p_token);
    if (!x) return { ok: false, erro: 'sessao' };
    const f = String(a.p_dados || '');
    if (!f.startsWith('data:image/') || f.length > 1500000) return { ok: false, erro: 'foto' };
    const n = await db.prepare('SELECT COUNT(*) n FROM fotos WHERE loja_id = ?').bind(x.l.id).first();
    if (n.n >= 600) return { ok: false, erro: 'limite' };
    const id = crypto.randomUUID();
    await db.prepare('INSERT INTO fotos(id,loja_id,dados,criado) VALUES(?,?,?,?)').bind(id, x.l.id, f, agora()).run();
    return { ok: true, id };
  },

  async fotos(db, a) {
    const x = await sessao(db, a.p_token);
    if (!x) return { ok: false, erro: 'sessao' };
    return { ok: true, fotos: await buscaFotos(db, x.l.id, a.p_ids) };
  },

  async site(db, a) {
    const l = await lojaPorCodigo(db, a.p_codigo);
    if (!l) return { ok: false, erro: 'loja' };
    if (!ativa(l)) return { ok: false, erro: 'expirado', nome: l.nome };
    const d = JSON.parse(l.dados);
    const { contador, google, ...loja } = d.loja || {};
    const carros = (d.carros || []).filter(c => (c.status === 'Disponível' || c.status === 'Reservado') && !c.venda).map(c => ({
      id: c.id, marca: c.marca, modelo: c.modelo, versao: c.versao, ano: c.ano, km: c.km, placa: c.placa, pintura: c.pintura,
      comb: c.comb, cambio: c.cambio, preco: c.preco, fipe: c.fipe, status: c.status, entrada: c.entrada, fotos: c.fotos || [],
      visitas: c.visitas || 0, docs: c.docs || {}, gastos: [], compra: 0, origem: 'Próprio',
    }));
    const pub = { loja, carros };
    const refs = [...new Set((JSON.stringify(pub).match(/ref:[0-9a-f-]{36}/g) || []).map(r => r.slice(4)))];
    return { ok: true, codigo: l.codigo, dados: pub, fotos: await buscaFotos(db, l.id, refs) };
  },

  async pedido(db, a, env, extra) {
    const lead = a.p_lead || {}, vis = a.p_visita;
    if (!txt(lead.nome, 80) || !txt(lead.tel, 30)) return { ok: false, erro: 'dados' };
    for (let tentativa = 0; tentativa < 6; tentativa++) {
      const l = await lojaPorCodigo(db, a.p_codigo);
      if (!l || !ativa(l)) return { ok: false, erro: 'loja' };
      const d = JSON.parse(l.dados), hoje = hojeBR();
      if ((d.leads || []).filter(x => x.site && x.data === hoje).length >= 150) return { ok: false, erro: 'limite' };
      const vs = (d.equipe || []).filter(e => e.papel !== 'Dono' && e.ativo !== false && !e.removido);
      let fila = +d.fila || 0, vid;
      if (vs.length) { fila = (fila + 1) % vs.length; vid = vs[fila].id; } else vid = (d.equipe && d.equipe[0] && d.equipe[0].id) || 1;
      const lid = agora() + Math.floor(Math.random() * 1000);
      const novo = { id: lid, nome: txt(lead.nome, 80), tel: txt(lead.tel, 30), carro: /^\d+$/.test(String(lead.carro)) ? +lead.carro : null,
        origem: 'Site', etapa: vis ? 'Visita marcada' : 'Novo', data: hoje, site: true, vend: vid, nota: txt(lead.nota, 500) };
      if (lead.procura) novo.procura = txt(lead.procura, 200);
      d.leads = (d.leads || []).concat(novo);
      if (vis && /^\d{4}-\d{2}-\d{2}$/.test(vis.data || '')) {
        d.visitas = (d.visitas || []).concat({ id: lid + 1, data: vis.data, hora: txt(vis.hora || '14:00', 5), cli: novo.nome, carro: novo.carro,
          tipo: vis.tipo === 'Visita' ? 'Visita' : 'Test drive', vend: vid, site: true });
      }
      d.fila = fila;
      const r = await db.prepare('UPDATE lojas SET dados = ?, versao = versao + 1 WHERE id = ? AND versao = ?')
        .bind(JSON.stringify(d), l.id, l.versao).run();
      if (r.meta && r.meta.changes) {
        const c = (d.carros || []).find(x => String(x.id) === String(novo.carro));
        const nc = c ? [c.marca, c.modelo, c.ano].filter(Boolean).join(' ') : '';
        const dt = vis && vis.data ? ` · ${vis.data.slice(8, 10)}/${vis.data.slice(5, 7)} às ${txt(vis.hora || '14:00', 5)}` : '';
        const av = {
          titulo: vis ? (vis.tipo === 'Visita' ? 'Visita marcada pelo site' : 'Pedido de test drive') : (novo.procura ? 'Cliente procurando carro' : 'Novo cliente pelo site'),
          corpo: `${novo.nome}${nc ? ' · ' + nc : novo.procura ? ' · procura ' + novo.procura : ''}${dt}`,
          url: `/l/${l.codigo}/painel`,
        };
        const donos = (d.equipe || []).filter(e => e.papel === 'Dono').map(e => +e.id);
        const p = enviaAvisos(db, env, l.id, [...new Set(donos.concat(+vid))], av).catch(() => 0);
        if (extra && extra.espera) extra.espera(p); else await p;
        return { ok: true };
      }
    }
    return { ok: false, erro: 'ocupado' };
  },

  async vapid(db) {
    return { ok: true, chave: (await chavesVapid(db)).pub };
  },

  async aviso_inscrever(db, a, env) {
    const x = await sessao(db, a.p_token);
    if (!x || !x.p) return { ok: false, erro: 'sessao' };
    const ep = a.p_sub && a.p_sub.endpoint;
    if (!endpointOk(env, ep) || String(ep).length > 1000) return { ok: false, erro: 'endereco' };
    const n = await db.prepare('SELECT COUNT(*) n FROM inscricoes WHERE loja_id = ?').bind(x.l.id).first();
    if (n.n >= 60) return { ok: false, erro: 'limite' };
    await db.prepare('INSERT OR REPLACE INTO inscricoes(endpoint,loja_id,pessoa_id,criado) VALUES(?,?,?,?)').bind(String(ep), x.l.id, +x.p.id, agora()).run();
    return { ok: true };
  },

  async aviso_sair(db, a) {
    await db.prepare('DELETE FROM inscricoes WHERE endpoint = ?').bind(String(a.p_endpoint || '')).run();
    return { ok: true };
  },

  async aviso_teste(db, a, env) {
    const x = await sessao(db, a.p_token);
    if (!x || !x.p) return { ok: false, erro: 'sessao' };
    await db.prepare('INSERT INTO avisos(loja_id,titulo,corpo,url,criado) VALUES(?,?,?,?,?)')
      .bind(x.l.id, 'Avisos ligados ✓', 'Quando chegar cliente pelo site, o aviso aparece assim.', `/l/${x.l.codigo}/painel`, agora()).run();
    return { ok: true, enviados: await enviaAvisos(db, env, x.l.id, [+x.p.id], null, false) };
  },

  async aviso_ultimo(db, a) {
    const i = await db.prepare('SELECT * FROM inscricoes WHERE endpoint = ?').bind(String(a.p_endpoint || '')).first();
    if (!i) return { ok: false };
    const v = await db.prepare('SELECT * FROM avisos WHERE loja_id = ? AND criado > ? ORDER BY id DESC LIMIT 1').bind(i.loja_id, agora() - 3600000).first();
    if (!v) return { ok: false };
    return { ok: true, titulo: v.titulo, corpo: v.corpo, url: v.url };
  },

  async feedback(db, a) {
    const x = await sessao(db, a.p_token);
    if (!x) return { ok: false, erro: 'sessao' };
    const n = await db.prepare('SELECT COUNT(*) n FROM feedbacks WHERE loja_id = ?').bind(x.l.id).first();
    if (n.n >= 30) return { ok: false, erro: 'limite' };
    const e = (x.d.equipe || []).find(q => +q.id === +x.s.pessoa_id) || {};
    await db.prepare('INSERT INTO feedbacks(loja_id,nota,gostou,faltou,continuar,quem,criado) VALUES(?,?,?,?,?,?,?)')
      .bind(x.l.id, Math.max(0, Math.min(10, parseInt(a.p_nota, 10) || 0)), txt(a.p_gostou, 2000), txt(a.p_faltou, 2000),
        txt(a.p_continuar, 40), `${e.nome || ''} (${e.papel || ''})`, agora()).run();
    return { ok: true };
  },

  async admin(db, a, env) {
    if (!adminOk(env, a.p_senha)) { await dormir(1000); return { ok: false, erro: env.ADMIN_SENHA ? 'senha' : 'config' }; }
    const ls = (await db.prepare('SELECT * FROM lojas ORDER BY criado DESC').all()).results || [];
    const ops = (await db.prepare('SELECT * FROM feedbacks ORDER BY criado DESC').all()).results || [];
    const fts = (await db.prepare('SELECT loja_id, COUNT(*) n FROM fotos GROUP BY loja_id').all()).results || [];
    return { ok: true, agora: agora(), lojas: ls.map(l => {
      const d = JSON.parse(l.dados), dono = (d.equipe || []).find(e => e.papel === 'Dono') || {};
      return { id: l.id, codigo: l.codigo, nome: l.nome, contato: l.contato, cidade: d.loja && d.loja.cid, wpp: d.loja && d.loja.wpp,
        dono: dono.nome, dominio: l.dominio || '', criado: l.criado, expira: l.expira, visto: l.visto, liberado: !!l.liberado, versao: l.versao,
        pessoas: (d.equipe || []).filter(e => !e.removido).map(e => ({ nome: e.nome, usuario: e.usuario, papel: e.papel, ativo: e.ativo !== false })),
        equipe: (d.equipe || []).length, carros: (d.carros || []).length, contatos: (d.leads || []).length,
        vendas: (d.carros || []).filter(c => c.venda).length, fotos: (fts.find(f => f.loja_id === l.id) || {}).n || 0,
        opinioes: ops.filter(o => o.loja_id === l.id).map(o => ({ nota: o.nota, gostou: o.gostou, faltou: o.faltou, continuar: o.continuar, quem: o.quem, criado: o.criado })) };
    }) };
  },

  async admin_acao(db, a, env) {
    if (!adminOk(env, a.p_senha)) { await dormir(1000); return { ok: false, erro: 'senha' }; }
    const id = String(a.p_loja || ''), t = agora();
    if (a.p_acao === 'tempo') {
      const h = Math.max(1, Math.min(720, parseInt(a.p_horas, 10) || 24));
      await db.prepare('UPDATE lojas SET expira = MAX(expira, ?) + ? WHERE id = ?').bind(t, h * 3600000, id).run();
    } else if (a.p_acao === 'liberar') {
      await db.prepare('UPDATE lojas SET liberado = 1 WHERE id = ?').bind(id).run();
    } else if (a.p_acao === 'encerrar') {
      await db.prepare('UPDATE lojas SET liberado = 0, expira = ? WHERE id = ?').bind(t, id).run();
    } else if (a.p_acao === 'senha') {
      const nova = String(a.p_nova || '');
      if (nova.length < 4) return { ok: false, erro: 'curta' };
      for (let i = 0; i < 6; i++) {
        const l = await db.prepare('SELECT * FROM lojas WHERE id = ?').bind(id).first();
        if (!l) return { ok: false, erro: 'loja' };
        const d = JSON.parse(l.dados), u = String(a.p_usuario || '').toLowerCase();
        const e = (d.equipe || []).find(x => String(x.usuario || '').toLowerCase() === u && !x.removido);
        if (!e) return { ok: false, erro: 'pessoa' };
        e.senha = await hashSenha(nova);
        const r = await db.prepare('UPDATE lojas SET dados = ?, versao = versao + 1 WHERE id = ? AND versao = ?').bind(JSON.stringify(d), id, l.versao).run();
        if (r.meta && r.meta.changes) return { ok: true };
      }
      return { ok: false, erro: 'ocupado' };
    } else if (a.p_acao === 'dominio') {
      const dom = limpaDominio(a.p_dominio);
      if (dom && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(dom)) return { ok: false, erro: 'dominio' };
      if (dom) { const o = await db.prepare('SELECT id FROM lojas WHERE dominio = ? AND id <> ?').bind(dom, id).first(); if (o) return { ok: false, erro: 'usado' }; }
      for (let i = 0; i < 6; i++) {
        const l = await db.prepare('SELECT * FROM lojas WHERE id = ?').bind(id).first();
        if (!l) return { ok: false, erro: 'loja' };
        const d = JSON.parse(l.dados);
        d.loja = d.loja || {}; d.loja.site = d.loja.site || {}; d.loja.site.dominio = dom;
        const r = await db.prepare('UPDATE lojas SET dados = ?, dominio = ?, versao = versao + 1 WHERE id = ? AND versao = ?').bind(JSON.stringify(d), dom || null, id, l.versao).run();
        if (r.meta && r.meta.changes) return { ok: true, dominio: dom };
      }
      return { ok: false, erro: 'ocupado' };
    } else if (a.p_acao === 'apagar') {
      await db.batch([
        db.prepare('DELETE FROM sessoes WHERE loja_id = ?').bind(id), db.prepare('DELETE FROM fotos WHERE loja_id = ?').bind(id),
        db.prepare('DELETE FROM feedbacks WHERE loja_id = ?').bind(id), db.prepare('DELETE FROM inscricoes WHERE loja_id = ?').bind(id),
        db.prepare('DELETE FROM avisos WHERE loja_id = ?').bind(id), db.prepare('DELETE FROM lojas WHERE id = ?').bind(id),
      ]);
    } else return { ok: false, erro: 'acao' };
    return { ok: true };
  },
};

async function buscaFotos(db, lojaId, ids) {
  ids = (Array.isArray(ids) ? ids : []).map(String).filter(i => /^[0-9a-f-]{36}$/.test(i)).slice(0, 400);
  const out = {};
  for (let i = 0; i < ids.length; i += 50) {
    const parte = ids.slice(i, i + 50);
    const r = await db.prepare(`SELECT id, dados FROM fotos WHERE loja_id = ? AND id IN (${parte.map(() => '?').join(',')})`).bind(lojaId, ...parte).all();
    (r.results || []).forEach(f => { out[f.id] = f.dados; });
  }
  return out;
}

function adminOk(env, senha) {
  const s = String(env.ADMIN_SENHA || ''), p = String(senha || '');
  if (!s || s.length !== p.length) return false;
  let dif = 0;
  for (let i = 0; i < s.length; i++) dif |= s.charCodeAt(i) ^ p.charCodeAt(i);
  return dif === 0;
}

const resp = (obj, st = 200) => new Response(JSON.stringify(obj), { status: st, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

export async function onRequestPost({ request, env, params, waitUntil }) {
  const fn = String(params.fn || '');
  if (!Object.prototype.hasOwnProperty.call(F, fn)) return resp({ ok: false, erro: 'funcao' }, 404);
  if (!env.DB) return resp({ ok: false, erro: 'sem-banco' }, 500);
  let a;
  try { a = await request.json(); } catch (e) { return resp({ ok: false, erro: 'json' }, 400); }
  try {
    await prepara(env.DB);
    return resp(await F[fn](env.DB, a || {}, env, { espera: typeof waitUntil === 'function' ? waitUntil : null }));
  } catch (e) {
    return resp({ ok: false, erro: 'servidor', detalhe: String(e && e.message || e).slice(0, 200) }, 500);
  }
}

// GET /api/manifest?c=<código>: o "cartão" do aplicativo para instalar o painel no celular
export async function onRequestGet({ request, env, params }) {
  if (String(params.fn || '') !== 'manifest') return resp({ ok: false, erro: 'use POST' }, 405);
  const u = new URL(request.url), cod = String(u.searchParams.get('c') || '').toLowerCase().slice(0, 120);
  let nome = 'Pátio', cor = '#dc2626', base = cod.startsWith('@') ? '' : '/l/' + cod.replace(/[^a-z0-9-]/g, '');
  try {
    if (env.DB) {
      await prepara(env.DB);
      const l = await lojaPorCodigo(env.DB, cod);
      if (l) {
        const d = JSON.parse(l.dados);
        nome = (d.loja && d.loja.nome) || l.nome || nome;
        if (d.loja && /^#[0-9a-f]{6}$/i.test(d.loja.cor || '')) cor = d.loja.cor;
        if (!cod.startsWith('@')) base = '/l/' + l.codigo;
      }
    }
  } catch (e) { /* manda o cartão padrão */ }
  const m = {
    name: nome === 'Pátio' ? nome : nome + ' · Pátio', short_name: nome.length > 14 ? 'Pátio' : nome, id: base + '/painel', start_url: base + '/painel', scope: base + '/',
    display: 'standalone', background_color: '#f5f5f4', theme_color: cor, lang: 'pt-BR',
    icons: [
      { src: '/icone-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icone-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icone-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
  return new Response(JSON.stringify(m), { headers: { 'Content-Type': 'application/manifest+json; charset=utf-8', 'Cache-Control': 'no-store' } });
}
