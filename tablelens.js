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
//
//  Otimizações de performance:
//  - statsCache lazy: só reconstrói quando invalidado (buildStatsCache é no-op se válido)
//  - applyFocusPatch: no hover/teclado, atualiza SOMENTE height+classe+conteúdo das
//    linhas que mudaram de região — sem recriar nenhum elemento DOM
//  - Math.min/max via loop (evita stack overflow com spread em arrays grandes)
//  - Delegação de eventos no tbody (um listener, não N por linha)
//  - colWidths e rowHeights cacheados entre patches se container não mudou
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

// ── Estado global ────────────────────────────────────────────────────────────
let sortCol   = null;
let sortAsc   = true;
let colTypes  = {};
let viewMode  = 'fit';

let focusRowStart = null;
let focusRowEnd   = null;
let focusColStart = null;
let focusColEnd   = null;

let hoverRowIdx  = null;
let _rafPending  = false;
let expandedRow  = null;

// indexCol, rawData, columns declarados em preprocessar.js

// ── Constantes do layout ──────────────────────────────────────────────────
const FOCAL_ROW_H   = 56;
const SEMI_ROW_H    = 18;
const CONTEXT_ROW_H = 4;
const MIN_ROW_H     = 3;
const SEMI_BAND     = 3;

const FOCAL_COL_W   = 160;
const CONTEXT_COL_W = 60;

const TH_H     = 38;
const FS_BAR_H = 28;

// ── Cache de stats (lazy / invalidável) ──────────────────────────────────────
let statsCache    = {};
let catCache      = {};
let catColors     = {};
let _statsDirty   = true;   // flag: true → precisa recalcular
let _numColIndex  = {};

/** Invalida o cache de stats (chamar após mudança de tipo ou de dados) */
function invalidateStats() { _statsDirty = true; }

function _safeMin(arr) {
  let m = Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] < m) m = arr[i];
  return m;
}
function _safeMax(arr) {
  let m = -Infinity;
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}

function buildNumColIndex() {
  _numColIndex = {};
  let ni = 0;
  columns.forEach(col => {
    if ((colTypes[col] || 'nominal') === 'quantitative') _numColIndex[col] = ni++;
  });
}

function buildStatsCache() {
  if (!_statsDirty) return;   // ← no-op se já está válido
  _statsDirty = false;

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
        const min  = _safeMin(nums);
        const max  = _safeMax(nums);
        let   sum  = 0;
        for (let i = 0; i < nums.length; i++) sum += nums[i];
        statsCache[col] = { min, max, mean: sum / nums.length };
      }
    } else {
      const cats     = [...new Set(nonEmpty)].sort();
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

function categoryHue(index) {
  const hue = (index * 137.508) % 360;
  return `hsl(${Math.round(hue)},60%,55%)`;
}

const COL_PALETTE = ['#3b82f6', '#eab308', '#22c55e'];

function colBarColor(col) {
  return COL_PALETTE[(_numColIndex[col] ?? 0) % COL_PALETTE.length];
}

// ── DOI & Transfer Function ───────────────────────────────────────────────────
function calcRowHeights(nRows, focusStart, focusEnd, availableH) {
  if (nRows === 0) return [];
  const fs = Math.max(0, focusStart ?? 0);
  const fe = Math.min(nRows - 1, focusEnd ?? 0);

  const weights = new Float64Array(nRows);
  for (let i = 0; i < nRows; i++) {
    if (i >= fs && i <= fe) {
      weights[i] = FOCAL_ROW_H;
    } else {
      const dist = i < fs ? fs - i : i - fe;
      if (dist <= SEMI_BAND) {
        const t = dist / SEMI_BAND;
        weights[i] = SEMI_ROW_H * (1 - t) + CONTEXT_ROW_H * t;
      } else {
        weights[i] = CONTEXT_ROW_H;
      }
    }
  }

  let totalW = 0;
  for (let i = 0; i < nRows; i++) totalW += weights[i];
  const scale = availableH / totalW;

  const heights = new Float64Array(nRows);
  let curSum = 0;
  for (let i = 0; i < nRows; i++) {
    heights[i] = Math.max(MIN_ROW_H, weights[i] * scale);
    curSum += heights[i];
  }
  heights[fs] = Math.max(MIN_ROW_H, heights[fs] + (availableH - curSum));
  return heights;
}

function calcColWidths(cols, focusStart, focusEnd, availableW, indexColW) {
  const n = cols.length;
  if (n === 0) return [];
  const fs = focusStart ?? null;
  const fe = focusEnd   ?? null;

  const weights = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    weights[i] = (fs !== null && i >= fs && i <= fe) ? FOCAL_COL_W : CONTEXT_COL_W;
  }

  let totalW = 0;
  for (let i = 0; i < n; i++) totalW += weights[i];
  const scale = (availableW - indexColW) / totalW;

  const widths = new Float64Array(n);
  let curSum = 0;
  for (let i = 0; i < n; i++) {
    widths[i] = Math.max(30, weights[i] * scale);
    curSum += widths[i];
  }
  widths[0] = Math.max(30, widths[0] + (availableW - indexColW - curSum));
  return widths;
}

