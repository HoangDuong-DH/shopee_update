# Shopee Listing Fill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the uploader so it loads listing and SKU workbooks, resolves the current Shopee listing, and fills title, rich description, variations, variation images, SKUs, and empty stock.

**Architecture:** A popup parses two user-selected `.xlsx` files with SheetJS and writes normalized maps to `chrome.storage.local`. A shared, dependency-free helper module owns parsing, normalization, filename matching, and SKU selection; the content script consumes its output to preflight and operate the Shopee DOM.

**Tech Stack:** Chrome Extension Manifest V3, vanilla JavaScript, SheetJS `xlsx.full.min.js`, Node built-in `node:test`.

## Global Constraints

- Do not submit or save the Shopee product automatically.
- Read workbooks only through user-selected file inputs; never hard-code a Windows path.
- Read `ID LISTING`, `Tiêu Đề`, `Bài Đăng`, variation columns K/L from the listing workbook by header name.
- Normalize only variation-group names by removing whitespace; preserve variation-option display text.
- Use `g2..gN` as rich-description images and `g1..gN` as 3:4 product images.
- Match a variation-1 image by its exact unaccented filename suffix, e.g. `Sả Chanh` → `-sa-chanh.jpg`.
- Fill a SKU only for a unique best Doris candidate; report missing and tied candidates without writing them.
- Set stock to `100` only if the row stock input is blank.
- Preserve the existing cover/3:4 crop flow and its cancel behavior.
- The workspace is not a Git repository; do not run commit commands.

---

## File structure

- Create `shared.js`: pure `SPUCore` functions usable by popup, content script, and Node tests.
- Create `popup.html`: two workbook inputs and loading status UI.
- Create `popup.js`: SheetJS ingestion and `chrome.storage.local` writes.
- Create `lib/xlsx.full.min.js`: the existing SheetJS distribution copied from `C:\shopee_helper_v1_2_2\lib\xlsx.full.min.js`.
- Create `package.json`: `node --test` script only; no package dependency installation.
- Create `tests/shared.test.js`: data-parser and SKU-resolution tests.
- Modify `manifest.json`: add `storage`, an action popup, `shared.js` before `content.js`, and the popup assets.
- Modify `content.js`: add storage loading, preflight, title/description/variation operations, and the expanded panel flow.
- Modify `content.css`: style the preflight summary and mapping errors.

### Task 1: Add and test pure mapping helpers

**Files:**
- Create: `package.json`
- Create: `tests/shared.test.js`
- Create: `shared.js`

**Interfaces:**
- Produces global `SPUCore` and CommonJS export containing `canonicalListingId`, `parseVariationCell`, `slugify`, `parseFolderFiles`, `splitArticle`, `escapeHtml`, `buildVariationCombinations`, and `resolveSku`.
- Consumes no DOM, Chrome API, or SheetJS object.

- [ ] **Step 1: Write the failing tests**

```js
// tests/shared.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared.js');

test('parses listing IDs and variation cells', () => {
  assert.equal(core.canonicalListingId(41378981745), '41378981745');
  assert.deepEqual(core.parseVariationCell('«Combo Tiết Kiệm»: 300ml · 2×500ml +🎁100'), {
    name: 'ComboTiếtKiệm', values: ['300ml', '2×500ml +🎁100'], rawName: 'Combo Tiết Kiệm',
  });
});

test('uses g2 onward for description and finds variation-image suffixes', () => {
  const files = [
    { name: 'x-ANH-BIA.jpg' }, { name: 'x-g1.jpg' }, { name: 'x-g2.jpg' },
    { name: 'x-sa-chanh.jpg' },
  ];
  const parsed = core.parseFolderFiles(files);
  assert.equal(parsed.cover.name, 'x-ANH-BIA.jpg');
  assert.deepEqual(parsed.gallery.map((x) => x.num), [1, 2]);
  assert.equal(core.findVariationImage(parsed, 'Sả Chanh').name, 'x-sa-chanh.jpg');
  assert.deepEqual(core.descriptionFiles(parsed).map((x) => x.name), ['x-g2.jpg']);
});

test('accepts only a unique best Doris SKU', () => {
  const candidates = [
    { sku: 'ATDSC500X2Q100', productName: 'Abura Sả Chanh Combo 2 x 500ml + 1 x 100ml' },
    { sku: 'ATDBHL500X2Q100', productName: 'Abura Bạc Hà Lục Combo 2 x 500ml + 1 x 100ml' },
  ];
  const resolved = core.resolveSku(candidates, 'Xịt Khử Mùi Bồn Cầu ABURA', ['Sả Chanh', '2×500ml +🎁100']);
  assert.equal(resolved.sku, 'ATDSC500X2Q100');
  assert.equal(core.resolveSku(candidates, 'ABURA', ['500ml']).status, 'ambiguous');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/shared.test.js`  
