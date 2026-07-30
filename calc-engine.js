// --- SHARED CALC ENGINE -------------------------------------------------
// Pure pricing/quantity math, no DOM. Loaded by the browser (calc-engine.js, plain
// script) for admin mode, and will also be the source the Worker runs for the
// company role once that endpoint exists — so nothing in here may read `document`,
// `window`, or any config-list global; everything it needs comes in as an argument.
//
// createCalcEngine(pricing) closes over one pricing object and returns bound
// functions. In the browser, `pricing` is the same object app.js mutates in place
// (Object.assign, never reassigned) so this stays in sync automatically. On the
// Worker side, each request will create its own engine from its own fetched
// pricing snapshot.
//
// This is currently the VENEER engine only — lumber and lamination are still
// defined directly in app.js and will move here in later passes.

function createCalcEngine(pricing){

  function fmtN(n, dec=0){ return n == null ? '—' : Number(n).toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec}); }

  function withMarkup(cost, cat){ const m = pricing.markup[cat]||0; return m>=100 ? cost : cost/(1-m/100); }

  function wasteMultFromPct(pct){ return pct > 0 ? 1 + pct / 100 : 1; }

  const THICK_KEY_MAP = { '1/4"':'025','1/2"':'050','3/4"':'075','1"':'100' };
  function thickToKey(t){ return THICK_KEY_MAP[t] || '075'; }

  const CORE_KEY_FALLBACK = { 'Regular MDF':'mdf', 'Fire Rated MDF':'frmdf', 'Particle Board':'pb', 'Fire Rated PB':'frpb' };
  function coreToKey(core){
    const found = (pricing?.veneerCores||[]).find(c => c.label === core);
    if(found) return found.key;
    return CORE_KEY_FALLBACK[core] || 'frmdf';
  }

  const SQUARING = 0.25;
  const KERF = 0.1875;
  const SHEET_WIDTHS  = { '4x8': 49, '4x10': 49, '5x10': 61, '5x12': 61 };
  const SHEET_LENGTHS = { '4x8': 97, '4x10': 121, '5x10': 121, '5x12': 145 };
  const EB_ROLL_FEET   = 500;
  const EB_WASTE_FACTOR = 1.1;

  // --- VENEER QUANTITY HELPERS ------------------------------------------
  function resolveVeneerQty(cfg){
    if(!cfg.panelW || !cfg.panelL || !cfg.slatW || !cfg.slatL || !cfg.slatsPerPanel) return null;
    const sqftPerPanel = (cfg.panelW * cfg.panelL) / 144;
    if(cfg.calcMode === 'sqft'){
      if(!cfg.sqft) return null;
      const panelQty   = Math.ceil(cfg.sqft / sqftPerPanel);
      const totalSlats = panelQty * cfg.slatsPerPanel;
      return { panelQty, totalSlats, effectiveSqft: cfg.sqft, sqftPerPanel };
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

  // Returns { size, slatsPerSheet, sheetPrice } — picks 4x8 vs 4x10 by cost-per-slat
  // (or by yield if prices are 0). Tries both normal and rotated orientation.
  function chooseVeneerSheet(slatW, slatL, price4x8, price4x10){
    function yieldFor(sheetW, sheetL){
      const cols = Math.floor((sheetW - SQUARING + KERF) / (slatW + KERF));
      const rows = Math.floor((sheetL - SQUARING + KERF) / (slatL + KERF));
      return Math.max(1, cols * rows);
    }
    const sw8 = SHEET_WIDTHS['4x8'], sl8 = SHEET_LENGTHS['4x8'];
    const sw10 = SHEET_WIDTHS['4x10'], sl10 = SHEET_LENGTHS['4x10'];
    const sps8  = yieldFor(sw8,  sl8);
    const sps10 = yieldFor(sw10, sl10);
    const fits8  = slatW <= sw8  && slatL <= sl8;
    const fits10 = slatW <= sw10 && slatL <= sl10;
    if(!fits8 && !fits10) return { size: '4x8',  slatsPerSheet: 1,    sheetPrice: price4x8  || 0 };
    if(!fits8)            return { size: '4x10', slatsPerSheet: sps10, sheetPrice: price4x10 || 0 };
    if(!fits10)           return { size: '4x8',  slatsPerSheet: sps8,  sheetPrice: price4x8  || 0 };
    if(price4x8 && price4x10){
      return (price4x10 / sps10) < (price4x8 / sps8)
        ? { size: '4x10', slatsPerSheet: sps10, sheetPrice: price4x10 }
        : { size: '4x8',  slatsPerSheet: sps8,  sheetPrice: price4x8  };
    }
    if(price4x10 && !price4x8) return { size: '4x10', slatsPerSheet: sps10, sheetPrice: price4x10 };
    if(price4x8  && !price4x10) return { size: '4x8',  slatsPerSheet: sps8,  sheetPrice: price4x8  };
    return { size: '4x8', slatsPerSheet: sps8, sheetPrice: 0 };
  }

  // Nests multiple different slat sizes onto as few sheets as possible, mixing 4x8/4x10 when
  // cheaper. No rotation — veneer grain direction has to stay fixed, so pieces are only ever
  // placed the way they're specified (w along sheet width, l along sheet length).
  // Uses a shelf/best-fit-decreasing-height heuristic: not provably optimal, but a real nesting
  // pass instead of rounding each size up to its own whole sheet independently.
  function packVeneerSheets(pieces, sheetOptions){
    const usable = sheetOptions
      .map(s => ({ ...s, uw: s.w - SQUARING, ul: s.l - SQUARING }))
      .filter(s => s.price > 0 && s.uw > 0 && s.ul > 0);
    if(!usable.length){
      const unfitCount = pieces.reduce((s,p) => s + (p.qty||0), 0);
      return { sheets: [], totalCost: 0, totalSheets: 0, unfitCount };
    }

    const instances = [];
    pieces.forEach(p => {
      if(!p.w || !p.l || !p.qty) return;
      for(let i=0;i<p.qty;i++) instances.push({ w:p.w, l:p.l });
    });
    instances.sort((a,b) => (b.l - a.l) || (b.w - a.w));

    const openSheets = []; // { key, price, uw, ul, usedLength, shelves:[{height, usedWidth}] }
    let unfitCount = 0;

    function tryPlaceOnExistingShelf(piece){
      let best = null;
      openSheets.forEach(sheet => {
        sheet.shelves.forEach(shelf => {
          const remainingW = sheet.uw - shelf.usedWidth;
          if(remainingW >= piece.w && shelf.height >= piece.l){
            const waste = remainingW - piece.w;
            if(!best || waste < best.waste) best = { shelf, waste };
          }
        });
      });
      return best;
    }
    function tryNewShelfOnOpenSheet(piece){
      let best = null;
      openSheets.forEach(sheet => {
        const remainingL = sheet.ul - sheet.usedLength;
        if(remainingL >= piece.l && sheet.uw >= piece.w){
          const waste = remainingL - piece.l;
          if(!best || waste < best.waste) best = { sheet, waste };
        }
      });
      return best;
    }
    function openNewSheet(piece){
      const fits = usable.filter(s => s.uw >= piece.w && s.ul >= piece.l);
      if(!fits.length) return null;
      fits.sort((a,b) => a.price - b.price);
      const chosen = fits[0];
      const sheet = { key: chosen.key, price: chosen.price, uw: chosen.uw, ul: chosen.ul, usedLength: 0, shelves: [] };
      openSheets.push(sheet);
      return sheet;
    }

    instances.forEach(piece => {
      const onShelf = tryPlaceOnExistingShelf(piece);
      if(onShelf){ onShelf.shelf.usedWidth += piece.w + KERF; return; }
      const newShelf = tryNewShelfOnOpenSheet(piece);
      if(newShelf){
        newShelf.sheet.shelves.push({ height: piece.l, usedWidth: piece.w + KERF });
        newShelf.sheet.usedLength += piece.l + KERF;
        return;
      }
      const sheet = openNewSheet(piece);
      if(!sheet){ unfitCount++; return; }
      sheet.shelves.push({ height: piece.l, usedWidth: piece.w + KERF });
      sheet.usedLength += piece.l + KERF;
    });

    const counts = {};
    openSheets.forEach(s => { counts[s.key] = (counts[s.key]||0) + 1; });
    const sheets = Object.entries(counts).map(([key,count]) => ({ key, count, price: usable.find(u=>u.key===key).price }));
    const totalCost = sheets.reduce((sum,s) => sum + s.count*s.price, 0);
    return { sheets, totalCost, totalSheets: openSheets.length, unfitCount };
  }

  // Groups veneer configs that can share a cut list: same species, grade, core, thickness,
  // finish, and orientation (grain direction can't be mixed). Custom species only pool
  // together when they also share the same entered sheet price.
  function veneerPoolKey(cfg){
    const sup = cfg.grade || 'talbert';
    const gr  = cfg.orientation === 'Vertical' ? 'AA' : 'A3';
    const ck  = coreToKey(cfg.core || 'Fire Rated MDF');
    const tk  = thickToKey(cfg.thickness || '3/4"');
    const fin = cfg.satinFinish ? '_satin' : '';
    let key = `${cfg.species}|${sup}|${gr}|${ck}|${tk}${fin}|${cfg.orientation}`;
    if(cfg.species === 'Custom') key += `|${cfg.customPricePerPanel||0}`;
    return key;
  }

  function computeVeneerPools(veneerConfigs){
    const pools = {};
    veneerConfigs.forEach((cfg, idx) => {
      if(!cfg.species || !cfg.slatW || !cfg.slatL || !cfg.panelW || !cfg.panelL) return;
      if(!pricing.veneerSpecies[cfg.species]) return;
      const qty = resolveVeneerQty(cfg);
      if(!qty) return;
      const key = veneerPoolKey(cfg);
      if(!pools[key]) pools[key] = { members: [] };
      const wasteMult = wasteMultFromPct(cfg.wasteOn);
      const pieceQty = Math.ceil(qty.totalSlats * wasteMult);
      pools[key].members.push({ idx, cfg, totalSlats: qty.totalSlats, pieceQty });
    });

    Object.values(pools).forEach(pool => {
      const first = pool.members[0].cfg;
      const isCustom = first.species === 'Custom';
      let p8, p10;
      if(isCustom){
        p8 = p10 = first.customPricePerPanel || 0;
      } else {
        const sData = pricing.veneerSpecies[first.species];
        const sup = first.grade || 'talbert';
        const gr  = first.orientation === 'Vertical' ? 'AA' : 'A3';
        const ck  = coreToKey(first.core || 'Fire Rated MDF');
        const tk  = thickToKey(first.thickness || '3/4"');
        const fin = first.satinFinish ? '_satin' : '';
        p8  = sData[`${sup}_${gr}_4x8_${ck}_${tk}${fin}`]  || 0;
        p10 = sData[`${sup}_${gr}_4x10_${ck}_${tk}${fin}`] || 0;
      }
      const sheetOptions = [
        { key:'4x8',  w:SHEET_WIDTHS['4x8'],  l:SHEET_LENGTHS['4x8'],  price:p8  },
        { key:'4x10', w:SHEET_WIDTHS['4x10'], l:SHEET_LENGTHS['4x10'], price:p10 },
      ];
      const pieces = pool.members.map(m => ({ w:m.cfg.slatW, l:m.cfg.slatL, qty:m.pieceQty }));
      pool.pack = packVeneerSheets(pieces, sheetOptions);
      pool.repIdx = pool.members[0].idx;
      pool.noPricing = !sheetOptions.some(s => s.price > 0);
    });

    return pools;
  }

  function calcVeneerCost(cfg, cutCostOverride, poolInfo, dadoCostOverride){
    if(!cfg.species || !cfg.slatW || !cfg.panelW || !cfg.panelL) return null;
    const sData = pricing.veneerSpecies[cfg.species];
    if(!sData) return null;

    const qty = resolveVeneerQty(cfg);
    if(!qty) return null;
    const { panelQty, totalSlats, effectiveSqft } = qty;

    const sup   = cfg.grade || 'talbert';
    const grade = cfg.orientation === 'Vertical' ? 'AA' : 'A3';
    const coreK  = coreToKey(cfg.core || 'Fire Rated MDF');
    const thickK = thickToKey(cfg.thickness || '3/4"');
    const finishSuffix = cfg.satinFinish ? '_satin' : '';

    // Sheet material cost comes from the pooled cut list (shared across every config with the
    // same species/grade/core/thickness/finish/orientation) rather than being rounded up per
    // config on its own — see computeVeneerPools()/packVeneerSheets().
    let sheetCost, sheetLineLabel, sheetsNeeded = 0;
    if(poolInfo){
      if(poolInfo.isRep){
        const pk = poolInfo.pack;
        const sizesDesc = pk.sheets.map(s => `${s.count} × ${grade} ${s.key}`).join(' + ') || 'no sheet fits';
        sheetCost = pk.totalCost;
        sheetsNeeded = pk.totalSheets;
        const warn = (poolInfo.noPricing || pk.unfitCount > 0) ? ' ⚠ Call for pricing' : '';
        sheetLineLabel = (poolInfo.memberCount > 1
          ? `Sheet Material — pooled across ${poolInfo.memberCount} configs (${sizesDesc})`
          : `Sheet Material (${sizesDesc})`) + warn;
      } else {
        sheetCost = 0;
        sheetLineLabel = `Sheet Material — pooled with Panel Config ${poolInfo.repLabel}`;
      }
    } else {
      // Fallback (shouldn't normally happen — renderResults always supplies poolInfo)
      const p8  = sData[`${sup}_${grade}_4x8_${coreK}_${thickK}${finishSuffix}`]  || 0;
      const p10 = sData[`${sup}_${grade}_4x10_${coreK}_${thickK}${finishSuffix}`] || 0;
      const opt = chooseVeneerSheet(cfg.slatW, cfg.slatL, p8, p10);
      const wasteMult = wasteMultFromPct(cfg.wasteOn);
      sheetsNeeded = Math.ceil(totalSlats / opt.slatsPerSheet * wasteMult);
      sheetCost = cfg.species === 'Custom' && cfg.customPricePerPanel
        ? sheetsNeeded * cfg.customPricePerPanel
        : sheetsNeeded * opt.sheetPrice;
      sheetLineLabel = `Sheet Material (${fmtN(sheetsNeeded)} x ${opt.size})` + (opt.sheetPrice ? '' : ' ⚠ Call for pricing');
    }

    const longSides  = (cfg.ebSides===4||cfg.ebSides===2)?2:(cfg.ebSides===3||cfg.ebSides===1)?1:0;
    const shortSides = (cfg.ebSides===4||cfg.ebSides===3)?2:0;
    const ebLong  = (cfg.slatL/12) * totalSlats * longSides;
    const ebShort = (cfg.slatW/12) * totalSlats * shortSides;
    const ebFt    = ebLong + ebShort;
    const ebRolls     = Math.ceil(ebFt * EB_WASTE_FACTOR / EB_ROLL_FEET);
    const isCustom    = cfg.species === 'Custom';
    const ebRollPrice = isCustom
      ? (cfg.customEBRollPrice || 0)
      : (cfg.satinFinish ? (sData['eb_roll_satin'] || sData['eb_roll'] || 0) : (sData['eb_roll'] || 0));
    const ebMaterialCost = ebRolls * ebRollPrice;
    const ebServiceCost  = ebFt * pricing.services.ebServicePerFt;

    const isTile = cfg.ceilingType === 'tile';
    const dadoSqft = isTile ? panelQty * (cfg.nominalSqFt || 0) : effectiveSqft;

    const cutCost = cutCostOverride !== undefined ? cutCostOverride : effectiveSqft * pricing.services.cutServicePerSqft;
    let assemblyCost = 0;
    if(cfg.assembly){
      if(isTile){
        assemblyCost = dadoCostOverride !== undefined ? dadoCostOverride : dadoSqft * pricing.services.dadoServicePerSqft;
      } else {
        assemblyCost = dadoSqft * pricing.services.assembly;
      }
    }
    const bracketCount = panelQty * cfg.bracketsPerPanel;
    const bracketCost  = bracketCount * pricing.services.bracketPrice;

    // Custom: user enters sell price directly — skip markup on materials only
    const panelLine = isCustom ? sheetCost      : withMarkup(sheetCost,      'panels');
    const ebMatLine = isCustom ? ebMaterialCost : withMarkup(ebMaterialCost, 'edgeBand');
    const ebSvcLine = withMarkup(ebServiceCost,  'ebService');
    const cutLine   = withMarkup(cutCost,        'cutService');
    const asmLine   = withMarkup(assemblyCost,   isTile ? 'dado' : 'assembly');
    const bktLine   = withMarkup(bracketCost,    'brackets');

    const subtotal = panelLine+ebMatLine+ebSvcLine+cutLine+asmLine+bktLine;
    return {
      species:cfg.species, orientation:cfg.orientation, grade, supplier:sup, cfgGrade:sup,
      sqftPerPanel:qty.sqftPerPanel, panelQty, totalSlats, sheetsNeeded,
      ebFt, ebRolls, ebRollPrice, bracketCount, effectiveSqft,
      lines:{
        [sheetLineLabel]: panelLine,
        ['Edge Band Material ('+fmtN(ebRolls)+' rolls)']: ebMatLine,
        ['Edge Band Service ('+fmtN(ebFt,0)+' ft)']: ebSvcLine,
        [cutCostOverride !== undefined ? 'Cut Service (flat)' : 'Cut Service']: cutLine,
        ...(cfg.assembly ? {[isTile ? (dadoCostOverride !== undefined ? 'Dado / Groove (flat)' : 'Dado / Groove') : 'Assembly / Packing']: asmLine} : {}),
        ...(isTile ? {} : {['Black Brackets ('+fmtN(bracketCount)+')']: bktLine}),
      },
      subtotal,
      sqftCost: effectiveSqft > 0 ? subtotal / effectiveSqft : null,
    };
  }

  return {
    withMarkup, coreToKey, thickToKey,
    resolveVeneerQty, chooseVeneerSheet, packVeneerSheets,
    veneerPoolKey, computeVeneerPools, calcVeneerCost,
  };
}

if(typeof module !== 'undefined' && module.exports){ module.exports = { createCalcEngine }; }
if(typeof self !== 'undefined'){ self.createCalcEngine = createCalcEngine; }
