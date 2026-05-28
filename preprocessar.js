// ─── Estado global ────────────────────────────────────────────────────────────
let rawData      = [];
let originalData = [];
let columns      = [];
let colMeta      = [];
let selectedCols = [];
let indexCol     = null;

// ─── Dados de exemplo ─────────────────────────────────────────────────────────
const SAMPLE_CSV = `nome,idade,salario,cidade,score
Ana,25,3500,São Paulo,87.2
Carlos,32,4200,Rio de Janeiro,91.0
Julia,29,4800,Campinas,73.5
Pedro,21,2200,Curitiba,78.4
Fernanda,40,9000,Curitiba,88.9
Marcos,45,5600,São Paulo,82.1
Grace,33,4100,Campinas,75.3
Hank,27,3300,Rio de Janeiro,65.8
Ivan,38,7100,São Paulo,93.5
Julia,24,2500,Belo Horizonte,79.8
Roberto,52,11200,São Paulo,90.1
Carla,36,6800,Campinas,84.7
Diego,31,3900,Rio de Janeiro,70.2
Aline,28,4400,Curitiba,86.3
Thiago,44,8700,São Paulo,77.9`;

// ─── Parsing CSV ──────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim() !== '');
  const firstLine = lines[0];
  let sep = ',';
  let inQuote = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuote = !inQuote;
    if (!inQuote && ch === ';') { sep = ';'; break; }
  }

  function splitLine(line) {
    const fields = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQ && line[i+1] === '"') { cur += '"'; i++; }
        else { inQ = !inQ; }
      } else if (ch === sep && !inQ) {
        fields.push(cur.trim()); cur = '';
      } else { cur += ch; }
    }
    fields.push(cur.trim());
    return fields;
  }

  const headers = splitLine(lines[0]);
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitLine(lines[i]);
    if (vals.length < headers.length - 1) continue;
    const row = {};
    headers.forEach((h, j) => { row[h] = vals[j] !== undefined ? vals[j] : ''; });
    rows.push(row);
  }
  return { headers, rows };
}

// ─── Detecção de tipos ────────────────────────────────────────────────────────
function detectType(values) {
  const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
  if (nonEmpty.length === 0) return 'nominal';
  const numCount = nonEmpty.filter(v => !isNaN(parseFloat(v)) && isFinite(v)).length;
  if (numCount / nonEmpty.length > 0.8) return 'quantitative';
  // ordinal: poucos valores únicos em sequência numérica ou com ordem aparente
  const uniq = [...new Set(nonEmpty)];
  if (uniq.length <= 8 && uniq.every(v => !isNaN(parseFloat(v)))) return 'ordinal';
  return 'nominal';
}

function getMissingCount(col) {
  return rawData.filter(r => r[col] === '' || r[col] === undefined || r[col] === null).length;
}

function buildColMeta() {
  colMeta = columns.map(col => {
    const vals    = rawData.map(r => r[col]);
    const type    = detectType(vals);
    const missing = getMissingCount(col);
    const sample  = vals.filter(v => v !== '').slice(0, 3).join(', ');
    const impute  = type === 'quantitative' ? 'mean' : 'mode';
    return { col, type, missing, sample, impute };
  });
}