Expected: FAIL because `../shared.js` does not exist.

- [ ] **Step 3: Add the test command and minimal helper implementation**

```json
// package.json
{ "private": true, "scripts": { "test": "node --test" } }
```

```js
// shared.js — expose the same object to Node and extension pages
const SPUCore = (() => {
  const canonicalListingId = (value) => String(Math.trunc(Number(value))).replace(/^NaN$/, '');
  const removeDiacritics = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D');
  const slugify = (value) => removeDiacritics(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const parseVariationCell = (value) => {
    const match = /^\s*«?\s*([^»:]+?)\s*»?\s*:\s*(.+?)\s*$/.exec(String(value || ''));
    if (!match || /^—$/.test(match[1])) return null;
    const rawName = match[1].trim();
    const values = match[2].split('·').map((v) => v.trim()).filter(Boolean);
    return values.length ? { rawName, name: rawName.replace(/\s+/g, ''), values } : null;
  };
  const parseFolderFiles = (files) => {
    const cover = files.find((f) => /anh[-_ ]?bia\.(jpe?g|png)$/i.test(f.name)) || null;
    const gallery = files.map((file) => ({ file, match: /[-_ ]g(\d{1,2})\.(jpe?g|png)$/i.exec(file.name) }))
      .filter((x) => x.match).map((x) => ({ num: Number(x.match[1]), file: x.file })).sort((a, b) => a.num - b.num);
    const variationImages = files.filter((f) => /\.(jpe?g|png)$/i.test(f.name) && f !== cover && !gallery.some((g) => g.file === f));
    return { cover, gallery, variationImages };
  };
  const findVariationImages = (parsed, value) => parsed.variationImages.filter((f) => new RegExp(`-${slugify(value)}\\.(jpe?g|png)$`, 'i').test(f.name));
  const findVariationImage = (parsed, value) => { const matches = findVariationImages(parsed, value); return matches.length === 1 ? matches[0] : null; };
  const descriptionFiles = (parsed) => parsed.gallery.filter((g) => g.num >= 2).map((g) => g.file);
  const splitArticle = (article) => { const lines = String(article || '').replace(/\r\n/g, '\n').split('\n'); return { headline: lines.shift().trim(), body: lines.join('\n').replace(/^\n+/, '') }; };
  const escapeHtml = (text) => String(text).replace(/[&<>\"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const buildVariationCombinations = (groups) => groups.length === 2 ? groups[0].values.flatMap((a) => groups[1].values.map((b) => [a, b])) : (groups[0] || { values: [] }).values.map((a) => [a]);
  const skuText = (text) => removeDiacritics(text).toLowerCase().replace(/🎁\s*(\d+)/g, '1x$1ml').replace(/×/g, 'x').replace(/[^a-z0-9]+/g, '');
  const resolveSku = (candidates, title, values) => {
    const needles = values.map(skuText).filter(Boolean);
    const titleTokens = removeDiacritics(title).toLowerCase().split(/[^a-z0-9]+/).filter((v) => v.length >= 4 && !/^(chai|xịt|san|pham|abura)$/.test(v));
    const scored = candidates.map((c) => {
      const name = skuText(c.productName);
      const words = removeDiacritics(c.productName).toLowerCase();
      return { ...c, score: needles.filter((n) => name.includes(n)).length, titleScore: titleTokens.filter((t) => words.includes(t)).length };
    }).filter((c) => c.score === needles.length && c.score > 0).sort((a, b) => b.score - a.score || b.titleScore - a.titleScore);
    if (!scored.length) return { status: 'missing' };
    if (scored.length > 1 && scored[0].score === scored[1].score && scored[0].titleScore === scored[1].titleScore) return { status: 'ambiguous', candidates: scored.filter((c) => c.score === scored[0].score && c.titleScore === scored[0].titleScore) };
    return { status: 'matched', sku: scored[0].sku, candidate: scored[0] };
  };
  return { canonicalListingId, parseVariationCell, slugify, parseFolderFiles, findVariationImages, findVariationImage, descriptionFiles, splitArticle, escapeHtml, buildVariationCombinations, resolveSku };
})();
if (typeof module !== 'undefined') module.exports = SPUCore;
if (typeof window !== 'undefined') window.SPUCore = SPUCore;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`  
Expected: three passing tests.

