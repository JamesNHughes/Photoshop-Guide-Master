/* global require */

let entrypoints;
let app;
let constants;
let core;
let localFileSystem;
let action;

/** In-memory guide clipboard. Persists for the duration of the Photoshop session. */
let guideClipboard = null;
let startupDiagnosticShown = false;

async function runCommandWithDiagnostics(commandName, handler) {
  try {
    console.log(`Guide Master: command invoked -> ${commandName}`);
    return await handler();
  } catch (error) {
    console.error(`Guide Master: command failed -> ${commandName}`, error);
    try {
      await core?.showAlert?.({ message: `Guide Master command failed: ${commandName}\n\n${error?.message ?? String(error)}` });
    } catch {
      // Ignore secondary alert failure.
    }
    throw error;
  }
}

// ── Utilities ────────────────────────────────────────────────────────────────

function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function byName(a, b) {
  return String(a?.name ?? "").localeCompare(String(b?.name ?? ""), undefined, { sensitivity: "base" });
}

function toSafeFileNameBase(name) {
  const cleaned = String(name ?? "")
    .trim()
    // Windows reserved characters: < > : " / \ | ? *
    .replace(/[<>:"/\\|?*]+/g, "-")
    // Control chars
    .replace(/[\u0000-\u001F\u007F]+/g, "")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim();

  // Avoid empty or dot-only filenames
  const safe = cleaned.replace(/^\.+$/, "");
  return safe || "guide-preset";
}

function fileNameToPresetName(fileName, fallbackName) {
  const raw = String(fileName ?? "").trim();
  const withoutExt = raw.replace(/\.json$/i, "").trim();
  return withoutExt || String(fallbackName ?? "").trim();
}

function toNumberValue(value) {
  const direct = Number(value);
  if (Number.isFinite(direct)) return direct;

  const nestedValue = Number(value?._value ?? value?.value);
  if (Number.isFinite(nestedValue)) return nestedValue;

  return NaN;
}

function roundValue(value, places = 3) {
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
}

function formatLengthValue(value) {
  const rounded = roundValue(value, 3);
  return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

function makeEl(tag, { cls, text } = {}) {
  const el = globalThis.document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function normalizeDirection(direction) {
  if (direction === constants.Direction.HORIZONTAL || direction === "horizontal") return "horizontal";
  if (direction === constants.Direction.VERTICAL   || direction === "vertical")   return "vertical";
  return direction;
}

function denormalizeDirection(direction) {
  if (direction === "horizontal") return constants.Direction.HORIZONTAL;
  if (direction === "vertical")   return constants.Direction.VERTICAL;
  return direction;
}

function guideKey(guide) {
  const dir   = normalizeDirection(guide.direction);
  const coord = Math.round(Number(guide.coordinate) * 1000) / 1000;
  return `${dir}:${coord}`;
}

function dedupeGuides(guides) {
  const seen = new Set();
  const out = [];
  for (const guide of guides ?? []) {
    const normalized = {
      direction: normalizeDirection(guide?.direction),
      coordinate: Number(guide?.coordinate)
    };
    if (!Number.isFinite(normalized.coordinate)) continue;
    if (normalized.direction !== "horizontal" && normalized.direction !== "vertical") continue;
    const key = guideKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

function mergeGuides(existingGuides, incomingGuides) {
  const existingKeys = new Set((existingGuides ?? []).map(guideKey));
  let mergeAddCount = 0;
  let mergeSkipCount = 0;

  const merged = [...(existingGuides ?? [])];
  for (const guide of incomingGuides ?? []) {
    const key = guideKey(guide);
    if (existingKeys.has(key)) {
      mergeSkipCount += 1;
      continue;
    }
    existingKeys.add(key);
    merged.push(guide);
    mergeAddCount += 1;
  }

  return { merged, mergeAddCount, mergeSkipCount };
}

async function getActiveDocumentId() {
  try {
    const result = await action?.batchPlay?.(
      [{
        _obj: "get",
        _target: [
          { _property: "documentID" },
          { _ref: "document", _enum: "ordinal", _value: "targetEnum" }
        ],
        _options: { dialogOptions: "dontDisplay" }
      }],
      {}
    );

    const documentId = Number(result?.[0]?.documentID ?? result?.[0]?.id ?? result?.[0]?.ID);
    return Number.isFinite(documentId) ? documentId : null;
  } catch {
    return null;
  }
}

function getDocumentById(documentId) {
  if (!Number.isFinite(documentId)) return null;

  const documents = app?.documents;
  const count = Number(documents?.length);
  if (!Number.isFinite(count) || count <= 0) return null;

  for (let index = 0; index < count; index += 1) {
    const document = documents[index];
    try {
      if (Number(document?.id) === documentId) {
        return document;
      }
    } catch {
      // Ignore one bad document proxy and keep scanning.
    }
  }

  return null;
}

async function getActiveDocumentSafely() {
  const documentId = await getActiveDocumentId();
  return getDocumentById(documentId);
}

async function hasOpenDocument() {
  return !!(await getActiveDocumentSafely());
}

function hasLocalFileSystem() {
  return !!localFileSystem;
}

async function requireLocalFileSystem(featureName) {
  if (hasLocalFileSystem()) return true;
  await core.showAlert({
    message: `${featureName} requires UXP local file storage, but it isn't available in this Photoshop/UXP build.`
  });
  return false;
}

function getGuidesSnapshotFromDocument(document) {
  const guides = [];
  const guideCollection = document.guides;
  const lengthValue = guideCollection?.length;
  const count = Number.isFinite(lengthValue) ? lengthValue : null;
  const limit = count ?? 10000;

  for (let index = 0; index < limit; index += 1) {
    const guide = guideCollection?.[index];
    if (!guide) {
      if (count === null) break;
      continue;
    }

    const direction = normalizeDirection(guide.direction);
    const rawCoordinate = guide.coordinate ?? guide.position ?? guide.location;
    const coordinate = Number(rawCoordinate);

    if (!Number.isFinite(coordinate)) continue;
    guides.push({ direction, coordinate });
  }

  return guides;
}

function getDocumentWidth(document) {
  return toNumberValue(document?.width);
}

function getDocumentHeight(document) {
  return toNumberValue(document?.height);
}

function getDocumentResolution(document) {
  return toNumberValue(document?.resolution);
}

function normalizeDocumentSpec(specLike) {
  const width = Number(specLike?.width);
  const height = Number(specLike?.height);
  const resolution = Number(specLike?.resolution);
  if (!Number.isFinite(width) || width <= 0) return null;
  if (!Number.isFinite(height) || height <= 0) return null;
  if (!Number.isFinite(resolution) || resolution <= 0) return null;
  return {
    width: roundValue(width, 3),
    height: roundValue(height, 3),
    resolution: roundValue(resolution, 3)
  };
}

function getDocumentSpec(document) {
  return normalizeDocumentSpec({
    width: getDocumentWidth(document),
    height: getDocumentHeight(document),
    resolution: getDocumentResolution(document)
  });
}

function formatDocumentSpec(spec) {
  const normalized = normalizeDocumentSpec(spec);
  if (!normalized) return "Unknown size";
  return `${formatLengthValue(normalized.width)} x ${formatLengthValue(normalized.height)} px @ ${formatLengthValue(normalized.resolution)} dpi`;
}

function documentSpecsDiffer(left, right) {
  const source = normalizeDocumentSpec(left);
  const target = normalizeDocumentSpec(right);
  if (!source || !target) return false;
  return source.width !== target.width || source.height !== target.height || source.resolution !== target.resolution;
}

function scaleGuidesToDocumentLayout(guides, sourceDocument, targetDocument) {
  const source = normalizeDocumentSpec(sourceDocument);
  const target = normalizeDocumentSpec(targetDocument);
  if (!source || !target) return dedupeGuides(guides ?? []);

  const widthScale = target.width / source.width;
  const heightScale = target.height / source.height;
  if (!Number.isFinite(widthScale) || widthScale <= 0 || !Number.isFinite(heightScale) || heightScale <= 0) {
    return dedupeGuides(guides ?? []);
  }

  return dedupeGuides((guides ?? []).map((guide) => {
    const direction = normalizeDirection(guide?.direction);
    const coordinate = Number(guide?.coordinate);
    if (!Number.isFinite(coordinate)) return null;

    const limit = direction === "vertical" ? target.width : target.height;
    const scaled = direction === "vertical" ? coordinate * widthScale : coordinate * heightScale;
    const clamped = Math.max(0, Math.min(limit, scaled));
    return { direction, coordinate: roundValue(clamped, 3) };
  }).filter(Boolean));
}

function normalizeRulerUnit(rawUnit) {
  const text = String(rawUnit?._value ?? rawUnit?._enum ?? rawUnit ?? "").toLowerCase();
  if (!text) return { key: "px", label: "px", displayName: "pixels" };
  if (text.includes("pixel")) return { key: "px", label: "px", displayName: "pixels" };
  if (text.includes("inch")) return { key: "in", label: "in", displayName: "inches" };
  if (text.includes("millimeter") || text.includes("millimetre") || text.includes("mm")) return { key: "mm", label: "mm", displayName: "millimeters" };
  if (text.includes("centimeter") || text.includes("centimetre") || text.includes("cm")) return { key: "cm", label: "cm", displayName: "centimeters" };
  if (text.includes("point")) return { key: "pt", label: "pt", displayName: "points" };
  if (text.includes("pica")) return { key: "pc", label: "pc", displayName: "picas" };
  return { key: "px", label: "px", displayName: "pixels" };
}

async function getCurrentRulerUnit() {
  try {
    const directUnit = app?.preferences?.unitsAndRulers?.rulerUnits;
    if (directUnit) return normalizeRulerUnit(directUnit);
  } catch {
    // Fall through to batchPlay.
  }

  try {
    const result = await action?.batchPlay?.(
      [{
        _obj: "get",
        _target: [
          { _property: "rulerUnits" },
          { _ref: "application", _enum: "ordinal", _value: "targetEnum" }
        ],
        _options: { dialogOptions: "dontDisplay" }
      }],
      {}
    );
    return normalizeRulerUnit(result?.[0]?.rulerUnits);
  } catch {
    return { key: "px", label: "px", displayName: "pixels" };
  }
}

function convertLengthToPixels(lengthValue, unitKey, resolution) {
  const value = Number(lengthValue);
  const dpi = Number(resolution);

  if (!Number.isFinite(value)) return NaN;
  if (unitKey === "px") return value;
  if (!Number.isFinite(dpi) || dpi <= 0) return NaN;

  switch (unitKey) {
    case "in": return value * dpi;
    case "cm": return value * dpi / 2.54;
    case "mm": return value * dpi / 25.4;
    case "pt": return value * dpi / 72;
    case "pc": return value * dpi / 6;
    default: return value;
  }
}

function convertPixelsToUnit(pixelValue, unitKey, resolution) {
  const value = Number(pixelValue);
  const dpi = Number(resolution);

  if (!Number.isFinite(value)) return NaN;
  if (unitKey === "px") return value;
  if (!Number.isFinite(dpi) || dpi <= 0) return NaN;

  switch (unitKey) {
    case "in": return value / dpi;
    case "cm": return value * 2.54 / dpi;
    case "mm": return value * 25.4 / dpi;
    case "pt": return value * 72 / dpi;
    case "pc": return value * 6 / dpi;
    default: return value;
  }
}

function getLengthLabel(baseLabel, unitKey) {
  const suffix = unitKey === "px" ? "px" : unitKey;
  return `${baseLabel} (${suffix})`;
}

function suggestSpacingValues(totalLength, segmentCount) {
  const length = Number(totalLength);
  const count = Math.max(1, Math.trunc(Number(segmentCount) || 1));
  if (!Number.isFinite(length) || length <= 0) {
    return { gutter: 0, margin: 0 };
  }

  const maxSuggestedMargin = length / Math.max(count * 3, 6);
  const maxSuggestedGutter = length / Math.max(count * 6, 12);

  const margin = Math.max(0, Math.round(Math.min(length * 0.05, maxSuggestedMargin)));
  const gutter = count <= 1 ? 0 : Math.max(0, Math.round(Math.min(length * 0.02, maxSuggestedGutter)));

  return { gutter, margin };
}

function buildSegmentGuides(direction, totalLength, segmentCount, gutterWidth, startMargin = 0, endMargin = 0, segmentLabel = "segments") {
  const length = Number(totalLength);
  const count = Math.trunc(Number(segmentCount));
  const gutter = Number(gutterWidth);
  const leadingMargin = Number(startMargin);
  const trailingMargin = Number(endMargin);

  if (!Number.isFinite(length) || length <= 0) {
    throw new Error(`Could not read the active document ${direction === "vertical" ? "width" : "height"}.`);
  }
  if (!Number.isFinite(count) || count < 1) {
    throw new Error(`${segmentLabel.charAt(0).toUpperCase()}${segmentLabel.slice(1)} must be 1 or greater.`);
  }
  if (!Number.isFinite(gutter) || gutter < 0) {
    throw new Error("Gutter must be 0 or greater.");
  }
  if (!Number.isFinite(leadingMargin) || leadingMargin < 0) {
    throw new Error(`${direction === "vertical" ? "Left" : "Top"} margin must be 0 or greater.`);
  }
  if (!Number.isFinite(trailingMargin) || trailingMargin < 0) {
    throw new Error(`${direction === "vertical" ? "Right" : "Bottom"} margin must be 0 or greater.`);
  }

  const totalGutter = gutter * Math.max(count - 1, 0);
  const usableLength = length - leadingMargin - trailingMargin - totalGutter;
  if (usableLength <= 0) {
    throw new Error("Margins, segments, and gutters exceed the document size.");
  }

  const segmentLength = usableLength / count;
  const guides = [];
  let cursor = leadingMargin;

  for (let index = 0; index < count; index += 1) {
    guides.push({ direction, coordinate: cursor });
    cursor += segmentLength;
    guides.push({ direction, coordinate: cursor });
    if (index < count - 1) cursor += gutter;
  }

  return dedupeGuides(guides);
}

function buildColumnGuides(documentWidth, columnCount, gutterWidth, leftMarginWidth = 0, rightMarginWidth = 0) {
  return buildSegmentGuides("vertical", documentWidth, columnCount, gutterWidth, leftMarginWidth, rightMarginWidth, "columns");
}

function buildRowGuides(documentHeight, rowCount, gutterHeight, topMarginHeight = 0, bottomMarginHeight = 0) {
  return buildSegmentGuides("horizontal", documentHeight, rowCount, gutterHeight, topMarginHeight, bottomMarginHeight, "rows");
}

function buildGridGuides(options) {
  const verticalGuides = buildColumnGuides(
    options.documentWidth,
    options.columnCount,
    options.columnGutterWidth,
    options.leftMarginWidth,
    options.rightMarginWidth
  );
  const horizontalGuides = buildRowGuides(
    options.documentHeight,
    options.rowCount,
    options.rowGutterHeight,
    options.topMarginHeight,
    options.bottomMarginHeight
  );
  return dedupeGuides([...verticalGuides, ...horizontalGuides]);
}

// ── Merge / Replace dialog ───────────────────────────────────────────────────

async function askMergeOrReplace({ existingGuideCount, pasteGuideCount, mergeAddCount, mergeSkipCount }) {
  return askMergeOrReplaceWithOptions({
    title: "Paste Guides",
    sourceLabel: "Clipboard",
    targetLabel: "Document",
    existingGuideCount,
    pasteGuideCount,
    mergeAddCount,
    mergeSkipCount,
    replaceLabel: "Replace",
    mergeLabel: "Merge"
  });
}

async function askMergeOrReplaceWithOptions({
  title,
  sourceLabel,
  targetLabel,
  existingGuideCount,
  pasteGuideCount,
  mergeAddCount,
  mergeSkipCount,
  replaceLabel,
  mergeLabel
}) {
  const domDocument = globalThis.document;
  if (!domDocument?.createElement) return "replace";

  const dialog = makeEl("dialog", { cls: "cpg-dialog" });
  const header = makeEl("div", { cls: "cpg-dialog__header" });
  header.appendChild(makeEl("span", { cls: "cpg-dialog__title", text: title ?? "Choose" }));

  const infoGrid = makeEl("div", { cls: "cpg-info-grid" });

  const sourceRow = makeEl("div", { cls: "cpg-info-row" });
  sourceRow.appendChild(makeEl("span", { cls: "cpg-info-label", text: sourceLabel ?? "Source" }));
  sourceRow.appendChild(makeEl("span", { cls: "cpg-info-value", text: plural(pasteGuideCount, "guide") }));

  const targetRow = makeEl("div", { cls: "cpg-info-row" });
  targetRow.appendChild(makeEl("span", { cls: "cpg-info-label", text: targetLabel ?? "Target" }));
  targetRow.appendChild(makeEl("span", { cls: "cpg-info-value", text: plural(existingGuideCount, "guide") }));

  infoGrid.append(sourceRow, targetRow);

  const actions = makeEl("div", { cls: "cpg-action-section" });
  const mergeDesc = mergeSkipCount > 0
    ? `add ${plural(mergeAddCount, "guide")}, skip ${plural(mergeSkipCount, "duplicate")}`
    : `add ${plural(mergeAddCount, "guide")}`;

  const mergeRow = makeEl("div", { cls: "cpg-action-row" });
  mergeRow.appendChild(makeEl("strong", { text: mergeLabel ?? "Merge" }));
  mergeRow.appendChild(domDocument.createTextNode(` — ${mergeDesc}`));

  const replaceRow = makeEl("div", { cls: "cpg-action-row" });
  replaceRow.appendChild(makeEl("strong", { text: replaceLabel ?? "Replace" }));
  replaceRow.appendChild(domDocument.createTextNode(` — remove existing, use ${plural(pasteGuideCount, "guide")}`));

  actions.append(mergeRow, replaceRow);

  const body = makeEl("div", { cls: "cpg-dialog__body" });
  body.append(infoGrid, actions);

  const footer = makeEl("div", { cls: "cpg-dialog__footer" });
  const cancelBtn = makeEl("button", { text: "Cancel" });
  cancelBtn.setAttribute("uxp-variant", "secondary");
  cancelBtn.addEventListener("click", () => dialog.close("cancel"));

  const mergeBtn = makeEl("button", { text: mergeLabel ?? "Merge" });
  mergeBtn.setAttribute("uxp-variant", "primary");
  mergeBtn.addEventListener("click", () => dialog.close("merge"));

  const replaceBtn = makeEl("button", { text: replaceLabel ?? "Replace" });
  replaceBtn.setAttribute("uxp-variant", "cta");
  replaceBtn.addEventListener("click", () => dialog.close("replace"));

  footer.append(cancelBtn, mergeBtn, replaceBtn);
  dialog.append(header, body, footer);
  domDocument.body.appendChild(dialog);

  const waitForClose = new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true });
  });

  try {
    dialog.showModal();
    const result = await waitForClose;
    return result === "merge" || result === "replace" ? result : null;
  } finally {
    try { dialog.close(); } catch { /* already closed */ }
    dialog.remove();
  }
}

async function askTextInput({ title, label, defaultValue = "", okText = "OK" }) {
  const domDocument = globalThis.document;
  if (!domDocument?.createElement) return null;

  const dialog = makeEl("dialog", { cls: "cpg-dialog" });
  const header = makeEl("div", { cls: "cpg-dialog__header" });
  header.appendChild(makeEl("span", { cls: "cpg-dialog__title", text: title ?? "Input" }));

  const body = makeEl("div", { cls: "cpg-dialog__body" });
  if (label) body.appendChild(makeEl("div", { cls: "cpg-field-label", text: label }));

  const input = makeEl("input", { cls: "cpg-text-input" });
  input.type = "text";
  input.value = defaultValue;
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") dialog.close("ok");
  });
  body.appendChild(input);

  const footer = makeEl("div", { cls: "cpg-dialog__footer" });
  const cancelBtn = makeEl("button", { text: "Cancel" });
  cancelBtn.setAttribute("uxp-variant", "secondary");
  cancelBtn.addEventListener("click", () => dialog.close("cancel"));

  const okBtn = makeEl("button", { text: okText });
  okBtn.setAttribute("uxp-variant", "cta");
  okBtn.addEventListener("click", () => dialog.close("ok"));

  footer.append(cancelBtn, okBtn);
  dialog.append(header, body, footer);
  domDocument.body.appendChild(dialog);

  const waitForClose = new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true });
  });

  try {
    dialog.showModal();
    input.focus();
    input.select();
    const result = await waitForClose;
    if (result !== "ok") return null;
    const value = String(input.value ?? "").trim();
    return value.length ? value : null;
  } finally {
    try { dialog.close(); } catch { /* ignore */ }
    dialog.remove();
  }
}

