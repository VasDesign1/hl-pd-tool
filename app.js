/* ================================================================
   HL + PD — Heat Load & Pressure Drop Calculator
   Calc coefficients are fetched from Firestore config/coefficients on login
   (see auth.js). They start empty here so a cloned local copy of the tool
   has no working formulas without a valid Firestore read.
   ================================================================ */

let WALL_MATERIAL_FACTORS      = {};
let NO_SUN_FACTOR              = 0;
let CARPET_FACTOR              = 0;
let UNCARPETED_FACTOR          = 0;
let CEILING_INSULATED_FACTOR   = 0;
let CEILING_UNINSULATED_FACTOR = 0;
let INDOOR_WALL_FACTOR         = 0;
let ACTIVITY_FACTORS           = {};
let DOOR_FACTOR                = 0;
let WINDOW_FACTORS             = {};
let ROUGHNESS                  = {};

// UI enum labels — plain strings, not secret, must match Firestore keys.
const DIRECTIONS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const SHADINGS = ["Curtains/Blinds", "Awning+Curtains/Blinds", "None", "Fully"];

// Called by auth.js after the coefficients doc is fetched from Firestore.
window.setCalcCoefficients = function (cfg) {
  if (!cfg || typeof cfg !== "object") return false;
  if (cfg.WALL_MATERIAL_FACTORS)      WALL_MATERIAL_FACTORS      = cfg.WALL_MATERIAL_FACTORS;
  if (cfg.NO_SUN_FACTOR != null)      NO_SUN_FACTOR              = cfg.NO_SUN_FACTOR;
  if (cfg.CARPET_FACTOR != null)      CARPET_FACTOR              = cfg.CARPET_FACTOR;
  if (cfg.UNCARPETED_FACTOR != null)  UNCARPETED_FACTOR          = cfg.UNCARPETED_FACTOR;
  if (cfg.CEILING_INSULATED_FACTOR != null)   CEILING_INSULATED_FACTOR   = cfg.CEILING_INSULATED_FACTOR;
  if (cfg.CEILING_UNINSULATED_FACTOR != null) CEILING_UNINSULATED_FACTOR = cfg.CEILING_UNINSULATED_FACTOR;
  if (cfg.INDOOR_WALL_FACTOR != null) INDOOR_WALL_FACTOR         = cfg.INDOOR_WALL_FACTOR;
  if (cfg.ACTIVITY_FACTORS)           ACTIVITY_FACTORS           = cfg.ACTIVITY_FACTORS;
  if (cfg.DOOR_FACTOR != null)        DOOR_FACTOR                = cfg.DOOR_FACTOR;
  if (cfg.WINDOW_FACTORS)             WINDOW_FACTORS             = cfg.WINDOW_FACTORS;
  if (cfg.ROUGHNESS)                  ROUGHNESS                  = cfg.ROUGHNESS;
  return true;
};

/* ================================================================
   STATE (in-memory only; wiped on refresh)
   ================================================================ */

const state = {
  sessions: [],          // [{ id, type, name, seq, data }]
  activeId: null,        // null = home, "__admin__" = admin panel, number = session id
  seqCounters: { THL: 0, PD: 0 },
  nextId: 1,
  modalOpen: null,       // null | "THL" | "PD"
};

function round3(v) { return Math.round(v * 1000) / 1000; }

function emptyTHLData() {
  return {
    roomArea: 0,
    outdoorPerimeter: 0,
    indoorPerimeter: 0,
    wallHeight: 0,
    wallMaterial: "Brick/Brick Veneer",
    sunExposure: false,
    carpet: false,
    ceilingInsulation: false,
    peopleCount: 0,
    activity: "Inactive",
    appliances: 500,
    doors: [],
    windows: [],
  };
}

function newTHL() {
  state.seqCounters.THL += 1;
  const s = {
    id: state.nextId++,
    type: "THL",
    seq: state.seqCounters.THL,
    name: "",
    data: emptyTHLData(),   // used when subs.length === 0 (single-page mode)
    subs: [],               // [{ id, name, data }]  — when non-empty, sub-page mode is active
    activeSub: null,        // null | 0..N-1 | "total"
    // takeoff is added later by openTakeoff (persisted per THL session)
  };
  state.sessions.push(s);
  return s;
}

let nextSubId = 1;
function newSubPage(name, data) {
  return { id: nextSubId++, name: name || "Sub-page", data: data || emptyTHLData() };
}

// Returns the data object the THL screen should render/edit right now.
// Sub-page mode: the sub's data.  Otherwise: session.data.
function activeTHLData(session) {
  if (session.subs && session.subs.length > 0 && typeof session.activeSub === "number") {
    return session.subs[session.activeSub].data;
  }
  return session.data;
}

function isTHLTotalView(session) {
  return session.subs && session.subs.length > 0 && session.activeSub === "total";
}

function isTHLDataDirty(d) {
  if (!d) return false;
  return num(d.roomArea) > 0 || num(d.outdoorPerimeter) > 0 || num(d.indoorPerimeter) > 0 ||
         num(d.wallHeight) > 0 || (d.doors && d.doors.length > 0) || (d.windows && d.windows.length > 0) ||
         num(d.peopleCount) > 0;
}

function renderSubTabs(session) {
  const bar = el("div", { class: "sub-tabs" });
  const hasSubs = session.subs && session.subs.length > 0;

  // Σ Total pinned as the FIRST tab — only shown once at least one sub exists
  if (hasSubs) {
    const totalActive = session.activeSub === "total";
    const totalTab = el("div", {
      class: "sub-tab sub-tab-total" + (totalActive ? " active" : ""),
      title: "Σ — consolidated view of every sub-page (editable). Auto-updates when any sub-page changes.",
    }, "Σ Total");
    totalTab.onclick = () => { session.activeSub = "total"; render(); };
    bar.appendChild(totalTab);
  }

  session.subs.forEach((sub, i) => {
    const isActive = session.activeSub === i;
    const tab = el("div", { class: "sub-tab" + (isActive ? " active" : ""), draggable: "true" });
    const nameSpan = el("span", { class: "sub-tab-label" }, sub.name);
    nameSpan.onclick = () => { session.activeSub = i; render(); };
    nameSpan.ondblclick = async (e) => {
      e.stopPropagation();
      if (!window.promptModal) return;
      const newName = await window.promptModal("New name for this sub-page:", sub.name,
        { title: "Rename sub-page", type: "text" });
      if (newName && newName.trim()) { sub.name = newName.trim(); render(); }
    };
    nameSpan.title = "Click to open · double-click to rename · drag to reorder · Ctrl+drag to merge · Right-click for menu";
    tab.appendChild(nameSpan);
    tab.oncontextmenu = (e) => {
      e.preventDefault();
      e.stopPropagation();
      showSubTabMenu(session, i, e.clientX, e.clientY);
    };
    tab.appendChild(el("button", {
      class: "sub-tab-close",
      title: "Delete this sub-page",
      onclick: async (e) => {
        e.stopPropagation();
        if (!window.confirmModal) return;
        const yes = await window.confirmModal(`Delete sub-page "${sub.name}"? This cannot be undone.`,
          { title: "Delete sub-page", danger: true, okLabel: "Delete" });
        if (!yes) return;
        session.subs.splice(i, 1);
        if (session.subs.length === 0) session.activeSub = null;
        else if (typeof session.activeSub === "number" && session.activeSub >= session.subs.length) {
          session.activeSub = session.subs.length - 1;
        }
        render();
      },
    }, "✕"));
    tab.ondragstart = (e) => {
      e.dataTransfer.effectAllowed = "copyMove";
      e.dataTransfer.setData("text/plain", String(i));
      tab.classList.add("dragging");
    };
    tab.ondragend = () => tab.classList.remove("dragging");
    tab.ondragover = (e) => {
      e.preventDefault();
      // Ctrl held => merge (visual: green ring); else reorder (blue bar)
      if (e.ctrlKey || e.metaKey) {
        e.dataTransfer.dropEffect = "copy";
        tab.classList.add("merge-target");
        tab.classList.remove("drop-target");
      } else {
        e.dataTransfer.dropEffect = "move";
        tab.classList.add("drop-target");
        tab.classList.remove("merge-target");
      }
    };
    tab.ondragleave = () => {
      tab.classList.remove("drop-target");
      tab.classList.remove("merge-target");
    };
    tab.ondrop = async (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Capture merge intent BEFORE removing classes. This is robust to the user
      // releasing Ctrl before the mouse button (in which case e.ctrlKey is false at drop time).
      const isMerge = (e.ctrlKey || e.metaKey) || tab.classList.contains("merge-target");
      tab.classList.remove("drop-target");
      tab.classList.remove("merge-target");
      const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
      const to = i;
      if (Number.isNaN(from) || from === to) return;

      if (isMerge) {
        // Merge `from` (source) INTO `to` (destination)
        await mergeSubPages(session, from, to);
      } else {
        // Regular drop → reorder
        const moved = session.subs.splice(from, 1)[0];
        session.subs.splice(to, 0, moved);
        if (typeof session.activeSub === "number") {
          if (session.activeSub === from) session.activeSub = to;
          else if (from < session.activeSub && to >= session.activeSub) session.activeSub -= 1;
          else if (from > session.activeSub && to <= session.activeSub) session.activeSub += 1;
        }
        render();
      }
    };
    bar.appendChild(tab);
  });
  // Bar-level drop → un-merge if user Ctrl+drops a merged sub onto empty area
  bar.ondragover = (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    // Only react when the drop target is the bar background itself (not a tab)
    if (e.target !== bar) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    bar.classList.add("unmerge-target");
  };
  bar.ondragleave = (e) => {
    if (e.target === bar) bar.classList.remove("unmerge-target");
  };
  bar.ondrop = async (e) => {
    const wasUnmerge = bar.classList.contains("unmerge-target");
    bar.classList.remove("unmerge-target");
    // Robust against Ctrl being released before drop
    const isCtrl = e.ctrlKey || e.metaKey || wasUnmerge;
    if (!isCtrl) return;
    if (e.target !== bar) return;
    e.preventDefault();
    const from = parseInt(e.dataTransfer.getData("text/plain"), 10);
    if (Number.isNaN(from)) return;
    const sub = session.subs[from];
    if (!sub) return;
    if (!sub.mergedFrom || sub.mergedFrom.length === 0) {
      await window.alertModal(
        `"${sub.name}" isn't a merged sub-page — nothing to un-merge.`,
        { title: "Not a merged sub-page" });
      return;
    }
    await unmergeSubPage(session, from);
  };

  bar.appendChild(el("button", {
    class: "sub-tab-add",
    title: hasSubs
      ? "Add a blank sub-page. Tip: Ctrl+drop one tab onto another to merge them, Ctrl+drop a merged tab onto empty space to un-merge."
      : "Split this THL into sub-pages (rooms / floors / zones). You can also do this by applying from Auto Take-Off.",
    onclick: async () => {
      const suggested = `Page ${session.subs.length + 1}`;
      const name = window.promptModal
        ? await window.promptModal("Name for the new sub-page:", suggested,
            { title: "New sub-page", type: "text", okLabel: "Add" })
        : suggested;
      if (name === null) return;
      const trimmed = (name || "").trim() || suggested;
      convertParentDataToMainSub(session);
      const sub = newSubPage(trimmed, emptyTHLData());
      // Carry defaults from the parent for a good starting point
      ["wallMaterial", "sunExposure", "carpet", "ceilingInsulation", "activity"].forEach(k => {
        if (session.data[k] !== undefined) sub.data[k] = session.data[k];
      });
      if (num(session.data.appliances) > 0) sub.data.appliances = num(session.data.appliances);
      if (num(session.data.wallHeight) > 0) sub.data.wallHeight = num(session.data.wallHeight);
      session.subs.push(sub);
      session.activeSub = session.subs.length - 1;
      render();
    },
  }, hasSubs ? "+ Add page" : "+ Add sub-page (split into rooms / floors)"));

  return bar;
}

function renderMergedPill(sub) {
  const wrap = el("div", { class: "merged-pill" });
  const names = sub.mergedFrom.map(m => m.name.replace(/ \((before merge|merged in)\)$/, "")).filter((v, i, a) => a.indexOf(v) === i);
  wrap.appendChild(el("span", { class: "merged-pill-icon" }, "🔗"));
  wrap.appendChild(el("span", {}, `Merged — includes data from ${names.length} sub-page${names.length === 1 ? "" : "s"}. Hover for per-field origin.`));
  // Build breakdown rows for the info-tip
  const breakdown = [];
  const rowLabels = [
    { key: "roomArea",         label: "Room area (m²)",    fmt: 3 },
    { key: "outdoorPerimeter", label: "Outdoor perim (m)", fmt: 3 },
    { key: "indoorPerimeter",  label: "Indoor perim (m)",  fmt: 3 },
    { key: "wallHeight",       label: "Wall height (m)" },
    { key: "wallMaterial",     label: "Wall material" },
    { key: "sunExposure",      label: "Sun exposure",      bool: true },
    { key: "carpet",           label: "Carpeted",          bool: true },
    { key: "ceilingInsulation",label: "Ceiling insulated", bool: true },
    { key: "peopleCount",      label: "People count" },
    { key: "activity",         label: "Activity" },
    { key: "appliances",       label: "Appliances (W)",    fmt: 0 },
    { key: "doors",            label: "Doors rows",        length: true },
    { key: "windows",          label: "Windows rows",      length: true },
  ];
  sub.mergedFrom.forEach(origin => {
    breakdown.push({ name: "── " + origin.name + " ──", val: "" });
    rowLabels.forEach(f => {
      let v = origin.data[f.key];
      if (f.length) v = (v || []).length;
      else if (f.bool) v = v ? "Yes" : "No";
      else if (f.fmt != null) v = fmt(num(v), f.fmt);
      breakdown.push({ name: f.label, val: String(v) });
    });
  });
  attachInfoTip(wrap, breakdown);
  return wrap;
}

/* ---- Sub-page merge (Ctrl+drop from one sub-tab onto another) ---- */

const CONFLICT_FIELDS = [
  { key: "wallMaterial",       label: "Wall material" },
  { key: "wallHeight",         label: "Wall height (m)" },
  { key: "sunExposure",        label: "Sun exposure",     format: v => v ? "Yes" : "No" },
  { key: "carpet",             label: "Carpeted",         format: v => v ? "Yes" : "No" },
  { key: "ceilingInsulation",  label: "Ceiling insulated", format: v => v ? "Yes" : "No" },
  { key: "activity",           label: "Activity level" },
];

async function mergeSubPages(session, fromIdx, toIdx) {
  const src = session.subs[fromIdx];
  const dst = session.subs[toIdx];
  if (!src || !dst) return;

  // Identify conflict fields
  const conflicts = CONFLICT_FIELDS
    .map(f => ({ ...f, src: src.data[f.key], dst: dst.data[f.key] }))
    .filter(f => f.src !== f.dst);

  const choice = await mergeConfirmModal(src, dst, conflicts);
  if (!choice) return;   // user cancelled

  // Snapshot each sub's data BEFORE we mutate dst
  const stamp = new Date().toISOString();
  const dstBefore = deepCloneTHLData(dst.data);
  const srcBefore = deepCloneTHLData(src.data);

  // Determine each side's atomic contributors — flatten any prior merges
  const contributorsOf = (sub, snapshot) => {
    if (sub.mergedFrom && sub.mergedFrom.length > 0) return sub.mergedFrom.slice();
    return [{ name: sub.name, data: snapshot, at: stamp }];
  };
  const contributors = contributorsOf(dst, dstBefore).concat(contributorsOf(src, srcBefore));

  // Names to combine
  const dstDisplay = dst.name || `Sub #${toIdx + 1}`;
  const srcDisplay = src.name || `Sub #${fromIdx + 1}`;

  // Numeric sums
  const merged = emptyTHLData();
  merged.roomArea         = round3(num(dst.data.roomArea)         + num(src.data.roomArea));
  merged.outdoorPerimeter = round3(num(dst.data.outdoorPerimeter) + num(src.data.outdoorPerimeter));
  merged.indoorPerimeter  = round3(num(dst.data.indoorPerimeter)  + num(src.data.indoorPerimeter));
  merged.peopleCount      = num(dst.data.peopleCount) + num(src.data.peopleCount);
  merged.appliances       = num(dst.data.appliances) + num(src.data.appliances);

  // Conflict fields — from user's radio choices; if no conflict, take dst's value
  CONFLICT_FIELDS.forEach(f => {
    if (dst.data[f.key] === src.data[f.key]) {
      merged[f.key] = dst.data[f.key];
    } else {
      merged[f.key] = choice.picks[f.key] === "src" ? src.data[f.key] : dst.data[f.key];
    }
  });

  // Concat tables (deep-copied)
  merged.doors   = (dst.data.doors   || []).concat(src.data.doors   || []).map(x => Object.assign({}, x));
  merged.windows = (dst.data.windows || []).concat(src.data.windows || []).map(x => Object.assign({}, x));

  // Assign merged data back to destination
  dst.data = merged;
  dst.mergedFrom = contributors;
  dst.name = combineSubNames(dstDisplay, srcDisplay);

  // Remove the source sub; keep the active view on the destination
  session.subs.splice(fromIdx, 1);
  const newDstIdx = fromIdx < toIdx ? toIdx - 1 : toIdx;
  session.activeSub = newDstIdx;
  render();

  await window.alertModal(
    `Merged "${srcDisplay}" and "${dstDisplay}" → new tab "${dst.name}".\n\n` +
    `• Perimeters, area, people and appliances summed\n` +
    `• ${(merged.doors || []).length} door row(s) and ${(merged.windows || []).length} window row(s) combined\n\n` +
    `Ctrl+drop this tab onto an empty area of the tab bar to un-merge.`,
    { title: "✓ Merged" }
  );
}

