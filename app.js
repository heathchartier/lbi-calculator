
// --- CONSTANTS -------------------------------------------------------
// Public endpoint, not a secret — same trust level as the GitHub raw URL fetched below.
// Passwords are never checked client-side anymore; every login/change-password call goes
// to the Worker, which holds the real password hashes in KV and never returns them.
const WORKER_AUTH_BASE = 'https://lbi-jobs.heathchartier.workers.dev';
const THICK_OPTIONS = [
  { key:'025', label:'1/4"' },
  { key:'050', label:'1/2"' },
  { key:'075', label:'3/4"' },
  { key:'100', label:'1"'   },
];
function thickToKey(t){ return { '1/4"':'025','1/2"':'050','3/4"':'075','1"':'100' }[t] || '075'; }
const KERF = 0.1875;
const SQUARING = 0.25;
const RESAW_KERF = 0.0625;   // thin-kerf blade for resaw/rip operations on 2x6/2x8
const TWO_X_SIX_T = 1.5;    // 2x6/2x8 shared actual thickness for resaw slabs (inches)
const TWO_X_SIX_W = 6.0;    // 2x6 rough width (inches)
const TWO_X_EIGHT_W = 8.0;  // 2x8 rough width (inches)
const END_TRIM = 4.0;

// --- WASTE % TOGGLE HELPERS --------------------------------------------
// Every "+10% waste" toggle in the app is now a mutually-exclusive 10%/15% pair.
// State is stored as a plain number (0, 10, or 15) on the config object. Old
// saved jobs stored a boolean (true=10%, false=off) — normalizeWastePct migrates
// that transparently the first time a config is rendered.
function wasteMultFromPct(pct){ return pct > 0 ? 1 + pct / 100 : 1; }
function normalizeWastePct(v, defaultPct){
  if(v === true) return 10;
  if(v === false) return 0;
  if(v === 10 || v === 15 || v === 0) return v;
  return defaultPct;
}
// Called from each checkbox's onchange, before the field is re-read, so only one
// of the pair is ever checked at a time.
function exclusiveWaste(id10, id15, justClicked){
  const e10 = document.getElementById(id10), e15 = document.getElementById(id15);
  if(!e10 || !e15) return;
  if(justClicked === 10 && e10.checked) e15.checked = false;
  if(justClicked === 15 && e15.checked) e10.checked = false;
}
function readWastePct(id10, id15){
  const e10 = document.getElementById(id10), e15 = document.getElementById(id15);
  if(e15?.checked) return 15;
  if(e10?.checked) return 10;
  return 0;
}
// Standard markup for a pair of waste toggles — pass the shared id prefix and
// an onchange callback name (called with no extra args, reads DOM itself).
function wasteToggleHTML(idPrefix, onchangeCall, pct){
  return `
    <div class="toggle-row">
      <label class="toggle"><input type="checkbox" id="${idPrefix}10" ${pct===10?'checked':''} onchange="exclusiveWaste('${idPrefix}10','${idPrefix}15',10);${onchangeCall}"><span class="toggle-slider"></span></label>
      <span class="toggle-label">+10% waste</span>
    </div>
    <div class="toggle-row">
      <label class="toggle"><input type="checkbox" id="${idPrefix}15" ${pct===15?'checked':''} onchange="exclusiveWaste('${idPrefix}10','${idPrefix}15',15);${onchangeCall}"><span class="toggle-slider"></span></label>
      <span class="toggle-label">+15% waste</span>
    </div>`;
}
const STOCK_LENGTHS      = [96, 120, 144, 168, 192]; // all lengths (long-stock species)
const STOCK_LENGTHS_STD  = [96, 120, 144];            // max 12' — most species
// Species that come in longer stock (can use 14' or 16' for estimating)
const LONG_STOCK_SPECIES = new Set([
  'Stain Grade Poplar',
  'V.G. Hemlock', 'Therm VG Hemlock',
  'V.G. Fir',
  'Therm Poplar',
  'Therm Pine',
  'Grey Accoya',
]);
const SHEET_WIDTHS  = { '4x8': 49, '4x10': 49, '5x10': 61, '5x12': 61 };
const SHEET_LENGTHS = { '4x8': 97, '4x10': 121, '5x10': 121, '5x12': 145 };
const EB_ROLL_FEET   = 500;
const EB_WASTE_FACTOR = 1.1;
// Lamination thickness definitions. user:false = admin-only (3/4 fallback)
const LAM_THICK_KEYS = [
  { k:'t0_25',   label:'1/4"',   val:0.25,   user:true  },
  { k:'t0_375',  label:'3/8"',   val:0.375,  user:true  },
  { k:'t0_5',    label:'1/2"',   val:0.5,    user:true  },
  { k:'t0_625',  label:'5/8"',   val:0.625,  user:true  },
  { k:'t0_6875', label:'11/16"', val:0.6875, user:false },
  { k:'t0_75',   label:'3/4"',   val:0.75,   user:true  },
  { k:'t1_0',    label:'1"',     val:1.0,    user:true  },
];
// Core sizes: 4x8, 4x10, 5x10, 5x12. Face/back sheets never come in 5x10 (Baltic Birch net-size only).
const LAM_SIZES = ['4x8','4x10','5x10','5x12'];
const LAM_FACE_SIZES = ['4x8','4x10','5x12'];
// Baltic Birch (or any "net size" flagged core) ships as true net dimensions, not oversize —
// and only in 48x96 / 60x120. Trimmed 1/4" per edge for squaring before cutting slats.
const LAM_NET_DIMS = { '4x8': {w:47.5, l:95.5}, '5x10': {w:59.5, l:119.5} };
const LAM_NET_SIZES = ['4x8','5x10'];
const LAM_SIZE_AREA = { '4x8': 4608, '4x10': 5760, '5x10': 7200, '5x12': 8640 };
function blankLamFace(){ return { price4x8:0, price4x10:0, price5x12:0, ebRoll:0 }; }
function blankLamCore(){ const o={netSize:false}; LAM_THICK_KEYS.forEach(t=>LAM_SIZES.forEach(s=>{o[`${t.k}_${s}`]=0;})); return o; }
// getLamSheetPrices, getLamFacePrices, getLamCoreAvailSizes, lamUsableDims, chooseLamSizes
// now live in calc-engine.js as Calc.getLamSheetPrices / Calc.getLamFacePrices /
// Calc.getLamCoreAvailSizes / Calc.lamUsableDims / Calc.chooseLamSizes.
const SUPPLIER_LABELS = { talbert: 'Talbert (Premium)', timber: 'Timber (Standard)' };

const STOCK_LOOKUP = [
  { min:0.1875, max:0.3125, stock:1.0,  label:'Resaw from 4/4',   resaw:true  },
  { min:0.375,  max:0.4375, stock:1.25, label:'Resaw from 5/4',   resaw:true  },
  { min:0.5,    max:0.5,    stock:1.5,  label:'Resaw from 6/4',   resaw:true  },
  { min:0.5625, max:0.8125, stock:1.0,  label:'Milled from 4/4',  resaw:false },
  { min:0.875,  max:1.0625, stock:1.25, label:'Milled from 5/4',  resaw:false },
  { min:1.125,  max:1.3125, stock:1.5,  label:'Milled from 6/4',  resaw:false },
  { min:1.375,  max:1.8125, stock:2.0,  label:'Milled from 8/4',  resaw:false },
  { min:1.875,  max:2.3125, stock:2.5,  label:'Milled from 10/4', resaw:false },
  { min:2.375,  max:2.8125, stock:3.0,  label:'Milled from 12/4', resaw:false },
  { min:2.875,  max:3.8125, stock:4.0,  label:'Milled from 16/4', resaw:false },
];

// tierPriceInfo now lives in calc-engine.js as Calc.tierPriceInfo.

function parseFraction(str){
  str = (str||'').trim();
  if(!str) return NaN;
  if(!isNaN(str)) return parseFloat(str);
  // Mixed: "1-1/4" or "1 1/4"
  const mixed = str.match(/^(\d+)[\s\-]+(\d+)\/(\d+)$/);
  if(mixed) return parseInt(mixed[1]) + parseInt(mixed[2])/parseInt(mixed[3]);
  // Simple fraction: "3/4"
  const frac = str.match(/^(\d+)\/(\d+)$/);
  if(frac) return parseInt(frac[1])/parseInt(frac[2]);
  return NaN;
}

// getStockInfo, getWidthWasteFactor, getSuggestedRoughThick now live in calc-engine.js
// as Calc.getStockInfo / Calc.getWidthWasteFactor / Calc.getSuggestedRoughThick.

// --- DEFAULT PRICING -------------------------------------------------
// veneerSpecies keys: {sup}_{grade}_{size}_{core}  e.g. talbert_A3_4x8_frmdf
// Cores: mdf | frmdf | pb | frpb   EB roll: {sup}_eb_roll (no core suffix)
function blankVeneerSpecies(overrides){
  const out = { eb_roll: 0, eb_roll_satin: 0 };
  ['talbert','timber'].forEach(s => {
    ['A3','AA'].forEach(g => ['4x8','4x10'].forEach(sz => ['mdf','frmdf','pb','frpb'].forEach(c => {
      THICK_OPTIONS.forEach(({key:t}) => {
        out[`${s}_${g}_${sz}_${c}_${t}`] = 0;
        out[`${s}_${g}_${sz}_${c}_${t}_satin`] = 0;
      });
    })));
  });
  return Object.assign(out, overrides || {});
}

function coreToKey(core){
  const found = (pricing?.veneerCores||[]).find(c => c.label === core);
  if(found) return found.key;
  // Fallback map for built-ins before pricing loads
  return { 'Regular MDF':'mdf', 'Fire Rated MDF':'frmdf', 'Particle Board':'pb', 'Fire Rated PB':'frpb' }[core] || 'frmdf';
}

function ensureAllCoreKeys(){
  const cores = (pricing.veneerCores||[]).map(c => c.key);
  Object.values(pricing.veneerSpecies||{}).forEach(p => {
    if(p['eb_roll']       === undefined) p['eb_roll']       = 0;
    if(p['eb_roll_satin'] === undefined) p['eb_roll_satin'] = 0;
    ['talbert','timber'].forEach(s => {
      ['A3','AA'].forEach(g => ['4x8','4x10'].forEach(sz => cores.forEach(c => {
        THICK_OPTIONS.forEach(({key:t}) => {
          const k = `${s}_${g}_${sz}_${c}_${t}`;
          if(p[k]          === undefined) p[k]          = 0;
          if(p[k+'_satin'] === undefined) p[k+'_satin'] = 0;
        });
      })));
    });
  });
}

function migrateThicknessKeys(){
  const cores = (pricing.veneerCores||[]).map(c => c.key);
  Object.values(pricing.veneerSpecies||{}).forEach(p => {
    ['talbert','timber'].forEach(s => {
      ['A3','AA'].forEach(g => ['4x8','4x10'].forEach(sz => cores.forEach(c => {
        const old = `${s}_${g}_${sz}_${c}`;
        const nw  = `${s}_${g}_${sz}_${c}_075`;
        if((p[old]||0) > 0 && !(p[nw]||0)) p[nw] = p[old];
        const oldS = old+'_satin', nwS = nw+'_satin';
        if((p[oldS]||0) > 0 && !(p[nwS]||0)) p[nwS] = p[oldS];
      })));
    });
  });
}

// SECURITY: every dollar-rate field below is 0, deliberately — this file is public source
// (unlike pricing.json, it can never be made private, since it's the app your browser runs).
// It used to hold real pricing as a "sensible fallback" before the first cloud fetch — some
// of those numbers were an exact match to live pricing at the time this was found (2026-08-02).
// This object is only ever a brief placeholder now: real pricing loads immediately after login
// (fetchCloudPricing for admin, applyCompanyPricingOptions for company), so there's no
// functional reason for a fallback value to ever be a real number. Structural/quantity fields
// (thresholds, resaw flags) are left as reasonable defaults — only $ rates were zeroed.
const DEFAULT_PRICING = {
  veneerSpecies: {
    'Walnut':         blankVeneerSpecies(),
    'White Oak':      blankVeneerSpecies(),
    'Rift White Oak': blankVeneerSpecies(),
    'Maple':          blankVeneerSpecies(),
    'Cherry':         blankVeneerSpecies(),
    'Alder':          blankVeneerSpecies(),
    'Beech':          blankVeneerSpecies(),
    'Custom':         blankVeneerSpecies(),
  },
  lumberSpecies: {
    'Flat Cut White Oak': { price:0, resaw:false },
    'Rift White Oak':     { price:0, resaw:false },
    'Walnut':             { price:0, resaw:false },
    'Stain Grade Poplar': { price:0, resaw:false },
    'Hard Maple':         { price:0, resaw:false },
    'V.G. Hemlock':       { price:0, resaw:true  },
    'V.G. Fir':           { price:0, resaw:true  },
    'Therm Ash':          { price:0, resaw:false },
    'Therm Poplar':       { price:0, resaw:false },
    'Therm Oak':          { price:0, resaw:false },
    'Therm Pine':         { price:0, resaw:false },
    'Therm VG Hemlock':   { price:0, resaw:true  },
    'Grey Accoya':        { price:0, resaw:false },
    'Custom':             { price:0, resaw:false },
  },
  services: {
    ebServicePerFt: 0, cutServicePerSqft: 0,
    cutFlatVeneer: 0, cutVeneerThreshold: 20,
    dadoServicePerSqft: 0, dadoFlatCharge: 0, dadoThreshold: 20,
    assembly: 0, bracketPrice: 0, glueLine: 0,
    millingFlat: 0, millingThreshold: 3000, millingPerLF: 0, seriesChange: 0,
    resawFlat: 0, resawThreshold: 3000, resawPerLF: 0,
    sandingFlat: 0, sandingThreshold: 1700, sandingPerLF: 0,
    cutFlat: 0, cutThreshold: 3000, cutPerLF: 0,
  },
  markup: {
    panels:0, edgeBand:0, lumber:0, milling:0,
    assembly:0, ebService:0, cutService:0, brackets:0, dado:0,
  },
  standardProducts: [],
  productCategories: [],
  laminationFaces: {},
  laminationCores: {},
  renameMap: {
    veneerSpecies: {}, lumberSpecies: {}, laminationFaces: {}, laminationCores: {},
  },
  veneerCores: [
    { key:'frmdf', label:'Fire Rated MDF' },
    { key:'mdf',   label:'Regular MDF' },
    { key:'pb',    label:'Particle Board' },
    { key:'frpb',  label:'Fire Rated PB' },
  ],
};

// --- STATE -----------------------------------------------------------
// SECURITY: deliberately NOT seeded from the localStorage cache here — a device that used
// this app before this fix shipped may still have real pricing cached from the old
// unconditional pre-login fetch. Starting from the (now-zeroed) DEFAULT_PRICING and letting
// mergePricing() below immediately re-save that safe state to localStorage means any stale
// real-data cache gets overwritten on first load, not read back into memory pre-login.
let pricing = deepCopy(DEFAULT_PRICING);
// Shared veneer-costing engine (calc-engine.js) — closes over this exact `pricing` object.
// pricing is mutated in place everywhere (fetchCloudPricing, saveAdmin), never reassigned,
// so this binding stays correct for the life of the page without re-creating it.
let Calc = createCalcEngine(pricing);
window.Calc = Calc; // exposed for debugging/testing only — app.js code always uses the local `Calc` binding above
let veneerConfigs = [];
let lumberConfigs = [];
let laminationConfigs = [];
let veneerCounter = 0;
let lumberCounter = 0;
let laminationCounter = 0;
let isDirty = false;
let productCart = {};
let currentJobId = null;
let productSearch = '';
let productCatCollapsed = {}; // catId -> bool; unset defaults to collapsed
let adminProdCatCollapsed = {}; // catId -> bool; unset defaults to collapsed
let productCounter = 0;
let categoryCounter = 0;
let _dragProdId = null;
let _dragCatId = null;
let _adminVeneerCore   = 'frmdf';
let _adminVeneerFinish = 'standard';
let _adminVeneerThick  = '075';

function deepCopy(o){ return JSON.parse(JSON.stringify(o)); }
function naturalSort(a, b){ return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); }
function sortedCats(cats){ return [...cats].sort((a,b) => naturalSort(a.name, b.name)); }

// --- AUTH -------------------------------------------------------------
// Real login: the browser never checks a password itself. It POSTs to the Worker, which
// holds the real password hashes in KV and returns a signed session token on success.
// The token's signature is only ever verified server-side (change-password calls send it
// back); reading its payload here is just local UI state, not a security check.
function saveSession(role, token){
  localStorage.setItem('lbiq_session_role', role);
  localStorage.setItem('lbiq_session_token', token);
}

function clearSession(){
  localStorage.removeItem('lbiq_session_role');
  localStorage.removeItem('lbiq_session_token');
  localStorage.removeItem('lbiq_session_expiry'); // remove legacy expiry key if present
}

function getSessionToken(){ return localStorage.getItem('lbiq_session_token'); }

function getValidSession(){
  const token = localStorage.getItem('lbiq_session_token');
  const role  = localStorage.getItem('lbiq_session_role');
  if(!token || !role) return null;
  try {
    let b64 = token.split('.')[0].replace(/-/g,'+').replace(/_/g,'/');
    while(b64.length % 4) b64 += '=';
    const payload = JSON.parse(atob(b64));
    if(payload.exp && Date.now() > payload.exp) return null;
  } catch { return null; }
  return role;
}

async function workerLogin(role, password){
  const resp = await fetch(`${WORKER_AUTH_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role, password }),
  });
  return await resp.json();
}

let sessionIsAdmin = false;
async function activateApp(isAdmin){
  sessionIsAdmin = !!isAdmin;
  document.getElementById('lockScreen').style.display = 'none';
  const app = document.getElementById('app');
  app.classList.add('visible');
  document.getElementById('adminBtn').style.display   = isAdmin ? '' : 'none';
  document.getElementById('logoutBtn').style.display  = '';
  document.getElementById('changePwBtn').style.display = '';
  document.getElementById('jobDate').value = new Date().toISOString().split('T')[0];

  // Admin needs real numbers to edit pricing — full fetch, same as always. Company role
  // never receives real pricing.json at all — see applyCompanyPricingOptions() above.
  if(isAdmin) await fetchCloudPricing();
  else await applyCompanyPricingOptions();

  addVeneerConfig();
  addLumberConfig();
  addLaminationConfig();
  recalcAll();
  renderProductsTab();
  renderLaminationConfigs();
}

function toggleLockPwVis(){
  const pw = document.getElementById('lockPw');
  const show = document.getElementById('eye-show');
  const hide = document.getElementById('eye-hide');
  const visible = pw.type === 'text';
  pw.type = visible ? 'password' : 'text';
  show.style.display = visible ? '' : 'none';
  hide.style.display = visible ? 'none' : '';
  pw.focus();
}

async function unlock(){
  const pw = document.getElementById('lockPw');
  const err = document.getElementById('lockErr');
  const v = pw.value.trim();
  if(!v) return;
  err.textContent = 'Checking…';
  try {
    let result = await workerLogin('admin', v);
    if(!result.ok) result = await workerLogin('company', v);
    if(result.ok){
      err.textContent = '';
      saveSession(result.role, result.token);
      await activateApp(result.role === 'admin');
      return;
    }
  } catch(e){
    err.textContent = 'Could not reach server — check your connection and try again.';
    return;
  }
  err.textContent = 'Incorrect password — try again.';
  pw.value = '';
  pw.classList.add('pw-shake');
  pw.style.borderColor = 'var(--red)';
  setTimeout(() => {
    err.textContent = '';
    pw.classList.remove('pw-shake');
    pw.style.borderColor = '';
  }, 2500);
}
document.getElementById('lockPw').addEventListener('keydown', e => { if(e.key === 'Enter') unlock(); });

function logout(){
  clearSession();
  veneerConfigs = []; lumberConfigs = [];
  veneerCounter = 0;  lumberCounter = 0;
  document.getElementById('app').classList.remove('visible');
  document.getElementById('lockScreen').style.display = '';
  document.getElementById('logoutBtn').style.display  = 'none';
  document.getElementById('changePwBtn').style.display = 'none';
  document.getElementById('lockPw').value = '';
}

// Auto-restore session — called after mergePricing() at bottom of file
async function checkSession(){
  const role = getValidSession();
  if(role){
    await activateApp(role === 'admin');
  }
}

// iOS Safari (browser + home-screen PWA) ignores body{overflow:hidden} and keeps
// rubber-band-scrolling the page behind a fixed-position modal, which makes the
// modal appear to drift/float as the background scrolls under it. Pinning the
// body itself with position:fixed blocks that background scroll.
let _scrollLockY = 0;
function lockBodyScroll(){
  _scrollLockY = window.scrollY;
  document.body.style.position = 'fixed';
  document.body.style.top   = `-${_scrollLockY}px`;
  document.body.style.left  = '0';
  document.body.style.right = '0';
  document.body.style.width = '100%';
}
function unlockBodyScroll(){
  document.body.style.position = '';
  document.body.style.top   = '';
  document.body.style.left  = '';
  document.body.style.right = '';
  document.body.style.width = '';
  window.scrollTo(0, _scrollLockY);
}

// iOS Safari (browser + home-screen PWA) positions position:fixed elements against the
// LAYOUT viewport, not the VISUAL one. The moment the on-screen keyboard opens (tapping
// any of the admin form's many text inputs), the visual viewport shrinks but a plain
// `inset:0` fixed overlay doesn't — so it can extend past what's actually visible.
// Height-only sync handles that. Deliberately NOT setting top/left from
// visualViewport.offsetTop/offsetLeft: those can read non-zero the instant the modal
// opens (status bar / safe-area quirks in standalone PWA mode), which shifted the whole
// overlay off position from the very first frame — worse than the problem it was meant
// to solve. inset:0 already anchors top:0/left:0 correctly on its own.
function syncModalViewport(){
  const vv = window.visualViewport;
  if(!vv) return;
  document.querySelectorAll('.modal-overlay:not(.hidden)').forEach(o => {
    o.style.height = vv.height + 'px';
  });
}
// Only listen for 'resize', not 'scroll'. In portrait, iOS Safari's address bar collapses
// and reappears continuously AS you scroll — that alone fires visualViewport 'scroll' (and
// sometimes 'resize') events constantly. Reacting to every one of those mid-scroll meant the
// modal's height was being live-resized while the user's finger was still moving, which reads
// as the modal "floating"/jittering. Landscape mode's browser chrome is mostly static (no
// collapse/expand cycle), so the same code never got a chance to jitter there — that's the
// "rotating the phone fixes it" symptom. 'resize' alone still catches the case that actually
// matters (the on-screen keyboard opening/closing), without firing on every scroll tick.
if(window.visualViewport){
  window.visualViewport.addEventListener('resize', syncModalViewport);
}

// Belt-and-suspenders: .modal-overlay (position:fixed, inset:0) is the ONLY scroll
// container while a modal is open — .modal-box is a plain flowing block inside it, not
// its own independent scrollable region (nesting two independent scroll containers, one
// fixed+centered wrapping one overflow:auto, is what caused the modal to visibly drag off
// -position and rubber-band-snap-back on iOS: the box itself was translating as a rigid
// unit instead of its content scrolling). Since the overlay covers the full screen
// whenever a modal is open, nothing touchable is ever truly "outside" it — this only
// guards against something in the future covering less than the full viewport.
document.addEventListener('touchmove', function(e){
  const openModal = document.querySelector('.modal-overlay:not(.hidden)');
  if(!openModal) return;
  if(!e.target.closest('.modal-overlay')) e.preventDefault();
}, { passive: false });

function openHelp(){
  const adminSection = document.getElementById('helpAdminSection');
  if(adminSection) adminSection.style.display = sessionIsAdmin ? '' : 'none';
  document.getElementById('helpModal').classList.remove('hidden');
  lockBodyScroll();
  syncModalViewport();
}
function closeHelp(){
  const m = document.getElementById('helpModal');
  m.classList.add('hidden');
  m.style.height = '';
  unlockBodyScroll();
}

function openChangePw(){
  const label = document.getElementById('changePwRoleLabel');
  if(label) label.textContent = sessionIsAdmin ? 'the Admin account' : 'the LBI account';
  document.getElementById('changePwNew').value = '';
  document.getElementById('changePwConfirm').value = '';
  document.getElementById('changePwError').textContent = '';
  document.getElementById('changePwModal').classList.remove('hidden');
  lockBodyScroll();
  syncModalViewport();
}
function closeChangePw(){
  const m = document.getElementById('changePwModal');
  m.classList.add('hidden');
  m.style.height = '';
  unlockBodyScroll();
}
async function saveChangePw(){
  const pw = document.getElementById('changePwNew').value;
  const confirm = document.getElementById('changePwConfirm').value;
  const errEl = document.getElementById('changePwError');
  if(!pw || pw.length < 4){ errEl.textContent = 'Password must be at least 4 characters.'; return; }
  if(pw !== confirm){ errEl.textContent = "Passwords don't match."; return; }
  errEl.textContent = 'Saving…';
  try {
    const resp = await fetch(`${WORKER_AUTH_BASE}/change-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: getSessionToken(), newPassword: pw }),
    });
    const result = await resp.json();
    if(!result.ok){ errEl.textContent = result.msg || 'Could not update password.'; return; }
  } catch(e){
    errEl.textContent = 'Could not reach server — check your connection and try again.';
    return;
  }
  closeChangePw();
  showToast('Password updated — takes effect on every device immediately');
}