async function askConfirm({ title, message, okText = "OK", okVariant = "cta" }) {
  const domDocument = globalThis.document;
  if (!domDocument?.createElement) return false;

  const dialog = makeEl("dialog", { cls: "cpg-dialog" });
  const header = makeEl("div", { cls: "cpg-dialog__header" });
  header.appendChild(makeEl("span", { cls: "cpg-dialog__title", text: title ?? "Confirm" }));

  const body = makeEl("div", { cls: "cpg-dialog__body" });
  body.appendChild(makeEl("div", { cls: "cpg-action-section", text: message ?? "" }));

  const footer = makeEl("div", { cls: "cpg-dialog__footer" });
  const cancelBtn = makeEl("button", { text: "Cancel" });
  cancelBtn.setAttribute("uxp-variant", "secondary");
  cancelBtn.addEventListener("click", () => dialog.close("cancel"));

  const okBtn = makeEl("button", { text: okText });
  okBtn.setAttribute("uxp-variant", okVariant);
  okBtn.addEventListener("click", () => dialog.close("ok"));

  footer.append(cancelBtn, okBtn);
  dialog.append(header, body, footer);
  domDocument.body.appendChild(dialog);

  const waitForClose = new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true });
  });

  try {
    dialog.showModal();
    const result = await waitForClose;
    return result === "ok";
  } finally {
    try { dialog.close(); } catch { /* ignore */ }
    dialog.remove();
  }
}