### Task 2: Load both workbooks in a popup and persist normalized maps

**Files:**
- Create: `popup.html`
- Create: `popup.js`
- Create: `lib/xlsx.full.min.js`
- Modify: `manifest.json`
- Test: `tests/shared.test.js`

**Interfaces:**
- Consumes `SPUCore.canonicalListingId` and `SPUCore.parseVariationCell`.
- Produces `chrome.storage.local` key `spu_source_data` with `{ listings, skuCandidates, meta }`.

- [ ] **Step 1: Extend the failing test with workbook-row normalization**

```js
test('normalizes a listing row into the current-listing source record', () => {
  const row = { 'ID LISTING': 41378981745, 'Tiêu Đề': 'Tên', 'Bài Đăng': 'Dòng đầu\nNội dung', 'PHÂN LOẠI 1 (copy đăng Shopee)': '«Mùi»: Sả Chanh' };
  assert.deepEqual(core.listingRecordFromRow(row), {
    id: '41378981745', title: 'Tên', article: 'Dòng đầu\nNội dung', groups: [{ rawName: 'Mùi', name: 'Mùi', values: ['Sả Chanh'] }],
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/shared.test.js`  
Expected: FAIL because `listingRecordFromRow` is not defined.

- [ ] **Step 3: Implement record conversion and popup ingestion**

```js
// append to shared.js before return
const listingRecordFromRow = (row) => {
  const groups = ['PHÂN LOẠI 1 (copy đăng Shopee)', 'PHÂN LOẠI 2 (copy đăng Shopee)'].map((key) => parseVariationCell(row[key])).filter(Boolean);
  return { id: canonicalListingId(row['ID LISTING']), title: String(row['Tiêu Đề'] || '').trim(), article: String(row['Bài Đăng'] || '').trim(), groups };
};
// include listingRecordFromRow in the returned object
```

```html
<!-- popup.html body scripts -->
<input id="listing-file" type="file" accept=".xlsx,.xls" />
<input id="doris-file" type="file" accept=".xlsx,.xls" />
<button id="load-sources">Nạp dữ liệu</button>
<div id="status" aria-live="polite"></div>
<script src="lib/xlsx.full.min.js"></script>
<script src="shared.js"></script>
<script src="popup.js"></script>
```

```js
// popup.js core persistence path
async function loadSources() {
  const listingBook = XLSX.read(await listingFile.arrayBuffer(), { type: 'array' });
  const dorisBook = XLSX.read(await dorisFile.arrayBuffer(), { type: 'array' });
  const listings = parseListings(listingBook);
  const skuCandidates = parseSkuCandidates(dorisBook);
  await chrome.storage.local.set({ spu_source_data: { listings, skuCandidates, meta: { loadedAt: new Date().toISOString(), listingFile: listingFile.name, dorisFile: dorisFile.name } } });
}
```

Copy the checked local SheetJS file into `lib/xlsx.full.min.js`. Update the manifest with `"permissions": ["storage"]`, an `action.default_popup` of `popup.html`, and `shared.js` before `content.js` in `content_scripts`.

