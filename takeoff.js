/* ================================================================
   Auto Take-Off module — jpg/png/pdf floor plan measurement
   Exposes: window.openTakeoff, closeTakeoff, isTakeoffOpen,
            renderTakeoffOverlay, refreshTakeoffSidebar
   ================================================================ */

(function () {
  "use strict";

  const COLORS = {
    scale:   "#f5a623",
    compass: "#e74c3c",
    outdoor: "#d64545",
    indoor:  "#e08b3c",
    window:  "#3684e0",
    door:    "#3ea768",
    room:    "#8a4dd6",
  };

  const TOOLS = [
    { key: "scale",   label: "📏 Set scale",     hint: "Click 2 points on a feature of known length, then enter its real length in metres." },
    { key: "compass", label: "🧭 Set North",     hint: "Click the base of the North arrow (or any point), then click in the direction of North. Windows will auto-detect their facing (N/NE/E/…)." },
    { key: "outdoor", label: "🟥 Outdoor walls", hint: "Click along the outer walls. Double-click (or press Enter) to finish. You can draw multiple outdoor polylines." },
    { key: "indoor",  label: "🟧 Indoor walls",  hint: "Click along an interior wall. Double-click to finish. Add each internal wall separately." },
    { key: "window",  label: "🟦 Window",        hint: "Click the two ends of a window (auto-finishes). Hold Ctrl while clicking to extend to a polyline (curved / multi-segment windows) — double-click or Enter to finish. Facing auto-detected from North + walls." },
    { key: "door",    label: "🟩 Door",          hint: "Click the two ends of a door (auto-finishes). Hold Ctrl while clicking to extend to a polyline (curved / multi-segment doors) — double-click or Enter to finish." },
    { key: "room",    label: "🟪 Room polygon",  hint: "Click around the room. Double-click to close the polygon. Enter ceiling height to get m² floor area and m³ volume." },
  ];

  const COMPASS_DIRS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

  // Rule-of-thumb HVAC/ventilation coefficients — fetched from Firestore on login (see auth.js).
  // Start at 0 so a bypassed local copy has no working numbers.
  let KW_PER_M2 = 0;
  let KW_PER_M3 = 0;
  let LS_PER_M2 = 0;
  let LS_PER_M3 = 0;
  // Called by auth.js right after the config/coefficients doc is loaded.
  window.setTakeoffCoefficients = function (cfg) {
    if (!cfg) return false;
    if (cfg.KW_PER_M2 != null) KW_PER_M2 = cfg.KW_PER_M2;
    if (cfg.KW_PER_M3 != null) KW_PER_M3 = cfg.KW_PER_M3;
    if (cfg.LS_PER_M2 != null) LS_PER_M2 = cfg.LS_PER_M2;
    if (cfg.LS_PER_M3 != null) LS_PER_M3 = cfg.LS_PER_M3;
    return true;
  };

  // Distinct fills for room polygons — cycled in the order rooms are created
  const ROOM_COLORS = [
    "#8a4dd6",  // purple
    "#d64545",  // red
    "#e0a83c",  // amber
    "#3ea768",  // green
    "#3684e0",  // blue
    "#d63b8a",  // pink
    "#3ec4a8",  // teal
    "#c67d3c",  // brown-orange
    "#7d3ec4",  // violet
    "#4b7d3e",  // olive
  ];

  const T = {
    open: false,
    session: null,
    // Per-page state (one entry per PDF page, or one entry for a single image)
    pages: [],          // [{ image, imageW, imageH, elements, view }]
    currentPageIdx: 0,
    // The following are LIVE REFERENCES into T.pages[currentPageIdx] so drawing
    // code can keep using them; goToPage() re-points them.
    image: null,        // HTMLImageElement OR offscreen canvas (PDF page)
    imageW: 0, imageH: 0,
    elements: [],       // finished elements on the CURRENT page
    view: { zoom: 1, panX: 0, panY: 0 },
    // Global across all pages
    scale: null,        // metres per image pixel
    north: null,        // {origin:{x,y}, vector:{x,y}} — image coords
    tool: null,
    wallHeight: 2.7,
    currentPath: [],    // in-progress polyline (image coords) — current sub-path
    completedSubPaths: [], // finished sub-paths in the CURRENT in-progress element (for skip-gap)
    mousePos: null,     // last known mouse pos in image coords (post-snap)
    snapHit: null,      // {x, y, type: 'vertex'|'edge'|'first'} or null
    dragging: false,
    dragStart: null,
    dragOrigin: null,
    replaceTables: false,
    busy: false,        // true while a prompt modal is open
    ortho: false,       // constrain new segments to horizontal/vertical
    snapToImage: false, // snap to dark features in the uploaded image
    toolboxPos: null,   // { screenX, screenY } when the mouse toolbox is open
    lastMouseScreen: null,  // { x, y } viewport coords — used to open toolbox at cursor
    compassHidden: false,   // set true while user is (re)drawing North, so the old arrow doesn't clutter
  };

  function makePage(image, w, h) {
    return {
      image, imageW: w, imageH: h,
      elements: [],
      view: { zoom: 1, panX: 0, panY: 0 },
    };
  }

  function goToPage(idx) {
    if (!T.pages.length) return;
    idx = Math.max(0, Math.min(T.pages.length - 1, idx));
    T.currentPageIdx = idx;
    const p = T.pages[idx];
    T.image = p.image;
    T.imageW = p.imageW;
    T.imageH = p.imageH;
    T.elements = p.elements;
    T.view = p.view;
    T.currentPath = [];
    T.mousePos = null;
    T.snapHit = null;
  }

  function setPages(pages, idx = 0) {
    T.pages = pages;
    if (pages.length > 0) {
      goToPage(idx);
    } else {
      T.currentPageIdx = 0;
      T.image = null; T.imageW = 0; T.imageH = 0;
      T.elements = [];
      T.view = { zoom: 1, panX: 0, panY: 0 };
    }
  }

  const SNAP_PX = 12;   // screen-pixel snap radius

  let canvas = null, ctx = null;
  let labelBoxes = [];          // { element, role, subIdx, x, y, w, h } — filled during redraw
  let labelDrag = null;         // { element, role, subIdx, startOffset, startMouseImg } while dragging a label
  let vertexDrag = null;        // { element, subIdx, vertexIdx } while dragging a vertex with Ctrl
  let justDraggedLabel = false; // suppresses the click that fires right after mouseup

  /* ---- Public API ---- */

  window.isTakeoffOpen = () => T.open;

  window.openTakeoff = function (session) {
    const stored = session.takeoff || null;
    Object.assign(T, {
      open: true, session,
      scale:  stored ? stored.scale  : null,
      north:  stored ? stored.north  : null,
      tool: null,
      wallHeight: (stored && stored.wallHeight) || session.data.wallHeight || 2.7,
      currentPath: [], completedSubPaths: [], mousePos: null, snapHit: null,
      dragging: false, dragStart: null, dragOrigin: null,
      replaceTables: stored ? stored.replaceTables : false,
      busy: false,
      ortho: stored ? !!stored.ortho : false,
      snapToImage: stored ? !!stored.snapToImage : false,
      toolboxPos: null,
      lastMouseScreen: null,
    });
    // Restore per-page state (or empty)
    setPages(stored && stored.pages ? stored.pages : [], stored ? stored.currentPageIdx || 0 : 0);
    // If the currently active sub-tab came from a specific PDF page, jump straight there
    if (session.subs && typeof session.activeSub === "number") {
      const activeSub = session.subs[session.activeSub];
      if (activeSub && typeof activeSub.takeoffPage === "number"
          && activeSub.takeoffPage < T.pages.length) {
        goToPage(activeSub.takeoffPage);
      }
    }
    window.render();
  };

  window.closeTakeoff = function () {
    if (T.session) {
      T.session.takeoff = {
        pages: T.pages,                       // full page array retained
        currentPageIdx: T.currentPageIdx,
        scale: T.scale,
        north: T.north,
        wallHeight: T.wallHeight,
        replaceTables: T.replaceTables,
        ortho: T.ortho,
        snapToImage: T.snapToImage,
      };
    }
    closeMouseToolbox();
    T.open = false; T.session = null;
    window.render();
  };

  window.renderTakeoffOverlay = function () {
    const overlay = el("div", { class: "takeoff-overlay" });

    const header = el("div", { class: "takeoff-header" }, [
      el("div", { class: "takeoff-title" }, "🖼️ Auto Take-Off"),
      el("div", { class: "takeoff-actions" }, [
        el("button", { class: "to-btn to-btn-ghost", onclick: () => window.closeTakeoff(), title: "Close take-off — your image and measurements stay saved for this THL. Reopen to keep editing." }, "Close"),
        el("button", { class: "to-btn to-btn-primary", onclick: applyToTHL, title: "Push measurements to THL and keep editing" }, "Apply to THL"),
      ]),
    ]);

    const canvasWrap = el("div", { class: "takeoff-canvas-wrap" });
    canvas = el("canvas", { id: "takeoff-canvas" });
    canvasWrap.appendChild(canvas);
    canvasWrap.appendChild(renderDropZone());
    canvasWrap.appendChild(renderPageNav());

    // Allow drop anywhere in the canvas area (replaces current image)
    canvasWrap.addEventListener("dragover", (e) => { e.preventDefault(); });
    canvasWrap.addEventListener("drop", (e) => {
      e.preventDefault();
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    });

    const body = el("div", { class: "takeoff-body" }, [canvasWrap, renderSidebar()]);
    overlay.appendChild(header);
    overlay.appendChild(body);

    setTimeout(() => {
      sizeCanvas();
      attachCanvasHandlers();
      redraw();
    }, 0);

    // Keep canvas sized on resize
    window.addEventListener("resize", onResizeThrottled, { passive: true });

    return overlay;
  };

  window.refreshTakeoffSidebar = function () {
    const existing = document.querySelector(".takeoff-sidebar");
    if (existing) existing.replaceWith(renderSidebar());
    refreshPageNav();
  };

  /* ---- Sidebar ---- */

  function renderSidebar() {
    const side = el("div", { class: "takeoff-sidebar" });

    // Upload
    const fileInput = el("input", { type: "file", accept: "image/*,application/pdf" });
    fileInput.style.display = "none";
    fileInput.addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) handleFile(f);
    });
    side.appendChild(el("button", {
      class: "to-btn to-btn-primary to-upload",
      onclick: () => fileInput.click(),
    }, T.image ? "📤 Replace image / PDF" : "📤 Upload image or PDF"));
    side.appendChild(fileInput);

    // Tools
    side.appendChild(el("div", { class: "to-section-title" }, "Tools"));
    const toolCol = el("div", { class: "to-tool-col" });
    TOOLS.forEach(t => {
      const active = T.tool === t.key;
      const btn = el("button", {
        class: "to-tool-btn" + (active ? " active" : ""),
        onclick: () => switchTool(t.key),
      }, t.label);
      btn.style.borderLeftColor = COLORS[t.key];
      if (active) { btn.style.background = COLORS[t.key]; btn.style.color = "white"; }
      toolCol.appendChild(btn);
    });
    side.appendChild(toolCol);

    // Current tool hint
    if (T.tool) {
      const hint = TOOLS.find(t => t.key === T.tool).hint;
      side.appendChild(el("div", { class: "to-hint" }, hint));
    }
    if (!T.scale && T.tool && T.tool !== "scale" && T.tool !== "compass") {
      side.appendChild(el("div", { class: "to-warn" }, "⚠ Set the scale first (📏)."));
    }

    // Skip-gap button (visible during a wall / window / door draw with 2+ vertices)
    if ((T.tool === "outdoor" || T.tool === "indoor" || T.tool === "window" || T.tool === "door")
        && T.currentPath.length >= 2) {
      const btn = el("button", {
        class: "to-btn to-btn-primary",
        title: "Finish the current segment, skip the gap, and start a new segment on your next click. Hotkey: Spacebar. Each segment shows its own length label.",
      }, "⏭ Skip gap · start next segment (Spacebar)");
      btn.onclick = skipGap;
      side.appendChild(btn);
    }

    // Drawing aids: Ortho + Snap to image
    side.appendChild(el("div", { class: "to-section-title" }, "Drawing aids"));
    const aids = el("div", { class: "to-aid-row" });
    const orthoBtn = el("button", {
      class: "to-aid-btn" + (T.ortho ? " active" : ""),
      title: "Constrain new lines to horizontal / vertical from the last vertex (hotkey: F8)",
    }, "📐 Ortho");
    orthoBtn.onclick = () => { T.ortho = !T.ortho; refreshTakeoffSidebar(); redraw(); };
    aids.appendChild(orthoBtn);
    const imgSnapBtn = el("button", {
      class: "to-aid-btn" + (T.snapToImage ? " active" : ""),
      title: "Snap to dark features (walls/edges/corners) in the uploaded floor plan (hotkey: F3)",
    }, "🎯 Snap image");
    imgSnapBtn.onclick = () => { T.snapToImage = !T.snapToImage; refreshTakeoffSidebar(); redraw(); };
    aids.appendChild(imgSnapBtn);
    side.appendChild(aids);

    // Scale
    side.appendChild(el("div", { class: "to-section-title" }, "Scale"));
    side.appendChild(el("div", { class: "to-scale" },
      T.scale ? `${(T.scale * 1000).toFixed(3)} mm per image px  (${T.scale.toFixed(5)} m/px)` : "not set"));

    // North
    side.appendChild(el("div", { class: "to-section-title" }, "North direction"));
    if (T.north) {
      // Angle from screen-up (0°) clockwise
      const dx = T.north.vector.x, dy = T.north.vector.y;
      let ang = Math.atan2(dx, -dy) * 180 / Math.PI;
      if (ang < 0) ang += 360;
      side.appendChild(el("div", { class: "to-scale" },
        `${ang.toFixed(1)}° from screen-up  →  windows will auto-detect facing`));
    } else {
      side.appendChild(el("div", { class: "to-scale muted" },
        "not set — window facings will default to N"));
    }

    // Totals
    side.appendChild(el("div", { class: "to-section-title" },
      T.pages.length > 1 ? "Current page totals (Apply uses these)" : "Running totals"));
    const totals = computeTotals();
    const tot = el("div", { class: "to-totals" });
    tot.appendChild(totRow("Outdoor perimeter", totals.outdoorLen.toFixed(2), "m"));
    tot.appendChild(totRow("Indoor perimeter",  totals.indoorLen.toFixed(2),  "m"));
    tot.appendChild(totRow("Rooms area",        totals.roomsArea.toFixed(2),  "m²"));
    tot.appendChild(totRow("Rooms volume",      totals.roomsVol.toFixed(2),   "m³"));
    tot.appendChild(totRow("Windows",           totals.windows,               ""));
    tot.appendChild(totRow("Doors",             totals.doors,                 ""));
    tot.appendChild(totRow("Wall / ceiling H",  T.wallHeight,                 "m"));
    side.appendChild(tot);

    // Elements list (current page only)
    if (T.elements.length > 0) {
      const label = T.pages.length > 1
        ? `Page ${T.currentPageIdx + 1} elements (${T.elements.length})`
        : `Elements (${T.elements.length})`;
      side.appendChild(el("div", { class: "to-section-title" }, label));
      const list = el("div", { class: "to-elements" });
      T.elements.forEach((e, i) => list.appendChild(elementRow(e, i)));
      side.appendChild(list);
    }

    const actions = el("div", { class: "to-btn-row" }, [
      el("button", { class: "to-btn to-btn-ghost", onclick: undoLast, title: "Delete last vertex (if drawing) or last element" }, "↶ Undo"),
      el("button", { class: "to-btn to-btn-ghost", onclick: async () => {
        if (!window.confirmModal) { clearAll(); return; }
        const yes = await window.confirmModal("Clear all measurements? This also clears the scale.", { title: "Clear all", danger: true });
        if (yes) clearAll();
      } }, "Clear all"),
      el("button", { class: "to-btn to-btn-ghost", onclick: () => { T.view.zoom = 1; T.view.panX = 0; T.view.panY = 0; redraw(); } }, "Fit"),
    ]);
    side.appendChild(actions);

    const base = "Wheel = zoom · Right-drag = pan · Drag label to move · Ctrl+drag a vertex to reshape · Double-click a room label for properties · Right-click label = toggle leader · Ctrl+click on window/door = extend polyline · Space = skip gap · T = quick toolbox · F8 = ortho · F3 = snap image · Enter = finish · Esc = cancel";
    const helpText = T.pages.length > 1
      ? base + " · Arrows / PageUp/Dn = switch page"
      : base;
    side.appendChild(el("div", { class: "to-help" }, helpText));

    return side;
  }

  function totRow(label, val, unit) {
    return el("div", { class: "to-total-row" }, [
      el("span", { class: "to-total-label" }, label),
      el("span", { class: "to-total-val" }, String(val) + (unit ? " " + unit : "")),
    ]);
  }

  function elementRow(e, i) {
    let text = "";
    if (e.type === "outdoor")      text = `Outdoor wall — ${e.length.toFixed(2)} m × ${e.height} m`;
    else if (e.type === "indoor")  text = `Indoor wall — ${e.length.toFixed(2)} m × ${e.height} m`;
    else if (e.type === "window")  {
      const f = computeWindowFacing(e);
      text = `Window — ${e.width.toFixed(2)} m × ${e.height} m${f ? "  ·  " + f : ""}`;
    }
    else if (e.type === "door")    text = `Door — ${e.width.toFixed(2)} m × ${e.height} m`;
    else if (e.type === "room")    text = `${e.name || "Room"} — ${e.area.toFixed(2)} m² × ${e.height} m = ${e.volume.toFixed(2)} m³`;
    else if (e.type === "scale")   text = `Scale ref — ${e.metres} m`;
    const dotColor = e.color || COLORS[e.type];
    return el("div", { class: "to-element-row" }, [
      el("span", { class: "to-element-dot", style: `background:${dotColor}` }),
      el("span", { class: "to-element-text" }, text),
      el("button", {
        class: "to-element-del",
        onclick: () => {
          const removed = T.elements.splice(i, 1)[0];
          if (removed.type === "scale") T.scale = null;
          refreshTakeoffSidebar();
          redraw();
        },
      }, "✕"),
    ]);
  }

  /* ---- Drop zone (shown until an image is loaded) ---- */

  function renderDropZone() {
    const zone = el("div", { class: "to-dropzone" + (T.image ? " hidden" : "") });
    const fileInput = el("input", { type: "file", accept: "image/*,application/pdf" });
    fileInput.style.display = "none";
    fileInput.addEventListener("change", (e) => {
      const f = e.target.files[0];
      if (f) handleFile(f);
    });
    zone.appendChild(el("div", { class: "to-dropzone-inner" }, [
      el("div", { class: "to-dropzone-icon" }, "📥"),
      el("div", { class: "to-dropzone-title" }, "Drop your floor plan here"),
      el("div", { class: "to-dropzone-sub" }, "or click anywhere in this area to browse"),
      el("div", { class: "to-dropzone-formats" }, "JPG · PNG · PDF"),
    ]));
    zone.appendChild(fileInput);
    zone.onclick = () => fileInput.click();
    zone.ondragover = (e) => { e.preventDefault(); zone.classList.add("drag-active"); };
    zone.ondragleave = (e) => {
      if (e.target === zone) zone.classList.remove("drag-active");
    };
    zone.ondrop = (e) => {
      e.preventDefault();
      zone.classList.remove("drag-active");
      const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleFile(f);
    };
    return zone;
  }

  function updateDropZoneVisibility() {
    const dz = document.querySelector(".to-dropzone");
    if (!dz) return;
    if (T.image) dz.classList.add("hidden");
    else dz.classList.remove("hidden");
    const nav = document.querySelector(".to-page-nav");
    if (nav) {
      if (T.pages.length > 1) nav.classList.remove("hidden");
      else nav.classList.add("hidden");
    } else if (T.pages.length > 1) {
      // Nav didn't exist before, rebuild via full sidebar refresh path
      refreshPageNav();
    }
  }

  /* ---- Page navigation (multi-page PDFs) ---- */

  function renderPageNav() {
    const hidden = T.pages.length <= 1;
    const nav = el("div", { class: "to-page-nav" + (hidden ? " hidden" : "") });
    const prev = el("button", { class: "to-page-btn", title: "Previous page (← / ↑ / PageUp)" }, "◀");
    const next = el("button", { class: "to-page-btn", title: "Next page (→ / ↓ / PageDown)" }, "▶");
    if (T.currentPageIdx <= 0) prev.disabled = true;
    if (T.currentPageIdx >= T.pages.length - 1) next.disabled = true;
    prev.onclick = () => goToPageAndRefresh(T.currentPageIdx - 1);
    next.onclick = () => goToPageAndRefresh(T.currentPageIdx + 1);

    const info = el("div", { class: "to-page-info" });
    const select = el("select", { class: "to-page-select", title: "Jump to page" });
    for (let i = 0; i < T.pages.length; i++) {
      const opt = document.createElement("option");
      opt.value = String(i);
      const n = T.pages[i].elements.length;
      opt.textContent = `Page ${i + 1}${n ? ` (${n})` : ""}`;
      if (i === T.currentPageIdx) opt.setAttribute("selected", "");
      select.appendChild(opt);
    }
    select.onchange = (e) => goToPageAndRefresh(parseInt(e.target.value, 10));
    info.appendChild(select);

    const count = el("div", { class: "to-page-count" },
      `${T.pages.length ? T.currentPageIdx + 1 : 0} / ${T.pages.length}`);

    nav.appendChild(prev);
    nav.appendChild(count);
    nav.appendChild(info);
    nav.appendChild(next);
    return nav;
  }

  function refreshPageNav() {
    const existing = document.querySelector(".to-page-nav");
    if (existing) existing.replaceWith(renderPageNav());
  }

  function goToPageAndRefresh(idx) {
    goToPage(idx);
    refreshPageNav();
    refreshTakeoffSidebar();
    redraw();
  }

  /* ---- File loading ---- */

  async function handleFile(file) {
    // Capture the target session at the moment the upload starts so we can finish
    // even if the user closes the take-off overlay or switches to another THL tab
    // while a big PDF is still rendering.
    const targetSession = T.session;
    const preserved = {
      scale: T.scale, north: T.north, wallHeight: T.wallHeight,
      replaceTables: T.replaceTables, ortho: T.ortho, snapToImage: T.snapToImage,
    };
    try {
      let pages;
      if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) {
        pages = await loadPDF(file);
      } else {
        pages = [await loadImage(file)];
      }
      // If the user is still on the same session in the take-off overlay, update the live UI
      if (T.open && T.session === targetSession) {
        setPages(pages, 0);
        refreshTakeoffSidebar();
        updateDropZoneVisibility();
        redraw();
      }
      // Regardless of overlay state, persist the upload to the target session so it survives.
      if (targetSession) {
        targetSession.takeoff = {
          pages: pages,
          currentPageIdx: 0,
          scale: preserved.scale,
          north: preserved.north,
          wallHeight: preserved.wallHeight,
          replaceTables: preserved.replaceTables,
          ortho: preserved.ortho,
          snapToImage: preserved.snapToImage,
        };
        // Refresh the THL-page header (the "Auto Take-Off (resume — N items)" label)
        if (typeof window.render === "function" && !T.open) window.render();
      }
    } catch (err) {
      if (window.alertModal) await window.alertModal("Failed to load file: " + err.message, { title: "Load failed" });
    }
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => resolve(makePage(img, img.naturalWidth, img.naturalHeight));
      img.onerror = () => reject(new Error("Could not decode image"));
      img.src = url;
    });
  }

  async function loadPDF(file) {
    if (!window.pdfjsLib) throw new Error("PDF.js not loaded");
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdfjs/pdf.worker.min.js";
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    const total = pdf.numPages;
    const startSession = T.session;
    const pages = [];
    for (let i = 1; i <= total; i++) {
      // Only update the on-screen dropzone hint if the user is still on the
      // same session's take-off overlay (they may have closed or switched).
      if (T.open && T.session === startSession) {
        updateLoadingHint(`Rendering PDF page ${i} of ${total}…`);
      }
      const pg = await pdf.getPage(i);
      const viewport = pg.getViewport({ scale: 2 });
      const off = document.createElement("canvas");
      off.width = viewport.width; off.height = viewport.height;
      await pg.render({ canvasContext: off.getContext("2d"), viewport }).promise;
      pages.push(makePage(off, off.width, off.height));
    }
    if (T.open && T.session === startSession) updateLoadingHint(null);
    return pages;
  }

  function updateLoadingHint(msg) {
    const t = document.querySelector(".to-dropzone-title");
    const s = document.querySelector(".to-dropzone-sub");
    if (msg) { if (t) t.textContent = "Loading…"; if (s) s.textContent = msg; }
    else { if (t) t.textContent = "Drop your floor plan here"; if (s) s.textContent = "or click anywhere in this area to browse"; }
  }

  /* ---- Canvas sizing & coord transforms ---- */

  let resizeTimer = null;
  function onResizeThrottled() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!T.open) return;
      sizeCanvas();
      redraw();
    }, 100);
  }

  function sizeCanvas() {
    if (!canvas) return;
    const wrap = canvas.parentElement;
    if (!wrap) return;
    const r = wrap.getBoundingClientRect();
    canvas.width = Math.max(300, Math.floor(r.width));
    canvas.height = Math.max(300, Math.floor(r.height));
    ctx = canvas.getContext("2d");
  }

  function baseFitScale() {
    if (!canvas || !T.image) return 1;
    return Math.min(canvas.width / T.imageW, canvas.height / T.imageH) * 0.96;
  }
  function effScale() { return baseFitScale() * T.view.zoom; }
  function centerOffset() {
    const s = effScale();
    return {
      x: (canvas.width - T.imageW * s) / 2 + T.view.panX,
      y: (canvas.height - T.imageH * s) / 2 + T.view.panY,
    };
  }
  function imageToCanvas(pt) {
    const s = effScale(), o = centerOffset();
    return { x: pt.x * s + o.x, y: pt.y * s + o.y };
  }
  function canvasToImage(pt) {
    const s = effScale(), o = centerOffset();
    return { x: (pt.x - o.x) / s, y: (pt.y - o.y) / s };
  }
  function eventToCanvas(e) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /* ---- Snap ---- */

  function snapPoint(pt) {
    if (!T.image) return null;
    const s = effScale();
    const thresh = SNAP_PX / s;   // image-space snap radius
    let best = null;
    let bestD = Infinity;

    const consider = (candidate, type) => {
      const d = Math.hypot(candidate.x - pt.x, candidate.y - pt.y);
      if (d < thresh && d < bestD) { bestD = d; best = { x: candidate.x, y: candidate.y, type }; }
    };

    // First-vertex of current path (highest priority — lets user close polygons)
    if (T.currentPath.length >= 2) {
      consider(T.currentPath[0], "first");
    }
    // Vertices of current path (except last, which is under the pointer)
    for (let i = 0; i < T.currentPath.length - 1; i++) {
      consider(T.currentPath[i], "vertex");
    }

    // Vertices of finished elements (across all sub-paths)
    for (const elm of T.elements) {
      const paths = elm.paths || [elm.path];
      for (const p of paths) for (const v of p) consider(v, "vertex");
    }

    // Vertices of any previously-completed sub-paths of the IN-PROGRESS element
    for (const sp of T.completedSubPaths) for (const v of sp) consider(v, "vertex");

    // Nearest point on edges (only if no vertex snap found)
    if (!best) {
      for (const elm of T.elements) {
        const paths = elm.paths || [elm.path];
        paths.forEach(p => {
          for (let i = 1; i < p.length; i++) {
            const q = closestOnSegment(pt, p[i - 1], p[i]);
            consider(q, "edge");
          }
        });
        // Room polygon closing edge
        if (elm.type === "room" && elm.path.length > 2) {
          const q = closestOnSegment(pt, elm.path[elm.path.length - 1], elm.path[0]);
          consider(q, "edge");
        }
      }
      // Edges of in-progress completed sub-paths
      for (const sp of T.completedSubPaths) {
        for (let i = 1; i < sp.length; i++) {
          const q = closestOnSegment(pt, sp[i - 1], sp[i]);
          consider(q, "edge");
        }
      }
    }
    return best;
  }

  /* ---- Ortho constraint ---- */

  function applyOrtho(pt) {
    if (!T.ortho) return pt;
    if (T.currentPath.length === 0) return pt;
    const prev = T.currentPath[T.currentPath.length - 1];
    const dx = Math.abs(pt.x - prev.x);
    const dy = Math.abs(pt.y - prev.y);
    return dx >= dy
      ? { x: pt.x, y: prev.y }
      : { x: prev.x, y: pt.y };
  }

  /* ---- Snap to features in the uploaded image (edges / corners) ---- */

  // Precomputed grayscale bitmap of the CURRENT page, on first request
  function ensurePageGrayscale() {
    const p = T.pages[T.currentPageIdx];
    if (!p || !p.image) return null;
    if (p.grayscale) return p.grayscale;
    // Downsample if huge (keep max dim <= 1600 to bound memory)
    const maxDim = 1600;
    const scale = Math.min(1, maxDim / Math.max(p.imageW, p.imageH));
    const w = Math.max(1, Math.round(p.imageW * scale));
    const h = Math.max(1, Math.round(p.imageH * scale));
    try {
      const off = document.createElement("canvas");
      off.width = w; off.height = h;
      off.getContext("2d").drawImage(p.image, 0, 0, w, h);
      const px = off.getContext("2d").getImageData(0, 0, w, h).data;
      const gray = new Uint8Array(w * h);
      for (let i = 0, j = 0; i < px.length; i += 4, j++) {
        gray[j] = (px[i] + px[i + 1] + px[i + 2]) / 3;
      }
      p.grayscale = { data: gray, w, h, scale };
      return p.grayscale;
    } catch (err) {
      // e.g. tainted canvas — bail out silently
      return null;
    }
  }

  function snapToImageFeature(pt) {
    if (!T.snapToImage) return null;
    const gs = ensurePageGrayscale();
    if (!gs) return null;
    const s = effScale();
    const screenRadius = 14;
    const rad = Math.max(4, Math.round(screenRadius / s * gs.scale));
    const cx = Math.round(pt.x * gs.scale);
    const cy = Math.round(pt.y * gs.scale);
    let bestX = -1, bestY = -1, bestScore = 0;
    for (let dy = -rad; dy <= rad; dy++) {
      const y = cy + dy;
      if (y < 0 || y >= gs.h) continue;
      for (let dx = -rad; dx <= rad; dx++) {
        const x = cx + dx;
        if (x < 0 || x >= gs.w) continue;
        const brightness = gs.data[y * gs.w + x];
        const darkness = 255 - brightness;
        if (darkness < 90) continue;   // ignore near-white pixels
        const dist = Math.hypot(dx, dy);
        const score = darkness - dist * 4;
        if (score > bestScore) {
          bestScore = score;
          bestX = x; bestY = y;
        }
      }
    }
    if (bestX < 0) return null;
    return { x: bestX / gs.scale, y: bestY / gs.scale, type: "image" };
  }

  function closestOnSegment(p, a, b) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return { x: a.x, y: a.y };
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return { x: a.x + t * dx, y: a.y + t * dy };
  }

  /* ---- Facing (compass) math ---- */

  // Centroid of outdoor/room element vertices — falls back to all element points,
  // then to the image center. Used to pick the OUTWARD side of a window's wall.
  function referenceCentroid() {
    let pts = [];
    for (const e of T.elements) if (e.type === "outdoor" || e.type === "room") pts = pts.concat(e.path);
    if (pts.length === 0) for (const e of T.elements) pts = pts.concat(e.path);
    if (pts.length === 0) return { x: T.imageW / 2, y: T.imageH / 2 };
    let cx = 0, cy = 0;
    pts.forEach(p => { cx += p.x; cy += p.y; });
    return { x: cx / pts.length, y: cy / pts.length };
  }

  function outwardNormal(p0, p1, ref) {
    const dx = p1.x - p0.x, dy = p1.y - p0.y;
    const n1 = { x: -dy, y: dx };
    const n2 = { x: dy, y: -dx };
    const mid = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const rx = mid.x - ref.x, ry = mid.y - ref.y;
    return (n1.x * rx + n1.y * ry) >= (n2.x * rx + n2.y * ry) ? n1 : n2;
  }

  // Compass direction of `vec` relative to `north` (image coords, y-down).
  // Returns one of "N","NE","E","SE","S","SW","W","NW".
  function compassOf(vec, north) {
    const nMag = Math.hypot(north.x, north.y);
    const vMag = Math.hypot(vec.x, vec.y);
    if (nMag < 1e-9 || vMag < 1e-9) return "N";
    const dot = north.x * vec.x + north.y * vec.y;
    const cross = north.x * vec.y - north.y * vec.x;    // in image coords, +cross ⇒ clockwise
    const cos = Math.max(-1, Math.min(1, dot / (nMag * vMag)));
    let ang = Math.acos(cos);
    if (cross < 0) ang = -ang;
    if (ang < 0) ang += 2 * Math.PI;
    const idx = Math.round(ang * 4 / Math.PI) % 8;
    return COMPASS_DIRS[idx];
  }

  function computeWindowFacing(el) {
    if (!T.north || !T.north.vector) return null;
    const p0 = el.path[0], p1 = el.path[1];
    const ref = referenceCentroid();
    const outward = outwardNormal(p0, p1, ref);
    return compassOf(outward, T.north.vector);
  }

  /* ---- Vertex hit-testing + recompute ---- */

  function findVertexAt(imgPt) {
    const s = effScale();
    const thresh = 10 / s;   // 10 screen pixels
    for (const e of T.elements) {
      const paths = e.paths || [e.path];
      for (let subIdx = 0; subIdx < paths.length; subIdx++) {
        const path = paths[subIdx];
        for (let vertexIdx = 0; vertexIdx < path.length; vertexIdx++) {
          const v = path[vertexIdx];
          if (Math.hypot(v.x - imgPt.x, v.y - imgPt.y) < thresh) {
            return { element: e, subIdx: e.paths ? subIdx : null, vertexIdx };
          }
        }
      }
    }
    return null;
  }

  function recomputeElement(e) {
    const paths = e.paths || [e.path];
    if (e.type === "room") {
      const path = paths[0];
      let a = 0;
      for (let i = 0; i < path.length; i++) {
        const j = (i + 1) % path.length;
        a += path[i].x * path[j].y - path[j].x * path[i].y;
      }
      e.area = Math.abs(a) / 2 * T.scale * T.scale;
      e.volume = e.area * (e.height || 0);
    } else if (e.type === "outdoor" || e.type === "indoor") {
      e.subLengths = paths.map(p => {
        let s = 0;
        for (let i = 1; i < p.length; i++) s += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
        return s * T.scale;
      });
      e.length = e.subLengths.reduce((a, b) => a + b, 0);
    } else if (e.type === "window" || e.type === "door") {
      e.subLengths = paths.map(p => {
        let s = 0;
        for (let i = 1; i < p.length; i++) s += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
        return s * T.scale;
      });
      e.width = e.subLengths.reduce((a, b) => a + b, 0);
    } else if (e.type === "scale") {
      // Adjusting the scale reference line updates the global scale factor
      const p1 = paths[0][0], p2 = paths[0][1];
      const px = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      if (px > 0 && e.metres > 0) {
        T.scale = e.metres / px;
        // All non-scale elements need to be re-measured under the new scale
        T.elements.forEach(other => { if (other.type !== "scale") recomputeElement(other); });
      }
    }
  }

  /* ---- Drawing ---- */

  function redraw() {
    if (!canvas || !ctx) return;
    labelBoxes = [];   // rebuild each frame; label hit-testing reads this
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!T.image) {
      // Dropzone overlay covers the canvas — leave canvas blank so the checkerboard shows through
      return;
    }
    const s = effScale(), o = centerOffset();
    ctx.drawImage(T.image, o.x, o.y, T.imageW * s, T.imageH * s);
    T.elements.forEach(drawElement);
    if (T.currentPath.length > 0) drawCurrent();
    if (T.snapHit && T.tool) drawSnapIndicator();
    // Hide the North arrow while the user is actively re-drawing it so the old one doesn't get in the way
    if (T.north && !T.compassHidden) drawCompass();
  }

  function drawCompass() {
    const originC = imageToCanvas(T.north.origin);
    const tipC = {
      x: originC.x + T.north.vector.x * effScale(),
      y: originC.y + T.north.vector.y * effScale(),
    };
    const ang = Math.atan2(tipC.y - originC.y, tipC.x - originC.x);
    const color = COLORS.compass;

    ctx.save();
    // Shaft
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(originC.x, originC.y);
    ctx.lineTo(tipC.x, tipC.y);
    ctx.stroke();
    // Arrowhead
    const ah = 10;
    ctx.beginPath();
    ctx.moveTo(tipC.x, tipC.y);
    ctx.lineTo(tipC.x - ah * Math.cos(ang - Math.PI / 6), tipC.y - ah * Math.sin(ang - Math.PI / 6));
    ctx.lineTo(tipC.x - ah * Math.cos(ang + Math.PI / 6), tipC.y - ah * Math.sin(ang + Math.PI / 6));
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    // Origin dot
    ctx.beginPath();
    ctx.arc(originC.x, originC.y, 4, 0, Math.PI * 2);
    ctx.fillStyle = "white";
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    // "N" label past the tip
    const labOff = 16;
    const nx = tipC.x + labOff * Math.cos(ang);
    const ny = tipC.y + labOff * Math.sin(ang);
    ctx.font = "bold 14px 'Segoe UI', sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "rgba(15,24,38,0.85)";
    ctx.fillRect(nx - 10, ny - 10, 20, 20);
    ctx.strokeStyle = color;
    ctx.strokeRect(nx - 10, ny - 10, 20, 20);
    ctx.fillStyle = "white";
    ctx.fillText("N", nx, ny);
    ctx.restore();
  }

  function drawSnapIndicator() {
    const p = imageToCanvas(T.snapHit);
    const type = T.snapHit.type;
    const isFirst = type === "first";
    const isImage = type === "image";
    const color = isImage ? "#f5c542" : "#7fdca0";
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    if (isImage) {
      // Diamond for image-feature snap
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - 8);
      ctx.lineTo(p.x + 8, p.y);
      ctx.lineTo(p.x, p.y + 8);
      ctx.lineTo(p.x - 8, p.y);
      ctx.closePath();
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
    } else if (type === "edge") {
      ctx.strokeRect(p.x - 6, p.y - 6, 12, 12);
    } else {
      ctx.beginPath();
      ctx.arc(p.x, p.y, isFirst ? 10 : 8, 0, Math.PI * 2);
      ctx.stroke();
      if (isFirst) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 3, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function drawElement(e) {
    const color = e.color || COLORS[e.type];
    const pts = e.path.map(imageToCanvas);
    if (e.type === "room") {
      ctx.beginPath();
      pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
      ctx.closePath();
      const opacity = e.fillOpacity != null ? e.fillOpacity : 0.22;
      const alphaByte = Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, "0");
      ctx.fillStyle = color + alphaByte;
      ctx.fill();
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.stroke();
      pts.forEach(p => drawVertex(p, color));
      const c = polygonCentroid(pts);
      const lines = [];
      if (e.name) lines.push(e.name);
      lines.push(`${e.area.toFixed(2)} m²`);
      lines.push(`${e.volume.toFixed(2)} m³`);
      if (e.showKwM2)   lines.push(`${(e.area   * KW_PER_M2).toFixed(2)} kW (m²)`);
      if (e.showKwM3)   lines.push(`${(e.volume * KW_PER_M3).toFixed(2)} kW (m³)`);
      if (e.showVentM2) lines.push(`${(e.area   * LS_PER_M2).toFixed(1)} L/s (m²)`);
      if (e.showVentM3) lines.push(`${(e.volume * LS_PER_M3).toFixed(1)} L/s (m³)`);
      const a = labelAnchor(c, e);
      drawLabel(a.x, a.y, lines.join("\n"), color, e, c);
      // Attached note label (yellow), positioned by its own offset relative to the centroid
      if (e.note && e.note.trim()) {
        const s = effScale();
        const off = e.noteOffset || { x: 0, y: 90 / s };   // default below the main label
        const na = { x: c.x + off.x * s, y: c.y + off.y * s };
        drawNoteLabel(na.x, na.y, e.note, color, e, c);
      }
    } else if (e.type === "outdoor" || e.type === "indoor") {
      // Support one or more sub-paths (skip-gap creates multiple)
      const paths = e.paths || [e.path];
      // Draw each sub-path with its OWN length label
      paths.forEach((rawPath, subIdx) => {
        const sp = rawPath.map(imageToCanvas);
        ctx.beginPath();
        sp.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.strokeStyle = color;
        ctx.lineWidth = 3;
        ctx.stroke();
        sp.forEach(p => drawVertex(p, color));

        // Per-sub-path label — placed at midpoint of longest segment IN THIS SUB-PATH
        let bestLen = 0, bestMid = null;
        for (let i = 1; i < sp.length; i++) {
          const l = Math.hypot(sp[i].x - sp[i - 1].x, sp[i].y - sp[i - 1].y);
          if (l > bestLen) {
            bestLen = l;
            bestMid = { x: (sp[i].x + sp[i - 1].x) / 2, y: (sp[i].y + sp[i - 1].y) / 2 };
          }
        }
        if (bestMid) {
          const subLen = (e.subLengths && e.subLengths[subIdx] != null) ? e.subLengths[subIdx] : e.length;
          // Per-sub-path label offset (independent drag per segment)
          if (!e.subLabelOffsets) e.subLabelOffsets = [];
          const off = e.subLabelOffsets[subIdx] || { x: 0, y: 0 };
          const scale = effScale();
          const anchor = { x: bestMid.x + off.x * scale, y: bestMid.y + off.y * scale };
          drawSubPathLabel(anchor.x, anchor.y, `${subLen.toFixed(2)} m`, color, e, subIdx, bestMid);
        }
      });
    } else if (e.type === "window" || e.type === "door") {
      const paths = e.paths || [e.path];
      paths.forEach((rawPath, subIdx) => {
        const sp = rawPath.map(imageToCanvas);
        ctx.beginPath();
        sp.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
        ctx.strokeStyle = color; ctx.lineWidth = 4;
        ctx.stroke();
        sp.forEach(p => drawVertex(p, color));

        // Per-segment label at longest-segment midpoint of this sub-path
        let bestLen = 0, bestMid = null;
        for (let i = 1; i < sp.length; i++) {
          const l = Math.hypot(sp[i].x - sp[i - 1].x, sp[i].y - sp[i - 1].y);
          if (l > bestLen) {
            bestLen = l;
            bestMid = { x: (sp[i].x + sp[i - 1].x) / 2, y: (sp[i].y + sp[i - 1].y) / 2 };
          }
        }
        if (bestMid) {
          const subLen = (e.subLengths && e.subLengths[subIdx] != null) ? e.subLengths[subIdx] : e.width;
          if (!e.subLabelOffsets) e.subLabelOffsets = [];
          const off = e.subLabelOffsets[subIdx] || { x: 0, y: 0 };
          const s = effScale();
          const anchor = { x: bestMid.x + off.x * s, y: bestMid.y + off.y * s };
          drawSubPathLabel(anchor.x, anchor.y, `${subLen.toFixed(2)} × ${e.height} m`, color, e, subIdx, bestMid);
        }
      });
    } else if (e.type === "scale") {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y); ctx.lineTo(pts[1].x, pts[1].y);
      ctx.strokeStyle = color; ctx.lineWidth = 2;
      ctx.setLineDash([8, 4]); ctx.stroke(); ctx.setLineDash([]);
      pts.forEach(p => drawVertex(p, color));
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      const a = labelAnchor(mid, e);
      drawLabel(a.x, a.y, `${e.metres} m ref`, color, e, mid);
    }
  }

  function drawCurrent() {
    const color = COLORS[T.tool] || "#666";
    // Draw previously-completed sub-paths (from Skip Gap) as solid lines
    T.completedSubPaths.forEach(sp => {
      const cp = sp.map(imageToCanvas);
      ctx.beginPath();
      cp.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.stroke();
      cp.forEach(p => drawVertex(p, color));
    });
    // The active sub-path — dashed
    const pts = T.currentPath.map(imageToCanvas);
    if (pts.length > 0) {
      ctx.beginPath();
      pts.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
      if (T.mousePos) {
        const m = imageToCanvas(T.mousePos);
        ctx.lineTo(m.x, m.y);
        if (T.tool === "room" && pts.length >= 2) {
          ctx.moveTo(m.x, m.y);
          ctx.lineTo(pts[0].x, pts[0].y);
        }
      }
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
      pts.forEach(p => drawVertex(p, color));
    }
  }

  function drawVertex(p, color) {
    ctx.beginPath();
    ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = "white"; ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.stroke();
  }

  function drawLabel(x, y, text, color, element, basePoint, subIdx) {
    const lines = String(text).split("\n");
    ctx.font = "bold 12px 'Segoe UI', sans-serif";
    const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 10;
    const lh = 15;
    const h = lines.length * lh + 6;
    const bx = x - w / 2, by = y - h / 2;

    // Leader line — drawn when the label has been moved AND user hasn't hidden it
    let ox = 0, oy = 0, hideLeader = false;
    if (element) {
      if (typeof subIdx === "number") {
        const soff = (element.subLabelOffsets && element.subLabelOffsets[subIdx]) || null;
        ox = (soff && soff.x) || 0;
        oy = (soff && soff.y) || 0;
        hideLeader = !!(element.subHideLeader && element.subHideLeader[subIdx]);
      } else {
        ox = (element.labelOffset && element.labelOffset.x) || 0;
        oy = (element.labelOffset && element.labelOffset.y) || 0;
        hideLeader = !!element.hideLeader;
      }
    }
    const moved = ox !== 0 || oy !== 0;
    if (element && basePoint && moved && !hideLeader) {
      const edge = clampToBox(basePoint.x, basePoint.y, bx, by, w, h);
      ctx.save();
      ctx.strokeStyle = color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(basePoint.x, basePoint.y);
      ctx.lineTo(edge.x, edge.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(basePoint.x, basePoint.y, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.8;
      ctx.fill();
      ctx.restore();
    }

    ctx.fillStyle = "rgba(15,24,38,0.85)";
    roundRect(ctx, bx, by, w, h, 4);
    ctx.fill();
    ctx.strokeStyle = color; ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "white";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    lines.forEach((l, i) => {
      ctx.fillText(l, x, by + lh / 2 + i * lh + 3);
    });
    if (element) labelBoxes.push({
      element,
      role: (typeof subIdx === "number") ? "sub" : "main",
      subIdx: (typeof subIdx === "number") ? subIdx : null,
      x: bx, y: by, w, h,
    });
  }

  // Wrapper for per-sub-path labels (each has its own draggable offset)
  function drawSubPathLabel(x, y, text, color, element, subIdx, basePoint) {
    drawLabel(x, y, text, color, element, basePoint, subIdx);
  }

  // Note label — yellow, italic, dashed leader; rendered near the room label
  function drawNoteLabel(x, y, text, color, element, basePoint) {
    const lines = String(text).split("\n");
    ctx.font = "italic 12px 'Segoe UI', sans-serif";
    const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + 12;
    const lh = 15;
    const h = lines.length * lh + 8;
    const bx = x - w / 2, by = y - h / 2;

    // Leader line back to the anchor (unless hidden)
    if (basePoint && !element.hideNoteLeader) {
      const edge = clampToBox(basePoint.x, basePoint.y, bx, by, w, h);
      ctx.save();
      ctx.strokeStyle = "#b08920";
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.2;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(basePoint.x, basePoint.y);
      ctx.lineTo(edge.x, edge.y);
      ctx.stroke();
      ctx.restore();
    }

    // Sticky-note styling
    ctx.fillStyle = "rgba(255,244,200,0.95)";
    roundRect(ctx, bx, by, w, h, 4);
    ctx.fill();
    ctx.strokeStyle = "#e0b84a"; ctx.lineWidth = 1;
    ctx.stroke();
    ctx.fillStyle = "#5a4200";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    lines.forEach((l, i) => {
      ctx.fillText(l, x, by + lh / 2 + i * lh + 4);
    });
    labelBoxes.push({ element, role: "note", subIdx: null, x: bx, y: by, w, h });
  }

  // Point on the label box's edge nearest to the anchor point (px, py) — used to end the leader line
  function clampToBox(px, py, bx, by, bw, bh) {
    const cx = Math.max(bx, Math.min(px, bx + bw));
    const cy = Math.max(by, Math.min(py, by + bh));
    return { x: cx, y: cy };
  }

  function labelAnchor(base, e) {
    const s = effScale();
    const ox = (e && e.labelOffset && e.labelOffset.x) || 0;
    const oy = (e && e.labelOffset && e.labelOffset.y) || 0;
    return { x: base.x + ox * s, y: base.y + oy * s };
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y); ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r); ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h); ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r); ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  function midpointOfLongestSegment(pts) {
    if (pts.length < 2) return pts[0] || { x: 0, y: 0 };
    if (pts.length === 2) return { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
    let maxLen = 0, best = { x: pts[0].x, y: pts[0].y };
    for (let i = 1; i < pts.length; i++) {
      const l = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
      if (l > maxLen) {
        maxLen = l;
        best = { x: (pts[i].x + pts[i - 1].x) / 2, y: (pts[i].y + pts[i - 1].y) / 2 };
      }
    }
    return best;
  }

  function polygonCentroid(pts) {
    let cx = 0, cy = 0, a = 0;
    for (let i = 0; i < pts.length; i++) {
      const j = (i + 1) % pts.length;
      const cross = pts[i].x * pts[j].y - pts[j].x * pts[i].y;
      cx += (pts[i].x + pts[j].x) * cross;
      cy += (pts[i].y + pts[j].y) * cross;
      a += cross;
    }
    a *= 0.5;
    if (Math.abs(a) < 1e-6) return pts[0];
    return { x: cx / (6 * a), y: cy / (6 * a) };
  }

  /* ---- Canvas event handlers ---- */

  function attachCanvasHandlers() {
    if (!canvas) return;
    canvas.onclick = onClick;
    canvas.ondblclick = onDblClick;
    canvas.onmousemove = onMove;
    canvas.onwheel = onWheel;
    canvas.oncontextmenu = (e) => e.preventDefault();
    canvas.onmousedown = onDown;
    canvas.onmouseup = onUp;
    canvas.onmouseleave = () => { T.mousePos = null; T.snapHit = null; redraw(); };
    // Global key handler
    if (!window._takeoffKeyHandler) {
      window._takeoffKeyHandler = (e) => {
        if (!T.open) return;
        if (document.querySelector(".modal-backdrop.modal-top")) return;   // a prompt/alert/confirm modal is open — let it handle keys
        if (e.key === "Escape") {
          if (T.toolboxPos) { closeMouseToolbox(); return; }
          // Cancel any in-progress draw; if we were re-drawing North, un-hide the old arrow
          if (T.currentPath.length > 0 || T.completedSubPaths.length > 0 || T.compassHidden) {
            T.currentPath = []; T.completedSubPaths = [];
            if (T.tool === "compass") T.compassHidden = false;
            refreshTakeoffSidebar(); redraw();
          }
          else window.closeTakeoff();
        } else if (e.key === "Enter") {
          if (T.currentPath.length >= 2 &&
              (T.tool === "outdoor" || T.tool === "indoor" || T.tool === "room" ||
               T.tool === "window"  || T.tool === "door")) {
            finishCurrent();
          }
        } else if (e.key === "z" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault(); undoLast();
        } else if (e.key === " " && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // Spacebar → skip-gap (walls, windows, doors)
          if ((T.tool === "outdoor" || T.tool === "indoor" || T.tool === "window" || T.tool === "door")
              && T.currentPath.length >= 2) {
            e.preventDefault();
            skipGap();
          }
        } else if (e.key === "F8") {
          e.preventDefault();
          T.ortho = !T.ortho;
          refreshTakeoffSidebar(); redraw();
        } else if (e.key === "F3") {
          e.preventDefault();
          T.snapToImage = !T.snapToImage;
          refreshTakeoffSidebar(); redraw();
        } else if ((e.key === "t" || e.key === "T") && !e.ctrlKey && !e.metaKey && !e.altKey) {
          // Focus check — don't hijack when user is typing in a modal input
          if (document.activeElement && document.activeElement.tagName === "INPUT") return;
          e.preventDefault();
          toggleMouseToolbox();
        } else if (e.key === "PageUp" || e.key === "ArrowLeft" || e.key === "ArrowUp") {
          // Skip if the user is typing in an input/select (they may be scrubbing a number)
          const ae = document.activeElement;
          if (ae && (ae.tagName === "INPUT" || ae.tagName === "SELECT" || ae.tagName === "TEXTAREA")) return;
          if (T.pages.length > 1) { e.preventDefault(); goToPageAndRefresh(T.currentPageIdx - 1); }
        } else if (e.key === "PageDown" || e.key === "ArrowRight" || e.key === "ArrowDown") {
          const ae = document.activeElement;
          if (ae && (ae.tagName === "INPUT" || ae.tagName === "SELECT" || ae.tagName === "TEXTAREA")) return;
          if (T.pages.length > 1) { e.preventDefault(); goToPageAndRefresh(T.currentPageIdx + 1); }
        }
      };
      window.addEventListener("keydown", window._takeoffKeyHandler);
    }
  }

  function onClick(e) {
    if (T.dragging || T.busy || justDraggedLabel) return;
    if (!T.image || !T.tool) return;
    const raw = canvasToImage(eventToCanvas(e));
    const orthoed = applyOrtho(raw);
    let snap = snapPoint(orthoed);
    if (!snap) {
      const imgSnap = snapToImageFeature(orthoed);
      if (imgSnap) snap = imgSnap;
    }
    const pt = snap ? { x: snap.x, y: snap.y } : orthoed;

    if (T.tool === "scale" || T.tool === "compass") {
      T.currentPath.push(pt);
      if (T.currentPath.length === 2) finishCurrent();
      else redraw();
      return;
    }

    // outdoor / indoor / window / door / room — polyline
    if (!T.scale) { warnNoScale(); return; }

    // First-vertex snap → close and finish (polygons + closed wall loops)
    if (snap && snap.type === "first" && T.currentPath.length >= 3) {
      T.currentPath.push({ x: snap.x, y: snap.y });
      finishCurrent();
      return;
    }

    T.currentPath.push(pt);

    // Auto-finish window/door on the 2nd click, UNLESS Ctrl is held (extend to polyline)
    // or there are already sub-paths from a Skip-gap (keep collecting).
    const ctrlHeld = e.ctrlKey || e.metaKey;
    if ((T.tool === "window" || T.tool === "door")
        && T.currentPath.length === 2
        && !ctrlHeld
        && T.completedSubPaths.length === 0) {
      finishCurrent();
      return;
    }

    redraw();
  }

  function warnNoScale() {
    if (window.alertModal) window.alertModal("Set the scale first — pick the 📏 Set scale tool, click two points on a known-length feature, and enter its real length.", { title: "Scale not set" });
  }

  function skipGap() {
    if (T.currentPath.length < 2) return;
    T.completedSubPaths.push(T.currentPath.slice());
    T.currentPath = [];
    refreshTakeoffSidebar();
    redraw();
  }

  // Switch the active tool. Handles Compass-hide-while-redrawing.
  function switchTool(newKey) {
    const oldKey = T.tool;
    if (oldKey === newKey) return;
    // Leaving compass tool without finishing → restore old North visibility
    if (oldKey === "compass") T.compassHidden = false;
    // Entering compass while a North arrow already exists → hide it so the user can re-draw cleanly
    if (newKey === "compass" && T.north) T.compassHidden = true;
    T.tool = newKey;
    T.currentPath = [];
    T.completedSubPaths = [];
    refreshTakeoffSidebar();
    redraw();
  }

  /* ---- Quick tool picker at mouse (T hotkey) ---- */

  function toggleMouseToolbox() {
    if (!T.image) return;
    if (T.toolboxPos) {
      closeMouseToolbox();
      return;
    }
    const pos = T.lastMouseScreen || { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    T.toolboxPos = { x: pos.x, y: pos.y };
    showMouseToolbox();
  }

  function closeMouseToolbox() {
    T.toolboxPos = null;
    const existing = document.getElementById("mouse-toolbox");
    if (existing) existing.remove();
    document.removeEventListener("mousedown", onOutsideToolboxClick, true);
  }

  function onOutsideToolboxClick(e) {
    const tb = document.getElementById("mouse-toolbox");
    if (tb && !tb.contains(e.target)) closeMouseToolbox();
  }

  function showMouseToolbox() {
    const existing = document.getElementById("mouse-toolbox");
    if (existing) existing.remove();
    const tb = document.createElement("div");
    tb.id = "mouse-toolbox";
    tb.className = "mouse-toolbox";

    const title = document.createElement("div");
    title.className = "mouse-toolbox-title";
    title.textContent = "Quick tools";
    tb.appendChild(title);

    // Tools — vertical stack, one per row
    const col = document.createElement("div");
    col.className = "mouse-toolbox-col";
    TOOLS.forEach(t => {
      const b = document.createElement("button");
      b.className = "mouse-toolbox-btn" + (T.tool === t.key ? " active" : "");
      b.style.borderLeftColor = COLORS[t.key];
      b.textContent = t.label;
      b.onclick = () => {
        closeMouseToolbox();
        switchTool(t.key);
      };
      col.appendChild(b);
    });
    tb.appendChild(col);

    // Drawing aids section
    const aidTitle = document.createElement("div");
    aidTitle.className = "mouse-toolbox-title";
    aidTitle.style.marginTop = "6px";
    aidTitle.textContent = "Drawing aids";
    tb.appendChild(aidTitle);

    const aidCol = document.createElement("div");
    aidCol.className = "mouse-toolbox-col";
    const orthoAid = document.createElement("button");
    orthoAid.className = "mouse-toolbox-btn" + (T.ortho ? " aid-active" : "");
    orthoAid.textContent = (T.ortho ? "✓ " : "  ") + "📐 Ortho (F8)";
    orthoAid.onclick = () => {
      T.ortho = !T.ortho;
      closeMouseToolbox();
      refreshTakeoffSidebar();
      redraw();
    };
    aidCol.appendChild(orthoAid);
    const snapAid = document.createElement("button");
    snapAid.className = "mouse-toolbox-btn" + (T.snapToImage ? " aid-active" : "");
    snapAid.textContent = (T.snapToImage ? "✓ " : "  ") + "🎯 Snap image (F3)";
    snapAid.onclick = () => {
      T.snapToImage = !T.snapToImage;
      closeMouseToolbox();
      refreshTakeoffSidebar();
      redraw();
    };
    aidCol.appendChild(snapAid);
    tb.appendChild(aidCol);

    const cancel = document.createElement("button");
    cancel.className = "mouse-toolbox-cancel";
    cancel.textContent = "Close (Esc)";
    cancel.onclick = closeMouseToolbox;
    tb.appendChild(cancel);

    document.body.appendChild(tb);
    const w = tb.offsetWidth, h = tb.offsetHeight;
    let left = T.toolboxPos.x - w / 2;
    let top  = T.toolboxPos.y - 20;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    top  = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    tb.style.left = left + "px";
    tb.style.top  = top + "px";
    setTimeout(() => document.addEventListener("mousedown", onOutsideToolboxClick, true), 0);
  }

  function onDblClick(e) {
    // Double-click on a room label → open the properties modal
    if (T.image) {
      const c = eventToCanvas(e);
      const hit = hitLabel(c.x, c.y);
      if (hit && hit.element && hit.element.type === "room" && hit.role === "main") {
        e.preventDefault();
        e.stopPropagation();
        openRoomPropertiesModal(hit.element);
        return;
      }
    }
    if (!T.tool) return;
    if ((T.tool === "outdoor" || T.tool === "indoor" || T.tool === "room" ||
         T.tool === "window"  || T.tool === "door")
        && T.currentPath.length >= 2) {
      const last = T.currentPath[T.currentPath.length - 1];
      const prev = T.currentPath[T.currentPath.length - 2];
      if (prev && Math.hypot(last.x - prev.x, last.y - prev.y) < 3 / effScale()) {
        T.currentPath.pop();
      }
      finishCurrent();
    }
  }

  function onMove(e) {
    // Dragging a vertex (Ctrl+drag)
    if (vertexDrag) {
      const c = eventToCanvas(e);
      let pt = canvasToImage(c);
      // Apply ortho if enabled (relative to the adjacent vertex, when there is one)
      if (T.ortho) {
        const paths = vertexDrag.element.paths || [vertexDrag.element.path];
        const p = paths[vertexDrag.subIdx == null ? 0 : vertexDrag.subIdx];
        const prev = p[vertexDrag.vertexIdx - 1] || p[vertexDrag.vertexIdx + 1];
        if (prev) {
          const dx = Math.abs(pt.x - prev.x);
          const dy = Math.abs(pt.y - prev.y);
          pt = dx >= dy ? { x: pt.x, y: prev.y } : { x: prev.x, y: pt.y };
        }
      }
      const paths = vertexDrag.element.paths || [vertexDrag.element.path];
      const path = paths[vertexDrag.subIdx == null ? 0 : vertexDrag.subIdx];
      path[vertexDrag.vertexIdx].x = pt.x;
      path[vertexDrag.vertexIdx].y = pt.y;
      recomputeElement(vertexDrag.element);
      refreshTakeoffSidebar();
      redraw();
      return;
    }
    // Dragging a label
    if (labelDrag) {
      const c = eventToCanvas(e);
      const imgNow = canvasToImage(c);
      const dx = imgNow.x - labelDrag.startMouseImg.x;
      const dy = imgNow.y - labelDrag.startMouseImg.y;
      const newOff = {
        x: labelDrag.startOffset.x + dx,
        y: labelDrag.startOffset.y + dy,
      };
      if (labelDrag.role === "note") {
        labelDrag.element.noteOffset = newOff;
      } else if (typeof labelDrag.subIdx === "number") {
        if (!labelDrag.element.subLabelOffsets) labelDrag.element.subLabelOffsets = [];
        labelDrag.element.subLabelOffsets[labelDrag.subIdx] = newOff;
      } else {
        labelDrag.element.labelOffset = newOff;
      }
      redraw();
      return;
    }
    // Panning with middle/right button
    if (T.dragging) {
      const c = eventToCanvas(e);
      T.view.panX = T.dragOrigin.panX + (c.x - T.dragStart.x);
      T.view.panY = T.dragOrigin.panY + (c.y - T.dragStart.y);
      redraw();
      return;
    }
    if (!T.image) return;

    // Hover cursor over labels
    const c = eventToCanvas(e);
    T.lastMouseScreen = { x: e.clientX, y: e.clientY };
    const overLabel = hitLabel(c.x, c.y);
    canvas.style.cursor = overLabel ? "grab" : (T.tool ? "crosshair" : "default");

    const raw = canvasToImage(c);
    // Order: ortho constrain → user-vertex/edge snap → image-feature snap → cursor
    const orthoed = applyOrtho(raw);
    let snap = snapPoint(orthoed);
    if (!snap) {
      const imgSnap = snapToImageFeature(orthoed);
      if (imgSnap) snap = imgSnap;
    }
    const prevSnap = T.snapHit;
    T.snapHit = snap;
    T.mousePos = snap ? { x: snap.x, y: snap.y } : orthoed;
    if (T.currentPath.length > 0 || snap || prevSnap || T.ortho) redraw();
  }

  function hitLabel(cx, cy) {
    // Iterate in reverse so top-drawn labels win
    for (let i = labelBoxes.length - 1; i >= 0; i--) {
      const b = labelBoxes[i];
      if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) return b;
    }
    return null;
  }

  function onWheel(e) {
    if (!T.image) return;
    e.preventDefault();
    const c = eventToCanvas(e);
    const before = canvasToImage(c);
    const factor = e.deltaY > 0 ? 0.85 : 1.15;
    T.view.zoom = Math.max(0.1, Math.min(30, T.view.zoom * factor));
    const after = canvasToImage(c);
    const s = effScale();
    T.view.panX += (after.x - before.x) * s;
    T.view.panY += (after.y - before.y) * s;
    redraw();
  }

  function onDown(e) {
    // Left+Ctrl on an existing vertex → drag that vertex (only when NOT mid-draw)
    if (e.button === 0 && T.image && (e.ctrlKey || e.metaKey) && T.currentPath.length === 0) {
      const c = eventToCanvas(e);
      const imgPt = canvasToImage(c);
      const vh = findVertexAt(imgPt);
      if (vh) {
        e.preventDefault();
        e.stopPropagation();
        vertexDrag = vh;
        canvas.style.cursor = "grabbing";
        return;
      }
    }
    // Left button → try to grab a label first
    if (e.button === 0 && T.image) {
      const c = eventToCanvas(e);
      const hit = hitLabel(c.x, c.y);
      if (hit) {
        e.preventDefault();
        e.stopPropagation();
        const startImg = canvasToImage(c);
        let startOffset;
        if (hit.role === "note") {
          const off = hit.element.noteOffset || { x: 0, y: 90 / effScale() };
          startOffset = { x: off.x, y: off.y };
        } else if (typeof hit.subIdx === "number") {
          if (!hit.element.subLabelOffsets) hit.element.subLabelOffsets = [];
          const so = hit.element.subLabelOffsets[hit.subIdx] || { x: 0, y: 0 };
          startOffset = { x: so.x, y: so.y };
        } else {
          startOffset = {
            x: (hit.element.labelOffset && hit.element.labelOffset.x) || 0,
            y: (hit.element.labelOffset && hit.element.labelOffset.y) || 0,
          };
        }
        labelDrag = {
          element: hit.element,
          role: hit.role,
          subIdx: hit.subIdx,
          startOffset,
          startMouseImg: startImg,
        };
        canvas.style.cursor = "grabbing";
        return;
      }
    }
    // Right-click on a label → toggle its leader line (before pan behavior)
    if (e.button === 2 && T.image) {
      const c = eventToCanvas(e);
      const hit = hitLabel(c.x, c.y);
      if (hit && hit.element) {
        e.preventDefault();
        e.stopPropagation();
        if (typeof hit.subIdx === "number") {
          if (!hit.element.subHideLeader) hit.element.subHideLeader = [];
          hit.element.subHideLeader[hit.subIdx] = !hit.element.subHideLeader[hit.subIdx];
        } else {
          hit.element.hideLeader = !hit.element.hideLeader;
        }
        redraw();
        return;
      }
    }
    // Middle / right button → pan
    if (e.button === 1 || e.button === 2) {
      T.dragging = true;
      T.dragStart = eventToCanvas(e);
      T.dragOrigin = { panX: T.view.panX, panY: T.view.panY };
      canvas.style.cursor = "grabbing";
      e.preventDefault();
    }
  }

  function onUp(e) {
    if (vertexDrag) {
      vertexDrag = null;
      justDraggedLabel = true;   // reuse flag to suppress the click that follows
      setTimeout(() => { justDraggedLabel = false; }, 60);
      canvas.style.cursor = T.tool ? "crosshair" : "default";
      return;
    }
    if (labelDrag) {
      labelDrag = null;
      justDraggedLabel = true;
      setTimeout(() => { justDraggedLabel = false; }, 60);
      canvas.style.cursor = "grab";
      return;
    }
    if (T.dragging) {
      canvas.style.cursor = T.tool ? "crosshair" : "default";
      setTimeout(() => { T.dragging = false; }, 50);
    }
  }

  /* ---- Finish + prompts ---- */

  async function finishCurrent() {
    const tool = T.tool;
    const path = T.currentPath.slice();
    T.currentPath = [];
    if (path.length < 2) { redraw(); return; }

    T.busy = true;
    try {
      if (tool === "scale") {
        const px = Math.hypot(path[0].x - path[1].x, path[0].y - path[1].y);
        const m = await promptFloatModal("Enter the real-world length of this line in metres.",
          "", { title: "📏 Set Scale", hint: "e.g. door width 0.9, wall length 5, etc." });
        if (m === null || m <= 0) { redraw(); return; }
        T.scale = m / px;
        T.elements.push({ type: "scale", path, metres: m });
        refreshTakeoffSidebar(); redraw(); return;
      }

      if (tool === "compass") {
        T.north = {
          origin: path[0],
          vector: { x: path[1].x - path[0].x, y: path[1].y - path[0].y },
        };
        T.compassHidden = false;   // new arrow is the visible one
        refreshTakeoffSidebar(); redraw();
        return;
      }

      if (tool === "window" || tool === "door") {
        // Support skip-gap (multiple sub-paths) and multi-vertex polylines
        const subPaths = T.completedSubPaths.concat([path]).filter(p => p.length >= 2);
        T.completedSubPaths = [];
        if (subPaths.length === 0) { redraw(); return; }
        const subLengths = subPaths.map(p => {
          let s = 0;
          for (let i = 1; i < p.length; i++) s += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
          return s * T.scale;
        });
        const width = subLengths.reduce((a, b) => a + b, 0);
        const defH = tool === "window" ? 1.5 : 2.1;
        const segNote = subPaths.length > 1
          ? ` — ${subPaths.length} segments (${subLengths.map(l => l.toFixed(2)).join(" + ")} m)`
          : "";
        const h = await promptFloatModal(
          `Height (m) for this ${tool} — total width measured as ${width.toFixed(2)} m${segNote}.`,
          defH, { title: tool === "window" ? "🟦 Window height" : "🟩 Door height" });
        if (h === null || h <= 0) { redraw(); return; }
        T.elements.push({
          type: tool,
          path: subPaths[0],
          paths: subPaths,
          subLengths,
          width, height: h,
        });
        refreshTakeoffSidebar(); redraw(); return;
      }

      if (tool === "outdoor" || tool === "indoor") {
        // Collect all sub-paths (previously "skipped" plus the current one)
        const subPaths = T.completedSubPaths.concat([path]).filter(p => p.length >= 2);
        T.completedSubPaths = [];
        if (subPaths.length === 0) { redraw(); return; }
        // Compute per-sub-path lengths + total
        const subLengths = subPaths.map(p => {
          let s = 0;
          for (let i = 1; i < p.length; i++) s += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
          return s * T.scale;
        });
        const len = subLengths.reduce((a, b) => a + b, 0);
        const segNote = subPaths.length > 1
          ? ` — ${subPaths.length} segments (${subLengths.map(l => l.toFixed(2)).join(" + ")} m)`
          : "";
        const h = await promptFloatModal(`Wall height (m) — total run measured as ${len.toFixed(2)} m${segNote}.`,
          T.wallHeight, { title: tool === "outdoor" ? "🟥 Outdoor wall height" : "🟧 Indoor wall height" });
        if (h === null || h <= 0) { redraw(); return; }
        T.wallHeight = h;
        T.elements.push({
          type: tool,
          path: subPaths[0],       // .path retained for back-compat = first sub-path
          paths: subPaths,          // full list of sub-paths
          subLengths,               // one length per sub-path (metres)
          length: len, height: h,
        });
        refreshTakeoffSidebar(); redraw(); return;
      }

      if (tool === "room") {
        if (path.length < 3) {
          await window.alertModal("Need at least 3 points for a room polygon.", { title: "Room too small" });
          redraw(); return;
        }
        let a = 0;
        for (let i = 0; i < path.length; i++) {
          const j = (i + 1) % path.length;
          a += path[i].x * path[j].y - path[j].x * path[i].y;
        }
        const areaPx = Math.abs(a) / 2;
        const area = areaPx * T.scale * T.scale;

        const h = await promptFloatModal(`Ceiling height (m) — floor area measured as ${area.toFixed(2)} m².`,
          T.wallHeight, { title: "🟪 Ceiling height" });
        if (h === null || h <= 0) { redraw(); return; }
        T.wallHeight = h;
        const volume = area * h;

        // Ask for a name (optional — Skip leaves it unnamed)
        const roomIdx = T.elements.filter(x => x.type === "room").length;
        const suggested = `Room ${roomIdx + 1}`;
        const rawName = await window.promptModal(
          "Name for this room (leave blank to skip):",
          suggested,
          { title: "🟪 Room name", type: "text", okLabel: "Save", cancelLabel: "Skip" }
        );
        const name = (rawName && rawName.trim()) ? rawName.trim() : null;

        const color = ROOM_COLORS[roomIdx % ROOM_COLORS.length];

        T.elements.push({
          type: "room", path, area, height: h, volume, name, color,
          fillOpacity: 0.22,
          showKwM2: false, showKwM3: false, showVentM2: false, showVentM3: false,
          note: "", noteOffset: null,
        });
        refreshTakeoffSidebar(); redraw();
        await window.alertModal(
          (name ? name + "\n\n" : "") +
          `Floor area:  ${area.toFixed(2)} m²\nCeiling height:  ${h} m\nVolume:  ${volume.toFixed(2)} m³`,
          { title: "🟪 Room measured" });
        return;
      }
    } finally {
      T.busy = false;
    }
  }

  async function promptFloatModal(msg, dflt, opts) {
    if (!window.promptModal) return null;
    const s = await window.promptModal(msg, dflt, opts);
    if (s === null || s === "") return null;
    const v = parseFloat(s);
    return isNaN(v) ? null : v;
  }

  /* ---- Totals ---- */

  function computeTotals() {
    // Current page only — Apply creates a sub-page from this page's measurements.
    let outdoorLen = 0, indoorLen = 0, roomsArea = 0, roomsVol = 0, windows = 0, doors = 0;
    (T.elements || []).forEach(e => {
      if (e.type === "outdoor") outdoorLen += e.length;
      else if (e.type === "indoor") indoorLen += e.length;
      else if (e.type === "room") { roomsArea += e.area; roomsVol += e.volume; }
      else if (e.type === "window") windows++;
      else if (e.type === "door") doors++;
    });
    return { outdoorLen, indoorLen, roomsArea, roomsVol, windows, doors };
  }

  /* ---- Undo / clear ---- */

  async function undoLast() {
    if (T.currentPath.length > 0) {
      T.currentPath.pop();
      redraw();
      return;
    }
    if (T.completedSubPaths.length > 0) {
      T.currentPath = T.completedSubPaths.pop();
      refreshTakeoffSidebar(); redraw();
      return;
    }
    if (T.elements.length > 0) {
      const last = T.elements[T.elements.length - 1];
      if (last.type === "scale") {
        if (!window.confirmModal) return;
        const yes = await window.confirmModal(
          `Undo the scale reference (${last.metres} m)?\n\n` +
          `Every measurement will lose its metre-scale until you set the scale again.`,
          { title: "Undo scale reference?", danger: true, okLabel: "Undo scale" });
        if (!yes) return;
        T.elements.pop();
        T.scale = null;
        refreshTakeoffSidebar(); redraw();
        return;
      }
      T.elements.pop();
      refreshTakeoffSidebar(); redraw();
      return;
    }
    // Nothing left in the element stack — offer to undo North if it's set
    if (T.north && window.confirmModal) {
      const yes = await window.confirmModal(
        `Nothing else to undo. Do you want to clear the North direction as well?\n\n` +
        `Window facings will fall back to "N" if you apply after this.`,
        { title: "Undo North direction?", danger: true, okLabel: "Clear North" });
      if (!yes) return;
      T.north = null;
      refreshTakeoffSidebar(); redraw();
    }
  }

  function clearAll() {
    // Wipe elements on EVERY page (mutate in place so T.elements reference stays valid)
    T.pages.forEach(p => { p.elements.length = 0; });
    T.currentPath = [];
    T.completedSubPaths = [];
    T.scale = null;
    T.north = null;
    T.compassHidden = false;
    T.tool = null;
    refreshTakeoffSidebar(); redraw();
  }

  /* ---- Apply to THL ---- Creates one new sub-page from the CURRENT take-off page's measurements. ---- */

  async function applyToTHL() {
    const s = T.session;
    if (!s) return;

    // Only current page's measurements go into the new sub
    const currentEls = T.elements || [];
    let outdoorLen = 0, indoorLen = 0, roomsArea = 0, roomsVol = 0;
    currentEls.forEach(e => {
      if (e.type === "outdoor") outdoorLen += e.length;        // e.length already sums all sub-paths
      else if (e.type === "indoor") indoorLen += e.length;
      else if (e.type === "room") { roomsArea += e.area; roomsVol += e.volume; }
    });
    const winEls  = currentEls.filter(e => e.type === "window");
    const doorEls = currentEls.filter(e => e.type === "door");
    const hasAnything = outdoorLen > 0 || indoorLen > 0 || roomsArea > 0
                     || winEls.length > 0 || doorEls.length > 0;
    if (!hasAnything) {
      await window.alertModal("Nothing to apply — no measurements on this page yet.\n\nDraw on the current page (or switch page with the top nav) then click Apply.", { title: "Nothing to apply" });
      return;
    }

    // Build the data payload that would be applied
    const buildPayload = () => {
      const d = window.emptyTHLData();
      // Carry over sensible defaults from the parent (materials, activity, etc)
      ["wallMaterial", "sunExposure", "carpet", "ceilingInsulation", "activity"].forEach(k => {
        if (s.data[k] !== undefined) d[k] = s.data[k];
      });
      d.appliances = num(s.data.appliances) || 500;
      if (outdoorLen > 0) d.outdoorPerimeter = round3(outdoorLen);
      if (indoorLen > 0)  d.indoorPerimeter  = round3(indoorLen);
      if (roomsArea > 0)  d.roomArea = round3(roomsArea);
      if (T.wallHeight)   d.wallHeight = T.wallHeight;
      winEls.forEach(e => {
        const facing = computeWindowFacing(e) || "N";
        d.windows.push({
          count: 1, width: round3(e.width), height: e.height,
          facing, shading: "Curtains/Blinds",
        });
      });
      doorEls.forEach(e => d.doors.push({
        count: 1, width: round3(e.width), height: e.height,
      }));
      return d;
    };

    // Does a sub already exist for this take-off page?
    const existingIdx = s.subs.findIndex(sub => sub.takeoffPage === T.currentPageIdx);
    const existing = existingIdx >= 0 ? s.subs[existingIdx] : null;

    // Decide: update the existing sub OR create a new one
    let mode;   // "update" | "create" | null
    if (existing && window.chooseModal) {
      mode = await window.chooseModal(
        `A sub-page already exists for take-off page ${T.currentPageIdx + 1}: "${existing.name}".\n\n` +
        `Update it with the current measurements (replaces its values), or create a new sub-page?`,
        [
          { label: `Update "${existing.name}"`, value: "update", primary: true },
          { label: "Create new sub-page",       value: "create" },
          { label: "Cancel",                    value: null },
        ],
        { title: "🖼️ Apply to THL" }
      );
      if (mode === null) return;
    } else {
      mode = "create";
    }

    let sub;
    if (mode === "update" && existing) {
      // Replace existing sub's data with the fresh payload; preserve name + id + takeoffPage
      const payload = buildPayload();
      // Overwrite only calculation-relevant fields; keep user-set categorical fields on the sub unchanged
      const keptFields = ["wallMaterial", "sunExposure", "carpet", "ceilingInsulation", "activity", "appliances", "peopleCount"];
      keptFields.forEach(k => { if (existing.data[k] !== undefined) payload[k] = existing.data[k]; });
      existing.data = payload;
      s.activeSub = existingIdx;
      sub = existing;
    } else {
      // Create new — prompt for name
      const pageNum = T.currentPageIdx + 1;
      const totalPages = T.pages.length;
      const suggested = totalPages > 1 ? `Page ${pageNum}` : (s.name || "Main");
      const nameRaw = await window.promptModal(
        `Name this new sub-page (measurements from take-off page ${pageNum}${totalPages > 1 ? " of " + totalPages : ""}):`,
        suggested,
        { title: "🖼️ Apply → New sub-page", type: "text", okLabel: "Create sub-page", cancelLabel: "Cancel" }
      );
      if (nameRaw === null) return;
      const subName = (nameRaw || "").trim() || suggested;
      // First-time conversion: preserve parent data as a "Main" sub before adding
      if (window.convertParentDataToMainSub) window.convertParentDataToMainSub(s);
      sub = window.newSubPage(subName, buildPayload());
      sub.takeoffPage = T.currentPageIdx;
      s.subs.push(sub);
      s.activeSub = s.subs.length - 1;
    }

    // Confirmation
    const parts = [];
    if (outdoorLen > 0) parts.push(`outdoor perimeter ${round3(outdoorLen)} m`);
    if (indoorLen > 0)  parts.push(`indoor perimeter ${round3(indoorLen)} m`);
    if (roomsArea > 0)  parts.push(`room area ${round3(roomsArea)} m²`);
    if (T.wallHeight)   parts.push(`wall height ${T.wallHeight} m`);
    if (winEls.length > 0) {
      const facingNote = T.north ? " (facings auto-detected)" : " (facings default N — set 🧭 first)";
      parts.push(`${winEls.length} window${winEls.length === 1 ? "" : "s"}${facingNote}`);
    }
    if (doorEls.length > 0) parts.push(`${doorEls.length} door${doorEls.length === 1 ? "" : "s"}`);

    const verb = mode === "update" ? "Updated" : "Created";
    await window.alertModal(
      `${verb} sub-page "${sub.name}" with:\n\n• ` + parts.join("\n• ") +
      "\n\nTake-Off stays open — switch page and Apply again for another sub, or Close when done.",
      { title: mode === "update" ? "✓ Sub-page updated" : "✓ Sub-page created" }
    );
  }

  function round3(v) { return Math.round(v * 1000) / 1000; }

  /* ---- Room properties modal (dbl-click a room label to open) ---- */

  function openRoomPropertiesModal(elm) {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop modal-top";
    const modal = document.createElement("div");
    modal.className = "modal modal-prompt";
    modal.style.maxWidth = "540px";

    const header = document.createElement("div");
    header.className = "modal-header";
    const h2 = document.createElement("h2");
    h2.textContent = "🟪 Room properties";
    header.appendChild(h2);

    const body = document.createElement("div");
    body.className = "modal-body";

    const kwM2   = elm.area   * KW_PER_M2;
    const kwM3   = elm.volume * KW_PER_M3;
    const ventM2 = elm.area   * LS_PER_M2;
    const ventM3 = elm.volume * LS_PER_M3;

    body.innerHTML =
      `<div class="rprops-grid">` +
        `<label class="rprops-lbl">Name</label>` +
        `<input class="rprops-input" id="rp-name" type="text" value="${escapeAttr(elm.name || "")}">` +

        `<label class="rprops-lbl">Fill colour</label>` +
        `<div style="display:flex; gap:8px; align-items:center;">` +
          `<input class="rprops-color" id="rp-color" type="color" value="${escapeAttr(elm.color || "#8a4dd6")}">` +
          `<span class="rprops-hint">Polygon fill + border</span>` +
        `</div>` +

        `<label class="rprops-lbl">Opacity</label>` +
        `<div style="display:flex; gap:8px; align-items:center;">` +
          `<input class="rprops-range" id="rp-opacity" type="range" min="0" max="100" value="${Math.round((elm.fillOpacity != null ? elm.fillOpacity : 0.22) * 100)}">` +
          `<span class="rprops-hint" id="rp-opacity-out">${Math.round((elm.fillOpacity != null ? elm.fillOpacity : 0.22) * 100)}%</span>` +
        `</div>` +
      `</div>` +

      `<div class="rprops-section">` +
        `<div class="rprops-section-title">HVAC (rule-of-thumb)</div>` +
        `<div class="rprops-checks">` +
          `<label><input type="checkbox" id="rp-kw-m2" ${elm.showKwM2 ? "checked" : ""}> Show <b>${kwM2.toFixed(2)} kW</b> — from <b>${elm.area.toFixed(2)} m² × 0.15 kW/m²</b></label>` +
          `<label><input type="checkbox" id="rp-kw-m3" ${elm.showKwM3 ? "checked" : ""}> Show <b>${kwM3.toFixed(2)} kW</b> — from <b>${elm.volume.toFixed(2)} m³ × 0.05 kW/m³</b></label>` +
        `</div>` +
      `</div>` +

      `<div class="rprops-section">` +
        `<div class="rprops-section-title">Ventilation (rule-of-thumb)</div>` +
        `<div class="rprops-checks">` +
          `<label><input type="checkbox" id="rp-vent-m2" ${elm.showVentM2 ? "checked" : ""}> Show <b>${ventM2.toFixed(1)} L/s</b> — from <b>${elm.area.toFixed(2)} m² × 9.9 L/s/m²</b></label>` +
          `<label><input type="checkbox" id="rp-vent-m3" ${elm.showVentM3 ? "checked" : ""}> Show <b>${ventM3.toFixed(1)} L/s</b> — from <b>${elm.volume.toFixed(2)} m³ × 3.3 L/s/m³</b></label>` +
        `</div>` +
        `<div class="rprops-hint" style="margin-top:6px">Rule-of-thumb only — for quick paperwork reference, not the real load calculation.</div>` +
      `</div>` +

      `<div class="rprops-section">` +
        `<div class="rprops-section-title">Note</div>` +
        `<textarea class="rprops-textarea" id="rp-note" rows="3" placeholder="Optional note — shown as a yellow sticky attached to the room. Drag it to reposition.">${escapeAttr(elm.note || "")}</textarea>` +
      `</div>`;

    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const cancel = document.createElement("button");
    cancel.className = "btn-secondary";
    cancel.textContent = "Cancel";
    cancel.onclick = () => close();
    const save = document.createElement("button");
    save.className = "btn-primary";
    save.textContent = "Save";
    save.onclick = () => {
      elm.name        = body.querySelector("#rp-name").value.trim();
      elm.color       = body.querySelector("#rp-color").value;
      elm.fillOpacity = parseFloat(body.querySelector("#rp-opacity").value) / 100;
      elm.showKwM2    = body.querySelector("#rp-kw-m2").checked;
      elm.showKwM3    = body.querySelector("#rp-kw-m3").checked;
      elm.showVentM2  = body.querySelector("#rp-vent-m2").checked;
      elm.showVentM3  = body.querySelector("#rp-vent-m3").checked;
      elm.note        = body.querySelector("#rp-note").value;
      close();
      refreshTakeoffSidebar();
      redraw();
    };
    footer.appendChild(cancel);
    footer.appendChild(save);
    body.appendChild(footer);

    modal.appendChild(header);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    // Live update opacity readout while sliding
    const rng = body.querySelector("#rp-opacity");
    const out = body.querySelector("#rp-opacity-out");
    rng.addEventListener("input", () => { out.textContent = rng.value + "%"; });

    setTimeout(() => body.querySelector("#rp-name").focus(), 0);

    const onKey = (ev) => {
      if (ev.key === "Escape") { ev.preventDefault(); close(); }
    };
    window.addEventListener("keydown", onKey);
    function close() {
      backdrop.remove();
      window.removeEventListener("keydown", onKey);
    }
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  }

  function escapeAttr(v) {
    if (v === null || v === undefined) return "";
    return String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

})();