// Combine two sub names into a single label. Handles pre-merged names too (e.g. "1+2" + "3" → "1+2+3").
function combineSubNames(a, b) {
  if (!a) return b || "";
  if (!b) return a;
  return (a + "+" + b).slice(0, 60);
}

async function unmergeSubPage(session, mergedIdx) {
  const merged = session.subs[mergedIdx];
  if (!merged || !merged.mergedFrom || merged.mergedFrom.length === 0) return;

  const picks = await unmergeChoiceModal(merged);
  if (!picks) return;                       // cancelled
  if (picks.length === 0) return;           // nothing selected

  // Extract each selected contributor as a new sub, inserted right after the merged one
  const remainingContributors = merged.mergedFrom.filter((_, i) => !picks.includes(i));
  const extracted = picks.map(i => merged.mergedFrom[i]);
  extracted.forEach((c, offset) => {
    const s = newSubPage(c.name.replace(/ \((before merge|merged in)\)$/, ""), deepCloneTHLData(c.data));
    // Insert after the merged tab
    session.subs.splice(mergedIdx + 1 + offset, 0, s);
  });

  if (remainingContributors.length === 0) {
    // Nothing left → delete the merged sub
    session.subs.splice(mergedIdx, 1);
    session.activeSub = mergedIdx;   // land on the first extracted sub
    if (session.activeSub >= session.subs.length) session.activeSub = session.subs.length - 1;
  } else if (remainingContributors.length === 1) {
    // One contributor left → sub is no longer "merged"; restore its data + name from the survivor
    const solo = remainingContributors[0];
    merged.data = deepCloneTHLData(solo.data);
    merged.name = solo.name.replace(/ \((before merge|merged in)\)$/, "");
    merged.mergedFrom = null;
  } else {
    // Still merged with 2+ contributors → rebuild data from remaining contributors and drop the extracted ones
    rebuildMergedData(merged, remainingContributors);
    merged.mergedFrom = remainingContributors;
    // Update name to reflect remaining contributors
    merged.name = remainingContributors
      .map(c => c.name.replace(/ \((before merge|merged in)\)$/, ""))
      .join("+")
      .slice(0, 60);
  }
  render();
  await window.alertModal(
    `Un-merged: extracted ${extracted.length} sub-page${extracted.length === 1 ? "" : "s"}` +
    (remainingContributors.length > 0
      ? `. The merged tab now contains ${remainingContributors.length} contributor${remainingContributors.length === 1 ? "" : "s"}.`
      : ". The merged tab was deleted."),
    { title: "✓ Un-merged" }
  );
}

// Recompute a merged sub's data from its remaining contributor snapshots.
// Note: this discards any post-merge edits — that's a documented limitation.
function rebuildMergedData(mergedSub, contributors) {
  const rebuilt = emptyTHLData();
  let firstCategoricals = null;
  const totals = { roomArea: 0, outdoorPerimeter: 0, indoorPerimeter: 0, peopleCount: 0, appliances: 0 };
  contributors.forEach(c => {
    const d = c.data;
    totals.roomArea         += num(d.roomArea);
    totals.outdoorPerimeter += num(d.outdoorPerimeter);
    totals.indoorPerimeter  += num(d.indoorPerimeter);
    totals.peopleCount      += num(d.peopleCount);
    totals.appliances       += num(d.appliances);
    (d.doors   || []).forEach(x => rebuilt.doors.push(Object.assign({}, x)));
    (d.windows || []).forEach(x => rebuilt.windows.push(Object.assign({}, x)));
    if (!firstCategoricals) firstCategoricals = d;
  });
  rebuilt.roomArea         = round3(totals.roomArea);
  rebuilt.outdoorPerimeter = round3(totals.outdoorPerimeter);
  rebuilt.indoorPerimeter  = round3(totals.indoorPerimeter);
  rebuilt.peopleCount      = totals.peopleCount;
  rebuilt.appliances       = totals.appliances;
  // For categoricals with remaining contributors — keep the merged sub's current choice if consistent,
  // otherwise fall back to the first contributor's choice.
  CONFLICT_FIELDS.forEach(f => {
    const vals = new Set(contributors.map(c => c.data[f.key]));
    rebuilt[f.key] = vals.size === 1 ? [...vals][0] : (mergedSub.data[f.key] !== undefined ? mergedSub.data[f.key] : firstCategoricals[f.key]);
  });
  mergedSub.data = rebuilt;
}

function unmergeChoiceModal(mergedSub) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop modal-top";
    const modal = document.createElement("div");
    modal.className = "modal modal-prompt";
    modal.style.maxWidth = "560px";

    const header = document.createElement("div");
    header.className = "modal-header";
    const h2 = document.createElement("h2");
    h2.textContent = `🔗 Un-merge "${mergedSub.name}"?`;
    header.appendChild(h2);

    const body = document.createElement("div");
    body.className = "modal-body";
    body.innerHTML =
      `<div class="prompt-msg">Pick which sub-pages to extract as separate tabs. Unpicked contributors stay merged (with data rebuilt from their snapshots — any post-merge edits are lost).</div>` +
      `<div class="merge-summary-title" style="margin-top:12px">Contributors:</div>`;

    const list = document.createElement("div");
    list.className = "unmerge-list";
    const checks = [];
    mergedSub.mergedFrom.forEach((c, i) => {
      const displayName = c.name.replace(/ \((before merge|merged in)\)$/, "");
      const item = document.createElement("label");
      item.className = "unmerge-item";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = true;                 // default = extract all
      cb.dataset.idx = String(i);
      checks.push(cb);
      const meta = `${fmt(num(c.data.roomArea), 2)} m²  ·  ${(c.data.doors || []).length} door / ${(c.data.windows || []).length} window row(s)  ·  ${num(c.data.peopleCount)} people`;
      item.appendChild(cb);
      const text = document.createElement("div");
      text.className = "unmerge-item-text";
      text.innerHTML = `<div class="unmerge-item-name">${escapeHTML(displayName)}</div><div class="unmerge-item-meta">${escapeHTML(meta)}</div>`;
      item.appendChild(text);
      list.appendChild(item);
    });
    body.appendChild(list);

    // Toggle-all convenience
    const toggleRow = document.createElement("div");
    toggleRow.style.marginTop = "8px";
    toggleRow.style.display = "flex";
    toggleRow.style.gap = "10px";
    const selectAll = document.createElement("button");
    selectAll.className = "btn-secondary";
    selectAll.textContent = "Select all";
    selectAll.type = "button";
    selectAll.onclick = () => checks.forEach(c => { c.checked = true; });
    const clearAll = document.createElement("button");
    clearAll.className = "btn-secondary";
    clearAll.textContent = "Clear";
    clearAll.type = "button";
    clearAll.onclick = () => checks.forEach(c => { c.checked = false; });
    toggleRow.appendChild(selectAll);
    toggleRow.appendChild(clearAll);
    body.appendChild(toggleRow);

    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const cancel = document.createElement("button");
    cancel.className = "btn-secondary";
    cancel.textContent = "Cancel";
    cancel.onclick = () => finish(null);
    const go = document.createElement("button");
    go.className = "btn-primary";
    go.textContent = "Extract selected";
    go.onclick = () => {
      const picks = checks.map((c, i) => c.checked ? i : -1).filter(i => i >= 0);
      finish(picks);
    };
    footer.appendChild(cancel);
    footer.appendChild(go);
    body.appendChild(footer);

    modal.appendChild(header);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    setTimeout(() => go.focus(), 0);

    const finish = (v) => {
      window.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(null); }
    };
    window.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) finish(null); });
  });
}

function deepCloneTHLData(d) {
  const copy = Object.assign({}, d);
  copy.doors   = (d.doors   || []).map(x => Object.assign({}, x));
  copy.windows = (d.windows || []).map(x => Object.assign({}, x));
  return copy;
}

// Modal that shows what will be summed + conflict radios for fields that differ
function mergeConfirmModal(src, dst, conflicts) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop modal-top";
    const modal = document.createElement("div");
    modal.className = "modal modal-prompt";
    modal.style.maxWidth = "620px";

    const header = document.createElement("div");
    header.className = "modal-header";
    const h2 = document.createElement("h2");
    h2.textContent = `🔗 Merge "${src.name}" into "${dst.name}"?`;
    header.appendChild(h2);

    const body = document.createElement("div");
    body.className = "modal-body";
    body.innerHTML =
      `<div class="prompt-msg">This will combine measurements from <b>${escapeHTML(src.name)}</b> and <b>${escapeHTML(dst.name)}</b> into <b>${escapeHTML(dst.name)}</b>, then delete <b>${escapeHTML(src.name)}</b>.</div>` +
      `<div class="merge-summary">` +
      `  <div class="merge-summary-title">Auto-summed:</div>` +
      `  <div class="merge-summary-item"><b>Room area</b> — ${fmt(num(dst.data.roomArea),2)} + ${fmt(num(src.data.roomArea),2)} = <b>${fmt(num(dst.data.roomArea)+num(src.data.roomArea),2)}</b> m²</div>` +
      `  <div class="merge-summary-item"><b>Outdoor perimeter</b> — ${fmt(num(dst.data.outdoorPerimeter),2)} + ${fmt(num(src.data.outdoorPerimeter),2)} = <b>${fmt(num(dst.data.outdoorPerimeter)+num(src.data.outdoorPerimeter),2)}</b> m</div>` +
      `  <div class="merge-summary-item"><b>Indoor perimeter</b> — ${fmt(num(dst.data.indoorPerimeter),2)} + ${fmt(num(src.data.indoorPerimeter),2)} = <b>${fmt(num(dst.data.indoorPerimeter)+num(src.data.indoorPerimeter),2)}</b> m</div>` +
      `  <div class="merge-summary-item"><b>People</b> — ${num(dst.data.peopleCount)} + ${num(src.data.peopleCount)} = <b>${num(dst.data.peopleCount)+num(src.data.peopleCount)}</b></div>` +
      `  <div class="merge-summary-item"><b>Appliances</b> — ${fmt(num(dst.data.appliances),0)} + ${fmt(num(src.data.appliances),0)} = <b>${fmt(num(dst.data.appliances)+num(src.data.appliances),0)}</b> W</div>` +
      `  <div class="merge-summary-item"><b>Doors</b> — ${(dst.data.doors||[]).length} + ${(src.data.doors||[]).length} = <b>${(dst.data.doors||[]).length + (src.data.doors||[]).length}</b> row(s), all kept</div>` +
      `  <div class="merge-summary-item"><b>Windows</b> — ${(dst.data.windows||[]).length} + ${(src.data.windows||[]).length} = <b>${(dst.data.windows||[]).length + (src.data.windows||[]).length}</b> row(s), all kept</div>` +
      `</div>`;

    const picks = {};
    if (conflicts.length > 0) {
      const conflictWrap = document.createElement("div");
      conflictWrap.className = "merge-conflicts";
      conflictWrap.innerHTML = `<div class="merge-summary-title">Conflicts — pick which value wins:</div>`;
      conflicts.forEach(c => {
        picks[c.key] = "dst";   // default to destination
        const fmtV = (v) => c.format ? c.format(v) : String(v);
        const row = document.createElement("div");
        row.className = "merge-conflict-row";
        row.innerHTML =
          `<div class="merge-conflict-label">${escapeHTML(c.label)}</div>` +
          `<label class="merge-conflict-opt"><input type="radio" name="mc-${c.key}" value="dst" checked> ` +
          `Keep <b>${escapeHTML(dst.name)}</b>: <span class="merge-conflict-val">${escapeHTML(fmtV(c.dst))}</span></label>` +
          `<label class="merge-conflict-opt"><input type="radio" name="mc-${c.key}" value="src"> ` +
          `Keep <b>${escapeHTML(src.name)}</b>: <span class="merge-conflict-val">${escapeHTML(fmtV(c.src))}</span></label>`;
        conflictWrap.appendChild(row);
        row.querySelectorAll(`input[name="mc-${c.key}"]`).forEach(r => {
          r.addEventListener("change", (e) => { picks[c.key] = e.target.value; });
        });
      });
      body.appendChild(conflictWrap);
    } else {
      const p = document.createElement("div");
      p.className = "merge-summary-item";
      p.style.marginTop = "10px";
      p.textContent = "No conflicting envelope / occupancy fields — the two sub-pages agree on all categorical settings.";
      body.appendChild(p);
    }

    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const cancel = document.createElement("button");
    cancel.className = "btn-secondary";
    cancel.textContent = "Cancel";
    cancel.onclick = () => finish(null);
    const merge = document.createElement("button");
    merge.className = "btn-primary";
    merge.textContent = "Merge";
    merge.onclick = () => finish({ picks });
    footer.appendChild(cancel);
    footer.appendChild(merge);
    body.appendChild(footer);

    modal.appendChild(header);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    setTimeout(() => merge.focus(), 0);

    const finish = (v) => {
      window.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(v);
    };
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); finish(null); }
      else if (e.key === "Enter") { e.preventDefault(); finish({ picks }); }
    };
    window.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) finish(null); });
  });
}

