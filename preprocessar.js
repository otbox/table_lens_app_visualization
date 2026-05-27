// ─── Estado global ────────────────────────────────────────────────────────────
let rawData      = [];   // linhas originais (objeto por linha)
let originalData = [];   // cópia intocada dos dados carregados (para regenerar)
let columns      = [];   // todas as colunas detectadas
let colMeta      = [];   // metadados por coluna: { col, type, missing, sample, impute }
let selectedCols = [];   // índices de colMeta selecionados para visualização
let indexCol     = null; // coluna usada como rótulo de linha (não plotada)

// ─── Dados de exemplo ─────────────────────────────────────────────────────────
const SAMPLE_CSV = `nome,idade,salario,cidade,data_nasc,score
Ana,25,3500,São Paulo,1996-03-12,87.2
Carlos,32,,Rio de Janeiro,1989-07-22,91.0
Julia,29,4800,Campinas,2002-01-05,
Pedro,21,2200,,1995-11-30,78.4
Fernanda,40,9000,Curitiba,,88.9
Marcos,,5600,São Paulo,1978-04-18,82.1
Grace,33,4100,Campinas,1991-08-09,75.3
Hank,27,3300,Rio de Janeiro,1997-02-14,
Ivan,38,7100,São Paulo,1986-10-01,93.5
Julia,24,2500,Belo Horizonte,2000-06-25,79.8`;

// ─── Parsing CSV ──────────────────────────────────────────────────────────────

