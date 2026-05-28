// ═══════════════════════════════════════════════════════════════════════════
//  Table Lens — implementação fiel a Rao & Card (1994)
//  "The Table Lens: Merging Graphical and Symbolic Representations
//   in an Interactive Focus+Context Visualization for Tabular Information"
//
//  Princípios centrais implementados:
//  1. DOI de BLOCO PULSO (step function) — não gaussiano
//  2. Transfer function = integral do DOI normalizada (seção 2 do paper)
//  3. Distorção independente em X (colunas) e Y (linhas)
//  4. 4 tipos de célula: focal / row-focal / col-focal / nonfocal
//  5. Barras para quantitativas; swatches coloridos para categóricas
//  6. Células focais: texto + gráfico; não-focais: miniatura gráfica
//  7. Ordenação interativa por coluna
//  8. Fullscreen fit-to-viewport determinístico (sem overflow jamais)
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

// ── Estado global ────────────────────────────────────────────────────────────
let sortCol   = null;
let sortAsc   = true;
let colTypes  = {};
let viewMode  = 'fit';

// Foco: índices de linha/coluna que estão na área focal
// Seguindo o paper: foco é uma "span" de células contíguas
let focusRowStart = null;   // linha inicial do foco (null = sem foco)
let focusRowEnd   = null;   // linha final do foco (inclusive)
let focusColStart = null;   // coluna inicial do foco (null = sem foco col)
let focusColEnd   = null;   // coluna final do foco (inclusive)

// Para interação hover no fullscreen
let hoverRowIdx  = null;
let _rafPending  = false;

// Expandido (modo scroll/fit clássico)
let expandedRow  = null;

// indexCol, rawData, columns declarados em preprocessar.js
// ─────────────────────────────────────────────────────────────────────────────

// ── Constantes do layout (calibradas pelo paper) ──────────────────────────
const FOCAL_ROW_H   = 56;   // altura de linha focal (px) — detalhe completo
const SEMI_ROW_H    = 18;   // altura row-focal (px) — barra + valor curto
const CONTEXT_ROW_H = 4;    // altura não-focal (px) — miniatura
const MIN_ROW_H     = 3;    // mínimo absoluto (px)

const FOCAL_COL_W   = 160;  // largura de coluna focal (px)
const CONTEXT_COL_W = 60;   // largura de coluna não-focal (px)

const TH_H = 38;            // altura do cabeçalho (px)
const FS_BAR_H = 28;        // barra inferior no fullscreen

// ── Modos de viewport ────────────────────────────────────────────────────────
function setViewMode(mode) {
  viewMode = mode;
  document.querySelectorAll('.vm-btn').forEach(btn =>
    btn.classList.toggle('vm-btn-active', btn.dataset.mode === mode)
  );
  const isFS = mode === 'fullscreen';
  document.body.classList.toggle('tl-fullscreen-active', isFS);
  if (isFS) {
    // Foco inicial: meio do dataset
    const mid = Math.floor(rawData.length / 2);
    setRowFocus(mid, mid);
  } else {
    hoverRowIdx = null;
  }
  renderTable();
}

// ── DOI & Transfer Function (Rao & Card 1994, seção "Distortion Function Framework") ──
/**
 * Calcula o vetor de alturas de linhas usando DOI de BLOCO PULSO.
 * O paper descreve que células focais têm nível DOI alto e contexto tem nível baixo.
 * A transfer function é a integral do DOI normalizada para caber em availableH.
 *
 * @param {number} nRows
 * @param {number} focusStart  - índice de início do bloco focal
 * @param {number} focusEnd    - índice de fim do bloco focal (inclusive)
 * @param {number} availableH  - pixels totais disponíveis para o tbody
 * @returns {number[]}         - alturas em px, soma === availableH
 */