// ─── Imputação ────────────────────────────────────────────────────────────────
function applyImputation() {
  const data = rawData.map(r => ({ ...r }));
  colMeta.forEach(meta => {
    if (meta.missing === 0 || meta.impute === 'none') return;
    const col = meta.col;
    if (meta.impute === 'mean' && meta.type === 'quantitative') {
      const nums = data.map(r => parseFloat(r[col])).filter(v => !isNaN(v));
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      data.forEach(r => { if (r[col] === '' || r[col] == null) r[col] = String(mean.toFixed(4)); });
    } else if (meta.impute === 'mode') {
      const freq = {};
      data.forEach(r => { const v = r[col]; if (v !== '' && v != null) freq[v] = (freq[v]||0)+1; });
      const mode = Object.entries(freq).sort((a,b)=>b[1]-a[1])[0]?.[0] ?? '';
      data.forEach(r => { if (r[col] === '' || r[col] == null) r[col] = mode; });
    } else if (meta.impute === 'linear') {
      const indices = data.map(r => {
        const v = r[col];
        if (v === '' || v == null) return null;
        return meta.type === 'date' ? new Date(v).getTime() : parseFloat(v);
      });
      for (let i = 0; i < indices.length; i++) {
        if (indices[i] !== null) continue;
        let l = i-1, ri2 = i+1;
        while (l >= 0 && indices[l] === null) l--;
        while (ri2 < indices.length && indices[ri2] === null) ri2++;
        let filled = null;
        if (l >= 0 && ri2 < indices.length) filled = indices[l] + (i-l)/(ri2-l)*(indices[ri2]-indices[l]);
        else if (l >= 0) filled = indices[l];
        else if (ri2 < indices.length) filled = indices[ri2];
        if (filled !== null) {
          indices[i] = filled;
          data[i][col] = meta.type === 'date'
            ? new Date(filled).toISOString().slice(0,10)
            : String(parseFloat(filled.toFixed(4)));
        }
      }
    }
  });
  return data;
}

// ─── Processamento ────────────────────────────────────────────────────────────
function processText(text) {
  const parsed = parseCSV(text);
  columns = parsed.headers;
  rawData = parsed.rows;
  originalData = rawData.map(r => ({ ...r }));
  buildColMeta();
}

// ─── Carregamento ─────────────────────────────────────────────────────────────
function loadSampleData() {
  processText(SAMPLE_CSV);
  showFileInfo('Dados de exemplo — 15 linhas, 5 colunas');
  showPreprocessPanel();
}

function showFileInfo(msg) {
  const el = document.getElementById('file-info');
  el.textContent = msg;
  el.style.display = 'block';
}

function readFile(file) {
  const reader = new FileReader();
  reader.onload = ev => {
    processText(ev.target.result);
    showFileInfo(`Carregado: ${file.name} — ${rawData.length} linhas, ${columns.length} colunas`);
    showPreprocessPanel();
  };
  reader.readAsText(file);
}

document.getElementById('csv-input').addEventListener('change', e => {
  const file = e.target.files[0]; if (file) readFile(file);
});

const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('click', () => document.getElementById('csv-input').click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragging'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', e => {
  e.preventDefault(); dropZone.classList.remove('dragging');
  const file = e.dataTransfer.files[0]; if (file) readFile(file);
});

// ─── Painel de pré-processamento ──────────────────────────────────────────────
function showPreprocessPanel() {
  renderSummary(); renderIndexSelect(); renderColTable(); renderAttrGrid();
  document.getElementById('preprocess-panel').style.display = 'block';
}

function renderIndexSelect() {
  const container = document.getElementById('index-select-wrap');
  const options = columns.map(col => `<option value="${col}">${col}</option>`).join('');
  container.innerHTML = `
    <label class="pp-index-label">
      Coluna de índice (rótulo das linhas):
      <select class="pp-impute-select" id="index-col-select" onchange="setIndexCol(this.value)">
        <option value="">— nenhuma —</option>
        ${options}
      </select>
    </label>`;
  const suggested = colMeta.find(m => m.type === 'categorical');
  if (suggested) {
    document.getElementById('index-col-select').value = suggested.col;
    setIndexCol(suggested.col);
  }
}

function setIndexCol(col) { indexCol = col || null; }

