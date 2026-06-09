
// --- CONSTANTS -------------------------------------------------------
const ADMIN_PASSWORD = 'Millwork2024';
const KERF = 0.125;
const RESAW_KERF = 0.0625;   // thin-kerf blade for resaw/rip operations on 2x6
const TWO_X_SIX_T = 1.5;    // 2x6 actual thickness (inches)
const TWO_X_SIX_W = 6.0;    // 2x6 nominal width (inches, rough/green)
const END_TRIM = 4.0;
const STOCK_LENGTHS = [96, 120, 144, 168, 192];
const SHEET_WIDTHS  = { '4x8': 48.5, '4x10': 48.5 };
const SHEET_LENGTHS = { '4x8': 96.5, '4x10': 120.5 };
const EB_ROLL_FEET   = 500;
const EB_WASTE_FACTOR = 1.1;
const SUPPLIER_LABELS = { talbert: 'Talbert (Premium)', timber: 'Timber (Standard)' };

function getLBIPassword(){ return localStorage.getItem('lbiq_lbi_password') || 'lbi2024'; }

// --- MILL LOOKUP TABLES ----------------------------------------------
// Width waste factor: additional inches lost per rip (includes saw kerf + edge prep)
// Source: mill production guide
function getWidthWasteFactor(finishedW){
  if(finishedW <= 1.000) return 1.000;   // 1/4" – 1"
  if(finishedW <= 1.500) return 1.125;   // 1-1/8" – 1-1/2"
  if(finishedW <= 2.375) return 1.375;   // 1-5/8" – 2-3/8"
  if(finishedW <= 3.375) return 1.625;   // 2-1/2" – 3-3/8"
  if(finishedW <= 4.375) return 1.750;   // 3-1/2" – 4-3/8"
  if(finishedW <= 6.375) return 2.000;   // 4-1/2" – 6-3/8"
  return 2.500;                          // 6-1/2" – 8-3/4"+
}

// Rough thickness to purchase for a given finished thickness
// Source: mill thickness chart
function getSuggestedRoughThick(finishedT){
  if(finishedT <= 0.8125) return 1.00;   // ≤ 13/16" → 4/4
  if(finishedT <= 1.0625) return 1.25;   // 7/8" – 1-1/16" → 5/4
  if(finishedT <= 1.3125) return 1.50;   // 1-1/8" – 1-5/16" → 6/4
  if(finishedT <= 1.8125) return 2.00;   // 1-3/8" – 1-13/16" → 8/4
  if(finishedT <= 2.0000) return 2.50;   // 1-7/8" – 2" → 10/4
  return 3.00;                           // > 2" → 12/4
}

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
    ebServicePerFt: 0.50, cutServicePerSqft: 0.19,
    assembly: 1.50, bracketPrice: 2.50,
    millingFlat: 780, millingThreshold: 3000, millingPerLF: 0.21, seriesChange: 115,
    sandingFlat: 240, sandingThreshold: 1700, sandingPerLF: 0.19,
    cutFlat: 500, cutThreshold: 3000, cutPerLF: 0.21,
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
const SESSION_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours

function saveSession(role){
  localStorage.setItem('lbiq_session_role',   role);
  localStorage.setItem('lbiq_session_expiry', Date.now() + SESSION_DURATION_MS);
}

function clearSession(){
  localStorage.removeItem('lbiq_session_role');
  localStorage.removeItem('lbiq_session_expiry');
}

function getValidSession(){
  const role   = localStorage.getItem('lbiq_session_role');
  const expiry = parseInt(localStorage.getItem('lbiq_session_expiry') || '0');
  if(role && Date.now() < expiry) return role;
  clearSession();
  return null;
}

function activateApp(isAdmin){
  document.getElementById('lockScreen').style.display = 'none';
  const app = document.getElementById('app');
  app.classList.add('visible');
  document.getElementById('adminBtn').style.display   = isAdmin ? '' : 'none';
  document.getElementById('logoutBtn').style.display  = '';
  document.getElementById('jobDate').value = new Date().toISOString().split('T')[0];
  addVeneerConfig();
  addLumberConfig();
  recalcAll();
}