- [ ] **Step 4: Run helper tests and syntax checks**

Run: `npm test; node --check popup.js; node --check shared.js; node --check content.js`  
Expected: all tests pass and each syntax check exits 0.

### Task 3: Build a fail-closed page preflight and panel summary

**Files:**
- Modify: `content.js`
- Modify: `content.css`
- Test: `tests/shared.test.js`

**Interfaces:**
- Consumes `chrome.storage.local.get('spu_source_data')`, `SPUCore` helpers, URL listing ID, and selected folder files.
- Produces `activePlan = { listing, parsedFiles, descriptionFiles, variationImages, combinations }` only after every required mapping is valid.

- [ ] **Step 1: Write the failing plan-builder test**

```js
test('rejects a plan with a missing variation image or ambiguous SKU', () => {
  const plan = core.buildPreflightPlan({ listing: { title: 'ABURA', groups: [{ name: 'Mùi', values: ['Sả Chanh'] }] }, parsedFiles: { variationImages: [] }, skuCandidates: [] });
  assert.equal(plan.ok, false);
  assert.match(plan.errors.join('\n'), /ảnh biến thể|SKU/i);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/shared.test.js`  
Expected: FAIL because `buildPreflightPlan` is not defined.

- [ ] **Step 3: Implement plan construction and content-script state**

```js
// shared.js: return a structured plan rather than throwing.
const buildPreflightPlan = ({ listing, parsedFiles, skuCandidates }) => {
  const errors = [];
  const combinations = buildVariationCombinations(listing.groups);
  const variationImages = (listing.groups[0] || { values: [] }).values.map((value) => ({ value, matches: findVariationImages(parsedFiles, value) }));
  variationImages.filter((x) => x.matches.length !== 1).forEach((x) => errors.push(`${x.matches.length ? 'Trùng' : 'Thiếu'} ảnh biến thể: ${x.value}`));
  const rows = combinations.map((values) => ({ values, resolved: resolveSku(skuCandidates, listing.title, values) }));
  rows.filter((r) => r.resolved.status !== 'matched').forEach((r) => errors.push(`Không xác định SKU: ${r.values.join(' / ')}`));
  return { ok: errors.length === 0, errors, listing, parsedFiles, descriptionFiles: descriptionFiles(parsedFiles), variationImages, rows };
};
```

```js
// content.js: reload source data and prepare before allowing run
async function loadSourceData() {
  const { spu_source_data: data } = await chrome.storage.local.get('spu_source_data');
  return data || null;
}
function currentListingId() {
  const match = /\/product\/(\d+)/.exec(location.pathname);
  return match ? match[1] : '';
}
```

Render title, description-image count, group names, mapped variation-image count, SKU-row count, and any errors with `textContent`, never interpolated `innerHTML` from workbook or filename data. Keep the Run button hidden/disabled until `activePlan.ok` is true.

- [ ] **Step 4: Run regression tests**

Run: `npm test; node --check content.js`  
Expected: all helper tests pass and `content.js` exits 0.

### Task 4: Fill title, rich description, variations, SKU, images, and blank stock

**Files:**
- Modify: `content.js`
- Modify: `content.css`
- Test: `tests/shared.test.js`

**Interfaces:**
- Consumes a valid `activePlan` from Task 3.
- Produces completed DOM fields without clicking Shopee's main save button.

- [ ] **Step 1: Add pure description-format tests**

```js
test('splits article headline from the body and escapes editor text', () => {
  assert.deepEqual(core.splitArticle('🌿 Tiêu đề\n\nNội dung'), { headline: '🌿 Tiêu đề', body: 'Nội dung' });
  assert.equal(core.escapeHtml('<b>x</b>'), '&lt;b&gt;x&lt;/b&gt;');
});
```

- [ ] **Step 2: Run the test to verify it fails if behavior is absent**

Run: `node --test tests/shared.test.js`  
Expected: PASS only after the helpers from Task 1 are present; otherwise add the missing implementation before proceeding.

