/* ============================================================
   Ceres Onboarding — protótipo com backend real (Firebase)
   Auth (login/cadastro) + Firestore (dados) + Storage (arquivos)
   ============================================================ */

/* ---------------- helpers ---------------- */
function uid(len = 20) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtDate(v) {
  if (!v) return '—';
  const d = v?.toDate ? v.toDate() : new Date(v);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('pt-BR');
}
function initials(name) { return (name || '?').trim().charAt(0).toUpperCase(); }
function personType(documento) {
  const digits = (documento || '').replace(/\D/g, '');
  if (digits.length === 11) return 'PF';
  if (digits.length === 14) return 'PJ';
  return null;
}
const FieldValue = firebase.firestore.FieldValue;

/* ---------------- operation branding ---------------- */
const OPERATIONS = {
  'CERES AGROBANK': { label: 'Ceres AgroFinance', tag: 'AGROFINANCE' },
  'CERES CONFINAMENTO': { label: 'Ceres Confinamento', tag: 'CONFINAMENTO' },
  'CERES TRADING': { label: 'Ceres Trading', tag: 'TRADING' },
  'HOME EQUITY/FARM EQUITY': { label: 'Home Equity/Farm Equity', tag: 'HOME EQUITY' },
};
const STATUS_META = {
  em_analise: { label: 'Em Análise', cls: 'analise' },
  aprovado: { label: 'Aprovado', cls: 'approved' },
  rejeitado: { label: 'Rejeitado', cls: 'rejected' },
  action_required: { label: 'Documento Adicional Solicitado', cls: 'action_required' },
};

/* ---------------- document config ---------------- */
const PF_BASE_DOCS = [
  { key: 'doc_pessoal', label: 'Documentos pessoais (CNH/RG/CRNM)' },
  { key: 'irpf', label: 'IRPF com base no ano anterior' },
  { key: 'comp_residencia', label: 'Comprovante de residência' },
];
const CERTIDAO_NASC = { key: 'certidao_nasc', label: 'Certidão de Nascimento' };
const OPERATION_DOCS = [
  { key: 'carta_bacen', label: 'Carta Bacen/SCR' },
  { key: 'relatorio_visita', label: 'Relatório de Visita (parceiro – manter arquivo editável)' },
  { key: 'endividamento', label: 'Endividamento calendarizado' },
];
const IMOVEL_DOCS = [
  { key: 'matricula_imovel', label: 'Certidão de Matrícula do Imóvel' },
  { key: 'penhor', label: 'Certidão de Penhor/Alienação Fiduciária' },
  { key: 'arrendamento', label: 'Contrato de Arrendamento/Comodato (opcional)', optional: true },
  { key: 'anuencia', label: 'Termo de Anuência do Proprietário' },
  { key: 'car_kml', label: 'CAR e KML' },
  { key: 'registro_b3', label: 'Documento de Registro B3' },
  { key: 'registro_cpr', label: 'Documento de Registro CPR (opcional)', optional: true },
];
const PJ_DOCS = [
  { key: 'cartao_cnpj', label: 'Cartão CNPJ' },
  { key: 'contrato_social', label: 'Contrato Social ou Estatuto Social' },
  { key: 'licenca_ambiental', label: 'Licença Ambiental de Operação (LO)' },
  { key: 'inscricao_estadual', label: 'Inscrição Estadual (IE)' },
];
const EMITENTE_BASE_DOCS = [
  { key: 'doc_pessoal', label: 'Documento Pessoal (CNH, RG ou CPF)' },
  { key: 'irpf', label: 'IRPF com base no ano anterior' },
  { key: 'comp_residencia', label: 'Comprovante de Residência' },
];

/* ---------------- live data cache (populated by Firestore listeners) ---------------- */
let db = { partners: [], requests: [], errors: [] };
let listeners = [];
function clearListeners() { listeners.forEach(u => u()); listeners = []; }

/* ---------------- auth / session state ---------------- */
let authUser = null;   // firebase.auth().currentUser
let session = null;    // { role: 'admin'|'partner', partner?: {...} }

/* ---------------- ui state ---------------- */
function initialUI() {
  return {
    role: null,              // 'admin' | 'partner' — chosen on the landing screen, before login
    authMode: 'login',       // 'login' | 'signup' (partner only)
    authError: '',
    authBusy: false,
    admin: { tab: 'parceiros', search: '', statusFilter: 'all', drill: null },
    partner: { screen: 'dashboard', requestId: null, search: '', filterOpen: false, statusFilter: 'all', operationFilter: 'all' },
    modal: null,
  };
}
let ui = initialUI();

