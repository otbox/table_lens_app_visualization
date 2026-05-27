// ─── Estado ───────────────────────────────────────────────────────────────────
let expandedRow = null;   // índice da linha atualmente expandida
let sortCol     = null;   // coluna usada para ordenação atual
let sortAsc     = true;   // direção da ordenação
let colTypes    = {};     // { colName: 'numeric'|'categorical'|'date' }
let viewMode    = 'fit';  // 'fit' | 'scroll' | 'fullscreen'
// indexCol é declarado em preprocessar.js

// ─── Modos de viewport ────────────────────────────────────────────────────────
function setViewMode(mode) {
  viewMode = mode;
  document.querySelectorAll('.vm-btn').forEach(btn =>
    btn.classList.toggle('vm-btn-active', btn.dataset.mode === mode)
  );
  document.body.classList.toggle('tl-fullscreen-active', mode === 'fullscreen');
  renderTable();
}

// ─── Cálculo de dimensões adaptativas ────────────────────────────────────────
function calcFitDimensions() {
  const nRows   = rawData.length;
  const visCols = columns.filter(c => c !== indexCol);
  const nCols   = visCols.length + (indexCol ? 1 : 0);
  const TH_H    = 36;

  let areaW, areaH;

  if (viewMode === 'fullscreen') {
    areaW = window.innerWidth;
    areaH = window.innerHeight;
  } else {
    // Área do card de visualização
    const card      = document.getElementById('table-lens-container').closest('.card');
    const cardRect  = card.getBoundingClientRect();
    const toolbarH  = card.querySelector('.toolbar')?.offsetHeight || 0;
    const statsH    = document.getElementById('stats-panel')?.offsetHeight || 0;
    areaW = cardRect.width  - 4;
    areaH = window.innerHeight - cardRect.top - toolbarH - statsH - 32;
  }

  const availH = Math.max(areaH - TH_H, nRows * 3);
  const rowH   = Math.min(28, Math.max(3, Math.floor(availH / nRows)));
  const colW   = Math.min(200, Math.max(36, Math.floor(areaW / nCols)));

  return { rowH, colW, thH: TH_H, totalH: TH_H + rowH * nRows };
}

// ─── Estatísticas ─────────────────────────────────────────────────────────────
let statsCache = {};
let catCache   = {};

function buildStatsCache() {
  statsCache = {};
  catCache   = {};
  columns.forEach(col => {
    const nums = rawData.map(r => parseFloat(r[col])).filter(v => !isNaN(v));
    if (nums.length > 0 && colTypes[col] !== 'categorical') {
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      statsCache[col] = { min: Math.min(...nums), max: Math.max(...nums), mean };
    } else {
      const cats = [...new Set(
        rawData.map(r => r[col]).filter(v => v !== '' && v != null)
      )].sort();
      const map = {};
      cats.forEach((cat, i) => {
        map[cat] = cats.length === 1 ? 0.5 : 0.05 + (i / (cats.length - 1)) * 0.90;
      });
      catCache[col] = map;
    }
  });
}

// ─── Cores ────────────────────────────────────────────────────────────────────
function getBarColor(value, min, max) {
  const norm = max === min ? 0.5 : (value - min) / (max - min);
  return `rgba(15,118,110,${0.15 + norm * 0.75})`;
}

function getCategoryColor(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i++)
    hash = value.charCodeAt(i) + ((hash << 5) - hash);
  return `hsl(${Math.abs(hash % 360)},55%,72%)`;
}