function unlock(){
  const v = document.getElementById('lockPw').value.trim();
  const isAdmin = (v === ADMIN_PASSWORD);
  const isUser  = (v === getLBIPassword());
  if(isAdmin || isUser){
    saveSession(isAdmin ? 'admin' : 'user');
    activateApp(isAdmin);
  } else {
    document.getElementById('lockErr').textContent = 'Incorrect password. Try again.';
    document.getElementById('lockPw').value = '';
    setTimeout(() => document.getElementById('lockErr').textContent = '', 3000);
  }
}
document.getElementById('lockPw').addEventListener('keydown', e => { if(e.key === 'Enter') unlock(); });

function logout(){
  clearSession();
  veneerConfigs = []; lumberConfigs = [];
  veneerCounter = 0;  lumberCounter = 0;
  document.getElementById('app').classList.remove('visible');
  document.getElementById('lockScreen').style.display = '';
  document.getElementById('logoutBtn').style.display  = 'none';
  document.getElementById('lockPw').value = '';
}

// Auto-restore session — called after mergePricing() at bottom of file
function checkSession(){
  const role = getValidSession();
  if(role){
    saveSession(role); // bump expiry on each load
    activateApp(role === 'admin');
  }
}

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
  const sup = supplier || 'talbert';
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
    grade:'timber',
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
    if(!cfg.grade) cfg.grade = 'talbert';
    const species = visibleVeneerSpecies(cfg.orientation, cfg.grade);
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
            <label class="field-label">Grade</label>
            <select id="v-grade-${cfg.id}" onchange="vUpdate(${cfg.id})">
              <option value="talbert" ${(cfg.grade||'talbert')==='talbert'?'selected':''}>Premium</option>
              <option value="timber"  ${(cfg.grade||'talbert')==='timber'?'selected':''}>Standard</option>
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
  cfg.grade          = document.getElementById('v-grade-'+id)?.value || cfg.grade || 'talbert';
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

  // update species dropdown when orientation or grade changes
  const specs = visibleVeneerSpecies(cfg.orientation, cfg.grade);
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

function calcVeneerCost(cfg, totalSqft){
  if(!cfg.species || !cfg.slatW || !cfg.panelW || !cfg.panelL) return null;
  const sData = pricing.veneerSpecies[cfg.species];
  if(!sData) return null;

  const qty = resolveVeneerQty(cfg, totalSqft);
  if(!qty) return null;
  const { panelQty, totalSlats, effectiveSqft } = qty;

  const sup   = cfg.grade || 'talbert';
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
  const assemblyCost = cfg.assembly ? effectiveSqft * pricing.services.assembly : 0;
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
    species:cfg.species, orientation:cfg.orientation, grade, supplier:sup, cfgGrade:sup,
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
    sanding:false, cutToLength:true, assembly:true, orientation:'Horizontal', notes:'',
    calcMode:'sqft', manualQty:0,
    roughThick:getSuggestedRoughThick(0.75), safetyBuffer:false,
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
    const pieces = Math.floor(usable / slatL);
    if(pieces > bestPieces){ bestPieces=pieces; best=stockIn; }
    else if(pieces===bestPieces && pieces>0 && stockIn<best){ best=stockIn; }
  }
  return { stockIn: best||96, piecesPerBoard: Math.max(1,bestPieces) };
}

// Stock length for a given slat length (Heath's mill rules)
// 72"+ → use next standard length above slat; <72" → pack multiples (getBestStock)
function getMillStockLength(slatL){
  if(slatL >= 72){
    if(slatL <= 95)  return 96;   // 8'
    if(slatL <= 119) return 120;  // 10'
    if(slatL <= 143) return 144;  // 12'
    if(slatL <= 167) return 168;  // 14'
    return 192;                   // 16'
  }
  return getBestStock(slatL).stockIn; // <72": maximize pieces per board
}