/* ---------------- toast ---------------- */
function toast(msg) {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

/* ============================================================
   DOCUMENT REQUIREMENT ENGINE (Nova Solicitação)
   ============================================================ */
function requiredBaseDocs(draft) {
  const type = personType(draft.documento);
  if (type === 'PJ') return PJ_DOCS.map(d => ({ ...d }));
  if (type === 'PF') {
    const docs = [...PF_BASE_DOCS];
    if (draft.estadoCivil === 'Solteiro(a)') docs.push(CERTIDAO_NASC);
    return docs.map(d => ({ ...d }));
  }
  return [];
}
function emitenteDocs(emitente) {
  const docs = [...EMITENTE_BASE_DOCS];
  if (emitente.estadoCivil === 'Solteiro(a)') docs.push(CERTIDAO_NASC);
  return docs;
}
function isFormComplete(draft) {
  if (!draft.operation || !draft.nome || !draft.documento || !draft.telefone || !draft.email) return false;
  const type = personType(draft.documento);
  if (!type) return false;
  const base = requiredBaseDocs(draft).filter(d => !d.optional);
  if (!base.every(d => draft.docs[d.key])) return false;
  if (type === 'PF') {
    if (!draft.profissao || !draft.icp || !draft.estadoCivil) return false;
    if (!OPERATION_DOCS.every(d => draft.docs[d.key])) return false;
    if (!draft.possuiAvalista) return false;
    if (!IMOVEL_DOCS.filter(d => !d.optional).every(d => draft.docs[d.key])) return false;
    if (!draft.certidaoPFPJ) return false;
    const n = parseInt(draft.numeroEmitentes || '0', 10);
    if (!n || n < 1) return false;
    for (let i = 0; i < n; i++) {
      const em = draft.emitentes[i];
      if (!em || !em.nome || !em.cpf) return false;
      if (!emitenteDocs(em).every(d => em.docs[d.key])) return false;
    }
  } else {
    if (!draft.subtipoOperacao || !draft.numeroSocios) return false;
  }
  return true;
}
function buildDocumentsFromDraft(draft) {
  const type = personType(draft.documento);
  const out = [];
  requiredBaseDocs(draft).forEach(d => out.push({ ...d, status: draft.docs[d.key] ? 'enviado' : 'pendente', fileName: draft.docs[d.key] || null, storagePath: draft.docPaths[d.key] || null }));
  if (type === 'PF') {
    OPERATION_DOCS.forEach(d => out.push({ ...d, status: draft.docs[d.key] ? 'enviado' : 'pendente', fileName: draft.docs[d.key] || null, storagePath: draft.docPaths[d.key] || null }));
    IMOVEL_DOCS.forEach(d => out.push({ ...d, status: draft.docs[d.key] ? 'enviado' : 'pendente', fileName: draft.docs[d.key] || null, storagePath: draft.docPaths[d.key] || null }));
    const n = parseInt(draft.numeroEmitentes || '0', 10) || 0;
    for (let i = 0; i < n; i++) {
      const em = draft.emitentes[i] || { docs: {}, docPaths: {} };
      emitenteDocs(em).forEach(d => out.push({ key: d.key + '_em' + i, label: `${d.label} do Emitente ${i + 1}`, status: em.docs[d.key] ? 'enviado' : 'pendente', fileName: em.docs[d.key] || null, storagePath: (em.docPaths || {})[d.key] || null }));
    }
  }
  (draft.extraDocs || []).forEach((f, i) => out.push({ key: 'extra_' + i, label: `Documento adicional: ${f.name}`, status: 'enviado', fileName: f.name, storagePath: f.path }));
  return out;
}

/* ============================================================
   FIREBASE — auth + data wiring
   ============================================================ */
fbAuth.onAuthStateChanged(async (user) => {
  authUser = user;
  clearListeners();

  if (!user) {
    session = null;
    db = { partners: [], requests: [], errors: [] };
    render();
    return;
  }

  // role is always derived from the account itself (admins collection membership),
  // never trusted from whichever login form the user happened to click — this also
  // sidesteps a race where a persisted session resolves while the user is mid-click
  // on the landing screen.
  let adminDoc;
  try {
    adminDoc = await fbDb.collection('admins').doc(user.email.toLowerCase()).get();
  } catch (e) {
    ui.authError = 'Não foi possível verificar a permissão. Tente novamente.';
    await fbAuth.signOut();
    render();
    return;
  }
  if (adminDoc.exists) {
    ui.role = 'admin';
    session = { role: 'admin' };
    attachAdminListeners();
  } else {
    ui.role = 'partner';
    session = { role: 'partner' };
    attachPartnerListeners(user.uid);
  }
  render();
});

function attachAdminListeners() {
  listeners.push(fbDb.collection('partners').orderBy('relationshipStart', 'desc').onSnapshot(snap => {
    db.partners = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }));
  listeners.push(fbDb.collection('requests').orderBy('updatedAt', 'desc').onSnapshot(snap => {
    db.requests = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }));
  listeners.push(fbDb.collection('errors').orderBy('createdAt', 'desc').onSnapshot(snap => {
    db.errors = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    render();
  }));
}
function attachPartnerListeners(uid) {
  listeners.push(fbDb.collection('partners').doc(uid).onSnapshot(doc => {
    db.partners = doc.exists ? [{ id: doc.id, ...doc.data() }] : [];
    render();
  }));
  listeners.push(fbDb.collection('requests').where('partnerId', '==', uid).onSnapshot(snap => {
    db.requests = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
    render();
  }));
  listeners.push(fbDb.collection('errors').where('partnerId', '==', uid).onSnapshot(snap => {
    db.errors = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    render();
  }));
}

function currentPartner() { return db.partners[0] || null; }

/* ============================================================
   RENDER: TOPBAR
   ============================================================ */
function renderTopbar() {
  const bar = document.getElementById('topbar');
  const loggedIn = !!authUser && !!session;

  bar.innerHTML = `
    <div class="brand">
      <div class="mark">GCI</div>
      <div class="name">Grupo Ceres<br><small>Investimentos</small></div>
    </div>
    <div class="topbar-right">
      ${!loggedIn && ui.role ? `<button class="link-btn muted" data-action="back-to-role">← Voltar</button>` : ''}
      ${loggedIn ? `<span class="badge ${session.role === 'admin' ? 'analise' : 'sent'}">${session.role === 'admin' ? 'Painel do Gestor' : 'Portal do Parceiro'}</span>` : ''}
      ${loggedIn ? `<span style="font-size:13px;font-weight:600;">${esc(authUser.email)}</span>` : ''}
      ${loggedIn && session.role === 'partner' ? `<button class="link-btn" title="Editar cadastro" data-action="open-edit-cadastro">✎</button>` : ''}
      ${loggedIn ? `<button class="link-btn muted" data-action="logout">Sair</button>` : ''}
    </div>
  `;
}

/* ============================================================
   ROLE + AUTH SCREENS
   ============================================================ */
function RoleScreen() {
  return `
    <div class="role-screen">
      <div class="box">
        <p class="eyebrow">Onboarding B2B</p>
        <h1 class="serif">Grupo Ceres Investimentos</h1>
        <p class="lede">Escolha como você quer entrar.</p>
        <div class="role-cards">
          <div class="role-card">
            <div class="ic">🏢</div>
            <h3 class="serif">Painel do Gestor</h3>
            <p>Gerencie parceiros, analise solicitações e responda erros reportados.</p>
            <button class="btn btn-primary btn-block" data-action="choose-role" data-role="admin">Entrar como Gestor</button>
          </div>
          <div class="role-card">
            <div class="ic">🤝</div>
            <h3 class="serif">Portal do Parceiro</h3>
            <p>Envie solicitações de documentação e acompanhe o andamento.</p>
            <button class="btn btn-outline btn-block" data-action="choose-role" data-role="partner">Entrar como Parceiro</button>
          </div>
        </div>
      </div>
    </div>
  `;
}

function AuthScreen() {
  if (ui.role === 'admin') return AdminLoginScreen();
  return ui.authMode === 'signup' ? PartnerSignupScreen() : PartnerLoginScreen();
}

function AdminLoginScreen() {
  return `
    <div class="role-screen">
      <div class="box" style="max-width:420px;">
        <h1 class="serif">Painel do Gestor</h1>
        <p class="lede">Acesso restrito à equipe Ceres.</p>
        <div class="info-block" style="text-align:left;">
          ${ui.authError ? `<div class="feedback-banner" style="margin-bottom:16px;"><b>Erro</b>${esc(ui.authError)}</div>` : ''}
          <div class="field"><label>E-mail</label><input type="email" id="au-email" placeholder="voce@ceresinvestimentos.com"></div>
          <div class="field"><label>Senha</label><input type="password" id="au-pass" placeholder="••••••••"></div>
          <button class="btn btn-primary btn-block" data-action="submit-admin-login" ${ui.authBusy ? 'disabled' : ''}>${ui.authBusy ? 'Entrando…' : 'Entrar'}</button>
        </div>
      </div>
    </div>
  `;
}

function PartnerLoginScreen() {
  return `
    <div class="role-screen">
      <div class="box" style="max-width:420px;">
        <h1 class="serif">Portal do Parceiro</h1>
        <p class="lede">Entre com o e-mail do seu cadastro.</p>
        <div class="info-block" style="text-align:left;">
          ${ui.authError ? `<div class="feedback-banner" style="margin-bottom:16px;"><b>Erro</b>${esc(ui.authError)}</div>` : ''}
          <div class="field"><label>E-mail</label><input type="email" id="au-email" placeholder="contato@empresa.com"></div>
          <div class="field"><label>Senha</label><input type="password" id="au-pass" placeholder="••••••••"></div>
          <button class="btn btn-primary btn-block" data-action="submit-partner-login" ${ui.authBusy ? 'disabled' : ''}>${ui.authBusy ? 'Entrando…' : 'Entrar'}</button>
        </div>
        <p style="margin-top:16px;font-size:13px;">Ainda não tem cadastro? <button class="link-btn" style="display:inline;font-size:13px;" data-action="goto-signup">Criar cadastro</button></p>
      </div>
    </div>
  `;
}

function PartnerSignupScreen() {
  return `
    <div class="role-screen">
      <div class="box" style="max-width:480px;">
        <div class="info-block" style="text-align:left;">
          <div class="section-label">🏢 Informações Cadastrais</div>
          ${ui.authError ? `<div class="feedback-banner" style="margin-bottom:16px;"><b>Erro</b>${esc(ui.authError)}</div>` : ''}
          <div class="field"><label>Nome ou Razão Social</label><input type="text" id="cad-nome" placeholder="Ex: João Silva ou Empresa LTDA"></div>
          <div class="field">
            <label>Tipo de Pessoa</label>
            <div class="radio-row">
              <label><input type="radio" name="cad-tipo" value="PJ" checked> Pessoa Jurídica (CNPJ)</label>
              <label><input type="radio" name="cad-tipo" value="PF"> Pessoa Física (CPF)</label>
            </div>
          </div>
          <div class="field"><label>CNPJ / CPF</label><input type="text" id="cad-doc" placeholder="00.000.000/0000-00"></div>
          <div class="form-grid-2">
            <div class="field"><label>E-mail</label><input type="email" id="cad-email" placeholder="contato@empresa.com"></div>
            <div class="field"><label>Número de WhatsApp</label><input type="text" id="cad-whats" placeholder="(00) 00000-0000"></div>
          </div>
          <div class="form-grid-2">
            <div class="field"><label>Senha</label><input type="password" id="cad-pass" placeholder="mínimo 6 caracteres"></div>
            <div class="field"><label>Confirmar Senha</label><input type="password" id="cad-pass2" placeholder="repita a senha"></div>
          </div>
          <button class="btn btn-primary btn-block" data-action="submit-cadastro" ${ui.authBusy ? 'disabled' : ''}>${ui.authBusy ? 'Criando…' : '💾 Finalizar Cadastro'}</button>
        </div>
        <p style="margin-top:16px;font-size:13px;">Já tem cadastro? <button class="link-btn" style="display:inline;font-size:13px;" data-action="goto-login">Entrar</button></p>
      </div>
    </div>
  `;
}

/* ============================================================
   ADMIN — Parceiros / Pendências / Erros  (unchanged from here down
   except the data now comes live from Firestore via `db`)
   ============================================================ */
function AdminRoot() {
  const a = ui.admin;
  if (a.drill?.type === 'partner-profile') return AdminPartnerProfile(a.drill.id, a.drill.returnTab || 'parceiros');
  if (a.drill?.type === 'partner-edit') return AdminPartnerEdit(a.drill.id);
  if (a.drill?.type === 'request-detail') return RequestDetail(a.drill.id, 'admin', a.drill.returnTo);

  const pendentes = db.requests.filter(r => r.status === 'em_analise').length;
  const concluidas = db.requests.filter(r => r.status === 'aprovado').length;

  return `
    <div class="page-head">
      <div>
        <h1 class="serif">Gestão de Parceiros</h1>
        <div class="subtitle">Painel Administrativo · Online</div>
      </div>
      <div class="stat-row">
        <div class="stat"><div class="n">${db.partners.length}</div><div class="l">Total</div></div>
        <div class="stat orange"><div class="n">${pendentes}</div><div class="l">Pendentes</div></div>
        <div class="stat green"><div class="n">${concluidas}</div><div class="l">Concluídas</div></div>
      </div>
    </div>

    <div class="tabbar">
      <button class="${a.tab === 'parceiros' ? 'active' : ''}" data-action="admin-tab" data-tab="parceiros">Parceiros</button>
      <button class="${a.tab === 'pendencias' ? 'active' : ''}" data-action="admin-tab" data-tab="pendencias">Pendências ${db.requests.filter(r => r.status === 'em_analise' || r.status === 'action_required').length ? `<span class="count-chip">${db.requests.filter(r => r.status === 'em_analise' || r.status === 'action_required').length}</span>` : ''}</button>
      <button class="${a.tab === 'erros' ? 'active' : ''}" data-action="admin-tab" data-tab="erros">Erros Reportados</button>
    </div>

    ${a.tab === 'parceiros' ? AdminPartnersTab() : ''}
    ${a.tab === 'pendencias' ? AdminPendenciasTab() : ''}
    ${a.tab === 'erros' ? AdminErrosTab() : ''}
  `;
}

function AdminPartnersTab() {
  const a = ui.admin;
  let list = db.partners.slice();
  if (a.search.trim()) {
    const q = a.search.toLowerCase();
    list = list.filter(p => (p.name || '').toLowerCase().includes(q) || (p.email || '').toLowerCase().includes(q));
  }
  if (a.statusFilter !== 'all') list = list.filter(p => partnerStatus(p.id) === a.statusFilter);

  return `
    <div class="panel">
      <div class="toolbar">
        <div class="search-box">
          <span>🔍</span>
          <input type="text" placeholder="Buscar por nome ou e-mail..." value="${esc(a.search)}" data-action="admin-search" />
        </div>
        <select class="select-mini" data-action="admin-status-filter" style="min-width:150px;">
          <option value="all" ${a.statusFilter === 'all' ? 'selected' : ''}>Todos Status</option>
          <option value="pending" ${a.statusFilter === 'pending' ? 'selected' : ''}>Pendentes</option>
          <option value="active" ${a.statusFilter === 'active' ? 'selected' : ''}>Ativos</option>
          <option value="rejected" ${a.statusFilter === 'rejected' ? 'selected' : ''}>Rejeitados</option>
        </select>
      </div>
      ${list.length === 0 ? `
        <div class="empty-state"><div class="icon">👥</div><h3 class="serif">Nenhum parceiro encontrado.</h3></div>
      ` : `
        <div class="list-head"><span>Parceiro</span><span>Documento</span><span>Início</span><span>Ações</span></div>
        ${list.map(p => `
          <div class="list-row" data-action="open-partner-profile" data-id="${p.id}">
            <div class="person">
              <div class="avatar">${initials(p.name)}</div>
              <div><div class="name">${esc(p.name)}</div><div class="sub">${esc(p.email)}</div></div>
            </div>
            <div class="mono">${esc(p.document)}</div>
            <div>${fmtDate(p.relationshipStart)}</div>
            <div><button class="link-btn" title="Revisão de dados cadastrais" data-action="open-partner-edit" data-id="${p.id}" data-stop="1">⋮</button></div>
          </div>
        `).join('')}
      `}
    </div>
  `;
}

function partnerStatus(partnerId) {
  const reqs = db.requests.filter(r => r.partnerId === partnerId);
  if (reqs.some(r => r.status === 'aprovado')) return 'active';
  if (reqs.some(r => r.status === 'rejeitado') && !reqs.some(r => r.status === 'em_analise' || r.status === 'aprovado')) return 'rejected';
  return 'pending';
}

function AdminPendenciasTab() {
  const list = db.requests.filter(r => r.status === 'em_analise' || r.status === 'action_required');
  return `
    ${list.length === 0 ? `<div class="panel"><div class="empty-state"><div class="icon">📄</div><h3 class="serif">Nenhuma pendência.</h3></div></div>` : `
      <div class="card-grid">
        ${list.map(r => {
          const p = db.partners.find(pp => pp.id === r.partnerId);
          return `
          <div class="info-card" data-action="open-request-detail" data-id="${r.id}" data-return="pendencias">
            <div class="top-row">
              <div class="title">${esc(r.form?.nome || p?.name || '—')}</div>
              <span class="badge ${STATUS_META[r.status].cls}">⚠</span>
            </div>
            <div class="meta">${esc(OPERATIONS[r.operation]?.label || r.operation)}</div>
            <div class="foot">🕒 ${fmtDate(r.updatedAt)}</div>
          </div>`;
        }).join('')}
      </div>
    `}
  `;
}

function AdminErrosTab() {
  const list = db.errors.slice();
  return `
    ${list.length === 0 ? `<div class="panel"><div class="empty-state"><div class="icon">✉️</div><h3 class="serif">Nenhum erro reportado.</h3></div></div>` : `
      <div class="card-grid">
        ${list.map(e => `
          <div class="info-card" data-action="open-error-modal" data-id="${e.id}">
            <div class="top-row">
              <div class="title" style="font-size:16px;">${esc(e.partnerName)}</div>
              <span class="badge ${e.status === 'respondido' ? 'sent' : 'pending'}">${e.status === 'respondido' ? 'Respondido' : 'Pendente'}</span>
            </div>
            <div class="meta">${esc(e.subject)}</div>
            <div class="foot">🕒 ${fmtDate(e.createdAt)}</div>
          </div>
        `).join('')}
      </div>
    `}
  `;
}

function AdminPartnerProfile(partnerId, returnTab) {
  const p = db.partners.find(x => x.id === partnerId);
  if (!p) return `<p>Parceiro não encontrado.</p>`;
  const reqs = db.requests.filter(r => r.partnerId === partnerId);
  return `
    <button class="back-link" data-action="admin-back-to-tab" data-tab="${returnTab}">← Voltar ao Dashboard</button>
    <div class="detail-head" style="margin-top:14px;">
      <div></div>
      <button class="btn btn-primary" data-action="open-partner-edit" data-id="${p.id}">✎ Editar Cadastro</button>
    </div>
    <div class="info-block">
      <div style="display:flex;justify-content:space-between;flex-wrap:wrap;gap:16px;">
        <div>
          <div class="mono" style="color:var(--muted);font-size:12px;">ID: ${p.id}</div>
          <h2 class="serif" style="margin:4px 0 6px;">${esc(p.name)}</h2>
          <div class="mono" style="color:var(--muted);">👤 ${esc(p.document)}</div>
        </div>
        <div style="display:flex;gap:10px;flex-wrap:wrap;">
          <div class="subsection" style="padding:12px 16px;"><div class="eyebrow">Início do Relacionamento</div><div>📅 ${fmtDate(p.relationshipStart)}</div></div>
          <div class="subsection" style="padding:12px 16px;"><div class="eyebrow">Última Atualização</div><div>🕒 ${fmtDate(p.lastUpdate)}</div></div>
        </div>
      </div>
      <div class="form-grid-2" style="margin-top:18px;">
        <div class="subsection"><div class="eyebrow">E-mail</div><div>✉️ ${esc(p.email)}</div></div>
        <div class="subsection"><div class="eyebrow">Telefone/WhatsApp</div><div>📞 ${esc(p.whatsapp)}</div></div>
      </div>
    </div>

    <h3 class="serif" style="font-size:20px;margin-bottom:14px;">Solicitações <span class="count-chip" style="background:var(--primary-soft);color:var(--primary);">${reqs.length}</span></h3>
    ${reqs.length === 0 ? `<div class="panel"><div class="empty-state">Nenhuma solicitação ainda.</div></div>` : `
      <div class="card-grid">
        ${reqs.map(r => `
          <div class="info-card" data-action="open-request-detail" data-id="${r.id}" data-return="partner-profile" data-return-id="${p.id}">
            <div class="top-row">
              <div class="request-brand-logo">${OPERATIONS[r.operation]?.tag || r.operation}</div>
              <span class="badge ${STATUS_META[r.status].cls}">${STATUS_META[r.status].label}</span>
            </div>
            <div class="title">${esc(OPERATIONS[r.operation]?.label || r.operation)}</div>
            <div class="foot">🕒 Atualizado em: ${fmtDate(r.updatedAt)} <span style="margin-left:auto;">Ver detalhes →</span></div>
          </div>
        `).join('')}
      </div>
    `}
  `;
}

function AdminPartnerEdit(partnerId) {
  const p = db.partners.find(x => x.id === partnerId);
  if (!p) return `<p>Parceiro não encontrado.</p>`;
  return `
    <button class="back-link" data-action="admin-close-edit" data-id="${p.id}">← Voltar</button>
    <div class="subtitle" style="text-align:right;margin-top:-24px;">Editando Parceiro</div>
    <h1 class="serif" style="text-align:right;margin-bottom:20px;">${esc(p.name)}</h1>
    <div class="info-block" style="max-width:520px;margin:0 auto;">
      <div class="field"><label>Nome / Razão Social</label><input type="text" id="ed-nome" value="${esc(p.name)}" /></div>
      <div class="form-grid-2">
        <div class="field"><label>Tipo de Pessoa</label>
          <select id="ed-tipo">
            <option value="PF" ${p.type === 'PF' ? 'selected' : ''}>Pessoa Física</option>
            <option value="PJ" ${p.type === 'PJ' ? 'selected' : ''}>Pessoa Jurídica</option>
          </select>
        </div>
        <div class="field"><label>CPF / CNPJ</label><input type="text" id="ed-doc" value="${esc(p.document)}" /></div>
      </div>
      <div class="form-grid-2">
        <div class="field"><label>E-mail de Contato</label><input type="email" id="ed-email" value="${esc(p.email)}" disabled title="O e-mail é o login do parceiro e não pode ser alterado aqui."/></div>
        <div class="field"><label>WhatsApp</label><input type="text" id="ed-whats" value="${esc(p.whatsapp)}" /></div>
      </div>
      <button class="btn btn-primary btn-block" data-action="save-partner-edit" data-id="${p.id}">💾 Salvar Alterações</button>
      <div style="text-align:center;margin-top:16px;">
        <button class="btn-danger-text" data-action="delete-partner" data-id="${p.id}">🗑 Excluir cadastro do parceiro</button>
      </div>
    </div>
  `;
}

/* ============================================================
   ADMIN + PARTNER shared — REQUEST DETAIL
   ============================================================ */
function RequestDetail(requestId, mode, returnTo) {
  const r = db.requests.find(x => x.id === requestId);
  if (!r) return `<p>Solicitação não encontrada.</p>`;
  const opMeta = OPERATIONS[r.operation] || { label: r.operation, tag: r.operation };
  const f = r.form || {};

  const backAction = mode === 'admin'
    ? (returnTo?.type === 'partner-profile' ? `data-action="open-partner-profile" data-id="${returnTo.id}"` : `data-action="admin-back-to-tab" data-tab="pendencias"`)
    : `data-action="partner-goto" data-screen="dashboard"`;

  const lastFeedback = r.feedbackHistory && r.feedbackHistory.length ? r.feedbackHistory[r.feedbackHistory.length - 1] : null;

  return `
    <div class="detail-head">
      <button class="back-link" ${backAction}>← Voltar ao Painel</button>
      <span class="ai-pill">🛡 IA de Análise Ativa</span>
    </div>

    ${mode === 'partner' && lastFeedback ? `<div class="feedback-banner"><b>Observação do Gestor</b>${esc(lastFeedback.text)}</div>` : ''}

    <div class="request-hero">
      <span class="badge ${STATUS_META[r.status].cls}">${STATUS_META[r.status].label}</span>
      <div class="mono" style="color:var(--muted);font-size:11px;margin-bottom:10px;">ID: ${r.id}</div>
      <div class="brand-mark">${opMeta.tag}</div>
      <h2 class="serif">${esc(opMeta.label)}</h2>
      <div class="client-name serif">${esc(f.nome || '—')}</div>
      <div class="client-doc">${esc(f.documento || '—')}</div>
    </div>

    <div class="info-block">
      <div class="form-grid-2">
        <div class="field"><label>CPF ou CNPJ</label><input type="text" value="${esc(f.documento || '')}" disabled></div>
        <div class="field"><label>Telefone</label><input type="text" value="${esc(f.telefone || '')}" disabled></div>
      </div>
      <div class="form-grid-2">
        <div class="field"><label>E-mail</label><input type="text" value="${esc(f.email || '')}" disabled></div>
        <div class="field"><label>Informações Adicionais (Parceiro)</label><input type="text" value="${esc(f.obs || 'N/A')}" disabled></div>
      </div>
      ${personType(f.documento) === 'PJ' ? `
        <div class="form-grid-2">
          <div class="field"><label>Subtipo de Operação</label><input type="text" value="${esc(f.subtipoOperacao || 'N/A')}" disabled></div>
          <div class="field"><label>Número de Sócios</label><input type="text" value="${esc(f.numeroSocios || 'N/A')}" disabled></div>
        </div>
        <div class="form-grid-2">
          <div class="field"><label>Possui Procurador?</label><input type="text" value="${esc(f.possuiProcurador || 'N/A')}" disabled></div>
          <div class="field"><label>Informações do Procurador</label><input type="text" value="${esc(f.infoProcurador || 'N/A')}" disabled></div>
        </div>
      ` : `
        <div class="form-grid-2">
          <div class="field"><label>Profissão</label><input type="text" value="${esc(f.profissao || 'N/A')}" disabled></div>
          <div class="field"><label>Possui ICP para assinatura?</label><input type="text" value="${esc(f.icp || 'N/A')}" disabled></div>
        </div>
        <div class="form-grid-2">
          <div class="field"><label>Estado Civil</label><input type="text" value="${esc(f.estadoCivil || 'N/A')}" disabled></div>
          <div class="field"><label>Possui Avalista?</label><input type="text" value="${esc(f.possuiAvalista || 'N/A')}" disabled></div>
        </div>
      `}
    </div>

    <div class="section-label">Documentos anexados</div>
    ${(r.documents || []).map(d => `
      <div class="doc-row ${d.status === 'enviado' ? 'sent' : ''}">
        <div class="ic">📄</div>
        <div class="txt">
          <div class="t">${esc(d.label)}</div>
          <div class="d">Documento Anexado Inicialmente</div>
          ${d.fileName ? `<div class="file-name">📎 ${esc(d.fileName)}</div>` : ''}
        </div>
        <span class="badge ${d.status === 'enviado' ? 'sent' : d.status === 'rejeitado' ? 'rejected' : 'pending'}">${d.status === 'enviado' ? 'Enviado' : d.status === 'rejeitado' ? 'Rejeitado' : 'Pendente de Envio'}</span>
        ${d.status === 'enviado' && d.storagePath ? `<button class="upload-slot" style="padding:8px 12px;font-size:11px;" data-action="download-doc" data-path="${esc(d.storagePath)}">⬇ Baixar</button>` : ''}
        ${mode === 'partner' && d.status !== 'enviado' ? `
          <label class="upload-slot" style="padding:8px 12px;font-size:11px;" data-uploading="${d.key}">📤 Enviar
            <input type="file" data-action="partner-upload-existing-doc" data-req="${r.id}" data-key="${d.key}">
          </label>
        ` : ''}
      </div>
    `).join('')}

    ${mode === 'admin' ? AdminControlPanel(r) : ''}
  `;
}

function AdminControlPanel(r) {
  const sentDocs = (r.documents || []).filter(d => d.status === 'enviado');
  return `
    <div class="admin-panel">
      <span class="gestor-tag">Visão do Gestor</span>
      <div class="section-label">🛡 Controles Administrativos</div>
      <div class="form-grid-2">
        <div class="field">
          <label>Alterar Status</label>
          <select id="ctrl-status">
            <option value="">Selecionar novo status...</option>
            <option value="action_required">Documento adicional / feedback solicitado</option>
            <option value="aprovado">Solicitação aceita</option>
            <option value="rejeitado">Solicitação rejeitada</option>
          </select>
        </div>
        <div class="field">
          <label>Rejeitar Documentos Enviados</label>
          <div class="checklist">
            ${sentDocs.length === 0 ? '<div style="opacity:.6;padding:6px 0;">Nenhum documento disponível para rejeição.</div>' :
              sentDocs.map(d => `<label><input type="checkbox" value="${d.key}" class="ctrl-reject-doc"> ${esc(d.label)}</label>`).join('')}
          </div>
        </div>
      </div>
      <div class="field"><label>Solicitar Novo Documento Adicional (opcional)</label><input type="text" id="ctrl-extra-doc" placeholder="Ex: Contrato Social Consolidado"></div>
      <div class="field"><label>Observações / Feedback ao Parceiro <span class="req">*Obrigatório</span></label><textarea id="ctrl-feedback" placeholder="Escreva aqui as orientações e motivos (obrigatório para salvar as ações)..."></textarea></div>
      <button class="btn btn-primary btn-block" data-action="save-admin-controls" data-id="${r.id}">📨 Salvar Atualizações</button>
    </div>
  `;
}

/* ============================================================
   PARTNER — dashboard / erros
   ============================================================ */
function PartnerRoot() {
  const p = ui.partner;
  const partner = currentPartner();
  if (!partner) return `<div class="role-screen"><div class="box"><p class="lede">Carregando seu cadastro…</p></div></div>`;
  if (p.screen === 'request-detail') return RequestDetail(p.requestId, 'partner', null);
  if (p.screen === 'erros') return PartnerErros();
  return PartnerDashboard();
}

function PartnerDashboard() {
  const partner = currentPartner();
  let reqs = db.requests.slice();
  const hasAny = reqs.length > 0;

  if (ui.partner.search.trim()) {
    const q = ui.partner.search.toLowerCase();
    reqs = reqs.filter(r => (r.form?.nome || '').toLowerCase().includes(q) || (OPERATIONS[r.operation]?.label || '').toLowerCase().includes(q));
  }
  if (ui.partner.statusFilter !== 'all') reqs = reqs.filter(r => r.status === ui.partner.statusFilter);
  if (ui.partner.operationFilter !== 'all') reqs = reqs.filter(r => r.operation === ui.partner.operationFilter);

  return `
    <div class="page-head">
      <div><h1 class="serif">Painel de Onboarding</h1><div class="subtitle" style="text-transform:none;letter-spacing:0;">Gerencie suas solicitações e documentos</div></div>
      <button class="btn btn-primary" data-action="open-nova-solicitacao">+ Nova Solicitação</button>
    </div>

    ${hasAny ? `
      <div class="dashboard-toolbar">
        <div class="search-mini">🔍 <input type="text" placeholder="Buscar solicitação..." value="${esc(ui.partner.search)}" data-action="partner-search"></div>
        <button class="filter-btn" data-action="toggle-partner-filters">▽</button>
      </div>
      ${ui.partner.filterOpen ? `
        <div class="filter-panel">
          <div class="field" style="margin:0;"><label>Status</label>
            <select data-action="partner-filter-status">
              <option value="all">Todos os status</option>
              ${Object.keys(STATUS_META).map(k => `<option value="${k}" ${ui.partner.statusFilter === k ? 'selected' : ''}>${STATUS_META[k].label}</option>`).join('')}
            </select>
          </div>
          <div class="field" style="margin:0;"><label>Operação</label>
            <select data-action="partner-filter-operation">
              <option value="all">Todas as operações</option>
              ${Object.keys(OPERATIONS).map(k => `<option value="${k}" ${ui.partner.operationFilter === k ? 'selected' : ''}>${OPERATIONS[k].label}</option>`).join('')}
            </select>
          </div>
        </div>
      ` : ''}
    ` : ''}

    ${reqs.length === 0 ? `
      <div class="panel">
        <div class="empty-state">
          <div class="icon">📄</div>
          <h3 class="serif">Nenhuma solicitação ativa</h3>
          <p>Comece seu processo de onboarding clicando no botão "Nova Solicitação" acima.</p>
        </div>
      </div>
    ` : `
      <div class="card-grid">
        ${reqs.map(r => `
          <div class="info-card" data-action="open-request-detail-partner" data-id="${r.id}">
            <div class="top-row" style="justify-content:center;flex-direction:column;align-items:center;text-align:center;">
              <div class="request-brand-logo" style="margin-bottom:8px;">${OPERATIONS[r.operation]?.tag || r.operation}</div>
              <div class="title">${esc(r.form?.nome || '—')}</div>
              <div class="mono" style="font-size:11px;color:var(--muted);">ID: ${r.id.slice(0, 8)}</div>
            </div>
            <div class="foot" style="justify-content:space-between;">
              <span class="badge ${STATUS_META[r.status].cls}">${STATUS_META[r.status].label}</span>
              <span>${fmtDate(r.updatedAt)}</span>
            </div>
          </div>
        `).join('')}
      </div>
    `}

    <div style="text-align:right;margin-top:22px;">
      <button class="link-btn muted" data-action="partner-goto" data-screen="erros">⚠ Reportar Erro</button>
    </div>
  `;
}

function PartnerErros() {
  const list = db.errors.slice();
  return `
    <button class="back-link" data-action="partner-goto" data-screen="dashboard">← Voltar ao Painel</button>
    <div class="page-head" style="margin-top:14px;">
      <div><h1 class="serif">Erros Reportados</h1><div class="subtitle" style="text-transform:none;letter-spacing:0;">Histórico de comunicação</div></div>
      <button class="btn btn-primary" data-action="open-reportar-erro">+ Reportar Novo Erro</button>
    </div>
    ${list.length === 0 ? `<div class="panel"><div class="empty-state">Nenhum erro reportado ainda.</div></div>` : `
      <div class="panel">
        ${list.map(e => `
          <div class="list-row" style="grid-template-columns:1fr auto;cursor:default;">
            <div><div class="name">${esc(e.subject)}</div><div class="sub">${fmtDate(e.createdAt)}</div></div>
            <span class="badge ${e.status === 'respondido' ? 'sent' : 'pending'}">${e.status === 'respondido' ? 'Respondido' : 'Pendente'}</span>
          </div>
        `).join('')}
      </div>
    `}
  `;
}

/* ============================================================
   MODALS
   ============================================================ */
function renderModal() {
  const root = document.getElementById('modal-root');
  if (!ui.modal) { root.innerHTML = ''; return; }
  if (ui.modal.type === 'nova-solicitacao') root.innerHTML = NovaSolicitacaoModal(ui.modal.draft);
  else if (ui.modal.type === 'edit-cadastro') root.innerHTML = EditCadastroModal();
  else if (ui.modal.type === 'reportar-erro') root.innerHTML = ReportarErroModal();
  else if (ui.modal.type === 'error-detail') root.innerHTML = ErrorDetailModal(ui.modal.id);
}

function NovaSolicitacaoModal(draft) {
  const type = personType(draft.documento);
  const complete = isFormComplete(draft) && !draft.anyUploading;

  const uploadSlot = (docKey, label, filesObj, extraAttrs = '', uploadingFlag = false) => {
    const file = filesObj[docKey];
    if (uploadingFlag) {
      return `<div class="upload-slot" style="opacity:.7;">⏳ ${esc(label)} <span class="name">Enviando...</span></div>`;
    }
    return `
      <label class="upload-slot ${file ? 'filled' : ''}" ${extraAttrs}>
        ${file ? '✅' : '📤'} ${esc(label)} ${file ? `<span class="name">— ${esc(file)}</span>` : '<span class="name">Clique para fazer upload</span>'}
        <input type="file" data-action="draft-file" data-key="${docKey}" accept=".pdf,.jpg,.jpeg,.png">
      </label>
    `;
  };

  let body = `
    <div class="field">
      <label>Tipo de Operação</label>
      <select id="ns-operation" data-action="draft-field" data-field="operation">
        <option value="">Selecione o Tipo de Operação</option>
        ${Object.keys(OPERATIONS).map(k => `<option value="${k}" ${draft.operation === k ? 'selected' : ''}>${OPERATIONS[k].label}</option>`).join('')}
      </select>
    </div>
    <div class="field"><label>Nome do Cliente ou Razão Social</label><input type="text" placeholder="Nome completo ou Razão Social" value="${esc(draft.nome)}" data-action="draft-field" data-field="nome"></div>
    <div class="form-grid-2">
      <div class="field"><label>CPF ou CNPJ</label><input type="text" placeholder="000.000.000-00 ou 00.000.000/0000-00" value="${esc(draft.documento)}" data-action="draft-field" data-field="documento"></div>
      <div class="field"><label>Telefone</label><input type="text" placeholder="(00) 00000-0000" value="${esc(draft.telefone)}" data-action="draft-field" data-field="telefone"></div>
    </div>
    <div class="field"><label>E-mail</label><input type="email" placeholder="email@exemplo.com" value="${esc(draft.email)}" data-action="draft-field" data-field="email"></div>
  `;

  if (type === 'PJ') {
    body += `
      <div class="section-divider"></div>
      <div class="section-label">Informações Adicionais (Pessoa Jurídica)</div>
      <div class="form-grid-2">
        <div class="field"><label>Subtipo de Operação</label><input type="text" value="${esc(draft.subtipoOperacao)}" data-action="draft-field" data-field="subtipoOperacao"></div>
        <div class="field"><label>Número de Sócios</label><input type="number" value="${esc(draft.numeroSocios)}" data-action="draft-field" data-field="numeroSocios"></div>
      </div>
      <div class="field"><label>Informações dos Sócios</label><textarea data-action="draft-field" data-field="infoSocios">${esc(draft.infoSocios)}</textarea></div>
      <div class="form-grid-2">
        <div class="field"><label>Possui Procurador?</label>
          <select data-action="draft-field" data-field="possuiProcurador">
            <option value="">Selecione...</option><option ${draft.possuiProcurador === 'Sim' ? 'selected' : ''}>Sim</option><option ${draft.possuiProcurador === 'Não' ? 'selected' : ''}>Não</option>
          </select>
        </div>
        <div class="field"><label>Tipo de Pessoa da Matrícula</label><input type="text" value="${esc(draft.tipoPessoaMatricula)}" data-action="draft-field" data-field="tipoPessoaMatricula"></div>
      </div>
      <div class="field"><label>Informações do Procurador</label><textarea data-action="draft-field" data-field="infoProcurador">${esc(draft.infoProcurador)}</textarea></div>

      <div class="section-divider"></div>
      <div class="section-label">Anexar Documentos Obrigatórios</div>
      ${PJ_DOCS.map(d => uploadSlot(d.key, d.label, draft.docs, '', draft.uploading[d.key])).join('')}
    `;
  } else if (type === 'PF') {
    body += `
      <div class="section-divider"></div>
      <div class="section-label">Informações Adicionais (Pessoa Física)</div>
      <div class="form-grid-2">
        <div class="field"><label>Profissão</label><input type="text" placeholder="Sua profissão" value="${esc(draft.profissao)}" data-action="draft-field" data-field="profissao"></div>
        <div class="field"><label>Possui ICP para assinatura?</label>
          <select data-action="draft-field" data-field="icp">
            <option value="">Selecione...</option><option ${draft.icp === 'Sim' ? 'selected' : ''}>Sim</option><option ${draft.icp === 'Não' ? 'selected' : ''}>Não</option>
          </select>
        </div>
      </div>
      <div class="field"><label>Estado Civil</label>
        <select data-action="draft-field" data-field="estadoCivil">
          <option value="">Selecione...</option>
          ${['Solteiro(a)', 'Casado(a)', 'União Estável', 'Viúvo(a)'].map(o => `<option ${draft.estadoCivil === o ? 'selected' : ''}>${o}</option>`).join('')}
        </select>
      </div>

      <div class="section-divider"></div>
      <div class="section-label">Anexar Documentos Obrigatórios</div>
      ${requiredBaseDocs(draft).map(d => uploadSlot(d.key, d.label, draft.docs, '', draft.uploading[d.key])).join('')}

      <div class="section-label" style="margin-top:20px;">Documentos da Operação (Obrigatórios)</div>
      <div class="form-grid-2">${OPERATION_DOCS.slice(0, 2).map(d => uploadSlot(d.key, d.label, draft.docs, '', draft.uploading[d.key])).join('')}</div>
      ${uploadSlot(OPERATION_DOCS[2].key, OPERATION_DOCS[2].label, draft.docs, '', draft.uploading[OPERATION_DOCS[2].key])}

      <div class="field" style="margin-top:14px;"><label>Possui Avalista?</label>
        <select data-action="draft-field" data-field="possuiAvalista">
          <option value="">Selecione...</option><option ${draft.possuiAvalista === 'Sim' ? 'selected' : ''}>Sim</option><option ${draft.possuiAvalista === 'Não' ? 'selected' : ''}>Não</option>
        </select>
      </div>

      <div class="section-label" style="margin-top:20px;">Dados do Imóvel</div>
      <div class="form-grid-2">${IMOVEL_DOCS.map(d => uploadSlot(d.key, d.label, draft.docs, '', draft.uploading[d.key])).join('')}</div>

      <div class="section-divider"></div>
      <div class="field"><label>A certidão é emitida em nome de Pessoa Física ou Jurídica? <span class="req">*</span></label>
        <select data-action="draft-field" data-field="certidaoPFPJ">
          <option value="">Selecione...</option><option ${draft.certidaoPFPJ === 'Pessoa Física' ? 'selected' : ''}>Pessoa Física</option><option ${draft.certidaoPFPJ === 'Pessoa Jurídica' ? 'selected' : ''}>Pessoa Jurídica</option>
        </select>
      </div>
      ${draft.certidaoPFPJ ? `
        <div class="field"><label>Número de Emitentes <span class="req">*</span></label><input type="number" min="1" value="${esc(draft.numeroEmitentes)}" data-action="draft-field" data-field="numeroEmitentes"></div>
        ${(draft.emitentes || []).map((em, i) => `
          <div class="subsection">
            <div class="section-label">Dados do Emitente ${i + 1}</div>
            <div class="field"><label>Nome do Emitente</label><input type="text" value="${esc(em.nome)}" data-action="draft-emitente-field" data-idx="${i}" data-field="nome"></div>
            <div class="form-grid-2">
              <div class="field"><label>CPF do Emitente</label><input type="text" value="${esc(em.cpf)}" data-action="draft-emitente-field" data-idx="${i}" data-field="cpf"></div>
              <div class="field"><label>E-mail do Emitente</label><input type="email" value="${esc(em.email)}" data-action="draft-emitente-field" data-idx="${i}" data-field="email"></div>
            </div>
            <div class="form-grid-2">
              <div class="field"><label>Telefone do Emitente</label><input type="text" value="${esc(em.telefone)}" data-action="draft-emitente-field" data-idx="${i}" data-field="telefone"></div>
              <div class="field"><label>Profissão</label><input type="text" value="${esc(em.profissao)}" data-action="draft-emitente-field" data-idx="${i}" data-field="profissao"></div>
            </div>
            <div class="form-grid-2">
              <div class="field"><label>Possui ICP para assinatura?</label>
                <select data-action="draft-emitente-field" data-idx="${i}" data-field="icp">
                  <option value="">Selecione...</option><option ${em.icp === 'Sim' ? 'selected' : ''}>Sim</option><option ${em.icp === 'Não' ? 'selected' : ''}>Não</option>
                </select>
              </div>
              <div class="field"><label>Estado Civil</label>
                <select data-action="draft-emitente-field" data-idx="${i}" data-field="estadoCivil">
                  <option value="">Selecione...</option>
                  ${['Solteiro(a)', 'Casado(a)', 'União Estável', 'Viúvo(a)'].map(o => `<option ${em.estadoCivil === o ? 'selected' : ''}>${o}</option>`).join('')}
                </select>
              </div>
            </div>
            <div class="section-label">Anexar Documentos Obrigatórios do Emitente ${i + 1}</div>
            ${emitenteDocs(em).map(d => uploadSlot(d.key, d.label, em.docs, `data-emitente="${i}"`, (em.uploading || {})[d.key])).join('')}
          </div>
        `).join('')}
      ` : ''}
    `;
  }

  body += `
    <div class="section-divider"></div>
    <div class="subsection">
      <div class="section-label">Complementos da Solicitação (opcional)</div>
      <div class="field"><label>Informações Adicionais</label><textarea placeholder="Insira observações, contexto ou explicações relevantes à operação..." data-action="draft-field" data-field="obs">${esc(draft.obs)}</textarea></div>
      <div class="field"><label>Documentos Adicionais</label>
        <label class="upload-slot">📤 <span class="name">Clique para selecionar documentos</span>
          <input type="file" multiple data-action="draft-extra-file">
        </label>
        ${(draft.extraDocs || []).length ? `<div style="margin-top:8px;font-size:12px;color:var(--muted);">${draft.extraDocs.map(f => esc(f.name)).join(', ')}</div>` : ''}
      </div>
    </div>
  `;

  return `
    <div class="modal-overlay" data-action="close-modal-overlay">
      <div class="modal" style="max-width:640px;" data-stop-modal="1">
        <button class="modal-close" data-action="close-modal">×</button>
        <h2 class="serif">Nova Solicitação de Documentação</h2>
        <div class="modal-sub">Preencha os dados abaixo. Os documentos são enviados de verdade para o Storage assim que você anexa cada um.</div>
        ${body}
        <button class="btn btn-primary btn-block" style="margin-top:10px;" ${complete ? '' : 'disabled'} data-action="submit-nova-solicitacao">Gerar Solicitação →</button>
        <div style="text-align:center;margin-top:14px;"><button class="link-btn muted" data-action="open-reportar-erro">⚠ Reportar erro</button></div>
      </div>
    </div>
  `;
}

function EditCadastroModal() {
  const p = currentPartner();
  if (!p) return '';
  return `
    <div class="modal-overlay" data-action="close-modal-overlay">
      <div class="modal" data-stop-modal="1">
        <button class="modal-close" data-action="close-modal">×</button>
        <h2 class="serif">Editar Cadastro</h2>
        <div class="field"><label>Nome / Empresa</label><input type="text" id="ec-nome" value="${esc(p.name)}"></div>
        <div class="field"><label>WhatsApp</label><input type="text" id="ec-whats" value="${esc(p.whatsapp)}"></div>
        <div class="field"><label>CPF / CNPJ</label><input type="text" id="ec-doc" value="${esc(p.document)}"></div>
        <button class="btn btn-primary btn-block" data-action="save-edit-cadastro" data-id="${p.id}">💾 Salvar Alterações</button>
      </div>
    </div>
  `;
}

function ReportarErroModal() {
  return `
    <div class="modal-overlay" data-action="close-modal-overlay">
      <div class="modal" data-stop-modal="1">
        <button class="modal-close" data-action="close-modal">×</button>
        <h2 class="serif">Reportar erro</h2>
        <div class="modal-sub">Encontrou algum problema? Envie os detalhes para nossa equipe.</div>
        <div class="field"><label>Assunto</label><input type="text" id="re-assunto" placeholder="Ex: Erro ao enviar documento"></div>
        <div class="field"><label>Descrição do Erro</label><textarea id="re-desc" placeholder="Descreva o que aconteceu em detalhes..."></textarea></div>
        <button class="btn btn-primary btn-block" data-action="submit-reportar-erro">Enviar</button>
        <div style="text-align:center;margin-top:12px;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em;">O prazo de resposta é de até 48 horas úteis</div>
      </div>
    </div>
  `;
}

function ErrorDetailModal(errorId) {
  const e = db.errors.find(x => x.id === errorId);
  if (!e) return '';
  return `
    <div class="modal-overlay" data-action="close-modal-overlay">
      <div class="modal" data-stop-modal="1">
        <button class="modal-close" data-action="close-modal">×</button>
        <h2 class="serif">Detalhes do Relato</h2>
        <div class="field"><label>Parceiro</label><input type="text" value="${esc(e.partnerName)}" disabled></div>
        <div class="field"><label>Assunto</label><input type="text" value="${esc(e.subject)}" disabled></div>
        <div class="field"><label>Descrição do Erro</label><textarea disabled>${esc(e.description)}</textarea></div>
        ${e.status === 'respondido' ? `
          <div class="subsection" style="background:var(--green-soft);">
            <div class="eyebrow" style="color:var(--green);">Resposta Enviada</div>
            <div style="margin:6px 0;">${esc(e.response)}</div>
            <div style="font-size:11px;color:var(--muted);">Respondido por ${esc(e.respondedBy)} · ${fmtDate(e.respondedAt)}</div>
          </div>
        ` : `
          <div class="field"><label>Responder</label><textarea id="err-resp" placeholder="Escreva a resposta para o parceiro..."></textarea></div>
          <button class="btn btn-primary btn-block" data-action="submit-error-response" data-id="${e.id}">Enviar Resposta</button>
        `}
      </div>
    </div>
  `;
}

/* ============================================================
   MASTER RENDER
   ============================================================ */
function render() {
  renderTopbar();
  const app = document.getElementById('app');
  if (!authUser) app.innerHTML = ui.role ? AuthScreen() : RoleScreen();
  else if (!session) app.innerHTML = `<div class="role-screen"><div class="box"><p class="lede">Verificando permissões…</p></div></div>`;
  else app.innerHTML = session.role === 'admin' ? AdminRoot() : PartnerRoot();
  renderModal();
}

/* ============================================================
   DRAFT HELPERS (Nova Solicitação)
   ============================================================ */
function emptyDraft() {
  return {
    id: fbDb.collection('requests').doc().id, // pre-generated so uploads have a stable storage path
    operation: '', nome: '', documento: '', telefone: '', email: '',
    profissao: '', icp: '', estadoCivil: '',
    subtipoOperacao: '', numeroSocios: '', infoSocios: '', possuiProcurador: '', infoProcurador: '', tipoPessoaMatricula: '',
    possuiAvalista: '', certidaoPFPJ: '', numeroEmitentes: '',
    emitentes: [], obs: '', docs: {}, docPaths: {}, uploading: {}, extraDocs: [], anyUploading: false,
  };
}
function emptyEmitente() { return { nome: '', cpf: '', email: '', telefone: '', profissao: '', icp: '', estadoCivil: '', docs: {}, docPaths: {}, uploading: {} }; }

async function uploadDraftFile(file, key, emitenteIdx) {
  const draft = ui.modal.draft;
  const target = emitenteIdx === undefined ? draft : draft.emitentes[emitenteIdx];
  target.uploading[key] = true;
  draft.anyUploading = true;
  renderModal();
  try {
    const path = `documents/${authUser.uid}/${draft.id}/${key}${emitenteIdx !== undefined ? '_em' + emitenteIdx : ''}_${file.name}`;
    await fbStorage.ref(path).put(file);
    target.docs[key] = file.name;
    target.docPaths[key] = path;
  } catch (e) {
    toast('Falha no upload: ' + e.message);
  } finally {
    target.uploading[key] = false;
    draft.anyUploading = Object.values(draft.uploading).some(Boolean) || draft.emitentes.some(em => Object.values(em.uploading || {}).some(Boolean));
    renderModal();
  }
}

/* ============================================================
   EVENT DELEGATION
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  render();

  document.body.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const action = el.dataset.action;
    if (action === 'close-modal-overlay' && e.target.closest('[data-stop-modal]')) return;

    switch (action) {
      case 'choose-role':
        ui.role = el.dataset.role;
        ui.authMode = 'login';
        ui.authError = '';
        render();
        break;
      case 'back-to-role':
        ui.role = null;
        ui.authError = '';
        render();
        break;
      case 'goto-signup': ui.authMode = 'signup'; ui.authError = ''; render(); break;
      case 'goto-login': ui.authMode = 'login'; ui.authError = ''; render(); break;

      case 'submit-admin-login': {
        const email = document.getElementById('au-email').value.trim();
        const pass = document.getElementById('au-pass').value;
        if (!email || !pass) { ui.authError = 'Preencha e-mail e senha.'; render(); break; }
        ui.authBusy = true; ui.authError = ''; render();
        try {
          await fbAuth.signInWithEmailAndPassword(email, pass);
          const adminDoc = await fbDb.collection('admins').doc(email.toLowerCase()).get();
          if (!adminDoc.exists) {
            await fbAuth.signOut();
            ui.authError = 'Esta conta não tem permissão de gestor.';
            ui.authBusy = false;
            render();
          }
          // if it IS an admin, onAuthStateChanged takes over and renders the dashboard
        } catch (err) { ui.authError = friendlyAuthError(err); ui.authBusy = false; render(); }
        break;
      }
      case 'submit-partner-login': {
        const email = document.getElementById('au-email').value.trim();
        const pass = document.getElementById('au-pass').value;
        if (!email || !pass) { ui.authError = 'Preencha e-mail e senha.'; render(); break; }
        ui.authBusy = true; ui.authError = ''; render();
        try { await fbAuth.signInWithEmailAndPassword(email, pass); }
        catch (err) { ui.authError = friendlyAuthError(err); ui.authBusy = false; render(); }
        break;
      }
      case 'submit-cadastro': {
        const nome = document.getElementById('cad-nome').value.trim();
        const doc = document.getElementById('cad-doc').value.trim();
        const email = document.getElementById('cad-email').value.trim();
        const whats = document.getElementById('cad-whats').value.trim();
        const pass = document.getElementById('cad-pass').value;
        const pass2 = document.getElementById('cad-pass2').value;
        const tipo = document.querySelector('input[name="cad-tipo"]:checked').value;
        if (!nome || !doc || !email) { ui.authError = 'Preencha nome, documento e e-mail.'; render(); break; }
        if (pass.length < 6) { ui.authError = 'A senha precisa ter ao menos 6 caracteres.'; render(); break; }
        if (pass !== pass2) { ui.authError = 'As senhas não coincidem.'; render(); break; }
        ui.authBusy = true; ui.authError = ''; render();
        try {
          const cred = await fbAuth.createUserWithEmailAndPassword(email, pass);
          await fbDb.collection('partners').doc(cred.user.uid).set({
            name: nome, type: tipo, document: doc, email, whatsapp: whats,
            relationshipStart: FieldValue.serverTimestamp(), lastUpdate: FieldValue.serverTimestamp(),
          });
          toast('Cadastro criado com sucesso!');
        } catch (err) { ui.authError = friendlyAuthError(err); ui.authBusy = false; render(); }
        break;
      }
      case 'logout':
        await fbAuth.signOut();
        ui = initialUI();
        render();
        break;

      /* ---- admin nav ---- */
      case 'admin-tab': ui.admin.tab = el.dataset.tab; ui.admin.drill = null; render(); break;
      case 'admin-back-to-tab': ui.admin.tab = el.dataset.tab; ui.admin.drill = null; render(); break;
      case 'open-partner-profile': ui.admin.drill = { type: 'partner-profile', id: el.dataset.id, returnTab: ui.admin.tab }; render(); break;
      case 'open-partner-edit':
        if (el.dataset.stop) e.stopPropagation();
        ui.admin.drill = { type: 'partner-edit', id: el.dataset.id };
        render();
        break;
      case 'admin-close-edit': ui.admin.drill = { type: 'partner-profile', id: el.dataset.id, returnTab: ui.admin.tab }; render(); break;
      case 'save-partner-edit': {
        const id = el.dataset.id;
        await fbDb.collection('partners').doc(id).update({
          name: document.getElementById('ed-nome').value.trim(),
          type: document.getElementById('ed-tipo').value,
          document: document.getElementById('ed-doc').value.trim(),
          whatsapp: document.getElementById('ed-whats').value.trim(),
          lastUpdate: FieldValue.serverTimestamp(),
        });
        toast('Cadastro atualizado.');
        ui.admin.drill = { type: 'partner-profile', id, returnTab: ui.admin.tab };
        render();
        break;
      }
      case 'delete-partner': {
        if (!confirm('Excluir este parceiro e todas as suas solicitações? (a conta de login dele precisa ser removida separadamente pelo Firebase Console)')) break;
        const id = el.dataset.id;
        const batch = fbDb.batch();
        batch.delete(fbDb.collection('partners').doc(id));
        const reqs = await fbDb.collection('requests').where('partnerId', '==', id).get();
        reqs.forEach(d => batch.delete(d.ref));
        const errs = await fbDb.collection('errors').where('partnerId', '==', id).get();
        errs.forEach(d => batch.delete(d.ref));
        await batch.commit();
        toast('Parceiro excluído.');
        ui.admin.drill = null; ui.admin.tab = 'parceiros';
        render();
        break;
      }
      case 'open-request-detail':
        ui.admin.drill = { type: 'request-detail', id: el.dataset.id, returnTo: el.dataset.return === 'partner-profile' ? { type: 'partner-profile', id: el.dataset.returnId } : { type: 'pendencias' } };
        render();
        break;
      case 'open-error-modal': ui.modal = { type: 'error-detail', id: el.dataset.id }; renderModal(); break;
      case 'submit-error-response': {
        const text = document.getElementById('err-resp').value.trim();
        if (!text) { toast('Escreva uma resposta antes de enviar.'); break; }
        await fbDb.collection('errors').doc(el.dataset.id).update({ status: 'respondido', response: text, respondedBy: authUser.email, respondedAt: FieldValue.serverTimestamp() });
        ui.modal = null; render();
        toast('Resposta enviada ao parceiro.');
        break;
      }
      case 'save-admin-controls': {
        const r = db.requests.find(x => x.id === el.dataset.id);
        const feedback = document.getElementById('ctrl-feedback').value.trim();
        if (!feedback) { toast('A observação/feedback é obrigatória.'); break; }
        const newStatus = document.getElementById('ctrl-status').value;
        const docs = (r.documents || []).map(d => ({ ...d }));
        document.querySelectorAll('.ctrl-reject-doc:checked').forEach(cb => {
          const doc = docs.find(d => d.key === cb.value);
          if (doc) doc.status = 'rejeitado';
        });
        const extraDoc = document.getElementById('ctrl-extra-doc').value.trim();
        if (extraDoc) docs.push({ key: 'extra_req_' + uid(6), label: extraDoc, status: 'pendente', fileName: null, storagePath: null });
        const payload = {
          documents: docs,
          feedbackHistory: FieldValue.arrayUnion({ text: feedback, at: new Date().toISOString(), by: authUser.email }),
          updatedAt: FieldValue.serverTimestamp(),
        };
        if (newStatus) payload.status = newStatus;
        await fbDb.collection('requests').doc(r.id).update(payload);
        toast('Atualizações salvas.');
        render();
        break;
      }

      /* ---- partner nav ---- */
      case 'partner-goto': ui.partner.screen = el.dataset.screen; render(); break;
      case 'open-request-detail-partner': ui.partner.requestId = el.dataset.id; ui.partner.screen = 'request-detail'; render(); break;
      case 'toggle-partner-filters': ui.partner.filterOpen = !ui.partner.filterOpen; render(); break;
      case 'open-edit-cadastro': ui.modal = { type: 'edit-cadastro' }; renderModal(); break;
      case 'save-edit-cadastro': {
        await fbDb.collection('partners').doc(el.dataset.id).update({
          name: document.getElementById('ec-nome').value.trim(),
          whatsapp: document.getElementById('ec-whats').value.trim(),
          document: document.getElementById('ec-doc').value.trim(),
          lastUpdate: FieldValue.serverTimestamp(),
        });
        ui.modal = null; render();
        toast('Cadastro atualizado.');
        break;
      }
      case 'download-doc': {
        // open the tab synchronously, in direct response to the click, then point it
        // at the file once we have the URL — awaiting first risks the browser treating
        // the later window.open() as an unrequested popup and blocking it.
        const tab = window.open('', '_blank');
        try {
          const url = await fbStorage.ref(el.dataset.path).getDownloadURL();
          if (tab) tab.location.href = url; else window.open(url, '_blank');
        } catch (err) {
          if (tab) tab.close();
          toast('Não foi possível abrir o arquivo.');
        }
        break;
      }

      /* ---- Nova Solicitação modal ---- */
      case 'open-nova-solicitacao': ui.modal = { type: 'nova-solicitacao', draft: emptyDraft() }; renderModal(); break;
      case 'submit-nova-solicitacao': {
        const draft = ui.modal.draft;
        if (!isFormComplete(draft)) { toast('Preencha todos os campos e documentos obrigatórios.'); break; }
        // Firestore rejects `undefined` field values, so these must be dropped via
        // destructuring rather than set to undefined — the upload/doc-tracking fields
        // don't belong in the form snapshot anyway (they're persisted in `documents`).
        const { docs, docPaths, uploading, emitentes, extraDocs, anyUploading, id, ...formSnapshot } = draft;
        try {
          await fbDb.collection('requests').doc(draft.id).set({
            partnerId: authUser.uid, operation: draft.operation, status: 'em_analise',
            form: formSnapshot,
            documents: buildDocumentsFromDraft(draft),
            feedbackHistory: [],
            createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
          });
          ui.modal = null;
          ui.partner.requestId = draft.id;
          ui.partner.screen = 'request-detail';
          render();
          toast('Solicitação criada com sucesso!');
        } catch (err) {
          toast('Falha ao criar a solicitação: ' + err.message);
        }
        break;
      }
      case 'open-reportar-erro': ui.modal = { type: 'reportar-erro' }; renderModal(); break;
      case 'submit-reportar-erro': {
        const subject = document.getElementById('re-assunto').value.trim();
        const desc = document.getElementById('re-desc').value.trim();
        if (!subject || !desc) { toast('Preencha assunto e descrição.'); break; }
        const p = currentPartner();
        await fbDb.collection('errors').add({ partnerId: authUser.uid, partnerName: p.name, subject, description: desc, status: 'pendente', response: null, createdAt: FieldValue.serverTimestamp() });
        ui.modal = null; render();
        toast('Erro reportado. Prazo de resposta: até 48h úteis.');
        break;
      }

      case 'close-modal':
      case 'close-modal-overlay':
        ui.modal = null;
        renderModal();
        break;
    }
  });

  /* ---------------- input/change delegation ---------------- */
  document.body.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.action === 'admin-search') { ui.admin.search = el.value; focusPreservingRender(renderPartial); }
    if (el.dataset.action === 'partner-search') { ui.partner.search = el.value; focusPreservingRender(renderPartial); }
    if (el.dataset.action === 'draft-field') { ui.modal.draft[el.dataset.field] = el.value; focusPreservingRender(renderModal); }
    if (el.dataset.action === 'draft-emitente-field') {
      const idx = parseInt(el.dataset.idx, 10);
      ui.modal.draft.emitentes[idx][el.dataset.field] = el.value;
      focusPreservingRender(renderModal);
    }
  });

  document.body.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.dataset.action === 'admin-status-filter') { ui.admin.statusFilter = el.value; renderPartial(); }
    if (el.dataset.action === 'partner-filter-status') { ui.partner.statusFilter = el.value; renderPartial(); }
    if (el.dataset.action === 'partner-filter-operation') { ui.partner.operationFilter = el.value; renderPartial(); }

    if (el.dataset.action === 'draft-field') {
      ui.modal.draft[el.dataset.field] = el.value;
      if (el.dataset.field === 'numeroEmitentes') {
        const n = Math.max(0, parseInt(el.value || '0', 10) || 0);
        const arr = ui.modal.draft.emitentes;
        while (arr.length < n) arr.push(emptyEmitente());
        while (arr.length > n) arr.pop();
      }
      renderModal();
    }
    if (el.dataset.action === 'draft-emitente-field') {
      const idx = parseInt(el.dataset.idx, 10);
      ui.modal.draft.emitentes[idx][el.dataset.field] = el.value;
      renderModal();
    }
    if (el.dataset.action === 'draft-file') {
      const file = el.files[0];
      if (!file) return;
      const emitenteIdx = el.dataset.emitente !== undefined ? parseInt(el.dataset.emitente, 10) : undefined;
      await uploadDraftFile(file, el.dataset.key, emitenteIdx);
    }
    if (el.dataset.action === 'draft-extra-file') {
      const draft = ui.modal.draft;
      draft.extraDocs = draft.extraDocs || [];
      for (const file of Array.from(el.files)) {
        const path = `documents/${authUser.uid}/${draft.id}/extra_${Date.now()}_${file.name}`;
        try { await fbStorage.ref(path).put(file); draft.extraDocs.push({ name: file.name, path }); }
        catch (err) { toast('Falha no upload de ' + file.name); }
      }
      renderModal();
    }
    if (el.dataset.action === 'partner-upload-existing-doc') {
      const file = el.files[0];
      if (!file) return;
      const req = db.requests.find(r => r.id === el.dataset.req);
      const path = `documents/${authUser.uid}/${req.id}/${el.dataset.key}_${file.name}`;
      try {
        await fbStorage.ref(path).put(file);
        const docs = (req.documents || []).map(d => d.key === el.dataset.key ? { ...d, status: 'enviado', fileName: file.name, storagePath: path } : d);
        await fbDb.collection('requests').doc(req.id).update({ documents: docs, updatedAt: FieldValue.serverTimestamp() });
        toast('Documento enviado.');
      } catch (err) { toast('Falha no upload: ' + err.message); }
    }
  });
});