async function askCreateGuideType() {
  const domDocument = globalThis.document;
  if (!domDocument?.createElement) return null;

  const dialog = makeEl("dialog", { cls: "cpg-dialog" });
  const header = makeEl("div", { cls: "cpg-dialog__header" });
  header.appendChild(makeEl("span", { cls: "cpg-dialog__title", text: "Create Guides" }));

  const body = makeEl("div", { cls: "cpg-dialog__body" });
  body.appendChild(makeEl("div", { cls: "cpg-muted", text: "Choose a guide layout to generate." }));

  const label = makeEl("div", { cls: "cpg-field-label", text: "Guide type" });
  const select = makeEl("select", { cls: "cpg-select" });
  const options = [
    ["columns", "Columns"],
    ["rows", "Rows"],
    ["grid", "Grid"]
  ];
  for (const [value, text] of options) {
    const option = makeEl("option", { text });
    option.value = value;
    select.appendChild(option);
  }
  select.value = "columns";
  body.append(label, select);

  const footer = makeEl("div", { cls: "cpg-dialog__footer" });
  const cancelBtn = makeEl("button", { text: "Cancel" });
  cancelBtn.setAttribute("uxp-variant", "secondary");
  cancelBtn.addEventListener("click", () => dialog.close("cancel"));
  const continueBtn = makeEl("button", { text: "Continue" });
  continueBtn.setAttribute("uxp-variant", "cta");
  continueBtn.addEventListener("click", () => dialog.close("ok"));
  footer.append(cancelBtn, continueBtn);

  dialog.append(header, body, footer);
  domDocument.body.appendChild(dialog);

  const waitForClose = new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue || "cancel"), { once: true });
  });

  try {
    dialog.showModal();
    const result = await waitForClose;
    if (result !== "ok") return null;
    return String(select.value ?? "columns");
  } finally {
    try { dialog.close(); } catch { /* ignore */ }
    dialog.remove();
  }
}