function openAdmin(){
  renderAdminModal();
  document.getElementById('adminModal').classList.remove('hidden');
  lockBodyScroll();
  syncModalViewport();
}
function closeAdmin(){
  const m = document.getElementById('adminModal');
  m.classList.add('hidden');
  m.style.height = ''; m.style.top = ''; m.style.left = '';
  unlockBodyScroll();
}

// --- TABS -------------------------------------------------------------
function switchTab(name, btn){
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  btn.classList.add('active');
  if(name === 'calculators') calcBracket();
}

// --- HELPERS ----------------------------------------------------------
function fmt(n){ return n == null ? '—' : '$' + Number(n).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); }
function fmtN(n, dec=0){ return n == null ? '—' : Number(n).toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec}); }
function markDirty(){ isDirty = true; }
function getSupplier(){ return document.getElementById('jobSupplier')?.value || 'talbert'; }

// --- SPECIES VISIBILITY -----------------------------------------------
function visibleVeneerSpecies(orientation, supplier, core, thickness){
  const sup   = supplier || 'talbert';
  const grade = orientation === 'Vertical' ? 'AA' : 'A3';
  const c = coreToKey(core || 'Fire Rated MDF');
  const t = thickToKey(thickness || '3/4"');
  return Object.entries(pricing.veneerSpecies).filter(([name, p]) => {
    if(name === 'Custom') return true;
    return (p[`${sup}_${grade}_4x8_${c}_${t}`]||0) > 0 || (p[`${sup}_${grade}_4x10_${c}_${t}`]||0) > 0;
  }).map(([name]) => name);
}
function visibleLumberSpecies(){
  return Object.entries(pricing.lumberSpecies)
    .filter(([,p]) => p.resaw ? (p.price2x6||0) > 0 || (p.price2x8||0) > 0 : (p.price||0) > 0)
    .map(([name]) => name);
}

// --- VENEER CONFIG ----------------------------------------------------
function addVeneerConfig(){
  const id   = ++veneerCounter;
  const last = veneerConfigs[veneerConfigs.length - 1];
  const cfg = {
    id,
    ceilingType:  last?.ceilingType  || 'grille',
    orientation:  last?.orientation  || 'Horizontal',
    species:      last?.species      || '',
    core:         last?.core         || 'Fire Rated MDF',
    thickness:    last?.thickness    || '3/4"',
    grade:        last?.grade        || 'talbert',
    satinFinish:  last?.satinFinish  || false,
    panelW:0, panelL:0, slatW:0, slatL:0, slatsPerPanel:0,
    bracketsPerPanel:0, ebSides:4, assembly:false, wasteOn:10, notes:'',
    calcMode:'sqft', manualQty:0, sqft:0, customPricePerPanel:0, nominalSqFt:0,
  };
  veneerConfigs.push(cfg);
  renderVeneerConfigs();
  recalcAll();
}

function resetVeneerConfigs(){
  if(!confirm('Clear all veneer configurations and start fresh?')) return;
  veneerConfigs = []; veneerCounter = 0;
  addVeneerConfig();
  recalcAll(); markDirty();
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
    cfg.wasteOn = normalizeWastePct(cfg.wasteOn, 10);
    const isTile = cfg.ceilingType === 'tile';
    const species = visibleVeneerSpecies(cfg.orientation, cfg.grade, cfg.core, cfg.thickness);
    if(!cfg.species && species.length > 0) cfg.species = species[0];

    const qtyLabel = isTile
      ? (cfg.calcMode === 'slats' ? 'Total Tiles' : '')
      : (cfg.calcMode === 'slats' ? 'Total Slats' : cfg.calcMode === 'panels' ? 'Number of Panels' : '');

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
            <label class="field-label">Ceiling Type</label>
            <select id="v-ceilingtype-${cfg.id}" onchange="vUpdate(${cfg.id})">
              <option value="grille" ${!isTile?'selected':''}>Ceiling Grille</option>
              <option value="tile"   ${isTile?'selected':''}>Ceiling Tile</option>
            </select>
          </div>
          ${isTile ? '' : `<div>
            <label class="field-label">Orientation</label>
            <select id="v-orient-${cfg.id}" onchange="vUpdate(${cfg.id})">
              <option value="Horizontal" ${cfg.orientation==='Horizontal'?'selected':''}>Horizontal Slats (A3)</option>
              <option value="Vertical"   ${cfg.orientation==='Vertical'?'selected':''}>Vertical Slats (AA)</option>
            </select>
          </div>`}
          <div>
            <label class="field-label">Finish</label>
            <select id="v-satin-${cfg.id}" onchange="vUpdate(${cfg.id})">
              <option value="standard" ${!cfg.satinFinish?'selected':''}>Unfinished</option>
              <option value="satin"    ${cfg.satinFinish?'selected':''}>Satin</option>
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
            <label class="field-label">Panel Core</label>
            <select id="v-core-${cfg.id}" onchange="vUpdate(${cfg.id})">
              ${(pricing.veneerCores||[]).map(c=>`<option value="${c.label}" ${cfg.core===c.label?'selected':''}>${c.label}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="field-label">Thickness</label>
            <select id="v-thick-${cfg.id}" onchange="vUpdate(${cfg.id})">
              ${THICK_OPTIONS.map(({label})=>`<option value="${label.replace(/"/g,'&quot;')}" ${cfg.thickness===label?'selected':''}>${label}</option>`).join('')}
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
          <div id="v-customprice-wrap-${cfg.id}" style="${cfg.species==='Custom'?'':'display:none'}">
            <label class="field-label">Sheet Cost / Sheet ($)</label>
            <input type="number" id="v-customprice-${cfg.id}" value="${cfg.customPricePerPanel||''}" step="0.01" min="0" placeholder="e.g. 250.00" oninput="vUpdate(${cfg.id})">
          </div>
          <div id="v-customeb-wrap-${cfg.id}" style="${cfg.species==='Custom'?'':'display:none'}">
            <label class="field-label">EB Cost / Roll ($)</label>
            <input type="number" id="v-customeb-${cfg.id}" value="${cfg.customEBRollPrice||''}" step="0.01" min="0" placeholder="e.g. 75.00" oninput="vUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Calculate By</label>
            <select id="v-mode-${cfg.id}" onchange="vUpdate(${cfg.id})">
              <option value="sqft"   ${cfg.calcMode==='sqft'?'selected':''}>By Sq Ft</option>
              <option value="slats"  ${cfg.calcMode==='slats'?'selected':''}>By ${isTile?'Tile':'Slat'} Count</option>
              ${isTile ? '' : `<option value="panels" ${cfg.calcMode==='panels'?'selected':''}>By Panel Count</option>`}
            </select>
          </div>
          ${cfg.calcMode==='sqft' ? `<div>
            <label class="field-label">Ceiling Sq Ft</label>
            <input type="number" id="v-sqft-${cfg.id}" value="${cfg.sqft||''}" step="1" min="1" placeholder="e.g. 500" oninput="vUpdate(${cfg.id})">
          </div>` : `<div>
            <label class="field-label">${qtyLabel}</label>
            <input type="number" id="v-manualQty-${cfg.id}" value="${cfg.manualQty||''}" step="1" min="1" placeholder="Enter count" oninput="vUpdate(${cfg.id})">
          </div>`}
        </div>
        <hr class="config-divider">
        <span class="section-label">${isTile ? 'Tile Dimensions (inches)' : 'Panel & Slat Dimensions (inches)'}</span>
        <div class="config-grid">
          <div>
            <label class="field-label">${isTile ? 'Tile Width (in)' : 'Panel Width (in)'}</label>
            <input type="text" id="v-panelW-${cfg.id}" value="${cfg.panelW||''}" placeholder="e.g. 12" oninput="vUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">${isTile ? 'Tile Length (in)' : 'Panel Length (in)'}</label>
            <input type="text" id="v-panelL-${cfg.id}" value="${cfg.panelL||''}" placeholder="e.g. 96" oninput="vUpdate(${cfg.id})">
          </div>
          ${isTile ? `
          <div>
            <label class="field-label">Nominal Sq Ft / Tile</label>
            <input type="number" id="v-nominalsqft-${cfg.id}" value="${cfg.nominalSqFt||''}" step="0.01" min="0" placeholder="e.g. 4" oninput="vUpdate(${cfg.id})">
          </div>
          ` : `
          <div>
            <label class="field-label">Slat Width (in)</label>
            <input type="text" id="v-slatW-${cfg.id}" value="${cfg.slatW||''}" placeholder="e.g. 3.25 or 3-1/4" oninput="vUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Slat Length (in)</label>
            <input type="text" id="v-slatL-${cfg.id}" value="${cfg.slatL||''}" placeholder="e.g. 96" oninput="vUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Slats / Panel</label>
            <input type="number" id="v-slats-${cfg.id}" value="${cfg.slatsPerPanel||''}" step="1" min="1" placeholder="e.g. 4" oninput="vUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Brackets / Panel</label>
            <input type="number" id="v-brackets-${cfg.id}" value="${cfg.bracketsPerPanel||''}" step="1" min="0" placeholder="e.g. 8" oninput="vUpdate(${cfg.id})">
          </div>
          `}
          <div>
            <label class="field-label">Edge Band Sides</label>
            <select id="v-ebsides-${cfg.id}" onchange="vUpdate(${cfg.id})">
              <option value="4" ${cfg.ebSides===4?'selected':''}>4 sides</option>
              <option value="3" ${cfg.ebSides===3?'selected':''}>3 sides</option>
              <option value="2" ${cfg.ebSides===2?'selected':''}>2 long sides</option>
              <option value="1" ${cfg.ebSides===1?'selected':''}>1 long side</option>
              <option value="0" ${cfg.ebSides===0?'selected':''}>No edge banding</option>
            </select>
          </div>
        </div>
        <hr class="config-divider">
        <div style="display:flex;gap:24px;flex-wrap:wrap">
          <div class="toggle-row">
            <label class="toggle"><input type="checkbox" id="v-assembly-${cfg.id}" ${cfg.assembly?'checked':''} onchange="vUpdate(${cfg.id})"><span class="toggle-slider"></span></label>
            <span class="toggle-label">${isTile ? 'Dado / Groove' : 'Assembly included'}</span>
          </div>
          ${wasteToggleHTML(`v-waste-${cfg.id}-`, `vUpdate(${cfg.id})`, cfg.wasteOn)}
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
  const prevCeilingType = cfg.ceilingType || 'grille';
  cfg.ceilingType    = document.getElementById('v-ceilingtype-'+id)?.value || cfg.ceilingType || 'grille';
  const ceilingTypeChanged = cfg.ceilingType !== prevCeilingType;
  const isTile = cfg.ceilingType === 'tile';

  const prevOrientation = cfg.orientation;
  cfg.orientation    = isTile ? 'Horizontal' : (document.getElementById('v-orient-'+id)?.value || cfg.orientation);
  cfg.grade          = document.getElementById('v-grade-'+id)?.value || cfg.grade || 'talbert';
  cfg.core           = document.getElementById('v-core-'+id)?.value  || cfg.core;
  cfg.thickness      = document.getElementById('v-thick-'+id)?.value || cfg.thickness || '3/4"';
  cfg.panelW         = parseFraction(document.getElementById('v-panelW-'+id)?.value) || cfg.panelW;
  cfg.panelL         = parseFraction(document.getElementById('v-panelL-'+id)?.value) || cfg.panelL;
  if(isTile){
    cfg.slatW         = cfg.panelW;
    cfg.slatL         = cfg.panelL;
    cfg.slatsPerPanel = 1;
    cfg.bracketsPerPanel = 0;
    cfg.nominalSqFt   = parseFloat(document.getElementById('v-nominalsqft-'+id)?.value) || 0;
  } else {
    cfg.slatW          = parseFraction(document.getElementById('v-slatW-'+id)?.value) || cfg.slatW;
    cfg.slatL          = parseFraction(document.getElementById('v-slatL-'+id)?.value) || cfg.slatL;
    cfg.slatsPerPanel  = parseInt(document.getElementById('v-slats-'+id)?.value) || cfg.slatsPerPanel;
    cfg.bracketsPerPanel = parseInt(document.getElementById('v-brackets-'+id)?.value) || 0;
  }
  const ebSidesEl = document.getElementById('v-ebsides-'+id);
  cfg.ebSides        = ebSidesEl ? parseInt(ebSidesEl.value) : cfg.ebSides;
  const orientationChanged = cfg.orientation !== prevOrientation;
  cfg.assembly       = document.getElementById('v-assembly-'+id)?.checked ?? true;
  cfg.satinFinish    = document.getElementById('v-satin-'+id)?.value === 'satin';
  cfg.wasteOn        = readWastePct(`v-waste-${id}-10`, `v-waste-${id}-15`);
  const prevMode     = cfg.calcMode;
  cfg.calcMode       = document.getElementById('v-mode-'+id)?.value || cfg.calcMode;
  if(isTile && cfg.calcMode === 'panels') cfg.calcMode = 'sqft';
  cfg.sqft               = parseFloat(document.getElementById('v-sqft-'+id)?.value) || 0;
  cfg.manualQty          = parseInt(document.getElementById('v-manualQty-'+id)?.value) || 0;
  cfg.customPricePerPanel = parseFloat(document.getElementById('v-customprice-'+id)?.value) || 0;
  cfg.customEBRollPrice = parseFloat(document.getElementById('v-customeb-'+id)?.value) || 0;

  // update species dropdown when orientation or grade changes — read current selection first
  const selectedSpecies = document.getElementById('v-species-'+id)?.value || cfg.species;
  const specs = visibleVeneerSpecies(cfg.orientation, cfg.grade, cfg.core, cfg.thickness);
  const sel = document.getElementById('v-species-'+id);
  if(sel){
    sel.innerHTML = specs.length === 0
      ? '<option value="">No species priced — see admin</option>'
      : specs.map(s => `<option value="${s}" ${s===selectedSpecies?'selected':''}>${s}</option>`).join('');
  }
  cfg.species = sel?.value || cfg.species;

  const vCustWrap = document.getElementById('v-customprice-wrap-'+id);
  if(vCustWrap) vCustWrap.style.display = cfg.species === 'Custom' ? '' : 'none';
  const vCustomEbWrap = document.getElementById('v-customeb-wrap-'+id);
  if(vCustomEbWrap) vCustomEbWrap.style.display = cfg.species === 'Custom' ? '' : 'none';

  const titleEl = document.getElementById('vtitle-'+id);
  if(titleEl) titleEl.textContent = cfg.species || 'New Configuration';

  // Re-render when mode, orientation, or ceiling type changes (updates EB dropdown options / field layout)
  if(prevMode !== cfg.calcMode || orientationChanged || ceilingTypeChanged){
    renderVeneerConfigs();
  }

  calcVeneerPreview(cfg);
  recalcAll();
  markDirty();
}

// --- VENEER QUANTITY HELPERS ------------------------------------------
// resolveVeneerQty, chooseVeneerSheet, packVeneerSheets now live in calc-engine.js
// (Calc.resolveVeneerQty / Calc.chooseVeneerSheet / Calc.packVeneerSheets) — shared
// with the Worker so a company-role login never has to run this math in the browser.

// veneerPoolKey, computeVeneerPools, calcVeneerCost now live in calc-engine.js as
// Calc.veneerPoolKey / Calc.computeVeneerPools(veneerConfigs) / Calc.calcVeneerCost.

function calcVeneerPreview(cfg){
  const preview = document.getElementById('v-preview-'+cfg.id);
  if(!preview) return;
  if(!cfg.slatW || !cfg.panelW || !cfg.panelL){ preview.innerHTML = ''; return; }

  const qty = Calc.resolveVeneerQty(cfg);
  if(!qty){ preview.innerHTML = ''; return; }
  const { panelQty, totalSlats } = qty;
  const isTile = cfg.ceilingType === 'tile';

  const grade = cfg.orientation === 'Vertical' ? 'AA' : 'A3';
  const sup   = cfg.grade || 'talbert';
  const coreK  = Calc.coreToKey(cfg.core || 'Fire Rated MDF');
  const thickK = Calc.thickToKey(cfg.thickness || '3/4"');
  const finSfx = cfg.satinFinish ? '_satin' : '';
  const sData  = (pricing.veneerSpecies || {})[cfg.species] || {};
  const p8  = sData[`${sup}_${grade}_4x8_${coreK}_${thickK}${finSfx}`]  || 0;
  const p10 = sData[`${sup}_${grade}_4x10_${coreK}_${thickK}${finSfx}`] || 0;
  const opt = Calc.chooseVeneerSheet(cfg.slatW, cfg.slatL, p8, p10);
  const { size, slatsPerSheet, sheetPrice: previewSheetPrice } = opt;
  const wasteMult   = wasteMultFromPct(cfg.wasteOn);
  const sheetsNeeded = Math.ceil(totalSlats / slatsPerSheet * wasteMult);
  const longSides  = (cfg.ebSides===4||cfg.ebSides===2)?2:(cfg.ebSides===3||cfg.ebSides===1)?1:0;
  const shortSides = (cfg.ebSides===4||cfg.ebSides===3)?2:0;
  const ebLong  = (cfg.slatL / 12) * totalSlats * longSides;
  const ebShort = (cfg.slatW / 12) * totalSlats * shortSides;
  const ebFt    = ebLong + ebShort;
  const ebRolls = Math.ceil(ebFt * EB_WASTE_FACTOR / EB_ROLL_FEET);
  const noPricing = cfg.species !== 'Custom' && !previewSheetPrice;

  preview.innerHTML = `
    ${noPricing ? `<div style="grid-column:1/-1;background:var(--warn-bg,#7c3d0020);border:1px solid var(--warn,#f59e0b);border-radius:6px;padding:6px 10px;color:var(--warn,#f59e0b);font-size:12px;font-weight:600">⚠ No ${grade} ${size} pricing found — update admin or call supplier for quote</div>` : ''}
    <div class="calc-preview-item"><div class="calc-preview-label">Sq Ft / ${isTile?'Tile':'Panel'}</div><div class="calc-preview-val">${fmtN(qty.sqftPerPanel,2)} sqft</div></div>
    ${isTile ? '' : `<div class="calc-preview-item"><div class="calc-preview-label">Panels Needed</div><div class="calc-preview-val">${fmtN(panelQty)}</div></div>`}
    <div class="calc-preview-item"><div class="calc-preview-label">Total ${isTile?'Tiles':'Slats'}</div><div class="calc-preview-val">${fmtN(totalSlats)}</div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">${isTile?'Tiles':'Slats'} / Sheet</div><div class="calc-preview-val">${fmtN(slatsPerSheet)}</div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">Sheets Needed${cfg.wasteOn?' (+'+cfg.wasteOn+'%)':''}</div><div class="calc-preview-val">${fmtN(sheetsNeeded)} <span style="font-size:11px;color:var(--mid)">(${grade} ${size})</span></div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">EB Footage</div><div class="calc-preview-val">${fmtN(ebFt,0)} ft</div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">EB Rolls</div><div class="calc-preview-val">${fmtN(ebRolls)}</div></div>
    ${isTile ? '' : `<div class="calc-preview-item"><div class="calc-preview-label">Brackets</div><div class="calc-preview-val">${fmtN(panelQty * cfg.bracketsPerPanel)}</div></div>`}
  `;
}