function escapeHTML(v) {
  if (v === null || v === undefined) return "";
  return String(v).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/* ---- Right-click menu on a sub-tab (reliable alternative to drag/drop) ---- */

function showSubTabMenu(session, subIdx, x, y) {
  // Close any existing menu
  document.querySelectorAll(".sub-tab-menu").forEach(n => n.remove());
  const sub = session.subs[subIdx];
  if (!sub) return;

  const menu = document.createElement("div");
  menu.className = "sub-tab-menu";
  menu.tabIndex = -1;

  const addItem = (label, handler, danger) => {
    const item = document.createElement("div");
    item.className = "sub-tab-menu-item" + (danger ? " danger" : "");
    item.textContent = label;
    item.onclick = async (e) => {
      e.stopPropagation();
      closeMenu();
      await handler();
    };
    menu.appendChild(item);
  };

  addItem(`Rename "${sub.name}"…`, async () => {
    if (!window.promptModal) return;
    const newName = await window.promptModal("New name for this sub-page:", sub.name,
      { title: "Rename sub-page", type: "text" });
    if (newName !== null) { sub.name = (newName || "").trim(); render(); }
  });

  // Merge submenu — list every other sub as a merge target
  const others = session.subs.map((s, i) => ({ s, i })).filter(o => o.i !== subIdx);
  if (others.length > 0) {
    const item = document.createElement("div");
    item.className = "sub-tab-menu-item has-submenu";
    item.textContent = `Merge "${sub.name}" into… ▸`;
    const sub2 = document.createElement("div");
    sub2.className = "sub-tab-submenu";
    others.forEach(o => {
      const sub2Item = document.createElement("div");
      sub2Item.className = "sub-tab-menu-item";
      sub2Item.textContent = o.s.name;
      sub2Item.onclick = async (e) => {
        e.stopPropagation();
        closeMenu();
        await mergeSubPages(session, subIdx, o.i);
      };
      sub2.appendChild(sub2Item);
    });
    item.appendChild(sub2);
    menu.appendChild(item);
  }

  if (sub.mergedFrom && sub.mergedFrom.length > 0) {
    addItem("🔗 Un-merge…", async () => {
      await unmergeSubPage(session, subIdx);
    });
  }

  const sep = document.createElement("div");
  sep.className = "sub-tab-menu-sep";
  menu.appendChild(sep);

  addItem("✕ Delete sub-page", async () => {
    if (!window.confirmModal) return;
    const yes = await window.confirmModal(`Delete sub-page "${sub.name}"? This cannot be undone.`,
      { title: "Delete sub-page", danger: true, okLabel: "Delete" });
    if (!yes) return;
    session.subs.splice(subIdx, 1);
    if (session.subs.length === 0) session.activeSub = null;
    else if (typeof session.activeSub === "number" && session.activeSub >= session.subs.length) {
      session.activeSub = session.subs.length - 1;
    }
    render();
  }, true);

  document.body.appendChild(menu);
  // Clamp to viewport
  const r = menu.getBoundingClientRect();
  let left = x, top = y;
  if (left + r.width > window.innerWidth - 8) left = window.innerWidth - r.width - 8;
  if (top + r.height > window.innerHeight - 8) top = window.innerHeight - r.height - 8;
  menu.style.left = left + "px";
  menu.style.top  = top + "px";
  menu.focus();

  const closeMenu = () => {
    menu.remove();
    document.removeEventListener("mousedown", onOutside, true);
    document.removeEventListener("keydown", onKey);
  };
  const onOutside = (ev) => { if (!menu.contains(ev.target)) closeMenu(); };
  const onKey = (ev) => { if (ev.key === "Escape") closeMenu(); };
  setTimeout(() => {
    document.addEventListener("mousedown", onOutside, true);
    document.addEventListener("keydown", onKey);
  }, 0);
}

// If a THL session has data entered on the parent but no subs yet, preserve it
// as a "Main" sub before adding another one. Shared by manual + Take-Off Apply.
function convertParentDataToMainSub(session) {
  if (session.subs.length > 0) return;
  if (!isTHLDataDirty(session.data)) return;
  const preservedData = emptyTHLData();
  Object.assign(preservedData, session.data);
  preservedData.doors = session.data.doors.map(x => Object.assign({}, x));
  preservedData.windows = session.data.windows.map(x => Object.assign({}, x));
  session.subs.push(newSubPage("Main", preservedData));
}
window.convertParentDataToMainSub = convertParentDataToMainSub;

function renderTHLTotal(session) {
  const subs = session.subs;
  const rows = subs.map(sub => ({ sub, result: calcTHL(sub.data) }));

  // Aggregated numeric fields
  const totalRoomArea       = subs.reduce((s, sub) => s + num(sub.data.roomArea), 0);
  const totalOutdoorPerim   = subs.reduce((s, sub) => s + num(sub.data.outdoorPerimeter), 0);
  const totalIndoorPerim    = subs.reduce((s, sub) => s + num(sub.data.indoorPerimeter), 0);
  const totalPeople         = subs.reduce((s, sub) => s + num(sub.data.peopleCount), 0);
  const totalAppliancesInp  = subs.reduce((s, sub) => s + num(sub.data.appliances), 0);

  // For categorical / boolean fields — show the value if all subs agree, else "Mixed"
  const distinct = (getter) => new Set(subs.map(getter));
  const uniqueOr = (set, mixedLabel) => set.size === 1 ? [...set][0] : mixedLabel;

  const wallHeights = subs.map(sub => num(sub.data.wallHeight)).filter(h => h > 0);
  const wallHeightDisplay = wallHeights.length === 0
    ? "0"
    : (new Set(wallHeights).size === 1 ? String(wallHeights[0]) : `mixed (${Math.min(...wallHeights)}–${Math.max(...wallHeights)})`);

  const wallMaterialDisplay = uniqueOr(distinct(sub => sub.data.wallMaterial), "Mixed");
  const boolLabel = (b) => (b ? "Yes" : "No");
  const sunDisplay    = uniqueOr(new Set(subs.map(sub => boolLabel(sub.data.sunExposure))), "Mixed");
  const carpetDisplay = uniqueOr(new Set(subs.map(sub => boolLabel(sub.data.carpet))), "Mixed");
  const ceilDisplay   = uniqueOr(new Set(subs.map(sub => boolLabel(sub.data.ceilingInsulation))), "Mixed");
  const activityDisplay = uniqueOr(distinct(sub => sub.data.activity), "Mixed");

  // Concatenated windows / doors with a "sub-page" tag on each row
  const allDoors = [];
  const allWindows = [];
  subs.forEach(sub => {
    (sub.data.doors || []).forEach(d => allDoors.push(Object.assign({ subName: sub.name }, d)));
    (sub.data.windows || []).forEach(w => allWindows.push(Object.assign({ subName: sub.name }, w)));
  });

  // Component breakdown = SUM of each sub's computed loads (correct math for mixed envelopes)
  let sumOW = 0, sumFL = 0, sumCE = 0, sumIW = 0, sumP = 0, sumA = 0, sumD = 0, sumW = 0, sumSens = 0;
  rows.forEach(({ result: r }) => {
    sumOW += r.outdoorWalls; sumFL += r.floors; sumCE += r.ceilings;
    sumIW += r.indoorWalls;  sumP  += r.people; sumA  += r.appliances;
    sumD  += r.doorsLoad;    sumW  += r.windowsLoad;
    sumSens += r.sensibleW;
  });
  const totalKW = 1.3 * sumSens / 1000;
  const wattsPerM2 = totalRoomArea > 0 ? totalKW * 1000 / totalRoomArea : NaN;

  const page = el("div", { class: "thl-total-view" });

  // Info banner with links to each sub
  const banner = el("div", { class: "total-banner" });
  banner.appendChild(el("strong", {}, "Σ Consolidated view. "));
  banner.appendChild(document.createTextNode(
    `Summed from ${subs.length} sub-page${subs.length === 1 ? "" : "s"}: `
  ));
  subs.forEach((sub, i) => {
    const link = el("a", { class: "total-tbl-link", href: "#" }, sub.name);
    link.onclick = (e) => { e.preventDefault(); session.activeSub = i; render(); };
    banner.appendChild(link);
    if (i < subs.length - 1) banner.appendChild(document.createTextNode(", "));
  });
  banner.appendChild(document.createTextNode(
    ". Doors & windows here are editable — edits write back to the source sub-page. Envelope / occupancy fields are aggregates: click a sub-page name to edit them."
  ));
  page.appendChild(banner);

  // Four consolidated input cards — read-only mirror of the regular THL layout
  // Per-sub breakdowns — show for every field so users can see the composition on hover
  const breakdownOf = (labelFn) => subs.map(sub => ({ name: sub.name, val: labelFn(sub) }));
  const bdRoomArea    = breakdownOf(sub => `${fmt(num(sub.data.roomArea), 3)} m²`);
  const bdOutPerim    = breakdownOf(sub => `${fmt(num(sub.data.outdoorPerimeter), 3)} m`);
  const bdInPerim     = breakdownOf(sub => `${fmt(num(sub.data.indoorPerimeter), 3)} m`);
  const bdWallHeight  = breakdownOf(sub => `${num(sub.data.wallHeight)} m`);
  const bdWallMat     = breakdownOf(sub => sub.data.wallMaterial);
  const bdSun         = breakdownOf(sub => sub.data.sunExposure ? "Yes" : "No");
  const bdCarpet      = breakdownOf(sub => sub.data.carpet ? "Yes" : "No");
  const bdCeil        = breakdownOf(sub => sub.data.ceilingInsulation ? "Yes" : "No");
  const bdPeople      = breakdownOf(sub => `${num(sub.data.peopleCount)}`);
  const bdActivity    = breakdownOf(sub => sub.data.activity);
  const bdAppliances  = breakdownOf(sub => `${fmt(num(sub.data.appliances), 0)} W`);

  const roomCard = el("div", { class: "card" }, [
    el("div", { class: "card-header" }, "Room & envelope — Σ"),
    el("div", { class: "card-body" }, [
      el("div", { class: "field-stack" }, [
        roField("Room area", "A", "m²", fmt(totalRoomArea, 3), bdRoomArea),
        roField("Outdoor perimeter", "P<sub>out</sub>", "m", fmt(totalOutdoorPerim, 3), bdOutPerim),
        roField("Indoor perimeter", "P<sub>in</sub>", "m", fmt(totalIndoorPerim, 3), bdInPerim),
        roField("Wall height", "H", "m", wallHeightDisplay, bdWallHeight),
        roField("Exterior wall material", "F<sub>wall</sub>", "", wallMaterialDisplay, bdWallMat),
        roField("Exterior sun exposure", "", "", sunDisplay, bdSun),
        roField("Carpeted floor", "", "", carpetDisplay, bdCarpet),
        roField("Ceiling insulated", "", "", ceilDisplay, bdCeil),
      ]),
    ]),
  ]);

  const occCard = el("div", { class: "card" }, [
    el("div", { class: "card-header" }, "Occupancy & appliances — Σ"),
    el("div", { class: "card-body" }, [
      el("div", { class: "field-stack" }, [
        roField("People count", "n", "", fmt(totalPeople, 0), bdPeople),
        roField("Activity level", "F<sub>act</sub>", "", activityDisplay, bdActivity),
        roField("Appliances (sum)", "Q<sub>appl</sub>", "W", fmt(totalAppliancesInp, 0), bdAppliances),
      ]),
    ]),
  ]);

  const doorsCard = el("div", { class: "card" }, [
    el("div", { class: "card-header" }, `Doors — Σ (${allDoors.length})`),
    renderTotalDoorsTable(session),
  ]);
  const winCard = el("div", { class: "card" }, [
    el("div", { class: "card-header" }, `Windows — Σ (${allWindows.length})`),
    renderTotalWindowsTable(session),
  ]);
  page.appendChild(el("div", { class: "card-row card-row-thl" }, [roomCard, occCard, doorsCard, winCard]));

  // Component breakdown — sum of each sub's contribution
  const compBreakdown = (getter) => rows.map(({ sub, result }) => ({
    name: sub.name,
    val: fmt(getter(result), 1) + " W",
  }));

  page.appendChild(el("div", { class: "card" }, [
    el("div", { class: "card-header" }, "Component breakdown — Σ"),
    el("div", { class: "card-body" }, [
      el("div", { class: "results-grid" }, [
        resultBoxBreakdown("Outdoor walls", fmt(sumOW, 1), "W", compBreakdown(r => r.outdoorWalls)),
        resultBoxBreakdown("Floors",        fmt(sumFL, 1), "W", compBreakdown(r => r.floors)),
        resultBoxBreakdown("Ceilings",      fmt(sumCE, 1), "W", compBreakdown(r => r.ceilings)),
        resultBoxBreakdown("Indoor walls",  fmt(sumIW, 1), "W", compBreakdown(r => r.indoorWalls)),
        resultBoxBreakdown("People",        fmt(sumP,  1), "W", compBreakdown(r => r.people)),
        resultBoxBreakdown("Appliances",    fmt(sumA,  1), "W", compBreakdown(r => r.appliances)),
        resultBoxBreakdown("Doors",         fmt(sumD,  1), "W", compBreakdown(r => r.doorsLoad)),
        resultBoxBreakdown("Windows",       fmt(sumW,  1), "W", compBreakdown(r => r.windowsLoad)),
      ]),
    ]),
  ]));

  // Headline
  page.appendChild(el("div", { class: "card card-headline" }, [
    el("div", { class: "card-header" }, "Cooling load — Σ TOTAL"),
    el("div", { class: "card-body" }, [
      el("div", { class: "hero-grid hero-grid-thl" }, [
        heroBoxStaticWithBreakdown("Total cooling load", fmt(totalKW, 3), "kW", true,
          `Σ across ${subs.length} sub-page${subs.length === 1 ? "" : "s"} — use this to size the AC unit`,
          rows.map(({ sub, result }) => ({ name: sub.name, val: fmt(result.totalKW, 3) + " kW" }))),
        heroBoxStaticWithBreakdown("Sensible cooling", fmt(sumSens, 1), "W", false, "Sum of 8 components",
          rows.map(({ sub, result }) => ({ name: sub.name, val: fmt(result.sensibleW, 1) + " W" }))),
        heroBoxStaticWithBreakdown("Watts per m²", fmt(isNaN(wattsPerM2) ? 0 : wattsPerM2, 1), "W/m²", false,
          `Total area ${fmt(totalRoomArea, 2)} m²`,
          rows.map(({ sub, result }) => ({
            name: sub.name,
            val: isNaN(result.wattsPerM2) ? "—" : fmt(result.wattsPerM2, 1) + " W/m²",
          }))),
      ]),
    ]),
  ]));

  // Per-page contribution table
  const perPageTbl = el("table", { class: "tbl total-tbl" });
  perPageTbl.appendChild(el("thead", {}, [
    el("tr", {}, [
      el("th", {}, "Sub-page"),
      el("th", {}, "Room area (m²)"),
      el("th", {}, "Sensible (W)"),
      el("th", {}, "Total (kW)"),
      el("th", {}, "W/m²"),
    ]),
  ]));
  const perBody = el("tbody");
  rows.forEach(({ sub, result: r }, i) => {
    const link = el("a", { class: "total-tbl-link", href: "#" }, sub.name);
    link.onclick = (e) => { e.preventDefault(); session.activeSub = i; render(); };
    perBody.appendChild(el("tr", {}, [
      el("td", {}, link),
      el("td", {}, fmt(num(sub.data.roomArea), 2)),
      el("td", {}, fmt(r.sensibleW, 1)),
      el("td", {}, fmt(r.totalKW, 3)),
      el("td", {}, fmt(isNaN(r.wattsPerM2) ? 0 : r.wattsPerM2, 1)),
    ]));
  });
  perBody.appendChild(el("tr", { class: "total-tbl-sum" }, [
    el("td", {}, "TOTAL"),
    el("td", {}, fmt(totalRoomArea, 2)),
    el("td", {}, fmt(sumSens, 1)),
    el("td", {}, fmt(totalKW, 3)),
    el("td", {}, fmt(isNaN(wattsPerM2) ? 0 : wattsPerM2, 1)),
  ]));
  perPageTbl.appendChild(perBody);

  page.appendChild(el("div", { class: "card" }, [
    el("div", { class: "card-header" }, "Per-page breakdown"),
    el("div", { class: "card-body" }, [perPageTbl]),
  ]));

  return page;
}

function roField(labelText, symbol, unit, value, breakdown) {
  const wrap = el("div", { class: "field ro-field" });
  wrap.appendChild(buildLabel(labelText, symbol, unit));
  const v = el("div", { class: "ro-value" }, String(value));
  const isMixed = String(value).toLowerCase().startsWith("mixed");
  if (isMixed) v.classList.add("ro-mixed");
  if (breakdown && breakdown.length > 0) {
    v.classList.add("ro-has-tip");
    attachInfoTip(v, breakdown);
  } else if (isMixed) {
    v.title = "Values differ across sub-pages.";
  }
  wrap.appendChild(v);
  return wrap;
}

// Small hover popover that lists per-sub values for a "Mixed" field
function attachInfoTip(triggerEl, rows) {
  let tip = null;
  triggerEl.style.cursor = "help";
  triggerEl.addEventListener("mouseenter", () => {
    tip = document.createElement("div");
    tip.className = "info-tip";
    const inner = document.createElement("div");
    inner.className = "info-tip-inner";
    inner.appendChild(el("div", { class: "info-tip-title" }, "Values by sub-page"));
    rows.forEach(r => {
      inner.appendChild(el("div", { class: "info-tip-row" }, [
        el("span", { class: "info-tip-name" }, r.name),
        el("span", { class: "info-tip-val" }, String(r.val)),
      ]));
    });
    tip.appendChild(inner);
    document.body.appendChild(tip);
    const r = triggerEl.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    let left = r.left + r.width / 2 - tr.width / 2;
    let top  = r.bottom + 6;
    left = Math.max(8, Math.min(left, window.innerWidth - tr.width - 8));
    if (top + tr.height > window.innerHeight - 8) top = r.top - tr.height - 6;
    tip.style.left = left + "px";
    tip.style.top  = top + "px";
  });
  triggerEl.addEventListener("mouseleave", () => {
    if (tip) { tip.remove(); tip = null; }
  });
}

// Editable doors table shown on the Total tab — edits write back to the source sub-page
function renderTotalDoorsTable(session) {
  const wrap = el("div", { class: "tbl-wrap" });
  const tbl = el("table", { class: "tbl" });
  tbl.appendChild(el("thead", {}, [
    el("tr", {}, [
      el("th", {}, "Sub-page"),
      el("th", {}, "Count"),
      el("th", {}, "Width (m)"),
      el("th", {}, "Height (m)"),
      el("th", {}, "Area (m²)"),
      el("th", {}, "Load (W)"),
      el("th", {}, ""),
    ]),
  ]));
  const tbody = el("tbody");
  const hasAny = session.subs.some(s => s.data.doors && s.data.doors.length > 0);
  if (!hasAny) {
    tbody.appendChild(el("tr", {}, [
      el("td", { colspan: "7", style: "text-align:center; color:var(--text-muted); padding:16px;" },
        "No doors on any sub-page yet."),
    ]));
  } else {
    session.subs.forEach((sub, subIdx) => {
      (sub.data.doors || []).forEach((r, i) => {
        const area = num(r.count) * num(r.width) * num(r.height);
        const load = area * 50;
        const subLink = el("a", { class: "total-tbl-link", href: "#" }, sub.name);
        subLink.onclick = (e) => { e.preventDefault(); session.activeSub = subIdx; render(); };
        tbody.appendChild(el("tr", {}, [
          el("td", {}, subLink),
          el("td", {}, tblNum(r.count,  (v) => { r.count  = v; render(); })),
          el("td", {}, tblNum(r.width,  (v) => { r.width  = v; render(); })),
          el("td", {}, tblNum(r.height, (v) => { r.height = v; render(); })),
          el("td", { class: "tbl-area" }, fmt(area, 3)),
          el("td", { class: "tbl-load" }, fmt(load, 1)),
          el("td", {}, el("button", {
            class: "btn-del",
            title: `Remove this door from ${sub.name}`,
            onclick: () => { sub.data.doors.splice(i, 1); render(); },
          }, "✕")),
        ]));
      });
    });
  }
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  return wrap;
}

// Editable windows table shown on the Total tab
function renderTotalWindowsTable(session) {
  const wrap = el("div", { class: "tbl-wrap" });
  const tbl = el("table", { class: "tbl" });
  tbl.appendChild(el("thead", {}, [
    el("tr", {}, [
      el("th", {}, "Sub-page"),
      el("th", {}, "Count"),
      el("th", {}, "Width (m)"),
      el("th", {}, "Height (m)"),
      el("th", {}, "Facing"),
      el("th", {}, "Shading"),
      el("th", {}, "Area (m²)"),
      el("th", {}, "Load (W)"),
      el("th", {}, ""),
    ]),
  ]));
  const tbody = el("tbody");
  const hasAny = session.subs.some(s => s.data.windows && s.data.windows.length > 0);
  if (!hasAny) {
    tbody.appendChild(el("tr", {}, [
      el("td", { colspan: "9", style: "text-align:center; color:var(--text-muted); padding:16px;" },
        "No windows on any sub-page yet."),
    ]));
  } else {
    session.subs.forEach((sub, subIdx) => {
      (sub.data.windows || []).forEach((r, i) => {
        const area = num(r.count) * num(r.width) * num(r.height);
        const factor = (WINDOW_FACTORS[r.facing] && WINDOW_FACTORS[r.facing][r.shading]) || 0;
        const load = area * factor;
        const subLink = el("a", { class: "total-tbl-link", href: "#" }, sub.name);
        subLink.onclick = (e) => { e.preventDefault(); session.activeSub = subIdx; render(); };
        tbody.appendChild(el("tr", {}, [
          el("td", {}, subLink),
          el("td", {}, tblNum(r.count,  (v) => { r.count  = v; render(); })),
          el("td", {}, tblNum(r.width,  (v) => { r.width  = v; render(); })),
          el("td", {}, tblNum(r.height, (v) => { r.height = v; render(); })),
          el("td", {}, tblSelect(r.facing,  DIRECTIONS, (v) => { r.facing  = v; render(); })),
          el("td", {}, tblSelect(r.shading, SHADINGS,   (v) => { r.shading = v; render(); }, "sh-select")),
          el("td", { class: "tbl-area" }, fmt(area, 3)),
          el("td", { class: "tbl-load" }, fmt(load, 1)),
          el("td", {}, el("button", {
            class: "btn-del",
            title: `Remove this window from ${sub.name}`,
            onclick: () => { sub.data.windows.splice(i, 1); render(); },
          }, "✕")),
        ]));
      });
    });
  }
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  return wrap;
}

function renderROTable(rows, columns) {
  const wrap = el("div", { class: "tbl-wrap" });
  const tbl = el("table", { class: "tbl" });
  tbl.appendChild(el("thead", {}, [
    el("tr", {}, columns.map(c => el("th", {}, c.label))),
  ]));
  const tbody = el("tbody");
  if (rows.length === 0) {
    tbody.appendChild(el("tr", {}, [
      el("td", { colspan: String(columns.length), style: "text-align:center; color:var(--text-muted); padding:16px;" }, "None"),
    ]));
  } else {
    rows.forEach(r => {
      tbody.appendChild(el("tr", {}, columns.map(c => {
        const v = r[c.key];
        let disp;
        if (v == null || v === "") disp = "—";
        else if (typeof v === "number" && c.fmt != null) disp = fmt(v, c.fmt);
        else disp = String(v);
        return el("td", {}, disp);
      })));
    });
  }
  tbl.appendChild(tbody);
  wrap.appendChild(tbl);
  return wrap;
}

function resultBoxBreakdown(label, value, unit, breakdown) {
  const box = el("div", { class: "result" }, [
    el("div", { class: "result-label" }, label),
    el("div", { class: "result-value" }, [
      value,
      unit ? el("span", { class: "unit-inline" }, unit) : null,
    ]),
  ]);
  if (breakdown && breakdown.length > 0) {
    box.classList.add("ro-has-tip");
    box.style.cursor = "help";
    attachInfoTip(box, breakdown);
  }
  return box;
}

function heroBoxStaticWithBreakdown(label, value, unit, primary, subtitle, breakdown) {
  const tile = heroBoxStatic(label, value, unit, primary, subtitle);
  if (breakdown && breakdown.length > 0) {
    tile.classList.add("ro-has-tip");
    tile.style.cursor = "help";
    attachInfoTip(tile, breakdown);
  }
  return tile;
}

function heroBoxStatic(label, value, unit, primary, subtitle) {
  const cls = "hero-tile" + (primary ? " hero-primary" : "");
  return el("div", { class: cls }, [
    el("div", { class: "hero-label" }, label),
    el("div", { class: "hero-value" }, [
      value,
      unit ? el("span", { class: "hero-unit" }, unit) : null,
    ]),
    subtitle ? el("div", { class: "hero-sub" }, subtitle) : null,
  ]);
}

function newPD() {
  state.seqCounters.PD += 1;
  const s = {
    id: state.nextId++,
    type: "PD",
    seq: state.seqCounters.PD,
    name: "",
    data: {
      velocity: 0,
      ductWidth: 0,
      ductHeight: 0,
      material: "Galvanised Iron",
      airDensity: 1.2,
      dynamicViscosity: 0.0000181,
    },
  };
  state.sessions.push(s);
  return s;
}

function findSession(id) {
  return state.sessions.find((s) => s.id === id);
}

function deleteSession(id) {
  const idx = state.sessions.findIndex((s) => s.id === id);
  if (idx === -1) return;
  state.sessions.splice(idx, 1);
  if (state.activeId === id) state.activeId = null;
}

function sessionLabel(s) {
  // Tab label = user's chosen name if set, otherwise the auto identifier (e.g. "THL #1")
  return (s.name && s.name.trim()) ? s.name.trim() : `${s.type} #${s.seq}`;
}

/* ================================================================
   CALCULATIONS
   ================================================================ */

function calcTHL(d) {
  const wh = num(d.wallHeight);
  const roomArea = num(d.roomArea);
  const outdoorPerim = num(d.outdoorPerimeter);
  const indoorPerim = num(d.indoorPerimeter);

  // Rows with per-row areas + loads
  const doorRows = d.doors.map((r) => {
    const area = num(r.count) * num(r.width) * num(r.height);
    const load = area * DOOR_FACTOR;
    return { ...r, area, load };
  });
  const doorsArea = doorRows.reduce((s, r) => s + r.area, 0);
  const doorsLoad = doorsArea * DOOR_FACTOR;

  const windowRows = d.windows.map((r) => {
    const area = num(r.count) * num(r.width) * num(r.height);
    const factor = (WINDOW_FACTORS[r.facing] && WINDOW_FACTORS[r.facing][r.shading]) || 0;
    const load = area * factor;
    return { ...r, area, factor, load };
  });
  const windowsArea = windowRows.reduce((s, r) => s + r.area, 0);
  const windowsLoad = windowRows.reduce((s, r) => s + r.load, 0);

  const outdoorFactor = d.sunExposure ? (WALL_MATERIAL_FACTORS[d.wallMaterial] || 0) : NO_SUN_FACTOR;
  const outdoorWalls = (outdoorPerim * wh - windowsArea) * outdoorFactor;

  const floors = roomArea * (d.carpet ? CARPET_FACTOR : UNCARPETED_FACTOR);
  const ceilings = roomArea * (d.ceilingInsulation ? CEILING_INSULATED_FACTOR : CEILING_UNINSULATED_FACTOR);
  const indoorWalls = (indoorPerim * wh - doorsArea) * INDOOR_WALL_FACTOR;
  const people = (ACTIVITY_FACTORS[d.activity] || 0) * num(d.peopleCount);
  const appliances = num(d.appliances);

  const sensibleW = outdoorWalls + floors + ceilings + indoorWalls + people + appliances + doorsLoad + windowsLoad;
  const totalKW = 1.3 * sensibleW / 1000;
  const wattsPerM2 = roomArea > 0 ? totalKW / roomArea * 1000 : NaN;

  return {
    doorRows, windowRows,
    doorsArea, doorsLoad, windowsArea, windowsLoad,
    outdoorWalls, floors, ceilings, indoorWalls, people, appliances,
    sensibleW, totalKW, wattsPerM2,
  };
}

function calcPD(d) {
  const V = num(d.velocity);
  const W = num(d.ductWidth);
  const H = num(d.ductHeight);
  const rho = num(d.airDensity);
  const mu = num(d.dynamicViscosity);
  const rough = ROUGHNESS[d.material] || 0;

  const area = W * H;
  const airflowM3s = V * area;
  const airflowLs = airflowM3s * 1000;

  const wMM = W * 1000;
  const hMM = H * 1000;
  const dh = (wMM + hMM) > 0 ? (2 * wMM * hMM) / (wMM + hMM) : NaN;   // mm

  const reynolds = (mu > 0 && !isNaN(dh)) ? (rho * V * (dh / 1000)) / mu : NaN;
  const firstFF = (!isNaN(reynolds) && reynolds > 0 && dh > 0)
    ? 0.11 * Math.pow(rough / dh + 68 / reynolds, 0.25)
    : NaN;
  const frictionFactor = isNaN(firstFF) ? NaN : (firstFF < 0.018 ? firstFF * 0.85 + 0.0028 : firstFF);
  const paPerM = (dh > 0 && !isNaN(frictionFactor))
    ? 1000 * frictionFactor * rho * V * V / (2 * dh)
    : NaN;

  return {
    area, airflowM3s, airflowLs, roughness: rough,
    hydraulicDiameter: dh, reynolds,
    firstFF, frictionFactor, paPerM,
  };
}

/* ================================================================
   UTILS
   ================================================================ */

function num(v) {
  const n = parseFloat(v);
  return isNaN(n) ? 0 : n;
}
function fmt(v, decimals = 2) {
  if (v === null || v === undefined || isNaN(v)) return "—";
  return v.toLocaleString("en-AU", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === "class") e.className = attrs[k];
    else if (k === "html") e.innerHTML = attrs[k];
    else if (k.startsWith("on") && typeof attrs[k] === "function") {
      e.addEventListener(k.slice(2), attrs[k]);
    } else if (k === "checked" || k === "disabled") {
      if (attrs[k]) e.setAttribute(k, "");
    } else {
      e.setAttribute(k, attrs[k]);
    }
  }
  (Array.isArray(children) ? children : [children]).forEach((c) => {
    if (c === null || c === undefined || c === false) return;
    if (typeof c === "string" || typeof c === "number") e.appendChild(document.createTextNode(c));
    else e.appendChild(c);
  });
  return e;
}