// ── Helpers de foco ───────────────────────────────────────────────────────────
function setRowFocus(start, end) {
  focusRowStart = start;
  focusRowEnd   = end ?? start;
}
function clearRowFocus() {
  focusRowStart = null;
  focusRowEnd   = null;
}

function cellRegion(rowIdx, colIdx) {
  const rowFocal = focusRowStart !== null && rowIdx >= focusRowStart && rowIdx <= focusRowEnd;
  const colFocal = focusColStart !== null && colIdx >= focusColStart && colIdx <= focusColEnd;
  if (rowFocal && colFocal) return 'focal';
  if (rowFocal)             return 'row-focal';
  if (colFocal)             return 'col-focal';
  return 'nonfocal';
}

// ── Modos de viewport ─────────────────────────────────────────────────────────
function setViewMode(mode) {
  viewMode = mode;
  document.querySelectorAll('.vm-btn').forEach(btn =>
    btn.classList.toggle('vm-btn-active', btn.dataset.mode === mode)
  );
  const isFS = mode === 'fullscreen';
  document.body.classList.toggle('tl-fullscreen-active', isFS);
  if (isFS) {
    setRowFocus(Math.floor(rawData.length / 2));
  } else {
    hoverRowIdx = null;
  }
  renderTable();
}

// ── Geração de conteúdo de célula (innerHTML strings — sem criar elementos) ──
function _cellHTMLFocal(col, value, rowH) {
  const stats = statsCache[col];
  if (stats !== undefined && value !== '' && !isNaN(parseFloat(value))) {
    const num   = parseFloat(value);
    const norm  = stats.max === stats.min ? 0.5 : (num - stats.min) / (stats.max - stats.min);
    const pct   = Math.round(norm * 100);
    const color = colBarColor(col);
    const label = Number.isInteger(num) ? String(num) : num.toFixed(2);
    return `<div class="tl-bar-track"><div class="tl-bar-fill" style="width:${pct}%;background:${color}"></div></div>`
         + `<div class="tl-focal-meta"><span class="tl-focal-val">${label}</span>`
         + `<span class="tl-focal-range">↕ ${stats.min} – ${stats.max}</span></div>`;
  }
  if (value !== '' && value !== null && value !== undefined) {
    const posMap   = catCache[col]   || {};
    const colorMap = catColors[col]  || {};
    const pos      = posMap[value]   ?? 0.5;
    const color    = colorMap[value] ?? '#94a3b8';
    const xPct     = Math.round(pos * 80) + 10;
    return `<div class="tl-swatch-track"><div class="tl-swatch" style="left:${xPct}%;background:${color}"></div></div>`
         + `<div class="tl-focal-val-cat" style="color:${color}">${value}</div>`;
  }
  return `<div class="tl-focal-missing">—</div>`;
}

function _cellHTMLRowFocal(col, value, rowH) {
  const stats = statsCache[col];
  const barH  = Math.max(3, rowH - 16);
  if (stats !== undefined && value !== '' && !isNaN(parseFloat(value))) {
    const num   = parseFloat(value);
    const norm  = stats.max === stats.min ? 0.5 : (num - stats.min) / (stats.max - stats.min);
    const pct   = Math.round(norm * 100);
    const color = colBarColor(col);
    const label = Number.isInteger(num) ? String(num) : num.toFixed(1);
    return `<div class="tl-bar-track" style="height:${barH}px"><div class="tl-bar-fill" style="width:${pct}%;background:${color};height:100%"></div></div>`
         + `<div class="tl-row-focal-val">${label}</div>`;
  }
  if (value !== '' && value !== null && value !== undefined) {
    const colorMap = catColors[col] || {};
    const posMap   = catCache[col]  || {};
    const color    = colorMap[value] ?? '#94a3b8';
    const pos      = posMap[value]   ?? 0.5;
    const xPct     = Math.round(pos * 80) + 10;
    return `<div class="tl-swatch-track" style="height:${Math.max(4, rowH - 14)}px"><div class="tl-swatch-sm" style="left:${xPct}%;background:${color}"></div></div>`
         + `<div class="tl-row-focal-val">${String(value).slice(0, 10)}</div>`;
  }
  return `<div class="tl-row-focal-val tl-missing">—</div>`;
}