async function askCreateLayoutOptions(initialLayoutType, documentWidth, documentHeight, rulerUnit, documentResolution) {
  const domDocument = globalThis.document;
  if (!domDocument?.createElement) return null;

  const dialog = makeEl("dialog", { cls: "cpg-dialog cpg-dialog--wide" });
  const header = makeEl("div", { cls: "cpg-dialog__header" });
  header.appendChild(makeEl("span", { cls: "cpg-dialog__title", text: "Create Guides" }));

  const body = makeEl("div", { cls: "cpg-dialog__body" });
  body.appendChild(makeEl("div", { cls: "cpg-muted", text: "Choose a layout, then tune counts, gutters, and margins." }));

  const shell = makeEl("div", { cls: "cpg-create-shell" });

  const overviewSection = makeEl("div", { cls: "cpg-section-card" });
  overviewSection.appendChild(makeEl("div", { cls: "cpg-section-card__title", text: "Overview" }));
  const overviewMeta = makeEl("div", { cls: "cpg-section-card__meta", text: "Choose layout type and spacing units first." });
  overviewSection.appendChild(overviewMeta);

  const layoutTypeWrap = makeEl("div", { cls: "cpg-field-stack__item" });
  layoutTypeWrap.appendChild(makeEl("div", { cls: "cpg-field-label", text: "Layout type" }));
  const layoutTypeSelect = makeEl("select", { cls: "cpg-select" });
  for (const [value, text] of [["columns", "Columns"], ["rows", "Rows"], ["grid", "Grid"]]) {
    const option = makeEl("option", { text });
    option.value = value;
    layoutTypeSelect.appendChild(option);
  }
  layoutTypeSelect.value = initialLayoutType ?? "columns";
  layoutTypeWrap.appendChild(layoutTypeSelect);

  const unitsWrap = makeEl("div", { cls: "cpg-field-stack__item" });
  unitsWrap.appendChild(makeEl("div", { cls: "cpg-field-label", text: "Spacing units" }));
  const unitsSelect = makeEl("select", { cls: "cpg-select" });
  const pixelsOption = makeEl("option", { text: "Pixels (px)" });
  pixelsOption.value = "px";
  unitsSelect.appendChild(pixelsOption);
  if (rulerUnit.key !== "px") {
    const systemOption = makeEl("option", { text: `Photoshop ruler units (${rulerUnit.label})` });
    systemOption.value = rulerUnit.key;
    unitsSelect.appendChild(systemOption);
  }
  unitsSelect.value = rulerUnit.key === "px" ? "px" : rulerUnit.key;
  unitsWrap.appendChild(unitsSelect);

  const dimensionSummary = makeEl("div", { cls: "cpg-section-card__meta" });
  const unitsHelp = makeEl("div", { cls: "cpg-muted" });
  overviewSection.append(layoutTypeWrap, unitsWrap, dimensionSummary, unitsHelp);

  const structureSection = makeEl("div", { cls: "cpg-section-card" });
  structureSection.appendChild(makeEl("div", { cls: "cpg-section-card__title", text: "Structure" }));
  const structureMeta = makeEl("div", { cls: "cpg-section-card__meta", text: "Counts drive the suggested spacing values." });
  structureSection.appendChild(structureMeta);

  const countsRow = makeEl("div", { cls: "cpg-inline-pair" });
  const columnsWrap = makeEl("div", { cls: "cpg-inline-pair__item" });
  columnsWrap.appendChild(makeEl("div", { cls: "cpg-field-label", text: "Columns" }));
  const columnsInput = makeEl("input", { cls: "cpg-text-input" });
  columnsInput.type = "text";
  columnsInput.inputMode = "numeric";
  columnsInput.value = "12";
  columnsWrap.appendChild(columnsInput);

  const rowsWrap = makeEl("div", { cls: "cpg-inline-pair__item" });
  rowsWrap.appendChild(makeEl("div", { cls: "cpg-field-label", text: "Rows" }));
  const rowsInput = makeEl("input", { cls: "cpg-text-input" });
  rowsInput.type = "text";
  rowsInput.inputMode = "numeric";
  rowsInput.value = "12";
  rowsWrap.appendChild(rowsInput);
  countsRow.append(columnsWrap, rowsWrap);

  const guttersRow = makeEl("div", { cls: "cpg-inline-pair" });
  const gutterWrap = makeEl("div", { cls: "cpg-inline-pair__item" });
  const gutterLabel = makeEl("div", { cls: "cpg-field-label" });
  gutterWrap.appendChild(gutterLabel);
  const gutterInput = makeEl("input", { cls: "cpg-text-input" });
  gutterInput.type = "text";
  gutterInput.inputMode = "decimal";
  gutterInput.value = "20";
  gutterWrap.appendChild(gutterInput);

  const rowGutterWrap = makeEl("div", { cls: "cpg-inline-pair__item" });
  const rowGutterLabel = makeEl("div", { cls: "cpg-field-label" });
  rowGutterWrap.appendChild(rowGutterLabel);
  const rowGutterInput = makeEl("input", { cls: "cpg-text-input" });
  rowGutterInput.type = "text";
  rowGutterInput.inputMode = "decimal";
  rowGutterInput.value = "20";
  rowGutterWrap.appendChild(rowGutterInput);
  guttersRow.append(gutterWrap, rowGutterWrap);
  structureSection.append(countsRow, guttersRow);

  const marginsSection = makeEl("div", { cls: "cpg-section-card" });
  marginsSection.appendChild(makeEl("div", { cls: "cpg-section-card__title", text: "Margins" }));
  marginsSection.appendChild(makeEl("div", { cls: "cpg-section-card__meta", text: "Suggested values update from counts until you override them." }));

  const horizontalMarginsRow = makeEl("div", { cls: "cpg-inline-pair" });
  const leftMarginWrap = makeEl("div", { cls: "cpg-inline-pair__item" });
  const leftMarginLabel = makeEl("div", { cls: "cpg-field-label" });
  leftMarginWrap.appendChild(leftMarginLabel);
  const leftMarginInput = makeEl("input", { cls: "cpg-text-input" });
  leftMarginInput.type = "text";
  leftMarginInput.inputMode = "decimal";
  leftMarginInput.value = "0";
  leftMarginWrap.appendChild(leftMarginInput);

  const rightMarginWrap = makeEl("div", { cls: "cpg-inline-pair__item" });
  const rightMarginLabel = makeEl("div", { cls: "cpg-field-label" });
  rightMarginWrap.appendChild(rightMarginLabel);
  const rightMarginInput = makeEl("input", { cls: "cpg-text-input" });
  rightMarginInput.type = "text";
  rightMarginInput.inputMode = "decimal";
  rightMarginInput.value = "0";
  rightMarginWrap.appendChild(rightMarginInput);
  horizontalMarginsRow.append(leftMarginWrap, rightMarginWrap);

  const verticalMarginsRow = makeEl("div", { cls: "cpg-inline-pair" });
  const topMarginWrap = makeEl("div", { cls: "cpg-inline-pair__item" });
  const topMarginLabel = makeEl("div", { cls: "cpg-field-label" });
  topMarginWrap.appendChild(topMarginLabel);
  const topMarginInput = makeEl("input", { cls: "cpg-text-input" });
  topMarginInput.type = "text";
  topMarginInput.inputMode = "decimal";
  topMarginInput.value = "0";
  topMarginWrap.appendChild(topMarginInput);

  const bottomMarginWrap = makeEl("div", { cls: "cpg-inline-pair__item" });
  const bottomMarginLabel = makeEl("div", { cls: "cpg-field-label" });
  bottomMarginWrap.appendChild(bottomMarginLabel);
  const bottomMarginInput = makeEl("input", { cls: "cpg-text-input" });
  bottomMarginInput.type = "text";
  bottomMarginInput.inputMode = "decimal";
  bottomMarginInput.value = "0";
  bottomMarginWrap.appendChild(bottomMarginInput);
  verticalMarginsRow.append(topMarginWrap, bottomMarginWrap);
  marginsSection.append(horizontalMarginsRow, verticalMarginsRow);

  const validationMessage = makeEl("div", { cls: "cpg-validation-message" });
  shell.append(overviewSection, structureSection, marginsSection);
  body.append(shell, validationMessage);

  const fieldConfigs = [
    { key: "gutterWidth", input: gutterInput },
    { key: "rowGutterHeight", input: rowGutterInput },
    { key: "leftMarginWidth", input: leftMarginInput },
    { key: "rightMarginWidth", input: rightMarginInput },
    { key: "topMarginHeight", input: topMarginInput },
    { key: "bottomMarginHeight", input: bottomMarginInput }
  ];
  const dirtyState = Object.fromEntries(fieldConfigs.map(({ key }) => [key, false]));
  let currentUnitKey = String(unitsSelect.value ?? "px");

  const getLayoutFlags = () => {
    const selectedLayout = String(layoutTypeSelect.value ?? "columns");
    return {
      isColumns: selectedLayout === "columns",
      isRows: selectedLayout === "rows",
      isGrid: selectedLayout === "grid"
    };
  };

  const syncOverviewCopy = () => {
    const { isColumns, isRows, isGrid } = getLayoutFlags();
    const widthInSystemUnits = convertPixelsToUnit(documentWidth, rulerUnit.key, documentResolution);
    const heightInSystemUnits = convertPixelsToUnit(documentHeight, rulerUnit.key, documentResolution);
    dimensionSummary.textContent = isRows
      ? (Number.isFinite(heightInSystemUnits) && rulerUnit.key !== "px"
          ? `Document height: ${roundValue(documentHeight)}px (${roundValue(heightInSystemUnits)} ${rulerUnit.label})`
          : `Document height: ${roundValue(documentHeight)}px`)
      : isGrid
        ? `Document: ${roundValue(documentWidth)}px x ${roundValue(documentHeight)}px${rulerUnit.key !== "px" && Number.isFinite(widthInSystemUnits) && Number.isFinite(heightInSystemUnits) ? ` (${roundValue(widthInSystemUnits)} ${rulerUnit.label} x ${roundValue(heightInSystemUnits)} ${rulerUnit.label})` : ""}`
        : (Number.isFinite(widthInSystemUnits) && rulerUnit.key !== "px"
            ? `Document width: ${roundValue(documentWidth)}px (${roundValue(widthInSystemUnits)} ${rulerUnit.label})`
            : `Document width: ${roundValue(documentWidth)}px`);
    unitsHelp.textContent = rulerUnit.key === "px"
      ? "Photoshop is currently using pixels."
      : `System unit values use Photoshop's current ruler units: ${rulerUnit.displayName}.`;
    overviewMeta.textContent = isGrid
      ? "Choose layout type and spacing units first. Grid uses both axes."
      : "Choose layout type and spacing units first.";
    structureMeta.textContent = isGrid
      ? "Columns and rows share the same compact layout, with separate gutters for each axis."
      : "Counts drive the suggested spacing values.";
  };

  const syncSectionVisibility = () => {
    const { isColumns, isRows, isGrid } = getLayoutFlags();
    columnsWrap.style.display = isColumns || isGrid ? "block" : "none";
    rowsWrap.style.display = isRows || isGrid ? "block" : "none";
    rowGutterWrap.style.display = isGrid ? "block" : "none";
    leftMarginWrap.style.display = isColumns || isGrid ? "block" : "none";
    rightMarginWrap.style.display = isColumns || isGrid ? "block" : "none";
    topMarginWrap.style.display = isRows || isGrid ? "block" : "none";
    bottomMarginWrap.style.display = isRows || isGrid ? "block" : "none";
  };

  const syncUnitLabels = () => {
    const unitKey = String(unitsSelect.value ?? "px");
    const { isRows } = getLayoutFlags();
    gutterLabel.textContent = getLengthLabel(isRows ? "Row gutter" : "Column gutter", unitKey);
    rowGutterLabel.textContent = getLengthLabel("Row gutter", unitKey);
    leftMarginLabel.textContent = getLengthLabel("Left margin", unitKey);
    rightMarginLabel.textContent = getLengthLabel("Right margin", unitKey);
    topMarginLabel.textContent = getLengthLabel("Top margin", unitKey);
    bottomMarginLabel.textContent = getLengthLabel("Bottom margin", unitKey);
  };

  const updateAutoFields = () => {
    const columnSuggestionPx = suggestSpacingValues(documentWidth, toNumberValue(columnsInput.value));
    const rowSuggestionPx = suggestSpacingValues(documentHeight, toNumberValue(rowsInput.value));
    const selectedUnitKey = String(unitsSelect.value ?? "px");
    const suggestions = {
      gutterWidth: convertPixelsToUnit(columnSuggestionPx.gutter, selectedUnitKey, documentResolution),
      rowGutterHeight: convertPixelsToUnit(rowSuggestionPx.gutter, selectedUnitKey, documentResolution),
      leftMarginWidth: convertPixelsToUnit(columnSuggestionPx.margin, selectedUnitKey, documentResolution),
      rightMarginWidth: convertPixelsToUnit(columnSuggestionPx.margin, selectedUnitKey, documentResolution),
      topMarginHeight: convertPixelsToUnit(rowSuggestionPx.margin, selectedUnitKey, documentResolution),
      bottomMarginHeight: convertPixelsToUnit(rowSuggestionPx.margin, selectedUnitKey, documentResolution)
    };

    for (const { key, input } of fieldConfigs) {
      if (dirtyState[key]) continue;
      const suggestedValue = suggestions[key];
      input.value = Number.isFinite(suggestedValue) ? formatLengthValue(suggestedValue) : "0";
    }
  };

  const validateLayout = () => {
    const selectedUnitKey = String(unitsSelect.value ?? "px");
    const { isColumns, isRows } = getLayoutFlags();
    try {
      const gutterInPixels = convertLengthToPixels(toNumberValue(gutterInput.value), selectedUnitKey, documentResolution);
      const rowGutterInPixels = convertLengthToPixels(toNumberValue(rowGutterInput.value), selectedUnitKey, documentResolution);
      const leftMarginInPixels = convertLengthToPixels(toNumberValue(leftMarginInput.value), selectedUnitKey, documentResolution);
      const rightMarginInPixels = convertLengthToPixels(toNumberValue(rightMarginInput.value), selectedUnitKey, documentResolution);
      const topMarginInPixels = convertLengthToPixels(toNumberValue(topMarginInput.value), selectedUnitKey, documentResolution);
      const bottomMarginInPixels = convertLengthToPixels(toNumberValue(bottomMarginInput.value), selectedUnitKey, documentResolution);

      if (
        !Number.isFinite(gutterInPixels) ||
        !Number.isFinite(rowGutterInPixels) ||
        !Number.isFinite(leftMarginInPixels) ||
        !Number.isFinite(rightMarginInPixels) ||
        !Number.isFinite(topMarginInPixels) ||
        !Number.isFinite(bottomMarginInPixels)
      ) {
        throw new Error(`Could not convert the entered values from ${selectedUnitKey} to pixels.`);
      }

      let generatedGuides = [];
      if (isColumns) {
        generatedGuides = buildColumnGuides(documentWidth, toNumberValue(columnsInput.value), gutterInPixels, leftMarginInPixels, rightMarginInPixels);
      } else if (isRows) {
        generatedGuides = buildRowGuides(documentHeight, toNumberValue(rowsInput.value), gutterInPixels, topMarginInPixels, bottomMarginInPixels);
      } else {
        generatedGuides = buildGridGuides({
          documentWidth,
          documentHeight,
          columnCount: toNumberValue(columnsInput.value),
          rowCount: toNumberValue(rowsInput.value),
          columnGutterWidth: gutterInPixels,
          rowGutterHeight: rowGutterInPixels,
          leftMarginWidth: leftMarginInPixels,
          rightMarginWidth: rightMarginInPixels,
          topMarginHeight: topMarginInPixels,
          bottomMarginHeight: bottomMarginInPixels
        });
      }

      createBtn.disabled = false;
      validationMessage.textContent = `Layout valid: ${plural(generatedGuides.length, "guide")} will be created.`;
      validationMessage.setAttribute("data-state", "valid");
    } catch (error) {
      createBtn.disabled = true;
      validationMessage.textContent = error?.message ?? String(error);
      validationMessage.setAttribute("data-state", "invalid");
    }
  };

  const convertFieldValuesToUnit = (nextUnitKey) => {
    for (const { input } of fieldConfigs) {
      const currentValue = toNumberValue(input.value);
      const pixelValue = convertLengthToPixels(currentValue, currentUnitKey, documentResolution);
      const convertedValue = convertPixelsToUnit(pixelValue, nextUnitKey, documentResolution);
      input.value = Number.isFinite(convertedValue) ? formatLengthValue(convertedValue) : input.value;
    }
    currentUnitKey = nextUnitKey;
  };

  unitsSelect.addEventListener("change", () => {
    const nextUnitKey = String(unitsSelect.value ?? "px");
    convertFieldValuesToUnit(nextUnitKey);
    syncUnitLabels();
    updateAutoFields();
    validateLayout();
  });

  layoutTypeSelect.addEventListener("change", () => {
    syncOverviewCopy();
    syncSectionVisibility();
    syncUnitLabels();
    updateAutoFields();
    validateLayout();
  });

  for (const { key, input } of fieldConfigs) {
    input.addEventListener("input", () => {
      dirtyState[key] = true;
      validateLayout();
    });
  }
  columnsInput.addEventListener("input", () => { updateAutoFields(); validateLayout(); });
  rowsInput.addEventListener("input", () => { updateAutoFields(); validateLayout(); });

  const footer = makeEl("div", { cls: "cpg-dialog__footer" });
  const cancelBtn = makeEl("button", { text: "Cancel" });
  cancelBtn.setAttribute("uxp-variant", "secondary");
  cancelBtn.addEventListener("click", () => dialog.close("cancel"));
  const createBtn = makeEl("button", { text: "Create" });
  createBtn.setAttribute("uxp-variant", "cta");
  createBtn.addEventListener("click", () => dialog.close("create"));
  footer.append(cancelBtn, createBtn);

  dialog.append(header, body, footer);
  domDocument.body.appendChild(dialog);

  syncOverviewCopy();
  syncSectionVisibility();
  syncUnitLabels();
  updateAutoFields();
  validateLayout();

  const waitForClose = new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue || "cancel"), { once: true });
  });

  try {
    dialog.showModal();
    const { isColumns, isGrid } = getLayoutFlags();
    const primaryInput = isColumns || isGrid ? columnsInput : rowsInput;
    primaryInput.focus();
    primaryInput.select();
    const result = await waitForClose;
    if (result !== "create") return null;
    return {
      layoutType: String(layoutTypeSelect.value ?? "columns"),
      spacingUnit: String(unitsSelect.value ?? "px"),
      columnCount: toNumberValue(columnsInput.value),
      rowCount: toNumberValue(rowsInput.value),
      gutterWidth: toNumberValue(gutterInput.value),
      rowGutterHeight: toNumberValue(rowGutterInput.value),
      leftMarginWidth: toNumberValue(leftMarginInput.value),
      rightMarginWidth: toNumberValue(rightMarginInput.value),
      topMarginHeight: toNumberValue(topMarginInput.value),
      bottomMarginHeight: toNumberValue(bottomMarginInput.value)
    };
  } finally {
    try { dialog.close(); } catch { /* ignore */ }
    dialog.remove();
  }
}