/* ================================================================
   RENDER — root
   ================================================================ */

const root = document.getElementById("app");

function render() {
  clearOrphanTips();
  root.innerHTML = "";
  root.appendChild(renderNav());
  if (state.activeId === null) {
    root.appendChild(renderHome());
  } else if (state.activeId === "__admin__") {
    // Admin panel — only reachable if user is an admin (nav button hidden otherwise)
    if (!(window.authGate && window.authGate.isAdmin)) { state.activeId = null; return render(); }
    root.appendChild(renderAdminPanel());
  } else {
    const session = findSession(state.activeId);
    if (!session) { state.activeId = null; return render(); }
    if (session.type === "THL") root.appendChild(renderTHL(session));
    else root.appendChild(renderPD(session));
    refresh(session);
  }
  if (state.modalOpen) root.appendChild(renderModal(state.modalOpen));
  if (window.isTakeoffOpen && window.isTakeoffOpen()) {
    root.appendChild(window.renderTakeoffOverlay());
  }
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.modalOpen) {
    state.modalOpen = null;
    render();
  }
});

/* ================================================================
   RENDER — nav
   ================================================================ */

function renderNav() {
  const nav = el("div", { class: "nav" });

  const homeBtn = el("button", {
    class: "nav-home",
    onclick: () => { state.activeId = null; render(); },
  }, "🏠 Home");
  nav.appendChild(homeBtn);

  if (state.sessions.length > 0) {
    nav.appendChild(el("div", { class: "nav-sep" }));

    const tabs = el("div", { class: "nav-tabs" });
    state.sessions.forEach((s) => {
      const isActive = s.id === state.activeId;
      const tab = el("div", { class: "nav-tab" + (isActive ? " active" : "") }, [
        el("span", {
          onclick: () => { state.activeId = s.id; render(); },
          ondblclick: async (e) => {
            e.stopPropagation();
            if (!window.promptModal) return;
            const suggested = s.name || `${s.type} #${s.seq}`;
            const newName = await window.promptModal(
              "New name for this calculation:", suggested,
              { title: "Rename calculation", type: "text", okLabel: "Rename" });
            if (newName === null) return;
            s.name = (newName || "").trim();
            render();
          },
          title: "Click to open · double-click to rename",
        }, sessionLabel(s)),
        el("button", {
          class: "nav-tab-close",
          title: "Delete this calculation",
          onclick: (e) => {
            e.stopPropagation();
            if (confirm(`Delete ${sessionLabel(s)}? This cannot be undone.`)) {
              deleteSession(s.id);
              render();
            }
          },
        }, "✕"),
      ]);
      tabs.appendChild(tab);
    });
    nav.appendChild(tabs);
  }

  // ⚙ Admin — only for admins
  if (window.authGate && window.authGate.isAdmin) {
    const adminActive = state.activeId === "__admin__";
    nav.appendChild(el("button", {
      class: "nav-admin" + (adminActive ? " active" : ""),
      title: "Admin — user management",
      onclick: () => { state.activeId = "__admin__"; render(); },
    }, "⚙ Admin"));
  }

  nav.appendChild(el("button", {
    class: "nav-new",
    onclick: () => { const s = newTHL(); state.activeId = s.id; render(); },
  }, "+ New THL"));
  nav.appendChild(el("button", {
    class: "nav-new",
    onclick: () => { const s = newPD(); state.activeId = s.id; render(); },
  }, "+ New PD"));

  // Signed-in identity + sign-out (only shown when the auth gate is active)
  if (window.authGate && window.authGate.currentUser) {
    const user = window.authGate.currentUser;
    const identity = el("div", { class: "nav-user" }, [
      window.authGate.isAdmin ? el("span", { class: "nav-user-badge" }, "ADMIN") : null,
      el("span", { class: "nav-user-name", title: `Signed in as ${user.username}` },
        user.name || user.username),
    ]);
    nav.appendChild(identity);
    nav.appendChild(el("button", {
      class: "nav-signout",
      title: "Sign out",
      onclick: () => window.authGate.signOut(),
    }, "Sign out"));
  }

  return nav;
}

/* ================================================================
   RENDER — home
   ================================================================ */

function renderHome() {
  const home = el("div", { class: "home" }, [
    el("div", { class: "home-title" }, "HL + PD Calculator"),
    el("div", { class: "home-subtitle" }, "Heat load and duct pressure drop"),
    el("div", { class: "home-buttons" }, [
      el("button", {
        class: "home-btn",
        onclick: () => { const s = newTHL(); state.activeId = s.id; render(); },
      }, [
        el("span", { class: "home-btn-icon" }, "🌡️"),
        "Heat Load Calculation",
      ]),
      el("button", {
        class: "home-btn",
        onclick: () => { const s = newPD(); state.activeId = s.id; render(); },
      }, [
        el("span", { class: "home-btn-icon" }, "💨"),
        "Pressure Drop Calculation",
      ]),
    ]),
  ]);

  const sessBox = el("div", { class: "home-sessions" }, [
    el("h2", {}, "Current session calculations"),
  ]);
  const list = el("div", { class: "home-session-list" });
  if (state.sessions.length === 0) {
    list.appendChild(el("div", { class: "home-empty" }, "None yet. Create one above."));
  } else {
    state.sessions.forEach((s) => {
      list.appendChild(el("div", {
        class: "home-session",
        onclick: () => { state.activeId = s.id; render(); },
      }, [
        el("span", { class: "home-session-label" }, sessionLabel(s)),
        el("span", { class: "home-session-type" }, s.type),
      ]));
    });
  }
  sessBox.appendChild(list);
  home.appendChild(sessBox);
  return home;
}