- [ ] **Step 3: Implement DOM operations in ordered helpers**

```js
function setNativeValue(el, value) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

async function fillTitle(plan) {
  const input = await waitFor(() => document.querySelector('[data-product-edit-field-unique-id="name"] input'));
  setNativeValue(input, plan.listing.title);
}

async function fillDescription(plan) {
  const editor = await waitFor(() => document.querySelector('[data-product-edit-field-unique-id="description"] .ql-editor'));
  const { headline, body } = SPUCore.splitArticle(plan.listing.article);
  editor.innerHTML = `<p>${SPUCore.escapeHtml(headline)}</p>`;
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: headline }));
  await uploadDescriptionImages(plan.descriptionFiles);
  await waitForDescriptionImages(editor, plan.descriptionFiles.length);
  editor.insertAdjacentHTML('beforeend', articleToParagraphs(body));
  editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: body }));
}
```

Implement `fillVariations(plan)` in this order: create missing groups; set group names and all option values; wait for matrix rows; upload each variation-1 image using the exact map from `plan.variationImages`; map matrix rows to their visible option values; set the matching SKU; set `100` only when `stockModel_*` is empty. Make every DOM wait time-bound and call `throwIfCancelled()` inside loops.

Call the helpers only after the existing product-image upload and crop stage completes:

```js
await fillTitle(activePlan);
await fillDescription(activePlan);
await fillVariations(activePlan);
addProgressLine('✅ Đã điền nội dung và phân loại. Kiểm tra lại rồi bấm Lưu/Cập nhật của Shopee.');
```

- [ ] **Step 4: Run tests and static verification**

Run: `npm test; node --check content.js; node --check popup.js; node --check shared.js`  
Expected: all tests pass and every syntax check exits 0.

### Task 5: Verify packaged extension and run a manual Shopee smoke test

**Files:**
- Modify only if verification exposes a defect: `manifest.json`, `content.js`, `content.css`, `popup.html`, `popup.js`, or `shared.js`

**Interfaces:**
- Consumes the completed extension from Tasks 1–4.
- Produces evidence that static packaging is valid and documents any runtime selector mismatch.

- [ ] **Step 1: Verify manifest references**

Run:

```powershell
$m = Get-Content -Raw -Encoding UTF8 manifest.json | ConvertFrom-Json
$refs = @($m.content_scripts.js) + @($m.content_scripts.css) + @($m.icons.PSObject.Properties.Value) + @('popup.html','popup.js','shared.js','lib/xlsx.full.min.js')
$refs | ForEach-Object { if (-not (Test-Path -LiteralPath $_)) { throw "Missing: $_" } }
```

Expected: exit 0 with no missing file.

- [ ] **Step 2: Load the unpacked extension and ingest the supplied workbooks**

In Chrome Extensions, reload the unpacked `C:\shopee_product_uploader` directory. Open the popup, select `abura.hcm.xlsx` and `FILE GIÁ DORIS.xlsx`, and confirm the popup reports a nonzero listing and SKU count.

- [ ] **Step 3: Smoke-test the known mapping without saving the listing**

Open listing `41378981745`, select `C:\Users\Admin\Desktop\abr\01 - ABURA Xịt Khử Mùi Toilet Bồn Cầu`, and verify the preflight summary contains:

```text
Title: Xịt Khử Mùi Bồn Cầu Toilet Nhà Vệ Sinh ABURA...
Description images: g2 through g8 (7 files)
Variation image: Sả Chanh → ...-SA-CHANH.jpg
SKU: Sả Chanh / 2×500ml +🎁100 → ATDSC500X2Q100
```

Run the fill flow, verify existing nonblank stock remains unchanged and blank stock becomes `100`, then stop before pressing Shopee's main `Lưu`/`Cập nhật` button.

- [ ] **Step 4: Record the actual runtime result**

If a Shopee selector or upload sequence fails, retain the panel error text and update the corresponding selector/wait helper. Re-run Step 3 until the smoke test reaches the final manual-save message.