function _cellHTMLColFocal(col, value, rowH) {
  const stats = statsCache[col];
  const h     = Math.max(2, rowH - 2);
  if (stats !== undefined && value !== '' && !isNaN(parseFloat(value))) {
    const num  = parseFloat(value);
    const norm = stats.max === stats.min ? 0.5 : (num - stats.min) / (stats.max - stats.min);
    const pct  = Math.round(norm * 100);
    return `<div class="tl-bar-track" style="height:${h}px"><div class="tl-bar-fill" style="width:${pct}%;background:${colBarColor(col)};height:100%"></div></div>`;
  }
  if (value !== '' && value !== null && value !== undefined) {
    const color = (catColors[col] || {})[value] ?? '#94a3b8';
    const pos   = (catCache[col]  || {})[value] ?? 0.5;
    const xPct  = Math.round(pos * 80) + 10;
    return `<div class="tl-swatch-track" style="height:${h}px"><div class="tl-swatch-sm" style="left:${xPct}%;background:${color}"></div></div>`;
  }
  return '';
}

function _cellHTMLNonfocal(col, value, rowH) {
  const stats = statsCache[col];
  const h     = Math.max(1, rowH - 1);
  if (stats !== undefined && value !== '' && !isNaN(parseFloat(value))) {
    const num  = parseFloat(value);
    const norm = stats.max === stats.min ? 0.5 : (num - stats.min) / (stats.max - stats.min);
    const pct  = Math.round(norm * 100);
    return `<div class="tl-bar-track" style="height:${h}px"><div class="tl-bar-fill" style="width:${pct}%;background:${colBarColor(col)};height:100%"></div></div>`;
  }
  if (value !== '' && value !== null && value !== undefined) {
    const color = (catColors[col] || {})[value] ?? '#94a3b8';
    const pos   = (catCache[col]  || {})[value] ?? 0.5;
    const xPct  = Math.round(pos * 80) + 10;
    return `<div class="tl-swatch-track" style="height:${h}px"><div class="tl-swatch-xs" style="left:${xPct}%;background:${color}"></div></div>`;
  }
  return `<div class="tl-missing-mark" style="height:${h}px"></div>`;
}

function _cellHTML(col, value, region, rowH) {
  switch (region) {
    case 'focal':     return _cellHTMLFocal(col, value, rowH);
    case 'row-focal': return _cellHTMLRowFocal(col, value, rowH);
    case 'col-focal': return _cellHTMLColFocal(col, value, rowH);
    default:          return _cellHTMLNonfocal(col, value, rowH);
  }
}

// ── Cache de geometria entre patches ─────────────────────────────────────────
let _cachedRowHeights = null;
let _cachedColWidths  = null;
let _cachedVisCols    = null;
let _cachedIdxColW    = 0;
let _cachedContainerW = 0;
let _cachedContainerH = 0;
let _prevFocusRowStart = undefined;
let _prevFocusRowEnd   = undefined;
let _prevFocusColStart = undefined;
let _prevFocusColEnd   = undefined;

function _geomChanged(cW, cH) {
  return cW !== _cachedContainerW || cH !== _cachedContainerH
      || focusColStart !== _prevFocusColStart || focusColEnd !== _prevFocusColEnd;
}

// ── PATCH: atualiza apenas as linhas que mudaram de região (sem re-render DOM) ──
/**
 * Chamado no hover / teclado quando SOMENTE o foco de linha mudou.
 * Não recria nenhum elemento — apenas atualiza style.height, className e innerHTML das células.
 */