function calcRowHeights(nRows, focusStart, focusEnd, availableH) {
  if (nRows === 0) return [];

  const fs   = Math.max(0, focusStart ?? 0);
  const fe   = Math.min(nRows - 1, focusEnd ?? 0);
  const nFoc = fe - fs + 1;
  const nCtx = nRows - nFoc;

  // DOI: focal = FOCAL_ROW_H, contexto próximo = SEMI_ROW_H, distante = CONTEXT_ROW_H
  // Implementamos 3 zonas: focal / semi (±3 linhas ao redor) / context
  const SEMI_BAND = 3;
  const weights = new Array(nRows);
  for (let i = 0; i < nRows; i++) {
    if (i >= fs && i <= fe) {
      weights[i] = FOCAL_ROW_H;
    } else {
      const dist = i < fs ? fs - i : i - fe;
      if (dist <= SEMI_BAND) {
        // interpolação linear entre FOCAL e CONTEXT conforme distância
        const t = dist / SEMI_BAND;
        weights[i] = SEMI_ROW_H * (1 - t) + CONTEXT_ROW_H * t;
      } else {
        weights[i] = CONTEXT_ROW_H;
      }
    }
  }

  // Normaliza (transfer function = integral do DOI / espaço total)
  const totalW = weights.reduce((a, b) => a + b, 0);
  const scale  = availableH / totalW;
  const heights = weights.map(w => Math.max(MIN_ROW_H, w * scale));

  // Correção de fechamento exato (arredondamento pode criar 1-2px de desvio)
  const curSum = heights.reduce((a, b) => a + b, 0);
  const diff   = availableH - curSum;
  // distribui o resíduo na linha focal
  heights[fs] = Math.max(MIN_ROW_H, heights[fs] + diff);

  return heights;
}

/**
 * Calcula larguras de colunas usando DOI de bloco pulso (eixo X independente).
 * Focal columns → FOCAL_COL_W; nonfocal → CONTEXT_COL_W.
 * Normaliza para caber em availableW.
 *
 * @param {string[]} cols
 * @param {number}   focusStart  - índice de coluna inicial focal (ou null)
 * @param {number}   focusEnd    - índice de coluna final focal (inclusive)
 * @param {number}   availableW  - pixels totais disponíveis para colunas de dados
 * @param {number}   indexColW   - largura reservada para coluna de índice
 * @returns {number[]}           - larguras em px
 */
function calcColWidths(cols, focusStart, focusEnd, availableW, indexColW) {
  const n = cols.length;
  if (n === 0) return [];

  const fs = focusStart ?? null;
  const fe = focusEnd   ?? null;

  const weights = cols.map((_, i) => {
    if (fs !== null && i >= fs && i <= fe) return FOCAL_COL_W;
    return CONTEXT_COL_W;
  });

  const totalW = weights.reduce((a, b) => a + b, 0);
  const scale  = (availableW - indexColW) / totalW;
  const widths = weights.map(w => Math.max(30, w * scale));

  // correção de fechamento
  const curSum = widths.reduce((a, b) => a + b, 0);
  widths[0] = Math.max(30, widths[0] + (availableW - indexColW - curSum));

  return widths;
}

// ── Helpers de foco ──────────────────────────────────────────────────────────
function setRowFocus(start, end) {
  focusRowStart = start;
  focusRowEnd   = end ?? start;
}

function clearRowFocus() {
  focusRowStart = null;
  focusRowEnd   = null;
}

// ── Tipo de região da célula (paper: focal / row-focal / col-focal / nonfocal) ──
function cellRegion(rowIdx, colIdx) {
  const rowFocal = focusRowStart !== null && rowIdx >= focusRowStart && rowIdx <= focusRowEnd;
  const colFocal = focusColStart !== null && colIdx >= focusColStart && colIdx <= focusColEnd;

  if (rowFocal && colFocal) return 'focal';
  if (rowFocal)             return 'row-focal';
  if (colFocal)             return 'col-focal';
  return 'nonfocal';
}

