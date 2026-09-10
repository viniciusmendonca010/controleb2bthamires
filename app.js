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
function isValidCPF(cpf) {
  const s = (cpf || '').replace(/\D/g, '');
  if (s.length !== 11 || /^(\d)\1{10}$/.test(s)) return false;
  const digits = s.split('').map(Number);
  const checkDigit = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += digits[i] * (len + 1 - i);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return checkDigit(9) === digits[9] && checkDigit(10) === digits[10];
}
function isValidCNPJ(cnpj) {
  const s = (cnpj || '').replace(/\D/g, '');
  if (s.length !== 14 || /^(\d)\1{13}$/.test(s)) return false;
  const digits = s.split('').map(Number);
  const checkDigit = (len) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < len; i++) sum += digits[i] * weights[i];
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return checkDigit(12) === digits[12] && checkDigit(13) === digits[13];
}
function isValidDocumento(documento) {
  const type = personType(documento);
  if (type === 'PF') return isValidCPF(documento);
  if (type === 'PJ') return isValidCNPJ(documento);
  return false;
}
const FieldValue = firebase.firestore.FieldValue;

/* ---------------- operation branding ---------------- */
const OPERATIONS = {
  'CERES CONFINAMENTO': { label: 'Ceres Confinamento', tag: 'CONFINAMENTO' },
  'CERES TRADING': { label: 'Ceres Trading', tag: 'TRADING' },
  'CERES AGROBANK': { label: 'Ceres AgroFinance', tag: 'AGROFINANCE' },
  'CREDITO BTG PACTUAL': { label: 'Crédito BTG Pactual', tag: 'BTG PACTUAL' },
  'CONSORCIO': { label: 'Consórcio', tag: 'CONSÓRCIO' },
  'IMPULSA': { label: 'Impulsiona', tag: 'IMPULSIONA' },
};
// Ceres AgroFinance is the only operation with a required sub-type today.
const AGROFINANCE_SUBTIPOS = ['Antecipação de Recebíveis', 'Semi-Estruturada', 'Estruturada'];
// Impulsiona: the stored volume is always capped at this amount when the
// request is submitted — requests actually needing more must go through the
// full manual flow (another Tipo de Operação) instead, so Impulsiona itself
// never collects Balanço/DRE or any other document tied to volume.
const IMPULSA_VOLUME_LIMIT = 2000000;
const IMPULSA_LOTE_ROW_LIMIT = 200;
// caps the stored volume at IMPULSA_VOLUME_LIMIT; keeps the originally
// requested figure alongside it (when different) so the gestor can see a
// partner actually needed more and route them to the manual/full flow.
function capImpulsaVolume(rawVolume) {
  const original = Number(rawVolume) || 0;
  const capped = Math.min(original, IMPULSA_VOLUME_LIMIT);
  return { impulsaVolume: String(capped), impulsaVolumeOriginal: original > IMPULSA_VOLUME_LIMIT ? String(original) : null };
}
// Lets a partner correct their own request in place (fix a typo, replace a
// rejected file, adjust a value) instead of forcing a whole new solicitação.
// Keyed by request id so switching between requests re-seeds the draft from
// that request's current saved form.
function ensurePartnerEditDraft(r) {
  if (ui.partner.editDraftId !== r.id) {
    ui.partner.editDraft = { ...r.form };
    ui.partner.editDraftId = r.id;
  }
  return ui.partner.editDraft;
}
function isImpulsaRowValid(row) {
  if (!row.nome || !row.documento || !isValidDocumento(row.documento)) return false;
  const volume = Number(row.volume) || 0;
  if (!row.volume || volume <= 0) return false;
  return true;
}
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

/* ============================================================
   CHECKLIST ENGINE — per operação/subtipo/pessoa document & field
   requirements, sourced from "CHECKLIST GCI.xlsx" (Ceres team).
   Covers Ceres Confinamento, Ceres Trading and Ceres AgroFinance;
   Crédito BTG Pactual and Consórcio have no checklist defined yet
   and keep using the generic PF/PJ_DOCS flow above.
   ============================================================ */
const CK_DOCS = {
  carta_bacen: { key: 'carta_bacen', label: 'Carta Bacen/SCR (modelo Ceres)' },
  relatorio_visita: { key: 'relatorio_visita', label: 'Relatório de Visita (Parceiro – manter arquivo editável)' },
  contrato_social: { key: 'contrato_social', label: 'Última alteração do Contrato Social (se Limitada) ou do Estatuto Social' },
  certidao_simplificada_jc: { key: 'certidao_simplificada_jc', label: 'Certidão simplificada emitida pela Junta Comercial (validade 30 dias)' },
  cartao_cnpj: { key: 'cartao_cnpj', label: 'Cartão de inscrição no CNPJ' },
  inscricao_estadual: { key: 'inscricao_estadual', label: 'Inscrição Estadual (se aplicável)', optional: true },
  inscricao_municipal: { key: 'inscricao_municipal', label: 'Inscrição Municipal (se aplicável)', optional: true },
  df_2022: { key: 'df_2022', label: 'DF 2022 (Balanço, DRE e Faturamento)' },
  df_2023: { key: 'df_2023', label: 'DF 2023 (Balanço, DRE e Faturamento)' },
  df_2024: { key: 'df_2024', label: 'DF 2024 (Balanço, DRE e Faturamento)' },
  df_2025: { key: 'df_2025', label: 'DF 2025 (Balanço, DRE e Faturamento)' },
  organograma: { key: 'organograma', label: 'Organograma societário' },
  endividamento_empresa: { key: 'endividamento_empresa', label: 'Endividamento calendarizado da empresa' },
  planilha_confina: { key: 'planilha_confina', label: 'Planilha Produtor Agrícola/Confina (modelo Ceres)' },
  curva_abc_cliente: { key: 'curva_abc_cliente', label: 'Curva ABC Cliente' },
  curva_abc_fornecedor: { key: 'curva_abc_fornecedor', label: 'Curva ABC Fornecedor' },
  apresentacao_institucional: { key: 'apresentacao_institucional', label: 'Apresentação Institucional ou Descrição da Companhia' },
  abertura_receita: { key: 'abertura_receita', label: 'Abertura de receita (preço, quantidade e margem de contribuição por linha)' },
  projecao_operacao: { key: 'projecao_operacao', label: 'Projeção — período da operação proposta' },

  doc_pessoal: { key: 'doc_pessoal', label: 'Documentos pessoais (CNH, RG ou CRNM) — cópias legíveis' },
  comp_residencia: { key: 'comp_residencia', label: 'Comprovante de residência (luz, gás e/ou água) — validade 60 dias' },
  irpf: { key: 'irpf', label: 'IRPF (ano base anterior), declaração completa + recibo' },
  endividamento_pf: { key: 'endividamento_pf', label: 'Endividamento calendarizado' },
  certidao_casamento_nasc: { key: 'certidao_casamento_nasc', label: 'Certidão de Casamento ou Certidão de Nascimento' },
  lcdpr: { key: 'lcdpr', label: 'LCDPR (Livro Caixa Digital do Produtor Rural), de 2022 até hoje' },
  planilha_quadro_safra: { key: 'planilha_quadro_safra', label: 'Planilha Produtor Agrícola / Quadro safra' },

  matricula_imovel: { key: 'matricula_imovel', label: 'Certidão de Matrícula do Imóvel (Registro Geral, Livro 2) — validade 30 dias' },
  penhor: { key: 'penhor', label: 'Certidão de Penhor e/ou Alienação Fiduciária (Registro Auxiliar, Livro 3) — validade 10 dias' },
  car_kml: { key: 'car_kml', label: 'CAR e KML das áreas dadas em garantia' },
  arrendamento: { key: 'arrendamento', label: 'Contrato de Arrendamento, Comodato e/ou similares (quando aplicável)', optional: true },
  anuencia: { key: 'anuencia', label: 'Termo de anuência do proprietário para alienação fiduciária e penhor agrícola' },
  doc_proprietarios: { key: 'doc_proprietarios', label: 'Documentos pessoais dos proprietários do imóvel, caso os emitentes não sejam os proprietários', optional: true },
  registro_b3_cpr: { key: 'registro_b3_cpr', label: 'Documento de registro B3 e registro em cartório da CPR (quando aplicável)', optional: true },

  procuracao: { key: 'procuracao', label: 'Procuração pública ou procuração privada com firma reconhecida' },
  doc_pessoal_procurador: { key: 'doc_pessoal_procurador', label: 'Documentos pessoais do procurador (CNH, RG e CPF) — cópias legíveis' },
  comp_residencia_procurador: { key: 'comp_residencia_procurador', label: 'Comprovante de residência do procurador — validade 60 dias' },

  ir_socio: { key: 'ir_socio', label: 'IR do sócio/avalista (ano base anterior), declaração completa + recibo' },
  conjuge_doc_pessoal: { key: 'conjuge_doc_pessoal', label: 'Documentos pessoais do cônjuge/avalista (CNH, RG ou CRNM)' },
};
function ck(...keys) { return keys.map(k => CK_DOCS[k]); }
const CK_IMOVEL_DOCS = ck('matricula_imovel', 'penhor', 'car_kml', 'arrendamento', 'anuencia', 'doc_proprietarios', 'registro_b3_cpr');
const CK_PROCURADOR_DOCS = ck('procuracao', 'doc_pessoal_procurador', 'comp_residencia_procurador');
const CK_SOCIO_DOCS = ck('doc_pessoal', 'comp_residencia', 'certidao_casamento_nasc', 'ir_socio');

const AGRO_PJ_BASE_DOCS = ck('carta_bacen', 'relatorio_visita', 'contrato_social', 'cartao_cnpj', 'inscricao_estadual', 'inscricao_municipal', 'df_2022', 'df_2023', 'df_2024', 'df_2025', 'organograma', 'endividamento_empresa', 'curva_abc_cliente', 'curva_abc_fornecedor');

