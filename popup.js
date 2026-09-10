"use strict";

const listingFile = document.getElementById("listing-file");
const dorisFile = document.getElementById("doris-file");
const statusEl = document.getElementById("status");

function setStatus(message, type) {
  statusEl.className = "status " + (type || "info");
  statusEl.textContent = message;
}

function headerIndex(row, name) {
  return row.findIndex((value) => String(value || "").replace(/\s+/g, " ").trim().toUpperCase() === name);
}

function listingRows(book) {
  const sheet = book.Sheets[book.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true });
  const headerAt = rows.findIndex((row) => headerIndex(row, "ID LISTING") >= 0);
  if (headerAt < 0) throw new Error("Không tìm thấy cột ID LISTING trong file listing.");
  const headers = rows[headerAt].map((value) => String(value || "").replace(/\s+/g, " ").trim());
  const map = {};
  rows.slice(headerAt + 1).forEach((values) => {
    const row = Object.fromEntries(headers.map((header, index) => [header, values[index]]));
    const record = SPUCore.listingRecordFromRow(row);
    if (record.id && record.title && record.article) map[record.id] = record;
  });
  return map;
}

function skuRows(book) {
  const candidates = [];
  book.SheetNames.forEach((name) => {
    const rows = XLSX.utils.sheet_to_json(book.Sheets[name], { header: 1, defval: "", raw: true });
    const headerAt = rows.findIndex((row) => headerIndex(row, "SKU") >= 0 && headerIndex(row, "TÊN SẢN PHẨM") >= 0);
    if (headerAt < 0) return;
    const headers = rows[headerAt];
    const skuAt = headerIndex(headers, "SKU");
    const productAt = headerIndex(headers, "TÊN SẢN PHẨM");
    rows.slice(headerAt + 1).forEach((row) => {
      const sku = String(row[skuAt] || "").trim();
      const productName = String(row[productAt] || "").trim();
      if (sku && productName) candidates.push({ sku, productName });
    });
  });
  return candidates;
}

document.getElementById("load-sources").addEventListener("click", async () => {
  if (!listingFile.files[0] || !dorisFile.files[0]) { setStatus("Hãy chọn đủ hai file Excel.", "err"); return; }
  try {
    setStatus("Đang đọc workbook…", "info");
    const listingBook = XLSX.read(await listingFile.files[0].arrayBuffer(), { type: "array" });
    const dorisBook = XLSX.read(await dorisFile.files[0].arrayBuffer(), { type: "array" });
    const listings = listingRows(listingBook);
    const skuCandidates = skuRows(dorisBook);
    if (!Object.keys(listings).length || !skuCandidates.length) throw new Error("Không đọc được dữ liệu listing hoặc SKU.");
    await chrome.storage.local.set({ spu_source_data: { listings, skuCandidates, meta: { listingFile: listingFile.files[0].name, dorisFile: dorisFile.files[0].name, loadedAt: new Date().toISOString() } } });
    setStatus(`✓ Đã nạp ${Object.keys(listings).length} listing và ${skuCandidates.length} SKU.`, "ok");
  } catch (error) { setStatus("Lỗi: " + error.message, "err"); }
});

chrome.storage.local.get("spu_source_data").then(({ spu_source_data: data }) => {
  if (data) setStatus(`Đã có ${Object.keys(data.listings || {}).length} listing · ${data.meta && data.meta.listingFile || ""}`, "ok");
});