// ── Paleta de colunas quantitativas (azul / amarelo / verde — sem repetir vizinhos) ──
// Três cores sólidas que se alternam garantindo que colunas adjacentes nunca tenham a mesma cor.
const COL_PALETTE = [
  '#3b82f6',  // azul
  '#eab308',  // amarelo
  '#22c55e',  // verde
];

// Sequência que nunca repete a cor vizinha: 0,1,2,0,1,2,...
// Para colunas com tipo quantitativo, mapeia o índice ordinal da coluna numérica
// dentro do conjunto de colunas visíveis, garantindo alternância.
let _numColIndex = {};  // col → índice ordinal entre colunas numéricas

function buildNumColIndex() {
  _numColIndex = {};
  let ni = 0;
  columns.forEach(col => {
    if ((colTypes[col] || 'nominal') === 'quantitative') {
      _numColIndex[col] = ni++;
    }
  });
}

function colBarColor(col) {
  const idx = _numColIndex[col] ?? 0;
  return COL_PALETTE[idx % COL_PALETTE.length];
}

// ── Estatísticas e caches ────────────────────────────────────────────────────
let statsCache = {};  // col → { min, max, mean }
let catCache   = {};  // col → { value → position 0..1 }
let catColors  = {};  // col → { value → hsl string }

function buildStatsCache() {
  statsCache = {};
  catCache   = {};
  catColors  = {};
  buildNumColIndex();

  columns.forEach(col => {
    const vals     = rawData.map(r => r[col]);
    const nonEmpty = vals.filter(v => v !== '' && v !== null && v !== undefined);
    const type     = colTypes[col] || 'nominal';

    if (type === 'quantitative') {
      const nums = nonEmpty.map(v => parseFloat(v)).filter(v => !isNaN(v));
      if (nums.length > 0) {
        const min  = Math.min(...nums);
        const max  = Math.max(...nums);
        const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
        statsCache[col] = { min, max, mean };
      }
    } else {
      // Nominal / ordinal: mapeia cada categoria a uma posição 0..1 (swatch position)
      const cats = [...new Set(nonEmpty)].sort();
      const posMap   = {};
      const colorMap = {};
      cats.forEach((cat, i) => {
        posMap[cat]   = cats.length <= 1 ? 0.5 : i / (cats.length - 1);
        colorMap[cat] = categoryHue(i, cats.length);
      });
      catCache[col]  = posMap;
      catColors[col] = colorMap;
    }
  });
}

function categoryHue(index, total) {
  // Cores distintas para categorias — golden ratio para distribuição uniforme
  const hue = (index * 137.508) % 360;
  return `hsl(${Math.round(hue)},60%,55%)`;
}

// ── Renderização de células (paper: representação gráfica × região) ──────────
/**
 * Célula FOCAL: texto + gráfico completo (barra proporcional ou swatch)
 * Corresponde à célula "focal" do paper — detalhe máximo
 */
function renderCellFocal(col, value, rowH) {
  const td = document.createElement('td');
  td.className = 'tl-cell tl-cell-focal';

  const stats = statsCache[col];
  if (stats !== undefined && value !== '' && !isNaN(parseFloat(value))) {
    // QUANTITATIVO: barra sólida + texto (paper: "bar representation")
    const num   = parseFloat(value);
    const norm  = stats.max === stats.min ? 0.5 : (num - stats.min) / (stats.max - stats.min);
    const pct   = Math.round(norm * 100);
    const color = colBarColor(col);  // cor sólida da paleta da coluna
    const label = Number.isInteger(num) ? String(num) : num.toFixed(2);
    td.innerHTML = `
      <div class="tl-bar-track">
        <div class="tl-bar-fill" style="width:${pct}%;background:${color}"></div>
      </div>
      <div class="tl-focal-meta">
        <span class="tl-focal-val">${label}</span>
        <span class="tl-focal-range">↕ ${stats.min} – ${stats.max}</span>
      </div>`;
  } else if (value !== '' && value !== null && value !== undefined) {
    // CATEGÓRICO: swatch colorido + texto (paper: "colored swatch")
    const posMap   = catCache[col]   || {};
    const colorMap = catColors[col]  || {};
    const pos      = posMap[value]   ?? 0.5;
    const color    = colorMap[value] ?? '#94a3b8';
    const xPct     = Math.round(pos * 80) + 10; // mantém swatch dentro dos limites
    td.innerHTML = `
      <div class="tl-swatch-track">
        <div class="tl-swatch" style="left:${xPct}%;background:${color}"></div>
      </div>
      <div class="tl-focal-val-cat" style="color:${color}">${value}</div>`;
  } else {
    td.innerHTML = `<div class="tl-focal-missing">—</div>`;
  }
  return td;
}