const COVERED_OPERATIONS = ['CERES AGROBANK', 'CERES CONFINAMENTO', 'CERES TRADING'];
const CHECKLISTS = {
  AGRO_ANTECIPACAO_PJ: {
    fields: ['enderecoInstitucional'], docs: AGRO_PJ_BASE_DOCS,
    hasSocios: true, hasProcurador: true, hasImovel: false,
  },
  AGRO_ESTRUTURADA_PJ: {
    fields: ['enderecoInstitucional'], docs: [...AGRO_PJ_BASE_DOCS, ...ck('apresentacao_institucional', 'abertura_receita', 'projecao_operacao')],
    hasSocios: true, hasProcurador: true, hasImovel: false,
  },
  AGRO_PF: {
    fields: ['icp'], docs: ck('carta_bacen', 'relatorio_visita', 'doc_pessoal', 'comp_residencia', 'irpf', 'endividamento_pf', 'certidao_casamento_nasc', 'lcdpr', 'planilha_quadro_safra'),
    hasSocios: false, hasProcurador: false, hasImovel: false,
  },
  CONFINA_PJ: {
    fields: ['enderecoInstitucional'], docs: ck('carta_bacen', 'contrato_social', 'certidao_simplificada_jc', 'cartao_cnpj', 'inscricao_estadual', 'inscricao_municipal', 'df_2022', 'df_2023', 'df_2024', 'df_2025', 'endividamento_empresa', 'organograma'),
    hasSocios: true, hasProcurador: false, hasImovel: true, hasConfinaPlanilha: true, hasRelatorioVisita: true,
  },
  CONFINA_PF: {
    fields: ['icp'], docs: ck('carta_bacen', 'doc_pessoal', 'comp_residencia', 'irpf', 'endividamento_pf', 'certidao_casamento_nasc'),
    hasSocios: false, hasProcurador: false, hasImovel: true, hasConfinaPlanilha: true, hasRelatorioVisita: true,
  },
  TRADING_PJ: {
    fields: ['enderecoInstitucional', 'dadosBancarios', 'enderecoFazenda'],
    docs: ck('carta_bacen', 'contrato_social', 'certidao_simplificada_jc', 'cartao_cnpj', 'inscricao_estadual', 'inscricao_municipal', 'df_2022', 'df_2023', 'df_2024', 'df_2025', 'planilha_confina', 'organograma'),
    hasSocios: true, hasSocioExtra: true, hasSocioPatrimonio: true, hasProcurador: true, hasImovel: true,
    hasRelatorioVisita: true, hasEndividamentoPatrimonio: true, hasFaturamento: true,
  },
  TRADING_PF: {
    fields: ['icp', 'dadosBancarios', 'enderecoFazenda', 'nacionalidade'],
    docs: ck('carta_bacen', 'doc_pessoal', 'comp_residencia', 'irpf', 'certidao_casamento_nasc', 'planilha_confina'),
    hasSocios: false, hasProcurador: false, hasImovel: true,
    hasRelatorioVisita: true, hasEndividamentoPatrimonio: true, hasFaturamento: true, hasPatrimonioPessoal: true,
  },
};
function resolveProfile(draft) {
  if (draft.operation === 'CERES AGROBANK') {
    if (draft.tipoPessoa === 'PF') return 'AGRO_PF';
    if (draft.tipoPessoa === 'PJ') {
      if (draft.agroSubtipo === 'Antecipação de Recebíveis') return 'AGRO_ANTECIPACAO_PJ';
      if (draft.agroSubtipo === 'Semi-Estruturada' || draft.agroSubtipo === 'Estruturada') return 'AGRO_ESTRUTURADA_PJ';
    }
    return null;
  }
  if (draft.operation === 'CERES CONFINAMENTO') return draft.tipoPessoa === 'PF' ? 'CONFINA_PF' : draft.tipoPessoa === 'PJ' ? 'CONFINA_PJ' : null;
  if (draft.operation === 'CERES TRADING') return draft.tipoPessoa === 'PF' ? 'TRADING_PF' : draft.tipoPessoa === 'PJ' ? 'TRADING_PJ' : null;
  return null; // Crédito BTG Pactual / Consórcio: no checklist yet, uses the generic PF/PJ flow
}
function isValidDocumentoForTipo(documento, tipoPessoa) {
  if (tipoPessoa === 'PF') return isValidCPF(documento);
  if (tipoPessoa === 'PJ') return isValidCNPJ(documento);
  return isValidDocumento(documento);
}
function isChecklistComplete(draft, profile) {
  if (profile.fields.includes('enderecoInstitucional') && !draft.enderecoInstitucional) return false;
  if (profile.fields.includes('icp') && (!draft.profissao || !draft.icp)) return false;
  if (profile.fields.includes('nacionalidade') && (!draft.nacionalidade || !draft.estadoCivil)) return false;
  if (profile.fields.includes('dadosBancarios') && !draft.dadosBancarios) return false;
  if (profile.fields.includes('enderecoFazenda') && !draft.enderecoFazenda) return false;
  if (!profile.docs.filter(d => !d.optional).every(d => draft.docs[d.key])) return false;

  if (profile.hasImovel) {
    if (!draft.certidaoPFPJ) return false;
    if (!CK_IMOVEL_DOCS.filter(d => !d.optional).every(d => draft.docs[d.key])) return false;
    const n = parseInt(draft.numeroEmitentes || '0', 10);
    if (!n || n < 1) return false;
    for (let i = 0; i < n; i++) {
      const em = draft.emitentes[i];
      if (!em || !em.nome || !em.cpf || !isValidCPF(em.cpf) || !em.docs.doc_pessoal) return false;
    }
  }
  if (profile.hasSocios) {
    const n = parseInt(draft.numeroSocios || '0', 10);
    if (!n || n < 1) return false;
    for (let i = 0; i < n; i++) {
      const s = draft.socios[i];
      if (!s || !s.nome || !s.cpf || !isValidCPF(s.cpf) || !s.profissao) return false;
      if (!CK_SOCIO_DOCS.every(d => s.docs[d.key])) return false;
      if (profile.hasSocioExtra && (!s.nacionalidade || !s.estadoCivil)) return false;
    }
  }
  if (profile.hasProcurador && draft.possuiProcurador === 'Sim' && !CK_PROCURADOR_DOCS.every(d => draft.docs[d.key])) return false;
  if (!draft.temConjugeAvalista) return false;
  if (draft.temConjugeAvalista === 'Sim' && (!draft.conjugeProfissao || !draft.conjugeContato || !draft.docs.conjuge_doc_pessoal)) return false;
  if (profile.hasConfinaPlanilha) {
    const hasCompleteYear = CONFINA_ANOS.some(a => CONFINA_METRICAS.every(m => draft.confinaPlanilha[m.key][a.key] !== ''));
    if (!hasCompleteYear) return false;
  }
  if (profile.hasRelatorioVisita) {
    const v = draft.visitaRelatorio;
    if (!v.razaoSocial || !v.motivoVisita || !v.produtoVisita || !v.resumoParecer) return false;
  }
  if (profile.hasFaturamento) {
    const hasCompleteYear = FATURAMENTO_ANOS.some(a => FATURAMENTO_MESES.every(m => draft.faturamento[m][a] !== ''));
    if (!hasCompleteYear) return false;
  }
  if (profile.hasEndividamentoPatrimonio) {
    const hasFazenda = draft.endividamentoPatrimonio.fazendas.some(f => f.nome !== '');
    if (!hasFazenda) return false;
  }
  return true;
}
function buildChecklistDocuments(draft, profile) {
  const out = [];
  const push = (d) => out.push({ ...d, status: draft.docs[d.key] ? 'enviado' : 'pendente', fileName: draft.docs[d.key] || null, storagePath: draft.docPaths[d.key] || null });
  profile.docs.forEach(push);
  if (profile.hasImovel) {
    CK_IMOVEL_DOCS.forEach(push);
    const n = parseInt(draft.numeroEmitentes || '0', 10) || 0;
    for (let i = 0; i < n; i++) {
      const em = draft.emitentes[i] || { nome: '', docs: {}, docPaths: {} };
      out.push({ key: 'em_doc_pessoal_' + i, label: `Documentos pessoais — Emitente ${i + 1} (${em.nome || '—'})`, status: em.docs.doc_pessoal ? 'enviado' : 'pendente', fileName: em.docs.doc_pessoal || null, storagePath: (em.docPaths || {}).doc_pessoal || null });
    }
  }
  if (profile.hasSocios) {
    const n = parseInt(draft.numeroSocios || '0', 10) || 0;
    for (let i = 0; i < n; i++) {
      const s = draft.socios[i] || { nome: '', docs: {}, docPaths: {} };
      CK_SOCIO_DOCS.forEach(d => out.push({ key: d.key + '_socio' + i, label: `${d.label} — Sócio ${i + 1} (${s.nome || '—'})`, status: s.docs[d.key] ? 'enviado' : 'pendente', fileName: s.docs[d.key] || null, storagePath: (s.docPaths || {})[d.key] || null }));
    }
  }
  if (profile.hasProcurador && draft.possuiProcurador === 'Sim') CK_PROCURADOR_DOCS.forEach(push);
  if (draft.temConjugeAvalista === 'Sim') push(CK_DOCS.conjuge_doc_pessoal);
  (draft.extraDocs || []).forEach((f, i) => out.push({ key: 'extra_' + i, label: `Documento adicional: ${f.name}`, status: 'enviado', fileName: f.name, storagePath: f.path }));
  return out;
}

/* ============================================================
   PLANILHA PRODUTOR AGRÍCOLA/CONFINA (modelo Ceres) — replicates
   "PLANILHA ABA CONFINA - Modelo v2.xlsx" (aba "Confina"): 15 input
   metrics per year (2022-2025 Realizado, 2026-2028 Projetado) plus
   the same derived totals as the original spreadsheet's formulas.
   Ceres Confinamento only, per the partner's request.
   ============================================================ */
const CONFINA_ANOS = [
  { key: '2022', tipo: 'Realizado' }, { key: '2023', tipo: 'Realizado' },
  { key: '2024', tipo: 'Realizado' }, { key: '2025', tipo: 'Realizado' },
  { key: '2026', tipo: 'Projetado' }, { key: '2027', tipo: 'Projetado' }, { key: '2028', tipo: 'Projetado' },
];
const CONFINA_METRICAS = [
  { key: 'propria', label: 'Área Própria', unid: 'ha' },
  { key: 'arrendada', label: 'Área Arrendada', unid: 'ha' },
  { key: 'precoVendaUnit', label: 'Preço de Venda', unid: 'R$/@' },
  { key: 'pesoMedioAbate', label: 'Peso Médio Abate Carcaça', unid: 'cbç' },
  { key: 'machoVendidos', label: 'Macho Animais Vendidos', unid: 'cbç' },
  { key: 'femeaVendidos', label: 'Fêmea Animais Vendidos', unid: 'cbç' },
  { key: 'ganhoFemea', label: 'Ganho Médio Carcaça Fêmea', unid: 'gr/dia' },
  { key: 'ganhoMacho', label: 'Ganho Médio Carcaça Macho', unid: 'gr/dia' },
  { key: 'compraUnit', label: 'Compra', unid: 'R$/@' },
  { key: 'entrada', label: 'Entrada', unid: '@' },
  { key: 'custoOperacional', label: 'Custo Operacional @ Produção', unid: 'R$/@' },
  { key: 'custeioNutricional', label: 'Custeio Nutricional', unid: 'R$/@' },
  { key: 'periodoAlojamento', label: 'Período Alojamento', unid: 'dias' },
  { key: 'diariaTotal', label: 'Diária Total', unid: 'cbç/dia' },
  { key: 'producaoGanho', label: 'Produção (ganho)', unid: '@/cab' },
];
function emptyConfinaPlanilha() {
  const out = {};
  CONFINA_METRICAS.forEach(m => { out[m.key] = {}; CONFINA_ANOS.forEach(a => { out[m.key][a.key] = ''; }); });
  return out;
}
// mirrors the exact cell formulas from the original spreadsheet's "Confina" tab
function calcConfinaAno(p, anoKey) {
  const n = (m) => Number(p?.[m]?.[anoKey]) || 0;
  const areaTotal = n('propria') + n('arrendada');
  const totalAnimais = n('machoVendidos') + n('femeaVendidos');
  const ganhoConsolidado = (n('ganhoFemea') * n('ganhoMacho') > 0) ? (n('ganhoFemea') + n('ganhoMacho')) / 2 : (n('ganhoFemea') + n('ganhoMacho'));
  const precoVendaTotal = n('precoVendaUnit') * n('pesoMedioAbate') * totalAnimais;
  const precoCompraTotal = n('compraUnit') * n('entrada') * totalAnimais;
  const custoTotalArroba = n('custeioNutricional') + n('custoOperacional');
  const custoTotalCabeca = custoTotalArroba * n('producaoGanho');
  const custoTotalReais = custoTotalArroba * totalAnimais * n('producaoGanho');
  const receita = precoVendaTotal;
  const custoCompraBoi = precoCompraTotal;
  const resultadoBruto = receita - custoCompraBoi;
  const custoProducao = custoTotalReais;
  const resultadoOperacional = resultadoBruto - custoProducao;
  const margemLiquida = receita !== 0 ? resultadoOperacional / receita : null;
  return { areaTotal, totalAnimais, ganhoConsolidado, custoTotalArroba, custoTotalCabeca, receita, custoCompraBoi, resultadoBruto, custoProducao, resultadoOperacional, margemLiquida };
}

/* ============================================================
   RELATÓRIO DE VISITA — replicates "RELATÓRIO DE VISITA -.xlsx".
   Ceres Confinamento only, per the partner's request.
   ============================================================ */
const VISITA_MOTIVOS = ['PROSPECÇÃO', 'MAJORAÇÃO DE LIMITE', 'ATUALIZAÇÃO'];
const VISITA_PRODUTOS = ['ANTECIPAÇÃO DE RECEBÍVEIS', 'CPR', 'CRA', 'CDCA', 'OUTRO'];
const VISITA_ROW_COUNT = 5;
function emptyVisitaRows(fields) { return Array.from({ length: VISITA_ROW_COUNT }, () => { const o = {}; fields.forEach(f => o[f] = ''); return o; }); }
function emptyVisitaRelatorio() {
  return {
    razaoSocial: '', cnpj: '', responsavel: '', motivoVisita: '', produtoVisita: '',
    limiteSugerido: '', devedoresSolidarios: '', garantia: '', desenhoOperacao: '',
    segmentos: emptyVisitaRows(['segmento', 'percentual', 'fornecedores']),
    culturas: emptyVisitaRows(['cultura', 'percentual', 'comentarios']),
    produtoresRurais: emptyVisitaRows(['culturas', 'totalHa', 'cidade']),
    resumoParecer: '',
  };
}

/* ============================================================
   FATURAMENTO MENSAL — replicates "Modelo de Faturamento.xlsx".
   Ceres Trading only, per the partner's request.
   ============================================================ */
const FATURAMENTO_MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const FATURAMENTO_MES_LABELS = { jan: 'JAN', fev: 'FEV', mar: 'MAR', abr: 'ABR', mai: 'MAI', jun: 'JUN', jul: 'JUL', ago: 'AGO', set: 'SET', out: 'OUT', nov: 'NOV', dez: 'DEZ' };
const FATURAMENTO_ANOS = ['2021', '2022', '2023', '2024', '2025'];
function emptyFaturamento() {
  const out = {};
  FATURAMENTO_MESES.forEach(m => { out[m] = {}; FATURAMENTO_ANOS.forEach(a => { out[m][a] = ''; }); });
  return out;
}
function calcFaturamentoAno(f, ano) {
  const total = FATURAMENTO_MESES.reduce((s, m) => s + (Number(f?.[m]?.[ano]) || 0), 0);
  return { total, media: total / 12 };
}
function calcFaturamentoVar(f, ano, anoAnterior) {
  const atual = calcFaturamentoAno(f, ano).total;
  const anterior = calcFaturamentoAno(f, anoAnterior).total;
  return anterior ? (atual - anterior) / anterior : null;
}

/* ============================================================
   ENDIVIDAMENTO E PATRIMÔNIO — replicates "Modelo endividamento e
   Patrimonio.xlsx" (abas Endiv. e Patrimônio: a debt schedule and a
   farm/property list; personal net worth per sócio/titular lives on
   the sócio object itself, see emptySocio/PatrimonioPessoalFields).
   Ceres Trading only, per the partner's request.
   ============================================================ */