// --- LUMBER CONFIG ---------------------------------------------------
function addLumberConfig(){
  const id   = ++lumberCounter;
  const last = lumberConfigs[lumberConfigs.length - 1];
  const thick = last?.thickness || 0.75;
  const cfg = {
    id,
    lumberType:   last?.lumberType   || 'grille',
    species:      last?.species      || '',
    orientation:  last?.orientation  || 'Horizontal',
    thickness:    thick,
    sanding:      last != null ? (last.sanding ?? true) : true,
    cutToLength:  last?.cutToLength  || false,
    calcMode:     last?.calcMode     || 'sqft',
    safetyBuffer: last != null ? normalizeWastePct(last.safetyBuffer, 10) : 10,
    slatW:0, slatL:0, slatsPerPanel:0, panelW:0, panelL:0, bracketsPerPanel:0,
    faceWidth:0, overallWidth:0,
    assembly:false, notes:'', manualQty:0, sqft:0, customPricePerBF:0,
    roughThick: Calc.getSuggestedRoughThick(thick),
  };
  lumberConfigs.push(cfg);
  renderLumberConfigs();
  recalcAll();
}

function resetLumberConfigs(){
  if(!confirm('Clear all lumber configurations and start fresh?')) return;
  lumberConfigs = []; lumberCounter = 0;
  addLumberConfig();
  recalcAll(); markDirty();
}

function removeLumberConfig(id){
  lumberConfigs = lumberConfigs.filter(c => c.id !== id);
  renderLumberConfigs();
  recalcAll();
}

// getBestStock, getMillStockLength, chooseResawStock, isTGType, effectiveFaceWidth,
// getVGPcsPerBoard now live in calc-engine.js as Calc.getBestStock / Calc.getMillStockLength /
// Calc.chooseResawStock / Calc.isTGType / Calc.effectiveFaceWidth / Calc.getVGPcsPerBoard.

// Label for the small "Milled from ..." badge next to Finished Thickness — must reflect the
// actual width-based 2x6-vs-2x8 pick (Calc.chooseResawStock), not a hardcoded guess, since the
// two rough stocks price differently and the badge previously always said "2×6" even when
// the real calculation picked 2×8.
function resawStockLabel(cfg){
  const width = Calc.isTGType(cfg) ? cfg.overallWidth : cfg.slatW;
  const picked = width ? Calc.chooseResawStock(width) : null;
  return picked ? `Milled from ${picked.stock.replace('x','×')}` : 'Milled from 2×6 or 2×8';
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
    cfg.safetyBuffer = normalizeWastePct(cfg.safetyBuffer, 10);
    const isTG = Calc.isTGType(cfg);
    const isTrim = cfg.lumberType === 'trim';
    const species  = visibleLumberSpecies();
    if(!cfg.species && species.length > 0) cfg.species = species[0];
    const sData    = pricing.lumberSpecies[cfg.species] || {};
    const isResaw  = sData.resaw || false;
    const millStockIn = cfg.slatL ? Calc.getMillStockLength(cfg.slatL, cfg.species) : 0;
    const stockFt     = millStockIn / 12;
    const pcsPerLen   = cfg.slatL >= 72 ? 1 : Math.max(1, Math.floor((millStockIn - END_TRIM) / cfg.slatL));
    const qtyLabel = isTG ? 'Total Pieces' : (cfg.calcMode === 'slats' ? 'Total Slats' : 'Number of Panels');

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
        ${isResaw ? `<div class="note-banner" id="lresaw-note-${cfg.id}">⚠ Hemlock/Fir: ${resawStockLabel(cfg)} rough stock — pcs per board depends on slat dimensions (see Lumber Calculation below).</div>` : ''}
        <div class="config-grid" style="margin-top:${isResaw?'16px':'0'}">
          <div>
            <label class="field-label">Ceiling Type</label>
            <select id="l-type-${cfg.id}" onchange="lUpdate(${cfg.id})">
              <option value="grille" ${cfg.lumberType==='grille'?'selected':''}>Ceiling Grille</option>
              <option value="tg"     ${cfg.lumberType==='tg'?'selected':''}>T&amp;G Ceiling</option>
              <option value="trim"   ${isTrim?'selected':''}>Trim</option>
            </select>
          </div>
          <div>
            <label class="field-label">Species</label>
            <select id="l-species-${cfg.id}" onchange="lUpdate(${cfg.id})">
              ${species.length===0 ? '<option value="">No species priced — see admin</option>' : species.map(s=>`<option value="${s}" ${cfg.species===s?'selected':''}>${s}</option>`).join('')}
            </select>
          </div>
          <div id="l-custombf-wrap-${cfg.id}" style="${cfg.species==='Custom'?'':'display:none'}">
            <label class="field-label">Price / BF ($)</label>
            <input type="number" id="l-custombf-${cfg.id}" value="${cfg.customPricePerBF||''}" step="0.01" min="0" placeholder="e.g. 8.50" oninput="lUpdate(${cfg.id})">
          </div>
          ${isTG ? '' : `<div>
            <label class="field-label">Orientation</label>
            <select id="l-orient-${cfg.id}" onchange="lUpdate(${cfg.id})">
              <option value="Horizontal" ${cfg.orientation==='Horizontal'?'selected':''}>Horizontal</option>
              <option value="Vertical"   ${cfg.orientation==='Vertical'?'selected':''}>Vertical</option>
            </select>
          </div>`}
          <div>
            <label class="field-label">Calculate By</label>
            <select id="l-mode-${cfg.id}" onchange="lUpdate(${cfg.id})">
              <option value="sqft"   ${cfg.calcMode==='sqft'?'selected':''}>By Sq Ft</option>
              <option value="slats"  ${cfg.calcMode==='slats'?'selected':''}>By ${isTG?'Piece':'Slat'} Count</option>
              ${isTG ? '' : `<option value="panels" ${cfg.calcMode==='panels'?'selected':''}>By Panel Count</option>`}
            </select>
          </div>
          ${cfg.calcMode==='sqft' ? `<div>
            <label class="field-label">Ceiling Sq Ft</label>
            <input type="number" id="l-sqft-${cfg.id}" value="${cfg.sqft||''}" step="1" min="1" placeholder="e.g. 500" oninput="lUpdate(${cfg.id})">
          </div>` : `<div>
            <label class="field-label">${qtyLabel}</label>
            <input type="number" id="l-manualQty-${cfg.id}" value="${cfg.manualQty||''}" step="1" min="1" placeholder="Enter count" oninput="lUpdate(${cfg.id})">
          </div>`}
        </div>
        <hr class="config-divider">
        <span class="section-label">${isTrim ? 'Trim Finished Dimensions (inches)' : isTG ? 'T&G Finished Dimensions (inches)' : 'Finished Slat Dimensions (inches)'}</span>
        <div class="config-grid">
          <div>
            <label class="field-label">Finished Thickness (in)</label>
            <input type="text" id="l-thick-${cfg.id}" value="${cfg.thickness}" autocorrect="off" autocapitalize="none" placeholder="e.g. 3/4 or .75" oninput="lUpdate(${cfg.id})">
            <span class="stock-tag" id="l-thick-tag-${cfg.id}" style="${isResaw||Calc.getStockInfo(cfg.thickness)?'':'display:none'}">${isResaw?resawStockLabel(cfg):(Calc.getStockInfo(cfg.thickness)?.label||'')}</span>
          </div>
          ${isTG ? `
          ${isTrim ? '' : `<div>
            <label class="field-label">Face Width (in)</label>
            <input type="text" id="l-faceW-${cfg.id}" value="${cfg.faceWidth||''}" placeholder="e.g. 4" oninput="lUpdate(${cfg.id})">
          </div>`}
          <div>
            <label class="field-label">Overall Width (in)</label>
            <input type="text" id="l-overallW-${cfg.id}" value="${cfg.overallWidth||''}" placeholder="e.g. 4.25" oninput="lUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Finished Length (in) ${cfg.calcMode==='sqft'?'(optional)':''}</label>
            <input type="text" id="l-slatL-${cfg.id}" value="${cfg.slatL||''}" placeholder="${cfg.calcMode==='sqft'?'e.g. 96 (blank = random)':'e.g. 96'}" oninput="lUpdate(${cfg.id})">
            ${cfg.slatL ? `<span class="stock-tag" id="l-stock-${cfg.id}">📏 ${stockFt}' stock · ${pcsPerLen} pc/length</span>` : `<span class="stock-tag" id="l-stock-${cfg.id}" style="display:none"></span>`}
          </div>
          ` : `
          <div>
            <label class="field-label">Finished Width (in)</label>
            <input type="text" id="l-slatW-${cfg.id}" value="${cfg.slatW||''}" placeholder="e.g. 3.25 or 3-1/4" oninput="lUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Finished Length (in) ${cfg.calcMode==='sqft'?'(optional)':''}</label>
            <input type="text" id="l-slatL-${cfg.id}" value="${cfg.slatL||''}" placeholder="${cfg.calcMode==='sqft'?'e.g. 96 (blank = random)':'e.g. 96'}" oninput="lUpdate(${cfg.id})">
            ${cfg.slatL ? `<span class="stock-tag" id="l-stock-${cfg.id}">📏 ${stockFt}' stock · ${pcsPerLen} pc/length</span>` : `<span class="stock-tag" id="l-stock-${cfg.id}" style="display:none"></span>`}
          </div>
          <div>
            <label class="field-label">Slats / Panel</label>
            <input type="number" id="l-slats-${cfg.id}" value="${cfg.slatsPerPanel||''}" step="1" min="1" placeholder="e.g. 4" oninput="lUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Panel Width (in)</label>
            <input type="text" id="l-panelW-${cfg.id}" value="${cfg.panelW||''}" placeholder="e.g. 12" oninput="lUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Panel Length (in)</label>
            <input type="text" id="l-panelL-${cfg.id}" value="${cfg.panelL||''}" placeholder="e.g. 96" oninput="lUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Brackets / Panel</label>
            <input type="number" id="l-brackets-${cfg.id}" value="${cfg.bracketsPerPanel||''}" step="1" min="0" placeholder="e.g. 8" oninput="lUpdate(${cfg.id})">
          </div>
          `}
        </div>
        <hr class="config-divider">
        <div style="display:flex;gap:24px;flex-wrap:wrap">
          ${isTG ? '' : `<div class="toggle-row">
            <label class="toggle"><input type="checkbox" id="l-assembly-${cfg.id}" ${cfg.assembly?'checked':''} onchange="lUpdate(${cfg.id})"><span class="toggle-slider"></span></label>
            <span class="toggle-label">Assembly included</span>
          </div>`}
          <div class="toggle-row">
            <label class="toggle"><input type="checkbox" id="l-sanding-${cfg.id}" ${cfg.sanding?'checked':''} onchange="lUpdate(${cfg.id})"><span class="toggle-slider"></span></label>
            <span class="toggle-label">Sanding</span>
          </div>
          <div class="toggle-row">
            <label class="toggle"><input type="checkbox" id="l-cut-${cfg.id}" ${cfg.cutToLength?'checked':''} onchange="lUpdate(${cfg.id})"><span class="toggle-slider"></span></label>
            <span class="toggle-label">Cut to length</span>
          </div>
          ${wasteToggleHTML(`l-safety-${cfg.id}-`, `lUpdate(${cfg.id})`, cfg.safetyBuffer)}
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
  const prevType   = cfg.lumberType;
  cfg.lumberType   = document.getElementById('l-type-'+id)?.value || cfg.lumberType || 'grille';
  cfg.species      = document.getElementById('l-species-'+id)?.value || cfg.species;
  cfg.orientation  = document.getElementById('l-orient-'+id)?.value || cfg.orientation;
  cfg.thickness    = parseFraction(document.getElementById('l-thick-'+id)?.value) || cfg.thickness;
  cfg.slatW        = parseFraction(document.getElementById('l-slatW-'+id)?.value) || cfg.slatW;
  cfg.slatL        = parseFraction(document.getElementById('l-slatL-'+id)?.value) || cfg.slatL;
  cfg.faceWidth    = parseFraction(document.getElementById('l-faceW-'+id)?.value) || cfg.faceWidth;
  cfg.overallWidth = parseFraction(document.getElementById('l-overallW-'+id)?.value) || cfg.overallWidth;
  cfg.slatsPerPanel = parseInt(document.getElementById('l-slats-'+id)?.value) || cfg.slatsPerPanel;
  cfg.panelW       = parseFraction(document.getElementById('l-panelW-'+id)?.value) || cfg.panelW;
  cfg.panelL       = parseFraction(document.getElementById('l-panelL-'+id)?.value) || cfg.panelL;
  cfg.bracketsPerPanel = parseInt(document.getElementById('l-brackets-'+id)?.value) || 0;
  cfg.assembly     = Calc.isTGType(cfg) ? false : (document.getElementById('l-assembly-'+id)?.checked ?? true);
  cfg.sanding      = document.getElementById('l-sanding-'+id)?.checked ?? true;
  cfg.cutToLength  = document.getElementById('l-cut-'+id)?.checked ?? true;
  const prevMode   = cfg.calcMode;
  cfg.calcMode     = document.getElementById('l-mode-'+id)?.value || cfg.calcMode;
  if(Calc.isTGType(cfg) && cfg.calcMode === 'panels') cfg.calcMode = 'sqft';
  cfg.sqft         = parseFloat(document.getElementById('l-sqft-'+id)?.value) || 0;
  cfg.manualQty    = parseInt(document.getElementById('l-manualQty-'+id)?.value) || 0;
  cfg.roughThick      = Calc.getSuggestedRoughThick(cfg.thickness);
  cfg.safetyBuffer    = readWastePct(`l-safety-${id}-10`, `l-safety-${id}-15`);
  cfg.customPricePerBF = parseFloat(document.getElementById('l-custombf-'+id)?.value) || 0;

  const lCustWrap = document.getElementById('l-custombf-wrap-'+id);
  if(lCustWrap) lCustWrap.style.display = cfg.species === 'Custom' ? '' : 'none';

  const titleEl = document.getElementById('ltitle-'+id);
  if(titleEl) titleEl.textContent = cfg.species || 'New Configuration';

  const stockTag = document.getElementById('l-stock-'+id);
  if(stockTag){
    if(cfg.slatL > 0){
      const millStockIn   = Calc.getMillStockLength(cfg.slatL, cfg.species);
      const millPcsPerLen = cfg.slatL >= 72 ? 1 : Math.max(1, Math.floor((millStockIn - END_TRIM) / cfg.slatL));
      stockTag.textContent = `📏 ${millStockIn/12}' stock · ${millPcsPerLen} pc/length`;
      stockTag.style.display = '';
    } else {
      stockTag.style.display = 'none';
    }
  }

  const thickTag = document.getElementById('l-thick-tag-'+id);
  if(thickTag){
    const sDataU = pricing.lumberSpecies[cfg.species] || {};
    if(sDataU.resaw){
      thickTag.textContent = resawStockLabel(cfg);
      thickTag.style.display = '';
    } else {
      const si = Calc.getStockInfo(cfg.thickness);
      thickTag.textContent = si ? si.label : '';
      thickTag.style.display = si ? '' : 'none';
    }
  }

  if(prevMode !== cfg.calcMode || prevType !== cfg.lumberType) renderLumberConfigs();

  calcLumberPreview(cfg);
  recalcAll();
  markDirty();
}

// T&G ceilings aren't panelized — quantity is driven by face width (LF) and overall width
// (BF/waste), not panel/slat breakdown. Finished length is optional in sqft mode (random
// lengths assumed) but required in piece-count mode, since totalLF can't be derived from a
// piece count without a real length.
// resolveTGQty, resolveLumberQty, calcContinuousBF, millLumberCalc now live in
// calc-engine.js as Calc.resolveTGQty / Calc.resolveLumberQty / Calc.calcContinuousBF /
// Calc.millLumberCalc.

function calcLumberPreview(cfg){
  const preview = document.getElementById('l-preview-'+cfg.id);
  if(!preview) return;
  const isTG = Calc.isTGType(cfg);
  if(isTG){
    if(!Calc.effectiveFaceWidth(cfg) || !cfg.overallWidth){ preview.innerHTML = ''; return; }
  } else {
    if(!cfg.slatW || !cfg.panelW || !cfg.panelL){ preview.innerHTML = ''; return; }
  }

  const qty = Calc.resolveLumberQty(cfg);
  if(!qty){ preview.innerHTML = ''; return; }
  const { panelQty, totalSlats } = qty;
  const calcWidth = isTG ? cfg.overallWidth : cfg.slatW;

  const m = Calc.millLumberCalc(cfg, qty);
  const displaySlats = m.totalSlatsUsed ?? totalSlats;

  // Update VG resaw note banner — show/hide and update text based on current species
  const resawNote = document.getElementById('lresaw-note-' + cfg.id);
  if(resawNote){
    if(m.isVGResaw && !m.noStock){
      const tLabel = fractionLabel(cfg.thickness.toString());
      const wLabel = fractionLabel(calcWidth.toString());
      const lenNote = (m.actualPieces && m.actualPieces !== totalSlats)
        ? ` Resawing only rips width/thickness — it doesn't trim to length — so you'll actually receive ${fmtN(m.actualPieces)} pcs @ ${m.stockFt}' each (not ${fmtN(totalSlats)} @ the ordered length).`
        : '';
      resawNote.textContent = `⚠ Hemlock/Fir: Milled from ${m.stockUsed} rough stock — ${m.pcsWide} pcs @ ${tLabel} × ${wLabel} per board.${lenNote}`;
      resawNote.style.display = '';
    } else {
      resawNote.style.display = 'none';
    }
  }

  const randomLengthHTML = m.randomLength ? `
    <div style="grid-column:1/-1;background:var(--warn-bg,#7c3d0020);border:1px solid var(--warn,#f59e0b);border-radius:6px;padding:6px 10px;color:var(--warn,#f59e0b);font-size:12px;font-weight:600">
      ⚠ No finished length entered — assuming random lengths for BF calculation
    </div>` : '';

  if(m.isContinuous){
    preview.innerHTML = `
      ${randomLengthHTML}
      <div class="calc-preview-item"><div class="calc-preview-label">Linear Feet Needed</div><div class="calc-preview-val">${fmtN(m.totalLF,0)} LF</div></div>
      <div class="calc-preview-item"><div class="calc-preview-label">Rough Stock</div><div class="calc-preview-val">${m.stockLabel || (ROUGH_THICKNESSES.find(r=>Math.abs(r.val-m.roughT)<0.001)?.label || m.roughT+'"')}</div></div>
      <div class="calc-preview-item"><div class="calc-preview-label">Width Waste Factor</div><div class="calc-preview-val">${m.widthWaste}"</div></div>
      <div class="calc-preview-item"><div class="calc-preview-label">Raw BF to Order${m.safetyBuffer?' (+'+m.safetyBuffer+'% waste)':''}</div><div class="calc-preview-val" style="color:var(--teal);font-weight:700;font-size:16px">${fmtN(m.rawBFTotal,0)} BF</div></div>
    `;
    return;
  }

  const roughLabel = m.isVGResaw
    ? (m.noStock ? '— (over 7.5" max)' : `${m.stockUsed} (${m.pcsWide} pcs/board)`)
    : m.stockLabel
      ? `${m.stockLabel}${m.isThickResaw ? ' · '+m.pcsWide+' pcs/board' : ''}`
      : (ROUGH_THICKNESSES.find(r=>Math.abs(r.val-m.roughT)<0.001)?.label || m.roughT+'"');

  const noStockHTML = m.noStock ? `
    <div style="grid-column:1/-1;background:var(--warn-bg,#7c3d0020);border:1px solid var(--warn,#f59e0b);border-radius:6px;padding:6px 10px;color:var(--warn,#f59e0b);font-size:12px;font-weight:600">
      ⚠ Width ${fractionLabel(calcWidth.toString())} exceeds 7.5" max for 2×6/2×8 resaw stock — call for pricing
    </div>` : '';

  const vgWarnHTML = m.vgWarning ? `
    <div style="grid-column:1/-1;background:#3a1a00;border:1px solid var(--gold);border-radius:var(--r);padding:10px 14px;font-size:12px;color:var(--gold);line-height:1.5">
      ⚠ ${fractionLabel(cfg.thickness.toString())} VG ${cfg.species} yields only <strong>${m.pcsWide} pcs</strong> per ${m.stockUsed} board — higher cost.
      <strong>Consider 11/16" (${m.vgAltPcs} pcs/board) for better yield.</strong>
    </div>` : '';

  preview.innerHTML = `
    ${noStockHTML}
    ${vgWarnHTML}
    ${isTG ? '' : `<div class="calc-preview-item"><div class="calc-preview-label">Panels Needed</div><div class="calc-preview-val">${fmtN(panelQty)}</div></div>`}
    <div class="calc-preview-item"><div class="calc-preview-label">${isTG?'Total Pieces':'Total Slats'}</div><div class="calc-preview-val">${fmtN(displaySlats)}</div></div>
    <div class="calc-preview-item"><div class="calc-preview-label">Stock Length</div><div class="calc-preview-val">${m.stockFt}' (${m.stockIn}")</div></div>
    ${m.piecesPerLen > 1 ? `<div class="calc-preview-item"><div class="calc-preview-label">Pcs / Board (length)</div><div class="calc-preview-val">${m.piecesPerLen}</div></div>` : ''}
    <div class="calc-preview-item"><div class="calc-preview-label">Rough Stock</div><div class="calc-preview-val">${roughLabel}</div></div>
    ${m.widthWaste !== null ? `<div class="calc-preview-item"><div class="calc-preview-label">Width Waste Factor</div><div class="calc-preview-val">${m.widthWaste}"</div></div>` : ''}
    ${m.boardsNeeded ? `<div class="calc-preview-item"><div class="calc-preview-label">Boards to Buy</div><div class="calc-preview-val">${m.boardsNeeded}${m.isVGResaw ? ' × '+m.stockUsed : ''} (${m.pcsPerBoard} slat${m.pcsPerBoard!==1?'s':''}/board)</div></div>` : ''}
    ${m.actualPieces && m.actualPieces !== totalSlats ? `<div class="calc-preview-item"><div class="calc-preview-label">Actual Delivery</div><div class="calc-preview-val" style="color:var(--gold)">${fmtN(m.actualPieces)} pcs @ ${m.stockFt}' ea</div></div>` : ''}
    ${m.boardsNeeded && m.bfPerBoard ? `<div class="calc-preview-item"><div class="calc-preview-label">BF / Board</div><div class="calc-preview-val">${fmtN(m.bfPerBoard,0)} BF</div></div>` : `<div class="calc-preview-item"><div class="calc-preview-label">BF / Slat</div><div class="calc-preview-val">${fmtN(m.bfPerSlat,3)} BF</div></div>`}
    <div class="calc-preview-item"><div class="calc-preview-label">Raw BF to Order${m.safetyBuffer?' (+'+m.safetyBuffer+'% waste)':''}</div><div class="calc-preview-val" style="color:var(--teal);font-weight:700;font-size:16px">${fmtN(m.rawBFTotal,0)} BF</div></div>
    ${isTG ? '' : `<div class="calc-preview-item"><div class="calc-preview-label">Brackets</div><div class="calc-preview-val">${fmtN(panelQty * cfg.bracketsPerPanel)}</div></div>`}
  `;
}

// calcLumberCost, calcJobServices now live in calc-engine.js as Calc.calcLumberCost /
// Calc.calcJobServices(lumberConfigs).

// --- RECALC -----------------------------------------------------------
function recalcAll(){
  veneerConfigs.forEach(cfg => calcVeneerPreview(cfg));
  lumberConfigs.forEach(cfg => calcLumberPreview(cfg));
  laminationConfigs.forEach(cfg => calcLaminationPreview(cfg));
  renderResults();
}

// Admin computes locally (full pricing already in memory, needed to edit it). Company
// role never runs pricing math client-side — it sends job configuration to the Worker's
// /pricing/calculate endpoint and renders whatever totals come back, via the exact same
// renderResultsHTML() so the two roles are guaranteed pixel-identical for the same job.
function renderResults(){
  if(!sessionIsAdmin){ renderResultsCompanyDebounced(); return; }
  const data = Calc.computeJobTotals({ veneerConfigs, lumberConfigs, laminationConfigs, productCart });
  renderResultsHTML(data);
}

let _companyCalcTimer = null;
function renderResultsCompanyDebounced(){
  clearTimeout(_companyCalcTimer);
  const cont = document.getElementById('resultsContent');
  if(cont) cont.innerHTML = '<div class="results-empty">Calculating…</div>';
  _companyCalcTimer = setTimeout(renderResultsCompany, 400);
}

async function renderResultsCompany(){
  const cont = document.getElementById('resultsContent');
  if(!veneerConfigs.length && !lumberConfigs.length && !laminationConfigs.length && !Object.keys(productCart).length){
    cont.innerHTML = '<div class="results-empty">Fill in job details and add a configuration above to see results.</div>';
    return;
  }
  try {
    const resp = await fetch(`${WORKER_AUTH_BASE}/pricing/calculate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: getSessionToken(),
        veneerConfigs, lumberConfigs, laminationConfigs, productCart,
      }),
    });
    const result = await resp.json();
    if(!result.ok){
      cont.innerHTML = `<div class="results-empty">⚠ ${result.msg || 'Could not calculate pricing.'}</div>`;
      return;
    }
    renderResultsHTML(result.data);
  } catch(e){
    cont.innerHTML = '<div class="results-empty">⚠ Could not reach pricing server — check your connection.</div>';
  }
}

