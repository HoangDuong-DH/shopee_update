// content.js — Shopee Product Uploader
// Chức năng: chọn folder ảnh sản phẩm → tự động
//   B1. Xoá ảnh cũ vùng 1:1
//   B2. Upload ẢNH BÌA (file *-ANH-BIA) vào vùng 1:1
//   B3. Tick checkbox "Hình ảnh tỷ lệ 3:4" (nếu chưa) + xoá ảnh cũ vùng 3:4
//   B4. Upload g1..gN vào vùng 3:4 theo thứ tự
//   B5. Chờ Shopee xử lý xong toàn bộ ảnh
//   B6. Với từng ảnh 3:4: mở modal crop → kéo nhẹ → "Đặt lại" → "Lưu" (fit full khung)
"use strict";

(function () {
  // ────────────────────────────────────────────────────────────
  // Utilities
  // ────────────────────────────────────────────────────────────
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  function waitFor(fn, opts) {
    opts = opts || {};
    const timeout = opts.timeout || 8000;
    const interval = opts.interval || 150;
    const label = opts.label || "";
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      (function tick() {
        let r = null;
        try { r = fn(); } catch (e) { r = null; }
        if (r) { resolve(r); return; }
        if (Date.now() - t0 > timeout) { reject(new Error("Quá thời gian chờ: " + label)); return; }
        setTimeout(tick, interval);
      })();
    });
  }

  function isVisible(el) {
    if (!el) return false;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function findBtnByText(texts, root) {
    root = root || document;
    if (typeof texts === "string") texts = [texts];
    const bs = root.querySelectorAll("button");
    for (let i = 0; i < bs.length; i++) {
      const sp = bs[i].querySelector("span");
      const t = ((sp ? sp.textContent : bs[i].textContent) || "").trim();
      if (texts.indexOf(t) >= 0) return bs[i];
    }
    return null;
  }

  // ────────────────────────────────────────────────────────────
  // DOM accessors — vùng ảnh Shopee
  // ────────────────────────────────────────────────────────────
  function squareWrapper() {
    return document.querySelector('[data-product-edit-field-unique-id="images"]');
  }
  function longWrapper() {
    return document.querySelector('[data-product-edit-field-unique-id="longImages"]');
  }
  function longCheckbox() {
    // checkbox "Hình ảnh tỷ lệ 3:4" — không có unique-id, định vị theo class rồi fallback theo value
    const byClass = document.querySelector(".long-image-checkbox-wrap input[type='checkbox']");
    if (byClass) return byClass;
    const all = document.querySelectorAll("input.eds-checkbox__input[type='checkbox']");
    for (let i = 0; i < all.length; i++) {
      if (/3\s*:\s*4/.test(all[i].value || "")) return all[i];
    }
    return null;
  }
  // Các itembox đang chứa ảnh (loại trừ ô upload)
  function imageBoxes(wrapper) {
    if (!wrapper) return [];
    const boxes = wrapper.querySelectorAll(".shopee-image-manager__itembox");
    const out = [];
    boxes.forEach((b) => {
      if (b.querySelector("img.shopee-image-manager__image")) out.push(b);
    });
    return out;
  }
  function uploadInput(wrapper) {
    if (!wrapper) return null;
    return wrapper.querySelector("input.eds-upload__input[type='file']");
  }
  function readMaxFiles(wrapper, fallback) {
    const v = parseInt(wrapper && wrapper.getAttribute("max-upload-file-num"), 10);
    return isNaN(v) ? (fallback || 9) : v;
  }
  function readMaxSize(wrapper) {
    const v = parseInt(wrapper && wrapper.getAttribute("max-file-size"), 10);
    return isNaN(v) ? 2097152 : v;
  }
  function readAllowedExts(wrapper) {
    const raw = (wrapper && wrapper.getAttribute("allowed-file-extensions")) || "jpg,jpeg,png";
    return raw.toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
  }

  // ────────────────────────────────────────────────────────────
  // Phân tích tên file trong folder
  //   *-ANH-BIA(.jpg|.png)  → ảnh bìa (vùng 1:1)
  //   *-g1 .. *-gN          → ảnh 3:4 theo số tăng dần
  // ────────────────────────────────────────────────────────────
  function parseFolderFiles(fileList) {
    const images = [];
    const ignored = [];
    for (let i = 0; i < fileList.length; i++) {
      const f = fileList[i];
      const m = /\.([a-z0-9]+)$/i.exec(f.name);
      const ext = m ? m[1].toLowerCase() : "";
      if (["jpg", "jpeg", "png"].indexOf(ext) >= 0) images.push(f);
      else ignored.push(f.name);
    }
    let cover = null;
    const coverDupes = [];
    const gallery = []; // {num, file}
    const unmatched = [];
    images.forEach((f) => {
      const stem = f.name.replace(/\.[a-z0-9]+$/i, "");
      if (/anh[-_ ]?bia$/i.test(stem)) {
        if (cover) coverDupes.push(f.name);
        else cover = f;
        return;
      }
      const g = /[-_ ]g(\d{1,2})$/i.exec(stem);
      if (g) { gallery.push({ num: parseInt(g[1], 10), file: f }); return; }
      unmatched.push(f.name);
    });
    gallery.sort((a, b) => a.num - b.num);
    return { cover, coverDupes, gallery, unmatched, ignored, totalImages: images.length };
  }

  function validatePicked(parsed) {
    const errs = [];
    const warns = [];
    if (!parsed.cover) errs.push("Không tìm thấy file ẢNH BÌA (tên kết thúc bằng -ANH-BIA).");
    if (parsed.coverDupes.length) errs.push("Có nhiều hơn 1 file ANH-BIA: " + parsed.coverDupes.join(", "));
    if (!parsed.gallery.length) errs.push("Không tìm thấy ảnh g1..gN nào (tên kết thúc bằng -g1, -g2 ...).");
    // trùng số gN
    const seen = {};
    parsed.gallery.forEach((g) => {
      if (seen[g.num]) errs.push("Trùng số thứ tự g" + g.num + ": " + seen[g.num] + " và " + g.file.name);
      else seen[g.num] = g.file.name;
    });
    // thiếu số ở giữa → chỉ cảnh báo
    for (let i = 0; i < parsed.gallery.length; i++) {
      if (parsed.gallery[i].num !== i + 1) {
        warns.push("Số thứ tự gN không liên tục (thiếu g" + (i + 1) + "?) — vẫn upload theo thứ tự tăng dần.");
        break;
      }
    }
    if (parsed.unmatched.length) warns.push("Bỏ qua " + parsed.unmatched.length + " ảnh không đúng pattern tên: " + parsed.unmatched.join(", "));
    if (parsed.ignored.length) warns.push("Bỏ qua " + parsed.ignored.length + " file không phải ảnh jpg/png.");
    return { errs, warns };
  }

  function validateAgainstShopee(parsed) {
    const errs = [];
    const sq = squareWrapper();
    const maxSize = readMaxSize(sq);
    const allowed = readAllowedExts(sq);
    const lw = longWrapper();
    const maxLong = readMaxFiles(lw, 9);
    if (parsed.gallery.length > maxLong) {
      errs.push("Có " + parsed.gallery.length + " ảnh 3:4 nhưng Shopee chỉ cho tối đa " + maxLong + ".");
    }
    const checkFile = (f) => {
      const ext = (/\.([a-z0-9]+)$/i.exec(f.name) || [])[1] || "";
      if (allowed.indexOf(ext.toLowerCase()) < 0) errs.push(f.name + ": định dạng ." + ext + " không được phép (" + allowed.join("/") + ").");
      if (f.size > maxSize) errs.push(f.name + ": " + (f.size / 1024 / 1024).toFixed(2) + "MB vượt giới hạn " + (maxSize / 1024 / 1024).toFixed(0) + "MB.");
    };
    if (parsed.cover) checkFile(parsed.cover);
    parsed.gallery.forEach((g) => checkFile(g.file));
    return errs;
  }

  // ────────────────────────────────────────────────────────────
  // Thao tác DOM: xoá ảnh / upload / chờ xong
  // ────────────────────────────────────────────────────────────
  async function confirmModalIfAny(timeout) {
    // Sau khi bấm xoá, Shopee CÓ THỂ hiện modal xác nhận (remove-image-interceptor)
    try {
      const btn = await waitFor(() => {
        const masks = document.querySelectorAll(".eds-modal__mask");
        for (let i = 0; i < masks.length; i++) {
          if (!isVisible(masks[i])) continue;
          // không đụng vào modal crop
          const header = masks[i].querySelector(".image-cropper-header");
          if (header) continue;
          const b = findBtnByText(["Xác nhận", "Đồng ý", "Xóa", "Xoá", "OK"], masks[i]);
          if (b) return b;
        }
        return null;
      }, { timeout: timeout || 1200, interval: 150, label: "modal xác nhận xoá" });
      if (btn) { btn.click(); await sleep(400); }
    } catch (e) { /* không có modal → bỏ qua */ }
  }

  async function deleteAllImages(wrapper, labelVung, progress) {
    let guard = 0;
    while (true) {
      throwIfCancelled();
      const boxes = imageBoxes(wrapper);
      if (!boxes.length) break;
      if (++guard > 30) throw new Error("Xoá ảnh " + labelVung + " không giảm số lượng sau 30 lần thử.");
      const before = boxes.length;
      progress("Xoá ảnh cũ " + labelVung + "… còn " + before);
      const box = boxes[0];
      // hover để Vue hiện tools (phòng khi listener gắn theo trạng thái hover)
      const content = box.querySelector(".shopee-image-manager__content") || box;
      content.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      content.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
      await sleep(120);
      const del = box.querySelector(".shopee-image-manager__icon--delete");
      if (!del) throw new Error("Không thấy icon xoá trên thumbnail " + labelVung + ".");
      del.click();
      await confirmModalIfAny(1200);
      try {
        await waitFor(() => imageBoxes(wrapper).length < before, { timeout: 6000, label: "ảnh " + labelVung + " giảm sau khi xoá" });
      } catch (e) {
        throw new Error("Đã bấm xoá nhưng số ảnh " + labelVung + " không giảm (" + before + "). " + e.message);
      }
      await sleep(250);
    }
  }

  async function uploadFiles(getWrapper, files, labelVung, progress) {
    progress("Upload " + files.length + " ảnh vào vùng " + labelVung + "…");
    // input có thể bị Vue re-render → query ngay trước khi dùng, chờ nếu chưa có
    const input = await waitFor(() => uploadInput(getWrapper()), { timeout: 8000, label: "ô chọn file vùng " + labelVung });
    const dt = new DataTransfer();
    files.forEach((f) => dt.items.add(f));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  async function waitUploadDone(getWrapper, expected, labelVung, progress) {
    const t0 = Date.now();
    const timeout = 30000 + expected * 20000; // ~20s/ảnh + 30s dự phòng
    let stable = 0;
    while (true) {
      throwIfCancelled();
      const wrapper = getWrapper();
      const n = imageBoxes(wrapper).length;
      progress("Chờ Shopee xử lý ảnh " + labelVung + "… " + n + "/" + expected);
      const loading = wrapper && wrapper.querySelector(".mask-loading");
      const busy = loading && isVisible(loading);
      if (n >= expected && !busy) {
        stable++;
        if (stable >= 3) return; // ổn định 3 lần poll liên tiếp
      } else {
        stable = 0;
      }
      if (Date.now() - t0 > timeout) {
        throw new Error("Upload " + labelVung + " chưa xong sau " + Math.round(timeout / 1000) + "s (" + n + "/" + expected +
          "). Có thể ảnh bị Shopee từ chối (nhỏ hơn 500x500?) — kiểm tra thông báo lỗi trên trang.");
      }
      await sleep(500);
    }
  }

  // ────────────────────────────────────────────────────────────
  // B6 — Crop "Đặt lại" fit full khung từng ảnh 3:4
  // ────────────────────────────────────────────────────────────
  function visibleCropModal() {
    const masks = document.querySelectorAll(".image-cropper-modal .eds-modal__mask");
    for (let i = 0; i < masks.length; i++) {
      if (!isVisible(masks[i])) continue;
      const header = masks[i].querySelector(".image-cropper-header");
      const t = (header && header.textContent || "").trim();
      if (/Chỉnh sửa hình ảnh/i.test(t)) return masks[i];
    }
    return null;
  }

  function pointerOpts(x, y, buttons) {
    return {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y,
      button: 0, buttons: buttons, pointerId: 1, isPrimary: true, pointerType: "mouse",
    };
  }

  // Kéo vùng crop một đoạn nhỏ để Cropper ghi nhận thay đổi → nút "Đặt lại" sáng
  async function simulateCropDrag(modal, dist) {
    const face = modal.querySelector(".cropper-face") || modal.querySelector(".cropper-drag-box");
    if (!face) throw new Error("Không thấy vùng kéo cropper trong modal.");
    const r = face.getBoundingClientRect();
    const x0 = r.left + r.width / 2;
    const y0 = r.top + r.height / 2;
    face.dispatchEvent(new PointerEvent("pointerdown", pointerOpts(x0, y0, 1)));
    face.dispatchEvent(new MouseEvent("mousedown", pointerOpts(x0, y0, 1)));
    const steps = 4;
    for (let i = 1; i <= steps; i++) {
      const x = x0 + (dist * i) / steps;
      const y = y0 + (dist * i) / steps;
      document.dispatchEvent(new PointerEvent("pointermove", pointerOpts(x, y, 1)));
      document.dispatchEvent(new MouseEvent("mousemove", pointerOpts(x, y, 1)));
      await sleep(40);
    }
    document.dispatchEvent(new PointerEvent("pointerup", pointerOpts(x0 + dist, y0 + dist, 0)));
    document.dispatchEvent(new MouseEvent("mouseup", pointerOpts(x0 + dist, y0 + dist, 0)));
    await sleep(250);
  }

  function resetButton(modal) {
    // nút "Đặt lại" nằm ở actions-right trong modal
    const zone = modal.querySelector(".actions-right");
    return zone ? zone.querySelector("button") : null;
  }
  function isBtnEnabled(btn) {
    return btn && !btn.disabled && !btn.classList.contains("eds-button--disabled");
  }

  async function cropFitOne(getWrapper, index, total, progress) {
    const label = "ảnh 3:4 thứ " + (index + 1) + "/" + total;
    progress("Crop " + label + ": mở modal…");
    const boxes = imageBoxes(getWrapper());
    const box = boxes[index];
    if (!box) throw new Error("Không thấy thumbnail " + label + " (danh sách thay đổi?).");
    const content = box.querySelector(".shopee-image-manager__content") || box;
    content.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    content.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    await sleep(150);
    const cropIcon = box.querySelector(".shopee-image-manager__icon--crop");
    if (!cropIcon) throw new Error("Không thấy icon crop trên " + label + ".");
    cropIcon.click();

    const modal = await waitFor(visibleCropModal, { timeout: 10000, label: "modal crop " + label });
    // chờ cropper khởi tạo xong (ảnh load qua cdn_proxy)
    await waitFor(() => modal.querySelector(".cropper-face") || modal.querySelector(".cropper-drag-box"),
      { timeout: 15000, label: "cropper khởi tạo " + label });
    await sleep(500);

    // Kéo nhẹ để "Đặt lại" sáng — thử tối đa 2 lần với biên độ tăng dần
    let enabled = false;
    const dists = [8, 20];
    for (let attempt = 0; attempt < dists.length && !enabled; attempt++) {
      progress("Crop " + label + ": kéo vùng ảnh (" + (attempt + 1) + ")…");
      await simulateCropDrag(modal, dists[attempt]);
      try {
        await waitFor(() => isBtnEnabled(resetButton(modal)), { timeout: 2500, label: "nút Đặt lại sáng" });
        enabled = true;
      } catch (e) { /* thử lại với biên độ lớn hơn */ }
    }

    if (enabled) {
      progress("Crop " + label + ": Đặt lại → Lưu…");
      resetButton(modal).click();
      await sleep(400);
      const saveBtn = await waitFor(() => {
        const b = findBtnByText("Lưu", modal.querySelector(".eds-modal__footer") || modal);
        return isBtnEnabled(b) ? b : null;
      }, { timeout: 8000, label: "nút Lưu sẵn sàng " + label });
      saveBtn.click();
      // Lưu → Shopee upload lại ảnh đã crop (remoteCrop) → modal tự đóng
      await waitFor(() => !visibleCropModal(), { timeout: 20000, label: "modal đóng sau Lưu " + label });
      await sleep(600);
      return { ok: true };
    }

    // Không kích hoạt được "Đặt lại" → KHÔNG bấm Lưu bừa; đóng modal, báo lại
    progress("Crop " + label + ": không kích hoạt được Đặt lại — bỏ qua.");
    const closeBtn = findBtnByText("Đóng", modal.querySelector(".eds-modal__footer") || modal);
    if (closeBtn) closeBtn.click();
    else {
      const x = modal.querySelector(".eds-modal__close");
      if (x) x.click();
    }
    try { await waitFor(() => !visibleCropModal(), { timeout: 5000, label: "đóng modal " + label }); } catch (e) {}
    await sleep(300);
    return { ok: false };
  }

  // ────────────────────────────────────────────────────────────
  // Luồng chính
  // ────────────────────────────────────────────────────────────
  let picked = null;   // { cover: File, gallery: [File], folderName, warns, allFiles }
  let sourceData = null;
  let activePlan = null;
  let running = false;
  let cancelRequested = false;

  function throwIfCancelled() {
    if (cancelRequested) throw new Error("__CANCELLED__");
  }

  function currentListingId() {
    const m = /\/product\/(\d+)/.exec(location.pathname);
    return m ? m[1] : "";
  }

  async function loadSourceData() {
    const got = await chrome.storage.local.get("spu_source_data");
    sourceData = got.spu_source_data || null;
    return sourceData;
  }

  async function prepareActivePlan() {
    activePlan = null;
    const data = sourceData || await loadSourceData();
    const id = currentListingId();
    if (!data) return { ok: false, errors: ["Chưa nạp 2 file Excel — bấm icon extension để nạp."], rows: [] };
    if (!id || !data.listings || !data.listings[id]) return { ok: false, errors: ["Không tìm thấy ID LISTING " + (id || "trong URL") + " trong file listing."], rows: [] };
    if (!picked || !picked.allFiles) return { ok: false, errors: ["Chưa chọn folder ảnh."], rows: [] };
    activePlan = SPUCore.buildPreflightPlan({
      listing: data.listings[id],
      parsedFiles: SPUCore.parseFolderFiles(picked.allFiles),
      skuCandidates: data.skuCandidates || []
    });
    return activePlan;
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  function articleHtml(text) {
    return String(text || "").split(/\r?\n/).map((line) => "<p>" + (line ? SPUCore.escapeHtml(line) : "<br>") + "</p>").join("");
  }

  async function uploadDescriptionImages(files) {
    if (!files.length) return;
    const root = await waitFor(() => document.querySelector('[data-product-edit-field-unique-id="description"]'), { timeout: 8000, label: "vùng mô tả" });
    const input = await waitFor(() => root.querySelector('input.file-upload.eds-upload__input[type="file"], input[type="file"]'), { timeout: 8000, label: "ô upload ảnh mô tả" });
    const dt = new DataTransfer(); files.forEach((file) => dt.items.add(file));
    input.files = dt.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }

  async function fillTitleAndDescription(plan, progress) {
    const title = await waitFor(() => document.querySelector('[data-product-edit-field-unique-id="name"] input'), { timeout: 8000, label: "ô tên sản phẩm" });
    setNativeValue(title, plan.listing.title);
    const editor = await waitFor(() => document.querySelector('[data-product-edit-field-unique-id="description"] .ql-editor'), { timeout: 8000, label: "editor mô tả" });
    const article = SPUCore.splitArticle(plan.listing.article);
    editor.innerHTML = articleHtml(article.headline);
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: article.headline }));
    const before = editor.querySelectorAll("img").length;
    progress("B7: upload " + plan.descriptionFiles.length + " ảnh g2..gN vào mô tả…");
    await uploadDescriptionImages(plan.descriptionFiles);
    await waitFor(() => editor.querySelectorAll("img").length >= before + plan.descriptionFiles.length, { timeout: 30000 + plan.descriptionFiles.length * 15000, label: "ảnh mô tả upload xong" });
    editor.insertAdjacentHTML("beforeend", articleHtml(article.body));
    editor.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: article.body }));
  }

  function variationPanels() { return Array.from(document.querySelectorAll(".variation-edit-item")); }
  function visibleText(el) { return (el && el.textContent || "").replace(/\s+/g, " ").trim(); }

  async function fillVariations(plan, progress) {
    if (!plan.listing.groups.length) return;
    while (variationPanels().length < plan.listing.groups.length) {
      const add = findBtnByText(["Thêm nhóm phân loại", "Thêm phân loại"]);
      if (!add) throw new Error("Không thấy nút thêm nhóm phân loại.");
      add.click(); await sleep(300);
    }
    const panels = variationPanels();
    for (let i = 0; i < plan.listing.groups.length; i++) {
      const group = plan.listing.groups[i];
      const panel = panels[i];
      const nameInput = panel.querySelector(".variation-name-panel input");
      const optionInput = panel.querySelector(".variation-option-panel input");
      if (!nameInput || !optionInput) throw new Error("Không thấy ô tên/tùy chọn phân loại " + (i + 1) + ".");
      setNativeValue(nameInput, group.name);
      for (let n = 0; n < group.values.length; n++) {
        setNativeValue(optionInput, group.values[n]);
        optionInput.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", code: "Enter" }));
        optionInput.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Enter", code: "Enter" }));
        await sleep(120);
      }
    }
    await waitFor(() => document.querySelector('[data-product-edit-field-unique-id^="skuModel_"] textarea, [data-product-edit-field-unique-id^="skuModel_"] input'), { timeout: 10000, label: "bảng SKU phân loại" });
    const skuInputs = Array.from(document.querySelectorAll('[data-product-edit-field-unique-id^="skuModel_"] textarea, [data-product-edit-field-unique-id^="skuModel_"] input'));
    skuInputs.forEach((skuInput) => {
      const row = skuInput.closest(".flex.data-group, .second-variation-wrapper") || skuInput.parentElement;
      const values = [visibleText(row.querySelector(".first-variation-cell")), visibleText(row.querySelector(".second-variation-cell"))].filter(Boolean);
      const resolved = plan.rows.find((item) => item.values.length === values.length && item.values.every((value, i) => value === values[i]));
      if (!resolved) return;
      setNativeValue(skuInput, resolved.resolved.sku);
      const stock = row.querySelector('[data-product-edit-field-unique-id^="stockModel_"] input, [data-product-edit-field-unique-id^="stockModel_"] textarea');
      if (stock && !String(stock.value || "").trim()) setNativeValue(stock, "100");
    });
    const imageInputs = Array.from(document.querySelectorAll(".variation-edit-item input[type='file']"));
    if (plan.variationImages.length && imageInputs.length < plan.variationImages.length) throw new Error("Không thấy đủ ô tải ảnh cho từng phân loại 1.");
    for (let i = 0; i < plan.variationImages.length; i++) {
      const dt = new DataTransfer(); dt.items.add(plan.variationImages[i].matches[0]);
      imageInputs[i].files = dt.files;
      imageInputs[i].dispatchEvent(new Event("change", { bubbles: true }));
      await sleep(250);
    }
    progress("B8: đã điền phân loại, SKU và kho trống = 100.");
  }

  async function runFlow() {
    if (running || !picked) return;
    running = true;
    cancelRequested = false;
    setRunningUI(true);
    const progress = addProgressLine;
    const skipped = [];
    try {
      const plan = activePlan || await prepareActivePlan();
      if (!plan.ok) throw new Error(plan.errors.join("\n"));
      if (!squareWrapper()) {
        throw new Error("Không thấy vùng 'Hình ảnh sản phẩm' — hãy mở trang Đăng/Sửa sản phẩm và đợi trang load xong.");
      }
      // Validate lần cuối theo giới hạn thực tế trên trang
      const shopeeErrs = validateAgainstShopee({ cover: picked.cover, gallery: picked.gallery.map((f, i) => ({ num: i + 1, file: f })) });
      if (shopeeErrs.length) throw new Error(shopeeErrs.join("\n"));

      // B1 — xoá ảnh cũ 1:1
      progress("B1: xoá ảnh cũ vùng 1:1…");
      await deleteAllImages(squareWrapper(), "1:1", progress);

      // B2 — upload ảnh bìa
      progress("B2: upload ẢNH BÌA…");
      await uploadFiles(squareWrapper, [picked.cover], "1:1", progress);
      await waitUploadDone(squareWrapper, 1, "1:1", progress);

      // B3 — bật 3:4 + dọn ảnh cũ
      progress("B3: bật vùng ảnh 3:4…");
      const cb = longCheckbox();
      if (!cb) throw new Error("Không thấy checkbox 'Hình ảnh tỷ lệ 3:4' trên trang.");
      if (!cb.checked) {
        cb.click();
        await sleep(300);
      }
      await waitFor(longWrapper, { timeout: 8000, label: "vùng ảnh 3:4 xuất hiện" });
      if (imageBoxes(longWrapper()).length) {
        progress("B3: vùng 3:4 đang có ảnh cũ → xoá…");
        await deleteAllImages(longWrapper(), "3:4", progress);
      }

      // B4 — upload g1..gN
      progress("B4: upload " + picked.gallery.length + " ảnh 3:4…");
      await uploadFiles(longWrapper, picked.gallery, "3:4", progress);

      // B5 — chờ xử lý xong
      await waitUploadDone(longWrapper, picked.gallery.length, "3:4", progress);
      progress("B5: ✓ upload xong toàn bộ.");

      // B6 — crop từng ảnh 3:4
      const total = imageBoxes(longWrapper()).length;
      for (let i = 0; i < total; i++) {
        throwIfCancelled();
        const r = await cropFitOne(longWrapper, i, total, progress);
        if (!r.ok) skipped.push(i + 1);
      }

      if (skipped.length) {
        progress("⚠ HOÀN THÀNH nhưng " + skipped.length + " ảnh chưa fit được (ảnh số " + skipped.join(", ") + ") — chỉnh tay các ảnh này.");
      } else {
        progress("✅ HOÀN THÀNH: 1 ảnh bìa + " + picked.gallery.length + " ảnh 3:4 đã fit full khung. Kiểm tra lại rồi bấm Lưu/Cập nhật của Shopee.");
      }
      await fillTitleAndDescription(plan, progress);
      await fillVariations(plan, progress);
      progress("✅ ĐÃ ĐIỀN NỘI DUNG + PHÂN LOẠI. Kiểm tra lại rồi bấm Lưu/Cập nhật của Shopee.");
    } catch (err) {
      if (err && err.message === "__CANCELLED__") {
        addProgressLine("⏹ Đã huỷ theo yêu cầu. Những bước đã chạy xong vẫn giữ nguyên trên trang.");
      } else {
        console.error("[spu]", err);
        addProgressLine("❌ LỖI: " + (err && err.message ? err.message : String(err)));
        addProgressLine("→ Các bước đã xong vẫn giữ nguyên. Xử lý tay phần còn lại hoặc bấm chạy lại.");
      }
    } finally {
      running = false;
      setRunningUI(false);
    }
  }

  // ────────────────────────────────────────────────────────────
  // Chọn folder (hộp thoại OS qua input webkitdirectory ẩn)
  // ────────────────────────────────────────────────────────────
  function pickFolder() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.setAttribute("webkitdirectory", "");
    inp.setAttribute("directory", "");
    inp.style.display = "none";
    document.body.appendChild(inp);
    inp.addEventListener("change", () => {
      try {
        const files = Array.from(inp.files || []);
        if (!files.length) { renderPicked(null, ["Không có file nào trong folder đã chọn."]); return; }
        const folderName = (files[0].webkitRelativePath || "").split("/")[0] || "(folder)";
        const parsed = parseFolderFiles(files);
        const { errs, warns } = validatePicked(parsed);
        const shopeeErrs = validateAgainstShopee(parsed);
        errs.push.apply(errs, shopeeErrs);
        if (errs.length) {
          picked = null;
          renderPicked(null, errs.concat(warns), folderName);
        } else {
          picked = { cover: parsed.cover, gallery: parsed.gallery.map((g) => g.file), folderName, warns, allFiles: files };
          prepareActivePlan().then((plan) => {
            renderPicked(picked, plan.ok ? warns : warns.concat(plan.errors), folderName);
          });
        }
      } finally {
        inp.remove();
      }
    }, { once: true });
    inp.click();
  }

  // ────────────────────────────────────────────────────────────
  // Panel UI
  // ────────────────────────────────────────────────────────────
  function buildPanel() {
    if (document.getElementById("spu-panel")) return;
    const panel = document.createElement("div");
    panel.id = "spu-panel";
    panel.innerHTML = `
      <div class="spu-header">
        <span class="spu-title">🚀 Shopee Uploader</span>
        <button class="spu-min-btn" title="Thu gọn">_</button>
      </div>
      <div class="spu-body">
        <button id="spu-pick" class="spu-btn spu-primary">📂 Chọn folder ảnh sản phẩm</button>
        <div id="spu-files" class="spu-files"><i>Chưa chọn folder</i></div>
        <button id="spu-run" class="spu-btn spu-primary" style="display:none">▶ Chạy upload + crop</button>
        <button id="spu-cancel" class="spu-btn spu-danger" style="display:none">✕ Huỷ (dừng sau bước hiện tại)</button>
        <div id="spu-progress" class="spu-progress"></div>
      </div>`;
    document.body.appendChild(panel);

    panel.querySelector(".spu-min-btn").addEventListener("click", () => panel.classList.toggle("spu-minimized"));
    panel.querySelector("#spu-pick").addEventListener("click", () => { if (!running) pickFolder(); });
    panel.querySelector("#spu-run").addEventListener("click", runFlow);
    panel.querySelector("#spu-cancel").addEventListener("click", () => {
      cancelRequested = true;
      addProgressLine("⏳ Sẽ dừng sau khi xong thao tác hiện tại…");
    });

    // kéo panel theo header
    const header = panel.querySelector(".spu-header");
    let drag = null;
    header.addEventListener("mousedown", (e) => {
      if (e.target.closest(".spu-min-btn")) return;
      drag = { x: e.clientX, y: e.clientY, top: panel.offsetTop, left: panel.offsetLeft };
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!drag) return;
      panel.style.top = (drag.top + e.clientY - drag.y) + "px";
      panel.style.left = (drag.left + e.clientX - drag.x) + "px";
      panel.style.right = "auto";
    });
    document.addEventListener("mouseup", () => { drag = null; });
  }

  function renderPicked(p, notes, folderName) {
    const el = document.getElementById("spu-files");
    const runBtn = document.getElementById("spu-run");
    if (!el) return;
    let html = "";
    if (folderName) html += `<div class="spu-folder">📁 ${folderName}</div>`;
    if (p) {
      html += `<div class="spu-file spu-cover">1. ${p.cover.name} <b>← ẢNH BÌA (1:1)</b></div>`;
      p.gallery.forEach((f, i) => {
        html += `<div class="spu-file">${i + 2}. ${f.name} <span class="spu-tag34">3:4</span></div>`;
      });
      html += `<div class="spu-sum">Tổng: 1 bìa + ${p.gallery.length} ảnh 3:4</div>`;
      runBtn.style.display = activePlan && activePlan.ok ? "" : "none";
    } else {
      runBtn.style.display = "none";
    }
    (notes || []).forEach((n) => { html += `<div class="spu-note">⚠ ${n}</div>`; });
    if (activePlan && activePlan.ok) {
      html += `<div class="spu-sum">✓ Mapping: ${activePlan.rows.length} SKU · ${activePlan.descriptionFiles.length} ảnh mô tả</div>`;
    }
    el.innerHTML = html || "<i>Chưa chọn folder</i>";
  }

  function addProgressLine(msg) {
    const el = document.getElementById("spu-progress");
    if (!el) return;
    // dòng cùng loại (cùng prefix trước dấu …) thì ghi đè dòng cuối để đỡ spam
    const last = el.lastElementChild;
    const key = msg.split("…")[0];
    if (last && last.getAttribute("data-key") === key && msg.indexOf("…") >= 0) {
      last.textContent = msg;
    } else {
      const div = document.createElement("div");
      div.setAttribute("data-key", key);
      div.textContent = msg;
      el.appendChild(div);
      while (el.children.length > 40) el.removeChild(el.firstChild);
    }
    el.scrollTop = el.scrollHeight;
  }

  function setRunningUI(on) {
    const pick = document.getElementById("spu-pick");
    const run = document.getElementById("spu-run");
    const cancel = document.getElementById("spu-cancel");
    if (pick) pick.disabled = on;
    if (run) { run.disabled = on; run.style.display = on ? "none" : (picked ? "" : "none"); }
    if (cancel) cancel.style.display = on ? "" : "none";
    if (!on) cancelRequested = false;
  }

  // ────────────────────────────────────────────────────────────
  // Boot
  // ────────────────────────────────────────────────────────────
  function boot() {
    buildPanel();
    loadSourceData().then(() => {
      addProgressLine(sourceData ? "Đã nạp dữ liệu Excel — chọn folder để kiểm tra mapping." : "Chưa nạp Excel — bấm icon extension để nạp 2 file.");
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes.spu_source_data) {
        sourceData = changes.spu_source_data.newValue || null;
        activePlan = null;
        addProgressLine(sourceData ? "Dữ liệu Excel đã cập nhật — chọn lại folder để kiểm tra mapping." : "Dữ liệu Excel đã bị xoá.");
      }
    });
    // Gợi ý trạng thái trang
    let tries = 0;
    const t = setInterval(() => {
      tries++;
      if (squareWrapper()) {
        addProgressLine("Sẵn sàng — đã thấy vùng 'Hình ảnh sản phẩm'.");
        clearInterval(t);
      } else if (tries > 40) {
        addProgressLine("Chưa thấy vùng ảnh sản phẩm — hãy mở trang Đăng/Sửa sản phẩm.");
        clearInterval(t);
      }
    }, 500);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