// ─── Células ──────────────────────────────────────────────────────────────────
function renderCellCompact(col, value, cellH) {
  const td    = document.createElement('td');
  td.className = 'tl-cell tl-cell-compact';

  const stats = statsCache[col];

  if (stats !== undefined && value !== '' && !isNaN(parseFloat(value))) {
    const norm  = stats.max === stats.min ? 0.5 : (parseFloat(value) - stats.min) / (stats.max - stats.min);
    const pct   = Math.round(norm * 100);
    const color = getBarColor(parseFloat(value), stats.min, stats.max);
    const barH  = Math.max(2, cellH - 4);
    td.innerHTML = `<div class="tl-bar-wrap"><div class="tl-bar-fill" style="width:${pct}%;background:${color};height:${barH}px;"></div></div>`;
  } else if (value !== '') {
    const color  = getCategoryColor(String(value));
    const yMap   = catCache[col] || {};
    const xPct   = Math.round((yMap[value] !== undefined ? yMap[value] : 0.5) * 100);
    const dotSz  = Math.max(3, Math.min(7, cellH - 3));
    td.innerHTML = `<div class="tl-cat-dot-wrap"><div class="tl-cat-dot" style="background:${color};left:${xPct}%;width:${dotSz}px;height:${dotSz}px;"></div></div>`;
  } else {
    td.innerHTML = `<div class="tl-missing-wrap"><div class="tl-missing"></div></div>`;
  }
  return td;
}

function renderCellExpanded(col, value) {
  const td    = document.createElement('td');
  td.className = 'tl-cell tl-cell-expanded';

  const stats = statsCache[col];

  if (stats !== undefined && value !== '' && !isNaN(parseFloat(value))) {
    const norm  = stats.max === stats.min ? 0.5 : (parseFloat(value) - stats.min) / (stats.max - stats.min);
    const pct   = Math.round(norm * 100);
    const color = getBarColor(parseFloat(value), stats.min, stats.max);
    const num   = parseFloat(value);
    td.innerHTML = `
      <div class="tl-bar-wrap"><div class="tl-bar-fill" style="width:${pct}%;background:${color};"></div></div>
      <div class="tl-expanded-info">
        <span class="tl-val">${Number.isInteger(num) ? num : num.toFixed(2)}</span>
        <span class="tl-range">min ${stats.min} · max ${stats.max}</span>
      </div>`;
  } else if (value !== '') {
    const color = getCategoryColor(String(value));
    const xMap  = catCache[col] || {};
    const xPct  = Math.round((xMap[value] !== undefined ? xMap[value] : 0.5) * 100);
    td.innerHTML = `
      <div class="tl-cat-dot-wrap" style="height:8px;margin-bottom:4px;">
        <div class="tl-cat-dot" style="background:${color};left:${xPct}%;"></div>
      </div>
      <div class="tl-val">${value}</div>`;
  } else {
    td.innerHTML = `<div class="tl-val tl-missing-label">—</div>`;
  }
  return td;
}

// ─── Editor de tipo ───────────────────────────────────────────────────────────
function openTypeEditor(col, anchorEl, event) {
  event.stopPropagation();

  const existing = document.getElementById('tl-type-editor');
  if (existing) {
    if (existing.dataset.col === col) { existing.remove(); return; }
    existing.remove();
  }

  const currentType = colTypes[col] || 'categorical';
  const editor = document.createElement('div');
  editor.id           = 'tl-type-editor';
  editor.dataset.col  = col;
  editor.className    = 'tl-type-editor';
  editor.innerHTML = `
    <div class="tl-type-editor-title">Tipo de <strong>${col}</strong></div>
    <div class="tl-type-opt ${currentType==='numeric'    ?'tl-type-opt-active':''}" data-type="numeric">
      <span class="tl-type-dot tl-dot-num"></span> Numérico
    </div>
    <div class="tl-type-opt ${currentType==='categorical'?'tl-type-opt-active':''}" data-type="categorical">
      <span class="tl-type-dot tl-dot-cat"></span> Categórico
    </div>
    <div class="tl-type-opt ${currentType==='date'       ?'tl-type-opt-active':''}" data-type="date">
      <span class="tl-type-dot tl-dot-date"></span> Data
    </div>`;

  const rect = anchorEl.getBoundingClientRect();
  editor.style.top  = (rect.bottom + 4) + 'px';
  editor.style.left = rect.left + 'px';
  document.body.appendChild(editor);

  editor.querySelectorAll('.tl-type-opt').forEach(opt => {
    opt.addEventListener('click', e => {
      e.stopPropagation();
      const newType = opt.dataset.type;
      colTypes[col] = newType;
      if (typeof colMeta !== 'undefined') {
        const meta = colMeta.find(m => m.col === col);
        if (meta) { meta.type = newType; meta.impute = newType==='numeric'?'mean':newType==='categorical'?'mode':'none'; }
      }
      editor.remove();
      expandedRow = null;
      buildStatsCache();
      renderTable();
    });
  });

  setTimeout(() => {
    document.addEventListener('click', function closeEditor() {
      document.getElementById('tl-type-editor')?.remove();
      document.removeEventListener('click', closeEditor);
    }, { once: true });
  }, 0);
}