function renderResultsHTML(data){
  const cont = document.getElementById('resultsContent');
  if(data.empty){
    cont.innerHTML = '<div class="results-empty">Fill in job details and add a configuration above to see results.</div>';
    return;
  }
  const {
    allResults, stockLines, stockTotal, hasStock, hasLumber, millSvc,
    millingBaseMarked, resawMillingMarked, seriesChangeMarked, sandingMarked, cutMarked, svcTotal,
    grandTotal, totalEffSqft,
  } = data;

  let html = '';

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
  });

  // Stock Items block
  if(hasStock){
    html += `<div class="result-config">`;
    html += `<div class="result-config-title" style="color:var(--teal)">STOCK ITEMS</div>`;
    stockLines.forEach(line => {
      html += `<div class="result-row"><span class="result-label">${line.label}</span><span class="result-value">${fmt(line.val)}</span></div>`;
    });
    html += `<div class="result-row" style="font-weight:600"><span>Stock Items Subtotal</span><span class="result-value">${fmt(stockTotal)}</span></div>`;
    html += '</div>';
  }

  // Combined mill services block
  if(hasLumber && millSvc){
    html += `<div class="result-config">`;
    html += `<div class="result-config-title" style="color:var(--gold)">MILL SERVICES</div>`;
    if(millSvc.millingBase > 0){
      const millingRate = millSvc.standardLF > pricing.services.millingThreshold ? 'at $/LF rate' : 'flat rate';
      html += `<div class="result-row"><span class="result-label">Milling (${fmtN(millSvc.standardLF,0)} LF — ${millingRate})</span><span class="result-value">${fmt(millingBaseMarked)}</span></div>`;
    }
    if(millSvc.resawMillingCost > 0){
      const resawRate = millSvc.resawLF > pricing.services.resawThreshold ? 'at $/LF rate' : 'flat rate';
      html += `<div class="result-row"><span class="result-label">Resaw Milling (${fmtN(millSvc.resawLF,0)} LF — ${resawRate})</span><span class="result-value">${fmt(resawMillingMarked)}</span></div>`;
    }
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
  }

  html += `<div class="result-total-card">`;
  if(allResults.length > 1 || (hasLumber && millSvc) || hasStock){
    allResults.forEach(r => {
      html += `<div class="result-total-row"><span class="result-label">${r.label}</span><span style="font-family:var(--font-mono)">${fmt(r.subtotal)}</span></div>`;
    });
    if(hasLumber && millSvc){
      html += `<div class="result-total-row"><span class="result-label">Mill Services</span><span style="font-family:var(--font-mono)">${fmt(svcTotal)}</span></div>`;
    }
    if(hasStock){
      html += `<div class="result-total-row"><span class="result-label">Stock Items</span><span style="font-family:var(--font-mono)">${fmt(stockTotal)}</span></div>`;
    }
  }
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
    id: currentJobId || Date.now(),
    name:     document.getElementById('jobName')?.value || 'Untitled',
    customer: document.getElementById('jobCustomer')?.value || '',
    po:       document.getElementById('jobPO')?.value || '',
    date:     document.getElementById('jobDate')?.value || '',
    notes:    document.getElementById('jobNotes')?.value || '',
    veneerConfigs:    deepCopy(veneerConfigs),
    lumberConfigs:    deepCopy(lumberConfigs),
    laminationConfigs:deepCopy(laminationConfigs),
    productCart:      {...productCart},
    savedAt: new Date().toISOString(),
  };
}

function saveJob(){
  const isNew = !currentJobId;
  const job   = buildJobObject();
  if(isNew) currentJobId = job.id;
  const jobs  = JSON.parse(localStorage.getItem('lbiq_jobs') || '[]');
  const idx   = jobs.findIndex(j => j.id === job.id);
  if(idx >= 0) jobs[idx] = {...jobs[idx], ...job};
  else jobs.unshift(job);
  localStorage.setItem('lbiq_jobs', JSON.stringify(jobs));
  isDirty = false;
  updateJobEditStatus();
  if(localStorage.getItem('lbiq_worker_key')){
    showToast(isNew ? 'Saving job to cloud…' : 'Updating job on cloud…');
    pushJobsToCloud(jobs).then(r => showToast(r.ok
      ? (isNew ? '✓ Job saved — visible on all devices' : '✓ Job updated — visible on all devices')
      : '⚠ Saved locally. Cloud sync failed: '+r.msg));
  } else {
    showToast(isNew ? 'Job saved' : 'Job updated');
  }
}

function applyRenameMap(configs, field, mapSection){
  const map = (pricing.renameMap || {})[mapSection] || {};
  configs.forEach(c => { if(c[field] && map[c[field]]) c[field] = map[c[field]]; });
}

function loadJob(job){
  document.getElementById('jobName').value     = job.name     || '';
  document.getElementById('jobCustomer').value = job.customer || '';
  document.getElementById('jobPO').value       = job.po       || '';
  document.getElementById('jobDate').value     = job.date     || '';
  document.getElementById('jobNotes').value    = job.notes    || '';
  // migrate old single-sqft jobs: distribute global sqft to each config
  if(job.sqft){
    (job.veneerConfigs||[]).forEach(c => { if(!c.sqft) c.sqft = parseFloat(job.sqft)||0; });
    (job.lumberConfigs||[]).forEach(c => { if(!c.sqft) c.sqft = parseFloat(job.sqft)||0; });
  }
  veneerConfigs     = job.veneerConfigs  || [];
  lumberConfigs     = job.lumberConfigs  || [];
  laminationConfigs = job.laminationConfigs || [];
  applyRenameMap(veneerConfigs,     'species', 'veneerSpecies');
  applyRenameMap(lumberConfigs,     'species', 'lumberSpecies');
  applyRenameMap(laminationConfigs, 'face',    'laminationFaces');
  applyRenameMap(laminationConfigs, 'core',    'laminationCores');
  veneerCounter     = veneerConfigs.reduce((m,c) => Math.max(m,c.id), 0);
  lumberCounter     = lumberConfigs.reduce((m,c) => Math.max(m,c.id), 0);
  laminationCounter = laminationConfigs.reduce((m,c) => Math.max(m,c.id), 0);
  Object.keys(productCart).forEach(k => delete productCart[k]);
  Object.assign(productCart, job.productCart || {});
  currentJobId = job.id;
  renderVeneerConfigs();
  renderLumberConfigs();
  renderLaminationConfigs();
  recalcAll();
  renderProductsTab();
  updateJobEditStatus();
  closeSavedJobs();
  isDirty = false;
}

async function openSavedJobs(){
  document.getElementById('savedModal').classList.remove('hidden');
  lockBodyScroll();
  syncModalViewport();
  const list = document.getElementById('savedJobsList');
  list.innerHTML = '<p style="color:var(--mid);font-size:14px">Loading…</p>';
  // Always fetch from GitHub — reading jobs.json is public, no token required
  const cloudJobs = await fetchJobsFromCloud();
  if(cloudJobs) localStorage.setItem('lbiq_jobs', JSON.stringify(cloudJobs));
  renderSavedJobsList();
}

function renderSavedJobsList(){
  const list = document.getElementById('savedJobsList');
  if(!list) return;
  const jobs = JSON.parse(localStorage.getItem('lbiq_jobs') || '[]');
  const canDelete = !!localStorage.getItem('lbiq_worker_key');
  if(!jobs.length){
    list.innerHTML = '<p style="color:var(--mid);font-size:14px">No saved jobs yet.</p>';
  } else {
    list.innerHTML = jobs.map(j => `
      <div class="saved-job-card">
        <div class="saved-job-info">
          <div class="saved-job-name">${j.name||'Untitled'}</div>
          <div class="saved-job-meta">${j.customer||''} ${j.po?'| '+j.po:''} | ${j.date||''}</div>
        </div>
        <button class="btn-secondary" onclick="loadJob(${JSON.stringify(j).replace(/"/g,'&quot;')})">Load</button>
        ${canDelete ? `<button class="btn-danger" onclick="deleteJob(${j.id})">✕</button>` : ''}
      </div>
    `).join('');
  }
}

function closeSavedJobs(){
  const m = document.getElementById('savedModal');
  m.classList.add('hidden');
  m.style.height = ''; m.style.top = ''; m.style.left = '';
  unlockBodyScroll();
}

function toggleCloudConnect(){
  const panel = document.getElementById('cloudConnectPanel');
  const toggle = document.getElementById('cloudConnectToggle');
  if(!panel) return;
  const isOpen = panel.style.display !== 'none';
  panel.style.display = isOpen ? 'none' : 'block';
  if(!isOpen){
    const hasKey = !!localStorage.getItem('lbiq_worker_key');
    const status = document.getElementById('cloudTokenStatus');
    if(status) status.textContent = hasKey ? '✓ Already connected' : '';
    if(status) status.style.color = 'var(--teal)';
  }
}

function saveCloudToken(){
  const val = document.getElementById('cloudTokenInput')?.value?.trim();
  const status = document.getElementById('cloudTokenStatus');
  if(!val){ if(status){ status.textContent = 'Please paste a key first'; status.style.color='var(--red)'; } return; }
  localStorage.setItem('lbiq_worker_key', val);
  document.getElementById('cloudTokenInput').value = '';
  if(status){ status.textContent = '✓ Connected! You can now save and sync jobs.'; status.style.color='var(--teal)'; }
  setTimeout(() => {
    document.getElementById('cloudConnectPanel').style.display = 'none';
  }, 2000);
}

function updateJobEditStatus(){
  const btn    = document.getElementById('saveJobBtn');
  const newBtn = document.getElementById('newJobBtn');
  const status = document.getElementById('jobEditStatus');
  if(btn)    btn.textContent = currentJobId ? '💾 Update Job' : '💾 Save Job';
  // Relabel when a saved job is loaded — "+ New Job" alone reads like "add to a list", not
  // "clear this and start a blank estimate", which is exactly what it does either way.
  if(newBtn) newBtn.textContent = currentJobId ? '✕ Clear & Start New' : '＋ New Job';
  if(status){
    status.textContent = currentJobId ? '✎ Editing saved job' : '';
    status.style.color = 'var(--teal)';
    status.style.fontSize = '12px';
  }
}

async function deleteJob(id){
  let jobs = JSON.parse(localStorage.getItem('lbiq_jobs') || '[]');
  jobs = jobs.filter(j => j.id !== id);
  localStorage.setItem('lbiq_jobs', JSON.stringify(jobs));
  renderSavedJobsList(); // reflect the local delete immediately — don't let a stale cloud re-fetch undo it
  if(localStorage.getItem('lbiq_worker_key')){
    showToast('Deleting…');
    const r = await pushJobsToCloud(jobs);
    if(!r.ok) showToast('⚠ Deleted locally. Cloud sync failed: '+r.msg+' — will retry next successful sync.');
  }
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
  document.getElementById('jobNotes').value    = '';
  veneerConfigs = []; lumberConfigs = []; laminationConfigs = [];
  veneerCounter = 0; lumberCounter = 0; laminationCounter = 0;
  currentJobId = null;
  Object.keys(productCart).forEach(k => delete productCart[k]);
  renderVeneerConfigs(); renderLumberConfigs(); renderLaminationConfigs();
  addVeneerConfig();
  updateJobEditStatus();
  recalcAll(); isDirty = false;
  showToast('Started a new blank estimate');
}

// --- ADMIN MODAL -------------------------------------------------------
function renderAdminModal(){
  // Cloud sync badge + last sync time
  const hasToken = !!localStorage.getItem('lbiq_gh_token') && !!localStorage.getItem('lbiq_worker_key');
  const badge = document.getElementById('cloud-sync-badge');
  if(badge){
    badge.textContent = hasToken ? 'Configured' : 'Not configured';
    badge.style.background = hasToken ? 'var(--teal-dim)' : 'var(--surf3)';
    badge.style.color = hasToken ? 'var(--teal)' : 'var(--mid)';
  }
  const lastSync = parseInt(localStorage.getItem('lbiq_last_sync') || '0');
  const syncEl = document.getElementById('cloud-sync-time');
  if(syncEl){
    if(lastSync){
      const mins = Math.round((Date.now() - lastSync) / 60000);
      syncEl.textContent = mins < 2 ? 'Last synced: just now' : `Last synced: ${mins} min ago`;
    } else {
      syncEl.textContent = 'Cloud sync not yet received on this device';
    }
  }

  // Markup grid
  const mg = document.getElementById('markupGrid');
  const markupLabels = {
    panels:'Panel & Lam Sheets (Veneer + Lam Face/Back/Core)', edgeBand:'Edge Band Material', lumber:'Lumber Material',
    milling:'Milling / Sanding', assembly:'Assembly', ebService:'EB Service',
    cutService:'Cut Service (Veneer Cut + Lam Glue Line)', brackets:'Brackets',
    dado:'Dado / Groove (Ceiling Tile)',
  };
  mg.innerHTML = Object.entries(markupLabels).map(([k,lbl]) => `
    <div>
      <label class="field-label">${lbl} Margin %</label>
      <input type="number" id="mkp-${k}" value="${pricing.markup[k]||0}" step="0.5" min="0" max="200"
        style="background:var(--surf3);border:1px solid var(--bdr2);border-radius:var(--r);color:var(--ink);padding:8px 10px;width:100%">
    </div>
  `).join('');

  // Veneer species table — finish + core tabbed
  _adminVeneerCore   = _adminVeneerCore   || 'frmdf';
  _adminVeneerFinish = _adminVeneerFinish || 'standard';
  _adminVeneerThick  = _adminVeneerThick  || '075';
  renderVeneerFinishTabs();
  renderVeneerThickTabs();
  renderVeneerCoreTabs();
  renderVeneerPricingTable();
  renderEBPricingSection();

  // Lumber pricing
  const lb = document.getElementById('lumberPricingBody');
  lb.innerHTML = Object.entries(pricing.lumberSpecies).sort(([a],[b]) => naturalSort(a,b)).map(([name,p]) => `
    <tr>
      <td style="white-space:nowrap;min-width:110px">
        <input type="text" class="admin-name-input" value="${name}"
          data-oldname="${name}" data-type="lumber" onchange="renameItem(this)">
      </td>
      <td><input type="number" class="admin-price-input" value="${p.price||0}" step="0.01"
          data-species="${name}" data-key="price" data-table="lumber" placeholder="${p.resaw?'—':''}"></td>
      <td><input type="number" class="admin-price-input" value="${p.price5_4||0}" step="0.01"
          data-species="${name}" data-key="price5_4" data-table="lumber" placeholder="${p.resaw?'—':''}"></td>
      <td><input type="number" class="admin-price-input" value="${p.price6_4||0}" step="0.01"
          data-species="${name}" data-key="price6_4" data-table="lumber" placeholder="${p.resaw?'—':''}"></td>
      <td><input type="number" class="admin-price-input" value="${p.price8_4||0}" step="0.01"
          data-species="${name}" data-key="price8_4" data-table="lumber" placeholder="${p.resaw?'—':''}"></td>
      <td><input type="number" class="admin-price-input" value="${p.price2x6||0}" step="0.01"
          data-species="${name}" data-key="price2x6" data-table="lumber" placeholder="${p.resaw?'':'—'}"></td>
      <td><input type="number" class="admin-price-input" value="${p.price2x8||0}" step="0.01"
          data-species="${name}" data-key="price2x8" data-table="lumber" placeholder="${p.resaw?'':'—'}"></td>
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
    ${svcHead('Standard Milling', 'var(--teal)')}
    ${svcField('millingFlat',      'Flat Fee (≤ threshold $)', '5')}
    ${svcField('millingThreshold', 'Threshold (LF)', '100')}
    ${svcField('millingPerLF',     'Over threshold ($/LF)', '0.01')}
    ${svcField('seriesChange',     'Series change charge ($)', '5')}

    ${svcHead('Resaw Milling (VG / Resaw species)', 'var(--teal)')}
    ${svcField('resawFlat',      'Flat Fee (≤ threshold $)', '5')}
    ${svcField('resawThreshold', 'Threshold (LF)', '100')}
    ${svcField('resawPerLF',     'Over threshold ($/LF)', '0.01')}

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
    ${svcField('ebServicePerFt',    'EB Service ($/ft)', '0.01')}
    ${svcField('cutServicePerSqft', 'Cut Service ($/sqft) — over threshold', '0.01')}
    ${svcField('cutFlatVeneer',     'Cut Service Flat Charge ($) — ≤ threshold', '1')}
    ${svcField('cutVeneerThreshold','Flat Charge Threshold (sheets)', '1')}

    ${svcHead('Dado / Groove (Ceiling Tile)', 'var(--gold)')}
    ${svcField('dadoServicePerSqft', 'Dado Service ($/sqft) — over threshold', '0.01')}
    ${svcField('dadoFlatCharge',     'Dado Flat Charge ($) — ≤ threshold', '1')}
    ${svcField('dadoThreshold',      'Flat Charge Threshold (tiles)', '1')}

    ${svcHead('Lamination Services', '#c084fc')}
    ${svcField('glueLine', 'Glue Line ($/sqft)', '0.01')}
  `;
  renderCategoryManager();
  renderAdminProducts();
  if(!pricing.laminationFaces) pricing.laminationFaces = {};
  if(!pricing.laminationCores) pricing.laminationCores = {};
  renderLaminationAdmin();
}

// Reads all currently-visible admin form inputs into pricing.
// Call this before any re-render of the admin modal to preserve unsaved edits.
function collectAdminForm(){
  // Markup
  ['panels','edgeBand','lumber','milling','assembly','ebService','cutService','brackets','dado'].forEach(k => {
    const el = document.getElementById('mkp-'+k);
    if(el) pricing.markup[k] = parseFloat(el.value) || 0;
  });

  // Veneer species (also auto-written by vPriceInput, but collect here for safety)
  document.querySelectorAll('#veneerPricingBody input[data-species]').forEach(el => {
    const s = el.dataset.species, k = el.dataset.key;
    if(!pricing.veneerSpecies[s]) pricing.veneerSpecies[s] = {};
    pricing.veneerSpecies[s][k] = parseFloat(el.value) || 0;
  });

  // Lumber
  document.querySelectorAll('#lumberPricingBody input[data-species]').forEach(el => {
    const s = el.dataset.species, k = el.dataset.key;
    if(!pricing.lumberSpecies[s]) pricing.lumberSpecies[s] = {};
    if(k === 'resaw') pricing.lumberSpecies[s].resaw = el.checked;
    else pricing.lumberSpecies[s][k] = parseFloat(el.value) || 0;
  });

  // Lamination faces
  document.querySelectorAll('#lamFacesBody input[data-lamface]').forEach(el => {
    const name = el.dataset.lamface, key = el.dataset.key;
    if(!pricing.laminationFaces[name]) pricing.laminationFaces[name] = blankLamFace();
    pricing.laminationFaces[name][key] = parseFloat(el.value) || 0;
  });

  // Lamination cores
  document.querySelectorAll('#lamCoresBody input[data-lamcore]').forEach(el => {
    const name = el.dataset.lamcore, key = el.dataset.key;
    if(!pricing.laminationCores[name]) pricing.laminationCores[name] = blankLamCore();
    if(key === 'netSize') pricing.laminationCores[name].netSize = el.checked;
    else pricing.laminationCores[name][key] = parseFloat(el.value) || 0;
  });

  // Services
  const svcKeys = [
    'millingFlat','millingThreshold','millingPerLF','seriesChange',
    'resawFlat','resawThreshold','resawPerLF',
    'sandingFlat','sandingThreshold','sandingPerLF',
    'cutFlat','cutThreshold','cutPerLF',
    'assembly','bracketPrice','ebServicePerFt','cutServicePerSqft','cutFlatVeneer','cutVeneerThreshold',
    'dadoServicePerSqft','dadoFlatCharge','dadoThreshold',
    'glueLine',
  ];
  svcKeys.forEach(k => {
    const el = document.getElementById('svc-'+k);
    if(el) pricing.services[k] = parseFloat(el.value) || 0;
  });
}

function saveAdmin(){
  // SECURITY: passwords, the Worker Key, and the Worker URL must NEVER be written onto the
  // `pricing` object below — that object gets serialized and pushed straight to the public
  // pricing.json on GitHub. All four stay in localStorage on this device only, exactly like
  // the GitHub token already did. If pricing.json still has any of these fields from before
  // this fix, delete them so they stop being carried forward on every future save.
  delete pricing.lbiPassword;
  delete pricing.workerUrl;
  delete pricing.workerKey;

  // Passwords now live server-side only (Worker + KV) — write-only fields here, blank
  // means "leave unchanged". Admin's own password goes through the same self-service
  // change-password endpoint the header button uses; the LBI/company password is a
  // manual admin-driven reset (no email/forgot-password flow), matching what Heath chose.
  const adminPw = document.getElementById('admin-admin-password')?.value?.trim();
  const lbiPw   = document.getElementById('admin-lbi-password')?.value?.trim();
  const pwToken = getSessionToken();
  const pwPromises = [];
  if(adminPw){
    pwPromises.push(fetch(`${WORKER_AUTH_BASE}/change-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: pwToken, newPassword: adminPw }),
    }).then(r => r.json()));
  }
  if(lbiPw){
    pwPromises.push(fetch(`${WORKER_AUTH_BASE}/admin/reset-company-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: pwToken, newPassword: lbiPw }),
    }).then(r => r.json()));
  }
  if(pwPromises.length){
    document.getElementById('admin-admin-password').value = '';
    document.getElementById('admin-lbi-password').value = '';
    Promise.all(pwPromises).then(results => {
      const failed = results.find(r => !r.ok);
      showToast(failed ? '⚠ Password update failed: ' + failed.msg : '✓ Password(s) updated');
    });
  }

  collectAdminForm();

  // GitHub PAT stays local — only used for pricing.json push from admin
  const ghTokenInput = document.getElementById('admin-gh-token')?.value?.trim();
  if(ghTokenInput) localStorage.setItem('lbiq_gh_token', ghTokenInput);

  // Worker URL + key: local-only, entered once per admin device via this form. No longer
  // auto-distributed through pricing.json (see fetchCloudPricing) — that shipped a write
  // credential to every anonymous visitor's browser before this fix.
  const workerUrlInput = document.getElementById('admin-worker-url')?.value?.trim();
  const workerKeyInput = document.getElementById('admin-worker-key')?.value?.trim();
  if(workerUrlInput) localStorage.setItem('lbiq_worker_url', workerUrlInput);
  if(workerKeyInput) localStorage.setItem('lbiq_worker_key', workerKeyInput);

  localStorage.setItem('lbiq_pricing', JSON.stringify(pricing));
  renderVeneerConfigs();
  renderLumberConfigs();
  renderLaminationConfigs();
  recalcAll();
  closeAdmin();

  if(localStorage.getItem('lbiq_gh_token')){
    showToast('Saving & syncing to cloud…');
    pushCloudPricing().then(r => showToast(r.ok ? '✓ Synced to cloud — all devices updated' : '⚠ Saved locally. Sync failed: '+r.msg));
  } else {
    showToast('Pricing saved!');
  }
  pushAdminPricingSecure().then(r => { if(r.ok) showToast('✓ Also synced to secure pricing storage'); });
}