function applyFocusPatch() {
  if (!_cachedRowHeights || !_cachedVisCols) { renderTable(); return; }

  const tbody   = document.querySelector('#table-lens-container tbody');
  if (!tbody) { renderTable(); return; }

  const visCols = _cachedVisCols;
  const nRows   = rawData.length;
  const hasFocus = focusRowStart !== null;

  // Recalcula apenas os heights (barato — só aritmética)
  const tbodyH = _cachedContainerH - TH_H - (viewMode === 'fullscreen' ? FS_BAR_H : 0);
  const newHeights = (hasFocus && tbodyH > 0)
    ? calcRowHeights(nRows, focusRowStart, focusRowEnd, tbodyH)
    : null;

  const rows = tbody.rows;
  for (let ri = 0; ri < rows.length; ri++) {
    const tr        = rows[ri];
    const dataIdx   = parseInt(tr.dataset.idx);
    if (isNaN(dataIdx)) continue;

    const rowH       = newHeights ? Math.round(newHeights[dataIdx]) : CONTEXT_ROW_H;
    const isFocalRow = hasFocus && dataIdx >= focusRowStart && dataIdx <= focusRowEnd;

    // Atualiza classe da linha
    tr.className = 'tl-row'
      + (isFocalRow ? ' tl-row-focal' : ' tl-row-context')
      + (!hasFocus  ? ' tl-row-no-focus' : '');
    tr.style.height    = rowH + 'px';
    tr.style.maxHeight = rowH + 'px';

    // Atualiza célula de índice
    let tdOffset = 0;
    if (indexCol) {
      const tdIdx = tr.cells[0];
      tdIdx.className = 'tl-cell tl-cell-index' + (isFocalRow ? ' tl-idx-focal' : '');
      tdIdx.textContent = rowH >= 10 && rawData[dataIdx]
        ? String(rawData[dataIdx][indexCol] ?? '') : '';
      tdOffset = 1;
    }

    // Atualiza células de dados
    const row = rawData[dataIdx];
    for (let ci = 0; ci < visCols.length; ci++) {
      const col    = visCols[ci];
      const td     = tr.cells[ci + tdOffset];
      if (!td) continue;
      const region = cellRegion(dataIdx, ci);
      const value  = row[col] !== undefined ? String(row[col]) : '';

      const newClass = 'tl-cell tl-cell-' + (region === 'nonfocal' ? 'nonfocal' : region);
      if (td.className !== newClass || td.dataset.region !== region || td.dataset.rowh !== String(rowH)) {
        td.className      = newClass;
        td.dataset.region = region;
        td.dataset.rowh   = rowH;
        td.innerHTML      = _cellHTML(col, value, region, rowH);
      }
    }
  }

  _cachedRowHeights    = newHeights;
  _prevFocusRowStart   = focusRowStart;
  _prevFocusRowEnd     = focusRowEnd;
}

// ── Editor de tipo inline ─────────────────────────────────────────────────────
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
        if (m) m.type = opt.dataset.type;
      }
      editor.remove();
      invalidateStats();
      renderTable();
    });
  });

  setTimeout(() => document.addEventListener('click', () =>
    document.getElementById('tl-type-editor')?.remove(), { once: true }), 0);
}

function renderStats() {
  document.getElementById('stats-panel').innerHTML = '';
}