// VG Fir/Hemlock: pieces per 2×6 board — width rips × thickness slabs
// 2×6 stock: 1.5" actual thickness, ~6" rough width; thin-kerf resaw/rip (RESAW_KERF = 1/16")
// Slabs from thickness:  floor(1.5 / (slatT + RESAW_KERF))
//   11/16" (0.6875): 1.5/0.75 = 2 slabs  |  3/4" (0.75): 1.5/0.8125 = 1 slab
// Strips from width:     floor(6 / (slatW + RESAW_KERF))
//   1.75":  6/1.8125 = 3 strips  |  2.75":  6/2.8125 = 2 strips
// Examples: 11/16"×1.75" → 2×3=6 ✓  3/4"×1.75" → 1×3=3 ✓
//           11/16"×2.75" → 2×2=4 ✓  3/4"×2.75" → 1×2=2 ✓
function getVGPcsPerBoard(slatT, slatW){
  const slabs  = Math.floor(TWO_X_SIX_T / (slatT + RESAW_KERF));
  const strips = Math.floor(TWO_X_SIX_W / (slatW + RESAW_KERF));
  return Math.max(1, slabs * strips);
}

const ROUGH_THICKNESSES = [
  {val:1.0,   label:'4/4  (1")'},
  {val:1.25,  label:'5/4  (1-1/4")'},
  {val:1.5,   label:'6/4  (1-1/2")'},
  {val:1.75,  label:'7/4  (1-3/4")'},
  {val:2.0,   label:'8/4  (2")'},
  {val:2.5,   label:'10/4 (2-1/2")'},
  {val:3.0,   label:'12/4 (3")'},
];