/**
 * Faz o parse do CSV sem dependências externas.
 * Detecta automaticamente o separador (vírgula ou ponto e vírgula).
 * Mantém todos os valores como string — a tipagem é feita pelo detectType.
 * @param {string} text
 * @returns {{ headers: string[], rows: object[] }}
 */
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim() !== '');

  // detecta separador a partir da primeira linha fora de aspas
  const firstLine = lines[0];
  let sep = ',';
  let inQuote = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuote = !inQuote;
    if (!inQuote && ch === ';') { sep = ';'; break; }
  }

  /**
   * Divide uma linha respeitando campos entre aspas duplas.
   * Ex: 1,"Braund, Mr. Owen",male  →  ['1', 'Braund, Mr. Owen', 'male']
   */
  function splitLine(line) {
    const fields = [];
    let cur = '';
    let inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        // aspas duplas escapadas ("")
        if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQ = !inQ; }
      } else if (ch === sep && !inQ) {
        fields.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
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

/**
 * Detecta o tipo predominante de uma coluna a partir dos seus valores brutos.
 * Prioridade: numérico > data > categórico.
 * @param {string[]} values
 * @returns {'numeric'|'date'|'categorical'}
 */
function detectType(values) {
  const nonEmpty = values.filter(v => v !== '' && v !== null && v !== undefined);
  if (nonEmpty.length === 0) return 'categorical';

  const numCount = nonEmpty.filter(v => !isNaN(parseFloat(v)) && isFinite(v)).length;
  if (numCount / nonEmpty.length > 0.8) return 'numeric';

  const dateRe = /^\d{4}-\d{2}-\d{2}$|^\d{2}\/\d{2}\/\d{4}$/;
  const dateCount = nonEmpty.filter(v => dateRe.test(v)).length;
  if (dateCount / nonEmpty.length > 0.7) return 'date';

  return 'categorical';
}

function getMissingCount(col) {
  return rawData.filter(r => r[col] === '' || r[col] === undefined || r[col] === null).length;
}

/**
 * Constrói o array colMeta a partir do rawData e columns atuais.
 */
function buildColMeta() {
  colMeta = columns.map(col => {
    const vals   = rawData.map(r => r[col]);
    const type   = detectType(vals);
    const missing = getMissingCount(col);
    const sample  = vals.filter(v => v !== '').slice(0, 3).join(', ');
    const impute  = type === 'numeric' ? 'mean'
                  : type === 'categorical' ? 'mode'
                  : 'none';
    return { col, type, missing, sample, impute };
  });
}

// ─── Imputação ────────────────────────────────────────────────────────────────

/**
 * Aplica a estratégia de imputação definida em colMeta sobre uma cópia de rawData.
 * Retorna um novo array de linhas com os valores faltantes preenchidos.
 * @returns {object[]}
 */
function applyImputation() {
  // cópia profunda para não modificar rawData original
  const data = rawData.map(r => ({ ...r }));

  colMeta.forEach(meta => {
    if (meta.missing === 0 || meta.impute === 'none') return;

    const col = meta.col;

    if (meta.impute === 'mean' && meta.type === 'numeric') {
      const nums = data
        .map(r => parseFloat(r[col]))
        .filter(v => !isNaN(v));
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
      data.forEach(r => {
        if (r[col] === '' || r[col] === undefined || r[col] === null) {
          r[col] = String(mean.toFixed(4));
        }
      });

    } else if (meta.impute === 'mode') {
      const freq = {};
      data.forEach(r => {
        const v = r[col];
        if (v !== '' && v !== undefined && v !== null) {
          freq[v] = (freq[v] || 0) + 1;
        }
      });
      const mode = Object.entries(freq).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
      data.forEach(r => {
        if (r[col] === '' || r[col] === undefined || r[col] === null) {
          r[col] = mode;
        }
      });

    } else if (meta.impute === 'linear') {
      // Interpolação linear por índice para numéricos e datas
      const indices = data.map((r, i) => {
        const v = r[col];
        if (v === '' || v === undefined || v === null) return null;
        return meta.type === 'date'
          ? new Date(v).getTime()
          : parseFloat(v);
      });

      for (let i = 0; i < indices.length; i++) {
        if (indices[i] !== null) continue;

        // encontra vizinhos não-nulos
        let left = i - 1;
        let right = i + 1;
        while (left >= 0 && indices[left] === null) left--;
        while (right < indices.length && indices[right] === null) right++;

        let filled = null;
        if (left >= 0 && right < indices.length) {
          // interpola entre os dois vizinhos
          const t = (i - left) / (right - left);
          filled = indices[left] + t * (indices[right] - indices[left]);
        } else if (left >= 0) {
          filled = indices[left];
        } else if (right < indices.length) {
          filled = indices[right];
        }

        if (filled !== null) {
          indices[i] = filled;
          data[i][col] = meta.type === 'date'
            ? new Date(filled).toISOString().slice(0, 10)
            : String(parseFloat(filled.toFixed(4)));
        }
      }
    }
  });

  return data;
}

// ─── Processamento do texto carregado ─────────────────────────────────────────

function processText(text) {
  const parsed = parseCSV(text);
  columns = parsed.headers;
  rawData = parsed.rows;
  originalData = rawData.map(r => ({ ...r }));  // cópia intocada
  buildColMeta();
}

// ─── Carregamento de arquivo ──────────────────────────────────────────────────

function loadSampleData() {
  processText(SAMPLE_CSV);
  showFileInfo('Dados de exemplo carregados — 10 linhas, 6 colunas');
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
    showFileInfo(`Arquivo carregado: ${file.name} — ${rawData.length} linhas, ${columns.length} colunas`);
    showPreprocessPanel();
  };
  reader.readAsText(file);
}

document.getElementById('csv-input').addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) readFile(file);
});

const dropZone = document.getElementById('drop-zone');
dropZone.addEventListener('click', () => document.getElementById('csv-input').click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragging'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragging'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragging');
  const file = e.dataTransfer.files[0];
  if (file) readFile(file);
});

// ─── Painel de pré-processamento ──────────────────────────────────────────────

/**
 * Exibe e renderiza o painel de inspeção + seleção de colunas.
 * Chamado após carregar qualquer dado.
 */