// ════════════════════════════════════════════════════════════════════════════
//  RENDERIZAÇÃO PRINCIPAL (full rebuild — chamada apenas quando estrutura muda)
// ════════════════════════════════════════════════════════════════════════════
function renderTable() {
  buildStatsCache();   // no-op se cache válido

  const container = document.getElementById('table-lens-container');
  container.innerHTML = '';

  if (!rawData || rawData.length === 0) return;

  const visCols  = columns.filter(c => c !== indexCol);
  const nRows    = rawData.length;
  const isFit    = viewMode === 'fit';
  const isScroll = viewMode === 'scroll';
  const isFS     = viewMode === 'fullscreen';

  // ── Geometria ──────────────────────────────────────────────────────────
  let containerW, containerH;

  if (isFS) {
    containerW = window.innerWidth;
    containerH = window.innerHeight;
    Object.assign(container.style, {
      position: 'fixed', inset: '0',
      width: '100vw', height: '100vh',
      overflow: 'hidden', zIndex: '1000',
      background: '#fff', borderRadius: '0',
    });
  } else {
    const card   = container.closest('.card');
    const cardR  = card.getBoundingClientRect();
    const toolH  = card.querySelector('.toolbar')?.offsetHeight || 0;
    const statsH = document.getElementById('stats-panel')?.offsetHeight || 0;
    containerW = cardR.width - 4;
    containerH = isScroll
      ? Math.round(window.innerHeight * 0.72)
      : Math.max(200, window.innerHeight - cardR.top - toolH - statsH - 40);
    Object.assign(container.style, {
      overflow: isScroll ? 'auto' : 'hidden',
      position: '', inset: '',
      width:    containerW + 'px',
      height:   isFit ? containerH + 'px' : 'auto',
      maxHeight: isScroll ? containerH + 'px' : '',
      zIndex: '', background: '', borderRadius: '',
    });
  }

  // ── Heights ────────────────────────────────────────────────────────────
  const tbodyH = isFS ? containerH - TH_H - FS_BAR_H
               : isFit ? containerH - TH_H
               : null;

  const hasFocus = focusRowStart !== null;
  let rowHeights = null;

  if (hasFocus && tbodyH !== null) {
    rowHeights = calcRowHeights(nRows, focusRowStart, focusRowEnd, tbodyH);
  } else if (hasFocus && isScroll) {
    rowHeights = new Float64Array(nRows);
    for (let i = 0; i < nRows; i++) {
      if (i >= focusRowStart && i <= focusRowEnd) { rowHeights[i] = FOCAL_ROW_H; continue; }
      const dist = i < focusRowStart ? focusRowStart - i : i - focusRowEnd;
      rowHeights[i] = dist <= SEMI_BAND ? SEMI_ROW_H : CONTEXT_ROW_H;
    }
  }

  // ── Widths ─────────────────────────────────────────────────────────────
  const idxColW  = indexCol ? Math.min(140, Math.max(60, Math.round(containerW * 0.10))) : 0;
  const colWidths = calcColWidths(visCols, focusColStart, focusColEnd, containerW, idxColW);

  // Persiste para patches futuros
  _cachedRowHeights    = rowHeights;
  _cachedColWidths     = colWidths;
  _cachedVisCols       = visCols;
  _cachedIdxColW       = idxColW;
  _cachedContainerW    = containerW;
  _cachedContainerH    = containerH;
  _prevFocusRowStart   = focusRowStart;
  _prevFocusRowEnd     = focusRowEnd;
  _prevFocusColStart   = focusColStart;
  _prevFocusColEnd     = focusColEnd;

  // ── Tabela ─────────────────────────────────────────────────────────────
  const table = document.createElement('table');
  table.className = 'tl-table' + (isFS ? ' tl-table-fs' : '');
  table.style.cssText = `table-layout:fixed;width:100%;height:${
    isFS ? 'calc(100vh - ' + (TH_H + FS_BAR_H) + 'px)' : '100%'};border-collapse:collapse;`;

  // ── Cabeçalho ──────────────────────────────────────────────────────────
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

    const isNum    = statsCache[col] !== undefined;
    const arrow    = col === sortCol ? (sortAsc ? ' ↑' : ' ↓') : '';
    const typeIcon = { quantitative: '📊', nominal: '🔤', ordinal: '🔢' }[colTypes[col] || 'nominal'];
    const isFocal  = focusColStart !== null && ci >= focusColStart && ci <= focusColEnd;

    th.innerHTML = `
      <div class="tl-th-inner ${isFocal ? 'tl-th-focal' : ''}">
        <div class="tl-th-top">
          <span class="tl-th-label">${col}${arrow}</span>
          <button class="tl-type-btn" title="Editar tipo">${typeIcon}</button>
        </div>
        ${isNum ? `<span class="tl-th-stats">ø ${statsCache[col].mean.toFixed(1)} [${statsCache[col].min}–${statsCache[col].max}]</span>` : ''}
      </div>`;

    th.querySelector('.tl-type-btn').addEventListener('click', e => openTypeEditor(col, e.currentTarget, e));
    th.addEventListener('click', e => { if (!e.target.classList.contains('tl-type-btn')) sortByColumn(col); });
    th.addEventListener('dblclick', e => {
      e.preventDefault();
      focusColStart = (focusColStart === ci) ? null : ci;
      focusColEnd   = (focusColStart === null) ? null : ci;
      renderTable();
    });
    headRow.appendChild(th);
  });

  thead.appendChild(headRow);
  table.appendChild(thead);

  // ── Tbody ──────────────────────────────────────────────────────────────
  // Usa DocumentFragment para batch insert (uma única reflowed)
  const tbody = document.createElement('tbody');
  const frag  = document.createDocumentFragment();

  for (let ri = 0; ri < nRows; ri++) {
    const row        = rawData[ri];
    const rowH       = rowHeights ? Math.round(rowHeights[ri]) : CONTEXT_ROW_H;
    const isFocalRow = hasFocus && ri >= focusRowStart && ri <= focusRowEnd;

    const tr = document.createElement('tr');
    tr.dataset.idx  = ri;
    tr.className    = 'tl-row'
      + (isFocalRow ? ' tl-row-focal' : ' tl-row-context')
      + (!hasFocus  ? ' tl-row-no-focus' : '');
    tr.style.cssText = `height:${rowH}px;max-height:${rowH}px;overflow:hidden;`;

    if (indexCol) {
      const tdIdx = document.createElement('td');
      tdIdx.className = 'tl-cell tl-cell-index' + (isFocalRow ? ' tl-idx-focal' : '');
      tdIdx.style.width = idxColW + 'px';
      if (rowH >= 10) tdIdx.textContent = row[indexCol] !== undefined ? String(row[indexCol]) : '';
      tr.appendChild(tdIdx);
    }

    for (let ci = 0; ci < visCols.length; ci++) {
      const col    = visCols[ci];
      const region = cellRegion(ri, ci);
      const value  = row[col] !== undefined ? String(row[col]) : '';
      const td     = document.createElement('td');
      td.className       = 'tl-cell tl-cell-' + (region === 'nonfocal' ? 'nonfocal' : region);
      td.dataset.region  = region;
      td.dataset.rowh    = rowH;
      td.style.cssText   = `width:${colWidths[ci]}px;max-width:${colWidths[ci]}px;`;
      td.innerHTML       = _cellHTML(col, value, region, rowH);
      tr.appendChild(td);
    }

    frag.appendChild(tr);
  }

  tbody.appendChild(frag);

  // ── Delegação de eventos (1 listener por tbody, não N por linha) ────────
  tbody.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-idx]');
    if (!tr) return;
    const ri       = parseInt(tr.dataset.idx);
    const isFocRow = focusRowStart !== null && ri >= focusRowStart && ri <= focusRowEnd;
    if (isFocRow && focusRowStart === ri && focusRowEnd === ri) clearRowFocus();
    else setRowFocus(ri, ri);
    applyFocusPatch();
  });

  tbody.addEventListener('mousemove', e => {
    if (viewMode !== 'fullscreen' && viewMode !== 'fit') return;
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
        applyFocusPatch();   // ← patch, não full render
      });
    }
  });

  table.appendChild(tbody);
  container.appendChild(table);

  // ── Barra inferior fullscreen ──────────────────────────────────────────
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