// --- CLOUD JOB SYNC ---------------------------------------------------
async function pushJobsToCloud(jobs){
  const workerUrl = localStorage.getItem('lbiq_worker_url');
  const workerKey = localStorage.getItem('lbiq_worker_key');
  if(!workerUrl || !workerKey) return { ok:false, msg:'Cloud sync not configured' };
  try {
    const resp = await fetch(workerUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Worker-Key': workerKey },
      body: JSON.stringify(jobs),
    });
    return await resp.json();
  } catch(e){ return { ok:false, msg:e.message }; }
}

async function fetchJobsFromCloud(){
  try {
    const resp = await fetch(
      `https://raw.githubusercontent.com/heathchartier/lbi-calculator/main/jobs.json?_=${Date.now()}`,
      { cache:'no-store' }
    );
    if(!resp.ok) return null;
    const jobs = await resp.json();
    return Array.isArray(jobs) ? jobs : null;
  } catch(e){ return null; }
}

// --- LAMINATION -------------------------------------------------------
function addLaminationConfig(){
  laminationCounter++;
  const faceKeys = Object.keys(pricing.laminationFaces || {});
  const coreKeys = Object.keys(pricing.laminationCores || {});
  const last = laminationConfigs[laminationConfigs.length - 1];
  laminationConfigs.push({
    id:        laminationCounter,
    face:      last?.face      || faceKeys[0] || '',
    back:      last?.back      || faceKeys[0] || '',
    core:      last?.core      || coreKeys[0] || '',
    thickness: last?.thickness || 0.75,
    ebSides:   last?.ebSides   ?? 4,
    calcMode:  last?.calcMode  || 'sqft',
    panelW:0, panelL:0, slatW:0, slatL:0,
    slatsPerPanel:0, bracketsPerPanel:0,
    assembly:false, wasteOn:10, manualQty:0, sqft:0,
  });
  renderLaminationConfigs();
}

function resetLaminationConfigs(){
  if(!confirm('Clear all lamination configurations and start fresh?')) return;
  laminationConfigs = []; laminationCounter = 0;
  addLaminationConfig();
  recalcAll(); markDirty();
}

function removeLaminationConfig(id){
  laminationConfigs = laminationConfigs.filter(c => c.id !== id);
  renderLaminationConfigs();
  recalcAll();
  markDirty();
}

function renderLaminationConfigs(){
  const cont = document.getElementById('laminationConfigs');
  if(!cont) return;
  cont.innerHTML = '';
  const faces = pricing.laminationFaces || {};
  const cores = pricing.laminationCores || {};
  const hasAnyFacePrice = (item) => LAM_FACE_SIZES.some(s => (item?.[`price${s}`]||0) > 0);
  const faceKeys = Object.keys(faces).filter(k => hasAnyFacePrice(faces[k]));
  const hasAnyCorePrice = (item) => LAM_THICK_KEYS.some(t => LAM_SIZES.some(s => (item[`${t.k}_${s}`]||0) > 0));
  const coreKeys = Object.keys(cores).filter(k => hasAnyCorePrice(cores[k]));
  // Largest priced sheet size for a face, so the Back dropdown can be filtered to sizes >= the front face
  const lamFaceMaxArea = (item) => LAM_FACE_SIZES.reduce((max,s) => (item?.[`price${s}`]||0) > 0 ? Math.max(max, LAM_SIZE_AREA[s]) : max, 0);

  laminationConfigs.forEach(cfg => {
    cfg.wasteOn = normalizeWastePct(cfg.wasteOn, 10);
    const modeLabels = {sqft:'By Sq Ft', slats:'By Slat Count', panels:'By Panel Count'};
    const qtyLabel   = cfg.calcMode === 'slats' ? 'Total Slats' : 'Number of Panels';
    const div = document.createElement('div');
    div.className = 'config-card';
    div.id = 'lcfg-' + cfg.id;
    div.innerHTML = `
      <div class="config-header" onclick="toggleCollapse('lcfg-${cfg.id}')">
        <span class="config-num">LAM ${laminationConfigs.indexOf(cfg)+1}</span>
        <span class="config-title" id="ltitle-${cfg.id}">${cfg.face||'New Configuration'}</span>
        <span class="config-chevron">▼</span>
        <button class="btn-danger print-hide" onclick="event.stopPropagation();removeLaminationConfig(${cfg.id})" style="margin-left:8px">Remove</button>
      </div>
      <div class="config-body">
        <div class="config-grid">
          <div>
            <label class="field-label">Laminated Face</label>
            <select id="l2-face-${cfg.id}" onchange="lamUpdate(${cfg.id})">
              ${faceKeys.length
                ? ['Customer Supplied',...faceKeys].map(f=>`<option value="${f}" ${cfg.face===f?'selected':''}>${f}</option>`).join('')
                : '<option value="Customer Supplied">Customer Supplied (no faces priced — see admin)</option>'}
            </select>
          </div>
          <div>
            <label class="field-label">Laminated Back</label>
            <select id="l2-back-${cfg.id}" onchange="lamUpdate(${cfg.id})">
              ${(() => {
                const frontArea = (cfg.face && cfg.face !== 'Customer Supplied') ? lamFaceMaxArea(faces[cfg.face]) : 0;
                const backKeys = frontArea > 0 ? faceKeys.filter(k => lamFaceMaxArea(faces[k]) >= frontArea) : faceKeys;
                return backKeys.length
                  ? ['Customer Supplied',...backKeys].map(f=>`<option value="${f}" ${(cfg.back||cfg.face)===f?'selected':''}>${f}</option>`).join('')
                  : '<option value="Customer Supplied">Customer Supplied (no faces large enough — see admin)</option>';
              })()}
            </select>
          </div>
          <div>
            <label class="field-label">Core</label>
            <select id="l2-core-${cfg.id}" onchange="lamUpdate(${cfg.id})">
              ${coreKeys.length
                ? coreKeys.map(c=>`<option value="${c}" ${cfg.core===c?'selected':''}>${c}</option>`).join('')
                : '<option value="">No cores priced — see admin</option>'}
            </select>
          </div>
          <div>
            <label class="field-label">Core Thickness</label>
            <select id="l2-thick-${cfg.id}" onchange="lamUpdate(${cfg.id})">
              ${LAM_THICK_KEYS.filter(t=>t.user).map(t=>`<option value="${t.val}" ${(cfg.thickness||0.75)==t.val?'selected':''}>${t.label}</option>`).join('')}
            </select>
          </div>
          <div>
            <label class="field-label">Calculate By</label>
            <select id="l2-mode-${cfg.id}" onchange="lamUpdate(${cfg.id})">
              <option value="sqft"   ${cfg.calcMode==='sqft'?'selected':''}>By Sq Ft</option>
              <option value="slats"  ${cfg.calcMode==='slats'?'selected':''}>By Slat Count</option>
              <option value="panels" ${cfg.calcMode==='panels'?'selected':''}>By Panel Count</option>
            </select>
          </div>
          ${cfg.calcMode==='sqft' ? `<div>
            <label class="field-label">Ceiling Sq Ft</label>
            <input type="number" id="l2-sqft-${cfg.id}" value="${cfg.sqft||''}" step="1" min="1" placeholder="e.g. 500" oninput="lamUpdate(${cfg.id})">
          </div>` : `<div>
            <label class="field-label">${qtyLabel}</label>
            <input type="number" id="l2-manualQty-${cfg.id}" value="${cfg.manualQty||''}" step="1" min="1" placeholder="Enter count" oninput="lamUpdate(${cfg.id})">
          </div>`}
        </div>
        <hr class="config-divider">
        <span class="section-label">Panel & Slat Dimensions (inches)</span>
        <div class="config-grid">
          <div>
            <label class="field-label">Panel Width (in)</label>
            <input type="text" id="l2-panelW-${cfg.id}" value="${cfg.panelW||''}" placeholder="e.g. 12" oninput="lamUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Panel Length (in)</label>
            <input type="text" id="l2-panelL-${cfg.id}" value="${cfg.panelL||''}" placeholder="e.g. 96" oninput="lamUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Slat Width (in)</label>
            <input type="text" id="l2-slatW-${cfg.id}" value="${cfg.slatW||''}" placeholder="e.g. 3.25 or 3-1/4" oninput="lamUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Slat Length (in)</label>
            <input type="text" id="l2-slatL-${cfg.id}" value="${cfg.slatL||''}" placeholder="e.g. 96" oninput="lamUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Slats / Panel</label>
            <input type="number" id="l2-slats-${cfg.id}" value="${cfg.slatsPerPanel||''}" step="1" min="1" placeholder="e.g. 4" oninput="lamUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Brackets / Panel</label>
            <input type="number" id="l2-brackets-${cfg.id}" value="${cfg.bracketsPerPanel||''}" step="1" min="0" placeholder="e.g. 8" oninput="lamUpdate(${cfg.id})">
          </div>
          <div>
            <label class="field-label">Edge Band Sides</label>
            <select id="l2-ebsides-${cfg.id}" onchange="lamUpdate(${cfg.id})">
              <option value="4" ${cfg.ebSides===4?'selected':''}>4 sides</option>
              <option value="3" ${cfg.ebSides===3?'selected':''}>3 sides</option>
              <option value="2" ${cfg.ebSides===2?'selected':''}>2 long sides</option>
              <option value="1" ${cfg.ebSides===1?'selected':''}>1 long side</option>
              <option value="0" ${cfg.ebSides===0?'selected':''}>No edge banding</option>
            </select>
          </div>
        </div>
        <hr class="config-divider">
        <div style="display:flex;gap:24px;flex-wrap:wrap">
          <div class="toggle-row">
            <label class="toggle"><input type="checkbox" id="l2-assembly-${cfg.id}" ${cfg.assembly?'checked':''} onchange="lamUpdate(${cfg.id})"><span class="toggle-slider"></span></label>
            <span class="toggle-label">Assembly included</span>
          </div>
          ${wasteToggleHTML(`l2-waste-${cfg.id}-`, `lamUpdate(${cfg.id})`, cfg.wasteOn)}
        </div>
        <div id="l2-preview-${cfg.id}" class="calc-preview" style="margin-top:16px"></div>
      </div>
    `;
    cont.appendChild(div);
  });
}

function lamUpdate(id){
  const cfg = laminationConfigs.find(c => c.id === id);
  if(!cfg) return;
  const prevFace = cfg.face;
  cfg.face      = document.getElementById('l2-face-'+id)?.value  || cfg.face;
  cfg.back      = document.getElementById('l2-back-'+id)?.value  || cfg.back;
  cfg.core      = document.getElementById('l2-core-'+id)?.value  || cfg.core;
  cfg.thickness = parseFloat(document.getElementById('l2-thick-'+id)?.value) || cfg.thickness || 0.75;
  cfg.panelW  = parseFraction(document.getElementById('l2-panelW-'+id)?.value) || 0;
  cfg.panelL  = parseFraction(document.getElementById('l2-panelL-'+id)?.value) || 0;
  cfg.slatW   = parseFraction(document.getElementById('l2-slatW-'+id)?.value) || 0;
  cfg.slatL   = parseFraction(document.getElementById('l2-slatL-'+id)?.value) || 0;
  cfg.slatsPerPanel   = parseInt(document.getElementById('l2-slats-'+id)?.value) || 0;
  cfg.bracketsPerPanel= parseInt(document.getElementById('l2-brackets-'+id)?.value) || 0;
  cfg.ebSides  = parseInt(document.getElementById('l2-ebsides-'+id)?.value) || 0;
  cfg.assembly = document.getElementById('l2-assembly-'+id)?.checked ?? false;
  cfg.wasteOn  = readWastePct(`l2-waste-${id}-10`, `l2-waste-${id}-15`);
  const prevMode = cfg.calcMode;
  cfg.calcMode = document.getElementById('l2-mode-'+id)?.value || cfg.calcMode;
  cfg.sqft     = parseFloat(document.getElementById('l2-sqft-'+id)?.value) || 0;
  cfg.manualQty= parseInt(document.getElementById('l2-manualQty-'+id)?.value) || 0;
  const titleEl = document.getElementById('ltitle-'+id);
  if(titleEl) titleEl.textContent = cfg.face || 'New Configuration';
  if(prevMode !== cfg.calcMode || prevFace !== cfg.face) renderLaminationConfigs();
  calcLaminationPreview(cfg);
  recalcAll();
  markDirty();
}

// resolveLaminationQty, calcLaminationCost now live in calc-engine.js as
// Calc.resolveLaminationQty / Calc.calcLaminationCost.

function calcLaminationPreview(cfg){
  const el = document.getElementById('l2-preview-'+cfg.id);
  if(!el) return;
  const qty = Calc.resolveLaminationQty(cfg);
  if(!qty){ el.innerHTML=''; return; }
  const { panelQty, totalSlats, effectiveSqft } = qty;
  const isCustomer = cfg.face === 'Customer Supplied';
  const isBackCustomer = (cfg.back || cfg.face) === 'Customer Supplied';
  const faceData  = isCustomer ? null : (pricing.laminationFaces||{})[cfg.face];
  const backData  = isBackCustomer ? null : (pricing.laminationFaces||{})[cfg.back || cfg.face];
  const coreData  = (pricing.laminationCores||{})[cfg.core];
  const wasteMult = wasteMultFromPct(cfg.wasteOn);
  const thick     = cfg.thickness || 0.75;

  const faceAvail = isCustomer ? {} : Calc.getLamFacePrices(faceData);
  const backAvail = isBackCustomer ? {} : Calc.getLamFacePrices(backData);
  const coreAvail = Calc.getLamCoreAvailSizes(coreData, thick);
  const coreIsNet = !!coreData?.netSize;
  const combo = Calc.chooseLamSizes(cfg.slatW, cfg.slatL, faceAvail, coreAvail, backAvail, coreIsNet);
  const sheetsNeeded = combo ? Math.ceil(totalSlats/combo.yieldPerSheet*wasteMult) : 0;

  const longSides  = (cfg.ebSides===4||cfg.ebSides===2)?2:(cfg.ebSides===3||cfg.ebSides===1)?1:0;
  const shortSides = (cfg.ebSides===4||cfg.ebSides===3)?2:0;
  const ebLong    = (cfg.slatL/12)*totalSlats*longSides;
  const ebShort   = (cfg.slatW/12)*totalSlats*shortSides;
  const ebRolls   = cfg.ebSides>0?Math.ceil((ebLong+ebShort)*EB_WASTE_FACTOR/EB_ROLL_FEET):0;
  let rows = `<div class="preview-row"><span>${fmtN(totalSlats)} slats · ${fmtN(effectiveSqft,1)} sqft · ${fmtN(panelQty)} panels</span></div>`;
  if(!combo){
    rows += `<div class="preview-row" style="color:var(--warn,#f59e0b)"><span>⚠ No sheet size fits these dimensions, or face/core pricing is missing</span></div>`;
  } else {
    if(!isCustomer)
      rows += `<div class="preview-row"><span>${cfg.face}</span><span>${fmtN(sheetsNeeded)} sheets (${combo.faceSz})</span></div>`;
    else
      rows += `<div class="preview-row"><span>Face: Customer Supplied</span></div>`;
    if(!isBackCustomer && combo.backSz)
      rows += `<div class="preview-row"><span>${cfg.back||cfg.face}</span><span>${fmtN(sheetsNeeded)} sheets (${combo.backSz})</span></div>`;
    if(cfg.core)
      rows += `<div class="preview-row"><span>${cfg.core}</span><span>${fmtN(sheetsNeeded)} sheets (${combo.coreSz})</span></div>`;
  }
  if(ebRolls>0)
    rows += `<div class="preview-row"><span>EB Material</span><span>${fmtN(ebRolls)} rolls</span></div>`;
  el.innerHTML = `<div class="preview-grid">${rows}</div>`;
}