/**
 * Célula ROW-FOCAL: linha está em foco mas coluna não
 * Mostra barra reduzida + valor abreviado
 */
function renderCellRowFocal(col, value, rowH) {
  const td = document.createElement('td');
  td.className = 'tl-cell tl-cell-row-focal';

  const stats = statsCache[col];
  if (stats !== undefined && value !== '' && !isNaN(parseFloat(value))) {
    const num   = parseFloat(value);
    const norm  = stats.max === stats.min ? 0.5 : (num - stats.min) / (stats.max - stats.min);
    const pct   = Math.round(norm * 100);
    const color = colBarColor(col);
    const barH  = Math.max(3, rowH - 16);
    const label = Number.isInteger(num) ? String(num) : num.toFixed(1);
    td.innerHTML = `
      <div class="tl-bar-track" style="height:${barH}px">
        <div class="tl-bar-fill" style="width:${pct}%;background:${color};height:100%"></div>
      </div>
      <div class="tl-row-focal-val">${label}</div>`;
  } else if (value !== '' && value !== null && value !== undefined) {
    const colorMap = catColors[col]  || {};
    const posMap   = catCache[col]   || {};
    const color    = colorMap[value] ?? '#94a3b8';
    const pos      = posMap[value]   ?? 0.5;
    const xPct     = Math.round(pos * 80) + 10;
    td.innerHTML = `
      <div class="tl-swatch-track" style="height:${Math.max(4, rowH-14)}px">
        <div class="tl-swatch-sm" style="left:${xPct}%;background:${color}"></div>
      </div>
      <div class="tl-row-focal-val">${String(value).slice(0, 10)}</div>`;
  } else {
    td.innerHTML = `<div class="tl-row-focal-val tl-missing">—</div>`;
  }
  return td;
}

/**
 * Célula COL-FOCAL: coluna em foco mas linha não
 * Mostra barra + valor, sem expansão vertical extra
 */
function renderCellColFocal(col, value, rowH) {
  const td = document.createElement('td');
  td.className = 'tl-cell tl-cell-col-focal';

  const stats = statsCache[col];
  if (stats !== undefined && value !== '' && !isNaN(parseFloat(value))) {
    const num   = parseFloat(value);
    const norm  = stats.max === stats.min ? 0.5 : (num - stats.min) / (stats.max - stats.min);
    const pct   = Math.round(norm * 100);
    const color = colBarColor(col);
    const h = Math.max(2, rowH - 2);
    td.innerHTML = `<div class="tl-bar-track" style="height:${h}px">
      <div class="tl-bar-fill" style="width:${pct}%;background:${color};height:100%"></div>
    </div>`;
  } else if (value !== '' && value !== null && value !== undefined) {
    const colorMap = catColors[col] || {};
    const posMap   = catCache[col]  || {};
    const color    = colorMap[value] ?? '#94a3b8';
    const pos      = posMap[value]  ?? 0.5;
    const xPct     = Math.round(pos * 80) + 10;
    const h        = Math.max(2, rowH - 2);
    td.innerHTML   = `<div class="tl-swatch-track" style="height:${h}px">
      <div class="tl-swatch-sm" style="left:${xPct}%;background:${color}"></div>
    </div>`;
  }
  return td;
}