async function askConfirmMergeOrReplaceAllConflicts({ conflictCount, importingCount }) {
  const domDocument = globalThis.document;
  if (!domDocument?.createElement) return "replace";

  const dialog = makeEl("dialog", { cls: "cpg-dialog" });
  const header = makeEl("div", { cls: "cpg-dialog__header" });
  header.appendChild(makeEl("span", { cls: "cpg-dialog__title", text: "Import Presets" }));

  const body = makeEl("div", { cls: "cpg-dialog__body" });
  body.appendChild(makeEl("div", { cls: "cpg-muted", text: `Importing ${plural(importingCount, "preset")}.` }));
  body.appendChild(makeEl("div", { cls: "cpg-muted", text: `${plural(conflictCount, "name conflict")} found.` }));
  body.appendChild(makeEl("div", { cls: "cpg-action-section", text: "For conflicting preset names:" }));
  const actions = makeEl("div", { cls: "cpg-action-section" });
  const mergeRow = makeEl("div", { cls: "cpg-action-row" });
  mergeRow.appendChild(makeEl("strong", { text: "Merge" }));
  mergeRow.appendChild(domDocument.createTextNode(" — combine guides and skip duplicates"));
  const replaceRow = makeEl("div", { cls: "cpg-action-row" });
  replaceRow.appendChild(makeEl("strong", { text: "Replace" }));
  replaceRow.appendChild(domDocument.createTextNode(" — overwrite existing presets"));
  actions.append(mergeRow, replaceRow);
  body.appendChild(actions);

  const footer = makeEl("div", { cls: "cpg-dialog__footer" });
  const cancelBtn = makeEl("button", { text: "Cancel" });
  cancelBtn.setAttribute("uxp-variant", "secondary");
  cancelBtn.addEventListener("click", () => dialog.close("cancel"));
  const mergeBtn = makeEl("button", { text: "Merge" });
  mergeBtn.setAttribute("uxp-variant", "primary");
  mergeBtn.addEventListener("click", () => dialog.close("merge"));
  const replaceBtn = makeEl("button", { text: "Replace" });
  replaceBtn.setAttribute("uxp-variant", "cta");
  replaceBtn.addEventListener("click", () => dialog.close("replace"));
  footer.append(cancelBtn, mergeBtn, replaceBtn);

  dialog.append(header, body, footer);
  domDocument.body.appendChild(dialog);

  const waitForClose = new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue), { once: true });
  });

  try {
    dialog.showModal();
    const result = await waitForClose;
    return result === "merge" || result === "replace" ? result : null;
  } finally {
    try { dialog.close(); } catch { /* ignore */ }
    dialog.remove();
  }
}

async function askPresetLoadLayoutMode({ presetName, sourceDocument, targetDocument }) {
  const domDocument = globalThis.document;
  if (!domDocument?.createElement) return null;

  const dialog = makeEl("dialog", { cls: "cpg-dialog" });
  const header = makeEl("div", { cls: "cpg-dialog__header" });
  header.appendChild(makeEl("span", { cls: "cpg-dialog__title", text: "Load Guide Preset" }));

  const body = makeEl("div", { cls: "cpg-dialog__body" });
  body.appendChild(makeEl("div", { cls: "cpg-action-section", text: `Preset “${presetName}” was saved from ${formatDocumentSpec(sourceDocument)}.` }));
  body.appendChild(makeEl("div", { cls: "cpg-muted", text: `Current document: ${formatDocumentSpec(targetDocument)}.` }));
  body.appendChild(makeEl("div", {
    cls: "cpg-muted",
    text: "Resize the document to the preset's original size and DPI, scale the guides into the current document layout, or apply the saved guide coordinates without rescaling."
  }));

  const footer = makeEl("div", { cls: "cpg-dialog__footer" });
  const cancelBtn = makeEl("button", { text: "Cancel" });
  cancelBtn.setAttribute("uxp-variant", "secondary");
  cancelBtn.addEventListener("click", () => dialog.close("cancel"));

  const applyBtn = makeEl("button", { text: "Apply to Current Layout" });
  applyBtn.setAttribute("uxp-variant", "secondary");
  applyBtn.addEventListener("click", () => dialog.close("applyCurrentLayout"));

  const noScaleBtn = makeEl("button", { text: "Apply Without Rescaling" });
  noScaleBtn.setAttribute("uxp-variant", "secondary");
  noScaleBtn.addEventListener("click", () => dialog.close("applyOriginalCoordinates"));

  const resizeBtn = makeEl("button", { text: "Resize Document" });
  resizeBtn.setAttribute("uxp-variant", "cta");
  resizeBtn.addEventListener("click", () => dialog.close("resizeDocument"));

  footer.append(cancelBtn, noScaleBtn, applyBtn, resizeBtn);
  dialog.append(header, body, footer);
  domDocument.body.appendChild(dialog);

  const waitForClose = new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue || "cancel"), { once: true });
  });

  try {
    dialog.showModal();
    const result = await waitForClose;
    return result === "resizeDocument" || result === "applyCurrentLayout" || result === "applyOriginalCoordinates" ? result : null;
  } finally {
    try { dialog.close(); } catch { /* ignore */ }
    dialog.remove();
  }
}

async function askImportPresetLayoutMode({ importingCount, sourceDocument, targetDocument }) {
  const domDocument = globalThis.document;
  if (!domDocument?.createElement) return null;

  const dialog = makeEl("dialog", { cls: "cpg-dialog" });
  const header = makeEl("div", { cls: "cpg-dialog__header" });
  header.appendChild(makeEl("span", { cls: "cpg-dialog__title", text: "Import Presets" }));

  const body = makeEl("div", { cls: "cpg-dialog__body" });
  body.appendChild(makeEl("div", {
    cls: "cpg-action-section",
    text: `${plural(importingCount, "imported preset")} include original document size and DPI metadata.`
  }));
  body.appendChild(makeEl("div", { cls: "cpg-muted", text: `Example imported layout: ${formatDocumentSpec(sourceDocument)}.` }));
  body.appendChild(makeEl("div", { cls: "cpg-muted", text: `Current document: ${formatDocumentSpec(targetDocument)}.` }));
  body.appendChild(makeEl("div", {
    cls: "cpg-muted",
    text: "Keep the original exported layout, or scale imported guides now so the stored presets match the current document layout."
  }));

  const footer = makeEl("div", { cls: "cpg-dialog__footer" });
  const cancelBtn = makeEl("button", { text: "Cancel" });
  cancelBtn.setAttribute("uxp-variant", "secondary");
  cancelBtn.addEventListener("click", () => dialog.close("cancel"));

  const keepBtn = makeEl("button", { text: "Keep Original Layout" });
  keepBtn.setAttribute("uxp-variant", "secondary");
  keepBtn.addEventListener("click", () => dialog.close("keepOriginal"));

  const applyBtn = makeEl("button", { text: "Apply Current Layout" });
  applyBtn.setAttribute("uxp-variant", "cta");
  applyBtn.addEventListener("click", () => dialog.close("applyCurrentLayout"));

  footer.append(cancelBtn, keepBtn, applyBtn);
  dialog.append(header, body, footer);
  domDocument.body.appendChild(dialog);

  const waitForClose = new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue || "cancel"), { once: true });
  });

  try {
    dialog.showModal();
    const result = await waitForClose;
    return result === "keepOriginal" || result === "applyCurrentLayout" ? result : null;
  } finally {
    try { dialog.close(); } catch { /* ignore */ }
    dialog.remove();
  }
}

// ── Preset storage ─────────────────────────────────────────────────────────

const PRESETS_FILE_NAME = "guide-presets.json";
const PRESETS_SCHEMA_VERSION = 2;

async function getPresetsFile() {
  const folder = await localFileSystem.getDataFolder();
  try {
    return await folder.getEntry(PRESETS_FILE_NAME);
  } catch {
    return await folder.createFile(PRESETS_FILE_NAME, { overwrite: true });
  }
}

function normalizePresetsPayload(payload) {
  if (!payload) return [];
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload.presets)) return payload.presets;
  if (payload.name && payload.guides) return [payload];
  return [];
}

function normalizePresetObject(presetLike) {
  const name = String(presetLike?.name ?? "").trim();
  if (!name) return null;
  const guides = dedupeGuides(presetLike?.guides ?? []);
  return {
    name,
    guides,
    sourceDocument: normalizeDocumentSpec(presetLike?.sourceDocument),
    createdAt: Number.isFinite(Number(presetLike?.createdAt)) ? Number(presetLike.createdAt) : Date.now(),
    updatedAt: Date.now()
  };
}

async function readPresets() {
  const file = await getPresetsFile();
  try {
    const text = await file.read();
    if (!text) return [];
    const json = JSON.parse(text);
    const raw = normalizePresetsPayload(json);
    const presets = raw.map(normalizePresetObject).filter(Boolean);
    presets.sort(byName);
    return presets;
  } catch {
    return [];
  }
}