const ENDIV_ANOS = ['2026', '2027', '2028', '2029', '2030', '2031', '2032', '2033', '2034', '2035'];
const ENDIV_ROW_COUNT = 5;
function emptyEndividamentoPatrimonio() {
  const dividaFields = ['tomador', 'banco', 'saldoDevedor', 'tipo', 'garantias', 'taxa', ...ENDIV_ANOS.map(a => 'y' + a)];
  const fazendaFields = ['nome', 'proprietario', 'cidadeUf', 'matricula', 'tipoPosse', 'areaTotal', 'areaPlantio', 'custoArrendamento'];
  const rows = (fields) => Array.from({ length: ENDIV_ROW_COUNT }, () => { const o = {}; fields.forEach(f => o[f] = ''); return o; });
  return { dividas: rows(dividaFields), fazendas: rows(fazendaFields) };
}
function calcPatrimonioTotais(ep) {
  const num = (v) => Number(v) || 0;
  return {
    areaTotal: ep.fazendas.reduce((s, f) => s + num(f.areaTotal), 0),
    areaPlantio: ep.fazendas.reduce((s, f) => s + num(f.areaPlantio), 0),
    saldoDevedorTotal: ep.dividas.reduce((s, d) => s + num(d.saldoDevedor), 0),
  };
}
// personal wealth fields (Bens e direitos PF, Dívida PF, atividade rural) live directly
// on a sócio (per sócio) or on the top-level draft (single PF titular)
const PATRIMONIO_PESSOAL_FIELDS = ['bensImoveis', 'bensAplicacoes', 'bensParticipacoes', 'bensOutros', 'dividaPF', 'areaExploracao', 'receitaRural', 'despesaRural', 'estoqueRebanho', 'dividaRural'];
function calcTotalBens(obj) {
  const num = (v) => Number(v) || 0;
  return num(obj.bensImoveis) + num(obj.bensAplicacoes) + num(obj.bensParticipacoes) + num(obj.bensOutros);
}

/* ============================================================
   COMMISSION ENGINE — Acordo de Parceria Comercial B2B GCI, Cláusula 3.
   The contract's 4 product categories don't map 1:1 onto the app's 5
   Tipo de Operação values (Confinamento, Crédito BTG Pactual and
   Consórcio aren't named in the contract at all, and AgroFinance's
   "Estruturada" subtipo could fall under 3.1.1 or 3.1.3) — so the
   gestor always picks the category explicitly; we only pre-select it
   for the one unambiguous case (Antecipação/Semi-Estruturada).
   ============================================================ */
