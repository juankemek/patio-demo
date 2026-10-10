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
  ]);
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

async function lojaPorCodigo(db, codigo) {
  return db.prepare('SELECT * FROM lojas WHERE codigo = ?').bind(String(codigo || '').toLowerCase().trim()).first();
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

  async pedido(db, a) {
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
      if (r.meta && r.meta.changes) return { ok: true };
    }
    return { ok: false, erro: 'ocupado' };
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
        dono: dono.nome, criado: l.criado, expira: l.expira, visto: l.visto, liberado: !!l.liberado, versao: l.versao,
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
    } else if (a.p_acao === 'apagar') {
      await db.batch([
        db.prepare('DELETE FROM sessoes WHERE loja_id = ?').bind(id), db.prepare('DELETE FROM fotos WHERE loja_id = ?').bind(id),
        db.prepare('DELETE FROM feedbacks WHERE loja_id = ?').bind(id), db.prepare('DELETE FROM lojas WHERE id = ?').bind(id),
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

export async function onRequestPost({ request, env, params }) {
  const fn = String(params.fn || '');
  if (!Object.prototype.hasOwnProperty.call(F, fn)) return resp({ ok: false, erro: 'funcao' }, 404);
  if (!env.DB) return resp({ ok: false, erro: 'sem-banco' }, 500);
  let a;
  try { a = await request.json(); } catch (e) { return resp({ ok: false, erro: 'json' }, 400); }
  try {
    await prepara(env.DB);
    return resp(await F[fn](env.DB, a || {}, env));
  } catch (e) {
    return resp({ ok: false, erro: 'servidor', detalhe: String(e && e.message || e).slice(0, 200) }, 500);
  }
}

export async function onRequestGet() { return resp({ ok: false, erro: 'use POST' }, 405); }