function renderLumberConfigs(){
  const cont = document.getElementById('lumberConfigs');
  cont.innerHTML = '';
  lumberConfigs.forEach(cfg => {
    const species  = visibleLumberSpecies();
    if(!cfg.species && species.length > 0) cfg.species = species[0];
    const sData    = pricing.lumberSpecies[cfg.species] || {};
    const isResaw  = sData.resaw || false;
    const millStockIn = getMillStockLength(cfg.slatL);
    const stockFt     = millStockIn / 12;
    const pcsPerLen   = cfg.slatL >= 72 ? 1 : Math.max(1, Math.floor((millStockIn - END_TRIM) / cfg.slatL));
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
        ${isResaw ? `<div class="note-banner" id="lresaw-note-${cfg.id}">⚠ Hemlock/Fir: Milled from 2×6 rough stock — pcs per board depends on slat dimensions (see Lumber Calculation below).</div>` : ''}
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
        <span class="section-label">Finished Slat Dimensions (inches)</span>
        <div class="config-grid">
          <div>
            <label class="field-label">Finished Thickness</label>
            <select id="l-thick-${cfg.id}" onchange="lUpdate(${cfg.id})">
              ${['0.25','0.4375','0.5','0.625','0.6875','0.75','1','1.25','1.5','1.75'].map(t=>`<option value="${t}" ${Math.abs(cfg.thickness-parseFloat(t))<0.001?'selected':''}>${fractionLabel(t)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="field-label">Finished Width</label>
            <input type="number" id="l-slatW-${cfg.id}" value="${cfg.slatW}" step="0.0625" min="0.5" oninput="lUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Finished Length</label>
            <input type="number" id="l-slatL-${cfg.id}" value="${cfg.slatL}" step="0.25" min="1" oninput="lUpdate(${cfg.id})">
            <span class="stock-tag" id="l-stock-${cfg.id}">📏 ${stockFt}' stock · ${pcsPerLen} pc/length</span>
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
          <div class="toggle-row">
            <label class="toggle"><input type="checkbox" id="l-sanding-${cfg.id}" ${cfg.sanding?'checked':''} onchange="lUpdate(${cfg.id})"><span class="toggle-slider"></span></label>
            <span class="toggle-label">Sanding</span>
          </div>
          <div class="toggle-row">
            <label class="toggle"><input type="checkbox" id="l-cut-${cfg.id}" ${cfg.cutToLength?'checked':''} onchange="lUpdate(${cfg.id})"><span class="toggle-slider"></span></label>
            <span class="toggle-label">Cut to length</span>
          </div>
          <div class="toggle-row">
            <label class="toggle"><input type="checkbox" id="l-safety-${cfg.id}" ${cfg.safetyBuffer?'checked':''} onchange="lUpdate(${cfg.id})"><span class="toggle-slider"></span></label>
            <span class="toggle-label">+10% safety buffer</span>
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
  cfg.sanding      = document.getElementById('l-sanding-'+id)?.checked ?? false;
  cfg.cutToLength  = document.getElementById('l-cut-'+id)?.checked ?? true;
  const prevMode   = cfg.calcMode;
  cfg.calcMode     = document.getElementById('l-mode-'+id)?.value || cfg.calcMode;
  cfg.manualQty    = parseInt(document.getElementById('l-manualQty-'+id)?.value) || 0;
  cfg.roughThick   = getSuggestedRoughThick(cfg.thickness);
  cfg.safetyBuffer = document.getElementById('l-safety-'+id)?.checked ?? false;

  const titleEl = document.getElementById('ltitle-'+id);
  if(titleEl) titleEl.textContent = cfg.species || 'New Configuration';

  const millStockIn   = getMillStockLength(cfg.slatL);
  const millPcsPerLen = cfg.slatL >= 72 ? 1 : Math.max(1, Math.floor((millStockIn - END_TRIM) / cfg.slatL));
  const stockTag      = document.getElementById('l-stock-'+id);
  if(stockTag) stockTag.textContent = `📏 ${millStockIn/12}' stock · ${millPcsPerLen} pc/length`;

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

function millLumberCalc(cfg, totalSlats){
  const sData    = pricing.lumberSpecies[cfg.species] || {};
  const isVGResaw = !!(sData.resaw);
  const defectPct = pricing.services.lumberDefectPct || 0;

  // --- Stock length ---
  const stockIn = getMillStockLength(cfg.slatL);
  const stockFt = stockIn / 12;

  // --- Pieces per board in the LENGTH direction (for <72" slats only) ---
  let piecesPerLen;
  if(cfg.slatL >= 72){
    piecesPerLen = 1;
  } else {
    const usable = stockIn - END_TRIM;
    piecesPerLen = Math.max(1, Math.floor(usable / cfg.slatL));
  }

  // --- BF per slat ---
  let roughT, widthWaste, pcsWide, bfPerSlat, vgWarning = false;

  if(isVGResaw){
    roughT     = 2.0;
    widthWaste = null;
    pcsWide    = getVGPcsPerBoard(cfg.thickness, cfg.slatW);
    const vgAltPcs = getVGPcsPerBoard(0.6875, cfg.slatW); // 11/16" yield for comparison
    if(cfg.thickness > 0.6875) vgWarning = true; // suggest 11/16" for better yield

    // Board-based: buy whole 2×6 boards, each yields pcsWide × piecesPerLen slats
    // You can't buy a fraction of a board so ceil first, then multiply by BF/board
    const pcsPerBoard  = pcsWide * piecesPerLen;
    const boardsNeeded = Math.ceil(totalSlats / pcsPerBoard);
    const bfPerBoard   = (2 * 6 * stockIn) / 144;
    // Store for return, then override rawBFTotal calculation below
    bfPerSlat = bfPerBoard / pcsPerBoard; // per-slat rate (for display)
    const rawBFResaw = boardsNeeded * bfPerBoard;
    // Apply safety buffer if on
    const safetyMult = cfg.safetyBuffer ? 1.10 : 1;
    return {
      isVGResaw, vgWarning, vgAltPcs,
      stockIn, stockFt, piecesPerLen,
      roughT, widthWaste, pcsWide,
      boardsNeeded, bfPerBoard, pcsPerBoard,
      bfPerSlat, rawBFTotal: Math.ceil(rawBFResaw * safetyMult), defectPct:0,
    };

  } else {
    roughT     = getSuggestedRoughThick(cfg.thickness);
    widthWaste = getWidthWasteFactor(cfg.slatW);
    pcsWide    = null;

    // Heath's formula: roughThick × (slatW + wasteFactor) × stockLength / 144
    // Divided by pieces per length if multiple fit (only applies when slatL < 72")
    bfPerSlat = roughT * (cfg.slatW + widthWaste) * stockIn / (144 * piecesPerLen);
  }

  // Total BF = BF/slat × count, apply optional safety buffer, round up
  const rawBFExact  = bfPerSlat * totalSlats;
  const safetyMult  = cfg.safetyBuffer ? 1.10 : 1;
  const rawBFTotal  = Math.ceil(rawBFExact * safetyMult);

  return {
    isVGResaw, vgWarning,
    stockIn, stockFt, piecesPerLen,
    roughT, widthWaste, pcsWide,
    bfPerSlat, rawBFTotal, defectPct,
    safetyBuffer: cfg.safetyBuffer,
  };
}

function calcLumberPreview(cfg){
  const preview = document.getElementById('l-preview-'+cfg.id);
  if(!preview) return;
  const totalSqft = parseFloat(document.getElementById('totalSqft')?.value) || 0;
  if(!cfg.slatW || !cfg.panelW || !cfg.panelL){ preview.innerHTML = ''; return; }

  const qty = resolveLumberQty(cfg, totalSqft);
  if(!qty){ preview.innerHTML = ''; return; }
  const { panelQty, totalSlats } = qty;

  const m = millLumberCalc(cfg, totalSlats);

  // Update VG resaw note banner — show/hide and update text based on current species
  const resawNote = document.getElementById('lresaw-note-' + cfg.id);
  if(resawNote){
    if(m.isVGResaw){
      const tLabel = fractionLabel(cfg.thickness.toString());
      const wLabel = fractionLabel(cfg.slatW.toString());
      resawNote.textContent = `⚠ Hemlock/Fir: Milled from 2×6 rough stock — ${m.pcsWide} pcs @ ${tLabel} × ${wLabel} per board. BF calculated on nominal 2×6.`;
      resawNote.style.display = '';
    } else {
      resawNote.style.display = 'none';
    }
  }

  const roughLabel = m.isVGResaw
    ? `2×6 (${m.pcsWide} pcs/board)`
    : (ROUGH_THICKNESSES.find(r=>Math.abs(r.val-m.roughT)<0.001)?.label || m.roughT+'"');

  const vgWarnHTML = m.vgWarning ? `
    <div style="grid-column:1/-1;background:#3a1a00;border:1px solid var(--gold);border-radius:var(--r);padding:10px 14px;font-size:12px;color:var(--gold);line-height:1.5">
      ⚠ ${fractionLabel(cfg.thickness.toString())} VG ${cfg.species} yields only <strong>${m.pcsWide} pcs</strong> per 2×6 board — higher cost.
      <strong>Consider 11/16" (${m.vgAltPcs} pcs/board) for better yield.</strong>
    </div>` : '';

  preview.innerHTML = `
    ${vgWarnHTML}
    <div class="calc-preview-item"><div class="calc-preview-label">Panels Needed</div><div class="calc-preview-val">${fmtN(panelQty)}</div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">Total Slats</div><div class="calc-preview-val">${fmtN(totalSlats)}</div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">Stock Length</div><div class="calc-preview-val">${m.stockFt}' (${m.stockIn}")</div></div>
    ${m.piecesPerLen > 1 ? `<div class="calc-preview-item"><div class="calc-preview-label">Pcs / Board (length)</div><div class="calc-preview-val">${m.piecesPerLen}</div></div>` : ''}
    <div class="calc-preview-item"><div class="calc-preview-label">Rough Stock</div><div class="calc-preview-val">${roughLabel}</div></div>
    ${m.widthWaste !== null ? `<div class="calc-preview-item"><div class="calc-preview-label">Width Waste Factor</div><div class="calc-preview-val">${m.widthWaste}"</div></div>` : ''}
    ${m.boardsNeeded ? `<div class="calc-preview-item"><div class="calc-preview-label">Boards to Buy</div><div class="calc-preview-val">${m.boardsNeeded} × 2×6 (${m.pcsPerBoard} pcs ea)</div></div>` : ''}
    ${m.boardsNeeded ? `<div class="calc-preview-item"><div class="calc-preview-label">BF / Board</div><div class="calc-preview-val">${fmtN(m.bfPerBoard,0)} BF</div></div>` : `<div class="calc-preview-item"><div class="calc-preview-label">BF / Slat</div><div class="calc-preview-val">${fmtN(m.bfPerSlat,3)} BF</div></div>`}
    <div class="calc-preview-item"><div class="calc-preview-label">Raw BF to Order${m.safetyBuffer?' (+10%)':''}</div><div class="calc-preview-val" style="color:var(--teal);font-weight:700;font-size:16px">${fmtN(m.rawBFTotal,0)} BF</div></div>
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

  const m = millLumberCalc(cfg, totalSlats);
  const { rawBFTotal } = m;

  const lumberCost   = rawBFTotal * sData.price;
  const assemblyCost = cfg.assembly ? effectiveSqft * pricing.services.assembly : 0;
  const bracketCost  = (panelQty * cfg.bracketsPerPanel) * pricing.services.bracketPrice;

  const lumberLine = withMarkup(lumberCost,   'lumber');
  const asmLine    = withMarkup(assemblyCost,  'assembly');
  const bktLine    = withMarkup(bracketCost,   'brackets');

  const subtotal = lumberLine + asmLine + bktLine;
  const lf = totalSlats * cfg.slatL / 12;
  return {
    species:cfg.species, isVGResaw:m.isVGResaw, rawBFTotal,
    panelQty, totalSlats, effectiveSqft, lf,
    lines:{
      [`Raw Lumber (${fmtN(rawBFTotal,0)} BF)`]: lumberLine,
      ...(cfg.assembly ? {'Assembly / Packing': asmLine} : {}),
      [`Black Brackets (${fmtN(panelQty*cfg.bracketsPerPanel)})`]: bktLine,
    },
    subtotal,
    sqftCost: effectiveSqft > 0 ? subtotal / effectiveSqft : null,
  };
}

// --- JOB-LEVEL MILL SERVICES -----------------------------------------
// Called once per renderResults — totals all lumber configs together
function calcJobServices(){
  const svc      = pricing.services;
  const totalSqft = parseFloat(document.getElementById('totalSqft')?.value) || 0;
  let totalLF = 0, sandingLF = 0, cutLF = 0;

  lumberConfigs.forEach(cfg => {
    const qty = resolveLumberQty(cfg, totalSqft);
    if(!qty) return;
    const lf = qty.totalSlats * cfg.slatL / 12;
    totalLF  += lf;
    if(cfg.sanding)      sandingLF += lf;
    if(cfg.cutToLength)  cutLF     += lf;
  });

  // Milling: flat fee up to threshold, then $/LF
  const millingBase = totalLF > 0
    ? (totalLF <= svc.millingThreshold ? svc.millingFlat : totalLF * svc.millingPerLF)
    : 0;

  // Series change: pairwise — +$115 per thickness diff, +$115 per width diff
  let seriesChangeCost = 0;
  for(let i = 0; i < lumberConfigs.length; i++){
    for(let j = i+1; j < lumberConfigs.length; j++){
      const a = lumberConfigs[i], b = lumberConfigs[j];
      if(Math.abs(a.thickness - b.thickness) > 0.001) seriesChangeCost += svc.seriesChange;
      if(Math.abs(a.slatW    - b.slatW)    > 0.001) seriesChangeCost += svc.seriesChange;
    }
  }

  const millingTotal = millingBase + seriesChangeCost;

  // Sanding: flat fee up to threshold, then $/LF (total LF for sanded configs)
  const sandingCost = sandingLF <= 0 ? 0
    : (sandingLF <= svc.sandingThreshold ? svc.sandingFlat : sandingLF * svc.sandingPerLF);

  // Cut to length: flat fee up to threshold, then $/LF
  const cutCost = cutLF <= 0 ? 0
    : (cutLF <= svc.cutThreshold ? svc.cutFlat : cutLF * svc.cutPerLF);

  return { totalLF, sandingLF, cutLF, millingBase, seriesChangeCost, millingTotal, sandingCost, cutCost };
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
  const allResults = [];

  veneerConfigs.forEach((cfg,i) => {
    const r = calcVeneerCost(cfg, totalSqft);
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

  // Mill services (all lumber configs combined)
  const hasLumber = allResults.some(r => 'isVGResaw' in r);
  let millSvc = null, millingBaseMarked = 0, seriesChangeMarked = 0, sandingMarked = 0, cutMarked = 0, svcTotal = 0;
  if(hasLumber){
    millSvc             = calcJobServices();
    millingBaseMarked   = withMarkup(millSvc.millingBase,      'milling');
    seriesChangeMarked  = withMarkup(millSvc.seriesChangeCost, 'milling');
    sandingMarked       = withMarkup(millSvc.sandingCost,      'milling');
    cutMarked           = withMarkup(millSvc.cutCost,          'milling');
    svcTotal            = millingBaseMarked + seriesChangeMarked + sandingMarked + cutMarked;
  }

  let html = '';
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

  // Combined mill services block
  if(hasLumber && millSvc){
    const millingRate = millSvc.totalLF > pricing.services.millingThreshold ? 'at $/LF rate' : 'flat rate';
    html += `<div class="result-config">`;
    html += `<div class="result-config-title" style="color:var(--gold)">MILL SERVICES</div>`;
    html += `<div class="result-row"><span class="result-label">Milling (${fmtN(millSvc.totalLF,0)} LF — ${millingRate})</span><span class="result-value">${fmt(millingBaseMarked)}</span></div>`;
    if(millSvc.seriesChangeCost > 0){
      html += `<div class="result-row"><span class="result-label">Series Change</span><span class="result-value">${fmt(seriesChangeMarked)}</span></div>`;
    }
    if(millSvc.sandingCost > 0){
      html += `<div class="result-row"><span class="result-label">Sanding (${fmtN(millSvc.sandingLF,0)} LF)</span><span class="result-value">${fmt(sandingMarked)}</span></div>`;
    }
    if(millSvc.cutCost > 0){
      html += `<div class="result-row"><span class="result-label">Cut to Length (${fmtN(millSvc.cutLF,0)} LF)</span><span class="result-value">${fmt(cutMarked)}</span></div>`;
    }
    html += `<div class="result-row" style="font-weight:600"><span>Mill Services Total</span><span class="result-value">${fmt(svcTotal)}</span></div>`;
    html += `</div>`;
    grandTotal += svcTotal;
  }

  html += `<div class="result-total-card">`;
  if(allResults.length > 1 || (hasLumber && millSvc)){
    allResults.forEach(r => {
      html += `<div class="result-total-row"><span class="result-label">${r.label}</span><span style="font-family:var(--font-mono)">${fmt(r.subtotal)}</span></div>`;
    });
    if(hasLumber && millSvc){
      html += `<div class="result-total-row"><span class="result-label">Mill Services</span><span style="font-family:var(--font-mono)">${fmt(svcTotal)}</span></div>`;
    }
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

  // Service rates — grouped sections
  const sg = document.getElementById('serviceRatesGrid');
  const svcInput = (k, step='1', min='0') => `<input type="number" id="svc-${k}" value="${pricing.services[k]||0}" step="${step}" min="${min}" style="background:var(--surf3);border:1px solid var(--bdr2);border-radius:var(--r);color:var(--ink);padding:8px 10px;width:100%">`;
  const svcHead  = (label, color='var(--teal)') => `<div style="grid-column:1/-1;margin-top:12px;padding-bottom:6px;border-bottom:1px solid var(--bdr2)"><span style="font-size:13px;font-weight:700;color:${color};letter-spacing:.5px;text-transform:uppercase">${label}</span></div>`;
  const svcField = (k, lbl, step='1') => `<div><label class="field-label">${lbl}</label>${svcInput(k, step)}</div>`;

  sg.innerHTML = `
    ${svcHead('Milling', 'var(--teal)')}
    ${svcField('millingFlat',      'Flat Fee (≤ threshold $)', '5')}
    ${svcField('millingThreshold', 'Threshold (LF)', '100')}
    ${svcField('millingPerLF',     'Over threshold ($/LF)', '0.01')}
    ${svcField('seriesChange',     'Series change charge ($)', '5')}

    ${svcHead('Sanding', 'var(--teal)')}
    ${svcField('sandingFlat',      'Flat Fee (≤ threshold $)', '5')}
    ${svcField('sandingThreshold', 'Threshold (LF)', '100')}
    ${svcField('sandingPerLF',     'Over threshold ($/LF)', '0.01')}

    ${svcHead('Cut to Length', 'var(--teal)')}
    ${svcField('cutFlat',      'Flat Fee (≤ threshold $)', '5')}
    ${svcField('cutThreshold', 'Threshold (LF)', '100')}
    ${svcField('cutPerLF',     'Over threshold ($/LF)', '0.01')}

    ${svcHead('Labor / Assembly', 'var(--gold)')}
    ${svcField('assembly',     'Assembly ($/sqft)', '0.25')}
    ${svcField('bracketPrice', 'Black Bracket ($/ea)', '0.25')}

    ${svcHead('Veneer Services', 'var(--gold)')}
    ${svcField('ebServicePerFt',   'EB Service ($/ft)', '0.01')}
    ${svcField('cutServicePerSqft','Cut Service ($/sqft)', '0.01')}
  `;
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
  const svcKeys = [
    'millingFlat','millingThreshold','millingPerLF','seriesChange',
    'sandingFlat','sandingThreshold','sandingPerLF',
    'cutFlat','cutThreshold','cutPerLF',
    'assembly','bracketPrice','ebServicePerFt','cutServicePerSqft',
  ];
  svcKeys.forEach(k => {
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

  // Migrate old service keys → new threshold-based keys
  if('millingBase' in pricing.services && !('millingFlat' in pricing.services)){
    pricing.services.millingFlat = pricing.services.millingBase;
    delete pricing.services.millingBase;
  }
  if('sandingOneSide' in pricing.services && !('sandingFlat' in pricing.services)){
    pricing.services.sandingFlat = 240;
    delete pricing.services.sandingOneSide;
    delete pricing.services.sandingTwoSides;
  }
  if('cuttingCharge' in pricing.services && !('cutFlat' in pricing.services)){
    pricing.services.cutFlat = pricing.services.cuttingCharge;
    delete pricing.services.cuttingCharge;
  }
  if(('assemblyLow' in pricing.services || 'assemblyHigh' in pricing.services) && !('assembly' in pricing.services)){
    pricing.services.assembly = 1.50;
    delete pricing.services.assemblyLow;
    delete pricing.services.assemblyHigh;
  }
  delete pricing.services.lumberDefectPct;

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

  // Restore session now that pricing is fully merged
  checkSession();
})();
