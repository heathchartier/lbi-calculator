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

  // --- LUMBER ENGINE ------------------------------------------------------
  const RESAW_KERF = 0.0625;
  const TWO_X_SIX_T = 1.5;
  const TWO_X_SIX_W = 6.0;
  const TWO_X_EIGHT_W = 8.0;
  const END_TRIM = 4.0;
  const STOCK_LENGTHS      = [96, 120, 144, 168, 192];
  const STOCK_LENGTHS_STD  = [96, 120, 144];
  const LONG_STOCK_SPECIES = new Set([
    'Stain Grade Poplar',
    'V.G. Hemlock', 'Therm VG Hemlock',
    'V.G. Fir',
    'Therm Poplar',
    'Therm Pine',
    'Grey Accoya',
  ]);
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

  function getStockInfo(t){ return STOCK_LOOKUP.find(s => t >= s.min && t <= s.max) || null; }

  function getWidthWasteFactor(finishedW){
    if(finishedW <= 1.000) return 1.000;
    if(finishedW <= 1.500) return 1.125;
    if(finishedW <= 2.375) return 1.375;
    if(finishedW <= 3.375) return 1.625;
    if(finishedW <= 4.375) return 1.750;
    if(finishedW <= 6.375) return 2.000;
    return 2.500;
  }

  function getSuggestedRoughThick(finishedT){
    const info = getStockInfo(finishedT);
    return info ? info.stock : 1.0;
  }

  // Maps a STOCK_LOOKUP stock value to its admin price field + short label.
  // 10/4, 12/4, 16/4 (stock 2.5/3.0/4.0) fall back to the 8/4 price — not stocked separately.
  function tierPriceInfo(stockVal){
    if(stockVal <= 1.0)  return { key:'price',    label:'4/4' };
    if(stockVal <= 1.25) return { key:'price5_4', label:'5/4' };
    if(stockVal <= 1.5)  return { key:'price6_4', label:'6/4' };
    return { key:'price8_4', label:'8/4' };
  }

  // Trim shares T&G's continuous-LF math (no panel/slat breakdown, no assembly/brackets) but
  // has no separate Face Width — face and overall width are the same board, so Trim only asks
  // for Overall Width and effectiveFaceWidth() below feeds that in wherever T&G would use
  // cfg.faceWidth for coverage math.
  function isTGType(cfg){ return cfg.lumberType === 'tg' || cfg.lumberType === 'trim'; }
  function effectiveFaceWidth(cfg){ return cfg.lumberType === 'trim' ? cfg.overallWidth : cfg.faceWidth; }

  function getBestStock(slatL, species){
    const lengths = LONG_STOCK_SPECIES.has(species) ? STOCK_LENGTHS : STOCK_LENGTHS_STD;
    let best = null, bestPieces = 0;
    for(const stockIn of lengths){
      const usable = stockIn - END_TRIM;
      const pieces = Math.floor(usable / slatL);
      if(pieces > bestPieces){ bestPieces=pieces; best=stockIn; }
      else if(pieces===bestPieces && pieces>0 && stockIn<best){ best=stockIn; }
    }
    return { stockIn: best||96, piecesPerBoard: Math.max(1,bestPieces) };
  }

  // Stock length for a given slat length.
  // Most species: max 12' stock. Long-stock species can use 14'/16'.
  function getMillStockLength(slatL, species){
    const isLong = LONG_STOCK_SPECIES.has(species);
    if(slatL >= 72){
      // Breakpoints sit a half inch under each stock length (e.g. 119.5" -> 10' stock) since
      // that's the standard way lengths are submitted here: entering exactly a stock length
      // (120") means zero trim margin, so it bumps to the next size up, while X.5" under is
      // the deliberate "reserve a hair for end splits" convention and fits the shorter stock.
      if(slatL <= 95.5)  return 96;   // 8'
      if(slatL <= 119.5) return 120;  // 10'
      if(slatL <= 143.5) return 144;  // 12'
      if(!isLong)         return 144;  // cap at 12' for standard species
      if(slatL <= 167.5) return 168;  // 14'
      return 192;                   // 16'
    }
    return getBestStock(slatL, species).stockIn;
  }

  // Picks 2x6 vs 2x8 rough stock by slat width. Widths above 7.5" have no valid resaw stock.
  function chooseResawStock(slatW){
    if(slatW <= 2.5)  return { stock:'2x6', width:TWO_X_SIX_W,   nominalW:6 };
    if(slatW <= 3.25) return { stock:'2x8', width:TWO_X_EIGHT_W, nominalW:8 };
    if(slatW <= 5.5)  return { stock:'2x6', width:TWO_X_SIX_W,   nominalW:6 };
    if(slatW <= 7.5)  return { stock:'2x8', width:TWO_X_EIGHT_W, nominalW:8 };
    return null;
  }

  // VG Fir/Hemlock: pieces per board — width rips × thickness slabs
  function getVGPcsPerBoard(slatT, slatW, stockWidth = TWO_X_SIX_W){
    const slabs  = Math.floor(TWO_X_SIX_T / (slatT + RESAW_KERF));
    const strips = Math.floor(stockWidth / (slatW + RESAW_KERF));
    return Math.max(1, slabs * strips);
  }

  function resolveTGQty(cfg){
    const faceWidth = effectiveFaceWidth(cfg);
    if(!faceWidth || !cfg.overallWidth) return null;
    if(cfg.calcMode === 'sqft'){
      if(!cfg.sqft) return null;
      const totalLF = cfg.sqft * 12 / faceWidth;
      return { panelQty:0, totalSlats:0, effectiveSqft: cfg.sqft, sqftPerPanel:0, randomLength: !cfg.slatL, totalLF };
    } else {
      if(!cfg.manualQty || !cfg.slatL) return null;
      const totalLF = cfg.manualQty * cfg.slatL / 12;
      const effectiveSqft = totalLF * faceWidth / 12;
      return { panelQty:0, totalSlats:cfg.manualQty, effectiveSqft, sqftPerPanel:0, randomLength:false, totalLF };
    }
  }

  function resolveLumberQty(cfg){
    if(isTGType(cfg)) return resolveTGQty(cfg);
    if(!cfg.panelW || !cfg.panelL || !cfg.slatW || !cfg.slatsPerPanel) return null;
    const sqftPerPanel = (cfg.panelW * cfg.panelL) / 144;
    if(cfg.calcMode === 'sqft'){
      if(!cfg.sqft) return null;
      const panelQty   = Math.ceil(cfg.sqft / sqftPerPanel);
      const totalSlats = panelQty * cfg.slatsPerPanel;
      const randomLength = !cfg.slatL;
      const totalLF = randomLength ? (cfg.sqft * 12 / cfg.slatW) : (totalSlats * cfg.slatL / 12);
      return { panelQty, totalSlats, effectiveSqft: cfg.sqft, sqftPerPanel, randomLength, totalLF };
    } else if(cfg.calcMode === 'slats'){
      if(!cfg.manualQty || !cfg.slatL) return null;
      const totalSlats = cfg.manualQty;
      const panelQty   = Math.ceil(totalSlats / cfg.slatsPerPanel);
      const totalLF = totalSlats * cfg.slatL / 12;
      return { panelQty, totalSlats, effectiveSqft: panelQty * sqftPerPanel, sqftPerPanel, randomLength:false, totalLF };
    } else {
      if(!cfg.manualQty || !cfg.slatL) return null;
      const panelQty   = cfg.manualQty;
      const totalSlats = panelQty * cfg.slatsPerPanel;
      const totalLF = totalSlats * cfg.slatL / 12;
      return { panelQty, totalSlats, effectiveSqft: panelQty * sqftPerPanel, sqftPerPanel, randomLength:false, totalLF };
    }
  }

  // Used only when no finished length is given at all (sqft mode, "random length" assumption —
  // works for both Grille and T&G). Computes BF straight from linear footage instead of the
  // discrete board-count model, since there's no real piece length to count boards against.
  function calcContinuousBF(cfg, totalLF, width, isTG, randomLength){
    const sData = pricing.lumberSpecies[cfg.species] || {};
    const isVGResaw = !!sData.resaw;
    const safetyMult = wasteMultFromPct(cfg.safetyBuffer);

    if(isVGResaw){
      const picked = chooseResawStock(width);
      if(!picked){
        return {
          isVGResaw, vgWarning:false, noStock:true, stockUsed:null, isTG:!!isTG, isContinuous:true,
          stockIn:null, stockFt:null, piecesPerLen:null,
          roughT:2.0, widthWaste:null, pcsWide:0,
          bfPerSlat:null, rawBFTotal:0, defectPct:0,
          safetyBuffer: cfg.safetyBuffer, stockLabel:null, isThickResaw:false,
          totalLF, randomLength: !!randomLength,
        };
      }
      const slabs   = Math.max(1, Math.floor(TWO_X_SIX_T / (cfg.thickness + RESAW_KERF)));
      const strips  = Math.max(1, Math.floor(picked.width / (width + RESAW_KERF)));
      const vgAltPcs = Math.max(1, Math.floor(TWO_X_SIX_T / (0.6875 + RESAW_KERF))) * strips;
      const vgWarning = cfg.thickness > 0.6875;
      const bfPerLF = (2.0 / slabs) * (picked.nominalW / strips) / 12;
      const rawBFTotal = Math.ceil(bfPerLF * totalLF * safetyMult);
      return {
        isVGResaw, vgWarning, vgAltPcs, noStock:false, stockUsed:picked.stock, isTG:!!isTG, isContinuous:true,
        stockIn:null, stockFt:null, piecesPerLen:null,
        roughT: 2.0/slabs, widthWaste:null, pcsWide: slabs*strips,
        bfPerSlat:null, rawBFTotal, defectPct:0,
        safetyBuffer: cfg.safetyBuffer, stockLabel:null, isThickResaw:false,
        totalLF, randomLength: !!randomLength,
      };
    }

    const roughT = getSuggestedRoughThick(cfg.thickness);
    const widthWaste = getWidthWasteFactor(width);
    const rawBFExact = roughT * (width + widthWaste) * totalLF / 12;
    const rawBFTotal = Math.ceil(rawBFExact * safetyMult);
    return {
      isVGResaw:false, vgWarning:false, isTG:!!isTG, isContinuous:true, noStock:false,
      stockIn:null, stockFt:null, piecesPerLen:null,
      roughT, widthWaste, pcsWide:null,
      bfPerSlat:null, rawBFTotal, defectPct: pricing.services.lumberDefectPct || 0,
      safetyBuffer: cfg.safetyBuffer,
      stockLabel: getStockInfo(cfg.thickness)?.label || null,
      isThickResaw:false, totalLF, randomLength: !!randomLength,
    };
  }

  function millLumberCalc(cfg, qty){
    const isTG = isTGType(cfg);
    const width = isTG ? cfg.overallWidth : cfg.slatW;

    if(qty.randomLength) return calcContinuousBF(cfg, qty.totalLF, width, isTG, true);

    const totalSlats = isTG ? Math.ceil(qty.totalLF * 12 / cfg.slatL) : qty.totalSlats;
    const sData    = pricing.lumberSpecies[cfg.species] || {};
    const isVGResaw = !!(sData.resaw);
    const defectPct = pricing.services.lumberDefectPct || 0;

    const stockIn = getMillStockLength(cfg.slatL, cfg.species);
    const stockFt = stockIn / 12;

    let piecesPerLen;
    if(cfg.slatL >= 72){
      piecesPerLen = 1;
    } else {
      const usable = stockIn - END_TRIM;
      piecesPerLen = Math.max(1, Math.floor(usable / cfg.slatL));
    }

    let roughT, widthWaste, pcsWide, bfPerSlat, vgWarning = false;

    if(isVGResaw){
      const picked = chooseResawStock(width);
      if(!picked){
        return {
          isVGResaw, vgWarning:false, noStock:true, stockUsed:null, isTG,
          stockIn, stockFt, piecesPerLen,
          roughT:2.0, widthWaste:null, pcsWide:0,
          boardsNeeded:0, bfPerBoard:0, pcsPerBoard:0, actualPieces:0, actualLF:0,
          bfPerSlat:0, rawBFTotal:0, defectPct:0, totalSlatsUsed: totalSlats,
        };
      }
      roughT     = 2.0;
      widthWaste = null;
      pcsWide    = getVGPcsPerBoard(cfg.thickness, width, picked.width);
      const vgAltPcs = getVGPcsPerBoard(0.6875, width, picked.width);
      if(cfg.thickness > 0.6875) vgWarning = true;

      const pcsPerBoard  = pcsWide * piecesPerLen;
      const boardsNeeded = Math.ceil(totalSlats / pcsPerBoard);
      const bfPerBoard   = (2 * picked.nominalW * stockIn) / 144;
      bfPerSlat = bfPerBoard / pcsPerBoard;
      const rawBFResaw = boardsNeeded * bfPerBoard;
      const safetyMult = wasteMultFromPct(cfg.safetyBuffer);
      const actualPieces = boardsNeeded * pcsPerBoard;
      const actualLF = actualPieces * stockFt;
      return {
        isVGResaw, vgWarning, vgAltPcs, noStock:false, stockUsed:picked.stock, isTG,
        stockIn, stockFt, piecesPerLen,
        roughT, widthWaste, pcsWide,
        boardsNeeded, bfPerBoard, pcsPerBoard, actualPieces, actualLF,
        bfPerSlat, rawBFTotal: Math.ceil(rawBFResaw * safetyMult), defectPct:0, totalSlatsUsed: totalSlats,
      };

    } else {
      const stockInfo = getStockInfo(cfg.thickness);
      roughT     = stockInfo ? stockInfo.stock : getSuggestedRoughThick(cfg.thickness);
      widthWaste = getWidthWasteFactor(width);

      if(stockInfo?.resaw){
        const pcsFromThick = Math.floor((roughT + RESAW_KERF) / (cfg.thickness + RESAW_KERF));
        pcsWide  = Math.max(1, pcsFromThick);
        const pcsPerBoard = pcsWide * piecesPerLen;
        const boardsNeeded = Math.ceil(totalSlats / pcsPerBoard);
        bfPerSlat = roughT * (width + widthWaste) * stockIn / (144 * pcsPerBoard);
        const rawBFExact = bfPerSlat * totalSlats;
        const safetyMult = wasteMultFromPct(cfg.safetyBuffer);
        const rawBFTotal = Math.ceil(rawBFExact * safetyMult);
        const actualLF = boardsNeeded * pcsWide * stockFt;
        return {
          isVGResaw, vgWarning, isTG,
          stockIn, stockFt, piecesPerLen,
          roughT, widthWaste, pcsWide,
          boardsNeeded, pcsPerBoard, actualPieces: boardsNeeded * pcsPerBoard, actualLF,
          bfPerSlat, rawBFTotal, defectPct,
          safetyBuffer: cfg.safetyBuffer,
          stockLabel: stockInfo?.label || null,
          isThickResaw: true, totalSlatsUsed: totalSlats,
        };
      } else {
        pcsWide    = null;
        bfPerSlat = roughT * (width + widthWaste) * stockIn / (144 * piecesPerLen);
      }

      const rawBFExact = bfPerSlat * totalSlats;
      const safetyMult = wasteMultFromPct(cfg.safetyBuffer);
      const rawBFTotal = Math.ceil(rawBFExact * safetyMult);
      const actualLF = totalSlats * stockFt / piecesPerLen;
      return {
        isVGResaw, vgWarning, isTG,
        stockIn, stockFt, piecesPerLen,
        roughT, widthWaste, pcsWide, actualLF,
        bfPerSlat, rawBFTotal, defectPct,
        safetyBuffer: cfg.safetyBuffer,
        stockLabel: stockInfo?.label || null,
        isThickResaw: false, totalSlatsUsed: totalSlats,
      };
    }
  }

  function calcLumberCost(cfg){
    if(!cfg.species) return null;
    if(isTGType(cfg)){
      if(!effectiveFaceWidth(cfg) || !cfg.overallWidth) return null;
    } else if(!cfg.slatW || !cfg.panelW || !cfg.panelL){
      return null;
    }
    const sData = pricing.lumberSpecies[cfg.species] || {};
    const isCustom = cfg.species === 'Custom';

    const qty = resolveLumberQty(cfg);
    if(!qty) return null;
    const { panelQty, totalSlats, effectiveSqft } = qty;

    const m = millLumberCalc(cfg, qty);
    const { rawBFTotal } = m;

    const tier = m.isVGResaw ? null : tierPriceInfo(m.roughT);
    const bfPrice = isCustom
      ? (cfg.customPricePerBF || 0)
      : m.isVGResaw
        ? (m.stockUsed === '2x8' ? (sData.price2x8 || 0) : (sData.price2x6 || 0))
        : (sData[tier.key] || 0);

    const lumberCost = rawBFTotal * bfPrice;
    const assemblyCost = (cfg.assembly && !isTGType(cfg)) ? effectiveSqft * pricing.services.assembly : 0;
    const bracketCost  = (panelQty * cfg.bracketsPerPanel) * pricing.services.bracketPrice;

    const lumberLine = withMarkup(lumberCost,   'lumber');
    const asmLine    = withMarkup(assemblyCost,  'assembly');
    const bktLine    = withMarkup(bracketCost,   'brackets');

    const subtotal = lumberLine + asmLine + bktLine;
    const lf = m.actualLF || qty.totalLF;

    const missingPrice = !isCustom && !m.noStock && !bfPrice;
    const tierTag = m.isVGResaw ? m.stockUsed : (tier ? tier.label : null);
    const lumberLabel = m.noStock
      ? `Raw Lumber — width exceeds 7.5" max ⚠ Call for pricing`
      : `Raw Lumber (${fmtN(rawBFTotal,0)} BF${tierTag ? ' · '+tierTag : ''})` + (missingPrice ? ' ⚠ Call for pricing' : '');

    return {
      species:cfg.species, isVGResaw:m.isVGResaw, rawBFTotal,
      panelQty, totalSlats, effectiveSqft, lf,
      lines:{
        [lumberLabel]: lumberLine,
        ...(cfg.assembly ? {'Assembly / Packing': asmLine} : {}),
        [`Black Brackets (${fmtN(panelQty*cfg.bracketsPerPanel)})`]: bktLine,
      },
      subtotal,
      sqftCost: effectiveSqft > 0 ? subtotal / effectiveSqft : null,
    };
  }

  // --- JOB-LEVEL MILL SERVICES ---------------------------------------------
  // Totals all lumber configs together — called once per renderResults.
  function calcJobServices(lumberConfigs){
    const svc = pricing.services;
    let totalLF = 0, standardLF = 0, resawLF = 0, sandingLF = 0, cutLF = 0;

    lumberConfigs.forEach(cfg => {
      const qty = resolveLumberQty(cfg);
      if(!qty) return;
      const m = millLumberCalc(cfg, qty);
      const lf = m.actualLF || qty.totalLF;
      totalLF += lf;
      const sDataJ = pricing.lumberSpecies[cfg.species] || {};
      const isResawCfg = !isTGType(cfg) && (sDataJ.resaw || !!(getStockInfo(cfg.thickness)?.resaw));
      if(isResawCfg) resawLF += lf; else standardLF += lf;
      if(cfg.sanding)     sandingLF += lf;
      if(cfg.cutToLength) cutLF     += lf;
    });

    const millingBase = standardLF > 0
      ? (standardLF <= svc.millingThreshold ? svc.millingFlat : standardLF * svc.millingPerLF)
      : 0;

    const resawMillingCost = resawLF > 0
      ? (resawLF <= svc.resawThreshold ? svc.resawFlat : resawLF * svc.resawPerLF)
      : 0;

    const setupKeys = new Set(
      lumberConfigs
        .filter(c => {
          const w = isTGType(c) ? c.overallWidth : c.slatW;
          return resolveLumberQty(c) && +c.thickness > 0 && +w > 0;
        })
        .map(c => `${(+c.thickness).toFixed(4)}_${(+(isTGType(c)?c.overallWidth:c.slatW)).toFixed(4)}`)
    );
    const seriesChangeCost = Math.max(0, setupKeys.size - 1) * svc.seriesChange;

    const millingTotal = millingBase + resawMillingCost + seriesChangeCost;

    const sandingCost = sandingLF <= 0 ? 0
      : (sandingLF <= svc.sandingThreshold ? svc.sandingFlat : sandingLF * svc.sandingPerLF);

    const cutCost = cutLF <= 0 ? 0
      : (cutLF <= svc.cutThreshold ? svc.cutFlat : cutLF * svc.cutPerLF);

    return { totalLF, standardLF, resawLF, sandingLF, cutLF, millingBase, resawMillingCost, seriesChangeCost, millingTotal, sandingCost, cutCost };
  }

  return {
    withMarkup, coreToKey, thickToKey,
    resolveVeneerQty, chooseVeneerSheet, packVeneerSheets,
    veneerPoolKey, computeVeneerPools, calcVeneerCost,
    getStockInfo, getWidthWasteFactor, getSuggestedRoughThick, tierPriceInfo,
    isTGType, effectiveFaceWidth, getBestStock, getMillStockLength,
    chooseResawStock, getVGPcsPerBoard, resolveTGQty, resolveLumberQty,
    calcContinuousBF, millLumberCalc, calcLumberCost, calcJobServices,
  };
}

if(typeof module !== 'undefined' && module.exports){ module.exports = { createCalcEngine }; }
if(typeof self !== 'undefined'){ self.createCalcEngine = createCalcEngine; }