function renderLaminationAdmin(){
  const el = document.getElementById('laminationAdminSection');
  if(!el) return;
  const facesRaw = pricing.laminationFaces || {};
  const coresRaw = pricing.laminationCores || {};
  const faces = Object.fromEntries(Object.keys(facesRaw).sort(naturalSort).map(k => [k, facesRaw[k]]));
  const cores = Object.fromEntries(Object.keys(coresRaw).sort(naturalSort).map(k => [k, coresRaw[k]]));

  const thickHdr = LAM_THICK_KEYS.map(t =>
    `<th colspan="${LAM_SIZES.length}" style="text-align:center;padding:3px 4px;color:var(--mid);border-left:1px solid var(--bdr)">${t.label}</th>`
  ).join('');
  const sizeHdr = LAM_THICK_KEYS.map(() =>
    LAM_SIZES.map(s=>`<th style="text-align:center;padding:2px 3px;color:var(--mid);font-weight:500;font-size:11px">${s}</th>`).join('')
  ).join('');
  const priceInputs = (name, d, attr, fn) =>
    LAM_THICK_KEYS.map(t => LAM_SIZES.map(s => {
      const k = `${t.k}_${s}`;
      const netBlocked = d.netSize && !LAM_NET_SIZES.includes(s);
      return `<td style="padding:2px 3px;border-left:1px solid var(--bdr)">
        <input type="number" class="admin-price-input" value="${netBlocked?0:(d[k]||0)}" step="0.01" style="width:78px"
          data-${attr}="${name}" data-key="${k}" oninput="${fn}(this)" placeholder="${netBlocked?'—':''}" ${netBlocked?'disabled':''}>
      </td>`;
    }).join('')).join('');

  el.innerHTML = `
    <div style="grid-column:1/-1;margin-top:12px;padding-bottom:6px;border-bottom:1px solid var(--bdr2)">
      <span style="font-size:13px;font-weight:700;color:#c084fc;letter-spacing:.5px;text-transform:uppercase">Lamination Faces</span>
    </div>
    <div style="grid-column:1/-1">
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <thead><tr>
          <th style="text-align:left;padding:4px 8px;color:var(--mid)">Face Name</th>
          <th style="text-align:center;padding:4px 8px;color:var(--mid)">4x8 Price/Sheet ($)</th>
          <th style="text-align:center;padding:4px 8px;color:var(--mid)">4x10 Price/Sheet ($)</th>
          <th style="text-align:center;padding:4px 8px;color:var(--mid)">5x12 Price/Sheet ($)</th>
          <th style="text-align:center;padding:4px 8px;color:var(--mid)">EB Roll Price ($)</th>
          <th style="width:36px"></th>
        </tr></thead>
        <tbody id="lamFacesBody">
          ${Object.entries(faces).map(([name,d]) => `<tr>
            <td style="padding:4px 4px;min-width:110px">
              <input type="text" class="admin-name-input" value="${name}"
                data-oldname="${name}" data-type="lamface" onchange="renameItem(this)">
            </td>
            <td style="padding:4px 8px;text-align:center">
              <input type="number" class="admin-price-input" value="${d.price4x8||0}" step="0.01"
                data-lamface="${name}" data-key="price4x8" oninput="lamFacePriceInput(this)">
            </td>
            <td style="padding:4px 8px;text-align:center">
              <input type="number" class="admin-price-input" value="${d.price4x10||0}" step="0.01"
                data-lamface="${name}" data-key="price4x10" oninput="lamFacePriceInput(this)">
            </td>
            <td style="padding:4px 8px;text-align:center">
              <input type="number" class="admin-price-input" value="${d.price5x12||0}" step="0.01"
                data-lamface="${name}" data-key="price5x12" oninput="lamFacePriceInput(this)">
            </td>
            <td style="padding:4px 8px;text-align:center">
              <input type="number" class="admin-price-input" value="${d.ebRoll||0}" step="0.01"
                data-lamface="${name}" data-key="ebRoll" oninput="lamFacePriceInput(this)">
            </td>
            <td style="padding:4px 8px">
              <button class="btn-danger" data-lamface="${name.replace(/"/g,'&quot;')}"
                onclick="removeLaminationFace(this.dataset.lamface)" style="padding:2px 8px;font-size:12px">✕</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div style="display:flex;gap:8px;margin-top:8px">
        <input type="text" id="newLamFaceName" placeholder="Face name (e.g. Formica 909)"
          style="flex:1;background:var(--surf3);border:1px solid var(--bdr2);border-radius:var(--r);color:var(--ink);padding:8px 10px">
        <button class="btn-secondary" onclick="addLaminationFace()">+ Add Face</button>
      </div>
    </div>

    <div style="grid-column:1/-1;margin-top:16px;padding-bottom:6px;border-bottom:1px solid var(--bdr2)">
      <span style="font-size:13px;font-weight:700;color:#c084fc;letter-spacing:.5px;text-transform:uppercase">Lamination Cores</span>
      <span style="font-size:11px;color:var(--mid);margin-left:8px">Price per sheet ($) by thickness and size. Check "Net Size" for cores (like Baltic Birch) that only come in true 48x96 / 60x120 net dimensions — the 4x10 and 5x12 columns are disabled for those.</span>
    </div>
    <div style="grid-column:1/-1;overflow-x:auto">
      <table style="border-collapse:collapse;font-size:12px;min-width:700px">
        <thead>
          <tr>
            <th style="text-align:left;padding:3px 6px;color:var(--mid)" rowspan="2">Core Name</th>
            <th style="text-align:center;padding:3px 4px;color:var(--mid)" rowspan="2">Net Size</th>
            ${thickHdr}
            <th rowspan="2" style="width:32px"></th>
          </tr>
          <tr>${sizeHdr}</tr>
        </thead>
        <tbody id="lamCoresBody">
          ${Object.entries(cores).map(([name,d]) => `<tr>
            <td style="padding:2px 4px;min-width:120px;white-space:nowrap">
              <input type="text" class="admin-name-input" value="${name}"
                data-oldname="${name}" data-type="lamcore" onchange="renameItem(this)" style="min-width:110px">
            </td>
            <td style="padding:2px 4px;text-align:center">
              <input type="checkbox" ${d.netSize?'checked':''} data-lamcore="${name}" data-key="netSize" onchange="lamCoreNetToggle(this)">
            </td>
            ${priceInputs(name, d, 'lamcore', 'lamCorePriceInput')}
            <td style="padding:2px 4px">
              <button class="btn-danger" data-lamcore="${name.replace(/"/g,'&quot;')}"
                onclick="removeLaminationCore(this.dataset.lamcore)" style="padding:2px 6px;font-size:11px">✕</button>
            </td>
          </tr>`).join('')}
        </tbody>
      </table>
      <div style="display:flex;gap:8px;margin-top:8px">
        <input type="text" id="newLamCoreName" placeholder="Core name (e.g. MDF Core)"
          style="flex:1;background:var(--surf3);border:1px solid var(--bdr2);border-radius:var(--r);color:var(--ink);padding:8px 10px">
        <button class="btn-secondary" onclick="addLaminationCore()">+ Add Core</button>
      </div>
    </div>
  `;
}

function addLaminationFace(){
  const input = document.getElementById('newLamFaceName');
  const name = input?.value?.trim();
  if(!name){ showToast('Enter a face name'); return; }
  if(!pricing.laminationFaces) pricing.laminationFaces = {};
  if(pricing.laminationFaces[name]){ showToast('Face already exists'); return; }
  collectAdminForm();
  pricing.laminationFaces[name] = blankLamFace();
  input.value = '';
  renderLaminationAdmin();
}

function removeLaminationFace(name){
  if(!pricing.laminationFaces) return;
  collectAdminForm();
  delete pricing.laminationFaces[name];
  renderLaminationAdmin();
}

function addLaminationCore(){
  const input = document.getElementById('newLamCoreName');
  const name = input?.value?.trim();
  if(!name){ showToast('Enter a core name'); return; }
  if(!pricing.laminationCores) pricing.laminationCores = {};
  if(pricing.laminationCores[name]){ showToast('Core already exists'); return; }
  collectAdminForm();
  pricing.laminationCores[name] = blankLamCore();
  input.value = '';
  renderLaminationAdmin();
}

function removeLaminationCore(name){
  if(!pricing.laminationCores) return;
  collectAdminForm();
  delete pricing.laminationCores[name];
  renderLaminationAdmin();
}

function calcPanelProduct(p){
  const sData = pricing.veneerSpecies[p.species];
  if(!sData) return null;
  const c = coreToKey(p.core || 'Fire Rated MDF');
  const costPerSheet = sData[`${p.grade}_${p.sheetGrade}_${p.sheetSize}_${c}`] || 0;
  if(!costPerSheet) return null;
  const sqft = p.sheetSize === '4x10' ? 40 : 32;
  const margin = (p.markup||0);
  const sellPerSheet = margin>=100 ? costPerSheet : costPerSheet/(1-margin/100);
  return { costPerSheet, sellPerSheet, sellPerSqft: sellPerSheet / sqft, sqft };
}

function calcLumberProduct(p){
  const sData = pricing.lumberSpecies[p.lSpecies];
  if(!sData) return null;
  if(!p.thickness || !p.slatW || !p.slatL) return null;
  const cfg = { species: p.lSpecies, thickness: p.thickness, slatW: p.slatW, slatL: p.slatL, safetyBuffer: false };
  const m = Calc.millLumberCalc(cfg, { totalSlats: 1, randomLength: false });
  if(m.noStock) return null;
  const bfPrice = m.isVGResaw
    ? (m.stockUsed === '2x8' ? (sData.price2x8 || 0) : (sData.price2x6 || 0))
    : (sData[Calc.tierPriceInfo(m.roughT).key] || 0);
  if(!bfPrice) return null;
  const finishedSqft = (p.slatW * p.slatL) / 144;
  const rawBFPerSqft = m.bfPerSlat / finishedSqft;
  const costPerSqft = rawBFPerSqft * bfPrice;
  const margin = (p.markup||0);
  return { costPerSqft, sellPerSqft: margin>=100 ? costPerSqft : costPerSqft/(1-margin/100), rawBFPerSqft };
}

function renderProductsTab(){
  const cont = document.getElementById('tab-products');
  if(!cont) return;
  const allProducts = pricing.standardProducts || [];
  const cats = sortedCats(pricing.productCategories || []);
  const q = productSearch.toLowerCase().trim();
  const products = q ? allProducts.filter(p => p.name.toLowerCase().includes(q)) : allProducts;
  const searchBar = `<div style="margin-bottom:16px">
    <input type="text" placeholder="🔍 Search products…" value="${productSearch.replace(/"/g,'&quot;')}"
      oninput="productSearch=this.value;renderProductsTab()"
      style="width:100%;background:var(--surf3);border:1px solid var(--bdr2);border-radius:var(--r);color:var(--ink);padding:9px 12px;font-size:14px;box-sizing:border-box">
  </div>`;
  if(!allProducts.length){
    cont.innerHTML = searchBar + '<div style="text-align:center;padding:48px 0;color:var(--mid);font-size:15px">No standard products have been added yet.</div>';
    return;
  }
  const renderCard = p => {
    const sell = (p.markup||0)>=100 ? (p.cost||0) : (p.cost||0)/(1-(p.markup||0)/100);
    if(!sell) return '';
    const qty = productCart[p.name] || 0;
    const lineTotal = qty > 0 ? `<span class="product-line-total">${fmt(qty * sell)}</span>` : '';
    const unit = p.type === 'lumber' ? 'BF' : 'EA';
    return `<div class="product-card">
      <div class="product-card-name">${p.name}</div>
      <div class="product-card-prices">
        <div class="product-price-item highlight"><span class="ppi-label">Price</span><span class="ppi-val">${fmt(sell)}</span></div>
      </div>
      <div class="product-qty-row">
        <label class="field-label" style="margin:0;white-space:nowrap">Qty</label>
        <input type="number" min="0" step="1" value="${qty||''}" placeholder="0"
          data-pname="${p.name.replace(/"/g,'&quot;')}"
          oninput="updateProductQty(this.dataset.pname,parseFloat(this.value)||0)">
        <span class="field-label" style="margin:0">${unit}</span>
        ${lineTotal}
      </div>
    </div>`;
  };
  const isSearching = !!q;
  const renderSection = (id, label, prods, cardFn, topMargin) => {
    if(!prods.length) return '';
    const collapsed = isSearching ? false : (productCatCollapsed[id] ?? true);
    return `<div class="product-section-label${collapsed?' collapsed':''}" style="margin-top:${topMargin?'28px':'0'}" onclick="toggleProductCat('${id}')">
      <span class="product-section-chevron">▼</span>${label} <span class="product-section-count">(${prods.length})</span>
    </div>${collapsed ? '' : `<div class="product-grid">${prods.map(cardFn).join('')}</div>`}`;
  };
  let html = '';
  if(cats.length){
    cats.forEach(cat => {
      const catProds = products.filter(p => p.category === cat.id);
      html += renderSection('cat-'+cat.id, cat.name, catProds, renderCard, !!html);
    });
    const uncat = products.filter(p => !p.category || !cats.find(c => c.id === p.category));
    html += renderSection('uncat', 'Other', uncat, renderCard, !!html);
  } else {
    const panels = products.filter(p => p.type === 'panel');
    const lumber = products.filter(p => p.type === 'lumber');
    html += renderSection('panels', 'Panel Products', panels, renderCard, !!html);
    html += renderSection('lumber', 'Lumber Products', lumber, renderCard, !!html);
  }
  if(!html) html = '<div style="text-align:center;padding:48px 0;color:var(--mid);font-size:15px">No products match your search.</div>';
  cont.innerHTML = searchBar + html;
}

function toggleProductCat(id){
  productCatCollapsed[id] = !(productCatCollapsed[id] ?? true);
  renderProductsTab();
}

function updateProductQty(name, qty){
  if(!qty || qty <= 0) delete productCart[name];
  else productCart[name] = qty;
  renderResults();
  markDirty();
}

function renderVeneerThickTabs(){
  const wrap = document.getElementById('veneer-thick-tabs');
  if(!wrap) return;
  wrap.innerHTML = THICK_OPTIONS.map(({key,label}) =>
    `<button class="${_adminVeneerThick===key?'btn-primary':'btn-ghost'}"
      onclick="setVeneerThick('${key}')" style="padding:5px 14px;font-size:12px">${label}</button>`
  ).join('');
}

function setVeneerThick(t){
  _adminVeneerThick = t;
  renderVeneerThickTabs();
  renderVeneerPricingTable();
}

function renderVeneerFinishTabs(){
  const wrap = document.getElementById('veneer-finish-tabs');
  if(!wrap) return;
  wrap.innerHTML = [
    { key:'standard', label:'Standard' },
    { key:'satin',    label:'Satin Finish' }
  ].map(f => `<button class="${_adminVeneerFinish===f.key?'btn-primary':'btn-ghost'}"
    onclick="setVeneerFinish('${f.key}')" style="padding:5px 14px;font-size:12px">${f.label}</button>`
  ).join('');
}

function setVeneerFinish(f){
  _adminVeneerFinish = f;
  renderVeneerFinishTabs();
  renderVeneerPricingTable();
}

function renderVeneerCoreTabs(){
  const wrap = document.getElementById('veneer-core-tabs');
  if(!wrap) return;
  const cores = pricing.veneerCores || [];
  const builtinKeys = ['frmdf','mdf','pb','frpb'];
  wrap.innerHTML = cores.map(c => {
    const isActive = c.key === _adminVeneerCore;
    const canRemove = !builtinKeys.includes(c.key);
    return `<span style="display:inline-flex;align-items:center;gap:2px">
      <button id="vcore-tab-${c.key}" class="${isActive?'btn-primary':'btn-ghost'}"
        onclick="setVeneerCore('${c.key}')" style="padding:5px 12px;font-size:12px">${c.label}</button>${
      canRemove ? `<button onclick="removeVeneerCore('${c.key}')" title="Remove core" style="background:none;border:none;color:var(--mid);cursor:pointer;padding:0 3px;font-size:13px;line-height:1">✕</button>` : ''
    }</span>`;
  }).join('') + `<button class="btn-ghost" onclick="addVeneerCore()" style="padding:5px 12px;font-size:12px">+ Add Core</button>`;
}

function addVeneerCore(){
  const label = prompt('New core name (e.g. "Plywood" or "LVL"):');
  if(!label || !label.trim()) return;
  const l = label.trim();
  const key = l.toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'') || ('core'+Date.now());
  if((pricing.veneerCores||[]).find(c => c.key === key || c.label === l)){
    showToast('A core with that name already exists'); return;
  }
  if(!pricing.veneerCores) pricing.veneerCores = [];
  pricing.veneerCores.push({ key, label: l });
  ensureAllCoreKeys();
  localStorage.setItem('lbiq_pricing', JSON.stringify(pricing));
  _adminVeneerCore = key;
  renderVeneerCoreTabs();
  renderVeneerPricingTable();
  renderVeneerConfigs();
  showToast('Core "'+l+'" added');
}

function removeVeneerCore(key){
  const core = (pricing.veneerCores||[]).find(c => c.key === key);
  if(!core) return;
  if(!confirm('Remove core "'+core.label+'"? Pricing data for this core will be kept but hidden.')) return;
  pricing.veneerCores = pricing.veneerCores.filter(c => c.key !== key);
  localStorage.setItem('lbiq_pricing', JSON.stringify(pricing));
  if(_adminVeneerCore === key) _adminVeneerCore = (pricing.veneerCores[0]||{key:'frmdf'}).key;
  renderVeneerCoreTabs();
  renderVeneerPricingTable();
}

function renderVeneerPricingTable(){
  const vb = document.getElementById('veneerPricingBody');
  if(!vb) return;
  const c  = _adminVeneerCore;
  const t  = _adminVeneerThick;
  const fs = _adminVeneerFinish === 'satin' ? '_satin' : '';
  vb.innerHTML = Object.entries(pricing.veneerSpecies).filter(([name]) => name !== 'Custom').sort(([a],[b]) => naturalSort(a,b)).map(([name, p]) => {
    const inp = (key) => `<input type="number" class="admin-price-input" value="${p[key]||0}" step="1" data-species="${name}" data-key="${key}" oninput="vPriceInput(this)">`;
    const row = (sup, label, color) => `
      <tr>
        ${sup==='talbert' ? `<td rowspan="2" style="vertical-align:middle;min-width:110px">
          <input type="text" class="admin-name-input" value="${name}"
            data-oldname="${name}" data-type="veneer" onchange="renameItem(this)">
        </td>` : ''}
        <td style="font-size:11px;font-weight:700;letter-spacing:.5px;color:${color};white-space:nowrap">${label}</td>
        <td>${inp(`${sup}_A3_4x8_${c}_${t}${fs}`)}</td>
        <td>${inp(`${sup}_A3_4x10_${c}_${t}${fs}`)}</td>
        <td>${inp(`${sup}_AA_4x8_${c}_${t}${fs}`)}</td>
        <td>${inp(`${sup}_AA_4x10_${c}_${t}${fs}`)}</td>
      </tr>`;
    return row('talbert','Talbert','var(--teal)') + row('timber','Timber','var(--gold)');
  }).join('');
}

function renderEBPricingSection(){
  const eb = document.getElementById('ebPricingBody');
  if(!eb) return;
  eb.innerHTML = Object.entries(pricing.veneerSpecies)
    .filter(([name]) => name !== 'Custom')
    .sort(([a],[b]) => naturalSort(a,b))
    .map(([name, p]) => {
      const inp = (key) => `<input type="number" class="admin-price-input" value="${p[key]||0}" step="1" data-species="${name}" data-key="${key}" oninput="vPriceInput(this)">`;
      return `<tr>
        <td style="vertical-align:middle;min-width:110px">
          <input type="text" class="admin-name-input" value="${name}"
            data-oldname="${name}" data-type="veneer" onchange="renameItem(this)">
        </td>
        <td>${inp('eb_roll')}</td>
        <td>${inp('eb_roll_satin')}</td>
      </tr>`;
    }).join('');
}

function setVeneerCore(c){
  _adminVeneerCore = c;
  renderVeneerCoreTabs();
  renderVeneerPricingTable();
}

function vPriceInput(el){
  const s = el.dataset.species, k = el.dataset.key;
  if(!pricing.veneerSpecies[s]) pricing.veneerSpecies[s] = blankVeneerSpecies();
  pricing.veneerSpecies[s][k] = parseFloat(el.value) || 0;
}
function lamFacePriceInput(el){
  const name = el.dataset.lamface, k = el.dataset.key;
  if(!pricing.laminationFaces[name]) pricing.laminationFaces[name] = blankLamFace();
  pricing.laminationFaces[name][k] = parseFloat(el.value) || 0;
}
function lamCorePriceInput(el){
  const name = el.dataset.lamcore, k = el.dataset.key;
  if(!pricing.laminationCores[name]) pricing.laminationCores[name] = blankLamCore();
  pricing.laminationCores[name][k] = parseFloat(el.value) || 0;
}
function lamCoreNetToggle(el){
  const name = el.dataset.lamcore;
  if(!pricing.laminationCores[name]) pricing.laminationCores[name] = blankLamCore();
  pricing.laminationCores[name].netSize = el.checked;
  renderLaminationAdmin();
  recalcAll();
  markDirty();
}

function renameItem(el){
  const oldName = el.dataset.oldname;
  const newName = el.value.trim();
  const type    = el.dataset.type;
  if(!newName || newName === oldName) return;
  collectAdminForm();
  const mapKey = {veneer:'veneerSpecies',lumber:'lumberSpecies',lamface:'laminationFaces',lamcore:'laminationCores'}[type];
  if(type === 'veneer' && pricing.veneerSpecies[oldName]){
    pricing.veneerSpecies[newName] = pricing.veneerSpecies[oldName];
    delete pricing.veneerSpecies[oldName];
    veneerConfigs.forEach(c => { if(c.species === oldName) c.species = newName; });
  } else if(type === 'lumber' && pricing.lumberSpecies[oldName]){
    pricing.lumberSpecies[newName] = pricing.lumberSpecies[oldName];
    delete pricing.lumberSpecies[oldName];
    lumberConfigs.forEach(c => { if(c.species === oldName) c.species = newName; });
  } else if(type === 'lamface' && pricing.laminationFaces[oldName]){
    pricing.laminationFaces[newName] = pricing.laminationFaces[oldName];
    delete pricing.laminationFaces[oldName];
    laminationConfigs.forEach(c => { if(c.face === oldName) c.face = newName; });
  } else if(type === 'lamcore' && pricing.laminationCores[oldName]){
    pricing.laminationCores[newName] = pricing.laminationCores[oldName];
    delete pricing.laminationCores[oldName];
    laminationConfigs.forEach(c => { if(c.core === oldName) c.core = newName; });
  } else {
    return;
  }
  // Record rename so saved jobs using the old name auto-update on load
  if(!pricing.renameMap) pricing.renameMap = {veneerSpecies:{},lumberSpecies:{},laminationFaces:{},laminationCores:{}};
  const map = pricing.renameMap[mapKey] || (pricing.renameMap[mapKey] = {});
  // If something previously renamed TO oldName, chain it forward
  Object.keys(map).forEach(k => { if(map[k] === oldName) map[k] = newName; });
  map[oldName] = newName;
  renderAdminModal();
  recalcAll();
  markDirty();
}

function renderAdminProducts(){
  const cont = document.getElementById('admin-products-list');
  if(!cont) return;
  const products = pricing.standardProducts || [];
  const cats = pricing.productCategories || [];
  if(!products.length){
    cont.innerHTML = '<div style="color:var(--mid);font-size:13px;padding:6px 0">No products yet.</div>';
    return;
  }
  const renderRow = p => {
    const sell = (p.markup||0)>=100 ? (p.cost||0) : (p.cost||0)/(1-(p.markup||0)/100);
    const price = p.cost ? `Cost: ${fmt(p.cost)} → Sell: ${fmt(sell)}` : '— no cost set';
    return `<div class="prod-drag-row" draggable="true"
      ondragstart="prodDragStart(event,${p.id})"
      ondragover="prodDragOver(event)"
      ondrop="prodDrop(event,${p.id})"
      ondragleave="this.classList.remove('drag-over')"
      style="display:flex;align-items:center;gap:10px;padding:9px 0 9px 4px;border-bottom:1px solid var(--bdr)">
      <span class="drag-handle">⠿</span>
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:14px">${p.name}</div>
        <div style="font-size:12px;color:var(--mid)">${p.type==='panel'?'Panel':'Lumber'} · ${price}</div>
      </div>
      <button class="btn-ghost" style="padding:5px 10px;font-size:12px;flex-shrink:0" onclick="editStandardProduct(${p.id})">Edit</button>
      <button class="btn-danger" style="padding:5px 10px;font-size:12px;flex-shrink:0" onclick="removeStandardProduct(${p.id})">✕</button>
    </div>`;
  };
  const sortedCatList = sortedCats(cats);
  const renderCatHeader = (id, label, count, color) => {
    const collapsed = adminProdCatCollapsed[id] ?? true;
    return `<div style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;padding:10px 0 2px" onclick="toggleAdminProdCat('${id}')">
      <span style="font-size:10px;color:var(--mid);transition:transform .2s;transform:rotate(${collapsed?'-90deg':'0deg'})">▼</span>
      <span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:${color}">${label}</span>
      <span style="font-size:11px;color:var(--mid)">(${count})</span>
    </div>`;
  };
  let html = '';
  sortedCatList.forEach(cat => {
    const catProds = products.filter(p => p.category === cat.id);
    if(!catProds.length) return;
    const id = 'cat-'+cat.id;
    html += renderCatHeader(id, cat.name, catProds.length, 'var(--teal)');
    if(!(adminProdCatCollapsed[id] ?? true)) catProds.forEach(p => { html += renderRow(p); });
  });
  const uncat = products.filter(p => !p.category || !cats.find(c => c.id === p.category));
  if(uncat.length){
    if(cats.length){
      html += renderCatHeader('uncat', 'Uncategorized', uncat.length, 'var(--mid)');
      if(!(adminProdCatCollapsed['uncat'] ?? true)) uncat.forEach(p => { html += renderRow(p); });
    } else {
      uncat.forEach(p => { html += renderRow(p); });
    }
  }
  cont.innerHTML = html;
}

function toggleAdminProdCat(id){
  adminProdCatCollapsed[id] = !(adminProdCatCollapsed[id] ?? true);
  renderAdminProducts();
}

function renderCategoryManager(){
  const cont = document.getElementById('admin-category-manager');
  if(!cont) return;
  const cats = sortedCats(pricing.productCategories || []);
  let html = cats.map(c => `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-bottom:1px solid var(--bdr)">
    <span style="flex:1;font-size:13px;font-weight:600">${c.name}</span>
    <button class="btn-danger" style="padding:3px 8px;font-size:12px" onclick="removeCategory(${c.id})">✕</button>
  </div>`).join('');
  if(!cats.length) html = '<div style="color:var(--mid);font-size:12px;padding:4px 0 6px">No categories yet.</div>';
  cont.innerHTML = html;
}

function addCategory(){
  const name = prompt('Category name:');
  if(!name || !name.trim()) return;
  if(!pricing.productCategories) pricing.productCategories = [];
  pricing.productCategories.push({ id: ++categoryCounter, name: name.trim() });
  localStorage.setItem('lbiq_pricing', JSON.stringify(pricing));
  renderCategoryManager();
  renderAdminProducts();
  renderProductsTab();
}

function removeCategory(id){
  if(!confirm('Remove this category? Products in it will become uncategorized.')) return;
  pricing.productCategories = (pricing.productCategories||[]).filter(c => c.id !== id);
  (pricing.standardProducts||[]).forEach(p => { if(p.category === id) p.category = 0; });
  localStorage.setItem('lbiq_pricing', JSON.stringify(pricing));
  renderCategoryManager();
  renderAdminProducts();
  renderProductsTab();
}

function prodDragStart(e, id){ _dragProdId = id; e.dataTransfer.effectAllowed = 'move'; }
function prodDragOver(e){ e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add('drag-over'); }
function prodDrop(e, targetId){
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if(_dragProdId === null || _dragProdId === targetId){ _dragProdId = null; return; }
  const prods = pricing.standardProducts || [];
  const fromIdx = prods.findIndex(p => p.id === _dragProdId);
  const toIdx = prods.findIndex(p => p.id === targetId);
  if(fromIdx < 0 || toIdx < 0){ _dragProdId = null; return; }
  prods[fromIdx].category = prods[toIdx].category;
  const [moved] = prods.splice(fromIdx, 1);
  const newTo = prods.findIndex(p => p.id === targetId);
  prods.splice(newTo, 0, moved);
  pricing.standardProducts = prods;
  localStorage.setItem('lbiq_pricing', JSON.stringify(pricing));
  _dragProdId = null;
  renderAdminProducts();
  renderProductsTab();
}

function catDragStart(e, id){ _dragCatId = id; e.dataTransfer.effectAllowed = 'move'; }
function catDragOver(e){ e.preventDefault(); e.dataTransfer.dropEffect = 'move'; e.currentTarget.classList.add('drag-over'); }
function catDrop(e, targetId){
  e.preventDefault();
  e.currentTarget.classList.remove('drag-over');
  if(_dragCatId === null || _dragCatId === targetId){ _dragCatId = null; return; }
  const cats = pricing.productCategories || [];
  const fromIdx = cats.findIndex(c => c.id === _dragCatId);
  const toIdx = cats.findIndex(c => c.id === targetId);
  if(fromIdx < 0 || toIdx < 0){ _dragCatId = null; return; }
  const [moved] = cats.splice(fromIdx, 1);
  cats.splice(toIdx, 0, moved);
  pricing.productCategories = cats;
  localStorage.setItem('lbiq_pricing', JSON.stringify(pricing));
  _dragCatId = null;
  renderCategoryManager();
  renderAdminProducts();
  renderProductsTab();
}

function populateProductFormSelects(){
  const catSel = document.getElementById('apf-category');
  if(catSel){
    const cats = pricing.productCategories || [];
    catSel.innerHTML = '<option value="0">— No Category —</option>' + cats.map(c=>`<option value="${c.id}">${c.name}</option>`).join('');
  }
}

function showProductForm(type, p){
  populateProductFormSelects();
  const form = document.getElementById('admin-product-form');
  form.style.display = '';
  document.getElementById('apf-type').value = type;
  document.getElementById('apf-id').value = p ? p.id : '';
  document.getElementById('apf-name').value = p ? p.name : '';
  document.getElementById('apf-markup').value = p ? (p.markup||0) : 0;
  document.getElementById('apf-category').value = p ? (p.category||0) : 0;
  document.getElementById('apf-form-title').textContent = (p ? 'Edit' : 'New') + (type==='panel' ? ' Panel' : ' Lumber') + ' Product';

  document.getElementById('apf-cost').value = p ? (p.cost||0) : 0;
  document.getElementById('apf-form-title').textContent = (p ? 'Edit' : 'New') + ' Product';
}

function addStandardProduct(type){ showProductForm(type, null); }

function editStandardProduct(id){
  const p = (pricing.standardProducts||[]).find(x => x.id===id);
  if(p) showProductForm(p.type, p);
}

function saveProductForm(){
  const type = document.getElementById('apf-type').value;
  const existingId = parseInt(document.getElementById('apf-id').value)||0;
  const name = document.getElementById('apf-name').value.trim();
  if(!name){ showToast('Enter a product name'); return; }
  const cost     = parseFloat(document.getElementById('apf-cost').value)||0;
  const markup   = parseFloat(document.getElementById('apf-markup').value)||0;
  const category = parseInt(document.getElementById('apf-category').value)||0;
  const product  = { id: existingId||++productCounter, type, name, cost, markup, category };
  if(!pricing.standardProducts) pricing.standardProducts=[];
  const idx = pricing.standardProducts.findIndex(p => p.id===existingId);
  if(idx>=0) pricing.standardProducts[idx]=product;
  else pricing.standardProducts.push(product);
  localStorage.setItem('lbiq_pricing', JSON.stringify(pricing));
  document.getElementById('admin-product-form').style.display='none';
  renderAdminProducts();
  renderProductsTab();
  showToast('Product saved!');
}

function removeStandardProduct(id){
  if(!confirm('Remove this product?')) return;
  pricing.standardProducts=(pricing.standardProducts||[]).filter(p=>p.id!==id);
  localStorage.setItem('lbiq_pricing', JSON.stringify(pricing));
  renderAdminProducts();
  renderProductsTab();
}

function addCustomSpecies(type){
  const name = prompt('Enter new species name:');
  if(!name || !name.trim()) return;
  const n = name.trim();
  collectAdminForm(); // preserve any prices typed but not yet saved
  if(type === 'veneer'){
    if(!pricing.veneerSpecies[n]){ pricing.veneerSpecies[n] = blankVeneerSpecies(); ensureAllCoreKeys(); }
  } else {
    if(!pricing.lumberSpecies[n]) pricing.lumberSpecies[n] = {price:0, resaw:false};
  }
  renderAdminModal();
}

// --- CLOUD SYNC -------------------------------------------------------
async function fetchCloudPricing(){
  const resp = await fetch(
    `https://raw.githubusercontent.com/heathchartier/lbi-calculator/main/pricing.json?_=${Date.now()}`,
    { cache:'no-store' }
  );
  if(!resp.ok) return;
  const imported = await resp.json();
  if(!imported.veneerSpecies || !imported.services) return;
  localStorage.setItem('lbiq_last_sync', Date.now());
  localStorage.setItem('lbiq_pricing', JSON.stringify(imported));
  // SECURITY: this fetch runs for EVERY visitor on EVERY page load, before any login check —
  // it must never write credentials (Worker Key, passwords) to localStorage here. That used
  // to happen ("auto-distribute worker credentials to this device") and silently handed a
  // write-capable key to any anonymous visitor's browser. Worker URL/Key are entered once by
  // an admin via Admin Settings instead (saveAdmin) and stay local to that device only.
  // Also strip any legacy secret fields that older pricing.json snapshots may still carry.
  delete imported.workerUrl;
  delete imported.workerKey;
  delete imported.lbiPassword;
  Object.keys(pricing).forEach(k => delete pricing[k]);
  Object.assign(pricing, imported);
  if(!pricing.productCategories) pricing.productCategories = [];
  if(!pricing.laminationFaces)   pricing.laminationFaces = {};
  if(!pricing.laminationCores)   pricing.laminationCores = {};
  if(!pricing.veneerCores) pricing.veneerCores = deepCopy(DEFAULT_PRICING.veneerCores);
  ensureAllCoreKeys();
  migrateThicknessKeys();
  Object.values(pricing.veneerSpecies).forEach(p => {
    if(!p['eb_roll'])       p['eb_roll']       = p['timber_eb_roll'] || p['talbert_eb_roll'] || 0;
    if(p['eb_roll_satin'] === undefined) p['eb_roll_satin'] = 0;
  });
  productCounter = Math.max(0, ...((pricing.standardProducts||[]).map(p=>p.id||0)));
  categoryCounter = Math.max(0, ...((pricing.productCategories||[]).map(c=>c.id||0)));
}

