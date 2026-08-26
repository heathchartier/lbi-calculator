// Extracts {code, price} pairs from a Royal Plywood-format quote/price-list PDF, for the
// Stock Items "Update Costs from PDF" feature. ES module (pdf.js 4.x only ships as ES
// modules) loaded on demand via a dynamic import() from app.js's handlePdfPriceUpload(),
// not a static <script type="module"> tag — this and its ~360KB pdf.js dependency would
// otherwise download on every single page load for every rep, for a feature only the admin
// ever uses. The 1MB pdf.worker.min.mjs is unaffected either way since pdf.js only fetches
// its worker lazily, on the first actual getDocument() call.
//
// Parses the table by each text item's actual position on the page rather than reading
// order, which the raw PDF text stream does NOT reliably follow — verified against a real
// 200-line, 9-page quote (2026-08-26): reading order interleaves a row's Description text
// with the NEXT row's Product Code in some cases, and long product codes sometimes wrap to
// a second line within their table cell, splitting one code across two text items with the
// Description of a DIFFERENT row's continuation in between. Column membership is decided by
// order within a row (Line, then Code) rather than a fixed x-position range for the code
// column specifically — an earlier version using x-ranges broke on two real, not
// hypothetical, cases: sub-point floating-point misalignment between a header label's x and
// its column's data x, and Description text starting a few points left of its own header
// label, letting stray tokens leak into what should have been a clean code string.
//
// Verified end to end against the real 200-line file before this was wired into the app:
// zero missing codes, zero missing prices, and the sum of all 200 extracted prices matched
// the PDF's own stated $17,169.05 total to the penny (every line in that file was qty 1, so
// price-summing double-checks both completeness and per-item correctness at once).
import * as pdfjsLib from './vendor/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = './vendor/pdf.worker.min.mjs';

export async function extractPdfPriceList(file) {
  const buf = await file.arrayBuffer();
  const doc = await pdfjsLib.getDocument({ data: buf }).promise;
  const results = [];

  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();
    const items = content.items
      .map(it => ({ str: it.str, x: it.transform[4], y: it.transform[5] }))
      .filter(it => it.str.trim() !== '');
    items.sort((a, b) => b.y - a.y || a.x - b.x);

    const rows = [];
    items.forEach(it => {
      let row = rows.find(r => Math.abs(r.y - it.y) < 3);
      if (!row) { row = { y: it.y, items: [] }; rows.push(row); }
      row.items.push(it);
    });
    rows.sort((a, b) => b.y - a.y);
    rows.forEach(r => r.items.sort((a, b) => a.x - b.x));

    const headerRow = rows.find(r => r.items.some(i => i.str === 'Product Code'));
    if (!headerRow) continue; // page has no price table (cover/signature pages etc.)
    const hdrX = {};
    headerRow.items.forEach(i => { hdrX[i.str] = i.x; });
    const priceStart = hdrX['Price'], priceEnd = hdrX['UOM'];
    if (priceStart == null || priceEnd == null) continue;

    let currentGroup = null;
    rows.forEach(r => {
      const sorted = r.items;
      const lineIdx = sorted.findIndex(i => i.x < 55 && i.x > 15 && /^\d+$/.test(i.str.trim()));
      if (lineIdx !== -1) {
        if (currentGroup) results.push(currentGroup);
        currentGroup = { code: '', price: null };
        const codeItem = sorted[lineIdx + 1];
        if (codeItem && !/\s/.test(codeItem.str)) currentGroup.code += codeItem.str;
      } else if (currentGroup) {
        const first = sorted[0];
        if (first && first.x < 100 && !/\s/.test(first.str)) currentGroup.code += first.str;
      }
      if (!currentGroup) return;
      r.items.forEach(i => {
        if (i.x >= priceStart && i.x < priceEnd) {
          const n = parseFloat(i.str.replace(/,/g, ''));
          if (!isNaN(n)) currentGroup.price = n;
        }
      });
    });
    if (currentGroup) { results.push(currentGroup); currentGroup = null; }
  }

  return results.filter(r => r.code && r.price != null);
}