/**
 * Célula NONFOCAL: contexto — apenas marca gráfica mínima
 * Paper: "nonfocal cells: just a minimal mark"
 */
function renderCellNonfocal(col, value, rowH) {
  const td = document.createElement('td');
  td.className = 'tl-cell tl-cell-nonfocal';

  const stats = statsCache[col];
  const h = Math.max(1, rowH - 1);

  if (stats !== undefined && value !== '' && !isNaN(parseFloat(value))) {
    const num   = parseFloat(value);
    const norm  = stats.max === stats.min ? 0.5 : (num - stats.min) / (stats.max - stats.min);
    const pct   = Math.round(norm * 100);
    const color = colBarColor(col);
    td.innerHTML = `<div class="tl-bar-track" style="height:${h}px">
      <div class="tl-bar-fill" style="width:${pct}%;background:${color};height:100%"></div>
    </div>`;
  } else if (value !== '' && value !== null && value !== undefined) {
    const colorMap = catColors[col] || {};
    const posMap   = catCache[col]  || {};
    const color    = colorMap[value] ?? '#94a3b8';
    const pos      = posMap[value]  ?? 0.5;
    const xPct     = Math.round(pos * 80) + 10;
    td.innerHTML   = `<div class="tl-swatch-track" style="height:${h}px">
      <div class="tl-swatch-xs" style="left:${xPct}%;background:${color}"></div>
    </div>`;
  } else {
    td.innerHTML = `<div class="tl-missing-mark" style="height:${h}px"></div>`;
  }
  return td;
}

// ── Seletor de renderização por região ───────────────────────────────────────
function renderCell(col, value, region, rowH) {
  switch (region) {
    case 'focal':     return renderCellFocal(col, value, rowH);
    case 'row-focal': return renderCellRowFocal(col, value, rowH);
    case 'col-focal': return renderCellColFocal(col, value, rowH);
    default:          return renderCellNonfocal(col, value, rowH);
  }
}

// ── Editor de tipo inline ────────────────────────────────────────────────────
function openTypeEditor(col, anchorEl, event) {
  event.stopPropagation();
  document.getElementById('tl-type-editor')?.remove();

  const currentType = colTypes[col] || 'categorical';
  const editor = document.createElement('div');
  editor.id = 'tl-type-editor';
  editor.className = 'tl-type-editor';
  editor.dataset.col = col;
  editor.innerHTML = `
    <div class="tl-type-editor-title">Tipo de <strong>${col}</strong></div>
    ${[['quantitative','📊','Quantitativo'],['nominal','🔤','Nominal'],['ordinal','🔢','Ordinal']].map(([t,ic,lb])=>`
      <div class="tl-type-opt ${currentType===t?'tl-type-opt-active':''}" data-type="${t}">
        <span>${ic}</span> ${lb}
      </div>`).join('')}`;

  const rect = anchorEl.getBoundingClientRect();
  editor.style.cssText = `top:${rect.bottom+4}px;left:${rect.left}px;position:fixed;`;
  document.body.appendChild(editor);

  editor.querySelectorAll('.tl-type-opt').forEach(opt => {
    opt.addEventListener('click', e => {
      e.stopPropagation();
      colTypes[col] = opt.dataset.type;
      if (typeof colMeta !== 'undefined') {
        const m = colMeta.find(m => m.col === col);
        if (m) { m.type = opt.dataset.type; }
      }
      editor.remove();
      buildStatsCache();
      renderTable();
    });
  });

  setTimeout(() => document.addEventListener('click', () =>
    document.getElementById('tl-type-editor')?.remove(), { once: true }), 0);
}

// ── Stats panel ──────────────────────────────────────────────────────────────
function renderStats() {
  document.getElementById('stats-panel').innerHTML = '';
}