function friendlyAuthError(err) {
  const map = {
    'auth/invalid-email': 'E-mail inválido.',
    'auth/user-not-found': 'Não encontramos uma conta com esse e-mail.',
    'auth/wrong-password': 'Senha incorreta.',
    'auth/invalid-credential': 'E-mail ou senha incorretos.',
    'auth/email-already-in-use': 'Já existe uma conta com esse e-mail.',
    'auth/weak-password': 'A senha precisa ter ao menos 6 caracteres.',
    'auth/too-many-requests': 'Muitas tentativas. Aguarde um pouco e tente de novo.',
  };
  return map[err.code] || err.message || 'Ocorreu um erro. Tente novamente.';
}

/* re-renders innerHTML replace the focused element, so this snapshots the
   active input's identity + cursor position and restores it afterwards */
function focusPreservingRender(renderFn) {
  const active = document.activeElement;
  let sel = null;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    sel = {
      action: active.dataset.action || null,
      field: active.dataset.field || null,
      idx: active.dataset.idx !== undefined ? active.dataset.idx : null,
      id: active.id || null,
      start: active.selectionStart,
      end: active.selectionEnd,
    };
  }
  renderFn();
  if (!sel) return;
  let selector = sel.id ? `#${CSS.escape(sel.id)}` : `[data-action="${sel.action}"]`;
  if (!sel.id) {
    if (sel.field) selector += `[data-field="${sel.field}"]`;
    if (sel.idx !== null) selector += `[data-idx="${sel.idx}"]`;
  }
  const found = document.querySelector(selector);
  if (found) {
    found.focus();
    if (typeof sel.start === 'number' && found.setSelectionRange) {
      try { found.setSelectionRange(sel.start, sel.end); } catch (e) { /* not applicable to this input type */ }
    }
  }
}

function renderPartial() {
  const app = document.getElementById('app');
  if (!authUser) app.innerHTML = ui.role ? AuthScreen() : RoleScreen();
  else if (session) app.innerHTML = session.role === 'admin' ? AdminRoot() : PartnerRoot();
}
