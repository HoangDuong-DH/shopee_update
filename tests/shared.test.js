const test = require("node:test");
const assert = require("node:assert/strict");
const core = require("../shared.js");

test("parses listing IDs and variation cells", () => {
  assert.equal(core.canonicalListingId(41378981745), "41378981745");
  assert.deepEqual(
    core.parseVariationCell("«Combo Tiết Kiệm»: 300ml · 2×500ml +🎁100"),
    {
      name: "ComboTiếtKiệm",
      rawName: "Combo Tiết Kiệm",
      values: ["300ml", "2×500ml +🎁100"],
    }
  );
});

test("finds g2 onward and the exact variation-image suffix", () => {
  const parsed = core.parseFolderFiles([
    { name: "x-ANH-BIA.jpg" },
    { name: "x-g1.jpg" },
    { name: "x-g2.jpg" },
    { name: "x-sa-chanh.jpg" },
  ]);

  assert.equal(parsed.cover.name, "x-ANH-BIA.jpg");
  assert.deepEqual(parsed.gallery.map((item) => item.num), [1, 2]);
  assert.equal(core.findVariationImage(parsed, "Sả Chanh").name, "x-sa-chanh.jpg");
  assert.deepEqual(core.descriptionFiles(parsed).map((file) => file.name), ["x-g2.jpg"]);
});

test("resolves a unique Doris SKU and rejects a tie", () => {
  const candidates = [
    { sku: "ATDSC500X2Q100", productName: "Abura Sả Chanh Combo 2 x 500ml + 1 x 100ml" },
    { sku: "ATDBHL500X2Q100", productName: "Abura Bạc Hà Lục Combo 2 x 500ml + 1 x 100ml" },
  ];

  const resolved = core.resolveSku(
    candidates,
    "Xịt Khử Mùi Bồn Cầu ABURA",
    ["Sả Chanh", "2×500ml +🎁100"]
  );

  assert.equal(resolved.status, "matched");
  assert.equal(resolved.sku, "ATDSC500X2Q100");
  assert.notEqual(core.resolveSku(candidates, "ABURA", ["500ml"]).status, "matched");
});

test("normalizes a listing workbook row", () => {
  const record = core.listingRecordFromRow({
    "ID LISTING": 41378981745,
    "Tiêu Đề": "Tên sản phẩm",
    "Bài Đăng": "Dòng đầu\nNội dung",
    "PHÂN LOẠI 1 (copy đăng Shopee)": "«Mùi Yêu Thích»: Sả Chanh · Bạc Hà",
    "PHÂN LOẠI 2 (copy đăng Shopee)": "«Combo Tiết Kiệm»: 300ml · 500ml",
  });

  assert.deepEqual(record, {
    id: "41378981745",
    title: "Tên sản phẩm",
    article: "Dòng đầu\nNội dung",
    groups: [
      { rawName: "Mùi Yêu Thích", name: "MùiYêuThích", values: ["Sả Chanh", "Bạc Hà"] },
      { rawName: "Combo Tiết Kiệm", name: "ComboTiếtKiệm", values: ["300ml", "500ml"] },
    ],
  });
});

test("fails preflight when variation image or SKU mapping is missing", () => {
  const plan = core.buildPreflightPlan({
    listing: { title: "ABURA", groups: [{ name: "Mùi", values: ["Sả Chanh"] }] },
    parsedFiles: { gallery: [{ num: 1, file: { name: "x-g1.jpg" } }], variationImages: [] },
    skuCandidates: [],
  });

  assert.equal(plan.ok, false);
  assert.match(plan.errors.join("\n"), /ảnh biến thể/i);
  assert.match(plan.errors.join("\n"), /SKU/i);
});

test("splits and safely formats article text for the rich editor", () => {
  assert.deepEqual(core.splitArticle("🌿 Tiêu đề\n\nNội dung"), { headline: "🌿 Tiêu đề", body: "Nội dung" });
  assert.equal(core.escapeHtml("<b>x</b>"), "&lt;b&gt;x&lt;/b&gt;");
});

test("matches a single Bạc Hà 500ml SKU without accepting Bạc Hà Lục or mixed combos", () => {
  const candidates = [
    { sku: "ATDBH500", productName: "Abura Chai Xịt tinh dầu BẠC HÀ 500ml" },
    { sku: "ATDBHL500", productName: "Abura Chai Xịt tinh dầu BẠC HÀ LỤC 500ml" },
    { sku: "ATD2SCBH500CS100", productName: "Abura Sả Chanh 500ml + Bạc Hà 500ml + Cam Sả 100ml" },
  ];

  const resolved = core.resolveSku(
    candidates,
    "Xịt Khử Mùi Bồn Cầu ABURA",
    ["Bạc Hà", "500ml"],
    ["Sả Chanh", "Bạc Hà", "Bạc Hà Lục"]
  );
  assert.deepEqual(resolved, { status: "matched", sku: "ATDBH500", candidate: candidates[0] });
});