// ════════════════════════════════════════════════════════════════════════════
//  RENDERIZAÇÃO PRINCIPAL
// ════════════════════════════════════════════════════════════════════════════
function renderTable() {
  buildStatsCache();

  const container = document.getElementById('table-lens-container');
  container.innerHTML = '';

  if (!rawData || rawData.length === 0) return;

  const visCols = columns.filter(c => c !== indexCol);
  const nRows   = rawData.length;
  const nCols   = visCols.length;
  const isFit   = viewMode === 'fit';
  const isScroll = viewMode === 'scroll';
  const isFS    = viewMode === 'fullscreen';

  // ── Geometria do container ──────────────────────────────────────────────
  let containerW, containerH;

  if (isFS) {
    containerW = window.innerWidth;
    containerH = window.innerHeight;
    Object.assign(container.style, {
      position: 'fixed', inset: '0',
      width: '100vw', height: '100vh',
      overflow: 'hidden',
      zIndex: '1000',
      background: '#fff',
      borderRadius: '0',
    });
  } else {
    const card    = container.closest('.card');
    const cardR   = card.getBoundingClientRect();
    const toolH   = card.querySelector('.toolbar')?.offsetHeight || 0;
    const statsH  = document.getElementById('stats-panel')?.offsetHeight || 0;
    containerW = cardR.width - 4;
    containerH = isScroll
      ? Math.round(window.innerHeight * 0.72)
      : Math.max(200, window.innerHeight - cardR.top - toolH - statsH - 40);

    Object.assign(container.style, {
      overflow:     isScroll ? 'auto' : 'hidden',
      position:     '',
      inset:        '',
      width:        containerW + 'px',
      height:       isFit ? containerH + 'px' : 'auto',
      maxHeight:    isScroll ? containerH + 'px' : '',
      zIndex:       '',
      background:   '',
      borderRadius: '',
    });
  }

  // ── Alturas (DOI de bloco pulso — eixo Y) ──────────────────────────────
  const tbodyH = isFS
    ? containerH - TH_H - FS_BAR_H
    : isFit
      ? containerH - TH_H
      : null;  // scroll: sem restrição

  let rowHeights = null;
  const hasFocus = focusRowStart !== null;

  if (hasFocus && tbodyH !== null) {
    rowHeights = calcRowHeights(nRows, focusRowStart, focusRowEnd, tbodyH);
  } else if (hasFocus && isScroll) {
    // No scroll, simula alturas mas sem normalização (pode scrollar)
    rowHeights = rawData.map((_, i) => {
      if (i >= focusRowStart && i <= focusRowEnd) return FOCAL_ROW_H;
      const dist = i < focusRowStart ? focusRowStart - i : i - focusRowEnd;
      if (dist <= 3) return SEMI_ROW_H;
      return CONTEXT_ROW_H;
    });
  }

  // ── Larguras (DOI de bloco pulso — eixo X) ──────────────────────────────
  const idxColW = indexCol ? Math.min(140, Math.max(60, Math.round(containerW * 0.10))) : 0;
  const dataW   = containerW - idxColW;
  const colWidths = calcColWidths(visCols, focusColStart, focusColEnd, dataW + idxColW, idxColW);

  // ── Criar tabela ────────────────────────────────────────────────────────
  const table = document.createElement('table');
  table.className = 'tl-table' + (isFS ? ' tl-table-fs' : '');
  table.style.cssText = `
    table-layout: fixed;
    width: 100%;
    height: ${isFS ? 'calc(100vh - ' + (TH_H + FS_BAR_H) + 'px)' : '100%'};
    border-collapse: collapse;
  `;

  // ── Cabeçalho ────────────────────────────────────────────────────────────
  const thead   = document.createElement('thead');
  const headRow = document.createElement('tr');
  headRow.style.height = TH_H + 'px';

  if (indexCol) {
    const th = document.createElement('th');
    th.className = 'tl-th tl-th-index';
    th.style.width = idxColW + 'px';
    th.innerHTML = `<div class="tl-th-inner"><span class="tl-th-label">${indexCol}</span></div>`;
    headRow.appendChild(th);
  }

  visCols.forEach((col, ci) => {
    const th = document.createElement('th');
    th.className = 'tl-th';
    th.style.width = colWidths[ci] + 'px';

    const isNum   = statsCache[col] !== undefined;
    const arrow   = col === sortCol ? (sortAsc ? ' ↑' : ' ↓') : '';
    const typeIcon = { quantitative: '📊', nominal: '🔤', ordinal: '🔢' }[colTypes[col] || 'nominal'];
    const isFocal = focusColStart !== null && ci >= focusColStart && ci <= focusColEnd;

    th.innerHTML = `
      <div class="tl-th-inner ${isFocal ? 'tl-th-focal' : ''}">
        <div class="tl-th-top">
          <span class="tl-th-label">${col}${arrow}</span>
          <button class="tl-type-btn" title="Editar tipo">${typeIcon}</button>
        </div>
        ${isNum ? `<span class="tl-th-stats">ø ${statsCache[col].mean.toFixed(1)} [${statsCache[col].min}–${statsCache[col].max}]</span>` : ''}
      </div>`;

    th.querySelector('.tl-type-btn').addEventListener('click', e => openTypeEditor(col, e.currentTarget, e));
    th.addEventListener('click', e => {
      if (e.target.classList.contains('tl-type-btn')) return;
      sortByColumn(col);
    });
    // Clique duplo no header: foca na coluna (eixo X)
    th.addEventListener('dblclick', e => {
      e.preventDefault();
      if (focusColStart === ci) {
        focusColStart = null; focusColEnd = null;
      } else {
        focusColStart = ci; focusColEnd = ci;
      }
      renderTable();
    });

    headRow.appendChild(th);
  });

  thead.appendChild(headRow);
  table.appendChild(thead);

  // ── Tbody ───────────────────────────────────────────────────────────────
  const tbody = document.createElement('tbody');

  rawData.forEach((row, ri) => {
    const tr = document.createElement('tr');
    tr.dataset.idx = ri;

    const rowH = rowHeights ? Math.round(rowHeights[ri]) : CONTEXT_ROW_H;
    const isFocalRow = hasFocus && ri >= focusRowStart && ri <= focusRowEnd;

    // Classe de região para estilização CSS
    tr.className = 'tl-row'
      + (isFocalRow ? ' tl-row-focal' : ' tl-row-context')
      + (!hasFocus  ? ' tl-row-no-focus' : '');

    tr.style.height    = rowH + 'px';
    tr.style.maxHeight = rowH + 'px';
    tr.style.overflow  = 'hidden';

    // Interação: clique foca a linha
    tr.addEventListener('click', () => {
      if (isFocalRow && focusRowStart === ri && focusRowEnd === ri) {
        clearRowFocus();
      } else {
        setRowFocus(ri, ri);
      }
      renderTable();
    });

    // Célula de índice
    if (indexCol) {
      const tdIdx = document.createElement('td');
      tdIdx.className = 'tl-cell tl-cell-index' + (isFocalRow ? ' tl-idx-focal' : '');
      tdIdx.style.width = idxColW + 'px';
      if (rowH >= 10) {
        tdIdx.textContent = row[indexCol] !== undefined ? String(row[indexCol]) : '';
      }
      tr.appendChild(tdIdx);
    }

    // Células de dados: região determinada pela posição relativa ao foco em X e Y
    visCols.forEach((col, ci) => {
      const region = cellRegion(ri, ci);
      const value  = row[col] !== undefined ? String(row[col]) : '';
      const cell   = renderCell(col, value, region, rowH);
      cell.style.width    = colWidths[ci] + 'px';
      cell.style.maxWidth = colWidths[ci] + 'px';
      tr.appendChild(cell);
    });

    tbody.appendChild(tr);
  });

  // Hover no tbody (fullscreen e fit): move o foco linha a linha
  tbody.addEventListener('mousemove', e => {
    if (!isFS && !isFit) return;
    const tr = e.target.closest('tr[data-idx]');
    if (!tr) return;
    const idx = parseInt(tr.dataset.idx);
    if (isNaN(idx) || idx === hoverRowIdx) return;
    hoverRowIdx = idx;
    if (!_rafPending) {
      _rafPending = true;
      requestAnimationFrame(() => {
        setRowFocus(hoverRowIdx, hoverRowIdx);
        _rafPending = false;
        renderTable();
      });
    }
  });

  tbody.addEventListener('mouseleave', () => {
    if (!isFS) return;
    // No fullscreen mantém o último foco por click; hover apenas move
  });

  table.appendChild(tbody);
  container.appendChild(table);

  // ── Barra inferior do fullscreen ────────────────────────────────────────
  if (isFS) {
    const bar = document.createElement('div');
    bar.className = 'tl-fs-bar';
    bar.innerHTML = `
      <span class="tl-fs-hint">▲▼ / PgUp/Dn / Home/End para navegar · Duplo clique no cabeçalho foca coluna · ESC para fechar</span>
      <button class="tl-fs-close" id="tl-fs-close-btn">✕ Fechar</button>`;
    container.appendChild(bar);
    document.getElementById('tl-fs-close-btn')
      .addEventListener('click', e => { e.stopPropagation(); setViewMode('fit'); });
    bindFisheyeKeys();
  }

  bindSearch();
}