/* ================================================================
   RENDER — THL page
   ================================================================ */

function renderTHL(session) {
  const page = el("div", { class: "page" });

  page.appendChild(renderPageHeader(session, "Heat Load Calculation"));

  // Sub-tab bar (always shown for THL — includes the "+ Add page" button so
  // sub-pages can be created manually even before Take-Off is used).
  page.appendChild(renderSubTabs(session));

  // Total view is read-only
  if (isTHLTotalView(session)) {
    page.appendChild(renderTHLTotal(session));
    return page;
  }

  // If the active sub was produced by a merge, show a pill with per-field origin on hover
  if (session.subs && session.subs.length > 0 && typeof session.activeSub === "number") {
    const sub = session.subs[session.activeSub];
    if (sub && sub.mergedFrom && sub.mergedFrom.length > 0) {
      page.appendChild(renderMergedPill(sub));
    }
  }

  const d = activeTHLData(session);

  // ---- Input cards side-by-side ----
  const roomCard = el("div", { class: "card" }, [
    el("div", { class: "card-header" }, "Room & envelope"),
    el("div", { class: "card-body" }, [
      el("div", { class: "field-stack" }, [
        numField("Room area", "m²", d.roomArea, (v) => { d.roomArea = v; refresh(session); }, 3, "A"),
        numField("Outdoor perimeter", "m", d.outdoorPerimeter, (v) => { d.outdoorPerimeter = v; refresh(session); }, 3, "P<sub>out</sub>"),
        numField("Indoor perimeter", "m", d.indoorPerimeter, (v) => { d.indoorPerimeter = v; refresh(session); }, 3, "P<sub>in</sub>"),
        numField("Wall height", "m", d.wallHeight, (v) => { d.wallHeight = v; refresh(session); }, 3, "H"),
        selectField("Exterior wall material", d.wallMaterial, Object.keys(WALL_MATERIAL_FACTORS), (v) => { d.wallMaterial = v; refresh(session); }, "F<sub>wall</sub>"),
        checkField("Exterior sun exposure", d.sunExposure, (v) => { d.sunExposure = v; refresh(session); }),
        checkField("Carpeted floor", d.carpet, (v) => { d.carpet = v; refresh(session); }),
        checkField("Ceiling insulated", d.ceilingInsulation, (v) => { d.ceilingInsulation = v; refresh(session); }),
      ]),
    ]),
  ]);

  const occCard = el("div", { class: "card" }, [
    el("div", { class: "card-header" }, "Occupancy & appliances"),
    el("div", { class: "card-body" }, [
      el("div", { class: "field-stack" }, [
        numField("People count", "", d.peopleCount, (v) => { d.peopleCount = v; refresh(session); }, 0, "n"),
        selectField("Activity level", d.activity, ["Active", "Inactive"], (v) => { d.activity = v; refresh(session); }, "F<sub>act</sub>"),
        numField("Appliances", "W", d.appliances, (v) => { d.appliances = v; refresh(session); }, 3, "Q<sub>appl</sub>"),
      ]),
    ]),
  ]);

  const doorsCard = el("div", { class: "card" }, [
    el("div", { class: "card-header" }, "Doors"),
    renderDoorsTable(session),
  ]);

  const winCard = el("div", { class: "card" }, [
    el("div", { class: "card-header" }, "Windows"),
    renderWindowsTable(session),
  ]);

  page.appendChild(el("div", { class: "card-row card-row-thl" }, [
    roomCard, occCard, doorsCard, winCard,
  ]));

  // ---- Component breakdown ----
  page.appendChild(el("div", { class: "card" }, [
    el("div", { class: "card-header" }, "Component breakdown"),
    el("div", { class: "card-body" }, [
      el("div", { class: "results-grid", id: "thl-results" }),
    ]),
  ]));

  // ---- Headline results (distinctive pane) ----
  page.appendChild(el("div", { class: "card card-headline" }, [
    el("div", { class: "card-header" }, "Cooling load — result"),
    el("div", { class: "card-body" }, [
      el("div", { class: "hero-grid hero-grid-thl", id: "thl-headline" }),
    ]),
  ]));

  return page;
}

/* ---- Doors / Windows tables ---- */

function renderDoorsTable(session) {
  const d = activeTHLData(session);
  const wrap = el("div", { class: "tbl-wrap" });
  const table = el("table", { class: "tbl" });

  const thead = el("thead", {}, [
    el("tr", {}, [
      el("th", {}, "#"),
      el("th", {}, "Count"),
      el("th", {}, "Width (m)"),
      el("th", {}, "Height (m)"),
      el("th", {}, "Area (m²)"),
      el("th", {}, "Load (W)"),
      el("th", {}, ""),
    ]),
  ]);
  const tbody = el("tbody");

  if (d.doors.length === 0) {
    tbody.appendChild(el("tr", {}, [
      el("td", { colspan: "7", style: "text-align:center; color: var(--text-muted); padding: 16px;" },
        "No doors — click ‘+ Add Door’ below to add one."),
    ]));
  } else {
    d.doors.forEach((r, i) => {
      const row = el("tr", {}, [
        el("td", { class: "tbl-idx" }, String(i + 1)),
        el("td", {}, tblNum(r.count, (v) => { r.count = v; refresh(session); })),
        el("td", {}, tblNum(r.width, (v) => { r.width = v; refresh(session); })),
        el("td", {}, tblNum(r.height, (v) => { r.height = v; refresh(session); })),
        el("td", { class: "tbl-area", "data-door-area": String(i) }, "—"),
        el("td", { class: "tbl-load", "data-door-load": String(i) }, "—"),
        el("td", {}, el("button", {
          class: "btn-del",
          title: "Remove this door",
          onclick: () => { d.doors.splice(i, 1); render(); },
        }, "✕")),
      ]);
      tbody.appendChild(row);
    });
  }
  table.appendChild(thead);
  table.appendChild(tbody);
  wrap.appendChild(table);

  const footer = el("div", { class: "tbl-footer" }, [
    el("div", { class: "tbl-totals" }, [
      el("span", {}, ["Total area: ", el("strong", { id: "doors-total-area" }, "—"), " m²"]),
      el("span", {}, ["Total load: ", el("strong", { id: "doors-total-load" }, "—"), " W"]),
    ]),
    el("button", {
      class: "btn-add",
      onclick: () => { d.doors.push({ count: 1, width: 0, height: 0 }); render(); },
    }, "+ Add Door"),
  ]);
  wrap.appendChild(footer);
  return wrap;
}

function renderWindowsTable(session) {
  const d = activeTHLData(session);
  const wrap = el("div", { class: "tbl-wrap" });
  const table = el("table", { class: "tbl" });

  const thead = el("thead", {}, [
    el("tr", {}, [
      el("th", {}, "#"),
      el("th", {}, "Count"),
      el("th", {}, "Width (m)"),
      el("th", {}, "Height (m)"),
      el("th", {}, "Facing"),
      el("th", {}, "Shading"),
      el("th", {}, "Area (m²)"),
      el("th", {}, "Load (W)"),
      el("th", {}, ""),
    ]),
  ]);
  const tbody = el("tbody");

  if (d.windows.length === 0) {
    tbody.appendChild(el("tr", {}, [
      el("td", { colspan: "9", style: "text-align:center; color: var(--text-muted); padding: 16px;" },
        "No windows — click ‘+ Add Window’ below to add one."),
    ]));
  } else {
    d.windows.forEach((r, i) => {
      const row = el("tr", {}, [
        el("td", { class: "tbl-idx" }, String(i + 1)),
        el("td", {}, tblNum(r.count, (v) => { r.count = v; refresh(session); })),
        el("td", {}, tblNum(r.width, (v) => { r.width = v; refresh(session); })),
        el("td", {}, tblNum(r.height, (v) => { r.height = v; refresh(session); })),
        el("td", {}, tblSelect(r.facing, DIRECTIONS, (v) => { r.facing = v; refresh(session); })),
        el("td", {}, tblSelect(r.shading, SHADINGS, (v) => { r.shading = v; refresh(session); }, "sh-select")),
        el("td", { class: "tbl-area", "data-win-area": String(i) }, "—"),
        el("td", { class: "tbl-load", "data-win-load": String(i) }, "—"),
        el("td", {}, el("button", {
          class: "btn-del",
          title: "Remove this window",
          onclick: () => { d.windows.splice(i, 1); render(); },
        }, "✕")),
      ]);
      tbody.appendChild(row);
    });
  }
  table.appendChild(thead);
  table.appendChild(tbody);
  wrap.appendChild(table);

  const footer = el("div", { class: "tbl-footer" }, [
    el("div", { class: "tbl-totals" }, [
      el("span", {}, ["Total area: ", el("strong", { id: "windows-total-area" }, "—"), " m²"]),
      el("span", {}, ["Total load: ", el("strong", { id: "windows-total-load" }, "—"), " W"]),
    ]),
    el("button", {
      class: "btn-add",
      onclick: () => {
        d.windows.push({ count: 1, width: 0, height: 0, facing: "N", shading: "Curtains/Blinds" });
        render();
      },
    }, "+ Add Window"),
  ]);
  wrap.appendChild(footer);
  return wrap;
}

/* ================================================================
   RENDER — PD page
   ================================================================ */

function renderPD(session) {
  const d = session.data;
  const page = el("div", { class: "page" });

  page.appendChild(renderPageHeader(session, "Pressure Drop Calculation"));

  const ductCard = el("div", { class: "card" }, [
    el("div", { class: "card-header" }, "Duct"),
    el("div", { class: "card-body" }, [
      el("div", { class: "field-stack" }, [
        numField("Duct width", "m", d.ductWidth, (v) => { d.ductWidth = v; refresh(session); }, 3, "W"),
        numField("Duct height", "m", d.ductHeight, (v) => { d.ductHeight = v; refresh(session); }, 3, "H"),
        selectField("Duct material", d.material, Object.keys(ROUGHNESS), (v) => { d.material = v; refresh(session); }, "ε"),
      ]),
    ]),
  ]);

  const flowCard = el("div", { class: "card" }, [
    el("div", { class: "card-header" }, "Flow & fluid"),
    el("div", { class: "card-body" }, [
      el("div", { class: "field-stack" }, [
        numField("Velocity", "m/s", d.velocity, (v) => { d.velocity = v; refresh(session); }, 3, "V"),
        numField("Air density", "kg/m³", d.airDensity, (v) => { d.airDensity = v; refresh(session); }, 3, "ρ"),
        numField("Dynamic viscosity", "kg/m·s", d.dynamicViscosity, (v) => { d.dynamicViscosity = v; refresh(session); }, 8, "μ"),
      ]),
    ]),
  ]);

  page.appendChild(el("div", { class: "card-row card-row-pd" }, [ductCard, flowCard]));

  page.appendChild(el("div", { class: "card" }, [
    el("div", { class: "card-header" }, "Intermediate values"),
    el("div", { class: "card-body" }, [
      el("div", { class: "results-grid", id: "pd-results" }),
    ]),
  ]));

  page.appendChild(el("div", { class: "card card-headline" }, [
    el("div", { class: "card-header" }, "Pressure drop — result"),
    el("div", { class: "card-body" }, [
      el("div", { class: "hero-grid hero-grid-pd", id: "pd-headline" }),
    ]),
  ]));

  return page;
}

/* ================================================================
   RENDER — helpers
   ================================================================ */

function renderPageHeader(session, title) {
  const children = [
    el("div", { class: "page-title" }, `${title} — #${session.seq}`),
    el("input", {
      class: "page-name-input",
      type: "text",
      placeholder: "Name this calculation (e.g. Living Room)…",
      value: session.name,
      oninput: (e) => {
        session.name = e.target.value;
        document.querySelectorAll(".nav-tab.active > span:first-child").forEach((el) => {
          el.textContent = sessionLabel(session);
        });
      },
    }),
  ];
  if (session.type === "THL") {
    const to = session.takeoff;
    let elCount = 0;
    if (to && to.pages) to.pages.forEach(p => { elCount += (p.elements || []).length; });
    const hasSaved = !!(to && to.pages && to.pages.length > 0);
    const label = hasSaved
      ? `🖼️ Auto Take-Off (resume — ${elCount} item${elCount === 1 ? "" : "s"})`
      : "🖼️ Auto Take-Off";
    children.push(el("button", {
      class: "btn-takeoff" + (hasSaved ? " has-saved" : ""),
      onclick: () => { if (window.openTakeoff) window.openTakeoff(session); },
      title: hasSaved ? "Resume your saved take-off for this THL" : "Open the floor-plan take-off tool",
    }, label));
  }
  children.push(el("button", {
    class: "btn-formulas",
    onclick: () => { state.modalOpen = session.type; render(); },
  }, "📋 Formulas"));
  children.push(el("button", {
    class: "btn-export",
    onclick: async () => { await exportPDF(session); },
    title: "Export this page as a PDF (visual capture of what you see)",
  }, "📤 Export PDF"));
  return el("div", { class: "page-header" }, children);
}

function buildLabel(labelText, symbol, unit) {
  const label = document.createElement("label");
  label.appendChild(document.createTextNode(labelText));
  if (symbol) {
    const s = document.createElement("span");
    s.className = "sym";
    s.innerHTML = symbol;   // allow HTML like "P<sub>out</sub>"
    label.appendChild(s);
  }
  if (unit) {
    const u = document.createElement("span");
    u.className = "unit";
    u.textContent = ` (${unit})`;
    label.appendChild(u);
  }
  return label;
}

function numField(labelText, unit, value, onchange, decimals = 3, symbol = "") {
  const wrap = el("div", { class: "field" });
  wrap.appendChild(buildLabel(labelText, symbol, unit));
  wrap.appendChild(el("input", {
    type: "number",
    step: "any",
    value: value === 0 ? "" : String(value),
    placeholder: "0",
    oninput: (e) => onchange(parseFloat(e.target.value)),
  }));
  return wrap;
}

function selectField(labelText, value, options, onchange, symbol = "") {
  const wrap = el("div", { class: "field" });
  wrap.appendChild(buildLabel(labelText, symbol, ""));
  const sel = el("select", { onchange: (e) => onchange(e.target.value) });
  options.forEach((o) => {
    const opt = el("option", { value: o }, o);
    if (o === value) opt.setAttribute("selected", "");
    sel.appendChild(opt);
  });
  wrap.appendChild(sel);
  return wrap;
}

function checkField(labelText, value, onchange) {
  const wrap = el("div", { class: "field-inline" });
  const cb = el("input", {
    type: "checkbox",
    checked: value,
    onchange: (e) => onchange(e.target.checked),
  });
  const id = "cb-" + Math.random().toString(36).slice(2, 9);
  cb.id = id;
  const lab = el("label", { for: id }, labelText);
  wrap.appendChild(cb);
  wrap.appendChild(lab);
  return wrap;
}

function tblNum(value, onchange) {
  return el("input", {
    type: "number",
    step: "any",
    value: value === 0 ? "" : String(value),
    placeholder: "0",
    oninput: (e) => onchange(parseFloat(e.target.value)),
  });
}
function tblSelect(value, options, onchange, extraClass = "") {
  const sel = el("select", { onchange: (e) => onchange(e.target.value) });
  if (extraClass) sel.className = extraClass;
  options.forEach((o) => {
    const opt = el("option", { value: o }, o);
    if (o === value) opt.setAttribute("selected", "");
    sel.appendChild(opt);
  });
  return sel;
}

/* ================================================================
   REFRESH — recompute + update all output cells
   ================================================================ */

function refresh(session) {
  clearOrphanTips();
  if (session.type === "THL") refreshTHL(session);
  else refreshPD(session);
}