async function writePresets(presets) {
  const file = await getPresetsFile();
  const normalized = (presets ?? []).map(normalizePresetObject).filter(Boolean);
  normalized.sort(byName);
  const payload = {
    schemaVersion: PRESETS_SCHEMA_VERSION,
    presets: normalized
  };
  await file.write(JSON.stringify(payload, null, 2));
  return normalized;
}

function findPresetIndex(presets, name) {
  return (presets ?? []).findIndex((p) => p?.name === name);
}

// ── Preset dialogs ─────────────────────────────────────────────────────────

async function choosePresetToLoadDialog(presets, { title = "Load Guide Preset" } = {}) {
  const domDocument = globalThis.document;
  if (!domDocument?.createElement) return null;

  const dialog = makeEl("dialog", { cls: "cpg-dialog" });

  const header = makeEl("div", { cls: "cpg-dialog__header" });
  header.appendChild(makeEl("span", { cls: "cpg-dialog__title", text: title }));

  const body = makeEl("div", { cls: "cpg-dialog__body" });

  const label = makeEl("div", { cls: "cpg-field-label", text: "Preset" });
  const select = makeEl("select", { cls: "cpg-select" });
  if (!presets?.length) {
    const opt = makeEl("option", { text: "(No presets yet)" });
    opt.value = "";
    select.appendChild(opt);
    select.disabled = true;
  } else {
    for (const preset of presets) {
      const opt = makeEl("option", { text: `${preset.name} — ${plural(preset.guides?.length ?? 0, "guide")}` });
      opt.value = preset.name;
      select.appendChild(opt);
    }

    // UXP/PS sometimes leaves select.value empty until user interaction,
    // even though the first option is visually selected.
    select.selectedIndex = 0;
    select.value = presets[0]?.name ?? "";
  }

  body.append(label, select);
  if (!presets?.length) {
    body.appendChild(makeEl("div", { cls: "cpg-muted", text: "Tip: Use Save Guide Preset… or Import…" }));
  }

  const footer = makeEl("div", { cls: "cpg-dialog__footer" });
  const cancelBtn = makeEl("button", { text: "Cancel" });
  cancelBtn.setAttribute("uxp-variant", "secondary");
  cancelBtn.addEventListener("click", () => dialog.close("cancel"));

  const loadBtn = makeEl("button", { text: "Load" });
  loadBtn.setAttribute("uxp-variant", "cta");
  loadBtn.disabled = !presets?.length;
  loadBtn.addEventListener("click", () => dialog.close("load"));

  footer.append(cancelBtn, loadBtn);
  dialog.append(header, body, footer);
  domDocument.body.appendChild(dialog);

  const waitForClose = new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue || "cancel"), { once: true });
  });

  try {
    dialog.showModal();
    const action = await waitForClose;
    if (!action || action === "cancel") return null;

    if (action !== "load") return null;
    const selectedName = String(select.value ?? "") || String(presets?.[0]?.name ?? "");
    return selectedName || null;
  } finally {
    try { dialog.close(); } catch { /* ignore */ }
    dialog.remove();
  }
}

async function choosePresetManagementDialog(presets, { title = "Manage Presets" } = {}) {
  const domDocument = globalThis.document;
  if (!domDocument?.createElement) return null;

  const dialog = makeEl("dialog", { cls: "cpg-dialog" });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    dialog.close("cancel");
  });

  const header = makeEl("div", { cls: "cpg-dialog__header" });
  header.appendChild(makeEl("span", { cls: "cpg-dialog__title", text: title }));

  const body = makeEl("div", { cls: "cpg-dialog__body" });

  const label = makeEl("div", { cls: "cpg-field-label", text: "Preset" });
  const select = makeEl("select", { cls: "cpg-select" });
  if (!presets?.length) {
    const opt = makeEl("option", { text: "(No presets yet)" });
    opt.value = "";
    select.appendChild(opt);
    select.disabled = true;
  } else {
    for (const preset of presets) {
      const opt = makeEl("option", { text: `${preset.name} — ${plural(preset.guides?.length ?? 0, "guide")}` });
      opt.value = preset.name;
      select.appendChild(opt);
    }

    select.selectedIndex = 0;
    select.value = presets[0]?.name ?? "";
  }

  body.append(label, select);
  if (!presets?.length) {
    body.appendChild(makeEl("div", { cls: "cpg-muted", text: "Tip: Use Save Guide Preset… or Import…" }));
  }

  const footer = makeEl("div", { cls: "cpg-dialog__footer" });
  const cancelBtn = makeEl("button", { text: "Done" });
  cancelBtn.setAttribute("uxp-variant", "secondary");
  cancelBtn.addEventListener("click", () => dialog.close("cancel"));

  const importBtn = makeEl("button", { text: "Import…" });
  importBtn.setAttribute("uxp-variant", "secondary");
  importBtn.addEventListener("click", () => dialog.close("import"));

  const exportBtn = makeEl("button", { text: "Export…" });
  exportBtn.setAttribute("uxp-variant", "secondary");
  exportBtn.disabled = !presets?.length;
  exportBtn.addEventListener("click", () => dialog.close("export"));

  const exportAllBtn = makeEl("button", { text: "Export All…" });
  exportAllBtn.setAttribute("uxp-variant", "secondary");
  exportAllBtn.disabled = !presets?.length;
  exportAllBtn.addEventListener("click", () => dialog.close("exportAll"));

  const renameBtn = makeEl("button", { text: "Rename…" });
  renameBtn.setAttribute("uxp-variant", "secondary");
  renameBtn.disabled = !presets?.length;
  renameBtn.addEventListener("click", () => dialog.close("rename"));

  const deleteBtn = makeEl("button", { text: "Delete…" });
  deleteBtn.setAttribute("uxp-variant", "secondary");
  deleteBtn.disabled = !presets?.length;
  deleteBtn.addEventListener("click", () => dialog.close("delete"));

  footer.append(cancelBtn, importBtn, exportBtn, exportAllBtn, renameBtn, deleteBtn);
  dialog.append(header, body, footer);
  domDocument.body.appendChild(dialog);

  const waitForClose = new Promise((resolve) => {
    dialog.addEventListener("close", () => resolve(dialog.returnValue || "cancel"), { once: true });
  });

  try {
    dialog.showModal();
    const action = await waitForClose;
    if (!action || action === "cancel") return null;
    const selectedName = String(select.value ?? "") || String(presets?.[0]?.name ?? "");
    return { action, selectedName };
  } finally {
    try { dialog.close(); } catch { /* ignore */ }
    dialog.remove();
  }
}

// ── Commands ─────────────────────────────────────────────────────────────────

async function copyGuides() {
  const targetDocument = await getActiveDocumentSafely();
  if (!targetDocument) {
    await core.showAlert({ message: "No document is open." });
    return;
  }

  const guides = getGuidesSnapshotFromDocument(targetDocument);
  guideClipboard = { guides, copiedAt: Date.now() };

  await core.showAlert({ message: `Copied ${plural(guides.length, "guide")}.` });
}

async function pasteGuides() {
  const targetDocument = await getActiveDocumentSafely();
  if (!targetDocument) {
    await core.showAlert({ message: "No document is open." });
    return;
  }

  if (!guideClipboard) {
    await core.showAlert({ message: "Clipboard is empty. Use Copy Guides first." });
    return;
  }

  const guidesToPaste   = guideClipboard.guides ?? [];
  const existingGuides  = getGuidesSnapshotFromDocument(targetDocument);
  const existingCount   = existingGuides.length;

  let pasteMode         = "replace";
  let existingGuideKeys = null;
  let mergeAddCount     = guidesToPaste.length;
  let mergeSkipCount    = 0;

  if (existingCount > 0) {
    const previewKeys = new Set(existingGuides.map(guideKey));
    mergeAddCount = 0;

    for (const guide of guidesToPaste) {
      const key = guideKey(guide);
      if (previewKeys.has(key)) {
        mergeSkipCount += 1;
      } else {
        mergeAddCount += 1;
        previewKeys.add(key);
      }
    }

    pasteMode = await askMergeOrReplaceWithOptions({
      title: "Paste Guides",
      sourceLabel: "Clipboard",
      targetLabel: "Document",
      existingGuideCount: existingCount,
      pasteGuideCount: guidesToPaste.length,
      mergeAddCount,
      mergeSkipCount
    });
    if (!pasteMode) return;

    if (pasteMode === "merge") {
      existingGuideKeys = new Set(existingGuides.map(guideKey));
    }
  }

  const currentDocument = await getActiveDocumentSafely();
  if (!currentDocument || currentDocument.id !== targetDocument.id) {
    await core.showAlert({ message: "Active document changed. Run Paste Guides again." });
    return;
  }

  await core.executeAsModal(
    async () => {
      if (pasteMode === "replace") {
        targetDocument.guides.removeAll();
      }

      for (const guide of guidesToPaste) {
        if (pasteMode === "merge" && existingGuideKeys) {
          const key = guideKey(guide);
          if (existingGuideKeys.has(key)) continue;
          existingGuideKeys.add(key);
        }
        targetDocument.guides.add(denormalizeDirection(guide.direction), guide.coordinate);
      }
    },
    { commandName: "Paste Guides" }
  );

  const successMsg = pasteMode === "replace"
    ? `Replaced with ${plural(guidesToPaste.length, "guide")}.`
    : `Merged: added ${plural(mergeAddCount, "guide")}${mergeSkipCount > 0 ? `, ${plural(mergeSkipCount, "duplicate")} skipped` : ""}.`;

  await core.showAlert({ message: successMsg });
}