async function pushCloudPricing(){
  const token = localStorage.getItem('lbiq_gh_token');
  if(!token) return { ok:false, msg:'No token' };
  const url = 'https://api.github.com/repos/heathchartier/lbi-calculator/contents/pricing.json';
  const headers = {
    'Authorization':`Bearer ${token}`,
    'Accept':'application/vnd.github.v3+json',
    'Content-Type':'application/json'
  };
  // SECURITY: final safety net — never let a password or the Worker Key ride along into the
  // public pricing.json, no matter how they got onto the in-memory `pricing` object.
  const sanitized = { ...pricing };
  delete sanitized.lbiPassword; delete sanitized.workerUrl; delete sanitized.workerKey;
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(sanitized, null, 2))));
  async function tryPush(retries){
    try {
      let sha;
      const getResp = await fetch(url, { headers });
      if(getResp.ok){ sha = (await getResp.json()).sha; }
      else if(getResp.status === 401) return { ok:false, msg:'Token invalid or expired — re-paste in Admin → Cloud Sync' };
      else if(getResp.status !== 404) return { ok:false, msg:'Could not reach GitHub' };
      const body = { message:'Update pricing from admin', content };
      if(sha) body.sha = sha;
      const putResp = await fetch(url, { method:'PUT', headers, body:JSON.stringify(body) });
      if(putResp.ok){
        const d = await putResp.json();
        localStorage.setItem('lbiq_cloud_sha', d.content.sha);
        return { ok:true };
      }
      const err = await putResp.json();
      // SHA mismatch — retry once with a fresh GET
      if(putResp.status === 409 && retries > 0) return tryPush(retries - 1);
      if(putResp.status === 401) return { ok:false, msg:'Token invalid or expired — re-paste in Admin → Cloud Sync' };
      return { ok:false, msg: err.message || `Error ${putResp.status}` };
    } catch(e){ return { ok:false, msg:'Network error' }; }
  }
  return tryPush(1);
}

