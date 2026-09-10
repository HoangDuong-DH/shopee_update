"use strict";

const SPUCore = (() => {
  function canonicalListingId(value) {
    const num = Number(value);
    return Number.isFinite(num) && num >= 0 ? String(Math.trunc(num)) : "";
  }

  function removeDiacritics(value) {
    return String(value || "")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/Đ/g, "D");
  }

  function slugify(value) {
    return removeDiacritics(value)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function parseVariationCell(value) {
    const match = /^\s*«?\s*([^»:]+?)\s*»?\s*:\s*(.+?)\s*$/.exec(String(value || ""));
    if (!match) return null;
    const rawName = match[1].trim();
    const values = match[2].split("·").map((item) => item.trim()).filter(Boolean);
    return values.length ? { rawName, name: rawName.replace(/\s+/g, ""), values } : null;
  }

  function parseFolderFiles(files) {
    const imageFiles = Array.from(files || []).filter((file) => /\.(jpe?g|png)$/i.test(file.name));
    const cover = imageFiles.find((file) => /anh[-_ ]?bia\.(jpe?g|png)$/i.test(file.name)) || null;
    const gallery = imageFiles
      .map((file) => ({ file, match: /[-_ ]g(\d{1,2})\.(jpe?g|png)$/i.exec(file.name) }))
      .filter((entry) => entry.match)
      .map((entry) => ({ num: Number(entry.match[1]), file: entry.file }))
      .sort((a, b) => a.num - b.num);
    const variationImages = imageFiles.filter((file) => file !== cover && !gallery.some((item) => item.file === file));
    return { cover, gallery, variationImages };
  }

  function findVariationImages(parsed, value) {
    const suffix = new RegExp(`-${slugify(value)}\\.(jpe?g|png)$`, "i");
    return (parsed.variationImages || []).filter((file) => suffix.test(file.name));
  }

  function findVariationImage(parsed, value) {
    const matches = findVariationImages(parsed, value);
    return matches.length === 1 ? matches[0] : null;
  }

  function descriptionFiles(parsed) {
    return (parsed.gallery || []).filter((item) => item.num >= 2).map((item) => item.file);
  }

  function listingRecordFromRow(row) {
    const groups = [
      "PHÂN LOẠI 1 (copy đăng Shopee)",
      "PHÂN LOẠI 2 (copy đăng Shopee)",
    ].map((key) => parseVariationCell(row[key])).filter(Boolean);
    return {
      id: canonicalListingId(row["ID LISTING"]),
      title: String(row["Tiêu Đề"] || "").trim(),
      article: String(row["Bài Đăng"] || "").trim(),
      groups,
    };
  }

  function buildVariationCombinations(groups) {
    if (!groups || !groups.length) return [];
    if (groups.length === 1) return groups[0].values.map((value) => [value]);
    return groups[0].values.flatMap((first) => groups[1].values.map((second) => [first, second]));
  }

  function splitArticle(article) {
    const lines = String(article || "").replace(/\r\n/g, "\n").split("\n");
    return { headline: String(lines.shift() || "").trim(), body: lines.join("\n").replace(/^\n+/, "") };
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>\"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[char]));
  }

  function buildPreflightPlan({ listing, parsedFiles, skuCandidates }) {
    const errors = [];
    if (!parsedFiles.cover) errors.push("Không có ảnh bìa ANH-BIA.");
    if (!(parsedFiles.gallery || []).length) errors.push("Không có ảnh g1..gN.");
    const variationImages = ((listing.groups || [])[0] || { values: [] }).values.map((value) => ({ value, matches: findVariationImages(parsedFiles, value) }));
    variationImages.forEach((item) => {
      if (item.matches.length !== 1) errors.push(`${item.matches.length ? "Trùng" : "Thiếu"} ảnh biến thể: ${item.value}`);
    });
    const firstGroupValues = ((listing.groups || [])[0] || { values: [] }).values;
    const rows = buildVariationCombinations(listing.groups || []).map((values) => ({ values, resolved: resolveSku(skuCandidates, listing.title, values, firstGroupValues) }));
    rows.forEach((row) => {
      if (row.resolved.status !== "matched") errors.push(`Không xác định SKU: ${row.values.join(" / ")}`);
    });
    return {
      ok: errors.length === 0,
      errors,
      listing,
      parsedFiles,
      descriptionFiles: descriptionFiles(parsedFiles),
      variationImages,
      rows,
    };
  }

  function skuKey(value) {
    return removeDiacritics(value)
      .toLowerCase()
      .replace(/🎁\s*(\d+)/g, "1x$1ml")
      .replace(/×/g, "x")
      .replace(/[^a-z0-9]+/g, "");
  }

  function wordKey(value) {
    return removeDiacritics(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function volumeSignature(value) {
    let text = removeDiacritics(value).toLowerCase().replace(/🎁\s*(\d+)/g, "1x$1ml");
    const volumes = [];
    text = text.replace(/(\d+)\s*[x×]\s*(\d+)\s*ml/g, (_, count, size) => {
      for (let i = 0; i < Number(count); i++) volumes.push(Number(size));
      return " ";
    });
    let match;
    const plain = /(\d+)\s*ml/g;
    while ((match = plain.exec(text))) volumes.push(Number(match[1]));
    return volumes.sort((a, b) => a - b);
  }

  function titleScore(productName, title) {
    const product = removeDiacritics(productName).toLowerCase();
    return removeDiacritics(title)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4 && !/^(chai|xit|san|pham|abura)$/.test(word))
      .filter((word) => product.includes(word)).length;
  }

  function resolveSku(candidates, title, values, variantUniverse) {
    const textValues = (values || []).filter((value) => volumeSignature(value).length === 0).map(wordKey).filter(Boolean);
    const expectedVolumes = (values || []).flatMap(volumeSignature);
    const allVariantKeys = (variantUniverse || []).map(wordKey).filter(Boolean);
    const matched = (candidates || [])
      .map((candidate) => {
        const productName = String(candidate.productName || "");
        const words = " " + wordKey(productName) + " ";
        const exactPhrases = textValues.every((value) => words.includes(" " + value + " "));
        const matchingVariants = allVariantKeys.filter((value) => words.includes(" " + value + " "));
        const longestVariant = matchingVariants.reduce((longest, value) => value.length > longest.length ? value : longest, "");
        const correctVariant = !allVariantKeys.length || textValues.every((value) => value === longestVariant);
        const sameVolumes = !expectedVolumes.length || JSON.stringify(volumeSignature(productName)) === JSON.stringify(expectedVolumes.sort((a, b) => a - b));
        return {
          candidate,
          score: exactPhrases && correctVariant && sameVolumes ? textValues.length + expectedVolumes.length : 0,
          titleScore: titleScore(productName, title),
        };
      }).filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || b.titleScore - a.titleScore);

    if (!matched.length) return { status: "missing" };
    if (matched.length > 1 && matched[0].titleScore === matched[1].titleScore) {
      return { status: "ambiguous", candidates: matched.filter((entry) => entry.titleScore === matched[0].titleScore).map((entry) => entry.candidate) };
    }
    return { status: "matched", sku: matched[0].candidate.sku, candidate: matched[0].candidate };
  }

  return {
    canonicalListingId,
    parseVariationCell,
    slugify,
    parseFolderFiles,
    findVariationImages,
    findVariationImage,
    descriptionFiles,
    listingRecordFromRow,
    buildVariationCombinations,
    buildPreflightPlan,
    splitArticle,
    escapeHtml,
    resolveSku,
  };
})();

if (typeof module !== "undefined") module.exports = SPUCore;
if (typeof window !== "undefined") window.SPUCore = SPUCore;