function refreshTHL(session) {
  if (isTHLTotalView(session)) return;   // Total view is static; no live refresh needed
  const d = activeTHLData(session);
  const r = calcTHL(d);

  // Per-row outputs
  r.doorRows.forEach((row, i) => {
    const a = document.querySelector(`[data-door-area="${i}"]`);
    const l = document.querySelector(`[data-door-load="${i}"]`);
    if (a) a.textContent = fmt(row.area, 3);
    if (l) l.textContent = fmt(row.load, 1);
  });
  r.windowRows.forEach((row, i) => {
    const a = document.querySelector(`[data-win-area="${i}"]`);
    const l = document.querySelector(`[data-win-load="${i}"]`);
    if (a) a.textContent = fmt(row.area, 3);
    if (l) l.textContent = fmt(row.load, 1);
  });

  const dTA = document.getElementById("doors-total-area");
  if (dTA) dTA.textContent = fmt(r.doorsArea, 3);
  const dTL = document.getElementById("doors-total-load");
  if (dTL) dTL.textContent = fmt(r.doorsLoad, 1);
  const wTA = document.getElementById("windows-total-area");
  if (wTA) wTA.textContent = fmt(r.windowsArea, 3);
  const wTL = document.getElementById("windows-total-load");
  if (wTL) wTL.textContent = fmt(r.windowsLoad, 1);

  const f = thlFormulas(d, r);

  const grid = document.getElementById("thl-results");
  if (grid) {
    grid.innerHTML = "";
    [
      ["Outdoor walls", r.outdoorWalls, "W", f.outdoorWalls],
      ["Floors",        r.floors,       "W", f.floors],
      ["Ceilings",      r.ceilings,     "W", f.ceilings],
      ["Indoor walls",  r.indoorWalls,  "W", f.indoorWalls],
      ["People",        r.people,       "W", f.people],
      ["Appliances",    r.appliances,   "W", f.appliances],
      ["Doors",         r.doorsLoad,    "W", f.doors],
      ["Windows",       r.windowsLoad,  "W", f.windows],
    ].forEach(([lab, val, unit, formula]) =>
      grid.appendChild(resultBox(lab, fmt(val, 1), unit, formula)));
  }

  const hg = document.getElementById("thl-headline");
  if (hg) {
    hg.innerHTML = "";
    hg.appendChild(heroBox("Total cooling load", fmt(r.totalKW, 3), "kW",
      f.totalKW, { primary: true, subtitle: "Sensible × 1.3 — use this to size the AC unit" }));
    hg.appendChild(heroBox("Sensible cooling", fmt(r.sensibleW, 1), "W",
      f.sensible, { subtitle: "Sum of 8 components" }));
    hg.appendChild(heroBox("Watts per m²", fmt(r.wattsPerM2, 1), "W/m²",
      f.wattsPerM2, { subtitle: "Load density" }));
  }
}

function refreshPD(session) {
  const d = session.data;
  const r = calcPD(d);
  const f = pdFormulas(d, r);

  const grid = document.getElementById("pd-results");
  if (grid) {
    grid.innerHTML = "";
    grid.appendChild(resultBox("Area",                fmt(r.area, 4),               "m²",   f.area));
    grid.appendChild(resultBox("Airflow",             fmt(r.airflowM3s, 4),         "m³/s", f.airflowM3s));
    grid.appendChild(resultBox("Airflow",             fmt(r.airflowLs, 1),          "L/s",  f.airflowLs));
    grid.appendChild(resultBox("Roughness",           fmt(r.roughness, 4),          "mm",   f.roughness));
    grid.appendChild(resultBox("Hydraulic diameter",  fmt(r.hydraulicDiameter, 2),  "mm",   f.hydraulicDiameter));
    grid.appendChild(resultBox("Reynolds number",     fmt(r.reynolds, 0),           "",     f.reynolds));
    grid.appendChild(resultBox("First estimate F.F.", fmt(r.firstFF, 5),            "",     f.firstFF));
    grid.appendChild(resultBox("Friction factor",     fmt(r.frictionFactor, 5),     "",     f.frictionFactor));
  }

  const hg = document.getElementById("pd-headline");
  if (hg) {
    hg.innerHTML = "";
    const ductSummary = `Duct: ${fmt(num(d.ductWidth)*1000,0)} × ${fmt(num(d.ductHeight)*1000,0)} mm  •  ${d.material}  •  V = ${fmt(num(d.velocity),2)} m/s`;
    hg.appendChild(heroBox("Pressure drop per length", fmt(r.paPerM, 3), "Pa/m",
      f.paPerM, { primary: true, subtitle: ductSummary }));
  }
}

function resultBox(label, value, unit, formula = null) {
  const cls = "result" + (formula ? " tip-wrap" : "");
  const box = el("div", { class: cls }, [
    el("div", { class: "result-label" }, label),
    el("div", { class: "result-value" }, [
      value,
      unit ? el("span", { class: "unit-inline" }, unit) : null,
    ]),
  ]);
  if (formula) attachTip(box, formula);
  return box;
}

function heroBox(label, value, unit, formula = null, opts = {}) {
  const { primary = false, subtitle = "" } = opts;
  const cls = "hero-tile" + (primary ? " hero-primary" : "") + (formula ? " tip-wrap" : "");
  const children = [
    el("div", { class: "hero-label" }, label),
    el("div", { class: "hero-value" }, [
      value,
      unit ? el("span", { class: "hero-unit" }, unit) : null,
    ]),
  ];
  if (subtitle) children.push(el("div", { class: "hero-sub" }, subtitle));
  const box = el("div", { class: cls }, children);
  if (formula) attachTip(box, formula);
  return box;
}

function renderTip(f) {
  const tip = el("div", { class: "tip" });
  tip.appendChild(el("div", { class: "tip-row" }, [
    el("span", { class: "tip-row-label" }, "Formula"),
    el("span", { class: "tip-row-val" }, f.formula),
  ]));
  tip.appendChild(el("div", { class: "tip-row" }, [
    el("span", { class: "tip-row-label" }, "Calculation"),
    el("span", { class: "tip-row-val" }, f.calc),
  ]));
  tip.appendChild(el("div", { class: "tip-row tip-result" }, [
    el("span", { class: "tip-row-label" }, "Result"),
    el("span", { class: "tip-row-val" }, f.result),
  ]));
  if (f.note) tip.appendChild(el("div", { class: "tip-note" }, f.note));
  return tip;
}

/* ---- Tooltip positioning (position:fixed, escapes card overflow) ---- */

function attachTip(wrap, formula) {
  const tip = renderTip(formula);
  document.body.appendChild(tip);       // attach at body so no ancestor can clip
  let visible = false;
  const show = () => {
    if (visible) return;
    positionTip(wrap, tip);
    visible = true;
  };
  const hide = () => {
    if (!visible) return;
    tip.style.display = "none";
    visible = false;
  };
  wrap.addEventListener("mouseenter", show);
  wrap.addEventListener("mouseleave", hide);
  // Clean up on next full render (before every render we drop all body-attached tips)
  wrap._tipEl = tip;
}

function positionTip(wrap, tip) {
  tip.style.display = "block";
  tip.style.visibility = "hidden";
  tip.classList.remove("tip-above", "tip-below");

  const rect = wrap.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  const gap = 8;
  const pad = 8;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const spaceAbove = rect.top;
  const spaceBelow = vh - rect.bottom;
  const preferBelow = spaceBelow >= tipRect.height + gap || spaceBelow > spaceAbove;

  let top;
  if (preferBelow) {
    top = rect.bottom + gap;
    tip.classList.add("tip-below");
  } else {
    top = rect.top - tipRect.height - gap;
    tip.classList.add("tip-above");
  }

  let left = rect.left + rect.width / 2 - tipRect.width / 2;
  left = Math.max(pad, Math.min(left, vw - tipRect.width - pad));

  const wrapCenterX = rect.left + rect.width / 2;
  const arrowX = Math.max(16, Math.min(wrapCenterX - left, tipRect.width - 16));

  tip.style.top = top + "px";
  tip.style.left = left + "px";
  tip.style.setProperty("--arrow-x", arrowX + "px");
  tip.style.visibility = "visible";
}

// Remove any tips left over on document.body (they'd leak across re-renders)
function clearOrphanTips() {
  document.querySelectorAll("body > .tip").forEach((t) => t.remove());
}

/* ================================================================
   FORMULA STRINGS (with live values substituted)
   ================================================================ */

function thlFormulas(d, r) {
  const wh = num(d.wallHeight);
  const wf = d.sunExposure ? (WALL_MATERIAL_FACTORS[d.wallMaterial] || 0) : NO_SUN_FACTOR;
  const wfLabel = d.sunExposure ? `${d.wallMaterial}, sun exposed` : `No sun exposure`;
  const floorF = d.carpet ? CARPET_FACTOR : UNCARPETED_FACTOR;
  const ceilF  = d.ceilingInsulation ? CEILING_INSULATED_FACTOR : CEILING_UNINSULATED_FACTOR;
  const actF   = ACTIVITY_FACTORS[d.activity] || 0;
  const rA = num(d.roomArea);
  const oP = num(d.outdoorPerimeter);
  const iP = num(d.indoorPerimeter);

  return {
    outdoorWalls: {
      formula: `Q_ow = (P_out × H − A_win) × F_wall`,
      calc:    `= (${fmt(oP,2)} × ${fmt(wh,2)} − ${fmt(r.windowsArea,3)}) × ${wf}`,
      result:  `= ${fmt(r.outdoorWalls,2)} W`,
      note:    `F_wall = ${wf} W/m²  (${wfLabel})`,
    },
    floors: {
      formula: `Q_fl = A × F_floor`,
      calc:    `= ${fmt(rA,2)} × ${floorF}`,
      result:  `= ${fmt(r.floors,2)} W`,
      note:    `F_floor = ${floorF} W/m²  (${d.carpet ? "Carpeted" : "Uncarpeted"})`,
    },
    ceilings: {
      formula: `Q_ce = A × F_ceiling`,
      calc:    `= ${fmt(rA,2)} × ${ceilF}`,
      result:  `= ${fmt(r.ceilings,2)} W`,
      note:    `F_ceiling = ${ceilF} W/m²  (${d.ceilingInsulation ? "Insulated" : "Uninsulated"})`,
    },
    indoorWalls: {
      formula: `Q_iw = (P_in × H − A_doors) × 8`,
      calc:    `= (${fmt(iP,2)} × ${fmt(wh,2)} − ${fmt(r.doorsArea,3)}) × ${INDOOR_WALL_FACTOR}`,
      result:  `= ${fmt(r.indoorWalls,2)} W`,
      note:    `Indoor wall factor is a constant 8 W/m² (uniform)`,
    },
    people: {
      formula: `Q_p = n × F_activity`,
      calc:    `= ${num(d.peopleCount)} × ${actF}`,
      result:  `= ${fmt(r.people,2)} W`,
      note:    `F_activity = ${actF} W/person  (${d.activity})`,
    },
    appliances: {
      formula: `Q_a = direct input`,
      calc:    `= ${fmt(r.appliances,2)} W`,
      result:  `= ${fmt(r.appliances,2)} W`,
    },
    doors: {
      formula: `Q_d = A_doors × 50`,
      calc:    `= ${fmt(r.doorsArea,3)} × ${DOOR_FACTOR}`,
      result:  `= ${fmt(r.doorsLoad,2)} W`,
      note:    `Door factor is a constant 50 W/m²`,
    },
    windows: {
      formula: `Q_w = Σ (A_i × F_i)`,
      calc:    `= ${fmt(r.windowsLoad,2)} W`,
      result:  `= ${fmt(r.windowsLoad,2)} W`,
      note:    `F_i from direction × shading factor table (see Formulas)`,
    },
    sensible: {
      formula: `Q_sens = Q_ow + Q_fl + Q_ce + Q_iw + Q_p + Q_a + Q_d + Q_w`,
      calc:    `= ${fmt(r.outdoorWalls,1)} + ${fmt(r.floors,1)} + ${fmt(r.ceilings,1)} + ${fmt(r.indoorWalls,1)}\n  + ${fmt(r.people,1)} + ${fmt(r.appliances,1)} + ${fmt(r.doorsLoad,1)} + ${fmt(r.windowsLoad,1)}`,
      result:  `= ${fmt(r.sensibleW,2)} W`,
    },
    totalKW: {
      formula: `Q_total = 1.3 × Q_sens / 1000`,
      calc:    `= 1.3 × ${fmt(r.sensibleW,2)} / 1000`,
      result:  `= ${fmt(r.totalKW,4)} kW`,
      note:    `The ×1.3 factor accounts for latent load + safety margin`,
    },
    wattsPerM2: {
      formula: `Q/A = Q_total × 1000 / A`,
      calc:    `= ${fmt(r.totalKW,4)} × 1000 / ${fmt(rA,2)}`,
      result:  `= ${fmt(r.wattsPerM2,2)} W/m²`,
    },
  };
}

function pdFormulas(d, r) {
  const V = num(d.velocity);
  const W = num(d.ductWidth);
  const H = num(d.ductHeight);
  const rho = num(d.airDensity);
  const mu = num(d.dynamicViscosity);

  return {
    area: {
      formula: `A = W × H`,
      calc:    `= ${fmt(W,3)} × ${fmt(H,3)}`,
      result:  `= ${fmt(r.area,4)} m²`,
    },
    airflowM3s: {
      formula: `Q = V × A`,
      calc:    `= ${fmt(V,3)} × ${fmt(r.area,4)}`,
      result:  `= ${fmt(r.airflowM3s,4)} m³/s`,
    },
    airflowLs: {
      formula: `Q_L = Q × 1000`,
      calc:    `= ${fmt(r.airflowM3s,4)} × 1000`,
      result:  `= ${fmt(r.airflowLs,1)} L/s`,
    },
    roughness: {
      formula: `ε = Lookup(Material)`,
      calc:    `= Lookup("${d.material}")`,
      result:  `= ${fmt(r.roughness,4)} mm`,
      note:    `See Formulas for the full roughness table`,
    },
    hydraulicDiameter: {
      formula: `D_h = 2 · (W_mm · H_mm) / (W_mm + H_mm)`,
      calc:    `= 2 × (${fmt(W*1000,1)} × ${fmt(H*1000,1)}) / (${fmt(W*1000,1)} + ${fmt(H*1000,1)})`,
      result:  `= ${fmt(r.hydraulicDiameter,2)} mm`,
    },
    reynolds: {
      formula: `Re = (ρ · V · D_h) / μ`,
      calc:    `= (${fmt(rho,3)} × ${fmt(V,3)} × ${fmt(r.hydraulicDiameter/1000,4)}) / ${mu}`,
      result:  `= ${fmt(r.reynolds,0)}`,
      note:    `D_h converted to metres`,
    },
    firstFF: {
      formula: `F₁ = 0.11 × (ε/D_h + 68/Re)^0.25`,
      calc:    `= 0.11 × (${fmt(r.roughness,4)}/${fmt(r.hydraulicDiameter,2)} + 68/${fmt(r.reynolds,0)})^0.25`,
      result:  `= ${fmt(r.firstFF,5)}`,
      note:    `Altshul first-estimate friction factor`,
    },
    frictionFactor: {
      formula: `if F₁ < 0.018: f = F₁ × 0.85 + 0.0028\nelse:          f = F₁`,
      calc:    `F₁ = ${fmt(r.firstFF,5)}   →   ${r.firstFF < 0.018 ? "corrected" : "unchanged"}`,
      result:  `= ${fmt(r.frictionFactor,5)}`,
      note:    `Altshul-Tsal correction for smooth-flow region`,
    },
    paPerM: {
      formula: `ΔP/L = 1000 · f · ρ · V² / (2 · D_h)`,
      calc:    `= 1000 × ${fmt(r.frictionFactor,5)} × ${fmt(rho,3)} × ${fmt(V,3)}²\n  / (2 × ${fmt(r.hydraulicDiameter,2)})`,
      result:  `= ${fmt(r.paPerM,4)} Pa/m`,
    },
  };
}

/* ================================================================
   FORMULA REFERENCE MODAL
   ================================================================ */

function renderModal(kind) {
  const backdrop = el("div", {
    class: "modal-backdrop",
    onclick: (e) => {
      if (e.target === backdrop) { state.modalOpen = null; render(); }
    },
  });
  const modal = el("div", { class: "modal" });
  const header = el("div", { class: "modal-header" }, [
    el("h2", {}, kind === "THL" ? "Heat Load — Formula Reference" : "Pressure Drop — Formula Reference"),
    el("button", {
      class: "modal-close",
      onclick: () => { state.modalOpen = null; render(); },
    }, "×"),
  ]);
  const body = el("div", { class: "modal-body" });
  if (kind === "THL") body.innerHTML = thlReferenceHTML();
  else body.innerHTML = pdReferenceHTML();
  modal.appendChild(header);
  modal.appendChild(body);
  backdrop.appendChild(modal);
  return backdrop;
}