// ── Teclado no fullscreen ─────────────────────────────────────────────────────
function bindFisheyeKeys() {
  document.onkeydown = null;
  document.onkeydown = e => {
    if (viewMode !== 'fullscreen') return;
    const n = rawData.length;
    if (!n) return;
    const cur = focusRowStart ?? Math.floor(n / 2);
    if (e.key === 'Escape')    { setViewMode('fit'); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setRowFocus(Math.min(n-1, cur+1)); applyFocusPatch(); }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setRowFocus(Math.max(0, cur-1));   applyFocusPatch(); }
    if (e.key === 'PageDown')  { e.preventDefault(); setRowFocus(Math.min(n-1, cur+10)); applyFocusPatch(); }
    if (e.key === 'PageUp')    { e.preventDefault(); setRowFocus(Math.max(0, cur-10));   applyFocusPatch(); }
    if (e.key === 'Home')      { e.preventDefault(); setRowFocus(0);    applyFocusPatch(); }
    if (e.key === 'End')       { e.preventDefault(); setRowFocus(n-1);  applyFocusPatch(); }
  };
}

// ── Busca ─────────────────────────────────────────────────────────────────────
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

// ── Ordenação ─────────────────────────────────────────────────────────────────
function sortByColumn(col) {
  sortAsc = sortCol === col ? !sortAsc : true;
  sortCol = col;
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

  invalidateStats();  // ordem mudou, stats de posição podem mudar
  renderTable();
}

// ── Redimensionamento ─────────────────────────────────────────────────────────
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