// ── Teclado no fullscreen ────────────────────────────────────────────────────
function bindFisheyeKeys() {
  document.onkeydown = null;
  document.onkeydown = e => {
    if (viewMode !== 'fullscreen') return;
    const n = rawData.length;
    if (!n) return;
    const cur = focusRowStart ?? Math.floor(n / 2);
    if (e.key === 'Escape')    { setViewMode('fit'); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setRowFocus(Math.min(n-1, cur+1)); renderTable(); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setRowFocus(Math.max(0, cur-1));   renderTable(); }
    if (e.key === 'PageDown')  { e.preventDefault(); setRowFocus(Math.min(n-1, cur+10)); renderTable(); }
    if (e.key === 'PageUp')    { e.preventDefault(); setRowFocus(Math.max(0, cur-10));   renderTable(); }
    if (e.key === 'Home')      { e.preventDefault(); setRowFocus(0);    renderTable(); }
    if (e.key === 'End')       { e.preventDefault(); setRowFocus(n-1);  renderTable(); }
  };
}

// ── Busca ────────────────────────────────────────────────────────────────────
function bindSearch() {
  const input = document.getElementById('search-input');
  const fresh = input.cloneNode(true);
  input.parentNode.replaceChild(fresh, input);
  fresh.addEventListener('input', () => {
    const q = fresh.value.toLowerCase();
    document.querySelectorAll('.tl-row').forEach(tr => {
      const ri  = parseInt(tr.dataset.idx);
      const row = rawData[ri];
      if (!row) return;
      const match = columns.some(col => String(row[col] ?? '').toLowerCase().includes(q));
      tr.style.display = match ? '' : 'none';
    });
  });
}

// ── Ordenação ────────────────────────────────────────────────────────────────
function sortByColumn(col) {
  sortAsc  = sortCol === col ? !sortAsc : true;
  sortCol  = col;
  clearRowFocus();
  hoverRowIdx = null;

  rawData.sort((a, b) => {
    const av = a[col], bv = b[col];
    const an = parseFloat(av), bn = parseFloat(bv);
    const cmp = !isNaN(an) && !isNaN(bn)
      ? an - bn
      : String(av ?? '').localeCompare(String(bv ?? ''));
    return sortAsc ? cmp : -cmp;
  });

  renderTable();
}

// ── Redimensionamento ────────────────────────────────────────────────────────
let _resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (rawData?.length > 0) renderTable();
  }, 100);
});

// ── Compat com preprocessar.js ───────────────────────────────────────────────
function toggleFocusMode()   { clearRowFocus(); renderTable(); }
function toggleFisheyeMode() { clearRowFocus(); renderTable(); }