function fmtBRL(n) {
  return (Number(n) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}
const COMMISSION_CATEGORIES = {
  antecipacao_semi: { label: 'Antecipação de Recebíveis / Semi-Estruturada (cláusula 3.1.1)' },
  estruturada: { label: 'Operação Estruturada — CRA/CRI/Debênture, Success Fee (cláusula 3.1.3)' },
  graos_insumos: { label: 'Comercialização de Grãos e Insumos (cláusula 3.1.2)' },
  nao_credito: { label: 'Operação Não-Crédito (cláusula 3.1.4)' },
};
const COMMISSION_GRAOS_RATES = { Soja: 0.0025, Milho: 0.005, Fertilizantes: 0.005 };

function calculateCommission(cd) {
  const num = (v) => Number(v) || 0;
  if (cd.category === 'antecipacao_semi') {
    const base = (num(cd.valorOperado) / 1000000) * 1000;
    const bonusElegivel = !!cd.ativacaoNovoCliente && num(cd.valorOperado) >= 500000 && num(cd.prazoMeses) >= 6;
    const bonus = bonusElegivel ? 3000 : 0;
    return { total: base + bonus, base, bonus, bonusElegivel, parcela1: base / 2, parcela2: base / 2 };
  }
  if (cd.category === 'graos_insumos') {
    const rate = COMMISSION_GRAOS_RATES[cd.produto] || 0;
    return { total: num(cd.vop) * rate, rate };
  }
  if (cd.category === 'estruturada') {
    const pct = Math.min(40, Math.max(0, num(cd.percentualParceiro)));
    return { total: num(cd.successFee) * (pct / 100), pct };
  }
  if (cd.category === 'nao_credito') {
    return { total: num(cd.receitaLiquida) * 0.30 };
  }
  return { total: 0 };
}
// true when no OTHER approved request in the system shares this client's
// CPF/CNPJ — a reasonable data-driven default for the "novo cliente" bonus
// eligibility, which the gestor can still override by hand.
function suggestNovoCliente(r) {
  const doc = r?.form?.documento;
  if (!doc) return false;
  return !db.requests.some(x => x.id !== r.id && x.form?.documento === doc && x.status === 'aprovado');
}
function initCommissionDraft(r) {
  if (r?.commission) return { ...r.commission };
  const suggestedCategory = (r?.operation === 'CERES AGROBANK' && ['Antecipação de Recebíveis', 'Semi-Estruturada'].includes(r?.form?.agroSubtipo))
    ? 'antecipacao_semi'
    : r?.operation === 'CERES TRADING' ? 'graos_insumos' : '';
  return {
    category: suggestedCategory,
    valorOperado: '', ativacaoNovoCliente: suggestNovoCliente(r), prazoMeses: '',
    produto: 'Soja', vop: '',
    successFee: '', percentualParceiro: '',
    receitaLiquida: '',
    parcela1Paga: false, parcela2Paga: false, notaFiscalRecebida: false, aceiteEmitido: false,
  };
}

/* ---------------- live data cache (populated by Firestore listeners) ---------------- */
let db = { partners: [], requests: [], errors: [] };
let listeners = [];
// distinguishes "still waiting on the first snapshot" from "snapshot arrived,
// there's just no partners/{uid} doc" — without this the partner screen can't
// tell a transient load from a genuinely missing profile (e.g. one created by
// hand in the console with the wrong document ID) and shows a spinner forever.
let partnerProfileLoaded = false;
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
    admin: { tab: 'parceiros', search: '', statusFilter: 'all', drill: null, commissionDraft: null },
    partner: { screen: 'dashboard', requestId: null, search: '', filterOpen: false, statusFilter: 'all', operationFilter: 'all', editDraft: null, editDraftId: null },
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

// e-mails the partner's registered address whenever the gestor moves their
// request to a new status; silently does nothing until EmailJS is configured
// in firebase-init.js, so the rest of the admin flow never depends on it.
async function notifyPartnerStatusChange(r, newStatus, feedback) {
  if (!EMAILJS_PUBLIC_KEY || !window.emailjs) return;
  const partner = db.partners.find(p => p.id === r.partnerId);
  const toEmail = partner?.email;
  if (!toEmail) return;
  try {
    await emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, {
      to_email: toEmail,
      to_name: partner.name || r.form?.nome || 'Parceiro',
      operation_label: OPERATIONS[r.operation]?.label || r.operation,
      status_label: STATUS_META[newStatus]?.label || newStatus,
      feedback_text: feedback || '',
      request_id: r.id,
    });
  } catch (e) {
    toast('Status salvo, mas o e-mail de notificação falhou: ' + (e.text || e.message || 'erro desconhecido'));
  }
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
  if (!draft.operation) return false;

  if (draft.operation === 'IMPULSA') {
    if (draft.impulsaModelo === 'individual') {
      return !!(draft.nome && draft.documento && isValidDocumento(draft.documento) && draft.impulsaVolume && Number(draft.impulsaVolume) > 0);
    }
    if (draft.impulsaModelo === 'lote') {
      return draft.impulsaLoteRows.length > 0 && draft.impulsaLoteRows.every(isImpulsaRowValid);
    }
    return false;
  }

  if (!draft.nome || !draft.documento || !draft.telefone || !draft.email) return false;
  if (draft.operation === 'CERES AGROBANK' && !draft.agroSubtipo) return false;

  if (COVERED_OPERATIONS.includes(draft.operation)) {
    if (!draft.tipoPessoa || !isValidDocumentoForTipo(draft.documento, draft.tipoPessoa)) return false;
    const profileKey = resolveProfile(draft);
    return !!profileKey && isChecklistComplete(draft, CHECKLISTS[profileKey]);
  }

  const type = personType(draft.documento);
  if (!type || !isValidDocumento(draft.documento)) return false;
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
      if (!em || !em.nome || !em.cpf || !isValidCPF(em.cpf)) return false;
      if (!emitenteDocs(em).every(d => em.docs[d.key])) return false;
    }
  } else {
    if (!draft.subtipoOperacao || !draft.numeroSocios) return false;
  }
  return true;
}
function buildDocumentsFromDraft(draft) {
  const profileKey = resolveProfile(draft);
  if (profileKey) return buildChecklistDocuments(draft, CHECKLISTS[profileKey]);

  if (draft.operation === 'IMPULSA') {
    const out = [];
    (draft.extraDocs || []).forEach((f, i) => out.push({ key: 'extra_' + i, label: `Documento adicional: ${f.name}`, status: 'enviado', fileName: f.name, storagePath: f.path }));
    return out;
  }

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
  partnerProfileLoaded = false;
  listeners.push(fbDb.collection('partners').doc(uid).onSnapshot(doc => {
    db.partners = doc.exists ? [{ id: doc.id, ...doc.data() }] : [];
    partnerProfileLoaded = true;
    render();
  }, err => {
    partnerProfileLoaded = true;
    toast('Não foi possível carregar seu cadastro: ' + err.message);
    render();
  }));
  listeners.push(fbDb.collection('requests').where('partnerId', '==', uid).onSnapshot(snap => {
    db.requests = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
    render();
  }, err => toast('Não foi possível carregar suas solicitações: ' + err.message)));
  listeners.push(fbDb.collection('errors').where('partnerId', '==', uid).onSnapshot(snap => {
    db.errors = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    render();
  }, err => toast('Não foi possível carregar seus relatos: ' + err.message)));
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
  // "Início do Relacionamento" / "Última Atualização" reflect real activity — the
  // first and most recent solicitação — rather than the partner record's own
  // relationshipStart/lastUpdate, which only change when the cadastro itself is
  // edited and otherwise sit frozen at signup time even as requests come and go.
  const reqTimestamps = (field) => reqs.map(r => r[field]?.toMillis?.()).filter(ms => typeof ms === 'number');
  const createdTimestamps = reqTimestamps('createdAt');
  const updatedTimestamps = reqTimestamps('updatedAt');
  const relationshipStart = createdTimestamps.length ? new Date(Math.min(...createdTimestamps)) : p.relationshipStart;
  const lastUpdate = updatedTimestamps.length ? new Date(Math.max(...updatedTimestamps)) : p.lastUpdate;
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
          <div class="subsection" style="padding:12px 16px;"><div class="eyebrow">Início do Relacionamento</div><div>📅 ${fmtDate(relationshipStart)}</div></div>
          <div class="subsection" style="padding:12px 16px;"><div class="eyebrow">Última Atualização</div><div>🕒 ${fmtDate(lastUpdate)}</div></div>
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

  // Once a request is approved it's a closed record; before that, the partner
  // can fix their own mistakes (typo'd CPF, wrong value, swap a rejected file)
  // in place instead of opening a brand-new solicitação.
  const editable = mode === 'partner' && r.status !== 'aprovado';
  const ed = editable ? ensurePartnerEditDraft(r) : f;
  const efield = (label, field, opts = {}) => {
    const raw = ed[field];
    if (editable) {
      return `<div class="field"><label>${label}</label><input type="text" ${opts.inputmode ? `inputmode="${opts.inputmode}"` : ''} value="${esc(raw ?? '')}" data-action="partner-edit-field" data-field="${field}"></div>`;
    }
    return `<div class="field"><label>${label}</label><input type="text" value="${esc(raw || (opts.fallback ?? 'N/A'))}" disabled></div>`;
  };
  const etextarea = (label, field) => {
    const raw = ed[field];
    if (editable) {
      return `<div class="field"><label>${label}</label><textarea data-action="partner-edit-field" data-field="${field}">${esc(raw ?? '')}</textarea></div>`;
    }
    return `<div class="field"><label>${label}</label><textarea disabled>${esc(raw || 'N/A')}</textarea></div>`;
  };

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
      ${f.agroSubtipo ? `<div class="mono" style="color:var(--muted);font-size:12px;margin-top:-10px;margin-bottom:14px;">${esc(f.agroSubtipo)}</div>` : ''}
      <div class="client-name serif">${esc((editable ? ed.nome : f.nome) || '—')}</div>
      <div class="client-doc">${esc((editable ? ed.documento : f.documento) || '—')}</div>
    </div>

    ${editable ? `
      <div class="feedback-banner" style="background:var(--primary-soft, #1c2b28);">
        <b>Editar Solicitação</b>Encontrou um dado errado ou quer atualizar uma informação? Corrija os campos abaixo e clique em "Salvar Alterações".
      </div>
      <div style="display:flex;justify-content:flex-end;margin-bottom:14px;">
        <button class="btn btn-primary" data-action="save-request-edit" data-id="${r.id}">💾 Salvar Alterações</button>
      </div>
    ` : ''}

    <div class="info-block">
      <div class="form-grid-2">
        ${efield('Nome / Razão Social', 'nome', { fallback: '' })}
        ${efield('CPF ou CNPJ', 'documento', { fallback: '' })}
      </div>
      <div class="form-grid-2">
        ${efield('Telefone', 'telefone', { fallback: '' })}
        ${efield('E-mail', 'email', { fallback: '' })}
      </div>
      ${efield('Informações Adicionais (Parceiro)', 'obs')}
      ${f.operation === 'IMPULSA' ? `
        <div class="form-grid-2">
          <div class="field"><label>Modelo</label><input type="text" value="${f.impulsaModelo === 'lote' ? 'Em Lote' : 'Individual'}" disabled></div>
          ${efield(`Volume (limitado a ${fmtBRL(IMPULSA_VOLUME_LIMIT)})`, 'impulsaVolume', { inputmode: 'decimal' })}
        </div>
        ${f.impulsaVolumeOriginal ? `
          <div class="feedback-banner"><b>Atenção</b>O parceiro solicitou originalmente ${fmtBRL(f.impulsaVolumeOriginal)} — valor acima do teto do Impulsiona. Oriente-o a abrir uma solicitação manual com a documentação completa para o volume real.</div>
        ` : ''}
        ${etextarea('Histórico Comercial', 'impulsaHistorico')}
      ` : (f.tipoPessoa || personType(f.documento)) === 'PJ' ? `
        <div class="form-grid-2">
          ${efield('Subtipo de Operação', 'subtipoOperacao')}
          <div class="field"><label>Número de Sócios</label><input type="text" value="${esc(f.numeroSocios || 'N/A')}" disabled></div>
        </div>
        <div class="form-grid-2">
          ${efield('Possui Procurador?', 'possuiProcurador')}
          ${efield('Informações do Procurador', 'infoProcurador')}
        </div>
      ` : `
        <div class="form-grid-2">
          ${efield('Profissão', 'profissao')}
          ${efield('Possui ICP para assinatura?', 'icp')}
        </div>
        <div class="form-grid-2">
          ${efield('Estado Civil', 'estadoCivil')}
          ${efield('Possui Avalista?', 'possuiAvalista')}
        </div>
      `}
      ${f.enderecoInstitucional ? `
        <div class="form-grid-2">
          ${efield('Endereço Institucional', 'enderecoInstitucional')}
        </div>
      ` : ''}
      ${f.enderecoFazenda || f.dadosBancarios ? `
        <div class="form-grid-2">
          ${efield('Endereço da Fazenda', 'enderecoFazenda')}
          ${efield('Dados Bancários', 'dadosBancarios')}
        </div>
      ` : ''}
      ${f.nacionalidade ? `
        <div class="form-grid-2">
          ${efield('Nacionalidade', 'nacionalidade')}
        </div>
      ` : ''}
      ${f.temConjugeAvalista ? `
        <div class="form-grid-2">
          ${efield('Possui Cônjuge/Avalista?', 'temConjugeAvalista')}
          ${efield('Profissão do Cônjuge/Avalista', 'conjugeProfissao')}
        </div>
      ` : ''}
    </div>
    ${f.confinaPlanilha ? ConfinaPlanilhaSection(f.confinaPlanilha, true) : ''}
    ${f.visitaRelatorio ? VisitaRelatorioSection(f.visitaRelatorio, true) : ''}
    ${f.faturamento ? FaturamentoSection(f.faturamento, true) : ''}
    ${f.endividamentoPatrimonio ? EndividamentoPatrimonioSection(f.endividamentoPatrimonio, true) : ''}

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

    ${mode === 'partner' && r.commission ? `
      <div class="subsection" style="margin-top:22px;">
        <div class="eyebrow">Sua Comissão Nesta Operação</div>
        <div style="font-size:22px;font-weight:800;margin:6px 0;">${fmtBRL(calculateCommission(r.commission).total)}</div>
        <div style="font-size:12.5px;color:var(--muted);">${COMMISSION_CATEGORIES[r.commission.category]?.label || ''}</div>
      </div>
    ` : ''}

    ${mode === 'admin' ? CommissionPanel(r) : ''}
    ${mode === 'admin' ? AdminControlPanel(r) : ''}
    ${mode === 'partner' ? `
      <div style="text-align:center;margin-top:28px;">
        <button class="btn-danger-text" data-action="delete-request" data-id="${r.id}">🗑 Excluir esta solicitação</button>
      </div>
    ` : ''}
  `;
}

function CommissionPanel(r) {
  const cd = ui.admin.commissionDraft || initCommissionDraft(r);
  const result = calculateCommission(cd);
  const alreadySaved = !!r.commission;

  const categoryFields = {
    antecipacao_semi: `
      <div class="form-grid-2">
        <div class="field"><label>Valor Efetivamente Operado (R$)</label><input type="text" inputmode="decimal" value="${esc(cd.valorOperado)}" data-action="commission-field" data-field="valorOperado"></div>
        <div class="field"><label>Prazo da Operação (meses)</label><input type="text" inputmode="numeric" value="${esc(cd.prazoMeses)}" data-action="commission-field" data-field="prazoMeses"></div>
      </div>
      <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;margin:4px 0 14px;">
        <input type="checkbox" data-action="commission-checkbox" data-field="ativacaoNovoCliente" ${cd.ativacaoNovoCliente ? 'checked' : ''}>
        Cliente novo (nunca operou com a Ceres) — elegível ao bônus de ativação de R$ 3.000,00 se valor ≥ R$ 500.000 e prazo ≥ 6 meses
      </label>
    `,
    graos_insumos: `
      <div class="form-grid-2">
        <div class="field"><label>Produto</label>
          <select data-action="commission-field" data-field="produto">
            ${Object.keys(COMMISSION_GRAOS_RATES).map(p => `<option ${cd.produto === p ? 'selected' : ''}>${p} (${(COMMISSION_GRAOS_RATES[p] * 100).toFixed(2)}% sobre VOP)</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>VOP — Volume da Operação (R$)</label><input type="text" inputmode="decimal" value="${esc(cd.vop)}" data-action="commission-field" data-field="vop"></div>
      </div>
    `,
    estruturada: `
      <div class="form-grid-2">
        <div class="field"><label>Success Fee recebido pela Ceres, líquido de impostos (R$)</label><input type="text" inputmode="decimal" value="${esc(cd.successFee)}" data-action="commission-field" data-field="successFee"></div>
        <div class="field"><label>% acordado com o Parceiro (até 40%)</label><input type="text" inputmode="decimal" value="${esc(cd.percentualParceiro)}" data-action="commission-field" data-field="percentualParceiro"></div>
      </div>
    `,
    nao_credito: `
      <div class="field"><label>Receita Líquida auferida pela Ceres (R$)</label><input type="text" inputmode="decimal" value="${esc(cd.receitaLiquida)}" data-action="commission-field" data-field="receitaLiquida"></div>
    `,
  };

  return `
    <div class="admin-panel" style="background:var(--surface);color:var(--ink);border:1px solid var(--border-c);">
      <div class="section-label">💰 Comissão do Parceiro ${alreadySaved ? '<span class="badge sent" style="margin-left:8px;">Calculada</span>' : ''}</div>
      <div class="field"><label>Categoria (Acordo de Parceria Comercial, Cláusula 3)</label>
        <select data-action="commission-field" data-field="category">
          <option value="">Selecione a categoria...</option>
          ${Object.keys(COMMISSION_CATEGORIES).map(k => `<option value="${k}" ${cd.category === k ? 'selected' : ''}>${COMMISSION_CATEGORIES[k].label}</option>`).join('')}
        </select>
      </div>
      ${cd.category ? categoryFields[cd.category] || '' : ''}
      ${cd.category ? `
        <div class="subsection" style="margin-top:4px;">
          <div class="eyebrow">Comissão Calculada</div>
          <div style="font-size:22px;font-weight:800;margin:4px 0;">${fmtBRL(result.total)}</div>
          ${cd.category === 'antecipacao_semi' ? `
            <div style="font-size:13px;color:var(--muted);">Base: ${fmtBRL(result.base)} · 50% no desembolso (${fmtBRL(result.parcela1)}) + 50% ao final (${fmtBRL(result.parcela2)})</div>
            ${result.bonusElegivel ? `<div style="font-size:13px;color:var(--green);margin-top:4px;">+ Bônus de ativação: ${fmtBRL(result.bonus)}</div>` : ''}
          ` : ''}
        </div>
        <div class="form-grid-2" style="margin-top:14px;">
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;"><input type="checkbox" data-action="commission-checkbox" data-field="notaFiscalRecebida" ${cd.notaFiscalRecebida ? 'checked' : ''}> Nota Fiscal recebida</label>
          <label style="display:flex;align-items:center;gap:8px;font-size:13px;"><input type="checkbox" data-action="commission-checkbox" data-field="aceiteEmitido" ${cd.aceiteEmitido ? 'checked' : ''}> Aceite emitido (cláusula 3.6)</label>
          ${cd.category === 'antecipacao_semi' ? `
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;"><input type="checkbox" data-action="commission-checkbox" data-field="parcela1Paga" ${cd.parcela1Paga ? 'checked' : ''}> 1ª parcela paga (desembolso)</label>
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;"><input type="checkbox" data-action="commission-checkbox" data-field="parcela2Paga" ${cd.parcela2Paga ? 'checked' : ''}> 2ª parcela paga (final)</label>
          ` : `
            <label style="display:flex;align-items:center;gap:8px;font-size:13px;"><input type="checkbox" data-action="commission-checkbox" data-field="parcela1Paga" ${cd.parcela1Paga ? 'checked' : ''}> Comissão paga</label>
          `}
        </div>
        <button class="btn btn-primary btn-block" style="margin-top:14px;" data-action="save-commission" data-id="${r.id}">💾 Salvar Comissão</button>
      ` : ''}
    </div>
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
  if (!partner) {
    const msg = partnerProfileLoaded
      ? 'Não encontramos um cadastro vinculado a esta conta. Se você acabou de se cadastrar, aguarde alguns segundos e recarregue a página. Se o problema continuar, entre em contato com o suporte.'
      : 'Carregando seu cadastro…';
    return `<div class="role-screen"><div class="box"><p class="lede">${esc(msg)}</p></div></div>`;
  }
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

function ConfinaPlanilhaSection(p, readonly) {
  const cell = (metricKey, anoKey) => readonly
    ? esc(p[metricKey]?.[anoKey] || '—')
    : `<input type="text" inputmode="decimal" value="${esc(p[metricKey][anoKey])}" data-action="confina-planilha-field" data-metric="${metricKey}" data-ano="${anoKey}" style="width:88px;padding:6px;font-size:12px;">`;
  const computedRow = (label, unid, getVal, fmt) => `
    <tr>
      <td style="padding:6px;font-weight:700;">${esc(label)}</td>
      <td style="padding:6px;color:var(--muted);font-size:11px;">${unid}</td>
      ${CONFINA_ANOS.map(a => `<td style="padding:6px;text-align:right;font-weight:700;white-space:nowrap;">${fmt(getVal(a.key))}</td>`).join('')}
    </tr>
  `;
  const n0 = (v) => (v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  const pct = (v) => v === null ? '—' : (v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
  return `
    <div class="section-divider"></div>
    <div class="section-label">Planilha Produtor Agrícola/Confina (modelo Ceres)</div>
    ${readonly ? '' : '<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Preencha ao menos um ano completo (histórico ou projetado). Os totais são calculados automaticamente.</div>'}
    <div style="overflow-x:auto;">
      <table style="border-collapse:collapse;width:100%;font-size:12.5px;min-width:760px;">
        <thead>
          <tr>
            <th style="text-align:left;padding:6px;">Métrica</th>
            <th style="padding:6px;">Unid.</th>
            ${CONFINA_ANOS.map(a => `<th style="padding:6px;white-space:nowrap;">${a.key}<br><span style="font-weight:500;color:var(--muted);font-size:10px;">${a.tipo}</span></th>`).join('')}
          </tr>
        </thead>
        <tbody>
          ${CONFINA_METRICAS.map(m => `
            <tr>
              <td style="padding:6px;">${esc(m.label)}</td>
              <td style="padding:6px;color:var(--muted);font-size:11px;">${m.unid}</td>
              ${CONFINA_ANOS.map(a => `<td style="padding:4px;">${cell(m.key, a.key)}</td>`).join('')}
            </tr>
          `).join('')}
          ${computedRow('Área Total', 'ha', k => calcConfinaAno(p, k).areaTotal, n0)}
          ${computedRow('Total Animais Vendidos', 'cbç', k => calcConfinaAno(p, k).totalAnimais, n0)}
          ${computedRow('Ganho Médio Consolidado', 'gr/dia', k => calcConfinaAno(p, k).ganhoConsolidado, n0)}
          ${computedRow('Receita (Venda)', 'R$', k => calcConfinaAno(p, k).receita, fmtBRL)}
          ${computedRow('Custo (Compra Boi)', 'R$', k => calcConfinaAno(p, k).custoCompraBoi, fmtBRL)}
          ${computedRow('Resultado Bruto', 'R$', k => calcConfinaAno(p, k).resultadoBruto, fmtBRL)}
          ${computedRow('Custo de Produção', 'R$', k => calcConfinaAno(p, k).custoProducao, fmtBRL)}
          ${computedRow('Resultado Operacional', 'R$', k => calcConfinaAno(p, k).resultadoOperacional, fmtBRL)}
          ${computedRow('Margem Líquida', '%', k => calcConfinaAno(p, k).margemLiquida, pct)}
        </tbody>
      </table>
    </div>
  `;
}

function VisitaRelatorioSection(v, readonly) {
  const inp = (field, type = 'text') => readonly
    ? esc(v[field] || '—')
    : `<input type="text" ${type === 'number' ? 'inputmode="decimal"' : ''} value="${esc(v[field])}" data-action="visita-field" data-field="${field}">`;
  const sel = (field, options) => readonly
    ? esc(v[field] || '—')
    : `<select data-action="visita-field" data-field="${field}"><option value="">Selecione...</option>${options.map(o => `<option ${v[field] === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
  const rowTable = (title, cols, tableKey, rows) => `
    <div class="section-label" style="margin-top:16px;">${title}</div>
    <div style="overflow-x:auto;">
      <table style="border-collapse:collapse;width:100%;font-size:12.5px;margin-bottom:10px;">
        <thead><tr>${cols.map(c => `<th style="text-align:left;padding:6px;">${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>
          ${rows.map((row, i) => `
            <tr>
              ${cols.map(c => `<td style="padding:4px;">${readonly ? esc(row[c.key] || '—') : `<input type="text" ${c.type === 'number' ? 'inputmode="decimal"' : ''} value="${esc(row[c.key])}" data-action="visita-row-field" data-table="${tableKey}" data-idx="${i}" data-field="${c.key}" style="width:100%;padding:6px;font-size:12px;">`}</td>`).join('')}
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
  return `
    <div class="section-divider"></div>
    <div class="section-label">Relatório de Visita</div>
    <div class="form-grid-2">
      <div class="field"><label>Razão Social</label>${readonly ? `<input type="text" value="${esc(v.razaoSocial)}" disabled>` : inp('razaoSocial')}</div>
      <div class="field"><label>CNPJ</label>${readonly ? `<input type="text" value="${esc(v.cnpj)}" disabled>` : inp('cnpj')}</div>
    </div>
    <div class="form-grid-2">
      <div class="field"><label>Responsável pela Empresa</label>${readonly ? `<input type="text" value="${esc(v.responsavel)}" disabled>` : inp('responsavel')}</div>
      <div class="field"><label>Motivo da Visita</label>${readonly ? `<input type="text" value="${esc(v.motivoVisita)}" disabled>` : sel('motivoVisita', VISITA_MOTIVOS)}</div>
    </div>
    <div class="form-grid-2">
      <div class="field"><label>Limite Sugerido (R$)</label>${readonly ? `<input type="text" value="${esc(v.limiteSugerido)}" disabled>` : inp('limiteSugerido', 'number')}</div>
      <div class="field"><label>Produto</label>${readonly ? `<input type="text" value="${esc(v.produtoVisita)}" disabled>` : sel('produtoVisita', VISITA_PRODUTOS)}</div>
    </div>
    <div class="form-grid-2">
      <div class="field"><label>Devedores Solidários (aval)</label>${readonly ? `<input type="text" value="${esc(v.devedoresSolidarios)}" disabled>` : inp('devedoresSolidarios')}</div>
      <div class="field"><label>Garantia</label>${readonly ? `<input type="text" value="${esc(v.garantia)}" disabled>` : inp('garantia')}</div>
    </div>
    <div class="field"><label>Desenho da Operação</label>${readonly ? `<textarea disabled>${esc(v.desenhoOperacao)}</textarea>` : `<textarea data-action="visita-field" data-field="desenhoOperacao">${esc(v.desenhoOperacao)}</textarea>`}</div>

    ${rowTable('1. Segmentação de Negócios', [{ key: 'segmento', label: 'Segmento' }, { key: 'percentual', label: '%', type: 'number' }, { key: 'fornecedores', label: 'Fornecedores' }], 'segmentos', v.segmentos)}
    ${rowTable('2. Culturas Atendidas', [{ key: 'cultura', label: 'Cultura' }, { key: 'percentual', label: '%', type: 'number' }, { key: 'comentarios', label: 'Comentários' }], 'culturas', v.culturas)}
    ${rowTable('3. Sócios Produtores Rurais (culturas, hectares e local)', [{ key: 'culturas', label: 'Principais Culturas' }, { key: 'totalHa', label: 'Total (ha)', type: 'number' }, { key: 'cidade', label: 'Cidade' }], 'produtoresRurais', v.produtoresRurais)}

    <div class="field"><label>5. Resumo sobre a Empresa/Sócios e Parecer</label>${readonly ? `<textarea disabled>${esc(v.resumoParecer)}</textarea>` : `<textarea data-action="visita-field" data-field="resumoParecer">${esc(v.resumoParecer)}</textarea>`}</div>
  `;
}

function FaturamentoSection(f, readonly) {
  const cell = (mes, ano) => readonly
    ? esc(f[mes]?.[ano] || '—')
    : `<input type="text" inputmode="decimal" value="${esc(f[mes][ano])}" data-action="faturamento-field" data-metric="${mes}" data-ano="${ano}" style="width:88px;padding:6px;font-size:12px;">`;
  const pct = (v) => v === null ? '—' : (v * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + '%';
  return `
    <div class="section-divider"></div>
    <div class="section-label">Faturamento Mensal</div>
    ${readonly ? '' : '<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Preencha ao menos um ano completo. Total, média e variação são calculados automaticamente.</div>'}
    <div style="overflow-x:auto;">
      <table style="border-collapse:collapse;width:100%;font-size:12.5px;min-width:560px;">
        <thead><tr><th style="text-align:left;padding:6px;">Mês</th>${FATURAMENTO_ANOS.map(a => `<th style="padding:6px;">${a}</th>`).join('')}</tr></thead>
        <tbody>
          ${FATURAMENTO_MESES.map(m => `<tr><td style="padding:6px;">${FATURAMENTO_MES_LABELS[m]}</td>${FATURAMENTO_ANOS.map(a => `<td style="padding:4px;">${cell(m, a)}</td>`).join('')}</tr>`).join('')}
          <tr><td style="padding:6px;font-weight:700;">TOTAL</td>${FATURAMENTO_ANOS.map(a => `<td style="padding:6px;text-align:right;font-weight:700;">${fmtBRL(calcFaturamentoAno(f, a).total)}</td>`).join('')}</tr>
          <tr><td style="padding:6px;font-weight:700;">MÉDIA</td>${FATURAMENTO_ANOS.map(a => `<td style="padding:6px;text-align:right;font-weight:700;">${fmtBRL(calcFaturamentoAno(f, a).media)}</td>`).join('')}</tr>
          <tr><td style="padding:6px;font-weight:700;">VAR. % vs ano anterior</td>${FATURAMENTO_ANOS.map((a, i) => `<td style="padding:6px;text-align:right;font-weight:700;">${i === 0 ? '—' : pct(calcFaturamentoVar(f, a, FATURAMENTO_ANOS[i - 1]))}</td>`).join('')}</tr>
        </tbody>
      </table>
    </div>
  `;
}

function EndividamentoPatrimonioSection(ep, readonly) {
  const rowInput = (table, i, field, type = 'text') => readonly
    ? esc(ep[table][i][field] || '—')
    : `<input type="text" ${type === 'number' ? 'inputmode="decimal"' : ''} value="${esc(ep[table][i][field])}" data-action="endiv-row-field" data-table="${table}" data-idx="${i}" data-field="${field}" style="width:100%;padding:6px;font-size:12px;">`;
  const totals = calcPatrimonioTotais(ep);
  const n2 = (v) => (v || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  return `
    <div class="section-divider"></div>
    <div class="section-label">Endividamento</div>
    ${readonly ? '' : '<div style="font-size:12px;color:var(--muted);margin-bottom:10px;">Uma linha por dívida/financiamento em aberto (deixe em branco se não houver).</div>'}
    <div style="overflow-x:auto;">
      <table style="border-collapse:collapse;width:100%;font-size:12px;min-width:1100px;">
        <thead><tr>
          <th style="padding:6px;text-align:left;">Tomador</th><th style="padding:6px;text-align:left;">Banco</th>
          <th style="padding:6px;">Saldo Devedor</th><th style="padding:6px;">Tipo</th><th style="padding:6px;">Garantias</th><th style="padding:6px;">Taxa</th>
          ${ENDIV_ANOS.map(a => `<th style="padding:6px;">${a}</th>`).join('')}
        </tr></thead>
        <tbody>
          ${ep.dividas.map((d, i) => `
            <tr>
              <td style="padding:4px;">${rowInput('dividas', i, 'tomador')}</td>
              <td style="padding:4px;">${rowInput('dividas', i, 'banco')}</td>
              <td style="padding:4px;">${rowInput('dividas', i, 'saldoDevedor', 'number')}</td>
              <td style="padding:4px;">${rowInput('dividas', i, 'tipo')}</td>
              <td style="padding:4px;">${rowInput('dividas', i, 'garantias')}</td>
              <td style="padding:4px;">${rowInput('dividas', i, 'taxa')}</td>
              ${ENDIV_ANOS.map(a => `<td style="padding:4px;">${rowInput('dividas', i, 'y' + a, 'number')}</td>`).join('')}
            </tr>
          `).join('')}
          <tr><td colspan="2" style="padding:6px;font-weight:700;">Total Saldo Devedor</td><td style="padding:6px;font-weight:700;">${fmtBRL(totals.saldoDevedorTotal)}</td><td colspan="${4 + ENDIV_ANOS.length}"></td></tr>
        </tbody>
      </table>
    </div>

    <div class="section-label" style="margin-top:18px;">Patrimônio — Fazendas/Imóveis</div>
    <div style="overflow-x:auto;">
      <table style="border-collapse:collapse;width:100%;font-size:12.5px;">
        <thead><tr>
          <th style="padding:6px;text-align:left;">Nome da Fazenda</th><th style="padding:6px;text-align:left;">Proprietário</th>
          <th style="padding:6px;text-align:left;">Cidade/UF</th><th style="padding:6px;text-align:left;">Nº Matrícula</th>
          <th style="padding:6px;">Própria/Arrendada</th><th style="padding:6px;">Área Total (ha)</th>
          <th style="padding:6px;">Área de Plantio (ha)</th><th style="padding:6px;">Custo Arrendamento (R$)</th>
        </tr></thead>
        <tbody>
          ${ep.fazendas.map((p, i) => `
            <tr>
              <td style="padding:4px;">${rowInput('fazendas', i, 'nome')}</td>
              <td style="padding:4px;">${rowInput('fazendas', i, 'proprietario')}</td>
              <td style="padding:4px;">${rowInput('fazendas', i, 'cidadeUf')}</td>
              <td style="padding:4px;">${rowInput('fazendas', i, 'matricula')}</td>
              <td style="padding:4px;">${rowInput('fazendas', i, 'tipoPosse')}</td>
              <td style="padding:4px;">${rowInput('fazendas', i, 'areaTotal', 'number')}</td>
              <td style="padding:4px;">${rowInput('fazendas', i, 'areaPlantio', 'number')}</td>
              <td style="padding:4px;">${rowInput('fazendas', i, 'custoArrendamento', 'number')}</td>
            </tr>
          `).join('')}
          <tr><td colspan="5" style="padding:6px;font-weight:700;">Total</td><td style="padding:6px;font-weight:700;">${n2(totals.areaTotal)}</td><td style="padding:6px;font-weight:700;">${n2(totals.areaPlantio)}</td><td></td></tr>
        </tbody>
      </table>
    </div>
  `;
}

// shared personal-wealth block: works for a sócio (data-action="draft-socio-field" + idx)
// or the top-level draft for a lone PF titular (data-action="draft-field")
function PatrimonioPessoalFields(obj, actionAttrs, readonly) {
  const f = (field, label) => readonly
    ? `<div class="field"><label>${label}</label><input type="text" value="${esc(obj[field])}" disabled></div>`
    : `<div class="field"><label>${label}</label><input type="text" inputmode="decimal" value="${esc(obj[field])}" ${actionAttrs} data-field="${field}"></div>`;
  return `
    <div class="section-label" style="margin-top:14px;">Patrimônio Pessoal</div>
    <div class="form-grid-2">${f('bensImoveis', 'Imóveis e Terrenos (R$)')}${f('bensAplicacoes', 'Aplicações e Disponibilidades (R$)')}</div>
    <div class="form-grid-2">${f('bensParticipacoes', 'Participações em Empresas (R$)')}${f('bensOutros', 'Outros Bens (R$)')}</div>
    <div style="font-size:13px;font-weight:700;margin:6px 0 10px;">Total de Bens: ${fmtBRL(calcTotalBens(obj))}</div>
    <div class="form-grid-2">${f('dividaPF', 'Dívida Pessoa Física (R$)')}${f('areaExploracao', 'Área de Exploração (ha)')}</div>
    <div class="form-grid-2">${f('receitaRural', 'Receita Atividade Rural (R$)')}${f('despesaRural', 'Despesa Atividade Rural (R$)')}</div>
    <div class="form-grid-2">${f('estoqueRebanho', 'Estoque de Rebanho (R$)')}${f('dividaRural', 'Dívida Rural (R$)')}</div>
  `;
}

function ChecklistFormFields(draft, profile, uploadSlot) {
  let html = '<div class="section-divider"></div><div class="section-label">Dados Adicionais</div>';

  if (profile.fields.includes('enderecoInstitucional')) {
    html += `<div class="field"><label>Endereço Institucional da Empresa</label><input type="text" placeholder="Endereço completo" value="${esc(draft.enderecoInstitucional)}" data-action="draft-field" data-field="enderecoInstitucional"></div>`;
  }
  if (profile.fields.includes('icp')) {
    html += `
      <div class="form-grid-2">
        <div class="field"><label>Profissão</label><input type="text" value="${esc(draft.profissao)}" data-action="draft-field" data-field="profissao"></div>
        <div class="field"><label>Possui ICP para assinatura?</label>
          <select data-action="draft-field" data-field="icp">
            <option value="">Selecione...</option><option ${draft.icp === 'Sim' ? 'selected' : ''}>Sim</option><option ${draft.icp === 'Não' ? 'selected' : ''}>Não</option>
          </select>
        </div>
      </div>
    `;
  }
  if (profile.fields.includes('nacionalidade')) {
    html += `
      <div class="form-grid-2">
        <div class="field"><label>Nacionalidade</label><input type="text" value="${esc(draft.nacionalidade)}" data-action="draft-field" data-field="nacionalidade"></div>
        <div class="field"><label>Estado Civil</label>
          <select data-action="draft-field" data-field="estadoCivil">
            <option value="">Selecione...</option>
            ${['Solteiro(a)', 'Casado(a)', 'União Estável', 'Viúvo(a)'].map(o => `<option ${draft.estadoCivil === o ? 'selected' : ''}>${o}</option>`).join('')}
          </select>
        </div>
      </div>
    `;
  }
  if (profile.fields.includes('dadosBancarios')) {
    html += `<div class="field"><label>Dados Bancários</label><textarea placeholder="Banco, agência, conta, tipo de conta, PIX..." data-action="draft-field" data-field="dadosBancarios">${esc(draft.dadosBancarios)}</textarea></div>`;
  }
  if (profile.fields.includes('enderecoFazenda')) {
    html += `<div class="field"><label>Endereço Completo da Fazenda</label><input type="text" value="${esc(draft.enderecoFazenda)}" data-action="draft-field" data-field="enderecoFazenda"></div>`;
  }
  if (profile.hasPatrimonioPessoal) html += PatrimonioPessoalFields(draft, 'data-action="draft-field"', false);

  html += '<div class="section-divider"></div><div class="section-label">Anexar Documentos Obrigatórios</div>';
  html += profile.docs.map(d => uploadSlot(d.key, d.label + (d.optional ? ' (opcional)' : ''), draft.docs, '', draft.uploading[d.key])).join('');

  if (profile.hasConfinaPlanilha) html += ConfinaPlanilhaSection(draft.confinaPlanilha, false);
  if (profile.hasRelatorioVisita) html += VisitaRelatorioSection(draft.visitaRelatorio, false);
  if (profile.hasFaturamento) html += FaturamentoSection(draft.faturamento, false);
  if (profile.hasEndividamentoPatrimonio) html += EndividamentoPatrimonioSection(draft.endividamentoPatrimonio, false);

  if (profile.hasSocios) {
    html += `
      <div class="section-divider"></div>
      <div class="section-label">Sócios</div>
      <div class="field"><label>Número de Sócios <span class="req">*</span></label><input type="text" inputmode="numeric" value="${esc(draft.numeroSocios)}" data-action="draft-field" data-field="numeroSocios"></div>
      ${(draft.socios || []).map((s, i) => `
        <div class="subsection">
          <div class="section-label">Sócio ${i + 1}</div>
          <div class="field"><label>Nome</label><input type="text" value="${esc(s.nome)}" data-action="draft-socio-field" data-idx="${i}" data-field="nome"></div>
          <div class="form-grid-2">
            <div class="field"><label>CPF</label><input type="text" value="${esc(s.cpf)}" data-action="draft-socio-field" data-idx="${i}" data-field="cpf"></div>
            <div class="field"><label>Profissão</label><input type="text" value="${esc(s.profissao)}" data-action="draft-socio-field" data-idx="${i}" data-field="profissao"></div>
          </div>
          <div class="form-grid-2">
            <div class="field"><label>E-mail</label><input type="text" inputmode="email" value="${esc(s.email)}" data-action="draft-socio-field" data-idx="${i}" data-field="email"></div>
            <div class="field"><label>Telefone</label><input type="text" value="${esc(s.telefone)}" data-action="draft-socio-field" data-idx="${i}" data-field="telefone"></div>
          </div>
          ${profile.hasSocioExtra ? `
            <div class="form-grid-2">
              <div class="field"><label>Nacionalidade</label><input type="text" value="${esc(s.nacionalidade)}" data-action="draft-socio-field" data-idx="${i}" data-field="nacionalidade"></div>
              <div class="field"><label>Estado Civil</label>
                <select data-action="draft-socio-field" data-idx="${i}" data-field="estadoCivil">
                  <option value="">Selecione...</option>
                  ${['Solteiro(a)', 'Casado(a)', 'União Estável', 'Viúvo(a)'].map(o => `<option ${s.estadoCivil === o ? 'selected' : ''}>${o}</option>`).join('')}
                </select>
              </div>
            </div>
          ` : ''}
          <div class="section-label">Documentos do Sócio ${i + 1}</div>
          ${CK_SOCIO_DOCS.map(d => uploadSlot(d.key, d.label, s.docs, `data-group="socios" data-idx="${i}"`, (s.uploading || {})[d.key])).join('')}
          ${profile.hasSocioPatrimonio ? PatrimonioPessoalFields(s, `data-action="draft-socio-field" data-idx="${i}"`, false) : ''}
        </div>
      `).join('')}
    `;
  }

  if (profile.hasProcurador) {
    html += `
      <div class="section-divider"></div>
      <div class="field"><label>Possui Procurador?</label>
        <select data-action="draft-field" data-field="possuiProcurador">
          <option value="">Selecione...</option><option ${draft.possuiProcurador === 'Sim' ? 'selected' : ''}>Sim</option><option ${draft.possuiProcurador === 'Não' ? 'selected' : ''}>Não</option>
        </select>
      </div>
      ${draft.possuiProcurador === 'Sim' ? `
        <div class="field"><label>Informações do Procurador</label><textarea data-action="draft-field" data-field="infoProcurador">${esc(draft.infoProcurador)}</textarea></div>
        <div class="section-label">Documentos do Procurador</div>
        ${CK_PROCURADOR_DOCS.map(d => uploadSlot(d.key, d.label, draft.docs, '', draft.uploading[d.key])).join('')}
      ` : ''}
    `;
  }

  html += `
    <div class="section-divider"></div>
    <div class="field"><label>Sócio(s)/titular possui cônjuge ou avalista? <span class="req">*</span></label>
      <select data-action="draft-field" data-field="temConjugeAvalista">
        <option value="">Selecione...</option><option ${draft.temConjugeAvalista === 'Sim' ? 'selected' : ''}>Sim</option><option ${draft.temConjugeAvalista === 'Não' ? 'selected' : ''}>Não</option>
      </select>
    </div>
    ${draft.temConjugeAvalista === 'Sim' ? `
      <div class="section-label">Cônjuges e Avalistas</div>
      <div class="form-grid-2">
        <div class="field"><label>Profissão</label><input type="text" value="${esc(draft.conjugeProfissao)}" data-action="draft-field" data-field="conjugeProfissao"></div>
        <div class="field"><label>E-mail e telefone</label><input type="text" value="${esc(draft.conjugeContato)}" data-action="draft-field" data-field="conjugeContato"></div>
      </div>
      ${uploadSlot('conjuge_doc_pessoal', CK_DOCS.conjuge_doc_pessoal.label, draft.docs, '', draft.uploading['conjuge_doc_pessoal'])}
    ` : ''}
  `;

  if (profile.hasImovel) {
    html += `
      <div class="section-divider"></div>
      <div class="section-label">Imóvel (Fazenda)</div>
      ${CK_IMOVEL_DOCS.map(d => uploadSlot(d.key, d.label + (d.optional ? ' (opcional)' : ''), draft.docs, '', draft.uploading[d.key])).join('')}
      <div class="field"><label>A certidão é emitida em nome de Pessoa Física ou Jurídica? <span class="req">*</span></label>
        <select data-action="draft-field" data-field="certidaoPFPJ">
          <option value="">Selecione...</option><option ${draft.certidaoPFPJ === 'Pessoa Física' ? 'selected' : ''}>Pessoa Física</option><option ${draft.certidaoPFPJ === 'Pessoa Jurídica' ? 'selected' : ''}>Pessoa Jurídica</option>
        </select>
      </div>
      ${draft.certidaoPFPJ ? `
        <div class="field"><label>Número de Emitentes <span class="req">*</span></label><input type="text" inputmode="numeric" value="${esc(draft.numeroEmitentes)}" data-action="draft-field" data-field="numeroEmitentes"></div>
        ${(draft.emitentes || []).map((em, i) => `
          <div class="subsection">
            <div class="section-label">Emitente ${i + 1} (e seu cônjuge)</div>
            <div class="form-grid-2">
              <div class="field"><label>Nome do Emitente</label><input type="text" value="${esc(em.nome)}" data-action="draft-emitente-field" data-idx="${i}" data-field="nome"></div>
              <div class="field"><label>CPF do Emitente</label><input type="text" value="${esc(em.cpf)}" data-action="draft-emitente-field" data-idx="${i}" data-field="cpf"></div>
            </div>
            <div class="section-label">Documentos pessoais do Emitente ${i + 1}</div>
            ${uploadSlot('doc_pessoal', 'Documentos pessoais (CNH, RG ou CRNM)', em.docs, `data-group="emitentes" data-idx="${i}"`, (em.uploading || {}).doc_pessoal)}
          </div>
        `).join('')}
      ` : ''}
    `;
  }

  return html;
}

function ImpulsaFormFields(draft, uploadSlot) {
  let html = `
    <div class="section-divider"></div>
    <div class="section-label">Modelo da Solicitação</div>
    <div class="field">
      <div class="radio-row">
        <label><input type="radio" name="ns-impulsa-modelo" value="individual" data-action="draft-field" data-field="impulsaModelo" ${draft.impulsaModelo === 'individual' ? 'checked' : ''}> Individual</label>
        <label><input type="radio" name="ns-impulsa-modelo" value="lote" data-action="draft-field" data-field="impulsaModelo" ${draft.impulsaModelo === 'lote' ? 'checked' : ''}> Em Lote (planilha)</label>
      </div>
    </div>
  `;
  if (draft.impulsaModelo === 'individual') html += ImpulsaIndividualFields(draft, uploadSlot);
  else if (draft.impulsaModelo === 'lote') html += ImpulsaLoteFields(draft, uploadSlot);
  return html;
}

function ImpulsaIndividualFields(draft, uploadSlot) {
  const volume = Number(draft.impulsaVolume) || 0;
  const docDigits = (draft.documento || '').replace(/\D/g, '');
  const docInvalid = (docDigits.length === 11 || docDigits.length === 14) && !isValidDocumento(draft.documento);
  return `
    <div class="section-divider"></div>
    <div class="section-label">Dados do Cliente</div>
    <div class="field"><label>Nome do Cliente ou Razão Social</label><input type="text" value="${esc(draft.nome)}" data-action="draft-field" data-field="nome"></div>
    <div class="form-grid-2">
      <div class="field">
        <label>CPF ou CNPJ</label>
        <input type="text" placeholder="000.000.000-00 ou 00.000.000/0000-00" value="${esc(draft.documento)}" data-action="draft-field" data-field="documento">
        ${docInvalid ? '<div style="color:var(--red);font-size:11.5px;margin-top:6px;">CPF/CNPJ inválido — confira os números digitados.</div>' : ''}
      </div>
      <div class="field">
        <label>Volume Solicitado (R$)</label>
        <input type="text" inputmode="decimal" value="${esc(draft.impulsaVolume)}" data-action="draft-field" data-field="impulsaVolume">
        ${volume > IMPULSA_VOLUME_LIMIT ? `<div style="color:var(--orange);font-size:11.5px;margin-top:6px;">Valores acima de ${fmtBRL(IMPULSA_VOLUME_LIMIT)} são limitados automaticamente a esse teto no envio. Para volumes maiores, use o fluxo manual com documentação completa.</div>` : ''}
      </div>
    </div>
    <div class="field"><label>Histórico Comercial</label><textarea placeholder="Descreva o histórico comercial do cliente..." data-action="draft-field" data-field="impulsaHistorico">${esc(draft.impulsaHistorico)}</textarea></div>
    <div class="form-grid-2">
      <div class="field"><label>Telefone <span style="font-weight:500;text-transform:none;color:var(--muted);">(opcional)</span></label><input type="text" placeholder="(00) 00000-0000" value="${esc(draft.telefone)}" data-action="draft-field" data-field="telefone"></div>
      <div class="field"><label>E-mail <span style="font-weight:500;text-transform:none;color:var(--muted);">(opcional)</span></label><input type="text" inputmode="email" placeholder="email@exemplo.com" value="${esc(draft.email)}" data-action="draft-field" data-field="email"></div>
    </div>
  `;
}

function ImpulsaLoteFields(draft, uploadSlot) {
  const rows = draft.impulsaLoteRows || [];
  const invalidCount = rows.filter(r => !isImpulsaRowValid(r)).length;
  return `
    <div class="section-divider"></div>
    <div class="section-label">Upload da Planilha</div>
    <div style="font-size:12px;color:var(--muted);margin-bottom:10px;">
      Colunas esperadas: Nome, CPF/CNPJ, Volume Solicitado, Histórico Comercial (Telefone e E-mail são opcionais). Até ${IMPULSA_LOTE_ROW_LIMIT} linhas por planilha.
    </div>
    <div class="form-grid-2" style="align-items:start;">
      <label class="upload-slot ${draft.impulsaLoteFileName ? 'filled' : ''}" style="margin:0;">
        ${draft.impulsaLoteFileName ? '✅' : '📤'} <span class="name">${draft.impulsaLoteFileName ? esc(draft.impulsaLoteFileName) : 'Clique para selecionar a planilha (.xlsx)'}</span>
        <input type="file" accept=".xlsx,.xls" data-action="impulsa-lote-file">
      </label>
      <button type="button" class="btn btn-outline" style="margin:0;" data-action="impulsa-lote-template">⬇ Baixar Modelo de Planilha</button>
    </div>
    ${rows.length ? `
      <div class="section-divider"></div>
      <div class="section-label">Clientes na Planilha (${rows.length}) ${invalidCount ? `<span style="color:var(--red);">— ${invalidCount} com pendência</span>` : '<span style="color:var(--green);">— tudo certo</span>'}</div>
      ${rows.map((row, i) => ImpulsaLoteRow(row, i)).join('')}
    ` : ''}
  `;
}

function ImpulsaLoteRow(row, i) {
  const volume = Number(row.volume) || 0;
  const errors = [];
  if (!row.nome) errors.push('nome');
  if (!row.documento || !isValidDocumento(row.documento)) errors.push('CPF/CNPJ');
  if (!row.volume || volume <= 0) errors.push('volume');
  const ok = errors.length === 0;
  return `
    <div class="subsection" style="border-color:${ok ? 'var(--green)' : 'var(--red)'};">
      <div class="top-row" style="margin-bottom:10px;">
        <div class="section-label" style="margin:0;">${i + 1}. ${esc(row.nome || '(sem nome)')} ${ok ? '✅' : '⚠️'}</div>
        <button type="button" class="link-btn muted" data-action="impulsa-lote-remove-row" data-idx="${i}">✕ Remover</button>
      </div>
      ${!ok ? `<div style="color:var(--red);font-size:12px;margin-bottom:10px;">Corrija: ${errors.join(', ')}</div>` : ''}
      <div class="form-grid-2">
        <div class="field"><label>Nome</label><input type="text" value="${esc(row.nome)}" data-action="impulsa-lote-row-field" data-idx="${i}" data-field="nome"></div>
        <div class="field"><label>CPF/CNPJ</label><input type="text" value="${esc(row.documento)}" data-action="impulsa-lote-row-field" data-idx="${i}" data-field="documento"></div>
      </div>
      <div class="form-grid-2">
        <div class="field">
          <label>Volume (R$)</label>
          <input type="text" inputmode="decimal" value="${esc(row.volume)}" data-action="impulsa-lote-row-field" data-idx="${i}" data-field="volume">
          ${volume > IMPULSA_VOLUME_LIMIT ? `<div style="color:var(--orange);font-size:11px;margin-top:4px;">Limitado a ${fmtBRL(IMPULSA_VOLUME_LIMIT)} no envio.</div>` : ''}
        </div>
        <div class="field"><label>Telefone (opcional)</label><input type="text" value="${esc(row.telefone)}" data-action="impulsa-lote-row-field" data-idx="${i}" data-field="telefone"></div>
      </div>
      <div class="field"><label>Histórico Comercial</label><textarea data-action="impulsa-lote-row-field" data-idx="${i}" data-field="historico">${esc(row.historico)}</textarea></div>
      <div class="field"><label>E-mail (opcional)</label><input type="text" inputmode="email" value="${esc(row.email)}" data-action="impulsa-lote-row-field" data-idx="${i}" data-field="email"></div>
    </div>
  `;
}

function NovaSolicitacaoModal(draft) {
  const covered = COVERED_OPERATIONS.includes(draft.operation);
  const isImpulsa = draft.operation === 'IMPULSA';
  const type = covered ? draft.tipoPessoa : personType(draft.documento);
  const profile = covered ? CHECKLISTS[resolveProfile(draft)] : null;
  const complete = isFormComplete(draft) && !draft.anyUploading;
  const docDigits = (draft.documento || '').replace(/\D/g, '');
  const docInvalid = (docDigits.length === 11 || docDigits.length === 14) && !isValidDocumentoForTipo(draft.documento, type);

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
    ${draft.operation === 'CERES AGROBANK' ? `
      <div class="field">
        <label>Subtipo Ceres AgroFinance</label>
        <select data-action="draft-field" data-field="agroSubtipo">
          <option value="">Selecione o Subtipo</option>
          ${AGROFINANCE_SUBTIPOS.map(o => `<option ${draft.agroSubtipo === o ? 'selected' : ''}>${o}</option>`).join('')}
        </select>
      </div>
    ` : ''}
    ${covered ? `
      <div class="field">
        <label>Tipo de Pessoa</label>
        <div class="radio-row">
          <label><input type="radio" name="ns-tipo-pessoa" value="PJ" data-action="draft-field" data-field="tipoPessoa" ${draft.tipoPessoa === 'PJ' ? 'checked' : ''}> Pessoa Jurídica (CNPJ)</label>
          <label><input type="radio" name="ns-tipo-pessoa" value="PF" data-action="draft-field" data-field="tipoPessoa" ${draft.tipoPessoa === 'PF' ? 'checked' : ''}> Pessoa Física (CPF)</label>
        </div>
      </div>
    ` : ''}
    ${!isImpulsa ? `
      <div class="field"><label>Nome do Cliente ou Razão Social</label><input type="text" placeholder="Nome completo ou Razão Social" value="${esc(draft.nome)}" data-action="draft-field" data-field="nome"></div>
      <div class="form-grid-2">
        <div class="field">
          <label>CPF ou CNPJ</label>
          <input type="text" placeholder="000.000.000-00 ou 00.000.000/0000-00" value="${esc(draft.documento)}" data-action="draft-field" data-field="documento">
          ${docInvalid ? '<div style="color:var(--red);font-size:11.5px;margin-top:6px;">CPF/CNPJ inválido — confira os números digitados.</div>' : ''}
        </div>
        <div class="field"><label>Telefone</label><input type="text" placeholder="(00) 00000-0000" value="${esc(draft.telefone)}" data-action="draft-field" data-field="telefone"></div>
      </div>
      <div class="field"><label>E-mail</label><input type="text" inputmode="email" placeholder="email@exemplo.com" value="${esc(draft.email)}" data-action="draft-field" data-field="email"></div>
    ` : ''}
  `;

  if (covered) {
    if (profile) body += ChecklistFormFields(draft, profile, uploadSlot);
  } else if (isImpulsa) {
    body += ImpulsaFormFields(draft, uploadSlot);
  } else if (type === 'PJ') {
    body += `
      <div class="section-divider"></div>
      <div class="section-label">Informações Adicionais (Pessoa Jurídica)</div>
      <div class="form-grid-2">
        <div class="field"><label>Subtipo de Operação</label><input type="text" value="${esc(draft.subtipoOperacao)}" data-action="draft-field" data-field="subtipoOperacao"></div>
        <div class="field"><label>Número de Sócios</label><input type="text" inputmode="numeric" value="${esc(draft.numeroSocios)}" data-action="draft-field" data-field="numeroSocios"></div>
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
        <div class="field"><label>Número de Emitentes <span class="req">*</span></label><input type="text" inputmode="numeric" value="${esc(draft.numeroEmitentes)}" data-action="draft-field" data-field="numeroEmitentes"></div>
        ${(draft.emitentes || []).map((em, i) => `
          <div class="subsection">
            <div class="section-label">Dados do Emitente ${i + 1}</div>
            <div class="field"><label>Nome do Emitente</label><input type="text" value="${esc(em.nome)}" data-action="draft-emitente-field" data-idx="${i}" data-field="nome"></div>
            <div class="form-grid-2">
              <div class="field"><label>CPF do Emitente</label><input type="text" value="${esc(em.cpf)}" data-action="draft-emitente-field" data-idx="${i}" data-field="cpf"></div>
              <div class="field"><label>E-mail do Emitente</label><input type="text" inputmode="email" value="${esc(em.email)}" data-action="draft-emitente-field" data-idx="${i}" data-field="email"></div>
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
            ${emitenteDocs(em).map(d => uploadSlot(d.key, d.label, em.docs, `data-group="emitentes" data-idx="${i}"`, (em.uploading || {})[d.key])).join('')}
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
    operation: '', agroSubtipo: '', tipoPessoa: '', nome: '', documento: '', telefone: '', email: '',
    profissao: '', icp: '', estadoCivil: '', enderecoInstitucional: '',
    subtipoOperacao: '', numeroSocios: '', infoSocios: '', possuiProcurador: '', infoProcurador: '', tipoPessoaMatricula: '',
    possuiAvalista: '', certidaoPFPJ: '', numeroEmitentes: '',
    temConjugeAvalista: '', conjugeProfissao: '', conjugeContato: '',
    dadosBancarios: '', enderecoFazenda: '', nacionalidade: '',
    impulsaModelo: '', impulsaVolume: '', impulsaHistorico: '', impulsaLoteRows: [], impulsaLoteFileName: '',
    confinaPlanilha: emptyConfinaPlanilha(), visitaRelatorio: emptyVisitaRelatorio(),
    faturamento: emptyFaturamento(), endividamentoPatrimonio: emptyEndividamentoPatrimonio(),
    bensImoveis: '', bensAplicacoes: '', bensParticipacoes: '', bensOutros: '', dividaPF: '',
    areaExploracao: '', receitaRural: '', despesaRural: '', estoqueRebanho: '', dividaRural: '',
    emitentes: [], socios: [], obs: '', docs: {}, docPaths: {}, uploading: {}, extraDocs: [], anyUploading: false,
  };
}
function emptyEmitente() { return { nome: '', cpf: '', email: '', telefone: '', profissao: '', icp: '', estadoCivil: '', docs: {}, docPaths: {}, uploading: {} }; }
function emptySocio() {
  return {
    nome: '', cpf: '', profissao: '', email: '', telefone: '', nacionalidade: '', estadoCivil: '',
    bensImoveis: '', bensAplicacoes: '', bensParticipacoes: '', bensOutros: '', dividaPF: '',
    areaExploracao: '', receitaRural: '', despesaRural: '', estoqueRebanho: '', dividaRural: '',
    docs: {}, docPaths: {}, uploading: {},
  };
}

// mirrors the contentType/size constraints enforced server-side in storage.rules,
// so users get an immediate, friendly message instead of a raw Firebase error
// after the bytes have already been sent.
function validateUploadFile(file) {
  const allowed = ['application/pdf', 'image/jpeg', 'image/png'];
  if (!allowed.includes(file.type)) return 'Formato não suportado. Envie PDF, JPG ou PNG.';
  if (file.size > 15 * 1024 * 1024) return 'Arquivo muito grande (máximo 15MB).';
  return null;
}

async function uploadDraftFile(file, key, groupKey, idx) {
  const invalid = validateUploadFile(file);
  if (invalid) { toast(invalid); return; }
  const draft = ui.modal.draft;
  const target = groupKey === undefined ? draft : draft[groupKey][idx];
  target.uploading[key] = true;
  draft.anyUploading = true;
  renderModal();
  try {
    const path = `documents/${authUser.uid}/${draft.id}/${key}${groupKey !== undefined ? '_' + groupKey + idx : ''}_${file.name}`;
    await fbStorage.ref(path).put(file);
    target.docs[key] = file.name;
    target.docPaths[key] = path;
  } catch (e) {
    toast('Falha no upload: ' + e.message);
  } finally {
    target.uploading[key] = false;
    draft.anyUploading = Object.values(draft.uploading).some(Boolean)
      || draft.emitentes.some(em => Object.values(em.uploading || {}).some(Boolean))
      || draft.socios.some(s => Object.values(s.uploading || {}).some(Boolean))
      || draft.impulsaLoteRows.some(r => Object.values(r.uploading || {}).some(Boolean));
    renderModal();
  }
}

/* ============================================================
   EVENT DELEGATION
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  render();

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.modal) { ui.modal = null; renderModal(); }
  });

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
        if (tipo === 'PF' && !isValidCPF(doc)) { ui.authError = 'CPF inválido. Confira os números digitados.'; render(); break; }
        if (tipo === 'PJ' && !isValidCNPJ(doc)) { ui.authError = 'CNPJ inválido. Confira os números digitados.'; render(); break; }
        if (pass.length < 6) { ui.authError = 'A senha precisa ter ao menos 6 caracteres.'; render(); break; }
        if (pass !== pass2) { ui.authError = 'As senhas não coincidem.'; render(); break; }
        ui.authBusy = true; ui.authError = ''; render();
        try {
          const cred = await fbAuth.createUserWithEmailAndPassword(email, pass);
          try {
            await fbDb.collection('partners').doc(cred.user.uid).set({
              name: nome, type: tipo, document: doc, email, whatsapp: whats,
              relationshipStart: FieldValue.serverTimestamp(), lastUpdate: FieldValue.serverTimestamp(),
            });
          } catch (writeErr) {
            // the login was created but the profile write failed — sign back out
            // rather than leaving an orphaned account with no partners/{uid} doc,
            // which would otherwise get stuck on "Carregando seu cadastro…" forever.
            await fbAuth.signOut();
            ui.authError = 'Não foi possível salvar seu cadastro. Tente novamente.';
            ui.authBusy = false;
            render();
            break;
          }
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
        ui.admin.commissionDraft = initCommissionDraft(db.requests.find(x => x.id === el.dataset.id));
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
        if (newStatus && newStatus !== r.status) await notifyPartnerStatusChange(r, newStatus, feedback);
        render();
        break;
      }
      case 'save-commission': {
        const cd = ui.admin.commissionDraft;
        if (!cd.category) { toast('Selecione a categoria da comissão.'); break; }
        await fbDb.collection('requests').doc(el.dataset.id).update({
          commission: cd,
          updatedAt: FieldValue.serverTimestamp(),
        });
        toast('Comissão salva.');
        render();
        break;
      }

      /* ---- partner nav ---- */
      case 'partner-goto': ui.partner.screen = el.dataset.screen; render(); break;
      case 'open-request-detail-partner': ui.partner.requestId = el.dataset.id; ui.partner.screen = 'request-detail'; render(); break;
      case 'toggle-partner-filters': ui.partner.filterOpen = !ui.partner.filterOpen; render(); break;
      case 'delete-request': {
        if (!confirm('Excluir esta solicitação? Essa ação não pode ser desfeita.')) break;
        const id = el.dataset.id;
        try {
          await fbDb.collection('requests').doc(id).delete();
          toast('Solicitação excluída.');
          ui.partner.requestId = null;
          ui.partner.screen = 'dashboard';
          render();
        } catch (err) {
          toast('Não foi possível excluir: ' + err.message);
        }
        break;
      }
      case 'save-request-edit': {
        const r = db.requests.find(x => x.id === el.dataset.id);
        const draft = ui.partner.editDraft;
        if (!r || !draft) break;
        if (!draft.nome || !draft.nome.trim()) { toast('Informe o nome / razão social.'); break; }
        if (!draft.documento || !isValidDocumento(draft.documento)) { toast('CPF/CNPJ inválido.'); break; }
        const updatedForm = { ...r.form, ...draft };
        if (r.operation === 'IMPULSA') Object.assign(updatedForm, capImpulsaVolume(updatedForm.impulsaVolume));
        try {
          await fbDb.collection('requests').doc(r.id).update({ form: updatedForm, updatedAt: FieldValue.serverTimestamp() });
          toast('Alterações salvas.');
          render();
        } catch (err) {
          toast('Não foi possível salvar: ' + err.message);
        }
        break;
      }
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

        if (draft.operation === 'IMPULSA' && draft.impulsaModelo === 'lote') {
          try {
            const loteId = uid(10);
            const batch = fbDb.batch();
            draft.impulsaLoteRows.forEach(row => {
              const ref = fbDb.collection('requests').doc();
              batch.set(ref, {
                partnerId: authUser.uid, operation: 'IMPULSA', status: 'em_analise',
                form: {
                  operation: 'IMPULSA', impulsaModelo: 'lote', loteId,
                  nome: row.nome, documento: row.documento, ...capImpulsaVolume(row.volume),
                  impulsaHistorico: row.historico, telefone: row.telefone, email: row.email,
                },
                documents: [],
                feedbackHistory: [],
                createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
              });
            });
            await batch.commit();
            ui.modal = null;
            ui.partner.screen = 'dashboard';
            render();
            toast(`${draft.impulsaLoteRows.length} solicitações criadas com sucesso!`);
          } catch (err) {
            toast('Falha ao criar as solicitações: ' + err.message);
          }
          break;
        }

        // Firestore rejects `undefined` field values, so these must be dropped via
        // destructuring rather than set to undefined — the upload/doc-tracking fields
        // don't belong in the form snapshot anyway (they're persisted in `documents`).
        const { docs, docPaths, uploading, emitentes, extraDocs, anyUploading, id, impulsaLoteRows, ...formSnapshot } = draft;
        if (formSnapshot.operation === 'IMPULSA') Object.assign(formSnapshot, capImpulsaVolume(formSnapshot.impulsaVolume));
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

      case 'impulsa-lote-template': {
        const wsData = [['Nome', 'CPF/CNPJ', 'Volume Solicitado', 'Histórico Comercial', 'Telefone', 'E-mail']];
        const ws = XLSX.utils.aoa_to_sheet(wsData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Modelo');
        XLSX.writeFile(wb, 'modelo_impulsiona.xlsx');
        break;
      }
      case 'impulsa-lote-remove-row':
        ui.modal.draft.impulsaLoteRows.splice(parseInt(el.dataset.idx, 10), 1);
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
    if (el.dataset.action === 'draft-socio-field') {
      const idx = parseInt(el.dataset.idx, 10);
      ui.modal.draft.socios[idx][el.dataset.field] = el.value;
      focusPreservingRender(renderModal);
    }
    if (el.dataset.action === 'commission-field') {
      ui.admin.commissionDraft[el.dataset.field] = el.value;
      focusPreservingRender(renderPartial);
    }
    if (el.dataset.action === 'partner-edit-field') {
      if (ui.partner.editDraft) ui.partner.editDraft[el.dataset.field] = el.value;
      focusPreservingRender(renderPartial);
    }
    if (el.dataset.action === 'confina-planilha-field') {
      ui.modal.draft.confinaPlanilha[el.dataset.metric][el.dataset.ano] = el.value;
      focusPreservingRender(renderModal);
    }
    if (el.dataset.action === 'visita-field') {
      ui.modal.draft.visitaRelatorio[el.dataset.field] = el.value;
      focusPreservingRender(renderModal);
    }
    if (el.dataset.action === 'visita-row-field') {
      const idx = parseInt(el.dataset.idx, 10);
      ui.modal.draft.visitaRelatorio[el.dataset.table][idx][el.dataset.field] = el.value;
      focusPreservingRender(renderModal);
    }
    if (el.dataset.action === 'faturamento-field') {
      ui.modal.draft.faturamento[el.dataset.metric][el.dataset.ano] = el.value;
      focusPreservingRender(renderModal);
    }
    if (el.dataset.action === 'endiv-row-field') {
      const idx = parseInt(el.dataset.idx, 10);
      ui.modal.draft.endividamentoPatrimonio[el.dataset.table][idx][el.dataset.field] = el.value;
      focusPreservingRender(renderModal);
    }
    if (el.dataset.action === 'impulsa-lote-row-field') {
      const idx = parseInt(el.dataset.idx, 10);
      ui.modal.draft.impulsaLoteRows[idx][el.dataset.field] = el.value;
      focusPreservingRender(renderModal);
    }
  });

  document.body.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.dataset.action === 'admin-status-filter') { ui.admin.statusFilter = el.value; renderPartial(); }
    if (el.dataset.action === 'partner-filter-status') { ui.partner.statusFilter = el.value; renderPartial(); }
    if (el.dataset.action === 'partner-filter-operation') { ui.partner.operationFilter = el.value; renderPartial(); }
    if (el.dataset.action === 'commission-field') { ui.admin.commissionDraft[el.dataset.field] = el.value; renderPartial(); }
    if (el.dataset.action === 'commission-checkbox') { ui.admin.commissionDraft[el.dataset.field] = el.checked; renderPartial(); }
    if (el.dataset.action === 'visita-field') { ui.modal.draft.visitaRelatorio[el.dataset.field] = el.value; renderModal(); }

    if (el.dataset.action === 'draft-field') {
      ui.modal.draft[el.dataset.field] = el.value;
      if (el.dataset.field === 'numeroEmitentes') {
        const n = Math.max(0, parseInt(el.value || '0', 10) || 0);
        const arr = ui.modal.draft.emitentes;
        while (arr.length < n) arr.push(emptyEmitente());
        while (arr.length > n) arr.pop();
      }
      if (el.dataset.field === 'numeroSocios' && COVERED_OPERATIONS.includes(ui.modal.draft.operation)) {
        const n = Math.max(0, parseInt(el.value || '0', 10) || 0);
        const arr = ui.modal.draft.socios;
        while (arr.length < n) arr.push(emptySocio());
        while (arr.length > n) arr.pop();
      }
      renderModal();
    }
    if (el.dataset.action === 'draft-emitente-field') {
      const idx = parseInt(el.dataset.idx, 10);
      ui.modal.draft.emitentes[idx][el.dataset.field] = el.value;
      renderModal();
    }
    if (el.dataset.action === 'draft-socio-field') {
      const idx = parseInt(el.dataset.idx, 10);
      ui.modal.draft.socios[idx][el.dataset.field] = el.value;
      renderModal();
    }
    if (el.dataset.action === 'draft-file') {
      const file = el.files[0];
      if (!file) return;
      const groupKey = el.dataset.group;
      const idx = el.dataset.idx !== undefined ? parseInt(el.dataset.idx, 10) : undefined;
      await uploadDraftFile(file, el.dataset.key, groupKey, idx);
    }
    if (el.dataset.action === 'draft-extra-file') {
      const draft = ui.modal.draft;
      draft.extraDocs = draft.extraDocs || [];
      for (const file of Array.from(el.files)) {
        const invalid = validateUploadFile(file);
        if (invalid) { toast(`${file.name}: ${invalid}`); continue; }
        const path = `documents/${authUser.uid}/${draft.id}/extra_${Date.now()}_${file.name}`;
        try { await fbStorage.ref(path).put(file); draft.extraDocs.push({ name: file.name, path }); }
        catch (err) { toast('Falha no upload de ' + file.name); }
      }
      renderModal();
    }
    if (el.dataset.action === 'partner-upload-existing-doc') {
      const file = el.files[0];
      if (!file) return;
      const invalid = validateUploadFile(file);
      if (invalid) { toast(invalid); return; }
      const req = db.requests.find(r => r.id === el.dataset.req);
      const path = `documents/${authUser.uid}/${req.id}/${el.dataset.key}_${file.name}`;
      try {
        await fbStorage.ref(path).put(file);
        const docs = (req.documents || []).map(d => d.key === el.dataset.key ? { ...d, status: 'enviado', fileName: file.name, storagePath: path } : d);
        await fbDb.collection('requests').doc(req.id).update({ documents: docs, updatedAt: FieldValue.serverTimestamp() });
        toast('Documento enviado.');
      } catch (err) { toast('Falha no upload: ' + err.message); }
    }
    if (el.dataset.action === 'impulsa-lote-row-field') {
      const idx = parseInt(el.dataset.idx, 10);
      ui.modal.draft.impulsaLoteRows[idx][el.dataset.field] = el.value;
      renderModal();
    }
    if (el.dataset.action === 'impulsa-lote-file') {
      const file = el.files[0];
      if (!file) return;
      const draft = ui.modal.draft;
      try {
        const buf = await file.arrayBuffer();
        const wb = XLSX.read(buf, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rowsRaw = XLSX.utils.sheet_to_json(ws, { defval: '' });
        if (!rowsRaw.length) { toast('A planilha está vazia.'); return; }
        if (rowsRaw.length > IMPULSA_LOTE_ROW_LIMIT) { toast(`A planilha tem mais de ${IMPULSA_LOTE_ROW_LIMIT} linhas — divida em arquivos menores.`); return; }
        const findCol = (row, patterns) => {
          const key = Object.keys(row).find(k => patterns.some(p => k.toLowerCase().includes(p)));
          return key ? String(row[key]).trim() : '';
        };
        draft.impulsaLoteRows = rowsRaw.map(r => ({
          nome: findCol(r, ['nome']),
          documento: findCol(r, ['cpf', 'cnpj']),
          volume: findCol(r, ['volume']).replace(/[^\d,.-]/g, '').replace(/\.(?=\d{3}(?:\D|$))/g, '').replace(',', '.'),
          historico: findCol(r, ['histórico', 'historico']),
          telefone: findCol(r, ['telefone', 'fone']),
          email: findCol(r, ['e-mail', 'email']),
          docs: {}, docPaths: {}, uploading: {},
        }));
        draft.impulsaLoteFileName = file.name;
        toast(`${draft.impulsaLoteRows.length} linha(s) carregada(s) — confira os dados antes de enviar.`);
      } catch (err) {
        toast('Não foi possível ler a planilha: ' + err.message);
      }
      renderModal();
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
  // the modal is rebuilt wholesale on every keystroke, which tears down and
  // recreates its own scrollable overlay — resetting scrollTop to 0 — so we
  // have to save/restore that scroll position ourselves, same as focus.
  const scrollEl = active ? active.closest('.modal-overlay') : null;
  const scrollTop = scrollEl ? scrollEl.scrollTop : null;
  if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) {
    sel = {
      action: active.dataset.action || null,
      field: active.dataset.field || null,
      idx: active.dataset.idx !== undefined ? active.dataset.idx : null,
      metric: active.dataset.metric || null,
      ano: active.dataset.ano || null,
      table: active.dataset.table || null,
      id: active.id || null,
      start: active.selectionStart,
      end: active.selectionEnd,
    };
  }
  renderFn();
  if (sel) {
    let selector = sel.id ? `#${CSS.escape(sel.id)}` : `[data-action="${sel.action}"]`;
    if (!sel.id) {
      if (sel.field) selector += `[data-field="${sel.field}"]`;
      if (sel.idx !== null) selector += `[data-idx="${sel.idx}"]`;
      if (sel.metric) selector += `[data-metric="${sel.metric}"]`;
      if (sel.ano) selector += `[data-ano="${sel.ano}"]`;
      if (sel.table) selector += `[data-table="${sel.table}"]`;
    }
    const found = document.querySelector(selector);
    if (found) {
      found.focus({ preventScroll: true });
      if (typeof sel.start === 'number' && found.setSelectionRange) {
        try { found.setSelectionRange(sel.start, sel.end); } catch (e) { /* not applicable to this input type */ }
      }
    }
  }
  if (scrollTop !== null) {
    const newScrollEl = document.querySelector('.modal-overlay');
    if (newScrollEl) newScrollEl.scrollTop = scrollTop;
  }
}

function renderPartial() {
  const app = document.getElementById('app');
  if (!authUser) app.innerHTML = ui.role ? AuthScreen() : RoleScreen();
  else if (session) app.innerHTML = session.role === 'admin' ? AdminRoot() : PartnerRoot();
}
