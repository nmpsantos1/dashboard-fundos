import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  TrendingUp, AlertCircle, LineChart as LineChartIcon, LayoutGrid, Printer, ArrowLeft,
  Loader2,
} from 'lucide-react';

/* ---------------------------------------------------------------------- */
/* Ligação à base de dados partilhada (Supabase) — só leitura              */
/* ---------------------------------------------------------------------- */

// Substituir pelos valores em Supabase -> Settings -> Data API.
const SUPABASE_URL = 'https://ynanmvxgzbwqfktzhxrq.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_Dl31OFAPt0ksFOB4JGRk0Q_R8UHzFPn';
const SUPABASE_CONFIGURED = !SUPABASE_URL.includes('COLA_AQUI') && !SUPABASE_ANON_KEY.includes('COLA_AQUI');
const POLL_INTERVAL_MS = 120000; // 2 minutos — dados pouco voláteis (cotações diárias)

function supabaseHeaders() {
  return { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` };
}

async function fetchTable(table, query = '') {
  const url = `${SUPABASE_URL}/rest/v1/${table}${query}`;
  const res = await fetch(url, { headers: supabaseHeaders() });
  if (!res.ok) throw new Error(`Falha ao carregar ${table}`);
  return res.json();
}

// Carrega o mapeamento, o risco e as definições (tabelas pequenas, sempre por inteiro).
async function loadCatalog() {
  const [mapping, risk, settings] = await Promise.all([
    fetchTable('mapeamento_produto_fundo', '?select=*'),
    fetchTable('risco_fundos', '?select=*'),
    fetchTable('definicoes', '?select=*&id=eq.default'),
  ]);
  return {
    mappingRows: mapping.map((r) => ({
      codProd: r.cod_prod, produto: r.produto, idvp: r.idvp || '',
      situacao: r.situacao || '', grupo: r.grupo || '', codFun: r.cod_fun, fundo: r.fundo,
    })),
    riskRows: risk.map((r) => ({
      fund: '', fundCode: r.cod_fun, srri: r.srri || null,
      riskClassOverride: r.classe_risco_manual || null, inceptionDate: r.data_inicio || null,
    })),
    riskFreeRate: settings && settings[0] ? Number(settings[0].taxa_isenta_risco) : 2,
  };
}

// Carrega o histórico de cotações de um ou vários fundos (por código), sob procura.
async function loadNavForFunds(codFunList) {
  if (!codFunList || codFunList.length === 0) return {};
  const inList = codFunList.map((c) => `"${c}"`).join(',');
  const rows = await fetchTable('nav_cotacoes', `?select=cod_fun,data,cotacao&cod_fun=in.(${inList})&order=data.asc`);
  const map = {};
  for (const r of rows) {
    if (!map[r.cod_fun]) map[r.cod_fun] = [];
    map[r.cod_fun].push({ date: new Date(`${r.data}T00:00:00`), dateISO: r.data, nav: Number(r.cotacao) });
  }
  return map;
}

function normalizeFundName(s) {
  return (s || '').toString().trim().replace(/\s+/g, ' ')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

function normalizeCode(s) {
  if (s === null || s === undefined) return '';
  let str = s.toString().trim();
  if (str === '') return '';
  if (/^\d+\.0+$/.test(str)) str = str.split('.')[0];
  if (/^\d+$/.test(str)) str = str.replace(/^0+(?=\d)/, '');
  return str;
}

function looseNameKey(s) {
  return s.replace(/\s+/g, '');
}

function alnumNameKey(s) {
  return s.replace(/[^A-Z0-9]/g, '');
}

function resolveFundKey(rawCode, rawName, lookups) {
  const code = normalizeCode(rawCode);
  if (code) return code;
  const norm = normalizeFundName(rawName);
  if (!norm) return null;
  // Se a coluna usada como "nome" contiver na realidade um código (ex.: ficheiro de cotações
  // que identifica o fundo só pelo Cod_Fun, mesmo que a coluna se chame "Fundo"), trata-o como código.
  if (/^\d+(\.\d+)?$/.test(norm)) {
    const asCode = normalizeCode(norm);
    if (asCode) return asCode;
  }
  if (lookups) {
    if (lookups.byName && lookups.byName.has(norm)) return lookups.byName.get(norm);
    const loose = looseNameKey(norm);
    if (lookups.byLoose && lookups.byLoose.has(loose)) return lookups.byLoose.get(loose);
    const alnum = alnumNameKey(norm);
    if (lookups.byAlnum && lookups.byAlnum.has(alnum)) return lookups.byAlnum.get(alnum);
  }
  return `NM:${norm}`;
}

function displayNameForKey(key, codeToName, fallbackNames) {
  if (!key) return '';
  if (codeToName.has(key)) return codeToName.get(key);
  if (fallbackNames.has(key)) return fallbackNames.get(key);
  return key.startsWith('NM:') ? key.slice(3) : key;
}

/* ---------------------------------------------------------------------- */
/* Helpers: dates & math                                                   */
/* ---------------------------------------------------------------------- */

function subtractYears(date, years) {
  const d = new Date(date);
  d.setFullYear(d.getFullYear() - years);
  return d;
}

function findAtOrBefore(series, targetDate) {
  let result = null;
  for (let i = 0; i < series.length; i++) {
    if (series[i].date <= targetDate) result = series[i];
    else break;
  }
  return result;
}

function findAtOrAfter(series, targetDate) {
  for (let i = 0; i < series.length; i++) {
    if (series[i].date >= targetDate) return series[i];
  }
  return null;
}

function dailyReturns(subset) {
  const rets = [];
  for (let i = 1; i < subset.length; i++) rets.push(subset[i].nav / subset[i - 1].nav - 1);
  return rets;
}

function annualizedVolOf(subset) {
  if (!subset || subset.length < 30) return null;
  const rets = dailyReturns(subset);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(variance) * Math.sqrt(252);
}

// Escala regulamentar (CESR/ESMA — a mesma base metodológica do SRRI):
// classe 1: 0%–0,5% · 2: 0,5%–2% · 3: 2%–5% · 4: 5%–10% · 5: 10%–15% · 6: 15%–25% · 7: ≥25%
function volatilityToClass(vol) {
  if (vol === null || vol === undefined || isNaN(vol)) return null;
  const pct = vol * 100;
  if (pct < 0.5) return 1;
  if (pct < 2) return 2;
  if (pct < 5) return 3;
  if (pct < 10) return 4;
  if (pct < 15) return 5;
  if (pct < 25) return 6;
  return 7;
}

function computeMetrics(series, riskFreeRate, officialInceptionDate) {
  if (!series || series.length === 0) return null;
  const naturalFirst = series[0];
  const last = series[series.length - 1];

  const prevYearEnd = new Date(last.date.getFullYear() - 1, 11, 31);
  let ytd = null;
  let ytdPartial = false;
  const baseline = findAtOrBefore(series, prevYearEnd);
  if (baseline) {
    ytd = last.nav / baseline.nav - 1;
  } else if (naturalFirst.date < last.date) {
    ytd = last.nav / naturalFirst.nav - 1;
    ytdPartial = true;
  }

  function periodReturn(years) {
    const target = subtractYears(last.date, years);
    if (naturalFirst.date > target) return null;
    const base = findAtOrBefore(series, target);
    if (!base || base.nav === 0) return null;
    const total = last.nav / base.nav - 1;
    const annualized = years > 1 ? Math.pow(1 + total, 1 / years) - 1 : total;
    return { total, annualized };
  }

  const oneYear = periodReturn(1);
  const threeYear = periodReturn(3);
  const fiveYear = periodReturn(5);
  const eightYear = periodReturn(8);

  // Rendibilidade desde o início: usa a Data de Início oficial (ficheiro de risco), quando
  // disponível, como base de cálculo. Se as cotações carregadas não recuarem até essa data,
  // usa-se a cotação mais antiga disponível e sinaliza-se o histórico em falta.
  let inceptionBase = naturalFirst;
  let inceptionDate = naturalFirst.date;
  let historyGap = false;
  if (officialInceptionDate) {
    inceptionDate = officialInceptionDate;
    if (naturalFirst.date <= officialInceptionDate) {
      inceptionBase = findAtOrAfter(series, officialInceptionDate) || naturalFirst;
    } else {
      historyGap = true;
    }
  }
  const daysElapsed = (last.date - inceptionBase.date) / 86400000;
  const yearsElapsed = daysElapsed / 365.25;
  const sinceInceptionTotal = last.nav / inceptionBase.nav - 1;
  const sinceInceptionAnnualized = yearsElapsed > 1
    ? Math.pow(1 + sinceInceptionTotal, 1 / yearsElapsed) - 1
    : null;

  function sharpe(years) {
    const target = subtractYears(last.date, years);
    if (naturalFirst.date > target) return null;
    const subset = series.filter((p) => p.date >= target);
    const annualizedVol = annualizedVolOf(subset);
    if (!annualizedVol) return null;
    const subYears = (subset[subset.length - 1].date - subset[0].date) / 86400000 / 365.25;
    const totalReturn = subset[subset.length - 1].nav / subset[0].nav - 1;
    const annualizedReturn = Math.pow(1 + totalReturn, 1 / subYears) - 1;
    return {
      sharpe: (annualizedReturn - riskFreeRate) / annualizedVol,
      annualizedReturn,
      annualizedVol,
    };
  }

  // Classe de risco: volatilidade anualizada numa janela de 12 meses (ou todo o histórico
  // disponível, se o fundo for mais novo), mapeada pela escala regulamentar acima.
  const classWindowTarget = subtractYears(last.date, 1);
  const classSubset = series.filter((p) => p.date >= (classWindowTarget > naturalFirst.date ? classWindowTarget : naturalFirst.date));
  const computedVolatility = annualizedVolOf(classSubset);
  const computedRiskClass = volatilityToClass(computedVolatility);

  return {
    firstDate: naturalFirst.date,
    inceptionDate,
    historyGap,
    lastDate: last.date,
    lastNav: last.nav,
    ytd, ytdPartial,
    oneYear, threeYear, fiveYear, eightYear,
    sinceInceptionTotal, sinceInceptionAnnualized,
    sharpe5: sharpe(5),
    sharpe8: sharpe(8),
    computedVolatility,
    computedRiskClass,
  };
}

function filterByRange(series, range) {
  if (!series || series.length === 0) return [];
  if (range === 'Máx') return series;
  const last = series[series.length - 1].date;
  let start;
  if (range === '1M') { start = new Date(last); start.setMonth(start.getMonth() - 1); }
  else if (range === '6M') { start = new Date(last); start.setMonth(start.getMonth() - 6); }
  else if (range === '1A') start = subtractYears(last, 1);
  else if (range === '3A') start = subtractYears(last, 3);
  else if (range === '5A') start = subtractYears(last, 5);
  else start = series[0].date;
  return series.filter((p) => p.date >= start);
}

/* ---------------------------------------------------------------------- */
/* Helpers: formatting                                                     */
/* ---------------------------------------------------------------------- */

function formatPercent(x, decimals = 2) {
  if (x === null || x === undefined || isNaN(x)) return 'N/D';
  return `${(x * 100).toLocaleString('pt-PT', {
    minimumFractionDigits: decimals, maximumFractionDigits: decimals,
  })}%`;
}

function formatDate(d) {
  if (!d) return 'N/D';
  return d.toLocaleDateString('pt-PT');
}

function formatDateHyphen(d) {
  if (!d) return 'N/D';
  const day = d.getDate().toString().padStart(2, '0');
  const month = (d.getMonth() + 1).toString().padStart(2, '0');
  return `${day}-${month}-${d.getFullYear()}`;
}

function formatNav(x) {
  if (x === null || x === undefined || isNaN(x)) return 'N/D';
  return x.toLocaleString('pt-PT', { minimumFractionDigits: 4, maximumFractionDigits: 4 });
}

function returnClass(x) {
  if (x === null || x === undefined || isNaN(x)) return '';
  return x >= 0 ? 'pos' : 'neg';
}

const SRRI_COLORS = ['#1B7A4C', '#4C9A3F', '#9BC53D', '#F4D35E', '#EE964B', '#E8622C', '#C0392B'];

// Cor de fundo para uma célula de rendibilidade no mapa de calor: verde para valores positivos,
// vermelho para negativos, com intensidade proporcional ao peso do valor na coluna (escala dinâmica).
function heatReturnColor(value, maxAbs) {
  if (value === null || value === undefined || isNaN(value)) return 'transparent';
  const intensity = Math.min(Math.abs(value) / (maxAbs || 1), 1);
  const alpha = 0.06 + intensity * 0.46;
  return value >= 0 ? `rgba(27,122,76,${alpha.toFixed(2)})` : `rgba(179,38,30,${alpha.toFixed(2)})`;
}

// Ordena por Cód. Fundo (numérico) mesmo quando o código não é mostrado na interface;
// fundos sem código numérico (nome não associado ao mapeamento) vão para o fim, por nome.
function compareByFundKey(a, b) {
  const na = Number(a.key);
  const nb = Number(b.key);
  const aIsCode = a.key && !a.key.startsWith('NM:') && !isNaN(na);
  const bIsCode = b.key && !b.key.startsWith('NM:') && !isNaN(nb);
  if (aIsCode && bIsCode) return na - nb;
  if (aIsCode) return -1;
  if (bIsCode) return 1;
  return a.label.localeCompare(b.label, 'pt');
}

/* ---------------------------------------------------------------------- */
/* Small components                                                        */
/* ---------------------------------------------------------------------- */

function RiskLadder({ level }) {
  return (
    <div className="risk-ladder">
      <div className="risk-ladder-track">
        {SRRI_COLORS.map((c, i) => {
          const stepLevel = i + 1;
          const active = level === stepLevel;
          return (
            <div
              key={stepLevel}
              className={`risk-step${active ? ' active' : ''}`}
              style={{ background: c }}
            >
              {stepLevel}
            </div>
          );
        })}
      </div>
      <div className="risk-ladder-caption">
        {level ? `Indicador Sumário de Risco: ${level} / 7` : 'Indicador Sumário de Risco: N/D'}
      </div>
    </div>
  );
}

function RiskClassBadge({ level, computed }) {
  if (!level) return <span className="badge badge-muted">Classe de Risco: N/D</span>;
  return (
    <span className="badge" style={{ background: SRRI_COLORS[level - 1] }}>
      Classe de Risco: {level}/7{computed ? ' (calculada)' : ''}
    </span>
  );
}


function ChartTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const date = new Date(`${label}T00:00:00`);
  return (
    <div className="chart-tooltip">
      <div className="chart-tooltip-date">{formatDate(date)}</div>
      <div className="chart-tooltip-value">{formatNav(payload[0].value)}</div>
    </div>
  );
}

function KpiCell({ label, value, valueClass, sub }) {
  return (
    <div className="kpi-cell">
      <div className="kpi-label">{label}</div>
      <div className={`kpi-value ${valueClass || ''}`}>{value}</div>
      {sub ? <div className="kpi-sub">{sub}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------------------- */
/* Main App                                                                 */
/* ---------------------------------------------------------------------- */

const RANGE_OPTIONS = ['1M', '6M', '1A', '3A', '5A', 'Máx'];
const SITUACAO_OPTIONS = ['Todos', 'Em Comercialização', 'Fora de Comercialização'];

export default function App() {
  const [fundSeriesCache, setFundSeriesCache] = useState({}); // codFun -> [{date, dateISO, nav}]
  const [fundSeriesLoading, setFundSeriesLoading] = useState({});
  const [riskRows, setRiskRows] = useState([]);
  const [mappingRows, setMappingRows] = useState([]);
  const [riskFreeRatePercent, setRiskFreeRatePercent] = useState('2'); // vem do Supabase, não editável na app
  const [selectedSituacao, setSelectedSituacao] = useState('Todos');
  const [selectedFund, setSelectedFund] = useState('');
  const [chartRange, setChartRange] = useState('3A');
  const [error, setError] = useState(null);
  const [viewMode, setViewMode] = useState('fundo');
  const [loaded, setLoaded] = useState(false);

  // Load Google Fonts
  useEffect(() => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,300..700&family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;500;600&display=swap';
    document.head.appendChild(link);
    return () => { document.head.removeChild(link); };
  }, []);

  // Carrega o catálogo (mapeamento + risco + definições) do Supabase, com atualização periódica.
  useEffect(() => {
    if (!SUPABASE_CONFIGURED) { setLoaded(true); return undefined; }
    let cancelled = false;
    async function load() {
      try {
        const { mappingRows: m, riskRows: r, riskFreeRate } = await loadCatalog();
        if (cancelled) return;
        setMappingRows(m);
        setRiskRows(r);
        setRiskFreeRatePercent(String(riskFreeRate));
        setError(null);
      } catch (e) {
        if (!cancelled) setError('Sem ligação à base de dados. A mostrar a última versão disponível.');
      } finally {
        if (!cancelled) setLoaded(true);
      }
    }
    load();
    const interval = setInterval(load, POLL_INTERVAL_MS);
    function onVisible() { if (document.visibilityState === 'visible') load(); }
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // Garante que as cotações de um fundo estão carregadas (busca sob procura, uma vez por fundo).
  const ensureFundSeries = useCallback((codFunList) => {
    const missing = codFunList.filter((fk) => fk && !fundSeriesCache[fk] && !fundSeriesLoading[fk]);
    if (missing.length === 0) return;
    setFundSeriesLoading((prev) => {
      const next = { ...prev };
      missing.forEach((fk) => { next[fk] = true; });
      return next;
    });
    loadNavForFunds(missing).then((map) => {
      setFundSeriesCache((prev) => {
        const next = { ...prev };
        missing.forEach((fk) => { next[fk] = map[fk] || []; });
        return next;
      });
      setFundSeriesLoading((prev) => {
        const next = { ...prev };
        missing.forEach((fk) => { delete next[fk]; });
        return next;
      });
    }).catch(() => {
      setError('Não foi possível carregar as cotações. Tente novamente.');
      setFundSeriesLoading((prev) => {
        const next = { ...prev };
        missing.forEach((fk) => { delete next[fk]; });
        return next;
      });
    });
  }, [fundSeriesCache, fundSeriesLoading]);

  /* ---- Fund key resolution (name <-> code) ---- */

  const hasMapping = mappingRows.length > 0;

  const nameLookups = useMemo(() => {
    const byName = new Map();
    const byLoose = new Map();
    const byAlnum = new Map();
    for (const r of mappingRows) {
      const code = normalizeCode(r.codFun);
      if (!code || !r.fundo) continue;
      const norm = normalizeFundName(r.fundo);
      if (!byName.has(norm)) byName.set(norm, code);
      const loose = looseNameKey(norm);
      if (!byLoose.has(loose)) byLoose.set(loose, code);
      const alnum = alnumNameKey(norm);
      if (!byAlnum.has(alnum)) byAlnum.set(alnum, code);
    }
    return { byName, byLoose, byAlnum };
  }, [mappingRows]);

  const codeToName = useMemo(() => {
    const map = new Map();
    for (const r of mappingRows) {
      const code = normalizeCode(r.codFun);
      if (code) map.set(code, (r.fundo || '').toString().trim().replace(/\s+/g, ' '));
    }
    return map;
  }, [mappingRows]);

  const fallbackNames = useMemo(() => new Map(), []);

  const fundSeries = useMemo(() => {
    const map = new Map();
    for (const [codFun, series] of Object.entries(fundSeriesCache)) map.set(codFun, series);
    return map;
  }, [fundSeriesCache]);

  const riskMap = useMemo(() => {
    const map = new Map();
    for (const r of riskRows) {
      const key = resolveFundKey(r.fundCode, r.fund, nameLookups);
      if (key) map.set(key, r);
    }
    return map;
  }, [riskRows, nameLookups]);

  /* ---- Product catalog (do Supabase) ---- */

  const effectiveMappingRows = mappingRows;

  const productsByKey = useMemo(() => {
    const map = new Map();
    for (const r of effectiveMappingRows) {
      const key = (r.codProd && r.codProd.toString().trim()) || r.produto;
      if (!map.has(key)) {
        map.set(key, {
          key, produto: r.produto, idvp: r.idvp,
          situacao: (r.situacao || '').toString().trim(),
          grupo: (r.grupo || '').toString().trim(),
          fundKeys: new Set(),
        });
      }
      const normCode = normalizeCode(r.codFun);
      if (normCode) map.get(key).fundKeys.add(normCode);
    }
    return map;
  }, [effectiveMappingRows]);

  const fundToProducts = useMemo(() => {
    const map = new Map();
    for (const p of productsByKey.values()) {
      for (const fk of p.fundKeys) {
        if (!map.has(fk)) map.set(fk, []);
        map.get(fk).push(p);
      }
    }
    return map;
  }, [productsByKey]);

  /* ---- Situação (tabs) -> lista de fundos agrupada por Grupo / Tipo de Produto ---- */

  const productsBySituacao = useMemo(() => {
    const arr = Array.from(productsByKey.values());
    if (!hasMapping || selectedSituacao === 'Todos') return arr;
    return arr.filter((p) => p.situacao === selectedSituacao);
  }, [productsByKey, selectedSituacao, hasMapping]);

  const groupedFundList = useMemo(() => {
    const byGrupo = new Map();
    for (const p of productsBySituacao) {
      const g = p.grupo || 'Sem grupo';
      if (!byGrupo.has(g)) byGrupo.set(g, new Map());
      for (const fk of p.fundKeys) {
        if (!byGrupo.get(g).has(fk)) byGrupo.get(g).set(fk, displayNameForKey(fk, codeToName, fallbackNames));
      }
    }
    const groups = Array.from(byGrupo.entries()).map(([g, fundsMap]) => ({
      grupo: g,
      funds: Array.from(fundsMap.entries())
        .map(([key, label]) => ({ key, label }))
        .sort(compareByFundKey),
    })).sort((a, b) => a.grupo.localeCompare(b.grupo, 'pt'));

    if (hasMapping && selectedSituacao === 'Todos') {
      const unmapped = [];
      for (const fk of fundSeries.keys()) {
        if (!fundToProducts.has(fk)) unmapped.push({ key: fk, label: displayNameForKey(fk, codeToName, fallbackNames) });
      }
      if (unmapped.length > 0) {
        unmapped.sort(compareByFundKey);
        groups.push({ grupo: 'Não mapeado', funds: unmapped });
      }
    }
    return groups;
  }, [productsBySituacao, hasMapping, selectedSituacao, fundSeries, fundToProducts, codeToName, fallbackNames]);

  useEffect(() => {
    const flat = groupedFundList.flatMap((g) => g.funds);
    if (flat.length === 0) {
      if (selectedFund !== '') setSelectedFund('');
      return;
    }
    if (!flat.some((o) => o.key === selectedFund)) setSelectedFund(flat[0].key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupedFundList]);

  // Busca as cotações do fundo selecionado, só quando ainda não estiverem em cache.
  useEffect(() => {
    if (selectedFund) ensureFundSeries([selectedFund]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFund]);

  const currentSeries = fundSeries.get(selectedFund) || [];
  const riskFreeRate = (parseFloat((riskFreeRatePercent || '0').toString().replace(',', '.')) || 0) / 100;
  const currentRisk = riskMap.get(selectedFund);

  const officialInceptionDate = useMemo(() => {
    if (!currentRisk || !currentRisk.inceptionDate) return null;
    return new Date(`${currentRisk.inceptionDate}T00:00:00`);
  }, [currentRisk]);

  const metrics = useMemo(
    () => computeMetrics(currentSeries, riskFreeRate, officialInceptionDate),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fundSeries, selectedFund, riskFreeRate, officialInceptionDate],
  );

  const chartData = useMemo(
    () => filterByRange(currentSeries, chartRange).map((p) => ({ dateISO: p.dateISO, nav: p.nav })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fundSeries, selectedFund, chartRange],
  );

  const selectedFundName = selectedFund ? displayNameForKey(selectedFund, codeToName, fallbackNames) : '';

  const globalMaxDate = useMemo(() => {
    let max = null;
    for (const arr of fundSeries.values()) {
      const last = arr[arr.length - 1];
      if (last && (!max || last.date > max)) max = last.date;
    }
    return max;
  }, [fundSeries]);

  // ---- Painel de resumo (mapa de calor): fundos "Em Comercialização", agrupados por Grupo ----
  // Ao entrar no painel de resumo, garante que as cotações de todos os fundos
  // "Em Comercialização" estão carregadas (busca em lote, uma única vez).
  useEffect(() => {
    if (viewMode !== 'resumo') return;
    const emComKeys = Array.from(productsByKey.values())
      .filter((p) => p.situacao === 'Em Comercialização')
      .flatMap((p) => Array.from(p.fundKeys));
    if (emComKeys.length > 0) ensureFundSeries(emComKeys);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewMode, productsByKey]);

  const summaryGroups = useMemo(() => {
    const emComProducts = Array.from(productsByKey.values()).filter((p) => p.situacao === 'Em Comercialização');
    const byGrupo = new Map();
    for (const p of emComProducts) {
      const g = p.grupo || 'Sem grupo';
      if (!byGrupo.has(g)) byGrupo.set(g, new Set());
      for (const fk of p.fundKeys) byGrupo.get(g).add(fk);
    }
    const groups = [];
    for (const [grupo, fundKeySet] of byGrupo) {
      const rows = [];
      for (const fk of fundKeySet) {
        const series = fundSeries.get(fk);
        if (!series || series.length === 0) continue;
        const risk = riskMap.get(fk);
        const officialInception = risk && risk.inceptionDate ? new Date(`${risk.inceptionDate}T00:00:00`) : null;
        const m = computeMetrics(series, riskFreeRate, officialInception);
        if (!m) continue;
        const riskClassIsOverride = !!(risk && risk.riskClassOverride);
        rows.push({
          key: fk,
          name: displayNameForKey(fk, codeToName, fallbackNames),
          metrics: m,
          srri: (risk && risk.srri) || null,
          riskClass: riskClassIsOverride ? risk.riskClassOverride : m.computedRiskClass,
          riskClassIsOverride,
        });
      }
      rows.sort((a, b) => {
        const na = Number(a.key);
        const nb = Number(b.key);
        const aIsCode = a.key && !a.key.startsWith('NM:') && !isNaN(na);
        const bIsCode = b.key && !b.key.startsWith('NM:') && !isNaN(nb);
        if (aIsCode && bIsCode) return na - nb;
        if (aIsCode) return -1;
        if (bIsCode) return 1;
        return a.name.localeCompare(b.name, 'pt');
      });
      if (rows.length > 0) groups.push({ grupo, rows });
    }
    groups.sort((a, b) => a.grupo.localeCompare(b.grupo, 'pt'));
    return groups;
  }, [productsByKey, fundSeries, riskMap, riskFreeRate, codeToName, fallbackNames]);

  const summaryMaxDate = useMemo(() => {
    let max = null;
    for (const g of summaryGroups) {
      for (const r of g.rows) {
        if (!max || r.metrics.lastDate > max) max = r.metrics.lastDate;
      }
    }
    return max;
  }, [summaryGroups]);

  const heatmapScales = useMemo(() => {
    const allRows = summaryGroups.flatMap((g) => g.rows);
    function maxAbsOf(getter) {
      let max = 0;
      for (const r of allRows) {
        const v = getter(r);
        if (v !== null && v !== undefined && !isNaN(v)) max = Math.max(max, Math.abs(v));
      }
      return max || 1;
    }
    return {
      ytd: maxAbsOf((r) => r.metrics.ytd),
      oneYear: maxAbsOf((r) => r.metrics.oneYear && r.metrics.oneYear.total),
      threeYear: maxAbsOf((r) => r.metrics.threeYear && r.metrics.threeYear.annualized),
      fiveYear: maxAbsOf((r) => r.metrics.fiveYear && r.metrics.fiveYear.annualized),
      eightYear: maxAbsOf((r) => r.metrics.eightYear && r.metrics.eightYear.annualized),
      sinceInception: maxAbsOf((r) => r.metrics.sinceInceptionAnnualized),
      sharpe5: maxAbsOf((r) => r.metrics.sharpe5 && r.metrics.sharpe5.sharpe),
      sharpe8: maxAbsOf((r) => r.metrics.sharpe8 && r.metrics.sharpe8.sharpe),
    };
  }, [summaryGroups]);

  const fundCount = fundSeries.size;
  const grupoCountTotal = useMemo(() => {
    const set = new Set();
    for (const p of productsByKey.values()) if (p.grupo) set.add(p.grupo);
    return set.size;
  }, [productsByKey]);

  /* ---- Render ---- */

  return (
    <div className="dashboard">
      <style>{`
        :root {
          --bg: #EEF1EE;
          --surface: #FFFFFF;
          --ink: #16241F;
          --ink-soft: #55655D;
          --hairline: #D8DED8;
          --accent-gold: #B8862E;
          --accent-teal: #0E5C56;
          --accent-teal-soft: rgba(14,92,86,0.08);
          --positive: #1B7A4C;
          --negative: #B3261E;
        }
        * { box-sizing: border-box; }
        .dashboard {
          background: var(--bg);
          color: var(--ink);
          font-family: 'Inter', system-ui, sans-serif;
          min-height: 100vh;
          padding: 32px;
        }
        .container { max-width: 1120px; margin: 0 auto; }
        .eyebrow {
          font-family: 'IBM Plex Mono', monospace;
          text-transform: uppercase;
          letter-spacing: 0.12em;
          font-size: 11px;
          color: var(--accent-teal);
          font-weight: 600;
        }
        .title {
          font-family: 'Fraunces', serif;
          font-size: 32px;
          font-weight: 600;
          margin: 6px 0 4px;
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .summary-line {
          color: var(--ink-soft);
          font-size: 13px;
          font-family: 'IBM Plex Mono', monospace;
        }
        .header-row {
          display: flex;
          justify-content: space-between;
          align-items: flex-end;
          flex-wrap: wrap;
          gap: 16px;
          margin-bottom: 20px;
        }
        .toolbar {
          display: flex;
          gap: 10px;
          flex-wrap: wrap;
          align-items: center;
        }
        .icon-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 9px 12px;
          border: 1px solid var(--hairline);
          border-radius: 8px;
          background: var(--surface);
          font-size: 13px;
          cursor: pointer;
          color: var(--ink-soft);
        }
        .icon-btn:hover { color: var(--ink); }
        .banner {
          padding: 12px 16px;
          border-radius: 10px;
          font-size: 13px;
          display: flex;
          gap: 8px;
          align-items: flex-start;
          margin-bottom: 16px;
        }
        .banner-error { background: rgba(179,38,30,0.08); color: var(--negative); border: 1px solid rgba(179,38,30,0.25); }
        .banner-success { background: rgba(27,122,76,0.08); color: var(--positive); border: 1px solid rgba(27,122,76,0.25); }
        .banner-warning { background: rgba(184,134,46,0.1); color: #8A6416; border: 1px solid rgba(184,134,46,0.3); }
        .banner code {
          font-family: 'IBM Plex Mono', monospace;
          background: rgba(0,0,0,0.06);
          padding: 1px 5px;
          border-radius: 4px;
        }
        .spin { animation: dashboard-spin 1s linear infinite; color: var(--accent-teal); }
        @keyframes dashboard-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .situacao-tabs {
          display: inline-flex;
          gap: 4px;
          background: var(--surface);
          border: 1px solid var(--hairline);
          border-radius: 12px;
          padding: 4px;
          margin-bottom: 20px;
        }
        .situacao-tab {
          padding: 8px 18px;
          border: none;
          background: transparent;
          border-radius: 9px;
          font-size: 12.5px;
          font-weight: 600;
          letter-spacing: 0.03em;
          text-transform: uppercase;
          color: var(--ink-soft);
          cursor: pointer;
          transition: background 0.15s, color 0.15s;
          white-space: nowrap;
        }
        .situacao-tab:hover { color: var(--ink); }
        .situacao-tab.active { background: var(--ink); color: #fff; }
        .main-layout {
          display: flex;
          gap: 20px;
          align-items: flex-start;
        }
        .fund-sidebar {
          flex: 0 0 280px;
          background: var(--surface);
          border: 1px solid var(--hairline);
          border-radius: 16px;
          padding: 10px;
          max-height: 74vh;
          overflow-y: auto;
          position: sticky;
          top: 20px;
        }
        .fund-group { margin-bottom: 6px; }
        .fund-group-header {
          font-family: 'IBM Plex Mono', monospace;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          font-size: 10.5px;
          color: var(--accent-teal);
          font-weight: 600;
          padding: 10px 10px 6px;
        }
        .fund-item {
          display: block;
          width: 100%;
          text-align: left;
          padding: 8px 10px;
          border: none;
          background: transparent;
          border-radius: 8px;
          font-size: 13px;
          color: var(--ink);
          cursor: pointer;
          line-height: 1.35;
        }
        .fund-item:hover { background: var(--accent-teal-soft); }
        .fund-item.active { background: var(--ink); color: #fff; font-weight: 600; }
        .fund-sidebar-empty { padding: 20px 10px; color: var(--ink-soft); font-size: 13px; }
        .main-content { flex: 1; min-width: 0; }
        .empty-state {
          text-align: center;
          padding: 70px 20px;
          color: var(--ink-soft);
          background: var(--surface);
          border: 1px solid var(--hairline);
          border-radius: 16px;
        }
        .empty-state svg { opacity: 0.35; margin-bottom: 12px; }
        .fund-header {
          background: var(--surface);
          border: 1px solid var(--hairline);
          border-radius: 16px;
          padding: 24px;
          display: flex;
          justify-content: space-between;
          gap: 20px;
          flex-wrap: wrap;
          margin-bottom: 20px;
        }
        .fund-name { font-family: 'Fraunces', serif; font-size: 26px; font-weight: 600; }
        .fund-last-nav {
          display: flex;
          align-items: baseline;
          gap: 10px;
          margin-top: 8px;
        }
        .fund-last-nav-value {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 34px;
          font-weight: 700;
          color: var(--accent-gold);
          line-height: 1;
        }
        .fund-last-nav-date {
          font-size: 13px;
          color: var(--ink-soft);
          font-family: 'IBM Plex Mono', monospace;
        }
        .fund-meta {
          color: var(--ink-soft);
          font-size: 13px;
          font-family: 'IBM Plex Mono', monospace;
          margin-top: 6px;
        }
        .fund-hint {
          font-size: 12px;
          color: var(--negative);
          background: rgba(179,38,30,0.06);
          border: 1px solid rgba(179,38,30,0.2);
          border-radius: 8px;
          padding: 8px 10px;
          margin-top: 10px;
          max-width: 480px;
          line-height: 1.5;
        }
        .fund-badges { display: flex; gap: 8px; flex-wrap: wrap; align-items: flex-start; }
        .badge {
          display: inline-flex;
          padding: 5px 12px;
          border-radius: 999px;
          font-size: 12px;
          font-weight: 600;
          color: #fff;
          white-space: nowrap;
        }
        .badge-muted { background: var(--hairline); color: var(--ink-soft); }
        .risk-ladder { margin-top: 14px; }
        .risk-ladder-track { display: flex; gap: 4px; max-width: 320px; }
        .risk-step {
          flex: 1;
          height: 26px;
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 11px;
          font-family: 'IBM Plex Mono', monospace;
          color: rgba(0,0,0,0.5);
          opacity: 0.35;
          transition: all 0.15s;
        }
        .risk-step.active {
          opacity: 1;
          transform: scaleY(1.3);
          color: #fff;
          font-weight: 700;
          box-shadow: 0 0 0 2px var(--ink);
        }
        .risk-ladder-caption {
          font-size: 11px;
          color: var(--ink-soft);
          font-family: 'IBM Plex Mono', monospace;
          margin-top: 8px;
        }
        .card {
          background: var(--surface);
          border: 1px solid var(--hairline);
          border-radius: 16px;
          margin-bottom: 20px;
        }
        .kpi-grid {
          display: grid;
          grid-template-columns: repeat(6, 1fr);
        }
        .kpi-cell {
          padding: 18px 16px;
          border-right: 1px solid var(--hairline);
        }
        .kpi-cell:last-child { border-right: none; }
        .kpi-label {
          text-transform: uppercase;
          font-size: 10.5px;
          letter-spacing: 0.06em;
          color: var(--ink-soft);
          margin-bottom: 8px;
        }
        .kpi-value {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 21px;
          font-weight: 600;
        }
        .kpi-value.pos { color: var(--positive); }
        .kpi-value.neg { color: var(--negative); }
        .kpi-sub { font-size: 11px; color: var(--ink-soft); margin-top: 5px; }
        .sharpe-row {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
        }
        .sharpe-cell {
          padding: 18px 20px;
          border-right: 1px solid var(--hairline);
        }
        .sharpe-cell:last-child { border-right: none; }
        .sharpe-label {
          text-transform: uppercase;
          font-size: 10.5px;
          letter-spacing: 0.06em;
          color: var(--ink-soft);
          margin-bottom: 8px;
        }
        .sharpe-value {
          font-family: 'IBM Plex Mono', monospace;
          font-size: 24px;
          font-weight: 600;
        }
        .sharpe-sub { font-size: 11.5px; color: var(--ink-soft); margin-top: 6px; }
        .chart-card { padding: 20px; }
        .chart-toolbar {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 12px;
          flex-wrap: wrap;
          gap: 10px;
        }
        .chart-title {
          font-family: 'Fraunces', serif;
          font-size: 17px;
          font-weight: 600;
        }
        .range-buttons { display: flex; gap: 4px; }
        .range-btn {
          padding: 5px 12px;
          border-radius: 999px;
          font-size: 12px;
          border: 1px solid var(--hairline);
          background: var(--surface);
          cursor: pointer;
          color: var(--ink-soft);
          font-family: 'IBM Plex Mono', monospace;
        }
        .range-btn.active { background: var(--ink); color: #fff; border-color: var(--ink); }
        .chart-tooltip {
          background: var(--ink);
          color: #fff;
          padding: 8px 12px;
          border-radius: 8px;
          font-size: 12px;
        }
        .chart-tooltip-date { font-family: 'IBM Plex Mono', monospace; opacity: 0.7; margin-bottom: 2px; }
        .chart-tooltip-value { font-family: 'IBM Plex Mono', monospace; font-weight: 600; }
        .summary-toggle-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          padding: 9px 14px;
          border: 1px solid var(--ink);
          border-radius: 8px;
          background: var(--ink);
          color: #fff;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .summary-toggle-btn:hover { background: var(--accent-teal); border-color: var(--accent-teal); }
        .summary-panel {
          background: var(--surface);
          border: 1px solid var(--hairline);
          border-radius: 16px;
          padding: 20px;
        }
        .summary-panel-header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          gap: 16px;
          margin-bottom: 16px;
          flex-wrap: wrap;
        }
        .summary-table-wrap { overflow-x: auto; }
        .heatmap-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 12.5px;
        }
        .heatmap-table th, .heatmap-table td {
          border: 1px solid var(--hairline);
          padding: 6px 8px;
          text-align: center;
          white-space: nowrap;
        }
        .heatmap-table thead th {
          background: var(--ink);
          color: #fff;
          font-weight: 600;
          font-size: 11px;
          text-transform: uppercase;
          letter-spacing: 0.03em;
        }
        .heatmap-table .th-sub {
          font-size: 10px;
          font-weight: 400;
          text-transform: none;
          opacity: 0.75;
          margin-top: 2px;
        }
        .heatmap-table .group-row td {
          background: var(--accent-teal-soft);
          color: var(--accent-teal);
          font-family: 'IBM Plex Mono', monospace;
          text-transform: uppercase;
          letter-spacing: 0.06em;
          font-size: 11px;
          font-weight: 700;
          text-align: left;
        }
        .heatmap-table .fund-name-cell { text-align: left; font-weight: 500; white-space: normal; min-width: 180px; }
        .heatmap-table .mono-cell { font-family: 'IBM Plex Mono', monospace; }
        .heatmap-table .risk-cell { color: #fff; font-weight: 600; }
        .heatmap-table tbody tr:nth-child(even):not(.group-row) { background: rgba(0,0,0,0.015); }
        .print-hide { }
        @media print {
          .print-hide { display: none !important; }
          body, .dashboard { background: #fff !important; padding: 0 !important; }
          .container { max-width: none !important; }
          .summary-panel { border: none !important; padding: 0 !important; }
          .heatmap-table { font-size: 10px; }
          .heatmap-table th, .heatmap-table td { padding: 3px 5px; }
          .heatmap-table, .heatmap-table * {
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
            color-adjust: exact;
          }
          @page { size: A4 landscape; margin: 10mm; }
        }
        @media (max-width: 800px) {
          .dashboard { padding: 18px; }
          .kpi-grid { grid-template-columns: repeat(2, 1fr); }
          .kpi-cell { border-right: none; border-bottom: 1px solid var(--hairline); }
          .sharpe-row { grid-template-columns: 1fr; }
          .sharpe-cell { border-right: none; border-bottom: 1px solid var(--hairline); }
          .sharpe-cell:last-child { border-bottom: none; }
          .main-layout { flex-direction: column; }
          .fund-sidebar { flex: none; width: 100%; max-height: 260px; position: static; }
        }
      `}</style>

      <div className="container">

        <div className="header-row print-hide">
          <div>
            <div className="eyebrow">Rendibilidades e Cotações GamaLife</div>
            <div className="title"><TrendingUp size={26} color="var(--accent-gold)" />Evolução diária das unidades de conta</div>
            <div className="summary-line">
              {fundCount} fundo{fundCount === 1 ? '' : 's'}{grupoCountTotal > 0 ? ` · ${grupoCountTotal} grupo${grupoCountTotal === 1 ? '' : 's'}` : ''}
              {globalMaxDate ? ` · dados até ${formatDate(globalMaxDate)}` : ''}
            </div>
          </div>
          <div className="toolbar">
            {hasMapping && (
              <button
                className="summary-toggle-btn print-hide"
                onClick={() => setViewMode((v) => (v === 'resumo' ? 'fundo' : 'resumo'))}
              >
                {viewMode === 'resumo' ? <ArrowLeft size={15} /> : <LayoutGrid size={15} />}
                {viewMode === 'resumo' ? 'Voltar à ficha do fundo' : 'Ver resumo (mapa de calor)'}
              </button>
            )}
          </div>
        </div>

        {!SUPABASE_CONFIGURED && (
          <div className="banner banner-warning print-hide">
            <AlertCircle size={16} />
            <span>
              Base de dados partilhada ainda não configurada — substitua <code>SUPABASE_URL</code> e{' '}
              <code>SUPABASE_ANON_KEY</code> no código pelos valores do projeto Supabase.
            </span>
          </div>
        )}
        {error && (
          <div className="banner banner-error print-hide">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        {viewMode === 'fundo' && hasMapping && effectiveMappingRows.length > 0 && (
          <div className="situacao-tabs print-hide">
            {SITUACAO_OPTIONS.map((s) => (
              <button
                key={s}
                className={`situacao-tab${selectedSituacao === s ? ' active' : ''}`}
                onClick={() => setSelectedSituacao(s)}
              >
                {s}
              </button>
            ))}
          </div>
        )}

        {viewMode === 'fundo' && (!loaded ? (
          <div className="empty-state">
            <Loader2 size={40} className="spin" />
            <div style={{ fontFamily: 'Fraunces, serif', fontSize: 18, marginTop: 12 }}>A carregar…</div>
          </div>
        ) : !hasMapping ? (
          <div className="empty-state">
            <LineChartIcon size={40} />
            <div style={{ fontFamily: 'Fraunces, serif', fontSize: 18, marginBottom: 6 }}>
              Sem dados disponíveis de momento
            </div>
            <div style={{ fontSize: 13 }}>
              Volte a tentar dentro de instantes.
            </div>
          </div>
        ) : (
          <div className="main-layout">
            <div className="fund-sidebar">
              {groupedFundList.map((group) => (
                <div className="fund-group" key={group.grupo}>
                  <div className="fund-group-header">{group.grupo}</div>
                  {group.funds.map((f) => (
                    <button
                      key={f.key}
                      className={`fund-item${f.key === selectedFund ? ' active' : ''}`}
                      onClick={() => setSelectedFund(f.key)}
                    >
                      {f.label}
                    </button>
                  ))}
                </div>
              ))}
              {groupedFundList.length === 0 && (
                <div className="fund-sidebar-empty">Nenhum fundo corresponde à Situação selecionada.</div>
              )}
            </div>

            <div className="main-content">
              {!selectedFund ? (
                <div className="empty-state">
                  <LineChartIcon size={40} />
                  <div style={{ fontFamily: 'Fraunces, serif', fontSize: 18, marginBottom: 6 }}>
                    Selecione um fundo
                  </div>
                  <div style={{ fontSize: 13 }}>
                    Escolha um fundo na lista à esquerda para ver a sua evolução.
                  </div>
                </div>
              ) : metrics ? (
                <>
                  <div className="fund-header">
                    <div>
                      <div className="fund-name">{selectedFundName}</div>
                      <div className="fund-last-nav">
                        <span className="fund-last-nav-value">{formatNav(metrics.lastNav)}</span>
                        <span className="fund-last-nav-date">{formatDate(metrics.lastDate)}</span>
                      </div>
                      {metrics.historyGap && (
                        <div className="fund-meta">Cotações carregadas apenas desde {formatDate(metrics.firstDate)}</div>
                      )}
                      <RiskLadder level={currentRisk?.srri || null} />
                      {!currentRisk?.srri && selectedFund.startsWith('NM:') && (
                        <div className="fund-hint">
                          SRRI não encontrado para este fundo — o ficheiro de risco identifica os fundos por Cod_Fun;
                          carregue o ficheiro de mapeamento Produto/Fundo para ligar este nome ao respetivo código.
                        </div>
                      )}
                    </div>
                    <div className="fund-badges">
                      {currentRisk?.riskClassOverride ? (
                        <RiskClassBadge level={currentRisk.riskClassOverride} computed={false} />
                      ) : (
                        <RiskClassBadge level={metrics.computedRiskClass} computed />
                      )}
                    </div>
                  </div>
                  {!currentRisk?.riskClassOverride && !metrics.computedRiskClass && (
                    <div className="fund-hint" style={{ marginTop: -12, marginBottom: 12 }}>
                      Classe de Risco N/D — histórico de cotações insuficiente para calcular a volatilidade
                      anualizada (mínimo cerca de 30 cotações diárias).
                    </div>
                  )}

                  <div className="card">
                    <div className="kpi-grid">
                      <KpiCell
                        label="Rendibilidade YTD"
                        value={formatPercent(metrics.ytd)}
                        valueClass={returnClass(metrics.ytd)}
                        sub={metrics.ytdPartial ? 'Parcial — fundo iniciado este ano' : null}
                      />
                      <KpiCell
                        label="Rendibilidade 1 ano"
                        value={metrics.oneYear ? formatPercent(metrics.oneYear.total) : 'N/D'}
                        valueClass={metrics.oneYear ? returnClass(metrics.oneYear.total) : ''}
                      />
                      <KpiCell
                        label="Rendibilidade 3 anos"
                        value={metrics.threeYear ? formatPercent(metrics.threeYear.annualized) : 'N/D'}
                        valueClass={metrics.threeYear ? returnClass(metrics.threeYear.annualized) : ''}
                        sub={metrics.threeYear ? `Anualizada · acumulada ${formatPercent(metrics.threeYear.total)}` : 'Histórico insuficiente'}
                      />
                      <KpiCell
                        label="Rendibilidade 5 anos"
                        value={metrics.fiveYear ? formatPercent(metrics.fiveYear.annualized) : 'N/D'}
                        valueClass={metrics.fiveYear ? returnClass(metrics.fiveYear.annualized) : ''}
                        sub={metrics.fiveYear ? `Anualizada · acumulada ${formatPercent(metrics.fiveYear.total)}` : 'Histórico insuficiente'}
                      />
                      <KpiCell
                        label="Rendibilidade 8 anos"
                        value={metrics.eightYear ? formatPercent(metrics.eightYear.annualized) : 'N/D'}
                        valueClass={metrics.eightYear ? returnClass(metrics.eightYear.annualized) : ''}
                        sub={metrics.eightYear ? `Anualizada · acumulada ${formatPercent(metrics.eightYear.total)}` : 'Histórico insuficiente'}
                      />
                      <KpiCell
                        label={`Rendibilidade Desde o Início (${formatDateHyphen(metrics.inceptionDate)})`}
                        value={formatPercent(metrics.sinceInceptionTotal)}
                        valueClass={returnClass(metrics.sinceInceptionTotal)}
                        sub={metrics.historyGap
                          ? `Cotações carregadas desde ${formatDate(metrics.firstDate)}`
                          : (metrics.sinceInceptionAnnualized !== null ? `Anualizada ${formatPercent(metrics.sinceInceptionAnnualized)}` : null)}
                      />
                    </div>
                  </div>

                  <div className="card">
                    <div className="sharpe-row">
                      <div className="sharpe-cell">
                        <div className="sharpe-label">Volatilidade Anualizada (12 meses)</div>
                        <div className="sharpe-value">{metrics.computedVolatility ? formatPercent(metrics.computedVolatility) : 'N/D'}</div>
                        <div className="sharpe-sub">
                          {metrics.computedVolatility ? 'Base da Classe de Risco' : 'Histórico diário insuficiente'}
                        </div>
                      </div>
                      <div className="sharpe-cell">
                        <div className="sharpe-label">Índice de Sharpe (5 anos)</div>
                        <div className="sharpe-value">{metrics.sharpe5 ? metrics.sharpe5.sharpe.toFixed(2) : 'N/D'}</div>
                        <div className="sharpe-sub">
                          {metrics.sharpe5
                            ? `Retorno anualizado ${formatPercent(metrics.sharpe5.annualizedReturn)} · Volatilidade (5 anos) ${formatPercent(metrics.sharpe5.annualizedVol)}`
                            : 'Histórico diário insuficiente (mínimo 5 anos)'}
                        </div>
                      </div>
                      <div className="sharpe-cell">
                        <div className="sharpe-label">Índice de Sharpe (8 anos)</div>
                        <div className="sharpe-value">{metrics.sharpe8 ? metrics.sharpe8.sharpe.toFixed(2) : 'N/D'}</div>
                        <div className="sharpe-sub">
                          {metrics.sharpe8
                            ? `Retorno anualizado ${formatPercent(metrics.sharpe8.annualizedReturn)} · Volatilidade (8 anos) ${formatPercent(metrics.sharpe8.annualizedVol)}`
                            : 'Histórico diário insuficiente (mínimo 8 anos)'}
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="card chart-card">
                    <div className="chart-toolbar">
                      <div className="chart-title">Evolução da unidade de conta</div>
                      <div className="range-buttons">
                        {RANGE_OPTIONS.map((r) => (
                          <button
                            key={r}
                            className={`range-btn${chartRange === r ? ' active' : ''}`}
                            onClick={() => setChartRange(r)}
                          >
                            {r}
                          </button>
                        ))}
                      </div>
                    </div>
                    <ResponsiveContainer width="100%" height={320}>
                      <LineChart data={chartData} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
                        <CartesianGrid stroke="var(--hairline)" vertical={false} />
                        <XAxis
                          dataKey="dateISO"
                          tick={{ fontSize: 11, fill: 'var(--ink-soft)' }}
                          axisLine={{ stroke: 'var(--hairline)' }}
                          tickLine={false}
                          minTickGap={50}
                          tickFormatter={(v) => new Date(`${v}T00:00:00`).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit', year: '2-digit' })}
                        />
                        <YAxis
                          domain={['auto', 'auto']}
                          tick={{ fontSize: 11, fill: 'var(--ink-soft)' }}
                          axisLine={false}
                          tickLine={false}
                          width={64}
                          tickFormatter={(v) => v.toLocaleString('pt-PT', { maximumFractionDigits: 2 })}
                        />
                        <Tooltip content={<ChartTooltip />} />
                        <Line type="monotone" dataKey="nav" stroke="var(--accent-gold)" strokeWidth={2} dot={false} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </>
              ) : fundSeriesLoading[selectedFund] ? (
                <div className="empty-state">
                  <Loader2 size={40} className="spin" />
                  <div style={{ fontFamily: 'Fraunces, serif', fontSize: 18, marginTop: 12 }}>A carregar cotações…</div>
                </div>
              ) : (
                <div className="empty-state">
                  <LineChartIcon size={40} />
                  <div style={{ fontFamily: 'Fraunces, serif', fontSize: 18, marginBottom: 6 }}>
                    Sem cotações para {selectedFundName}
                  </div>
                  <div style={{ fontSize: 13 }}>
                    Este fundo está no mapeamento mas ainda não tem cotações publicadas.
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}

        {viewMode === 'resumo' && (
          <div className="summary-panel">
            <div className="summary-panel-header print-hide">
              <div>
                <div className="chart-title">Resumo — Fundos Em Comercialização</div>
                <div className="summary-line">
                  Agrupado por Grupo · {summaryGroups.reduce((n, g) => n + g.rows.length, 0)} fundo(s)
                  {summaryMaxDate ? ` · dados a ${formatDateHyphen(summaryMaxDate)}` : ''}
                </div>
              </div>
              <button className="icon-btn" onClick={() => window.print()}>
                <Printer size={15} /> Imprimir / Exportar PDF
              </button>
            </div>

            {summaryGroups.length === 0 && Object.keys(fundSeriesLoading).length > 0 ? (
              <div className="empty-state">
                <Loader2 size={40} className="spin" />
                <div style={{ fontFamily: 'Fraunces, serif', fontSize: 18, marginTop: 12 }}>A carregar cotações…</div>
              </div>
            ) : summaryGroups.length === 0 ? (
              <div className="empty-state">
                <LayoutGrid size={40} />
                <div style={{ fontFamily: 'Fraunces, serif', fontSize: 18, marginBottom: 6 }}>
                  Sem fundos em comercialização com cotações publicadas
                </div>
                <div style={{ fontSize: 13 }}>
                  Confirme que o mapeamento tem produtos com Situação "Em Comercialização"
                  e que existem cotações publicadas para os respetivos fundos.
                </div>
              </div>
            ) : (
              <div className="summary-table-wrap">
                <table className="heatmap-table">
                  <thead>
                    <tr>
                      <th rowSpan={2}>Fundo</th>
                      <th rowSpan={2}>
                        Valor UP
                        {summaryMaxDate ? <div className="th-sub">({formatDateHyphen(summaryMaxDate)})</div> : null}
                      </th>
                      <th colSpan={6}>Rentabilidade Anualizada</th>
                      <th rowSpan={2}>Data de Início</th>
                      <th rowSpan={2}>Indicador Sumário de Risco</th>
                      <th rowSpan={2}>Classe de Risco</th>
                      <th colSpan={2}>Índice de Sharpe</th>
                    </tr>
                    <tr>
                      <th>YTD</th>
                      <th>1 ano</th>
                      <th>3 anos</th>
                      <th>5 anos</th>
                      <th>8 anos</th>
                      <th>Início do Fundo</th>
                      <th>5 anos</th>
                      <th>8 anos</th>
                    </tr>
                  </thead>
                  {summaryGroups.map((group) => (
                    <tbody key={group.grupo}>
                      <tr className="group-row">
                        <td colSpan={13}>{group.grupo}</td>
                      </tr>
                      {group.rows.map((r) => (
                        <tr key={r.key}>
                          <td className="fund-name-cell">{r.name}</td>
                          <td className="mono-cell">{formatNav(r.metrics.lastNav)}</td>
                          <td className="mono-cell" style={{ background: heatReturnColor(r.metrics.ytd, heatmapScales.ytd) }}>
                            {formatPercent(r.metrics.ytd)}
                          </td>
                          <td className="mono-cell" style={{ background: heatReturnColor(r.metrics.oneYear && r.metrics.oneYear.total, heatmapScales.oneYear) }}>
                            {r.metrics.oneYear ? formatPercent(r.metrics.oneYear.total) : 'N/D'}
                          </td>
                          <td className="mono-cell" style={{ background: heatReturnColor(r.metrics.threeYear && r.metrics.threeYear.annualized, heatmapScales.threeYear) }}>
                            {r.metrics.threeYear ? formatPercent(r.metrics.threeYear.annualized) : 'N/D'}
                          </td>
                          <td className="mono-cell" style={{ background: heatReturnColor(r.metrics.fiveYear && r.metrics.fiveYear.annualized, heatmapScales.fiveYear) }}>
                            {r.metrics.fiveYear ? formatPercent(r.metrics.fiveYear.annualized) : 'N/D'}
                          </td>
                          <td className="mono-cell" style={{ background: heatReturnColor(r.metrics.eightYear && r.metrics.eightYear.annualized, heatmapScales.eightYear) }}>
                            {r.metrics.eightYear ? formatPercent(r.metrics.eightYear.annualized) : 'N/D'}
                          </td>
                          <td className="mono-cell" style={{ background: heatReturnColor(r.metrics.sinceInceptionAnnualized, heatmapScales.sinceInception) }}>
                            {r.metrics.sinceInceptionAnnualized !== null ? formatPercent(r.metrics.sinceInceptionAnnualized) : 'N/D'}
                          </td>
                          <td className="mono-cell">{formatDateHyphen(r.metrics.inceptionDate)}</td>
                          <td
                            className="mono-cell risk-cell"
                            style={r.srri ? { background: SRRI_COLORS[r.srri - 1] } : undefined}
                          >
                            {r.srri ? `${r.srri}/7` : 'N/D'}
                          </td>
                          <td
                            className="mono-cell risk-cell"
                            style={r.riskClass ? { background: SRRI_COLORS[r.riskClass - 1] } : undefined}
                          >
                            {r.riskClass ? `${r.riskClass}/7` : 'N/D'}
                          </td>
                          <td className="mono-cell" style={{ background: heatReturnColor(r.metrics.sharpe5 && r.metrics.sharpe5.sharpe, heatmapScales.sharpe5) }}>
                            {r.metrics.sharpe5 ? r.metrics.sharpe5.sharpe.toFixed(2) : 'N/D'}
                          </td>
                          <td className="mono-cell" style={{ background: heatReturnColor(r.metrics.sharpe8 && r.metrics.sharpe8.sharpe, heatmapScales.sharpe8) }}>
                            {r.metrics.sharpe8 ? r.metrics.sharpe8.sharpe.toFixed(2) : 'N/D'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  ))}
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