async function createGuides() {
  const targetDocument = await getActiveDocumentSafely();
  if (!targetDocument) {
    await core.showAlert({ message: "No document is open." });
    return;
  }

  const documentWidth = getDocumentWidth(targetDocument);
  const documentHeight = getDocumentHeight(targetDocument);
  const documentResolution = getDocumentResolution(targetDocument);
  const rulerUnit = await getCurrentRulerUnit();

  const guideType = await askCreateGuideType();
  if (!guideType) return;

  const options = await askCreateLayoutOptions(guideType, documentWidth, documentHeight, rulerUnit, documentResolution);
  if (!options) return;

  const selectedGuideType = options.layoutType || guideType;

  let generatedGuides;
  try {
    const gutterInPixels = convertLengthToPixels(options.gutterWidth, options.spacingUnit, documentResolution);
    const rowGutterInPixels = convertLengthToPixels(options.rowGutterHeight, options.spacingUnit, documentResolution);
    const leftMarginInPixels = convertLengthToPixels(options.leftMarginWidth, options.spacingUnit, documentResolution);
    const rightMarginInPixels = convertLengthToPixels(options.rightMarginWidth, options.spacingUnit, documentResolution);
    const topMarginInPixels = convertLengthToPixels(options.topMarginHeight, options.spacingUnit, documentResolution);
    const bottomMarginInPixels = convertLengthToPixels(options.bottomMarginHeight, options.spacingUnit, documentResolution);

    if (
      !Number.isFinite(gutterInPixels) ||
      !Number.isFinite(rowGutterInPixels) ||
      !Number.isFinite(leftMarginInPixels) ||
      !Number.isFinite(rightMarginInPixels) ||
      !Number.isFinite(topMarginInPixels) ||
      !Number.isFinite(bottomMarginInPixels)
    ) {
      throw new Error(`Could not convert the entered values from ${options.spacingUnit} to pixels.`);
    }

    if (selectedGuideType === "rows") {
      generatedGuides = buildRowGuides(
        documentHeight,
        options.rowCount,
        gutterInPixels,
        topMarginInPixels,
        bottomMarginInPixels
      );
    } else if (selectedGuideType === "grid") {
      generatedGuides = buildGridGuides({
        documentWidth,
        documentHeight,
        columnCount: options.columnCount,
        rowCount: options.rowCount,
        columnGutterWidth: gutterInPixels,
        rowGutterHeight: rowGutterInPixels,
        leftMarginWidth: leftMarginInPixels,
        rightMarginWidth: rightMarginInPixels,
        topMarginHeight: topMarginInPixels,
        bottomMarginHeight: bottomMarginInPixels
      });
    } else {
      generatedGuides = buildColumnGuides(
        documentWidth,
        options.columnCount,
        gutterInPixels,
        leftMarginInPixels,
        rightMarginInPixels
      );
    }
  } catch (error) {
    await core.showAlert({ message: error?.message ?? String(error) });
    return;
  }

  const existingGuides = getGuidesSnapshotFromDocument(targetDocument);
  const existingCount = existingGuides.length;

  let pasteMode = "replace";
  let existingGuideKeys = null;
  let mergeAddCount = generatedGuides.length;
  let mergeSkipCount = 0;

  if (existingCount > 0) {
    const preview = mergeGuides(existingGuides, generatedGuides);
    mergeAddCount = preview.mergeAddCount;
    mergeSkipCount = preview.mergeSkipCount;

    pasteMode = await askMergeOrReplaceWithOptions({
      title: selectedGuideType === "rows" ? "Create Row Guides" : selectedGuideType === "grid" ? "Create Grid Guides" : "Create Column Guides",
      sourceLabel: "Generated",
      targetLabel: "Document",
      existingGuideCount: existingCount,
      pasteGuideCount: generatedGuides.length,
      mergeAddCount,
      mergeSkipCount
    });
    if (!pasteMode) return;

    if (pasteMode === "merge") {
      existingGuideKeys = new Set(existingGuides.map(guideKey));
    }
  }

  const currentDocument = await getActiveDocumentSafely();
  if (!currentDocument || currentDocument.id !== targetDocument.id) {
    await core.showAlert({ message: "Active document changed. Run Create Guide again." });
    return;
  }

  await core.executeAsModal(
    async () => {
      if (pasteMode === "replace") {
        targetDocument.guides.removeAll();
      }

      for (const guide of generatedGuides) {
        if (pasteMode === "merge" && existingGuideKeys) {
          const key = guideKey(guide);
          if (existingGuideKeys.has(key)) continue;
          existingGuideKeys.add(key);
        }
        targetDocument.guides.add(denormalizeDirection(guide.direction), guide.coordinate);
      }
    },
    { commandName: selectedGuideType === "rows" ? "Create Row Guides" : selectedGuideType === "grid" ? "Create Grid Guides" : "Create Column Guides" }
  );

  const createdSummary = selectedGuideType === "rows"
    ? `${Math.trunc(options.rowCount)} rows`
    : selectedGuideType === "grid"
      ? `${Math.trunc(options.columnCount)} columns x ${Math.trunc(options.rowCount)} rows`
      : `${Math.trunc(options.columnCount)} columns`;
  const actionLabel = selectedGuideType === "rows" ? "row guides" : selectedGuideType === "grid" ? "grid guides" : "column guides";
  const successMsg = pasteMode === "replace"
    ? `Created ${plural(generatedGuides.length, "guide")} for ${createdSummary}.`
    : `Created ${actionLabel}: added ${plural(mergeAddCount, "guide")}${mergeSkipCount > 0 ? `, ${plural(mergeSkipCount, "duplicate")} skipped` : ""}.`;
  await core.showAlert({ message: successMsg });
}

async function clearGuides() {
  const targetDocument = await getActiveDocumentSafely();
  if (!targetDocument) {
    await core.showAlert({ message: "No document is open." });
    return;
  }

  const existingGuides = getGuidesSnapshotFromDocument(targetDocument);
  const existingCount = existingGuides.length;

  if (existingCount === 0) {
    await core.showAlert({ message: "This document has no guides to clear." });
    return;
  }

  const ok = await askConfirm({
    title: "Clear All Guides",
    message: `Remove ${plural(existingCount, "guide")} from the active document?`,
    okText: "Clear",
    okVariant: "cta"
  });
  if (!ok) return;

  const currentDocument = await getActiveDocumentSafely();
  if (!currentDocument || currentDocument.id !== targetDocument.id) {
    await core.showAlert({ message: "Active document changed. Run Clear All Guides again." });
    return;
  }

  await core.executeAsModal(
    async () => {
      targetDocument.guides.removeAll();
    },
    { commandName: "Clear All Guides" }
  );

  await core.showAlert({ message: `Cleared ${plural(existingCount, "guide")}.` });
}

async function savePreset() {
  const targetDocument = await getActiveDocumentSafely();
  if (!targetDocument) {
    await core.showAlert({ message: "No document is open." });
    return;
  }

  if (!(await requireLocalFileSystem("Save Guide Preset"))) return;

  const name = await askTextInput({
    title: "Save Guide Preset",
    label: "Preset name",
    defaultValue: "",
    okText: "Save"
  });
  if (!name) return;

  const currentDocumentSpec = getDocumentSpec(targetDocument);
  const currentGuides = dedupeGuides(getGuidesSnapshotFromDocument(targetDocument));
  let presets = await readPresets();
  const idx = findPresetIndex(presets, name);

  if (idx >= 0) {
    const existing = presets[idx];
    const incoming = currentGuides;
    const existingCount = existing.guides?.length ?? 0;
    const incomingCount = incoming.length;

    const preview = mergeGuides(dedupeGuides(existing.guides), incoming);
    const mode = await askMergeOrReplaceWithOptions({
      title: "Save Guide Preset",
      sourceLabel: "Document",
      targetLabel: "Existing Preset",
      existingGuideCount: existingCount,
      pasteGuideCount: incomingCount,
      mergeAddCount: preview.mergeAddCount,
      mergeSkipCount: preview.mergeSkipCount,
      replaceLabel: "Replace",
      mergeLabel: "Merge"
    });
    if (!mode) return;

    if (mode === "replace") {
      presets[idx] = { ...existing, name, guides: incoming, sourceDocument: currentDocumentSpec, updatedAt: Date.now() };
    } else {
      presets[idx] = { ...existing, name, guides: dedupeGuides(preview.merged), sourceDocument: currentDocumentSpec, updatedAt: Date.now() };
    }
  } else {
    presets.push({ name, guides: currentGuides, sourceDocument: currentDocumentSpec, createdAt: Date.now(), updatedAt: Date.now() });
  }

  presets = await writePresets(presets);

  const saved = presets.find((p) => p.name === name);
  await core.showAlert({ message: `Saved preset “${name}” (${plural(saved?.guides?.length ?? 0, "guide")}).` });
}

async function exportPreset(preset) {
  if (!(await requireLocalFileSystem("Export Preset"))) return;
  try {
    const suggested = `${toSafeFileNameBase(preset.name)}.json`;
    const file = await localFileSystem.getFileForSaving(suggested, { types: ["json"] });
    if (!file) return;

    // If the user changes the filename in the save dialog, reflect that in
    // the exported preset name (without changing the stored preset name).
    const exportedName = fileNameToPresetName(file.name, preset.name);

    const payload = {
      schemaVersion: PRESETS_SCHEMA_VERSION,
      presets: [
        {
          name: String(exportedName),
          guides: dedupeGuides(preset.guides),
          sourceDocument: normalizeDocumentSpec(preset.sourceDocument),
          createdAt: preset.createdAt,
          updatedAt: preset.updatedAt
        }
      ]
    };
    await file.write(JSON.stringify(payload, null, 2));
    await core.showAlert({ message: `Exported preset “${preset.name}”.` });
  } catch (error) {
    console.error("Export preset failed", error);
    await core.showAlert({ message: `Export failed: ${error?.message ?? String(error)}` });
  }
}

async function exportAllPresets(presets) {
  if (!(await requireLocalFileSystem("Export All Presets"))) return;
  try {
    const safeBase = toSafeFileNameBase("guide-presets");
    const suggested = `${safeBase}.json`;
    const file = await localFileSystem.getFileForSaving(suggested, { types: ["json"] });
    if (!file) return;

    const payload = {
      schemaVersion: PRESETS_SCHEMA_VERSION,
      presets: (presets ?? []).map((p) => ({
        name: String(p.name),
        guides: dedupeGuides(p.guides),
        sourceDocument: normalizeDocumentSpec(p.sourceDocument),
        createdAt: p.createdAt,
        updatedAt: p.updatedAt
      }))
    };

    await file.write(JSON.stringify(payload, null, 2));
    await core.showAlert({ message: `Exported ${plural(presets?.length ?? 0, "preset")}.` });
  } catch (error) {
    console.error("Export all presets failed", error);
    await core.showAlert({ message: `Export failed: ${error?.message ?? String(error)}` });
  }
}