function showPreprocessPanel() {
  renderSummary();
  renderIndexSelect();
  renderColTable();
  renderAttrGrid();
  document.getElementById('preprocess-panel').style.display = 'block';
}

function renderIndexSelect() {
  const container = document.getElementById('index-select-wrap');
  const options = columns.map(col =>
    `<option value="${col}">${col}</option>`
  ).join('');
  container.innerHTML = `
    <label class="pp-index-label">
      Coluna de índice (rótulo das linhas):
      <select class="pp-impute-select" id="index-col-select" onchange="setIndexCol(this.value)">
        <option value="">— nenhuma —</option>
        ${options}
      </select>
    </label>
  `;
  // tenta auto-selecionar primeira coluna não-numérica como sugestão
  const suggested = colMeta.find(m => m.type === 'categorical');
  if (suggested) {
    document.getElementById('index-col-select').value = suggested.col;
    setIndexCol(suggested.col);
  }
}

function setIndexCol(col) {
  indexCol = col || null;
}

function renderSummary() {
  const totalCells   = rawData.length * columns.length;
  const totalMissing = colMeta.reduce((s, m) => s + m.missing, 0);
  const pct = totalCells > 0 ? Math.round(totalMissing / totalCells * 100) : 0;

  document.getElementById('summary-row').innerHTML = `
    <div class="pp-summary-card"><span class="pp-val">${rawData.length}</span><span class="pp-lbl">linhas</span></div>
    <div class="pp-summary-card"><span class="pp-val">${columns.length}</span><span class="pp-lbl">colunas</span></div>
    <div class="pp-summary-card"><span class="pp-val">${totalMissing}</span><span class="pp-lbl">valores faltantes</span></div>
    <div class="pp-summary-card"><span class="pp-val">${pct}%</span><span class="pp-lbl">dados faltantes</span></div>
  `;
}