function renderSummary() {
  const totalCells = rawData.length * columns.length;
  const totalMissing = colMeta.reduce((s, m) => s + m.missing, 0);
  const pct = totalCells > 0 ? Math.round(totalMissing / totalCells * 100) : 0;
  document.getElementById('summary-row').innerHTML = `
    <div class="pp-summary-card"><span class="pp-val">${rawData.length}</span><span class="pp-lbl">linhas</span></div>
    <div class="pp-summary-card"><span class="pp-val">${columns.length}</span><span class="pp-lbl">colunas</span></div>
    <div class="pp-summary-card"><span class="pp-val">${totalMissing}</span><span class="pp-lbl">faltantes</span></div>
    <div class="pp-summary-card"><span class="pp-val">${pct}%</span><span class="pp-lbl">% faltante</span></div>`;
}

function renderColTable() {
  const tbody = document.getElementById('col-tbody');
  tbody.innerHTML = '';
  colMeta.forEach((m, i) => {
    const pct = rawData.length > 0 ? m.missing / rawData.length : 0;
    const fillCls = pct > 0.3 ? 'bar-high' : pct > 0.1 ? 'bar-med' : 'bar-low';
    const typeLabel = { quantitative:'Quantitativo', nominal:'Nominal', ordinal:'Ordinal' }[m.type] || m.type;
    const typeCls   = { quantitative:'badge-num', nominal:'badge-cat', ordinal:'badge-ord' }[m.type] || 'badge-cat';
    const imputeOpts = buildImputeOptions(m.type, m.impute);
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="pp-col-name" title="${m.col}">${m.col}</td>
      <td>
        <span class="pp-badge ${typeCls}">${typeLabel}</span>
        <select class="pp-type-select" id="override-${i}" style="display:none"
                onchange="overrideType(${i}, this.value)">
          <option value="quantitative" ${m.type==='quantitative'?'selected':''}>Quantitativo</option>
          <option value="nominal"      ${m.type==='nominal'     ?'selected':''}>Nominal</option>
          <option value="ordinal"      ${m.type==='ordinal'     ?'selected':''}>Ordinal</option>
        </select>
        <button class="pp-link-btn" onclick="toggleTypeOverride(${i})">editar</button>
      </td>
      <td>
        <div class="pp-bar-wrap">
          <div class="pp-bar"><div class="pp-bar-fill ${fillCls}" style="width:${Math.round(pct*100)}%"></div></div>
          <span class="pp-bar-label">${m.missing} (${Math.round(pct*100)}%)</span>
        </div>
      </td>
      <td>
        ${m.missing > 0
          ? `<select class="pp-impute-select" onchange="setImpute(${i}, this.value)">${imputeOpts}</select>`
          : `<span class="pp-no-impute">—</span>`}
      </td>
      <td class="pp-sample" title="${m.sample}">${m.sample}</td>`;
    tbody.appendChild(tr);
  });
}

function buildImputeOptions(type, current) {
  const opts = type === 'quantitative'
    ? [['none','Nenhuma'],['mean','Média'],['mode','Moda'],['linear','Interpolação linear']]
    : [['none','Nenhuma'],['mode','Moda']];
  return opts.map(([val, label]) =>
    `<option value="${val}" ${val===current?'selected':''}>${label}</option>`).join('');
}

function toggleTypeOverride(i) {
  const el = document.getElementById('override-'+i);
  el.style.display = el.style.display === 'none' ? 'inline-block' : 'none';
}
function overrideType(i, newType) {
  colMeta[i].type   = newType;
  colMeta[i].impute = newType === 'quantitative' ? 'mean' : 'mode';
  renderColTable();
}
function setImpute(i, val) { colMeta[i].impute = val; }

// ─── Chips de seleção ─────────────────────────────────────────────────────────
function renderAttrGrid() {
  const grid = document.getElementById('attr-grid');
  grid.innerHTML = '';
  colMeta.forEach((m, i) => {
    const chip = document.createElement('div');
    chip.className = 'pp-chip selected';
    chip.dataset.idx = i;
    const typeOptions = [['quantitative','Quantitativo'],['nominal','Nominal'],['ordinal','Ordinal']]
      .map(([val, label]) => `<option value="${val}" ${m.type===val?'selected':''}>${label}</option>`).join('');
    chip.innerHTML = `
      <div class="pp-chip-check"><div class="pp-chip-inner"></div></div>
      <div class="pp-chip-body">
        <div class="pp-chip-label" title="${m.col}">${m.col}</div>
        <select class="pp-chip-type-select pp-chip-type--${m.type}" data-idx="${i}">${typeOptions}</select>
      </div>`;
    chip.addEventListener('click', e => {
      if (e.target.tagName === 'SELECT' || e.target.closest('select')) return;
      toggleChip(chip, i);
    });
    chip.querySelector('select').addEventListener('change', function(e) {
      e.stopPropagation();
      const newType = this.value;
      colMeta[i].type   = newType;
      colMeta[i].impute = newType === 'quantitative' ? 'mean' : 'mode';
      this.className = `pp-chip-type-select pp-chip-type--${newType}`;
      const override = document.getElementById('override-'+i);
      if (override) override.value = newType;
      renderColTable();
    });
    grid.appendChild(chip);
  });
  selectedCols = [...Array(colMeta.length).keys()];
  updateSelCount();
}

function toggleChip(chip, idx) {
  const was = chip.classList.contains('selected');
  chip.classList.toggle('selected', !was);
  if (!was) { if (!selectedCols.includes(idx)) selectedCols.push(idx); }
  else { selectedCols = selectedCols.filter(i => i !== idx); }
  updateSelCount();
}
function toggleAllChips(state) {
  document.querySelectorAll('.pp-chip').forEach(c => c.classList.toggle('selected', state));
  selectedCols = state ? [...Array(colMeta.length).keys()] : [];
  updateSelCount();
}
function selectChipsByType(type) {
  document.querySelectorAll('.pp-chip').forEach((c, i) => c.classList.toggle('selected', colMeta[i].type===type));
  selectedCols = colMeta.map((m,i) => m.type===type ? i : -1).filter(i => i>=0);
  updateSelCount();
}
function updateSelCount() {
  document.getElementById('sel-count').textContent = `${selectedCols.length} de ${colMeta.length} selecionados`;
}

// ─── Finalizar ────────────────────────────────────────────────────────────────
function finalize() {
  if (rawData.length === 0)    { alert('Carregue um CSV antes.'); return; }
  if (selectedCols.length === 0) { alert('Selecione ao menos um atributo.'); return; }

  // 1. Restaurar originais e imputar
  rawData = originalData.map(r => ({ ...r }));
  const imputedData = applyImputation();

  // 2. Filtrar colunas selecionadas (excluindo índice)
  const selectedNames = selectedCols.map(i => colMeta[i].col).filter(c => c !== indexCol);

  // 3. Atualizar globais lidos pelo tablelens.js
  rawData = imputedData.map(row => {
    const filtered = {};
    selectedNames.forEach(col => { filtered[col] = row[col]; });
    return filtered;
  });
  columns = selectedNames;

  // 4. Tipos definidos pelo usuário → colTypes (lido pelo tablelens.js)
  colTypes = {};
  colMeta.forEach(m => { colTypes[m.col] = m.type; });

  // 5. Inicializar estado do Table Lens
  //    (variáveis declaradas em tablelens.js)
  focusRowStart = Math.floor(rawData.length / 2);
  focusRowEnd   = focusRowStart;
  focusColStart = null;
  focusColEnd   = null;
  hoverRowIdx   = null;
  sortCol       = null;
  sortAsc       = true;
  viewMode      = 'fullscreen';

  document.body.classList.add('tl-fullscreen-active');
  document.querySelectorAll('.vm-btn').forEach(btn =>
    btn.classList.toggle('vm-btn-active', btn.dataset.mode === 'fullscreen'));

  // 6. Renderizar
  renderStats();
  renderTable();
}