function thlReferenceHTML() {
  return `
    <h3>Symbols</h3>
    <div class="symbol-list">
      <span><b>A</b> — room floor area (m²)</span>
      <span><b>H</b> — wall height (m)</span>
      <span><b>P<sub>out</sub></b> — outdoor wall perimeter (m)</span>
      <span><b>P<sub>in</sub></b> — indoor wall perimeter (m)</span>
      <span><b>A<sub>win</sub></b> — total window area (m²)</span>
      <span><b>A<sub>doors</sub></b> — total door area (m²)</span>
      <span><b>n</b> — number of people</span>
      <span><b>Q</b> — heat load component (W)</span>
      <span><b>F</b> — heat load factor (W/m² or W/person)</span>
    </div>

    <h3>Outdoor walls</h3>
    <div class="formula">Q<sub>ow</sub> = (P<sub>out</sub> × H − A<sub>win</sub>) × F<sub>wall</sub></div>
    <table class="ref">
      <tr><th>Condition</th><th>F<sub>wall</sub> (W/m²)</th></tr>
      <tr><td>No sun exposure</td><td>15</td></tr>
      <tr><td>Sun exposed — Brick / Brick Veneer</td><td>35</td></tr>
      <tr><td>Sun exposed — Weatherboard / fibro</td><td>40</td></tr>
    </table>

    <h3>Floors</h3>
    <div class="formula">Q<sub>fl</sub> = A × F<sub>floor</sub></div>
    <table class="ref">
      <tr><th>Condition</th><th>F<sub>floor</sub> (W/m²)</th></tr>
      <tr><td>Carpeted</td><td>6</td></tr>
      <tr><td>Uncarpeted</td><td>12</td></tr>
    </table>

    <h3>Ceilings</h3>
    <div class="formula">Q<sub>ce</sub> = A × F<sub>ceiling</sub></div>
    <table class="ref">
      <tr><th>Condition</th><th>F<sub>ceiling</sub> (W/m²)</th></tr>
      <tr><td>Insulated</td><td>8</td></tr>
      <tr><td>Uninsulated</td><td>50</td></tr>
    </table>

    <h3>Indoor walls</h3>
    <div class="formula">Q<sub>iw</sub> = (P<sub>in</sub> × H − A<sub>doors</sub>) × 8</div>
    <p class="note">Indoor wall factor is a constant 8 W/m² (uniform).</p>

    <h3>People</h3>
    <div class="formula">Q<sub>p</sub> = n × F<sub>activity</sub></div>
    <table class="ref">
      <tr><th>Activity</th><th>F<sub>activity</sub> (W/person)</th></tr>
      <tr><td>Active (e.g. gym)</td><td>250</td></tr>
      <tr><td>Inactive (e.g. sitting)</td><td>120</td></tr>
    </table>

    <h3>Appliances</h3>
    <div class="formula">Q<sub>a</sub> = direct input (W)</div>

    <h3>Doors</h3>
    <div class="formula">Q<sub>d</sub> = A<sub>doors</sub> × 50</div>
    <p class="note">Door factor is a constant 50 W/m².</p>

    <h3>Windows</h3>
    <div class="formula">Q<sub>w</sub> = Σ (A<sub>i</sub> × F<sub>i</sub>(facing, shading))</div>
    <p class="note">Each window has its own factor F<sub>i</sub> from this table:</p>
    <table class="ref">
      <tr>
        <th>Facing</th>
        <th>Curtains / Blinds</th>
        <th>Awning + C/B</th>
        <th>None</th>
        <th>Fully shaded</th>
      </tr>
      <tr><td>N</td><td>210</td><td>110</td><td>300</td><td>60</td></tr>
      <tr><td>NE</td><td>180</td><td>95</td><td>250</td><td>60</td></tr>
      <tr><td>E</td><td>95</td><td>65</td><td>120</td><td>60</td></tr>
      <tr><td>SE</td><td>95</td><td>65</td><td>120</td><td>60</td></tr>
      <tr><td>S</td><td>95</td><td>65</td><td>120</td><td>60</td></tr>
      <tr><td>SW</td><td>180</td><td>95</td><td>250</td><td>60</td></tr>
      <tr><td>W</td><td>130</td><td>60</td><td>370</td><td>60</td></tr>
      <tr><td>NW</td><td>300</td><td>145</td><td>430</td><td>60</td></tr>
    </table>
    <p class="note">All values in W/m² of window area.</p>

    <h3>Sensible cooling</h3>
    <div class="formula">Q<sub>sens</sub> = Q<sub>ow</sub> + Q<sub>fl</sub> + Q<sub>ce</sub> + Q<sub>iw</sub> + Q<sub>p</sub> + Q<sub>a</sub> + Q<sub>d</sub> + Q<sub>w</sub>   (W)</div>

    <h3>Total cooling</h3>
    <div class="formula">Q<sub>total</sub> = 1.3 × Q<sub>sens</sub> / 1000   (kW)</div>
    <p class="note">The ×1.3 factor accounts for latent load and a safety margin.</p>

    <h3>Watts per m²</h3>
    <div class="formula">Q / A = Q<sub>total</sub> × 1000 / A   (W/m²)</div>
  `;
}

function pdReferenceHTML() {
  return `
    <h3>Symbols</h3>
    <div class="symbol-list">
      <span><b>V</b> — air velocity (m/s)</span>
      <span><b>W, H</b> — duct width & height (m)</span>
      <span><b>A</b> — cross-section area (m²)</span>
      <span><b>Q</b> — volumetric flow rate (m³/s or L/s)</span>
      <span><b>D<sub>h</sub></b> — hydraulic diameter (mm)</span>
      <span><b>ρ</b> — air density (kg/m³)</span>
      <span><b>μ</b> — dynamic viscosity (kg/m·s)</span>
      <span><b>ε</b> — absolute roughness (mm)</span>
      <span><b>Re</b> — Reynolds number (—)</span>
      <span><b>f</b> — friction factor (—)</span>
      <span><b>ΔP/L</b> — pressure drop per length (Pa/m)</span>
    </div>

    <h3>Cross-section area</h3>
    <div class="formula">A = W × H</div>

    <h3>Airflow</h3>
    <div class="formula">Q = V × A          (m³/s)
Q<sub>L</sub> = Q × 1000     (L/s)</div>

    <h3>Hydraulic diameter (rectangular duct)</h3>
    <div class="formula">D<sub>h</sub> = 2 · (W<sub>mm</sub> · H<sub>mm</sub>) / (W<sub>mm</sub> + H<sub>mm</sub>)   (mm)</div>
    <p class="note">Width and height are converted to mm for D<sub>h</sub>.</p>

    <h3>Reynolds number</h3>
    <div class="formula">Re = (ρ · V · D<sub>h,m</sub>) / μ</div>
    <p class="note">D<sub>h,m</sub> = D<sub>h</sub> / 1000 (metres).</p>

    <h3>Friction factor — Altshul first estimate</h3>
    <div class="formula">F₁ = 0.11 · (ε / D<sub>h</sub> + 68 / Re)<sup>0.25</sup></div>

    <h3>Friction factor — Altshul-Tsal correction</h3>
    <div class="formula">If F₁ &lt; 0.018:  f = F₁ · 0.85 + 0.0028
Else:              f = F₁</div>

    <h3>Pressure drop per length</h3>
    <div class="formula">ΔP/L = 1000 · f · ρ · V² / (2 · D<sub>h</sub>)   (Pa/m)</div>

    <h3>Absolute roughness ε by material</h3>
    <table class="ref">
      <tr><th>Duct material</th><th>ε (mm)</th></tr>
      <tr><td>Galvanised Iron</td><td>0.15</td></tr>
      <tr><td>Drawn Brass</td><td>0.0015</td></tr>
      <tr><td>Drawn Copper</td><td>0.0015</td></tr>
      <tr><td>Commercial Steel</td><td>0.045</td></tr>
      <tr><td>Wrought Iron</td><td>0.045</td></tr>
      <tr><td>Asphalted Cast Iron</td><td>0.12</td></tr>
      <tr><td>Cast Iron</td><td>2.55</td></tr>
      <tr><td>Wood Stave</td><td>0.9</td></tr>
      <tr><td>Concrete</td><td>3</td></tr>
      <tr><td>Riveted Steel</td><td>9</td></tr>
    </table>

    <h3>Typical air properties</h3>
    <p class="note">ρ ≈ 1.2 kg/m³ and μ ≈ 1.81 × 10⁻⁵ kg/m·s at standard conditions (20 °C, 1 atm).</p>
  `;
}

/* ================================================================
   CENTERED MODAL PROMPT / ALERT (async, replaces window.prompt/alert)
   ================================================================ */

window.promptModal = function (message, defaultValue, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop modal-top";
    const modal = document.createElement("div");
    modal.className = "modal modal-prompt";

    const header = document.createElement("div");
    header.className = "modal-header";
    const h2 = document.createElement("h2");
    h2.textContent = opts.title || "Enter value";
    header.appendChild(h2);

    const body = document.createElement("div");
    body.className = "modal-body";
    const msg = document.createElement("div");
    msg.className = "prompt-msg";
    msg.textContent = message;
    body.appendChild(msg);

    const input = document.createElement("input");
    input.className = "prompt-input";
    input.type = opts.type || "number";
    input.step = "any";
    if (defaultValue !== undefined && defaultValue !== null && defaultValue !== "")
      input.value = String(defaultValue);
    if (opts.placeholder) input.placeholder = opts.placeholder;
    body.appendChild(input);

    if (opts.hint) {
      const hint = document.createElement("div");
      hint.className = "prompt-hint";
      hint.textContent = opts.hint;
      body.appendChild(hint);
    }

    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const cancel = document.createElement("button");
    cancel.className = "btn-secondary";
    cancel.textContent = opts.cancelLabel || "Cancel";
    const ok = document.createElement("button");
    ok.className = "btn-primary";
    ok.textContent = opts.okLabel || "OK";
    footer.appendChild(cancel);
    footer.appendChild(ok);
    body.appendChild(footer);

    modal.appendChild(header);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);

    setTimeout(() => { input.focus(); input.select(); }, 0);

    const finish = (val) => {
      window.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(input.value); }
      else if (e.key === "Escape") { e.preventDefault(); finish(null); }
    };
    window.addEventListener("keydown", onKey);
    ok.addEventListener("click", () => finish(input.value));
    cancel.addEventListener("click", () => finish(null));
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) finish(null); });
  });
};

window.confirmModal = function (message, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop modal-top";
    const modal = document.createElement("div");
    modal.className = "modal modal-prompt";

    const header = document.createElement("div");
    header.className = "modal-header";
    const h2 = document.createElement("h2");
    h2.textContent = opts.title || "Confirm";
    header.appendChild(h2);

    const body = document.createElement("div");
    body.className = "modal-body";
    const msg = document.createElement("div");
    msg.className = "prompt-msg";
    msg.textContent = message;
    body.appendChild(msg);

    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const cancel = document.createElement("button");
    cancel.className = "btn-secondary";
    cancel.textContent = opts.cancelLabel || "Cancel";
    const ok = document.createElement("button");
    ok.className = "btn-primary";
    if (opts.danger) ok.style.background = "var(--danger)";
    ok.textContent = opts.okLabel || "OK";
    footer.appendChild(cancel);
    footer.appendChild(ok);
    body.appendChild(footer);

    modal.appendChild(header);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    setTimeout(() => ok.focus(), 0);

    const finish = (val) => {
      window.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      else if (e.key === "Escape") { e.preventDefault(); finish(false); }
    };
    window.addEventListener("keydown", onKey);
    ok.addEventListener("click", () => finish(true));
    cancel.addEventListener("click", () => finish(false));
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) finish(false); });
  });
};

/* ================================================================
   EXPORT — WYSIWYG PDF via html2canvas + jsPDF
   ================================================================ */

async function exportPDF(session) {
  if (!window.html2canvas || !window.jspdf) {
    await window.alertModal("PDF export library missing (vendor/pdf/).", { title: "Export failed" });
    return;
  }
  // Kill any hover popovers before capture so they don't end up in the PDF
  cleanTransientTooltips();

  // Target: the page content of the current view (the .page div under root)
  const pageEl = document.querySelector(".page");
  if (!pageEl) return;

  // Show a small "generating" overlay so the user knows something is happening
  const overlay = document.createElement("div");
  overlay.className = "export-overlay";
  overlay.textContent = "Generating PDF…";
  document.body.appendChild(overlay);

  try {
    const captureW = Math.max(pageEl.scrollWidth, 1600);
    const canvas = await window.html2canvas(pageEl, {
      backgroundColor: "#ffffff",
      scale: 2,                 // hi-res
      useCORS: true,
      logging: false,
      windowWidth: captureW,
      width: captureW,
      height: pageEl.scrollHeight,
      onclone: (doc) => {
        // Strip transient popovers / overlays
        doc.querySelectorAll(".info-tip, .tip, .mouse-toolbox, .modal-backdrop").forEach(n => n.remove());
        // Replace form controls with styled text spans — html2canvas clips text inside inputs.
        replaceFormControlsForExport(doc);
      },
    });

    const { jsPDF } = window.jspdf;
    // Preserve the aspect ratio of what was captured; give it a generous page
    // size so the content isn't squished. Cap the longer side at ~1600pt.
    const imgW = canvas.width;
    const imgH = canvas.height;
    const maxPt = 1600;
    const shrink = Math.min(1, maxPt / Math.max(imgW, imgH));
    const pdfW = Math.round(imgW * shrink);
    const pdfH = Math.round(imgH * shrink);
    const orientation = pdfW >= pdfH ? "landscape" : "portrait";
    const pdf = new jsPDF({ orientation, unit: "pt", format: [pdfW, pdfH] });
    const imgData = canvas.toDataURL("image/jpeg", 0.92);
    pdf.addImage(imgData, "JPEG", 0, 0, pdfW, pdfH);

    const baseName = sessionLabel(session).replace(/[\/\\?%*:|"<>]/g, "-");
    pdf.save(baseName + ".pdf");
  } catch (err) {
    console.error(err);
    await window.alertModal("Failed to generate PDF: " + err.message, { title: "Export failed" });
  } finally {
    overlay.remove();
  }
}

function cleanTransientTooltips() {
  document.querySelectorAll(".info-tip").forEach(n => n.remove());
  document.querySelectorAll(".tip").forEach(n => n.remove());   // takeoff formula tips
  const tb = document.getElementById("mouse-toolbox");
  if (tb) tb.remove();
}

// Swap inputs/selects/checkboxes for text spans so html2canvas renders values correctly.
// Runs only on the cloned document that html2canvas rasterises — the live page is untouched.
function replaceFormControlsForExport(doc) {
  doc.querySelectorAll("input[type='number'], input[type='text']").forEach(inp => {
    const span = doc.createElement("span");
    span.className = (inp.className ? inp.className + " " : "") + "export-static-input";
    const val = inp.value !== "" ? inp.value : (inp.placeholder || "");
    span.textContent = val;
    // Copy geometry / borders from the live input so the box shape matches
    const cs = doc.defaultView.getComputedStyle(inp);
    span.style.display     = "inline-block";
    span.style.boxSizing   = "border-box";
    span.style.width       = cs.width;
    span.style.height      = cs.height;
    span.style.lineHeight  = cs.height;                   // vertically centre the text
    span.style.padding     = "0 " + cs.paddingRight;      // horizontal padding only
    span.style.border      = cs.border;
    span.style.borderRadius = cs.borderRadius;
    span.style.background  = cs.backgroundColor;
    span.style.color       = cs.color;
    span.style.fontSize    = cs.fontSize;
    span.style.fontFamily  = cs.fontFamily;
    span.style.fontWeight  = cs.fontWeight;
    span.style.overflow    = "hidden";
    span.style.whiteSpace  = "nowrap";
    span.style.textAlign   = "left";
    inp.parentNode.replaceChild(span, inp);
  });
  doc.querySelectorAll("select").forEach(sel => {
    const opt = sel.options[sel.selectedIndex];
    const span = doc.createElement("span");
    span.className = (sel.className ? sel.className + " " : "") + "export-static-select";
    span.textContent = opt ? opt.text : "";
    const cs = doc.defaultView.getComputedStyle(sel);
    span.style.display     = "inline-block";
    span.style.boxSizing   = "border-box";
    span.style.width       = cs.width;
    span.style.height      = cs.height;
    span.style.lineHeight  = cs.height;
    span.style.padding     = "0 " + cs.paddingRight;
    span.style.border      = cs.border;
    span.style.borderRadius = cs.borderRadius;
    span.style.background  = cs.backgroundColor;
    span.style.color       = cs.color;
    span.style.fontSize    = cs.fontSize;
    span.style.fontFamily  = cs.fontFamily;
    span.style.fontWeight  = cs.fontWeight;
    span.style.overflow    = "hidden";
    span.style.whiteSpace  = "nowrap";
    sel.parentNode.replaceChild(span, sel);
  });
  doc.querySelectorAll("input[type='checkbox']").forEach(cb => {
    const span = doc.createElement("span");
    span.textContent = cb.checked ? "☑" : "☐";
    span.style.display = "inline-block";
    span.style.width = "16px";
    span.style.height = "16px";
    span.style.fontSize = "16px";
    span.style.lineHeight = "16px";
    span.style.textAlign = "center";
    span.style.color = cb.checked ? "var(--accent)" : "#888";
    cb.parentNode.replaceChild(span, cb);
  });
}

// Choose from a list of buttons — resolves with the selected button's `value`, or null on Esc/backdrop-click
window.chooseModal = function (message, options, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop modal-top";
    const modal = document.createElement("div");
    modal.className = "modal modal-prompt";
    const header = document.createElement("div");
    header.className = "modal-header";
    const h2 = document.createElement("h2");
    h2.textContent = opts.title || "Choose";
    header.appendChild(h2);
    const body = document.createElement("div");
    body.className = "modal-body";
    const msg = document.createElement("div");
    msg.className = "prompt-msg";
    msg.textContent = message;
    body.appendChild(msg);
    const footer = document.createElement("div");
    footer.className = "modal-footer";
    footer.style.flexWrap = "wrap";
    options.forEach((opt, i) => {
      const b = document.createElement("button");
      b.className = opt.primary ? "btn-primary" : "btn-secondary";
      b.textContent = opt.label;
      b.onclick = () => finish(opt.value);
      footer.appendChild(b);
    });
    body.appendChild(footer);
    modal.appendChild(header);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    setTimeout(() => {
      const primary = footer.querySelector(".btn-primary") || footer.firstChild;
      if (primary) primary.focus();
    }, 0);
    const finish = (v) => {
      window.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve(v);
    };
    const onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); finish(null); } };
    window.addEventListener("keydown", onKey);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) finish(null); });
  });
};