// New secure pricing storage (PRICING_KV via the Worker's /admin/pricing) — runs alongside
// pushCloudPricing() above, not instead of it. Both stay live until Ryan's system has fully
// moved onto /pricing/calculate and /pricing/options; only then does the GitHub push above
// get retired. Silent on failure by design: until PRICING_KV is actually created and this
// branch is deployed, every call here is expected to fail (network error or 401 against the
// still-live old Worker, which requires X-Worker-Key for any PUT and never gets it from this
// call) — that's a safe no-op, not a real error, so there's nothing to alarm the admin with.
async function pushAdminPricingSecure(){
  const token = getSessionToken();
  if(!token) return { ok:false, msg:'Not logged in' };
  try {
    const resp = await fetch(`${WORKER_AUTH_BASE}/admin/pricing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, pricing }),
    });
    try { return await resp.json(); }
    catch { return { ok:false, msg:'Bad response' }; }
  } catch(e){
    return { ok:false, msg: e.message };
  }
}

// Company role never gets real pricing.json — this builds a structurally-identical `pricing`
// object from the cost-free /pricing/options endpoint instead, so every existing render/lookup
// function (visibleVeneerSpecies, renderLumberConfigs, calcVeneerPreview, etc.) keeps working
// completely unmodified, but every dollar field is a fixed placeholder (1), never a real
// number — deliberately not 0, since several filters check `price > 0` to decide whether an
// option should appear, and a uniform non-zero placeholder makes every option appear equally
// available (correct: the real availability check now happens server-side in
// Calc.calcVeneerCost/calcLumberCost/calcLaminationCost via /pricing/calculate, which returns
// a "⚠ Call for pricing" line for anything actually unpriced — same as admin already sees).
// Structural, non-monetary flags (resaw, netSize, veneer core keys) come through as real
// values, since those drive genuine UI/calc behavior and reveal nothing about cost.
function placeholderVeneerSpecies(){
  const o = blankVeneerSpecies();
  Object.keys(o).forEach(k => { o[k] = 1; });
  return o;
}
function placeholderLamFace(){ return { price4x8:1, price4x10:1, price5x12:1, ebRoll:1 }; }
function placeholderLamCore(netSize){
  const o = blankLamCore();
  Object.keys(o).forEach(k => { if(k !== 'netSize') o[k] = 1; });
  o.netSize = !!netSize;
  return o;
}
async function applyCompanyPricingOptions(){
  try {
    const resp = await fetch(`${WORKER_AUTH_BASE}/pricing/options`);
    const result = await resp.json();
    if(!result.ok) return;
    const opts = result.options;

    Object.keys(pricing).forEach(k => delete pricing[k]);
    Object.assign(pricing, deepCopy(DEFAULT_PRICING));

    pricing.veneerSpecies = {};
    (opts.veneerSpecies || []).forEach(name => { pricing.veneerSpecies[name] = placeholderVeneerSpecies(); });

    pricing.lumberSpecies = {};
    (opts.lumberSpecies || []).forEach(({name, resaw}) => {
      pricing.lumberSpecies[name] = { price:1, price5_4:1, price6_4:1, price8_4:1, price2x6:1, price2x8:1, resaw:!!resaw };
    });

    (opts.veneerCores || []).forEach(({key, label}) => {
      if(!pricing.veneerCores.find(c => c.key === key)) pricing.veneerCores.push({ key, label });
    });

    pricing.laminationFaces = {};
    (opts.laminationFaces || []).forEach(name => { pricing.laminationFaces[name] = placeholderLamFace(); });

    pricing.laminationCores = {};
    (opts.laminationCores || []).forEach(({name, netSize}) => { pricing.laminationCores[name] = placeholderLamCore(netSize); });

    // Stock products: the sell price IS meant to be visible (that's the final quoted price) —
    // stored here as cost with markup 0 so the existing renderProductsTab math (cost/(1-markup))
    // reproduces exactly that sell price, without a real wholesale cost or margin ever existing
    // in this object.
    pricing.standardProducts = (opts.standardProducts || []).map(p => ({
      id: p.id, name: p.name, type: p.type, category: p.category, cost: p.sellPrice, markup: 0,
    }));
    pricing.productCategories = opts.productCategories || [];

    ensureAllCoreKeys();
  } catch(e){ /* keep whatever was already in `pricing` (structural defaults) */ }
}

// --- PRICING EXPORT / IMPORT ------------------------------------------
function exportPricing(){
  const json = JSON.stringify(pricing, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'lbiq-pricing.json'; a.click();
  URL.revokeObjectURL(url);
  showToast('Pricing exported — open on the other device and import');
}

function importPricing(input){
  const file = input.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    try {
      const imported = JSON.parse(e.target.result);
      if(!imported.veneerSpecies || !imported.services) { showToast('Invalid pricing file'); return; }
      if(!confirm('Replace all pricing with the imported data? This cannot be undone.')) return;
      localStorage.setItem('lbiq_pricing', JSON.stringify(imported));
      location.reload();
    } catch(err) { showToast('Could not read file — make sure it is a valid pricing export'); }
  };
  reader.readAsText(file);
  input.value = '';
}

// --- CALCULATORS ------------------------------------------------------
function r2(n){ return Math.round(n * 100) / 100; }

function calcBF(){
  const w = parseFraction(document.getElementById('bf-width').value);
  const t = parseFraction(document.getElementById('bf-thick').value);
  const l = parseFraction(document.getElementById('bf-len').value);
  const q = parseFloat(document.getElementById('bf-qty').value) || 1;
  const el       = document.getElementById('bf-result');
  const stockEl  = document.getElementById('bf-stock-label');
  const boardsEl = document.getElementById('bf-boards-label');
  const totalEl  = document.getElementById('bf-total-label');
  const wastePct = readWastePct('bf-waste10', 'bf-waste15');

  if(!w || !t || !l || isNaN(w) || isNaN(t) || isNaN(l)){
    el.textContent = '—'; stockEl.textContent = ''; boardsEl.textContent = ''; totalEl.textContent = ''; return;
  }

  const info = Calc.getStockInfo(t);
  const stockThick = info ? info.stock : t;
  const boardsNeeded = (info && info.resaw) ? Math.ceil(q / 2) : q;
  const bf = (w * stockThick * l * boardsNeeded) / 12;

  el.textContent = fmtN(bf, 2);
  totalEl.textContent = wastePct ? `Total (+${wastePct}%): ${fmtN(bf * wasteMultFromPct(wastePct), 2)} BF` : '';

  if(info){
    stockEl.textContent = info.label;
    stockEl.style.color = info.resaw ? 'var(--gold)' : 'var(--teal)';
    if(info.resaw){
      boardsEl.textContent = `${q} pcs → ${boardsNeeded} board${boardsNeeded!==1?'s':''} needed (2 pcs per board)`;
    } else {
      boardsEl.textContent = '';
    }
  } else if(t > 0){
    stockEl.style.color = 'var(--mid)';
    stockEl.textContent = 'Thickness not in standard range — using as entered';
    boardsEl.textContent = '';
  }
}

function calcLFfromSqft(){
  document.getElementById('lf-lf').value = '';
  const w = parseFraction(document.getElementById('lf-width').value) || 0;
  const s = parseFloat(document.getElementById('lf-sqft').value) || 0;
  if(!w || !s){ calcLFTotal(); return; }
  document.getElementById('lf-lf').value = r2(s * 12 / w);
  calcLFTotal();
}

function calcSqftFromLF(){
  document.getElementById('lf-sqft').value = '';
  const w = parseFraction(document.getElementById('lf-width').value) || 0;
  const l = parseFloat(document.getElementById('lf-lf').value) || 0;
  if(!w || !l){ calcLFTotal(); return; }
  document.getElementById('lf-sqft').value = r2(l * w / 12);
  calcLFTotal();
}

function calcLF(){ calcLFfromSqft(); }

// Shared "Total (with waste)" line for the Sqft <-> LF converter — reflects
// whatever sqft/lf values are currently populated, regardless of which side
// the user typed into.
function calcLFTotal(){
  const totalEl = document.getElementById('lf-total-label');
  if(!totalEl) return;
  const wastePct = readWastePct('lf-waste10', 'lf-waste15');
  const sqft = parseFloat(document.getElementById('lf-sqft').value) || 0;
  const lf   = parseFloat(document.getElementById('lf-lf').value) || 0;
  if(!wastePct || (!sqft && !lf)){ totalEl.textContent = ''; return; }
  const mult = wasteMultFromPct(wastePct);
  const parts = [];
  if(sqft) parts.push(`${fmtN(sqft*mult,2)} sqft`);
  if(lf)   parts.push(`${fmtN(lf*mult,2)} LF`);
  totalEl.textContent = `Total (+${wastePct}%): ${parts.join(' / ')}`;
}

function calcPCfromCount(){
  document.getElementById('pc-sqft').value = '';
  const w = parseFraction(document.getElementById('pc-w').value) || 0;
  const l = parseFraction(document.getElementById('pc-l').value) || 0;
  const c = parseFloat(document.getElementById('pc-count').value) || 0;
  if(!w || !l || !c){ calcPCTotal(); return; }
  document.getElementById('pc-sqft').value = r2(c * w * l / 144);
  calcPCTotal();
}

function calcCountFromSqft(){
  document.getElementById('pc-count').value = '';
  const w = parseFraction(document.getElementById('pc-w').value) || 0;
  const l = parseFraction(document.getElementById('pc-l').value) || 0;
  const s = parseFloat(document.getElementById('pc-sqft').value) || 0;
  if(!w || !l || !s){ calcPCTotal(); return; }
  document.getElementById('pc-count').value = r2(s * 144 / (w * l));
  calcPCTotal();
}

// Shared "Total (with waste)" line for the Panel Count <-> Sqft converter.
function calcPCTotal(){
  const totalEl = document.getElementById('pc-total-label');
  if(!totalEl) return;
  const wastePct = readWastePct('pc-waste10', 'pc-waste15');
  const count = parseFloat(document.getElementById('pc-count').value) || 0;
  const sqft  = parseFloat(document.getElementById('pc-sqft').value) || 0;
  if(!wastePct || (!count && !sqft)){ totalEl.textContent = ''; return; }
  const mult = wasteMultFromPct(wastePct);
  const parts = [];
  if(count) parts.push(`${fmtN(Math.ceil(count*mult))} panels`);
  if(sqft)  parts.push(`${fmtN(sqft*mult,2)} sqft`);
  totalEl.textContent = `Total (+${wastePct}%): ${parts.join(' / ')}`;
}

function calcPC(){ calcPCfromCount(); }

// --- SLAT CALCULATOR --------------------------------------------------
function calcSlat(){
  const mode          = document.getElementById('sc-mode')?.value || 'sqft';
  const qty           = parseFloat(document.getElementById('sc-qty')?.value) || 0;
  const thick         = parseFraction(document.getElementById('sc-thick')?.value || '') || 0;
  const slatW         = parseFraction(document.getElementById('sc-slatW')?.value) || 0;
  const slatL         = parseFraction(document.getElementById('sc-slatL')?.value) || 0;
  const slatsPerPanel = parseInt(document.getElementById('sc-slatsPerPanel')?.value) || 0;
  const panelW        = parseFraction(document.getElementById('sc-panelW')?.value) || 0;
  const panelL        = parseFraction(document.getElementById('sc-panelL')?.value) || 0;
  const wastePct      = readWastePct('sc-waste10', 'sc-waste15');
  const res           = document.getElementById('sc-result');

  const labelEl = document.getElementById('sc-qty-label');
  if(labelEl) labelEl.textContent = mode==='sqft' ? 'Ceiling Sq Ft' : mode==='slats' ? 'Total Slats' : 'Number of Panels';

  if(!slatW || !slatL || !thick){ res.innerHTML = '<span style="color:var(--mid)">Enter thickness, width, and length to see results.</span>'; return; }

  // Resolve total slats
  let totalSlats = 0;
  if(mode === 'slats'){
    totalSlats = qty;
  } else if(mode === 'panels'){
    if(!slatsPerPanel){ res.innerHTML = '<span style="color:var(--mid)">Enter slats per panel.</span>'; return; }
    totalSlats = qty * slatsPerPanel;
  } else {
    if(!panelW || !panelL){ res.innerHTML = '<span style="color:var(--mid)">Enter panel width and length for sq ft mode.</span>'; return; }
    if(!slatsPerPanel){ res.innerHTML = '<span style="color:var(--mid)">Enter slats per panel.</span>'; return; }
    const panelSqft = (panelW * panelL) / 144;
    totalSlats = panelSqft > 0 ? Math.ceil(qty / panelSqft) * slatsPerPanel : 0;
  }
  if(!totalSlats){ res.innerHTML = '<span style="color:var(--mid)">Enter a quantity to see results.</span>'; return; }

  // Mill calculation — mirrors lumber tab
  const stockIn      = Calc.getMillStockLength(slatL, '');
  const stockFt      = stockIn / 12;
  const piecesPerLen = slatL >= 72 ? 1 : Math.max(1, Math.floor((stockIn - END_TRIM) / slatL));
  const safetyMult   = wasteMultFromPct(wastePct);
  const lengthNote   = piecesPerLen > 1 ? ` · ${piecesPerLen} slats/board` : '';
  const isVG         = document.getElementById('sc-vg')?.checked;

  let pcsWide, boardsNeeded, bfPerSlat, bfPerBoard, rawBFTotal;
  let roughLabel, widthWasteLabel, warningHTML = '';
  let actualPieces = 0; // set for resaw paths — pieces are full stock-length, not slatL
  let vgStockUsed = '2×6';

  if(isVG){
    // V.G. Fir / Hemlock: milled from 2×6 or 2×8 rough stock, chosen by slat width
    const picked = Calc.chooseResawStock(slatW);
    if(!picked){
      pcsWide = 0; boardsNeeded = 0; bfPerSlat = 0; bfPerBoard = 0; rawBFTotal = 0;
      roughLabel = '— (over 7.5" max)';
      widthWasteLabel = '—';
      warningHTML = `<div style="grid-column:1/-1;background:var(--warn-bg,#7c3d0020);border:1px solid var(--warn,#f59e0b);border-radius:6px;padding:6px 10px;color:var(--warn,#f59e0b);font-size:12px;font-weight:600">
        ⚠ Slat width exceeds 7.5" max for 2×6/2×8 resaw stock — call for pricing
      </div>`;
    } else {
      pcsWide      = Calc.getVGPcsPerBoard(thick, slatW, picked.width);
      const pcsPerBoard = pcsWide * piecesPerLen;
      boardsNeeded = Math.ceil(totalSlats / pcsPerBoard);
      bfPerBoard   = (2 * picked.nominalW * stockIn) / 144;
      bfPerSlat    = bfPerBoard / pcsPerBoard;
      rawBFTotal   = Math.ceil(boardsNeeded * bfPerBoard * safetyMult);
      roughLabel   = `${picked.stock} rough · ${pcsWide} pcs/board`;
      actualPieces = boardsNeeded * pcsPerBoard;
      vgStockUsed  = picked.stock.replace('x','×');
      widthWasteLabel = `— (${picked.stock} board)`;
      if(thick > 0.6875){
        const altPcs = Calc.getVGPcsPerBoard(0.6875, slatW, picked.width);
        warningHTML = `<div style="grid-column:1/-1;background:#3a1a00;border:1px solid var(--gold);border-radius:var(--r);padding:10px 14px;font-size:12px;color:var(--gold);line-height:1.5">
          ⚠ At this thickness you get <strong>${pcsWide} pcs</strong> per ${picked.stock} board.
          Consider <strong>11/16" (${altPcs} pcs/board)</strong> for better yield.
        </div>`;
      }
    }
  } else {
    // Standard path: lookup rough stock, apply widthWaste
    const stockInfo = Calc.getStockInfo(thick);
    const roughT    = stockInfo ? stockInfo.stock : Calc.getSuggestedRoughThick(thick);
    const widthWaste = Calc.getWidthWasteFactor(slatW);
    const stockLabel = stockInfo?.label || `${roughT}" rough`;
    const isResaw    = !!(stockInfo?.resaw);

    if(isResaw){
      const pcsFromThick = Math.floor((roughT + RESAW_KERF) / (thick + RESAW_KERF));
      pcsWide       = Math.max(1, pcsFromThick);
      const pcsPerBoard = pcsWide * piecesPerLen;
      boardsNeeded  = Math.ceil(totalSlats / pcsPerBoard);
      bfPerSlat     = roughT * (slatW + widthWaste) * stockIn / (144 * pcsPerBoard);
      rawBFTotal    = Math.ceil(bfPerSlat * totalSlats * safetyMult);
      roughLabel    = `${stockLabel} · ${pcsWide} pcs/board`;
      actualPieces  = boardsNeeded * pcsWide * piecesPerLen;
    } else {
      pcsWide      = null;
      boardsNeeded = Math.ceil(totalSlats / piecesPerLen);
      bfPerSlat    = roughT * (slatW + widthWaste) * stockIn / (144 * piecesPerLen);
      rawBFTotal   = Math.ceil(bfPerSlat * totalSlats * safetyMult);
      roughLabel   = stockLabel;
    }
    widthWasteLabel = `${widthWaste}"`;
  }

  res.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px">
      ${warningHTML}
      <div>
        <div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Total Slats</div>
        <div style="font-size:22px;font-weight:700;color:var(--ink)">${fmtN(totalSlats)}</div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Stock Length</div>
        <div style="font-size:22px;font-weight:700;color:var(--ink)">${stockFt}'</div>
        <div style="font-size:11px;color:var(--dim)">${stockIn}"${lengthNote}</div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Rough Stock</div>
        <div style="font-size:15px;font-weight:700;color:var(--ink);line-height:1.3">${roughLabel}</div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Boards to Buy</div>
        <div style="font-size:22px;font-weight:700;color:var(--ink)">${fmtN(boardsNeeded)}</div>
        ${isVG ? `<div style="font-size:11px;color:var(--dim)">${vgStockUsed} boards</div>` : pcsWide ? `<div style="font-size:11px;color:var(--dim)">${pcsWide} slat${pcsWide!==1?'s':''}/board (resaw)</div>` : ''}
      </div>
      <div>
        <div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Width Waste</div>
        <div style="font-size:22px;font-weight:700;color:var(--ink)">${widthWasteLabel}</div>
      </div>
      ${actualPieces && actualPieces !== totalSlats ? `<div>
        <div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Actual Delivery</div>
        <div style="font-size:22px;font-weight:700;color:var(--gold)">${fmtN(actualPieces)}</div>
        <div style="font-size:11px;color:var(--dim)">pcs @ ${stockFt}' each (resaw doesn't trim to length)</div>
      </div>` : ''}
      <div>
        <div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">BF / Slat</div>
        <div style="font-size:22px;font-weight:700;color:var(--ink)">${fmtN(bfPerSlat,3)}</div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Raw BF to Order${wastePct?' (+'+wastePct+'%)':''}</div>
        <div style="font-size:22px;font-weight:700;color:var(--teal)">${fmtN(rawBFTotal,0)} BF</div>
      </div>
    </div>
  `;
}

// --- TILE CALCULATOR ----------------------------------------------------
// No species/pricing context here, so sheet size is picked by best yield
// (fewest sheets) rather than cost, unlike chooseVeneerSheet() on the live tab.
function calcTile(){
  const mode     = document.getElementById('tc-mode')?.value || 'sqft';
  const qty      = parseFloat(document.getElementById('tc-qty')?.value) || 0;
  const tileW    = parseFraction(document.getElementById('tc-tileW')?.value) || 0;
  const tileL    = parseFraction(document.getElementById('tc-tileL')?.value) || 0;
  const nominal  = parseFloat(document.getElementById('tc-nominal')?.value) || 0;
  const wastePct = readWastePct('tc-waste10', 'tc-waste15');
  const res      = document.getElementById('tc-result');

  const labelEl = document.getElementById('tc-qty-label');
  if(labelEl) labelEl.textContent = mode==='sqft' ? 'Ceiling Sq Ft' : 'Total Tiles';

  if(!tileW || !tileL){ res.innerHTML = '<span style="color:var(--mid)">Enter tile width and length to see results.</span>'; return; }

  const sqftPerTile = (tileW * tileL) / 144;
  let totalTiles = 0;
  if(mode === 'tiles'){
    totalTiles = qty;
  } else {
    totalTiles = Math.ceil(qty / sqftPerTile);
  }
  if(!totalTiles){ res.innerHTML = '<span style="color:var(--mid)">Enter a quantity to see results.</span>'; return; }

  function yieldFor(sheetW, sheetL){
    const cols = Math.floor((sheetW - SQUARING + KERF) / (tileW + KERF));
    const rows = Math.floor((sheetL - SQUARING + KERF) / (tileL + KERF));
    return Math.max(1, cols * rows);
  }
  const fits8  = tileW <= SHEET_WIDTHS['4x8']  && tileL <= SHEET_LENGTHS['4x8'];
  const fits10 = tileW <= SHEET_WIDTHS['4x10'] && tileL <= SHEET_LENGTHS['4x10'];
  const wasteMult = wasteMultFromPct(wastePct);

  let chosen;
  if(!fits8 && !fits10){
    chosen = { size:'—', sheets:0, perSheet:0, warn:true };
  } else if(!fits8){
    const sps10 = yieldFor(SHEET_WIDTHS['4x10'], SHEET_LENGTHS['4x10']);
    chosen = { size:'4x10', sheets: Math.ceil(totalTiles / sps10 * wasteMult), perSheet: sps10, warn:false };
  } else {
    const sps8  = yieldFor(SHEET_WIDTHS['4x8'],  SHEET_LENGTHS['4x8']);
    const sps10 = yieldFor(SHEET_WIDTHS['4x10'], SHEET_LENGTHS['4x10']);
    const sheets8  = Math.ceil(totalTiles / sps8  * wasteMult);
    const sheets10 = Math.ceil(totalTiles / sps10 * wasteMult);
    chosen = sheets10 < sheets8
      ? { size:'4x10', sheets: sheets10, perSheet: sps10, warn:false }
      : { size:'4x8',  sheets: sheets8,  perSheet: sps8,  warn:false };
  }

  const nominalTotal = totalTiles * nominal;

  res.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px">
      ${chosen.warn ? `<div style="grid-column:1/-1;background:var(--warn-bg,#7c3d0020);border:1px solid var(--warn,#f59e0b);border-radius:6px;padding:6px 10px;color:var(--warn,#f59e0b);font-size:12px;font-weight:600">⚠ Tile size exceeds max sheet dimensions — call for pricing</div>` : ''}
      <div>
        <div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Total Tiles</div>
        <div style="font-size:22px;font-weight:700;color:var(--ink)">${fmtN(totalTiles)}</div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Sq Ft / Tile (net)</div>
        <div style="font-size:22px;font-weight:700;color:var(--ink)">${fmtN(sqftPerTile,2)}</div>
      </div>
      ${nominal ? `<div>
        <div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Nominal Sq Ft Total</div>
        <div style="font-size:22px;font-weight:700;color:var(--ink)">${fmtN(nominalTotal,0)}</div>
        <div style="font-size:11px;color:var(--dim)">dado/groove reference only</div>
      </div>` : ''}
      <div>
        <div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Tiles / Sheet</div>
        <div style="font-size:22px;font-weight:700;color:var(--ink)">${fmtN(chosen.perSheet)}</div>
        <div style="font-size:11px;color:var(--dim)">${chosen.size} sheet</div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Sheets Needed${wastePct?' (+'+wastePct+'%)':''}</div>
        <div style="font-size:22px;font-weight:700;color:var(--teal)">${fmtN(chosen.sheets)}</div>
      </div>
    </div>
  `;
}

// --- T&G CALCULATOR ------------------------------------------------------
// Mirrors the Lumber tab's T&G mode: face width drives coverage (LF), overall
// width drives BF/waste — same split used because a T&G board's milled face
// (the visible coverage) is narrower than its actual overall width.
function calcTG(){
  const mode     = document.getElementById('tg-mode')?.value || 'sqft';
  const qty      = parseFloat(document.getElementById('tg-qty')?.value) || 0;
  const thick    = parseFraction(document.getElementById('tg-thick')?.value || '') || 0;
  const faceW    = parseFraction(document.getElementById('tg-faceW')?.value) || 0;
  const overallW = parseFraction(document.getElementById('tg-overallW')?.value) || 0;
  const lenIn    = parseFraction(document.getElementById('tg-len')?.value) || 0;
  const wastePct = readWastePct('tg-waste10', 'tg-waste15');
  const isVG     = document.getElementById('tg-vg')?.checked;
  const res      = document.getElementById('tg-result');

  const labelEl = document.getElementById('tg-qty-label');
  if(labelEl) labelEl.textContent = mode==='sqft' ? 'Ceiling Sq Ft' : 'Total Pieces';
  const lenLabelEl = document.getElementById('tg-len-label');
  if(lenLabelEl) lenLabelEl.textContent = mode==='sqft' ? 'Finished Length (in) (optional)' : 'Finished Length (in)';

  if(!thick || !faceW || !overallW){ res.innerHTML = '<span style="color:var(--mid)">Enter thickness, face width, and overall width to see results.</span>'; return; }

  let totalLF = 0, randomLength = false;
  if(mode === 'pieces'){
    if(!qty || !lenIn){ res.innerHTML = '<span style="color:var(--mid)">Enter piece count and finished length.</span>'; return; }
    totalLF = qty * lenIn / 12;
  } else {
    if(!qty){ res.innerHTML = '<span style="color:var(--mid)">Enter a quantity to see results.</span>'; return; }
    randomLength = !lenIn;
    totalLF = qty * 12 / faceW;
  }
  if(!totalLF){ res.innerHTML = '<span style="color:var(--mid)">Enter a quantity to see results.</span>'; return; }

  const safetyMult = wasteMultFromPct(wastePct);
  let rawBFTotal, roughLabel, warningHTML = '';

  if(isVG){
    const picked = Calc.chooseResawStock(overallW);
    if(!picked){
      rawBFTotal = 0;
      roughLabel = '— (over 7.5" max)';
      warningHTML = `<div style="grid-column:1/-1;background:var(--warn-bg,#7c3d0020);border:1px solid var(--warn,#f59e0b);border-radius:6px;padding:6px 10px;color:var(--warn,#f59e0b);font-size:12px;font-weight:600">
        ⚠ Overall width exceeds 7.5" max for 2×6/2×8 resaw stock — call for pricing
      </div>`;
    } else {
      const slabs   = Math.max(1, Math.floor(TWO_X_SIX_T / (thick + RESAW_KERF)));
      const strips  = Math.max(1, Math.floor(picked.width / (overallW + RESAW_KERF)));
      const bfPerLF = (2.0 / slabs) * (picked.nominalW / strips) / 12;
      rawBFTotal    = Math.ceil(bfPerLF * totalLF * safetyMult);
      roughLabel    = `${picked.stock} rough · ${slabs*strips} pcs/board`;
      if(thick > 0.6875){
        const altSlabs = Math.max(1, Math.floor(TWO_X_SIX_T / (0.6875 + RESAW_KERF)));
        warningHTML = `<div style="grid-column:1/-1;background:#3a1a00;border:1px solid var(--gold);border-radius:var(--r);padding:10px 14px;font-size:12px;color:var(--gold);line-height:1.5">
          ⚠ At this thickness you get <strong>${slabs*strips} pcs</strong> per ${picked.stock} board.
          Consider <strong>11/16" (${altSlabs*strips} pcs/board)</strong> for better yield.
        </div>`;
      }
    }
  } else {
    const roughT      = Calc.getSuggestedRoughThick(thick);
    const widthWaste  = Calc.getWidthWasteFactor(overallW);
    const rawBFExact  = roughT * (overallW + widthWaste) * totalLF / 12;
    rawBFTotal        = Math.ceil(rawBFExact * safetyMult);
    roughLabel        = Calc.getStockInfo(thick)?.label || `${roughT}" rough`;
  }

  res.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px">
      ${warningHTML}
      ${randomLength ? `<div style="grid-column:1/-1;background:var(--surf3);border-radius:6px;padding:6px 10px;font-size:12px;color:var(--mid)">No finished length entered — assuming random lengths (LF-based estimate).</div>` : ''}
      <div>
        <div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Linear Feet Needed</div>
        <div style="font-size:22px;font-weight:700;color:var(--ink)">${fmtN(totalLF,0)} LF</div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Rough Stock</div>
        <div style="font-size:15px;font-weight:700;color:var(--ink);line-height:1.3">${roughLabel}</div>
      </div>
      <div>
        <div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Raw BF to Order${wastePct?' (+'+wastePct+'%)':''}</div>
        <div style="font-size:22px;font-weight:700;color:var(--teal)">${fmtN(rawBFTotal,0)} BF</div>
      </div>
    </div>
  `;
}

// --- BRACKET CALCULATOR -----------------------------------------------
function calcBracket(){
  const bW      = parseFraction(document.getElementById('bc-w')?.value || '') || 0;
  const bL      = parseFraction(document.getElementById('bc-l')?.value || '') || 0;
  const panels  = parseFloat(document.getElementById('bc-panels')?.value) || 0;
  const perPanel= parseFloat(document.getElementById('bc-perPanel')?.value) || 0;
  const res     = document.getElementById('bc-result');

  if(!bW || !bL){ res.innerHTML = '<span style="color:var(--mid)">Enter bracket width and length to see results.</span>'; return; }

  // Usable sheet after 1/4" squaring each edge
  // Fixed layout: width runs across the 47.5" (4') dimension, length runs down the 95.5" (8') dimension
  // Panel saw blade = 3/16" (0.1875") kerf between each piece
  const sheetW = 47.5;
  const sheetL = 95.5;
  const BLADE  = 0.1875;

  const cols = Math.floor((sheetW + BLADE) / (bW + BLADE));
  const rows = Math.floor((sheetL + BLADE) / (bL + BLADE));
  const bracketsPerSheet = cols * rows;

  if(!panels || !perPanel){
    res.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px">
        <div><div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Brackets / Sheet</div><div style="font-size:22px;font-weight:700;color:var(--ink)">${fmtN(bracketsPerSheet)}</div><div style="font-size:11px;color:var(--dim)">${cols} across × ${rows} down</div></div>
      </div>
      <div style="margin-top:8px;font-size:12px;color:var(--dim)">Enter panel count and brackets per panel for total sheets needed.</div>
    `;
    return;
  }

  const wastePct = readWastePct('bc-waste10', 'bc-waste15');
  const totalBrackets = panels * perPanel;
  const sheetsNeeded = bracketsPerSheet > 0 ? Math.ceil(totalBrackets / bracketsPerSheet) : 0;
  const totalBracketsWaste = Math.ceil(totalBrackets * wasteMultFromPct(wastePct));
  const sheetsNeededWaste = bracketsPerSheet > 0 ? Math.ceil(totalBracketsWaste / bracketsPerSheet) : 0;

  res.innerHTML = `
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px">
      <div><div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Total Brackets</div><div style="font-size:22px;font-weight:700;color:var(--ink)">${fmtN(totalBrackets)}</div><div style="font-size:11px;color:var(--dim)">${fmtN(panels)} panels × ${fmtN(perPanel)}/panel</div></div>
      <div><div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Brackets / Sheet</div><div style="font-size:22px;font-weight:700;color:var(--ink)">${fmtN(bracketsPerSheet)}</div><div style="font-size:11px;color:var(--dim)">${cols} across × ${rows} down</div></div>
      <div><div style="font-size:11px;color:var(--mid);text-transform:uppercase;letter-spacing:.05em">Sheets Needed</div><div style="font-size:22px;font-weight:700;color:var(--teal)">${fmtN(sheetsNeeded)}</div><div style="font-size:11px;color:var(--dim)">3/4" × 48" × 96" Baltic Birch</div></div>
    </div>
    ${wastePct ? `<div style="margin-top:10px;font-size:14px;font-weight:700;color:var(--teal);text-align:center">Total (+${wastePct}%): ${fmtN(totalBracketsWaste)} brackets — ${fmtN(sheetsNeededWaste)} sheets</div>` : ''}
    <div style="margin-top:8px;font-size:12px;color:var(--dim)">Width (${bW}") across 47.5" · Length (${bL}") down 95.5"</div>
  `;
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

    // Migrate old keys without core suffix (talbert_A3_4x8) → frmdf (talbert_A3_4x8_frmdf)
    ['talbert','timber'].forEach(sup => {
      ['A3','AA'].forEach(grade => {
        ['4x8','4x10'].forEach(size => {
          const oldKey = `${sup}_${grade}_${size}`;
          if(oldKey in p){
            const newKey = oldKey + '_frmdf';
            if(!(newKey in p)) p[newKey] = p[oldKey];
            delete p[oldKey];
          }
        });
      });
    });

    // Migrate talbert_eb_roll / timber_eb_roll → single eb_roll
    if(!p['eb_roll']){
      p['eb_roll'] = p['timber_eb_roll'] || p['talbert_eb_roll'] || 0;
    }
    if(p['eb_roll_satin'] === undefined) p['eb_roll_satin'] = 0;
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
  if(!pricing.standardProducts)   pricing.standardProducts = [];
  if(!pricing.productCategories)  pricing.productCategories = [];
  if(!pricing.laminationFaces)    pricing.laminationFaces = {};
  if(!pricing.laminationCores)    pricing.laminationCores = {};
  if(!pricing.veneerCores) pricing.veneerCores = deepCopy(dp.veneerCores);
  // Add any built-in cores missing from saved data
  dp.veneerCores.forEach(dc => {
    if(!pricing.veneerCores.find(c => c.key === dc.key)) pricing.veneerCores.unshift(dc);
  });
  ensureAllCoreKeys();
  migrateThicknessKeys();
  productCounter = Math.max(0, ...pricing.standardProducts.map(p => p.id || 0));
  categoryCounter = Math.max(0, ...pricing.productCategories.map(c => c.id || 0));

  localStorage.setItem('lbiq_pricing', JSON.stringify(pricing));

  // No pricing fetch here anymore — that used to run unconditionally for every visitor,
  // before any login, which meant real cost/margin data loaded into memory regardless of
  // role. Real pricing now loads only after a role is known, inside activateApp() (admin:
  // real fetchCloudPricing(); company: cost-free applyCompanyPricingOptions()). Until then,
  // `pricing` just holds the structural DEFAULT_PRICING shape merged above — enough to render
  // the lock screen, nothing sensitive.
  checkSession();
})();