async function importPresetsIntoStore() {
  if (!(await requireLocalFileSystem("Import Presets"))) return;
  try {
    const file = await localFileSystem.getFileForOpening({ types: ["json"] });
    if (!file) return;
    const text = await file.read();
    const json = JSON.parse(text);
    const incomingRaw = normalizePresetsPayload(json);
    let incoming = incomingRaw.map(normalizePresetObject).filter(Boolean);
    if (!incoming.length) {
      await core.showAlert({ message: "No valid presets found in that file." });
      return;
    }

    let presets = await readPresets();
    const existingNames = new Set(presets.map((p) => p.name));
    const conflictNames = incoming.filter((p) => existingNames.has(p.name)).map((p) => p.name);

    let conflictMode = "replace";
    if (conflictNames.length > 0) {
      const chosen = await askConfirmMergeOrReplaceAllConflicts({
        conflictCount: conflictNames.length,
        importingCount: incoming.length
      });
      if (!chosen) return;
      conflictMode = chosen;
    }

    for (const preset of incoming) {
      const idx = findPresetIndex(presets, preset.name);
      if (idx < 0) {
        presets.push(preset);
        continue;
      }

      if (conflictMode === "replace") {
        presets[idx] = {
          ...presets[idx],
          guides: preset.guides,
          sourceDocument: normalizeDocumentSpec(preset.sourceDocument),
          updatedAt: Date.now()
        };
      } else {
        const merged = mergeGuides(dedupeGuides(presets[idx].guides), dedupeGuides(preset.guides));
        presets[idx] = {
          ...presets[idx],
          guides: dedupeGuides(merged.merged),
          sourceDocument: normalizeDocumentSpec(presets[idx].sourceDocument) ?? normalizeDocumentSpec(preset.sourceDocument),
          updatedAt: Date.now()
        };
      }
    }

    await writePresets(presets);
    await core.showAlert({ message: `Imported ${plural(incoming.length, "preset")}.` });
  } catch (error) {
    console.error("Import presets failed", error);
    await core.showAlert({ message: `Import failed: ${error?.message ?? String(error)}` });
  }
}

async function renamePreset(presets, selectedName) {
  const preset = presets.find((p) => p.name === selectedName);
  if (!preset) return;

  const newName = await askTextInput({
    title: "Rename Preset",
    label: "New name",
    defaultValue: preset.name,
    okText: "Rename"
  });
  if (!newName) return;
  if (newName === preset.name) return;

  if (presets.some((p) => p.name === newName)) {
    await core.showAlert({ message: "A preset with that name already exists." });
    return;
  }

  const idx = findPresetIndex(presets, preset.name);
  if (idx < 0) return;
  presets[idx] = { ...preset, name: newName, updatedAt: Date.now() };
  await writePresets(presets);
  await core.showAlert({ message: `Renamed to “${newName}”.` });
}

async function deletePreset(presets, selectedName) {
  const preset = presets.find((p) => p.name === selectedName);
  if (!preset) return;

  const ok = await askConfirm({
    title: "Delete Preset",
    message: `Delete preset “${preset.name}” (${plural(preset.guides?.length ?? 0, "guide")})? This cannot be undone.`,
    okText: "Delete",
    okVariant: "cta"
  });
  if (!ok) return;

  const next = (presets ?? []).filter((p) => p.name !== preset.name);
  await writePresets(next);
  await core.showAlert({ message: `Deleted preset “${preset.name}”.` });
}

async function loadPreset() {
  const targetDocument = await getActiveDocumentSafely();
  if (!targetDocument) {
    await core.showAlert({ message: "No document is open." });
    return;
  }

  if (!(await requireLocalFileSystem("Load Guide Preset"))) return;
  const originalTargetSpec = getDocumentSpec(targetDocument);

  const presets = await readPresets();
  const selectedName = await choosePresetToLoadDialog(presets, { title: "Load Guide Preset" });
  if (!selectedName) return;

  const preset = presets.find((p) => p.name === selectedName);
  if (!preset) {
    await core.showAlert({ message: "No preset selected." });
    return;
  }

  const currentDocument = await getActiveDocumentSafely();
  if (!currentDocument || currentDocument.id !== targetDocument.id) {
    await core.showAlert({ message: "Active document changed. Run Load Guide Preset again." });
    return;
  }

    let guidesToPaste = dedupeGuides(preset.guides ?? []);
    let layoutAction = "original";

    if (preset.sourceDocument && originalTargetSpec && documentSpecsDiffer(preset.sourceDocument, originalTargetSpec)) {
      const layoutMode = await askPresetLoadLayoutMode({
        presetName: preset.name,
        sourceDocument: preset.sourceDocument,
        targetDocument: originalTargetSpec
      });
      if (!layoutMode) return;

      if (layoutMode === "resizeDocument") {
        await core.executeAsModal(
          async () => {
            if (typeof targetDocument.resizeImage !== "function") {
              throw new Error("This Photoshop build does not support document resizing from the plugin API.");
            }
            await targetDocument.resizeImage(
              preset.sourceDocument.width,
              preset.sourceDocument.height,
              preset.sourceDocument.resolution
            );
          },
          { commandName: "Resize Document for Guide Preset" }
        );
        layoutAction = "resizedDocument";
      } else if (layoutMode === "applyCurrentLayout") {
        guidesToPaste = scaleGuidesToDocumentLayout(guidesToPaste, preset.sourceDocument, originalTargetSpec);
        layoutAction = "appliedCurrentLayout";
      } else {
        layoutAction = "appliedOriginalCoordinates";
      }
    }

    const existingGuides = getGuidesSnapshotFromDocument(targetDocument);
    const existingCount = existingGuides.length;

    let pasteMode = "replace";
    let existingGuideKeys = null;
    let mergeAddCount = guidesToPaste.length;
    let mergeSkipCount = 0;

    if (existingCount > 0) {
      const previewKeys = new Set(existingGuides.map(guideKey));
      mergeAddCount = 0;
      for (const guide of guidesToPaste) {
        const key = guideKey(guide);
        if (previewKeys.has(key)) {
          mergeSkipCount += 1;
        } else {
          mergeAddCount += 1;
          previewKeys.add(key);
        }
      }

      pasteMode = await askMergeOrReplaceWithOptions({
        title: "Load Guide Preset",
        sourceLabel: "Preset",
        targetLabel: "Document",
        existingGuideCount: existingCount,
        pasteGuideCount: guidesToPaste.length,
        mergeAddCount,
        mergeSkipCount
      });
      if (!pasteMode) return;
      if (pasteMode === "merge") {
        existingGuideKeys = new Set(existingGuides.map(guideKey));
      }
    }

    await core.executeAsModal(
      async () => {
        if (pasteMode === "replace") {
          targetDocument.guides.removeAll();
        }
        for (const guide of guidesToPaste) {
          if (pasteMode === "merge" && existingGuideKeys) {
            const key = guideKey(guide);
            if (existingGuideKeys.has(key)) continue;
            existingGuideKeys.add(key);
          }
          targetDocument.guides.add(denormalizeDirection(guide.direction), guide.coordinate);
        }
      },
      { commandName: "Load Guide Preset" }
    );

    const successMsg = pasteMode === "replace"
      ? `Loaded preset “${preset.name}” (${plural(guidesToPaste.length, "guide")})${layoutAction === "resizedDocument" ? "; document resized to preset size." : layoutAction === "appliedCurrentLayout" ? "; guides scaled to current document layout." : layoutAction === "appliedOriginalCoordinates" ? "; saved guide coordinates applied without rescaling." : ""}.`
      : `Merged preset “${preset.name}”: added ${plural(mergeAddCount, "guide")}${mergeSkipCount > 0 ? `, ${plural(mergeSkipCount, "duplicate")} skipped` : ""}${layoutAction === "resizedDocument" ? "; document resized to preset size" : layoutAction === "appliedCurrentLayout" ? "; guides scaled to current document layout" : layoutAction === "appliedOriginalCoordinates" ? "; saved guide coordinates applied without rescaling" : ""}.`;
  await core.showAlert({ message: successMsg });
}

async function managePresets() {
  if (!(await requireLocalFileSystem("Manage Presets"))) return;

  while (true) {
    const presets = await readPresets();
    const result = await choosePresetManagementDialog(presets, { title: "Manage Presets" });
    if (!result) return;

    const { action, selectedName } = result;

    if (action === "import") {
      await importPresetsIntoStore();
      continue;
    }

    if (action === "exportAll") {
      await exportAllPresets(presets);
      continue;
    }

    const preset = presets.find((p) => p.name === selectedName);
    if (!preset) {
      await core.showAlert({ message: "No preset selected." });
      continue;
    }

    if (action === "export") {
      await exportPreset(preset);
      continue;
    }

    if (action === "rename") {
      await renamePreset([...presets], preset.name);
      continue;
    }

    if (action === "delete") {
      await deletePreset([...presets], preset.name);
      continue;
    }
  }
}

// ── Theme awareness ─────────────────────────────────────────────────────────

function applyTheme(themeModule) {
  const body = globalThis.document?.body;
  if (!body || !themeModule) return;
  const dark = ["darkest", "dark", "medium"].includes(themeModule.appTheme);
  body.setAttribute("data-cpg-theme", dark ? "dark" : "light");
}

// ── Init ─────────────────────────────────────────────────────────────────────

function initPlugin() {
  try {
    const { entrypoints: uxpEntrypoints, theme, storage } = require("uxp");
    const photoshop = require("photoshop");

    entrypoints = uxpEntrypoints;
    localFileSystem = storage?.localFileSystem;

    app = photoshop?.app;
    constants = photoshop?.constants;
    core = photoshop?.core;
    action = photoshop?.action;

    if (!entrypoints?.setup) throw new Error("UXP entrypoints not available");
    if (!app || !constants || !core || !action) throw new Error("Photoshop UXP module missing expected exports");

    entrypoints.setup({
      commands: {
        copyGuides: () => runCommandWithDiagnostics("Copy Guides", copyGuides),
        pasteGuides: () => runCommandWithDiagnostics("Paste Guides", pasteGuides),
        createGuides: () => runCommandWithDiagnostics("Create Guide", createGuides),
        clearGuides: () => runCommandWithDiagnostics("Clear All Guides", clearGuides),
        savePreset: () => runCommandWithDiagnostics("Save Guide Preset", savePreset),
        loadPreset: () => runCommandWithDiagnostics("Load Guide Preset", loadPreset),
        managePresets: () => runCommandWithDiagnostics("Manage Presets", managePresets)
      }
    });

    if (!startupDiagnosticShown) {
      startupDiagnosticShown = true;
      console.log("Guide Master: plugin initialized successfully");
    }

    applyTheme(theme);
    if (typeof theme?.addEventListener === "function") {
      theme.addEventListener("themechange", () => applyTheme(theme));
    }
  } catch (error) {
    console.error("Guide Master: init failed", error);
    try { alert(`Guide Master failed to load.\n\n${error?.message ?? String(error)}`); } catch { /* ignore */ }
  }
}

initPlugin();

