
// --- CONSTANTS -------------------------------------------------------
const ADMIN_PASSWORD = 'Millwork2024';
const KERF = 0.125;
const END_TRIM = 1.0;
const STOCK_LENGTHS = [96, 120, 144, 168, 192];
const SHEET_WIDTHS  = { '4x8': 48.5, '4x10': 48.5 };
const SHEET_LENGTHS = { '4x8': 96.5, '4x10': 120.5 };
const EB_ROLL_FEET   = 500;
const EB_WASTE_FACTOR = 1.1;
const SUPPLIER_LABELS = { talbert: 'Talbert (Premium)', timber: 'Timber (Standard)' };

function getLBIPassword(){ return localStorage.getItem('lbiq_lbi_password') || 'lbi2024'; }

// --- DEFAULT PRICING -------------------------------------------------
// veneerSpecies keys: talbert_A3_4x8, talbert_A3_4x10, talbert_AA_4x8, talbert_AA_4x10,
//                     talbert_eb_roll,  timber_A3_4x8, ..., timber_eb_roll
function blankVeneerSpecies(xA3_8,xA3_10,xAA_8,xAA_10,xEB){
  return {
    talbert_A3_4x8:0, talbert_A3_4x10:0,
    talbert_AA_4x8:0, talbert_AA_4x10:0, talbert_eb_roll:0,
    timber_A3_4x8:xA3_8||0, timber_A3_4x10:xA3_10||0,
    timber_AA_4x8:xAA_8||0, timber_AA_4x10:xAA_10||0, timber_eb_roll:xEB||0,
  };
}

const DEFAULT_PRICING = {
  veneerSpecies: {
    'Walnut':         blankVeneerSpecies(258,381,350,515,167),
    'White Oak':      blankVeneerSpecies(236,338,303,430,147),
    'Rift White Oak': blankVeneerSpecies(283,431,401,617,167),
    'Maple':          blankVeneerSpecies(),
    'Cherry':         blankVeneerSpecies(),
    'Alder':          blankVeneerSpecies(),
    'Beech':          blankVeneerSpecies(),
    'Custom':         blankVeneerSpecies(185,0,185,0,75),
  },
  lumberSpecies: {
    'Flat Cut White Oak': { price:7.25, resaw:false },
    'Rift White Oak':     { price:11.90, resaw:false },
    'Walnut':             { price:11.20, resaw:false },
    'Stain Grade Poplar': { price:2.50,  resaw:false },
    'Hard Maple':         { price:3.50,  resaw:false },
    'V.G. Hemlock':       { price:7.25,  resaw:true  },
    'V.G. Fir':           { price:0,     resaw:true  },
    'Therm Ash':          { price:7.27,  resaw:false },
    'Therm Poplar':       { price:5.61,  resaw:false },
    'Therm Oak':          { price:12.48, resaw:false },
    'Therm Pine':         { price:7.20,  resaw:false },
    'Therm VG Hemlock':   { price:12.50, resaw:true  },
    'Grey Accoya':        { price:12.25, resaw:false },
    'Custom':             { price:3.25,  resaw:false },
  },
  services: {
    ebServicePerFt:0.50, cutServicePerSqft:0.19,
    assemblyLow:2.00, assemblyHigh:3.00, bracketPrice:2.50,
    millingBase:780, sandingOneSide:453.60, sandingTwoSides:604.80, cuttingCharge:630,
  },
  markup: {
    panels:0, edgeBand:0, lumber:0, milling:0,
    assembly:0, ebService:0, cutService:0, brackets:0,
  },
};

// --- STATE -----------------------------------------------------------
let pricing = JSON.parse(localStorage.getItem('lbiq_pricing') || 'null') || deepCopy(DEFAULT_PRICING);
let veneerConfigs = [];
let lumberConfigs = [];
let veneerCounter = 0;
let lumberCounter = 0;
let isDirty = false;

function deepCopy(o){ return JSON.parse(JSON.stringify(o)); }

// --- AUTH -------------------------------------------------------------
function unlock(){
  const v = document.getElementById('lockPw').value.trim();
  const isAdmin = (v === ADMIN_PASSWORD);
  const isUser  = (v === getLBIPassword());
  if(isAdmin || isUser){
    document.getElementById('lockScreen').style.display = 'none';
    const app = document.getElementById('app');
    app.classList.add('visible');
    document.getElementById('jobDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('adminBtn').style.display = isAdmin ? '' : 'none';
    addVeneerConfig();
    recalcAll();
  } else {
    document.getElementById('lockErr').textContent = 'Incorrect password. Try again.';
    document.getElementById('lockPw').value = '';
    setTimeout(() => document.getElementById('lockErr').textContent = '', 3000);
  }
}
document.getElementById('lockPw').addEventListener('keydown', e => { if(e.key === 'Enter') unlock(); });

function openAdmin(){
  renderAdminModal();
  document.getElementById('adminModal').classList.remove('hidden');
}
function closeAdmin(){ document.getElementById('adminModal').classList.add('hidden'); }

// --- TABS -------------------------------------------------------------
function switchTab(name, btn){
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
}

// --- HELPERS ----------------------------------------------------------
function fmt(n){ return n == null ? '—' : '$' + Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtN(n, dec=0){ return n == null ? '—' : Number(n).toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec}); }
function withMarkup(cost, cat){ const m = pricing.markup[cat]||0; return cost*(1+m/100); }
function markDirty(){ isDirty = true; }
function getSupplier(){ return document.getElementById('jobSupplier')?.value || 'talbert'; }

// --- SPECIES VISIBILITY -----------------------------------------------
function visibleVeneerSpecies(orientation, supplier){
  const sup = supplier || getSupplier();
  const grade = orientation === 'Vertical' ? 'AA' : 'A3';
  return Object.entries(pricing.veneerSpecies).filter(([,p]) => {
    return (p[sup+'_'+grade+'_4x8']||0) > 0 || (p[sup+'_'+grade+'_4x10']||0) > 0;
  }).map(([name]) => name);
}
function visibleLumberSpecies(){
  return Object.entries(pricing.lumberSpecies).filter(([,p]) => (p.price||0) > 0).map(([name]) => name);
}

// --- VENEER CONFIG ----------------------------------------------------
function addVeneerConfig(){
  const id = ++veneerCounter;
  const cfg = {
    id, orientation:'Horizontal', species:'', core:'Fire Rated MDF',
    panelW:12, panelL:96, slatW:3.25, slatL:96, slatsPerPanel:4,
    bracketsPerPanel:8, ebSides:4, assembly:true, satinFinish:true, notes:'',
    calcMode:'sqft', manualQty:0,
  };
  veneerConfigs.push(cfg);
  renderVeneerConfigs();
  recalcAll();
}

function removeVeneerConfig(id){
  veneerConfigs = veneerConfigs.filter(c => c.id !== id);
  renderVeneerConfigs();
  recalcAll();
}