window.alertModal = function (message, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop modal-top";
    const modal = document.createElement("div");
    modal.className = "modal modal-prompt";

    const header = document.createElement("div");
    header.className = "modal-header";
    const h2 = document.createElement("h2");
    h2.textContent = opts.title || "Info";
    header.appendChild(h2);

    const body = document.createElement("div");
    body.className = "modal-body";
    const msg = document.createElement("div");
    msg.className = "prompt-msg";
    msg.textContent = message;
    body.appendChild(msg);

    const footer = document.createElement("div");
    footer.className = "modal-footer";
    const ok = document.createElement("button");
    ok.className = "btn-primary";
    ok.textContent = opts.okLabel || "OK";
    footer.appendChild(ok);
    body.appendChild(footer);

    modal.appendChild(header);
    modal.appendChild(body);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    setTimeout(() => ok.focus(), 0);

    const finish = () => {
      window.removeEventListener("keydown", onKey);
      backdrop.remove();
      resolve();
    };
    const onKey = (e) => {
      if (e.key === "Enter" || e.key === "Escape") { e.preventDefault(); finish(); }
    };
    window.addEventListener("keydown", onKey);
    ok.addEventListener("click", finish);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) finish(); });
  });
};

/* ================================================================
   ADMIN PANEL — user management (create / edit / disable / delete)
   Only reachable when window.authGate.isAdmin is true.
   ================================================================ */

function renderAdminPanel() {
  const page = el("div", { class: "page admin-page" });
  page.appendChild(el("div", { class: "page-header" }, [
    el("div", { class: "page-title" }, "⚙ Admin — Users"),
    el("button", {
      class: "btn-primary admin-add-btn",
      onclick: () => openAddUserModal(),
    }, "+ Add user"),
  ]));

  const card = el("div", { class: "card admin-users-card" }, [
    el("div", { class: "card-header" }, "All users"),
    el("div", { class: "card-body", id: "admin-users-body" }, [
      el("div", { class: "admin-loading" }, "Loading users…"),
    ]),
  ]);
  page.appendChild(card);

  // Fetch async and populate
  fetchAllUsers().then(users => {
    const body = card.querySelector("#admin-users-body");
    body.innerHTML = "";
    body.appendChild(renderUsersTable(users));
  }).catch(err => {
    const body = card.querySelector("#admin-users-body");
    body.innerHTML = "";
    body.appendChild(el("div", { class: "admin-error" },
      "Failed to load users: " + (err.message || err.code)));
  });

  return page;
}

async function fetchAllUsers() {
  const db = window.authGate.fbDb();
  const snap = await db.collection("users").get();
  const users = snap.docs.map(d => Object.assign({ uid: d.id }, d.data()));
  // Sort: admins first, then by username
  users.sort((a, b) => {
    if ((a.role === "admin") !== (b.role === "admin")) return a.role === "admin" ? -1 : 1;
    return (a.username || "").localeCompare(b.username || "");
  });
  return users;
}

function renderUsersTable(users) {
  const tbl = el("table", { class: "admin-tbl" });
  tbl.appendChild(el("thead", {}, [
    el("tr", {}, [
      el("th", {}, "Username"),
      el("th", {}, "Name"),
      el("th", {}, "Role"),
      el("th", {}, "Status"),
      el("th", {}, "Password"),
      el("th", {}, "Actions"),
    ]),
  ]));
  const tbody = el("tbody");
  if (users.length === 0) {
    tbody.appendChild(el("tr", {}, [
      el("td", { colspan: "6", style: "text-align:center;padding:24px;color:var(--text-muted);" },
        "No users yet — click ‘+ Add user’."),
    ]));
  } else {
    users.forEach(u => tbody.appendChild(renderAdminUserRow(u)));
  }
  tbl.appendChild(tbody);
  return tbl;
}

function renderAdminUserRow(u) {
  const me = window.authGate.currentUser;
  const isSelf = u.uid === me.uid;
  const row = el("tr", { class: u.active ? "" : "admin-tr-inactive" });
  row.appendChild(el("td", { class: "admin-td-username" }, u.username || "—"));
  row.appendChild(el("td", {}, u.name || "—"));
  row.appendChild(el("td", {}, el("span",
    { class: "admin-role-pill role-" + (u.role || "user") },
    u.role || "user")));
  row.appendChild(el("td", {}, u.active
    ? el("span", { class: "admin-status admin-status-active" }, "Active")
    : el("span", { class: "admin-status admin-status-revoked" }, "Revoked")));
  row.appendChild(el("td", {}, u.mustChangePassword
    ? el("span", { class: "admin-pw-flag" }, "temp (must change)")
    : el("span", { style: "color:var(--text-muted);" }, "set by user")));

  const actions = el("div", { class: "admin-actions" });
  if (isSelf) {
    actions.appendChild(el("span", { class: "admin-self" }, "(you)"));
  } else {
    actions.appendChild(el("button", {
      class: "admin-btn",
      onclick: () => openEditUserModal(u),
    }, "Edit"));
    if (u.active) {
      actions.appendChild(el("button", {
        class: "admin-btn admin-btn-warn",
        onclick: () => disableUser(u),
      }, "Disable"));
    } else {
      actions.appendChild(el("button", {
        class: "admin-btn admin-btn-ok",
        onclick: () => enableUser(u),
      }, "Enable"));
    }
    actions.appendChild(el("button", {
      class: "admin-btn admin-btn-danger",
      onclick: () => deleteUser(u),
    }, "Delete"));
  }
  row.appendChild(el("td", {}, actions));
  return row;
}

/* ---- Actions ---- */

async function disableUser(u) {
  const yes = await window.confirmModal(
    `Revoke access for "${u.username}"?\n\nThey'll be signed out on their next request and shown the "Access revoked" screen.`,
    { title: "Disable user", danger: true, okLabel: "Disable" });
  if (!yes) return;
  try {
    await window.authGate.fbDb().collection("users").doc(u.uid).update({
      active: false,
      revokedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    render();
  } catch (e) {
    await window.alertModal("Failed: " + (e.message || e.code), { title: "Disable failed" });
  }
}

async function enableUser(u) {
  try {
    await window.authGate.fbDb().collection("users").doc(u.uid).update({
      active: true,
      revokedAt: null,
    });
    render();
  } catch (e) {
    await window.alertModal("Failed: " + (e.message || e.code), { title: "Enable failed" });
  }
}

async function deleteUser(u) {
  const yes = await window.confirmModal(
    `Delete "${u.username}" from the tool?\n\n` +
    `This removes their profile from HL + PD. Their Firebase Auth login stays until you also remove it in the Firebase console (Authentication → Users → delete).`,
    { title: "Delete user", danger: true, okLabel: "Delete" });
  if (!yes) return;
  try {
    await window.authGate.fbDb().collection("users").doc(u.uid).delete();
    render();
  } catch (e) {
    await window.alertModal("Failed: " + (e.message || e.code), { title: "Delete failed" });
  }
}

/* ---- Add / Edit modals ---- */

function openAddUserModal() {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop modal-top";
  const modal = document.createElement("div");
  modal.className = "modal modal-prompt";
  modal.style.maxWidth = "460px";

  modal.innerHTML = `
    <div class="modal-header"><h2>+ Add user</h2></div>
    <div class="modal-body">
      <div class="prompt-msg">Create a new account. A temporary password will be generated and shown to you — you share it with the user, they change it on first login.</div>
      <div class="rprops-grid">
        <label class="rprops-lbl">Username</label>
        <input class="rprops-input" id="adm-username" type="text" autofocus placeholder="e.g. AB, jsmith">
        <label class="rprops-lbl">Full name</label>
        <input class="rprops-input" id="adm-name" type="text" placeholder="Shown in the tool">
        <label class="rprops-lbl">Role</label>
        <select class="rprops-input" id="adm-role">
          <option value="user" selected>User</option>
          <option value="admin">Admin</option>
        </select>
      </div>
      <div class="auth-error" id="adm-err"></div>
      <div class="modal-footer">
        <button class="btn-secondary" id="adm-cancel">Cancel</button>
        <button class="btn-primary" id="adm-create">Create user</button>
      </div>
    </div>`;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);

  const usernameInp = modal.querySelector("#adm-username");
  const nameInp = modal.querySelector("#adm-name");
  const roleInp = modal.querySelector("#adm-role");
  const errEl = modal.querySelector("#adm-err");
  const createBtn = modal.querySelector("#adm-create");
  setTimeout(() => usernameInp.focus(), 0);

  const close = () => { backdrop.remove(); window.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  window.addEventListener("keydown", onKey);
  modal.querySelector("#adm-cancel").onclick = close;
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });

  createBtn.onclick = async () => {
    const username = usernameInp.value.trim();
    const name = nameInp.value.trim();
    const role = roleInp.value;
    errEl.textContent = "";
    if (!username || !name) { errEl.textContent = "Both username and full name are required."; return; }
    if (username.toUpperCase() === "FO") { errEl.textContent = "'FO' is reserved for the bootstrap admin."; return; }
    if (!/^[A-Za-z0-9._-]+$/.test(username)) { errEl.textContent = "Username can only contain letters, digits, . _ -"; return; }
    createBtn.disabled = true; createBtn.textContent = "Creating…";
    try {
      const result = await createUserAsAdmin(username, name, role);
      close();
      showTempPasswordModal(result.username, result.tempPassword);
      render();
    } catch (e) {
      const code = e && e.code;
      errEl.textContent = code === "auth/email-already-in-use"
        ? `Username "${username}" is already taken.`
        : ((e && e.message) || "Failed to create user.");
      createBtn.disabled = false; createBtn.textContent = "Create user";
    }
  };
}

async function createUserAsAdmin(username, name, role) {
  const helpers = window.authGate.helpers;
  const cfg = helpers.firebaseConfig();
  const email = helpers.emailFor(username);
  const tempPw = generateTempPassword();
  const hashedPw = await helpers.firebasePasswordFor(tempPw);

  // Secondary Firebase app so admin's own session is not signed out.
  const tempApp = firebase.initializeApp(cfg, "userCreator-" + Date.now());
  try {
    const tempAuth = tempApp.auth();
    const cred = await tempAuth.createUserWithEmailAndPassword(email, hashedPw);
    const newUid = cred.user.uid;
    await tempAuth.signOut();

    // Write the profile doc using admin's main auth
    const db = window.authGate.fbDb();
    await db.collection("users").doc(newUid).set({
      email, username, name,
      role: role === "admin" ? "admin" : "user",
      active: true,
      mustChangePassword: true,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdBy: (window.authGate.currentUser && window.authGate.currentUser.username) || "unknown",
    });
    return { username, tempPassword: tempPw };
  } finally {
    try { await tempApp.delete(); } catch (e) {}
  }
}

function generateTempPassword() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 10; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}

function showTempPasswordModal(username, tempPassword) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop modal-top";
  const modal = document.createElement("div");
  modal.className = "modal modal-prompt";
  modal.style.maxWidth = "460px";
  modal.innerHTML = `
    <div class="modal-header"><h2>✓ User created</h2></div>
    <div class="modal-body">
      <div class="prompt-msg">Share these credentials with the user via a secure channel. This is the <b>only</b> time the temp password will be shown.</div>
      <div class="temp-creds">
        <div class="temp-cred-row"><span class="temp-cred-lbl">Username</span><code>${escapeHTML(username)}</code></div>
        <div class="temp-cred-row"><span class="temp-cred-lbl">Temp password</span><code>${escapeHTML(tempPassword)}</code></div>
      </div>
      <div class="prompt-msg" style="margin-top:10px;font-size:12px;color:var(--text-muted);">They'll be forced to change the password on first login.</div>
      <div class="modal-footer">
        <button class="btn-secondary" id="tc-copy">📋 Copy</button>
        <button class="btn-primary" id="tc-done">Done</button>
      </div>
    </div>`;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  setTimeout(() => modal.querySelector("#tc-done").focus(), 0);
  const close = () => { backdrop.remove(); window.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape" || e.key === "Enter") close(); };
  window.addEventListener("keydown", onKey);
  modal.querySelector("#tc-done").onclick = close;
  const copyBtn = modal.querySelector("#tc-copy");
  copyBtn.onclick = async () => {
    const text =
      `HL + PD Calculator\n` +
      `Sign in at: ${location.origin || "the site"}\n` +
      `Username: ${username}\n` +
      `Temp password: ${tempPassword}\n` +
      `(You'll be asked to change the password on first login.)`;
    try {
      await navigator.clipboard.writeText(text);
      copyBtn.textContent = "Copied ✓";
      setTimeout(() => { copyBtn.textContent = "📋 Copy"; }, 1500);
    } catch (e) { copyBtn.textContent = "Copy failed"; }
  };
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
}

function openEditUserModal(u) {
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop modal-top";
  const modal = document.createElement("div");
  modal.className = "modal modal-prompt";
  modal.style.maxWidth = "440px";
  modal.innerHTML = `
    <div class="modal-header"><h2>Edit user: ${escapeHTML(u.username)}</h2></div>
    <div class="modal-body">
      <div class="rprops-grid">
        <label class="rprops-lbl">Full name</label>
        <input class="rprops-input" id="eu-name" type="text" value="${escapeHTML(u.name || "")}" autofocus>
        <label class="rprops-lbl">Role</label>
        <select class="rprops-input" id="eu-role">
          <option value="user" ${u.role !== "admin" ? "selected" : ""}>User</option>
          <option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option>
        </select>
      </div>
      <div class="auth-error" id="eu-err"></div>
      <div class="modal-footer">
        <button class="btn-secondary" id="eu-cancel">Cancel</button>
        <button class="btn-primary" id="eu-save">Save</button>
      </div>
    </div>`;
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  setTimeout(() => modal.querySelector("#eu-name").focus(), 0);
  const close = () => { backdrop.remove(); window.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  window.addEventListener("keydown", onKey);
  modal.querySelector("#eu-cancel").onclick = close;
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) close(); });
  modal.querySelector("#eu-save").onclick = async () => {
    const name = modal.querySelector("#eu-name").value.trim();
    const role = modal.querySelector("#eu-role").value;
    if (!name) { modal.querySelector("#eu-err").textContent = "Name is required."; return; }
    try {
      await window.authGate.fbDb().collection("users").doc(u.uid).update({
        name, role: role === "admin" ? "admin" : "user",
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      close();
      render();
    } catch (e) {
      modal.querySelector("#eu-err").textContent = (e.message || e.code || "Failed to save.");
    }
  };
}

/* ================================================================
   BOOT
   ================================================================ */

// The auth gate calls this once the user is signed in AND approved.
// (If auth.js is missing / Firebase isn't configured, we fall back to
// rendering immediately so the tool still works standalone.)
window.startApp = render;
if (!window.authGate) {
  // No auth gate — go straight in (dev / standalone mode)
  render();
}