// ─── Stats panel ──────────────────────────────────────────────────────────────
function renderStats() {
  document.getElementById('stats-panel').innerHTML = '';
}

// ─── Renderização principal ───────────────────────────────────────────────────
function renderTable() {
  buildStatsCache();

  const container = document.getElementById('table-lens-container');
  container.innerHTML = '';

  const visCols  = columns.filter(c => c !== indexCol);
  const isFit    = viewMode === 'fit';
  const isFS     = viewMode === 'fullscreen';
  let   dims     = null;

  if (isFit && rawData.length > 0) dims = calcFitDimensions();

  // ── Estilos do container por modo ──
  if (viewMode === 'fit') {
    Object.assign(container.style, {
      overflow:   'hidden',
      width:      '100%',
      height:     dims ? dims.totalH + 'px' : 'auto',
      maxHeight:  '',
      position:   '',
      inset:      '',
      zIndex:     '',
      background: '',
      borderRadius: '',
    });
  } else if (viewMode === 'scroll') {
    Object.assign(container.style, {
      overflow:   'auto',
      width:      '100%',
      height:     'auto',
      maxHeight:  Math.round(window.innerHeight * 0.72) + 'px',
      position:   '',
      inset:      '',
      zIndex:     '',
      background: '',
    });
  } else if (viewMode === 'fullscreen') {
    Object.assign(container.style, {
      overflowX:    'hidden',
      overflowY:    'auto',       // scroll vertical no fullscreen
      position:     'fixed',
      inset:        '0',
      width:        '100vw',
      height:       '100vh',
      maxHeight:    '',
      zIndex:       '1000',
      background:   '#fff',
      borderRadius: '0',
    });
  }

  // ── Tabela ──
  const table = document.createElement('table');
  table.className = 'table-lens tl-table' + (isFS ? ' tl-table-fs' : '');

  if (isFit && dims) {
    Object.assign(table.style, { tableLayout: 'fixed', width: '100%', height: '100%' });
  } else {
    Object.assign(table.style, { tableLayout: 'auto', width: isFS ? '100%' : 'max-content', minWidth: '100%' });
  }

  // ── Cabeçalho ──
  const thead   = document.createElement('thead');
  const headRow = document.createElement('tr');
  if (isFit && dims) headRow.style.height = dims.thH + 'px';

  if (indexCol) {
    const thIdx   = document.createElement('th');
    thIdx.className = 'tl-th tl-th-index';
    if (isFit && dims) thIdx.style.width = dims.colW + 'px';
    thIdx.innerHTML = `<div class="tl-th-inner"><span class="tl-th-label">${indexCol}</span></div>`;
    headRow.appendChild(thIdx);
  }

  visCols.forEach(col => {
    const th       = document.createElement('th');
    th.className   = 'tl-th';
    if (isFit && dims) th.style.width = dims.colW + 'px';

    const isNumeric = statsCache[col] !== undefined;
    const arrow     = col === sortCol ? (sortAsc ? ' ↑' : ' ↓') : '';
    const typeIcon  = { numeric:'🔢', categorical:'🔤', date:'📅' }[colTypes[col] || 'categorical'];
    th.title = isNumeric
      ? `${col}\nMédia: ${statsCache[col].mean.toFixed(2)}\nMín: ${statsCache[col].min}\nMáx: ${statsCache[col].max}`
      : col;

    th.innerHTML = `
      <div class="tl-th-inner">
        <div class="tl-th-top">
          <span class="tl-th-label">${col}${arrow}</span>
          <button class="tl-type-btn" title="Editar tipo">${typeIcon}</button>
        </div>
        ${isNumeric && (!dims || dims.rowH > 8) ? `<span class="tl-th-stats">ø ${statsCache[col].mean.toFixed(1)}</span>` : ''}
      </div>`;

    th.querySelector('.tl-type-btn').addEventListener('click', e => openTypeEditor(col, e.currentTarget, e));
    th.addEventListener('click', () => sortByColumn(col));
    headRow.appendChild(th);
  });

  thead.appendChild(headRow);
  table.appendChild(thead);

  // ── Corpo ──
  const tbody = document.createElement('tbody');
  // fullscreen: altura natural por linha (sem comprimir); fit: calculada
  const cellH = (isFit && dims) ? dims.rowH : 20;

  rawData.forEach((row, rowIdx) => {
    const tr       = document.createElement('tr');
    const isExpanded = rowIdx === expandedRow;
    tr.className   = 'tl-row' + (isExpanded ? ' tl-row-expanded' : '');
    tr.dataset.idx = rowIdx;

    if (!isExpanded) {
      tr.style.height    = cellH + 'px';
      tr.style.maxHeight = cellH + 'px';
      tr.style.overflow  = 'hidden';
    }

    tr.addEventListener('click', () => {
      expandedRow = expandedRow === rowIdx ? null : rowIdx;
      renderTable();
    });

    if (indexCol) {
      const tdIdx   = document.createElement('td');
      tdIdx.className = 'tl-cell tl-cell-index';
      // Só exibe texto se a linha tiver altura legível
      if (cellH >= 10 || isExpanded) {
        tdIdx.textContent = row[indexCol] !== undefined ? String(row[indexCol]) : '';
      }
      tr.appendChild(tdIdx);
    }

    visCols.forEach(col => {
      const value = row[col] !== undefined ? String(row[col]) : '';
      tr.appendChild(isExpanded ? renderCellExpanded(col, value) : renderCellCompact(col, value, cellH));
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  if (expandedRow !== null) table.classList.add('has-focus');
  if (isFit && dims && dims.rowH <= 6) table.classList.add('tl-dense');

  container.appendChild(table);

  // Botão fechar fullscreen
  if (viewMode === 'fullscreen') {
    const closeBtn     = document.createElement('button');
    closeBtn.className  = 'tl-fs-close';
    closeBtn.innerHTML  = '✕ Fechar';
    closeBtn.addEventListener('click', e => { e.stopPropagation(); setViewMode('fit'); });
    container.appendChild(closeBtn);
  }

  bindSearch();
}

// ─── Busca ────────────────────────────────────────────────────────────────────
function bindSearch() {
  const input = document.getElementById('search-input');
  const fresh = input.cloneNode(true);
  input.parentNode.replaceChild(fresh, input);

  fresh.addEventListener('input', () => {
    const q = fresh.value.toLowerCase();
    document.querySelectorAll('.tl-row').forEach(tr => {
      const rowIdx = parseInt(tr.dataset.idx);
      const row    = rawData[rowIdx];
      const match  = columns.some(col => String(row[col] ?? '').toLowerCase().includes(q));
      tr.style.display = match ? '' : 'none';
    });
  });
}

// ─── Ordenação ────────────────────────────────────────────────────────────────
function sortByColumn(col) {
  if (sortCol === col) { sortAsc = !sortAsc; }
  else                 { sortCol = col; sortAsc = true; }
  expandedRow = null;

  rawData.sort((a, b) => {
    const av = a[col], bv = b[col];
    const an = parseFloat(av), bn = parseFloat(bv);
    const cmp = (!isNaN(an) && !isNaN(bn)) ? an - bn : String(av ?? '').localeCompare(String(bv ?? ''));
    return sortAsc ? cmp : -cmp;
  });

  renderTable();
}

// ─── Compat ───────────────────────────────────────────────────────────────────
function toggleFocusMode() { expandedRow = null; renderTable(); }

// ─── Recalcula ao redimensionar ───────────────────────────────────────────────
let _resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => { if (rawData?.length > 0) renderTable(); }, 120);
});