function renderVeneerConfigs(){
  const cont = document.getElementById('veneerConfigs');
  cont.innerHTML = '';
  veneerConfigs.forEach(cfg => {
    const species = visibleVeneerSpecies(cfg.orientation);
    if(!cfg.species && species.length > 0) cfg.species = species[0];

    const modeLabels = {sqft:'By Sq Ft', slats:'By Slat Count', panels:'By Panel Count'};
    const qtyLabel   = cfg.calcMode === 'slats' ? 'Total Slats' : cfg.calcMode === 'panels' ? 'Number of Panels' : '';
    const showQty    = cfg.calcMode !== 'sqft';

    const div = document.createElement('div');
    div.className = 'config-card';
    div.id = 'vcfg-' + cfg.id;
    div.innerHTML = `
      <div class="config-header" onclick="toggleCollapse('vcfg-${cfg.id}')">
        <span class="config-num">PANEL ${veneerConfigs.indexOf(cfg)+1}</span>
        <span class="config-title" id="vtitle-${cfg.id}">${cfg.species||'New Configuration'}</span>
        <span class="config-chevron">▼</span>
        <button class="btn-danger print-hide" onclick="event.stopPropagation();removeVeneerConfig(${cfg.id})" style="margin-left:8px">Remove</button>
      </div>
      <div class="config-body">
        <div class="config-grid">
          <div>
            <label class="field-label">Orientation</label>
            <select id="v-orient-${cfg.id}" onchange="vUpdate(${cfg.id})">
              <option value="Horizontal" ${cfg.orientation==='Horizontal'?'selected':''}>Horizontal Slats (A3)</option>
              <option value="Vertical"   ${cfg.orientation==='Vertical'?'selected':''}>Vertical Slats (AA)</option>
            </select>
          </div>
          <div>
            <label class="field-label">Species</label>
            <select id="v-species-${cfg.id}" onchange="vUpdate(${cfg.id})">
              ${species.length===0
                ? '<option value="">No species priced — see admin</option>'
                : species.map(s => `<option value="${s}" ${cfg.species===s?'selected':''}>${s}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="field-label">Panel Core</label>
            <select id="v-core-${cfg.id}" onchange="vUpdate(${cfg.id})">
              <option value="Fire Rated MDF" ${cfg.core==='Fire Rated MDF'?'selected':''}>Fire Rated MDF</option>
              <option value="Regular MDF"    ${cfg.core==='Regular MDF'?'selected':''}>Regular MDF</option>
            </select>
          </div>
          <div>
            <label class="field-label">Calculate By</label>
            <select id="v-mode-${cfg.id}" onchange="vUpdate(${cfg.id})">
              <option value="sqft"   ${cfg.calcMode==='sqft'?'selected':''}>By Sq Ft (job total)</option>
              <option value="slats"  ${cfg.calcMode==='slats'?'selected':''}>By Slat Count</option>
              <option value="panels" ${cfg.calcMode==='panels'?'selected':''}>By Panel Count</option>
            </select>
          </div>
          ${showQty ? `<div>
            <label class="field-label">${qtyLabel}</label>
            <input type="number" id="v-manualQty-${cfg.id}" value="${cfg.manualQty||''}" step="1" min="1" placeholder="Enter count" oninput="vUpdate(${cfg.id})">
          </div>` : ''}
        </div>
        <hr class="config-divider">
        <span class="section-label">Panel & Slat Dimensions (inches)</span>
        <div class="config-grid">
          <div>
            <label class="field-label">Panel Width</label>
            <input type="number" id="v-panelW-${cfg.id}" value="${cfg.panelW}" step="0.25" min="1" oninput="vUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Panel Length</label>
            <input type="number" id="v-panelL-${cfg.id}" value="${cfg.panelL}" step="0.25" min="1" oninput="vUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Slat Width</label>
            <input type="number" id="v-slatW-${cfg.id}" value="${cfg.slatW}" step="0.0625" min="0.5" oninput="vUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Slat Length</label>
            <input type="number" id="v-slatL-${cfg.id}" value="${cfg.slatL}" step="0.25" min="1" oninput="vUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Slats / Panel</label>
            <input type="number" id="v-slats-${cfg.id}" value="${cfg.slatsPerPanel}" step="1" min="1" oninput="vUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Brackets / Panel</label>
            <input type="number" id="v-brackets-${cfg.id}" value="${cfg.bracketsPerPanel}" step="1" min="0" oninput="vUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Edge Band Sides</label>
            <select id="v-ebsides-${cfg.id}" onchange="vUpdate(${cfg.id})">
              <option value="4" ${cfg.ebSides===4?'selected':''}>4 sides</option>
              <option value="3" ${cfg.ebSides===3?'selected':''}>3 sides</option>
              <option value="2" ${cfg.ebSides===2?'selected':''}>Long sides only</option>
            </select>
          </div>
        </div>
        <hr class="config-divider">
        <div style="display:flex;gap:24px;flex-wrap:wrap">
          <div class="toggle-row">
            <label class="toggle"><input type="checkbox" id="v-assembly-${cfg.id}" ${cfg.assembly?'checked':''} onchange="vUpdate(${cfg.id})"><span class="toggle-slider"></span></label>
            <span class="toggle-label">Assembly included</span>
          </div>
          <div class="toggle-row">
            <label class="toggle"><input type="checkbox" id="v-satin-${cfg.id}" ${cfg.satinFinish?'checked':''} onchange="vUpdate(${cfg.id})"><span class="toggle-slider"></span></label>
            <span class="toggle-label">Satin finish</span>
          </div>
        </div>
        <div id="v-preview-${cfg.id}" class="calc-preview" style="margin-top:16px"></div>
      </div>
    `;
    cont.appendChild(div);
  });
}

function vUpdate(id){
  const cfg = veneerConfigs.find(c => c.id === id);
  if(!cfg) return;
  cfg.orientation    = document.getElementById('v-orient-'+id)?.value || cfg.orientation;
  cfg.core           = document.getElementById('v-core-'+id)?.value || cfg.core;
  cfg.panelW         = parseFloat(document.getElementById('v-panelW-'+id)?.value) || cfg.panelW;
  cfg.panelL         = parseFloat(document.getElementById('v-panelL-'+id)?.value) || cfg.panelL;
  cfg.slatW          = parseFloat(document.getElementById('v-slatW-'+id)?.value) || cfg.slatW;
  cfg.slatL          = parseFloat(document.getElementById('v-slatL-'+id)?.value) || cfg.slatL;
  cfg.slatsPerPanel  = parseInt(document.getElementById('v-slats-'+id)?.value) || cfg.slatsPerPanel;
  cfg.bracketsPerPanel = parseInt(document.getElementById('v-brackets-'+id)?.value) || 0;
  cfg.ebSides        = parseInt(document.getElementById('v-ebsides-'+id)?.value) || 4;
  cfg.assembly       = document.getElementById('v-assembly-'+id)?.checked ?? true;
  cfg.satinFinish    = document.getElementById('v-satin-'+id)?.checked ?? true;
  cfg.calcMode       = document.getElementById('v-mode-'+id)?.value || cfg.calcMode;
  cfg.manualQty      = parseInt(document.getElementById('v-manualQty-'+id)?.value) || 0;

  // re-render if mode changed (shows/hides manual qty input)
  const modeChanged = cfg.calcMode !== (document.getElementById('v-mode-'+id)?.dataset.prev);
  if(document.getElementById('v-mode-'+id)){
    document.getElementById('v-mode-'+id).dataset.prev = cfg.calcMode;
  }

  // update species dropdown when orientation changes
  const specs = visibleVeneerSpecies(cfg.orientation);
  const sel = document.getElementById('v-species-'+id);
  if(sel){
    sel.innerHTML = specs.length === 0
      ? '<option value="">No species priced — see admin</option>'
      : specs.map(s => `<option value="${s}" ${cfg.species===s?'selected':''}>${s}</option>`).join('');
  }
  cfg.species = document.getElementById('v-species-'+id)?.value || cfg.species;

  const titleEl = document.getElementById('vtitle-'+id);
  if(titleEl) titleEl.textContent = cfg.species || 'New Configuration';

  // Re-render config to show/hide manual qty field when mode changes
  if(modeChanged){
    renderVeneerConfigs();
  }

  calcVeneerPreview(cfg);
  recalcAll();
  markDirty();
}

// --- VENEER QUANTITY HELPERS ------------------------------------------
function resolveVeneerQty(cfg, totalSqft){
  const sqftPerPanel = (cfg.panelW * cfg.panelL) / 144;
  if(cfg.calcMode === 'sqft'){
    if(!totalSqft) return null;
    const panelQty   = Math.ceil(totalSqft / sqftPerPanel);
    const totalSlats = panelQty * cfg.slatsPerPanel;
    return { panelQty, totalSlats, effectiveSqft: totalSqft, sqftPerPanel };
  } else if(cfg.calcMode === 'slats'){
    if(!cfg.manualQty) return null;
    const totalSlats = cfg.manualQty;
    const panelQty   = Math.ceil(totalSlats / cfg.slatsPerPanel);
    return { panelQty, totalSlats, effectiveSqft: panelQty * sqftPerPanel, sqftPerPanel };
  } else { // panels
    if(!cfg.manualQty) return null;
    const panelQty   = cfg.manualQty;
    const totalSlats = panelQty * cfg.slatsPerPanel;
    return { panelQty, totalSlats, effectiveSqft: panelQty * sqftPerPanel, sqftPerPanel };
  }
}

function calcVeneerPreview(cfg){
  const preview = document.getElementById('v-preview-'+cfg.id);
  if(!preview) return;
  const totalSqft = parseFloat(document.getElementById('totalSqft')?.value) || 0;
  if(!cfg.slatW || !cfg.panelW || !cfg.panelL){ preview.innerHTML = ''; return; }

  const qty = resolveVeneerQty(cfg, totalSqft);
  if(!qty){ preview.innerHTML = ''; return; }
  const { panelQty, totalSlats } = qty;

  const grade = cfg.orientation === 'Vertical' ? 'AA' : 'A3';
  const colsPerSheet = Math.floor((SHEET_WIDTHS['4x8'] + KERF) / (cfg.slatW + KERF));
  const rowsPerSheet = Math.floor((SHEET_LENGTHS['4x8'] + KERF) / (cfg.slatL + KERF));
  const slatsPerSheet = Math.max(1, colsPerSheet * rowsPerSheet);
  const sheetsNeeded  = Math.ceil(totalSlats / slatsPerSheet);
  const ebLong  = (cfg.slatL / 12) * totalSlats * 2;
  const ebShort = (cfg.slatW / 12) * totalSlats * (cfg.ebSides >= 3 ? (cfg.ebSides === 4 ? 2 : 1) : 0);
  const ebFt    = ebLong + ebShort;
  const ebRolls = Math.ceil(ebFt * EB_WASTE_FACTOR / EB_ROLL_FEET);

  preview.innerHTML = `
    <div class="calc-preview-item"><div class="calc-preview-label">Sq Ft / Panel</div><div class="calc-preview-val">${fmtN(qty.sqftPerPanel,2)} sqft</div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">Panels Needed</div><div class="calc-preview-val">${fmtN(panelQty)}</div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">Total Slats</div><div class="calc-preview-val">${fmtN(totalSlats)}</div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">Slats / Sheet</div><div class="calc-preview-val">${fmtN(slatsPerSheet)}</div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">Sheets Needed</div><div class="calc-preview-val">${fmtN(sheetsNeeded)} <span style="font-size:11px;color:var(--mid)">(${grade})</span></div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">EB Footage</div><div class="calc-preview-val">${fmtN(ebFt,0)} ft</div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">EB Rolls</div><div class="calc-preview-val">${fmtN(ebRolls)}</div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">Brackets</div><div class="calc-preview-val">${fmtN(panelQty * cfg.bracketsPerPanel)}</div></div>
  `;
}

function calcVeneerCost(cfg, totalSqft, supplier){
  if(!cfg.species || !cfg.slatW || !cfg.panelW || !cfg.panelL) return null;
  const sData = pricing.veneerSpecies[cfg.species];
  if(!sData) return null;

  const qty = resolveVeneerQty(cfg, totalSqft);
  if(!qty) return null;
  const { panelQty, totalSlats, effectiveSqft } = qty;

  const sup   = supplier || 'talbert';
  const grade = cfg.orientation === 'Vertical' ? 'AA' : 'A3';
  const colsPerSheet = Math.floor((SHEET_WIDTHS['4x8'] + KERF) / (cfg.slatW + KERF));
  const rowsPerSheet = Math.floor((SHEET_LENGTHS['4x8'] + KERF) / (cfg.slatL + KERF));
  const slatsPerSheet = Math.max(1, colsPerSheet * rowsPerSheet);
  const sheetsNeeded  = Math.ceil(totalSlats / slatsPerSheet);

  const sheetPrice = sData[sup+'_'+grade+'_4x8'] || 0;
  const sheetCost  = sheetsNeeded * sheetPrice;

  const ebLong  = (cfg.slatL/12) * totalSlats * 2;
  const ebShort = (cfg.slatW/12) * totalSlats * (cfg.ebSides>=4?2:cfg.ebSides===3?1:0);
  const ebFt    = ebLong + ebShort;
  const ebRolls     = Math.ceil(ebFt * EB_WASTE_FACTOR / EB_ROLL_FEET);
  const ebRollPrice = sData[sup+'_eb_roll'] || 0;
  const ebMaterialCost = ebRolls * ebRollPrice;
  const ebServiceCost  = ebFt * pricing.services.ebServicePerFt;

  const cutCost      = effectiveSqft * pricing.services.cutServicePerSqft;
  const assemblyCost = cfg.assembly ? effectiveSqft * (cfg.slatsPerPanel<=4 ? pricing.services.assemblyLow : pricing.services.assemblyHigh) : 0;
  const bracketCount = panelQty * cfg.bracketsPerPanel;
  const bracketCost  = bracketCount * pricing.services.bracketPrice;

  const panelLine = withMarkup(sheetCost,      'panels');
  const ebMatLine = withMarkup(ebMaterialCost, 'edgeBand');
  const ebSvcLine = withMarkup(ebServiceCost,  'ebService');
  const cutLine   = withMarkup(cutCost,        'cutService');
  const asmLine   = withMarkup(assemblyCost,   'assembly');
  const bktLine   = withMarkup(bracketCost,    'brackets');

  const subtotal = panelLine+ebMatLine+ebSvcLine+cutLine+asmLine+bktLine;
  return {
    species:cfg.species, orientation:cfg.orientation, grade, supplier:sup,
    sqftPerPanel:qty.sqftPerPanel, panelQty, totalSlats, sheetsNeeded,
    sheetPrice, slatsPerSheet, ebFt, ebRolls, ebRollPrice, bracketCount, effectiveSqft,
    lines:{
      ['Panel Sheets ('+fmtN(sheetsNeeded)+' x '+grade+' 4x8)']: panelLine,
      ['Edge Band Material ('+fmtN(ebRolls)+' rolls)']: ebMatLine,
      ['Edge Band Service ('+fmtN(ebFt,0)+' ft)']: ebSvcLine,
      'Cut Service': cutLine,
      ...(cfg.assembly ? {'Assembly / Packing': asmLine} : {}),
      ['Black Brackets ('+fmtN(bracketCount)+')']: bktLine,
    },
    subtotal,
    sqftCost: effectiveSqft > 0 ? subtotal / effectiveSqft : null,
  };
}

// --- LUMBER CONFIG ---------------------------------------------------
function addLumberConfig(){
  const id = ++lumberCounter;
  const cfg = {
    id, species:'', thickness:0.75, slatW:3.25, slatL:96,
    slatsPerPanel:4, panelW:12, panelL:96, bracketsPerPanel:8,
    sanded:'1-side', cutToLength:true, assembly:true, orientation:'Horizontal', notes:'',
    calcMode:'sqft', manualQty:0,
  };
  lumberConfigs.push(cfg);
  renderLumberConfigs();
  recalcAll();
}

function removeLumberConfig(id){
  lumberConfigs = lumberConfigs.filter(c => c.id !== id);
  renderLumberConfigs();
  recalcAll();
}

function getBestStock(slatL){
  let best = null, bestPieces = 0;
  for(const stockIn of STOCK_LENGTHS){
    const usable = stockIn - END_TRIM;
    const pieces = Math.floor((usable + KERF) / (slatL + KERF));
    if(pieces > bestPieces){ bestPieces=pieces; best=stockIn; }
    else if(pieces===bestPieces && pieces>0 && stockIn<best){ best=stockIn; }
  }
  return { stockIn: best||96, piecesPerBoard: bestPieces||1 };
}

function renderLumberConfigs(){
  const cont = document.getElementById('lumberConfigs');
  cont.innerHTML = '';
  lumberConfigs.forEach(cfg => {
    const species  = visibleLumberSpecies();
    if(!cfg.species && species.length > 0) cfg.species = species[0];
    const sData    = pricing.lumberSpecies[cfg.species] || {};
    const isResaw  = sData.resaw || false;
    const stockInfo = getBestStock(cfg.slatL);
    const stockFt  = stockInfo.stockIn / 12;
    const showQty  = cfg.calcMode !== 'sqft';
    const qtyLabel = cfg.calcMode === 'slats' ? 'Total Slats' : 'Number of Panels';

    const div = document.createElement('div');
    div.className = 'config-card';
    div.id = 'lcfg-' + cfg.id;
    div.innerHTML = `
      <div class="config-header" onclick="toggleCollapse('lcfg-${cfg.id}')">
        <span class="config-num" style="background:var(--gold-dim);color:var(--gold);border-color:var(--gold)">LUMBER ${lumberConfigs.indexOf(cfg)+1}</span>
        <span class="config-title" id="ltitle-${cfg.id}">${cfg.species||'New Configuration'}</span>
        <span class="config-chevron">▼</span>
        <button class="btn-danger print-hide" onclick="event.stopPropagation();removeLumberConfig(${cfg.id})" style="margin-left:8px">Remove</button>
      </div>
      <div class="config-body">
        ${isResaw ? `<div class="note-banner">⚠ Hemlock/Fir: Resaw from 2x6 rough stock — 4 pcs @ 11/16" x 2-1/4" per board. Note to customer: material will be <strong>11/16" thick</strong>.</div>` : ''}
        <div class="config-grid" style="margin-top:${isResaw?'16px':'0'}">
          <div>
            <label class="field-label">Species</label>
            <select id="l-species-${cfg.id}" onchange="lUpdate(${cfg.id})">
              ${species.length===0 ? '<option value="">No species priced — see admin</option>' : species.map(s=>`<option value="${s}" ${cfg.species===s?'selected':''}>${s}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="field-label">Orientation</label>
            <select id="l-orient-${cfg.id}" onchange="lUpdate(${cfg.id})">
              <option value="Horizontal" ${cfg.orientation==='Horizontal'?'selected':''}>Horizontal</option>
              <option value="Vertical"   ${cfg.orientation==='Vertical'?'selected':''}>Vertical</option>
            </select>
          </div>
          <div>
            <label class="field-label">Calculate By</label>
            <select id="l-mode-${cfg.id}" onchange="lUpdate(${cfg.id})">
              <option value="sqft"   ${cfg.calcMode==='sqft'?'selected':''}>By Sq Ft (job total)</option>
              <option value="slats"  ${cfg.calcMode==='slats'?'selected':''}>By Slat Count</option>
              <option value="panels" ${cfg.calcMode==='panels'?'selected':''}>By Panel Count</option>
            </select>
          </div>
          ${showQty ? `<div>
            <label class="field-label">${qtyLabel}</label>
            <input type="number" id="l-manualQty-${cfg.id}" value="${cfg.manualQty||''}" step="1" min="1" placeholder="Enter count" oninput="lUpdate(${cfg.id})">
          </div>` : ''}
        </div>
        <hr class="config-divider">
        <span class="section-label">Slat Dimensions (inches)</span>
        <div class="config-grid">
          <div>
            <label class="field-label">Thickness</label>
            <select id="l-thick-${cfg.id}" onchange="lUpdate(${cfg.id})">
              ${['0.25','0.4375','0.5','0.625','0.6875','0.75','1','1.25','1.5','1.75'].map(t=>`<option value="${t}" ${Math.abs(cfg.thickness-parseFloat(t))<0.001?'selected':''}>${fractionLabel(t)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="field-label">Width</label>
            <input type="number" id="l-slatW-${cfg.id}" value="${cfg.slatW}" step="0.0625" min="0.5" oninput="lUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Length</label>
            <input type="number" id="l-slatL-${cfg.id}" value="${cfg.slatL}" step="0.25" min="1" oninput="lUpdate(${cfg.id})">
            <span class="stock-tag" id="l-stock-${cfg.id}">📏 ${stockFt}' stock · ${stockInfo.piecesPerBoard} pc/board</span>
          </div>
          <div>
            <label class="field-label">Slats / Panel</label>
            <input type="number" id="l-slats-${cfg.id}" value="${cfg.slatsPerPanel}" step="1" min="1" oninput="lUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Panel Width</label>
            <input type="number" id="l-panelW-${cfg.id}" value="${cfg.panelW}" step="0.25" min="1" oninput="lUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Panel Length</label>
            <input type="number" id="l-panelL-${cfg.id}" value="${cfg.panelL}" step="0.25" min="1" oninput="lUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Brackets / Panel</label>
            <input type="number" id="l-brackets-${cfg.id}" value="${cfg.bracketsPerPanel}" step="1" min="0" oninput="lUpdate(${cfg.id})">
          </div>
        </div>
        <hr class="config-divider">
        <div style="display:flex;gap:24px;flex-wrap:wrap">
          <div class="toggle-row">
            <label class="toggle"><input type="checkbox" id="l-assembly-${cfg.id}" ${cfg.assembly?'checked':''} onchange="lUpdate(${cfg.id})"><span class="toggle-slider"></span></label>
            <span class="toggle-label">Assembly included</span>
          </div>
          <div>
            <label class="field-label" style="margin-bottom:5px">Sanding</label>
            <select id="l-sanded-${cfg.id}" onchange="lUpdate(${cfg.id})" style="width:auto">
              <option value="none"    ${cfg.sanded==='none'?'selected':''}>No sanding</option>
              <option value="1-side"  ${cfg.sanded==='1-side'?'selected':''}>1 side</option>
              <option value="2-sides" ${cfg.sanded==='2-sides'?'selected':''}>2 sides</option>
            </select>
          </div>
          <div class="toggle-row">
            <label class="toggle"><input type="checkbox" id="l-cut-${cfg.id}" ${cfg.cutToLength?'checked':''} onchange="lUpdate(${cfg.id})"><span class="toggle-slider"></span></label>
            <span class="toggle-label">Cut to length</span>
          </div>
        </div>
        <div id="l-preview-${cfg.id}" class="calc-preview" style="margin-top:16px"></div>
      </div>
    `;
    cont.appendChild(div);
  });
}

function fractionLabel(t){
  const map = {'0.25':'1/4"','0.4375':'7/16"','0.5':'1/2"','0.625':'5/8"','0.6875':'11/16"',
    '0.75':'3/4"','1':'1"','1.25':'1-1/4"','1.5':'1-1/2"','1.75':'1-3/4"'};
  return map[t] || t+'"';
}

function lUpdate(id){
  const cfg = lumberConfigs.find(c => c.id === id);
  if(!cfg) return;
  cfg.species      = document.getElementById('l-species-'+id)?.value || cfg.species;
  cfg.orientation  = document.getElementById('l-orient-'+id)?.value || cfg.orientation;
  cfg.thickness    = parseFloat(document.getElementById('l-thick-'+id)?.value) || cfg.thickness;
  cfg.slatW        = parseFloat(document.getElementById('l-slatW-'+id)?.value) || cfg.slatW;
  cfg.slatL        = parseFloat(document.getElementById('l-slatL-'+id)?.value) || cfg.slatL;
  cfg.slatsPerPanel = parseInt(document.getElementById('l-slats-'+id)?.value) || cfg.slatsPerPanel;
  cfg.panelW       = parseFloat(document.getElementById('l-panelW-'+id)?.value) || cfg.panelW;
  cfg.panelL       = parseFloat(document.getElementById('l-panelL-'+id)?.value) || cfg.panelL;
  cfg.bracketsPerPanel = parseInt(document.getElementById('l-brackets-'+id)?.value) || 0;
  cfg.assembly     = document.getElementById('l-assembly-'+id)?.checked ?? true;
  cfg.sanded       = document.getElementById('l-sanded-'+id)?.value || cfg.sanded;
  cfg.cutToLength  = document.getElementById('l-cut-'+id)?.checked ?? true;
  const prevMode   = cfg.calcMode;
  cfg.calcMode     = document.getElementById('l-mode-'+id)?.value || cfg.calcMode;
  cfg.manualQty    = parseInt(document.getElementById('l-manualQty-'+id)?.value) || 0;

  const titleEl = document.getElementById('ltitle-'+id);
  if(titleEl) titleEl.textContent = cfg.species || 'New Configuration';

  const stockInfo = getBestStock(cfg.slatL);
  const stockTag  = document.getElementById('l-stock-'+id);
  if(stockTag) stockTag.textContent = `📏 ${stockInfo.stockIn/12}' stock · ${stockInfo.piecesPerBoard} pc/board`;

  if(prevMode !== cfg.calcMode) renderLumberConfigs();

  calcLumberPreview(cfg);
  recalcAll();
  markDirty();
}

function resolveLumberQty(cfg, totalSqft){
  const sqftPerPanel = (cfg.panelW * cfg.panelL) / 144;
  if(cfg.calcMode === 'sqft'){
    if(!totalSqft) return null;
    const panelQty   = Math.ceil(totalSqft / sqftPerPanel);
    const totalSlats = panelQty * cfg.slatsPerPanel;
    return { panelQty, totalSlats, effectiveSqft: totalSqft, sqftPerPanel };
  } else if(cfg.calcMode === 'slats'){
    if(!cfg.manualQty) return null;
    const totalSlats = cfg.manualQty;
    const panelQty   = Math.ceil(totalSlats / cfg.slatsPerPanel);
    return { panelQty, totalSlats, effectiveSqft: panelQty * sqftPerPanel, sqftPerPanel };
  } else {
    if(!cfg.manualQty) return null;
    const panelQty   = cfg.manualQty;
    const totalSlats = panelQty * cfg.slatsPerPanel;
    return { panelQty, totalSlats, effectiveSqft: panelQty * sqftPerPanel, sqftPerPanel };
  }
}

function calcLumberPreview(cfg){
  const preview = document.getElementById('l-preview-'+cfg.id);
  if(!preview) return;
  const totalSqft = parseFloat(document.getElementById('totalSqft')?.value) || 0;
  if(!cfg.slatW || !cfg.panelW || !cfg.panelL){ preview.innerHTML = ''; return; }

  const qty = resolveLumberQty(cfg, totalSqft);
  if(!qty){ preview.innerHTML = ''; return; }
  const { panelQty, totalSlats } = qty;

  const sData    = pricing.lumberSpecies[cfg.species] || {};
  const isResaw  = sData.resaw || false;
  const stockInfo = getBestStock(cfg.slatL);
  const stockFt  = stockInfo.stockIn / 12;

  let boardsNeeded, boardFtTotal;
  if(isResaw){
    boardsNeeded = Math.ceil(totalSlats / 4);
    boardFtTotal = boardsNeeded * (2*6*stockFt/12);
  } else {
    boardsNeeded = Math.ceil(totalSlats / stockInfo.piecesPerBoard);
    boardFtTotal = boardsNeeded * (cfg.thickness * cfg.slatW * stockFt / 12);
  }

  preview.innerHTML = `
    <div class="calc-preview-item"><div class="calc-preview-label">Panels Needed</div><div class="calc-preview-val">${fmtN(panelQty)}</div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">Total Slats</div><div class="calc-preview-val">${fmtN(totalSlats)}</div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">Stock Length</div><div class="calc-preview-val">${stockFt}'</div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">Pcs / Board</div><div class="calc-preview-val">${fmtN(stockInfo.piecesPerBoard)}</div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">Boards Needed</div><div class="calc-preview-val">${fmtN(boardsNeeded)}</div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">Board Footage</div><div class="calc-preview-val">${fmtN(boardFtTotal,1)} BF</div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">Brackets</div><div class="calc-preview-val">${fmtN(panelQty * cfg.bracketsPerPanel)}</div></div>
  `;
}

function calcLumberCost(cfg, totalSqft){
  if(!cfg.species || !cfg.slatW || !cfg.panelW || !cfg.panelL) return null;
  const sData = pricing.lumberSpecies[cfg.species] || {};
  if(!sData.price) return null;

  const qty = resolveLumberQty(cfg, totalSqft);
  if(!qty) return null;
  const { panelQty, totalSlats, effectiveSqft } = qty;

  const isResaw  = sData.resaw || false;
  const stockInfo = getBestStock(cfg.slatL);
  const stockFt  = stockInfo.stockIn / 12;

  let boardsNeeded, boardFtTotal;
  if(isResaw){
    boardsNeeded = Math.ceil(totalSlats / 4);
    boardFtTotal = boardsNeeded * (2*6*stockFt/12);
  } else {
    boardsNeeded = Math.ceil(totalSlats / stockInfo.piecesPerBoard);
    boardFtTotal = boardsNeeded * (cfg.thickness * cfg.slatW * stockFt / 12);
  }

  const lumberCost   = boardFtTotal * sData.price;
  const millingCost  = pricing.services.millingBase;
  const sandingCost  = cfg.sanded==='1-side' ? pricing.services.sandingOneSide :
                       cfg.sanded==='2-sides' ? pricing.services.sandingTwoSides : 0;
  const cuttingCost  = cfg.cutToLength ? pricing.services.cuttingCharge : 0;
  const totalMilling = millingCost + sandingCost + cuttingCost;
  const assemblyCost = cfg.assembly ? effectiveSqft * (cfg.slatsPerPanel<=4 ? pricing.services.assemblyLow : pricing.services.assemblyHigh) : 0;
  const bracketCost  = (panelQty * cfg.bracketsPerPanel) * pricing.services.bracketPrice;

  const lumberLine  = withMarkup(lumberCost,   'lumber');
  const millingLine = withMarkup(totalMilling,  'milling');
  const asmLine     = withMarkup(assemblyCost,  'assembly');
  const bktLine     = withMarkup(bracketCost,   'brackets');

  const subtotal = lumberLine + millingLine + asmLine + bktLine;
  return {
    species:cfg.species, isResaw, stockInfo, boardsNeeded, boardFtTotal,
    panelQty, totalSlats, effectiveSqft,
    lines:{
      ['Lumber ('+fmtN(boardFtTotal,1)+' BF @ '+fmt(sData.price)+'/BF)']: lumberLine,
      'Milling': millingLine,
      ...(cfg.assembly ? {'Assembly / Packing': asmLine} : {}),
      ['Black Brackets ('+fmtN(panelQty*cfg.bracketsPerPanel)+')']: bktLine,
    },
    subtotal,
    sqftCost: effectiveSqft > 0 ? subtotal / effectiveSqft : null,
  };
}

// --- RECALC -----------------------------------------------------------
function recalcAll(){
  const totalSqft = parseFloat(document.getElementById('totalSqft')?.value) || 0;
  veneerConfigs.forEach(cfg => calcVeneerPreview(cfg));
  lumberConfigs.forEach(cfg => calcLumberPreview(cfg));
  renderResults(totalSqft);
}

function renderResults(totalSqft){
  const cont = document.getElementById('resultsContent');
  const supplier = getSupplier();
  const allResults = [];

  veneerConfigs.forEach((cfg,i) => {
    const r = calcVeneerCost(cfg, totalSqft, supplier);
    if(r) allResults.push({...r, label:`Panel Config ${i+1} — ${r.species} (${r.orientation})`});
  });
  lumberConfigs.forEach((cfg,i) => {
    const r = calcLumberCost(cfg, totalSqft);
    if(r) allResults.push({...r, label:`Lumber Config ${i+1} — ${r.species}`});
  });

  if(!allResults.length){
    cont.innerHTML = '<div class="results-empty">Fill in job details and add a configuration above to see results.</div>';
    return;
  }

  const supplierLabel = SUPPLIER_LABELS[supplier] || supplier;
  let html = `<div style="font-size:12px;color:var(--mid);margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid var(--bdr)">Supplier: <strong style="color:var(--teal)">${supplierLabel}</strong></div>`;
  let grandTotal = 0;

  allResults.forEach(r => {
    html += `<div class="result-config"><div class="result-config-title">${r.label}</div>`;
    Object.entries(r.lines).forEach(([label,val]) => {
      html += `<div class="result-row"><span class="result-label">${label}</span><span class="result-value">${fmt(val)}</span></div>`;
    });
    html += `<div class="result-row" style="font-weight:600"><span>Config Subtotal</span><span class="result-value">${fmt(r.subtotal)}</span></div>`;
    if(r.sqftCost != null){
      html += `<div class="result-row"><span class="result-label">Cost per sq ft</span><span class="result-value">${fmt(r.sqftCost)}/sqft</span></div>`;
    }
    html += '</div>';
    grandTotal += r.subtotal;
  });

  html += `<div class="result-total-card">`;
  if(allResults.length > 1){
    allResults.forEach(r => {
      html += `<div class="result-total-row"><span class="result-label">${r.label}</span><span style="font-family:var(--font-mono)">${fmt(r.subtotal)}</span></div>`;
    });
  }
  const totalEffSqft = allResults.reduce((s,r) => s + (r.effectiveSqft||0), 0);
  if(totalEffSqft > 0){
    html += `<div class="result-total-row"><span class="result-label">Cost per sq ft (total)</span><span style="font-family:var(--font-mono)">${fmt(grandTotal/totalEffSqft)}/sqft</span></div>`;
  }
  html += `<div class="result-total-row grand"><span class="result-label">TOTAL ESTIMATE</span><span>${fmt(grandTotal)}</span></div>`;
  html += '</div>';

  const jobName  = document.getElementById('jobName')?.value || '';
  const customer = document.getElementById('jobCustomer')?.value || 'LBI';
  const poNum    = document.getElementById('jobPO')?.value || '';
  const date     = document.getElementById('jobDate')?.value || '';
  const sqftDisp = totalEffSqft > 0 ? fmtN(totalEffSqft) + ' sqft' : '';
  const printHdr = `<div style="display:none" class="print-header">
    <div style="font-size:22px;font-weight:800">${jobName}</div>
    <div style="color:#555;margin-top:4px">${customer}${poNum?' | '+poNum:''} | ${date}${sqftDisp?' | '+sqftDisp:''}</div>
    <hr style="margin:12px 0">
  </div>`;

  cont.innerHTML = printHdr + html;
  document.querySelectorAll('.print-header').forEach(el => { el.style.display=''; });
}

// --- COLLAPSE ---------------------------------------------------------
function toggleCollapse(id){
  const card = document.getElementById(id);
  if(card) card.classList.toggle('collapsed');
}

// --- JOB SAVE / LOAD -------------------------------------------------
function buildJobObject(){
  return {
    id: Date.now(),
    name:     document.getElementById('jobName')?.value || 'Untitled',
    customer: document.getElementById('jobCustomer')?.value || '',
    po:       document.getElementById('jobPO')?.value || '',
    date:     document.getElementById('jobDate')?.value || '',
    sqft:     document.getElementById('totalSqft')?.value || '',
    notes:    document.getElementById('jobNotes')?.value || '',
    supplier: document.getElementById('jobSupplier')?.value || 'talbert',
    veneerConfigs: deepCopy(veneerConfigs),
    lumberConfigs: deepCopy(lumberConfigs),
    savedAt: new Date().toISOString(),
  };
}

function saveJob(){
  const job  = buildJobObject();
  const jobs = JSON.parse(localStorage.getItem('lbiq_jobs') || '[]');
  const idx  = jobs.findIndex(j => j.name===job.name && j.date===job.date);
  if(idx >= 0) jobs[idx] = {...jobs[idx], ...job, id:jobs[idx].id};
  else jobs.unshift(job);
  localStorage.setItem('lbiq_jobs', JSON.stringify(jobs));
  isDirty = false;
  showToast('Job saved!');
}

function loadJob(job){
  document.getElementById('jobName').value     = job.name     || '';
  document.getElementById('jobCustomer').value = job.customer || '';
  document.getElementById('jobPO').value       = job.po       || '';
  document.getElementById('jobDate').value     = job.date     || '';
  document.getElementById('totalSqft').value   = job.sqft     || '';
  document.getElementById('jobNotes').value    = job.notes    || '';
  const supEl = document.getElementById('jobSupplier');
  if(supEl && job.supplier) supEl.value = job.supplier;
  veneerConfigs  = job.veneerConfigs || [];
  lumberConfigs  = job.lumberConfigs || [];
  veneerCounter  = veneerConfigs.reduce((m,c) => Math.max(m,c.id), 0);
  lumberCounter  = lumberConfigs.reduce((m,c) => Math.max(m,c.id), 0);
  renderVeneerConfigs();
  renderLumberConfigs();
  recalcAll();
  closeSavedJobs();
  isDirty = false;
}

function openSavedJobs(){
  const jobs = JSON.parse(localStorage.getItem('lbiq_jobs') || '[]');
  const list = document.getElementById('savedJobsList');
  if(!jobs.length){
    list.innerHTML = '<p style="color:var(--mid);font-size:14px">No saved jobs yet.</p>';
  } else {
    list.innerHTML = jobs.map(j => `
      <div class="saved-job-card">
        <div class="saved-job-info">
          <div class="saved-job-name">${j.name||'Untitled'}</div>
          <div class="saved-job-meta">${j.customer||''} ${j.po?'| '+j.po:''} | ${j.sqft||'?'} sqft | ${j.date||''}</div>
        </div>
        <button class="btn-secondary" onclick="loadJob(${JSON.stringify(j).replace(/"/g,'"')})">Load</button>
        <button class="btn-ghost" onclick="copyJobCode(${JSON.stringify(j).replace(/"/g,'"')})">Share</button>
        <button class="btn-danger" onclick="deleteJob(${j.id})">✕</button>
      </div>
    `).join('');
  }
  document.getElementById('savedModal').classList.remove('hidden');
}

function closeSavedJobs(){ document.getElementById('savedModal').classList.add('hidden'); }

function deleteJob(id){
  let jobs = JSON.parse(localStorage.getItem('lbiq_jobs') || '[]');
  jobs = jobs.filter(j => j.id !== id);
  localStorage.setItem('lbiq_jobs', JSON.stringify(jobs));
  openSavedJobs();
}

function copyJobCode(job){
  const code = btoa(JSON.stringify(job));
  navigator.clipboard.writeText(code)
    .then(() => showToast('Job code copied!'))
    .catch(() => prompt('Copy this job code:', code));
}

function importJobCode(){
  const raw = document.getElementById('importCodeInput')?.value?.trim();
  if(!raw){ showToast('Paste a job code first'); return; }
  try {
    const job = JSON.parse(atob(raw));
    loadJob(job);
    showToast('Job imported!');
  } catch(e){ showToast('Invalid job code'); }
}

function newJob(){
  if(isDirty && !confirm('You have unsaved changes. Start a new job anyway?')) return;
  document.getElementById('jobName').value     = '';
  document.getElementById('jobCustomer').value = 'LBI';
  document.getElementById('jobPO').value       = '';
  document.getElementById('jobDate').value     = new Date().toISOString().split('T')[0];
  document.getElementById('totalSqft').value   = '500';
  document.getElementById('jobNotes').value    = '';
  const supEl = document.getElementById('jobSupplier');
  if(supEl) supEl.value = 'talbert';
  veneerConfigs = []; lumberConfigs = [];
  veneerCounter = 0; lumberCounter = 0;
  renderVeneerConfigs(); renderLumberConfigs();
  addVeneerConfig();
  recalcAll(); isDirty = false;
}

// --- ADMIN MODAL -------------------------------------------------------
function renderAdminModal(){
  // LBI Password
  const lbiPwEl = document.getElementById('admin-lbi-password');
  if(lbiPwEl) lbiPwEl.value = getLBIPassword();

  // Markup grid
  const mg = document.getElementById('markupGrid');
  const markupLabels = {
    panels:'Panel Sheets', edgeBand:'Edge Band Material', lumber:'Lumber Material',
    milling:'Milling / Sanding', assembly:'Assembly', ebService:'EB Service',
    cutService:'Cut Service', brackets:'Brackets',
  };
  mg.innerHTML = Object.entries(markupLabels).map(([k,lbl]) => `
    <div>
      <label class="field-label">${lbl} Markup %</label>
      <input type="number" id="mkp-${k}" value="${pricing.markup[k]||0}" step="0.5" min="0" max="200"
        style="background:var(--surf3);border:1px solid var(--bdr2);border-radius:var(--r);color:var(--ink);padding:8px 10px;width:100%">
    </div>
  `).join('');

  // Veneer species table — two rows per species (Talbert + Timber)
  const vb = document.getElementById('veneerPricingBody');
  vb.innerHTML = Object.entries(pricing.veneerSpecies).map(([name, p]) => {
    const id = name.replace(/\s/g,'_');
    const row = (sup, label, color) => `
      <tr>
        ${sup === 'talbert' ? `<td rowspan="2" style="font-weight:600;white-space:nowrap;vertical-align:middle">${name}</td>` : ''}
        <td style="font-size:11px;font-weight:700;letter-spacing:.5px;color:${color};white-space:nowrap">${label}</td>
        <td><input type="number" class="admin-price-input" value="${p[sup+'_A3_4x8']||0}" step="1" data-species="${name}" data-key="${sup}_A3_4x8"></td>
        <td><input type="number" class="admin-price-input" value="${p[sup+'_A3_4x10']||0}" step="1" data-species="${name}" data-key="${sup}_A3_4x10"></td>
        <td><input type="number" class="admin-price-input" value="${p[sup+'_AA_4x8']||0}" step="1" data-species="${name}" data-key="${sup}_AA_4x8"></td>
        <td><input type="number" class="admin-price-input" value="${p[sup+'_AA_4x10']||0}" step="1" data-species="${name}" data-key="${sup}_AA_4x10"></td>
        <td><input type="number" class="admin-price-input" value="${p[sup+'_eb_roll']||0}" step="1" data-species="${name}" data-key="${sup}_eb_roll"></td>
      </tr>`;
    return row('talbert','Talbert','var(--teal)') + row('timber','Timber','var(--gold)');
  }).join('');

  // Lumber pricing
  const lb = document.getElementById('lumberPricingBody');
  lb.innerHTML = Object.entries(pricing.lumberSpecies).map(([name,p]) => `
    <tr>
      <td style="font-weight:600;white-space:nowrap">${name}</td>
      <td><input type="number" class="admin-price-input" value="${p.price||0}" step="0.01"
          data-species="${name}" data-key="price" data-table="lumber"></td>
      <td style="text-align:center"><input type="checkbox" ${p.resaw?'checked':''}
          data-species="${name}" data-key="resaw" data-table="lumber"></td>
    </tr>
  `).join('');

  // Service rates
  const sg = document.getElementById('serviceRatesGrid');
  const svcLabels = {
    ebServicePerFt:'EB Service ($/ft)', cutServicePerSqft:'Cut Service ($/sqft)',
    assemblyLow:'Assembly ≤4 slats ($/sqft)', assemblyHigh:'Assembly ≥5 slats ($/sqft)',
    bracketPrice:'Black Bracket ($/ea)', millingBase:'Milling Base ($)',
    sandingOneSide:'Sanding 1-Side ($)', sandingTwoSides:'Sanding 2-Sides ($)',
    cuttingCharge:'Cutting Charge ($)',
  };
  sg.innerHTML = Object.entries(svcLabels).map(([k,lbl]) => `
    <div>
      <label class="field-label">${lbl}</label>
      <input type="number" id="svc-${k}" value="${pricing.services[k]||0}" step="0.01" min="0"
        style="background:var(--surf3);border:1px solid var(--bdr2);border-radius:var(--r);color:var(--ink);padding:8px 10px;width:100%">
    </div>
  `).join('');
}

function saveAdmin(){
  // LBI password
  const lbiPw = document.getElementById('admin-lbi-password')?.value?.trim();
  if(lbiPw) localStorage.setItem('lbiq_lbi_password', lbiPw);

  // Markup
  ['panels','edgeBand','lumber','milling','assembly','ebService','cutService','brackets'].forEach(k => {
    const el = document.getElementById('mkp-'+k);
    if(el) pricing.markup[k] = parseFloat(el.value) || 0;
  });

  // Veneer species
  document.querySelectorAll('#veneerPricingBody input[data-species]').forEach(el => {
    const s = el.dataset.species, k = el.dataset.key;
    if(!pricing.veneerSpecies[s]) pricing.veneerSpecies[s] = {};
    pricing.veneerSpecies[s][k] = parseFloat(el.value) || 0;
  });

  // Lumber
  document.querySelectorAll('#lumberPricingBody input[data-species]').forEach(el => {
    const s = el.dataset.species, k = el.dataset.key, table = el.dataset.table;
    if(table === 'lumber'){
      if(!pricing.lumberSpecies[s]) pricing.lumberSpecies[s] = {};
      if(k === 'resaw') pricing.lumberSpecies[s].resaw = el.checked;
      else pricing.lumberSpecies[s][k] = parseFloat(el.value) || 0;
    }
  });
  document.querySelectorAll('#lumberPricingBody input[type=checkbox][data-key=resaw]').forEach(el => {
    const s = el.dataset.species;
    if(pricing.lumberSpecies[s]) pricing.lumberSpecies[s].resaw = el.checked;
  });

  // Services
  Object.keys(pricing.services).forEach(k => {
    const el = document.getElementById('svc-'+k);
    if(el) pricing.services[k] = parseFloat(el.value) || 0;
  });

  localStorage.setItem('lbiq_pricing', JSON.stringify(pricing));
  renderVeneerConfigs();
  renderLumberConfigs();
  recalcAll();
  closeAdmin();
  showToast('Pricing saved!');
}

function addCustomSpecies(type){
  const name = prompt('Enter new species name:');
  if(!name || !name.trim()) return;
  const n = name.trim();
  if(type === 'veneer'){
    if(!pricing.veneerSpecies[n]) pricing.veneerSpecies[n] = blankVeneerSpecies();
  } else {
    if(!pricing.lumberSpecies[n]) pricing.lumberSpecies[n] = {price:0, resaw:false};
  }
  renderAdminModal();
}

// --- TOAST ------------------------------------------------------------
function showToast(msg){
  let t = document.getElementById('toast');
  if(!t){
    t = document.createElement('div'); t.id = 'toast';
    Object.assign(t.style, {
      position:'fixed', bottom:'24px', left:'50%', transform:'translateX(-50%)',
      background:'var(--teal)', color:'#0f1112', padding:'10px 22px', borderRadius:'30px',
      fontFamily:'var(--font-head)', fontWeight:'700', fontSize:'15px',
      zIndex:'9999', transition:'opacity .3s', opacity:'0', pointerEvents:'none',
    });
    document.body.appendChild(t);
  }
  t.textContent = msg; t.style.opacity = '1';
  clearTimeout(t._tid); t._tid = setTimeout(() => t.style.opacity='0', 2500);
}

// --- INIT -------------------------------------------------------------
(function mergePricing(){
  const dp = DEFAULT_PRICING;

  // Migrate old single-price format (A3_4x8) → timber keys (those prices were always Timber)
  Object.entries(pricing.veneerSpecies).forEach(([name, p]) => {
    if('A3_4x8' in p){
      p.timber_A3_4x8  = p.A3_4x8;  delete p.A3_4x8;
      p.timber_A3_4x10 = p.A3_4x10; delete p.A3_4x10;
      p.timber_AA_4x8  = p.AA_4x8;  delete p.AA_4x8;
      p.timber_AA_4x10 = p.AA_4x10; delete p.AA_4x10;
      p.timber_eb_roll  = p.eb_roll;  delete p.eb_roll;
      if(p.talbert_A3_4x8 == null) p.talbert_A3_4x8  = 0;
      if(p.talbert_A3_4x10 == null) p.talbert_A3_4x10 = 0;
      if(p.talbert_AA_4x8 == null) p.talbert_AA_4x8  = 0;
      if(p.talbert_AA_4x10 == null) p.talbert_AA_4x10 = 0;
      if(p.talbert_eb_roll == null) p.talbert_eb_roll  = 0;
    }
    // Fix prices stored as talbert when they should be timber (one-time swap for earlier test data)
    const keys = ['A3_4x8','A3_4x10','AA_4x8','AA_4x10','eb_roll'];
    const hasTimberPrices = keys.some(k => (p['timber_'+k]||0) > 0);
    if(!hasTimberPrices){
      keys.forEach(k => {
        p['timber_'+k] = p['talbert_'+k] || 0;
        p['talbert_'+k] = 0;
      });
    }
  });

  // Merge new default species
  Object.keys(dp.veneerSpecies).forEach(k => {
    if(!pricing.veneerSpecies[k]) pricing.veneerSpecies[k] = deepCopy(dp.veneerSpecies[k]);
    else {
      // ensure all supplier keys exist
      const def = dp.veneerSpecies[k];
      Object.keys(def).forEach(pk => {
        if(pricing.veneerSpecies[k][pk] == null) pricing.veneerSpecies[k][pk] = def[pk];
      });
    }
  });
  Object.keys(dp.lumberSpecies).forEach(k => {
    if(!pricing.lumberSpecies[k]) pricing.lumberSpecies[k] = deepCopy(dp.lumberSpecies[k]);
  });
  Object.keys(dp.markup).forEach(k => {
    if(pricing.markup[k] == null) pricing.markup[k] = dp.markup[k];
  });
  Object.keys(dp.services).forEach(k => {
    if(pricing.services[k] == null) pricing.services[k] = dp.services[k];
  });
  localStorage.setItem('lbiq_pricing', JSON.stringify(pricing));
})();