function renderColTable() {
  const tbody = document.getElementById('col-tbody');
  tbody.innerHTML = '';

  colMeta.forEach((m, i) => {
    const pct      = rawData.length > 0 ? m.missing / rawData.length : 0;
    const fillCls  = pct > 0.3 ? 'bar-high' : pct > 0.1 ? 'bar-med' : 'bar-low';
    const typeLabel = { numeric: 'Numérico', categorical: 'Categórico', date: 'Data' }[m.type];
    const typeCls   = { numeric: 'badge-num', categorical: 'badge-cat', date: 'badge-date' }[m.type];
    const imputeOpts = buildImputeOptions(m.type, m.impute);

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="pp-col-name" title="${m.col}">${m.col}</td>
      <td>
        <span class="pp-badge ${typeCls}">${typeLabel}</span>
        <select class="pp-type-select" id="override-${i}" style="display:none"
                onchange="overrideType(${i}, this.value)">
          <option value="numeric"     ${m.type==='numeric'    ?'selected':''}>Numérico</option>
          <option value="categorical" ${m.type==='categorical'?'selected':''}>Categórico</option>
          <option value="date"        ${m.type==='date'       ?'selected':''}>Data</option>
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
      <td class="pp-sample" title="${m.sample}">${m.sample}</td>
    `;
    tbody.appendChild(tr);
  });
}

function buildImputeOptions(type, current) {
  const opts = type === 'numeric'
    ? [['none','Nenhuma'],['mean','Média'],['mode','Moda'],['linear','Interpolação linear']]
    : type === 'date'
    ? [['none','Nenhuma'],['linear','Interpolação linear']]
    : [['none','Nenhuma'],['mode','Moda']];

  return opts.map(([val, label]) =>
    `<option value="${val}" ${val === current ? 'selected' : ''}>${label}</option>`
  ).join('');
}

function toggleTypeOverride(i) {
  const el = document.getElementById('override-' + i);
  el.style.display = el.style.display === 'none' ? 'inline-block' : 'none';
}

function overrideType(i, newType) {
  colMeta[i].type   = newType;
  colMeta[i].impute = newType === 'numeric' ? 'mean' : newType === 'categorical' ? 'mode' : 'none';
  renderColTable();
}

function setImpute(i, val) {
  colMeta[i].impute = val;
}

// ─── Seleção de atributos ─────────────────────────────────────────────────────

function renderAttrGrid() {
  const grid = document.getElementById('attr-grid');
  grid.innerHTML = '';

  colMeta.forEach((m, i) => {
    const typeLabel = { numeric: 'numérico', categorical: 'categórico', date: 'data' }[m.type];
    const chip = document.createElement('div');
    chip.className = 'pp-chip selected';
    chip.dataset.idx = i;
    chip.addEventListener('click', () => toggleChip(chip, i));
    chip.innerHTML = `
      <div class="pp-chip-check"><div class="pp-chip-inner"></div></div>
      <div>
        <div class="pp-chip-label" title="${m.col}">${m.col}</div>
        <div class="pp-chip-type">${typeLabel}</div>
      </div>
    `;
    grid.appendChild(chip);
  });

  selectedCols = [...Array(colMeta.length).keys()];
  updateSelCount();
}

function toggleChip(chip, idx) {
  const wasSelected = chip.classList.contains('selected');
  chip.classList.toggle('selected', !wasSelected);
  if (!wasSelected) {
    if (!selectedCols.includes(idx)) selectedCols.push(idx);
  } else {
    selectedCols = selectedCols.filter(i => i !== idx);
  }
  updateSelCount();
}

function toggleAllChips(state) {
  document.querySelectorAll('.pp-chip').forEach((chip, i) => chip.classList.toggle('selected', state));
  selectedCols = state ? [...Array(colMeta.length).keys()] : [];
  updateSelCount();
}

function selectChipsByType(type) {
  document.querySelectorAll('.pp-chip').forEach((chip, i) => {
    chip.classList.toggle('selected', colMeta[i].type === type);
  });
  selectedCols = colMeta.map((m, i) => m.type === type ? i : -1).filter(i => i >= 0);
  updateSelCount();
}

function updateSelCount() {
  document.getElementById('sel-count').textContent =
    `${selectedCols.length} de ${colMeta.length} selecionados`;
}

// ─── Finalizar: imputar → filtrar → passar para tablelens ─────────────────────

/**
 * Ponto de integração com tablelens.js.
 * 1. Aplica imputação sobre rawData → data imputada
 * 2. Filtra columns para as selecionadas
 * 3. Atualiza rawData e columns (usados pelo tablelens)
 * 4. Chama renderStats() e renderTable() do tablelens.js
 */
function finalize() {
  if (rawData.length === 0) {
    alert('Carregue um CSV antes de gerar a visualização.');
    return;
  }
  if (selectedCols.length === 0) {
    alert('Selecione ao menos um atributo para visualizar.');
    return;
  }

  // 1. restaurar dados originais antes de imputar (permite regerar)
  rawData = originalData.map(r => ({ ...r }));

  // 2. reconstruir colMeta com os tipos/imputes atuais sobre os dados originais
  // (não chama buildColMeta para não perder as escolhas do usuário)
  const imputedData = applyImputation();

  // 3. filtrar colunas selecionadas (excluindo a coluna de índice)
  const selectedNames = selectedCols.map(i => colMeta[i].col).filter(c => c !== indexCol);

  // 4. sobrescrever as variáveis globais que tablelens.js lê
  rawData = imputedData.map(row => {
    const filtered = {};
    selectedNames.forEach(col => { filtered[col] = row[col]; });
    return filtered;
  });
  columns = selectedNames;

  // 5. passar tipos definidos pelo usuário para o tablelens
  colTypes = {};
  colMeta.forEach(m => { colTypes[m.col] = m.type; });

  // 6. renderizar via tablelens.js
  renderStats();
  renderTable();
}