// =======================================================================
// Photobooth wizard: Layout -> Templates -> Photos -> Order -> Preview.
//
// The photo paper is a fixed 10cm x 14.8cm sheet. Layout picks whether
// the sheet holds one 10x14.8cm design or two 5x14.8cm strips side by
// side. Everything downstream (which templates are offered, how many
// photos are needed, how the final sheet is built) derives from that.
//
// `wizard` holds the whole in-progress job. Each step's render function
// derives its UI purely from `wizard` + `templates`, so navigating back
// and re-advancing always shows consistent state — there's no separate
// "is this step stale" bookkeeping.
// =======================================================================

let templates = [];           // all templates known to the app

let wizard = {
  layout: null,                // 'single' | 'double'
  mirror: true,                 // double only: same template on both sides?
  duplicatePhotos: false,       // double + mirror only: same photos on both sides too
  templateLeft: null,           // the template (also used alone for 'single')
  templateRight: null,          // double + !mirror only
  photoPool: [],                 // [{ img, path, name }] gathered in the Photos step
  order: [],                     // photoPool indices, length === total slots, slot order
  adjustments: []                // [{zoom,panX,panY} | undefined], index-aligned with `order`
};

const STEP_ORDER = ['layout', 'templates', 'photos', 'order', 'preview'];
let currentStep = 'layout';
let maxReachedIndex = 0;

// ---------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------
function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// `bustCache` appends a unique query string so Chromium re-reads a file
// that changed on disk (e.g. border.png after alpha holes are punched
// into it) instead of serving a stale decoded copy from memory cache.
function loadImageFromPath(path, bustCache = false) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `file://${path}` + (bustCache ? `?t=${Date.now()}` : '');
  });
}

// Electron's renderer doesn't implement window.prompt() (it throws), so we
// use a small <dialog> instead. Resolves to the entered string, or
// undefined if the operator cancels / leaves it blank.
function askName(labelText) {
  return new Promise((resolve) => {
    const dlg = document.getElementById('nameDialog');
    const input = document.getElementById('nameInput');
    document.getElementById('nameDialogLabel').textContent = labelText;
    input.value = '';
    dlg.addEventListener('close', () => {
      const name = dlg.returnValue === 'ok' && input.value.trim() ? input.value.trim() : undefined;
      resolve(name);
    }, { once: true });
    dlg.showModal();
  });
}

// ---------------------------------------------------------------------
// Derived wizard state
// ---------------------------------------------------------------------
function templatesStepValid() {
  if (wizard.layout === 'single') return !!wizard.templateLeft;
  if (wizard.layout === 'double') {
    return wizard.mirror ? !!wizard.templateLeft : !!(wizard.templateLeft && wizard.templateRight);
  }
  return false;
}

// The template used on each side, in left-to-right order. One entry for
// a single sheet, two for a double (the same template twice if mirrored).
function activeTemplates() {
  if (!templatesStepValid()) return [];
  if (wizard.layout === 'single') return [wizard.templateLeft];
  return wizard.mirror ? [wizard.templateLeft, wizard.templateLeft] : [wizard.templateLeft, wizard.templateRight];
}

function totalSlotsNeeded() {
  return sideRanges().reduce((sum, r) => sum + r.count, 0);
}

// Where each side's slots start in the flattened photo order. Normally
// one entry per side. But for a double layout with "duplicate photos" on,
// both sides print the exact same photos with the exact same crop — so
// there's really only one set of slots to gather/order/edit; the sheet
// just draws that one composited strip into both halves at print time.
function sideRanges() {
  const tpls = activeTemplates();
  if (wizard.layout === 'double' && wizard.duplicatePhotos && tpls.length > 0) {
    return [{ template: tpls[0], start: 0, count: tpls[0].slots.length }];
  }
  const ranges = [];
  let start = 0;
  for (const t of tpls) {
    ranges.push({ template: t, start, count: t.slots.length });
    start += t.slots.length;
  }
  return ranges;
}

function resetWizard() {
  wizard = {
    layout: null, mirror: true, duplicatePhotos: false, templateLeft: null, templateRight: null,
    photoPool: [], order: [], adjustments: []
  };
  maxReachedIndex = 0;
  renderLayoutStep();
  goToStep('layout');
}

// ---------------------------------------------------------------------
// Wizard navigation
// ---------------------------------------------------------------------
function refreshTabsEnabled() {
  document.querySelectorAll('.tab').forEach((tab) => {
    const idx = STEP_ORDER.indexOf(tab.dataset.step);
    tab.disabled = idx > maxReachedIndex;
    tab.classList.toggle('active', tab.dataset.step === currentStep);
  });
}

async function goToStep(step) {
  // Guard against landing on Order/Preview with a stale photo count —
  // e.g. the operator jumped back to Templates via its tab, picked a
  // template with a different slot count, then jumped forward again
  // without redoing Photos.
  if ((step === 'order' || step === 'preview') && wizard.photoPool.length !== totalSlotsNeeded()) {
    alert('Your template selection changed — please re-check your photos.');
    step = 'photos';
  }

  currentStep = step;
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  document.getElementById(`step-${step}`).classList.add('active');
  refreshTabsEnabled();

  if (step === 'templates') renderTemplatesStep();
  else if (step === 'photos') renderPhotosStep();
  else if (step === 'order') renderOrderStep();
  else if (step === 'preview') await renderPreviewStep();
}

async function advanceTo(step) {
  const idx = STEP_ORDER.indexOf(step);
  if (idx > maxReachedIndex) maxReachedIndex = idx;
  await goToStep(step);
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    if (tab.disabled) return;
    goToStep(tab.dataset.step);
  });
});

document.getElementById('newOrderBtn').addEventListener('click', () => {
  if (!confirm('Start a new order? This clears the current photos and choices.')) return;
  resetWizard();
});

// =======================================================================
// Step 1: Layout — the only two physically-possible choices for this
// paper size.
// =======================================================================
function renderLayoutStep() {
  document.querySelectorAll('.layout-card').forEach((card) => {
    card.classList.toggle('selected', card.dataset.layout === wizard.layout);
  });
}

document.querySelectorAll('.layout-card').forEach((card) => {
  card.addEventListener('click', () => {
    const layout = card.dataset.layout;
    if (wizard.layout !== layout) {
      wizard.layout = layout;
      wizard.mirror = true;
      wizard.duplicatePhotos = false;
      wizard.templateLeft = null;
      wizard.templateRight = null;
      wizard.photoPool = [];
      wizard.order = [];
      wizard.adjustments = [];
      maxReachedIndex = 0;
    }
    renderLayoutStep();
    advanceTo('templates');
  });
});

async function refreshSavedJobs() {
  const jobs = await window.kiosk.strips.list();
  const grid = document.getElementById('savedStripGrid');
  grid.innerHTML = '';

  if (jobs.length === 0) {
    grid.innerHTML = '<p class="muted">No saved jobs yet. Finish a sheet and click "Save job" on the Preview step.</p>';
    return;
  }

  for (const job of jobs) {
    const n = job.photoPaths ? job.photoPaths.length : 0;
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <button class="card-delete" title="Delete this saved job">&times;</button>
      ${job.thumbnail ? `<img src="${job.thumbnail}" />` : ''}
      <p>${job.name}<br/><small>${job.layout === 'double' ? '2 prints' : '1 print'} &middot; ${n} photo${n === 1 ? '' : 's'} &middot; ${new Date(job.createdAt).toLocaleDateString()}</small></p>
    `;
    card.addEventListener('click', () => loadSavedJob(job));
    card.querySelector('.card-delete').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete saved job "${job.name}"?`)) return;
      await window.kiosk.strips.delete(job.id);
      await refreshSavedJobs();
    });
    grid.appendChild(card);
  }
}

async function loadSavedJob(rec) {
  if (!rec.templateIds || rec.templateIds.length === 0) {
    alert("This saved job is in an old format and can't be reopened. Delete it and create a new one.");
    return;
  }

  await refreshTemplatesList();
  const [leftId, rightId] = rec.templateIds;
  const tplLeft = templates.find(t => t.id === leftId);
  const tplRight = rec.layout === 'double' ? templates.find(t => t.id === rightId) : null;
  if (!tplLeft || (rec.layout === 'double' && !tplRight)) {
    alert('One of the templates this job used no longer exists.');
    return;
  }

  wizard.layout = rec.layout;
  wizard.templateLeft = tplLeft;
  wizard.templateRight = rec.layout === 'double' ? tplRight : null;
  wizard.mirror = rec.layout === 'double' && leftId === rightId;
  wizard.duplicatePhotos = rec.layout === 'double' && wizard.mirror && !!rec.duplicatePhotos;

  const needed = totalSlotsNeeded();
  if (rec.photoPaths.length !== needed) {
    alert(`This job has ${rec.photoPaths.length} photo(s) but its template(s) need ${needed} now.`);
    return;
  }

  let imgs;
  try {
    imgs = await Promise.all(rec.photoPaths.map(p => loadImageFromPath(p)));
  } catch {
    alert("One or more of this job's photo files couldn't be opened — they may have been moved or deleted.");
    return;
  }

  wizard.photoPool = rec.photoPaths.map((p, i) => ({ img: imgs[i], path: p, name: p.split(/[\\/]/).pop() }));
  wizard.order = wizard.photoPool.map((_, i) => i);
  wizard.adjustments = (rec.adjustments || []).map(a => a && { zoom: a.zoom, panX: a.panX, panY: a.panY });

  maxReachedIndex = STEP_ORDER.length - 1;
  renderLayoutStep();
  await advanceTo('preview');
}

// =======================================================================
// Step 2: Templates
// =======================================================================
async function refreshTemplatesList() {
  templates = await window.kiosk.templates.list();
}

function renderTemplatesStep() {
  const isSingle = wizard.layout === 'single';
  document.getElementById('templatesSingleWrap').hidden = !isSingle;
  document.getElementById('templatesDoubleWrap').hidden = isSingle;
  document.getElementById('templatesHeading').textContent = isSingle
    ? 'Choose a template (10cm × 14.8cm)'
    : 'Choose template(s) (5cm × 14.8cm each)';

  if (isSingle) {
    renderTemplatePickerGrid('templateGrid_single', 'full', wizard.templateLeft, (t) => {
      wizard.templateLeft = t;
      renderTemplatesStep();
    });
  } else {
    document.getElementById('mirrorTemplatesCheckbox').checked = wizard.mirror;
    document.getElementById('rightTemplateWrap').hidden = wizard.mirror;
    // Only makes sense with one shared template design.
    document.getElementById('duplicatePhotosRow').hidden = !wizard.mirror;
    document.getElementById('duplicatePhotosCheckbox').checked = wizard.duplicatePhotos;

    renderTemplatePickerGrid('templateGrid_left', 'half', wizard.templateLeft, (t) => {
      wizard.templateLeft = t;
      renderTemplatesStep();
    });
    if (!wizard.mirror) {
      renderTemplatePickerGrid('templateGrid_right', 'half', wizard.templateRight, (t) => {
        wizard.templateRight = t;
        renderTemplatesStep();
      });
    }
  }

  document.getElementById('templatesNextBtn').disabled = !templatesStepValid();
}

document.getElementById('mirrorTemplatesCheckbox').addEventListener('change', (e) => {
  wizard.mirror = e.target.checked;
  if (!wizard.mirror && !wizard.templateRight) wizard.templateRight = wizard.templateLeft;
  if (!wizard.mirror) wizard.duplicatePhotos = false; // no longer meaningful
  renderTemplatesStep();
});

document.getElementById('duplicatePhotosCheckbox').addEventListener('change', (e) => {
  wizard.duplicatePhotos = e.target.checked;
  // The required photo count changes immediately (doubles/halves), so
  // whatever was gathered for the old count is no longer valid.
  wizard.photoPool = [];
  wizard.order = [];
  wizard.adjustments = [];
  renderTemplatesStep();
});

function renderTemplatePickerGrid(containerId, printSize, selected, onPick) {
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  const list = templates.filter(t => t.printSize === printSize);
  const sizeLabel = printSize === 'full' ? '10×14.8cm' : '5×14.8cm';

  if (list.length === 0) {
    container.innerHTML = `<p class="muted">No ${sizeLabel} templates yet. Click "+ Upload Template" above (or flip an existing one's size below).</p>`;
    return;
  }

  const byCount = new Map();
  for (const t of list) {
    const n = t.slots.length;
    if (!byCount.has(n)) byCount.set(n, []);
    byCount.get(n).push(t);
  }

  for (const n of [...byCount.keys()].sort((a, b) => a - b)) {
    const heading = document.createElement('p');
    heading.className = 'template-group-heading';
    heading.textContent = `${n} photo slot${n === 1 ? '' : 's'}`;
    container.appendChild(heading);

    const grid = document.createElement('div');
    grid.className = 'template-grid';
    for (const t of byCount.get(n)) {
      grid.appendChild(makeTemplatePickCard(t, !!(selected && selected.id === t.id), onPick));
    }
    container.appendChild(grid);
  }
}

// A template card sizes itself to the template's own proportions (fixed
// thumbnail height, width follows the aspect ratio) instead of forcing
// every thumbnail into the same box — a 5x14.8cm strip and a 10x14.8cm
// sheet don't look alike, so they shouldn't be squeezed into one shape.
// Hovering shows a bigger preview (see showTemplateHoverPreview).
function makeTemplatePickCard(tpl, isSelected, onPick) {
  const card = document.createElement('div');
  card.className = 'template-card' + (isSelected ? ' selected' : '');
  card.innerHTML = `
    <button class="card-delete" title="Delete this template">&times;</button>
    <img src="file://${tpl.borderPath}?t=${Date.now()}" />
    <button class="link-btn flip-size-btn">Use as ${tpl.printSize === 'full' ? '5×14.8cm' : '10×14.8cm'}</button>
  `;
  card.addEventListener('click', () => onPick(tpl));
  card.addEventListener('mouseenter', () => showTemplateHoverPreview(tpl));
  card.addEventListener('mouseleave', hideTemplateHoverPreview);
  card.querySelector('.card-delete').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`Delete this template? This can't be undone.`)) return;
    await window.kiosk.templates.delete(tpl.id);
    if (wizard.templateLeft && wizard.templateLeft.id === tpl.id) wizard.templateLeft = null;
    if (wizard.templateRight && wizard.templateRight.id === tpl.id) wizard.templateRight = null;
    await refreshTemplatesList();
    renderTemplatesStep();
  });
  card.querySelector('.flip-size-btn').addEventListener('click', async (e) => {
    e.stopPropagation();
    await window.kiosk.templates.setPrintSize(tpl.id, tpl.printSize === 'full' ? 'half' : 'full');
    await refreshTemplatesList();
    renderTemplatesStep();
  });
  return card;
}

function showTemplateHoverPreview(tpl) {
  const pane = document.getElementById('templateHoverPreview');
  document.getElementById('templateHoverPreviewImg').src = `file://${tpl.borderPath}?t=${Date.now()}`;
  pane.hidden = false;
}
function hideTemplateHoverPreview() {
  document.getElementById('templateHoverPreview').hidden = true;
}

// Asks how many photo slots a just-picked template has. Pre-filled with a
// quick best-effort guess so the common case is just hitting OK. Resolves
// the entered count, or null if cancelled.
function askSlotCount(guess) {
  return new Promise((resolve) => {
    const dlg = document.getElementById('slotCountDialog');
    const input = document.getElementById('slotCountInput');
    input.value = String(Math.max(1, guess || 1));
    dlg.addEventListener('close', () => {
      if (dlg.returnValue !== 'ok') { resolve(null); return; }
      const n = parseInt(input.value, 10);
      resolve(Number.isFinite(n) && n > 0 ? n : null);
    }, { once: true });
    dlg.showModal();
  });
}

// Renders the detected slot guesses over the template image and lets the
// operator fix them by hand before accepting: drag a box to move it, drag
// a corner to resize it, click its × to delete it, or drag on empty space
// to draw a new one. Resolves true if they accept — `tpl.candidateSlots`
// is updated in place with whatever the operator ends up with.
// `note` is an extra line about how well auto-detection matched the
// count they asked for.
function confirmDetectedSlots(tpl, note) {
  return new Promise((resolve) => {
    const dlg = document.getElementById('confirmSlotsDialog');
    const canvas = document.getElementById('confirmSlotsCanvas');
    const msg = document.getElementById('confirmSlotsMsg');
    const status = document.getElementById('confirmSlotsCount');
    const resetBtn = document.getElementById('confirmSlotsResetBtn');
    const okBtn = document.getElementById('confirmSlotsOkBtn');

    const n0 = tpl.candidateSlots.length;
    msg.textContent =
      `Found ${n0} photo slot${n0 === 1 ? '' : 's'} in this template.` +
      (note ? ` ${note}` : '') +
      (tpl.mode === 'alpha'
        ? ' Accepting saves these slots.'
        : ' Accepting cuts transparent holes into the template at these spots so photos show through.');

    const original = tpl.candidateSlots.map(s => ({ ...s }));
    let slots = original.map(s => ({ ...s }));
    let selected = -1;

    let img = null;
    let scale = 1;
    let minSizeReal = 1;
    const HANDLE_PX = 8; // corner-handle hit radius, in canvas-rendered px
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const corners = (x, y, w, h) => [[x, y, 'nw'], [x + w, y, 'ne'], [x, y + h, 'sw'], [x + w, y + h, 'se']];

    function redraw() {
      if (!img) return;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      ctx.font = 'bold 16px system-ui, sans-serif';

      slots.forEach((s, i) => {
        const x = s.x * scale, y = s.y * scale, w = s.w * scale, h = s.h * scale;
        ctx.fillStyle = i === selected ? 'rgba(99, 102, 241, 0.30)' : 'rgba(34, 197, 94, 0.25)';
        ctx.fillRect(x, y, w, h);
        ctx.lineWidth = 2;
        ctx.setLineDash(s.extrapolated ? [8, 6] : []);
        ctx.strokeStyle = s.extrapolated ? '#f59e0b' : (i === selected ? '#6366f1' : '#22c55e');
        ctx.strokeRect(x, y, w, h);
        ctx.setLineDash([]);
        ctx.fillStyle = '#022c22';
        ctx.fillText(String(i + 1), x + 6, y + 20);

        ctx.fillStyle = '#f3f4f6';
        for (const [hx, hy] of corners(x, y, w, h)) ctx.fillRect(hx - 4, hy - 4, 8, 8);

        ctx.fillStyle = '#dc2626';
        ctx.fillRect(x + w - 18, y + 2, 16, 16);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.fillText('×', x + w - 14, y + 14);
        ctx.font = 'bold 16px system-ui, sans-serif';
      });

      if (drag && drag.mode === 'draw' && drag.current) {
        const x0 = Math.min(drag.startReal.x, drag.current.x) * scale;
        const y0 = Math.min(drag.startReal.y, drag.current.y) * scale;
        const w0 = Math.abs(drag.current.x - drag.startReal.x) * scale;
        const h0 = Math.abs(drag.current.y - drag.startReal.y) * scale;
        ctx.setLineDash([6, 4]);
        ctx.strokeStyle = '#f59e0b';
        ctx.strokeRect(x0, y0, w0, h0);
        ctx.setLineDash([]);
      }

      const anyExtrapolated = slots.some(s => s.extrapolated);
      status.textContent =
        `${slots.length} slot${slots.length === 1 ? '' : 's'} — drag to move, a corner to resize, ` +
        `× to delete, or drag empty space to add one.` +
        (anyExtrapolated ? ' Dashed boxes were predicted, not directly detected — check them.' : '');
      okBtn.disabled = slots.length === 0;
    }

    function canvasPoint(e) {
      const rect = canvas.getBoundingClientRect();
      return {
        x: (e.clientX - rect.left) / rect.width * canvas.width,
        y: (e.clientY - rect.top) / rect.height * canvas.height
      };
    }
    function hitDelete(p, s) {
      const x = s.x * scale, y = s.y * scale, w = s.w * scale;
      return p.x >= x + w - 18 && p.x <= x + w - 2 && p.y >= y + 2 && p.y <= y + 18;
    }
    function hitHandle(p, s) {
      const x = s.x * scale, y = s.y * scale, w = s.w * scale, h = s.h * scale;
      for (const [hx, hy, name] of corners(x, y, w, h)) {
        if (Math.abs(p.x - hx) <= HANDLE_PX && Math.abs(p.y - hy) <= HANDLE_PX) return name;
      }
      return null;
    }
    function hitBox(p, s) {
      const x = s.x * scale, y = s.y * scale, w = s.w * scale, h = s.h * scale;
      return p.x >= x && p.x <= x + w && p.y >= y && p.y <= y + h;
    }

    let drag = null; // { mode: 'move'|'resize'|'draw', index, handle, startReal, origBox, current }

    // This dialog/canvas is reused for every template upload — scope all
    // these listeners to this one invocation so they don't pile up (and
    // fire against stale closures) across repeated uploads.
    const controller = new AbortController();
    const { signal } = controller;

    canvas.addEventListener('mousedown', (e) => {
      if (!img) return;
      const p = canvasPoint(e);

      for (let i = slots.length - 1; i >= 0; i--) {
        if (hitDelete(p, slots[i])) {
          slots.splice(i, 1);
          if (selected === i) selected = -1;
          redraw();
          return;
        }
      }
      for (let i = slots.length - 1; i >= 0; i--) {
        const handle = hitHandle(p, slots[i]);
        if (handle) {
          selected = i;
          drag = { mode: 'resize', index: i, handle, startReal: { x: p.x / scale, y: p.y / scale }, origBox: { ...slots[i] } };
          redraw();
          return;
        }
      }
      for (let i = slots.length - 1; i >= 0; i--) {
        if (hitBox(p, slots[i])) {
          selected = i;
          drag = { mode: 'move', index: i, startReal: { x: p.x / scale, y: p.y / scale }, origBox: { ...slots[i] } };
          redraw();
          return;
        }
      }
      selected = -1;
      drag = { mode: 'draw', startReal: { x: p.x / scale, y: p.y / scale }, current: { x: p.x / scale, y: p.y / scale } };
      redraw();
    }, { signal });

    window.addEventListener('mousemove', (e) => {
      if (!drag || !img) return;
      const p = canvasPoint(e);
      const rx = clamp(p.x / scale, 0, img.width);
      const ry = clamp(p.y / scale, 0, img.height);

      if (drag.mode === 'move') {
        const s = slots[drag.index];
        const dx = rx - drag.startReal.x, dy = ry - drag.startReal.y;
        s.x = clamp(drag.origBox.x + dx, 0, img.width - s.w);
        s.y = clamp(drag.origBox.y + dy, 0, img.height - s.h);
        delete s.extrapolated;
      } else if (drag.mode === 'resize') {
        const s = slots[drag.index];
        const o = drag.origBox;
        let { x, y, w, h } = o;
        if (drag.handle.includes('w')) { const nx = clamp(rx, 0, o.x + o.w - minSizeReal); w = o.x + o.w - nx; x = nx; }
        if (drag.handle.includes('e')) { const nx2 = clamp(rx, o.x + minSizeReal, img.width); w = nx2 - o.x; }
        if (drag.handle.includes('n')) { const ny = clamp(ry, 0, o.y + o.h - minSizeReal); h = o.y + o.h - ny; y = ny; }
        if (drag.handle.includes('s')) { const ny2 = clamp(ry, o.y + minSizeReal, img.height); h = ny2 - o.y; }
        Object.assign(s, { x, y, w, h });
        delete s.extrapolated;
      } else if (drag.mode === 'draw') {
        drag.current = { x: rx, y: ry };
      }
      redraw();
    }, { signal });

    window.addEventListener('mouseup', () => {
      if (drag && drag.mode === 'draw') {
        const x = Math.min(drag.startReal.x, drag.current.x);
        const y = Math.min(drag.startReal.y, drag.current.y);
        const w = Math.abs(drag.current.x - drag.startReal.x);
        const h = Math.abs(drag.current.y - drag.startReal.y);
        if (w > minSizeReal && h > minSizeReal) {
          slots.push({ x, y, w, h });
          selected = slots.length - 1;
        }
      }
      drag = null;
      redraw();
    }, { signal });

    resetBtn.addEventListener('click', () => {
      slots = original.map(s => ({ ...s }));
      selected = -1;
      redraw();
    }, { signal });

    const loadImg = new Image();
    loadImg.onload = () => {
      img = loadImg;
      scale = Math.min(1, 520 / img.width);
      canvas.width = img.width * scale;
      canvas.height = img.height * scale;
      minSizeReal = 20 / scale;
      redraw();
    };
    loadImg.src = `file://${tpl.borderPath}`;

    dlg.addEventListener('close', () => {
      controller.abort(); // drop the mousedown/mousemove/mouseup/reset listeners above
      const accepted = dlg.returnValue === 'ok';
      if (accepted) {
        tpl.candidateSlots = slots.map(s => ({
          x: Math.round(s.x), y: Math.round(s.y), w: Math.round(s.w), h: Math.round(s.h),
          ...(s.extrapolated ? { extrapolated: true } : {})
        }));
      }
      resolve(accepted);
    }, { once: true });
    dlg.showModal();
  });
}

document.getElementById('addTemplateBtn').addEventListener('click', async () => {
  // No naming prompt — templates are picked by thumbnail, not by name.
  // main.js falls back to the source PNG's filename internally.
  const added = await window.kiosk.templates.add();
  if (!added) return; // user cancelled the file dialog

  const expectedCount = await askSlotCount(added.guessCount);
  if (expectedCount == null) {
    // Cancelled — nothing was ever finalized, so just discard the staged template.
    await window.kiosk.templates.delete(added.id);
    return;
  }

  const detected = await window.kiosk.templates.detectForCount(added.id, expectedCount);

  if (detected.slots.length === 0) {
    alert(
      `Couldn't find ${expectedCount} photo slot${expectedCount === 1 ? '' : 's'} in that PNG.\n` +
      'Either make the photo areas fully transparent (alpha = 0), or leave ' +
      'them as clean white shapes, then re-upload.'
    );
    await window.kiosk.templates.delete(added.id);
  } else {
    const note = detected.trimmed
      ? `Detection found more than ${expectedCount} — trusting your count and showing the ${detected.slots.length} most likely.`
      : detected.matched
        ? ''
        : `You said ${expectedCount}, but the closest match had ${detected.slots.length} — check carefully before accepting.`;
    const accepted = await confirmDetectedSlots(
      { ...added, candidateSlots: detected.slots, mode: detected.mode },
      note
    );
    if (accepted) {
      if (detected.mode === 'alpha') {
        // Already real transparent holes — nothing to punch.
        await window.kiosk.templates.setSlots(added.id, detected.slots);
      } else {
        // 'white' or 'flat': a solid-color placeholder, not a real hole —
        // cut one in at each slot, sampling that slot's own fill color.
        await window.kiosk.templates.punchSlots(added.id, detected.slots);
      }
    } else {
      await window.kiosk.templates.delete(added.id);
    }
  }

  await refreshTemplatesList();
  if (currentStep === 'templates') renderTemplatesStep();
});

document.getElementById('templatesBackBtn').addEventListener('click', () => goToStep('layout'));
document.getElementById('templatesNextBtn').addEventListener('click', () => advanceTo('photos'));

// =======================================================================
// Step 3: Photos — gather exactly as many photos as the chosen
// template(s) need, from the device and/or the Drive gallery, in any
// number of picks.
// =======================================================================
function renderPhotosStep() {
  const needed = totalSlotsNeeded();
  const count = wizard.photoPool.length;

  document.getElementById('photosNeededLabel').textContent = needed
    ? `This sheet needs exactly ${needed} photo${needed === 1 ? '' : 's'}.`
    : 'Choose your template(s) first.';

  const thumbs = document.getElementById('photoThumbs');
  thumbs.innerHTML = '';
  wizard.photoPool.forEach((p, i) => {
    const card = document.createElement('div');
    card.className = 'card';
    card.innerHTML = `
      <button class="card-delete" title="Remove">&times;</button>
      <img src="${p.img.src}" />
      <p><small>${p.name}</small></p>
    `;
    card.querySelector('.card-delete').addEventListener('click', () => {
      wizard.photoPool.splice(i, 1);
      renderPhotosStep();
    });
    thumbs.appendChild(card);
  });

  const status = document.getElementById('uploadStatus');
  if (!needed) status.textContent = '';
  else if (count < needed) status.textContent = `${count} of ${needed} — add ${needed - count} more.`;
  else if (count === needed) status.textContent = `${count} of ${needed} — ready.`;
  else status.textContent = `${count} of ${needed} — remove ${count - needed}.`;

  document.getElementById('clearUploadsBtn').disabled = count === 0;
  document.getElementById('photosNextBtn').disabled = needed === 0 || count !== needed;
}

document.getElementById('photoInput').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  e.target.value = ''; // let the same file be re-picked later
  for (const f of files) {
    try {
      // Electron exposes the real on-disk path on File objects from <input>.
      wizard.photoPool.push({ img: await fileToImage(f), path: f.path || null, name: f.name });
    } catch {
      /* skip an unreadable file */
    }
  }
  renderPhotosStep();
});

document.getElementById('clearUploadsBtn').addEventListener('click', () => {
  wizard.photoPool = [];
  renderPhotosStep();
});

// --- Photo gallery: photos sent from the phone camera page plus the
// (optional) Google Drive folder, in one inline panel. Click a photo to
// add/remove it from the pool — no separate screen or fixed selection
// order here; that happens in the Order step. ---
let galleryPhotos = [];
let galleryPollTimer = null;
let knownGalleryPaths = null;     // every path seen so far, to spot new arrivals
const newPhonePaths = new Set();  // phone photos that arrived and haven't been touched yet

function updateGalleryToggleLabel() {
  const open = !document.getElementById('galleryPanel').hidden;
  const n = newPhonePaths.size;
  document.getElementById('toggleGalleryBtn').textContent = open
    ? 'Hide gallery'
    : `Phone / Drive gallery${n ? ` (${n} new)` : ''}`;
}

// The QR code + link that opens the camera page on the phone.
async function loadPhoneBox() {
  const qr = document.getElementById('phoneQr');
  const status = document.getElementById('phoneStatus');
  const url = document.getElementById('phoneUrl');
  qr.hidden = true;
  url.textContent = '';
  status.textContent = 'Checking phone connection…';

  let info;
  try {
    info = await window.kiosk.phone.info();
  } catch (err) {
    status.textContent = `Phone camera unavailable: ${err.message}`;
    return;
  }
  if (!info.running) {
    status.textContent = `The phone camera server isn't running (${info.error}).`;
    return;
  }
  if (info.noNetwork) {
    status.textContent = 'No network found — connect this PC to Wi-Fi, then reopen the gallery.';
    return;
  }

  qr.src = info.qr;
  qr.hidden = false;
  status.textContent =
    'Scan once with the phone camera and open the link (in Chrome: ⋮ → Add to Home screen, so it stays one tap away). ' +
    'Each photo you take appears below within a couple of seconds. The phone and this PC must be on the same Wi-Fi.';
  url.textContent = info.url + (info.others.length
    ? `  —  if that doesn't open, try: ${info.others.map(o => `${o.url} (${o.name})`).join(', ')}`
    : '');
}

document.getElementById('toggleGalleryBtn').addEventListener('click', async () => {
  const panel = document.getElementById('galleryPanel');
  const opening = panel.hidden;
  panel.hidden = !opening;
  updateGalleryToggleLabel();

  clearInterval(galleryPollTimer);
  if (!opening) return;

  loadPhoneBox();
  const folder = await window.kiosk.gallery.getFolder();
  document.getElementById('galleryFolderLabel').textContent = folder
    ? `Google Drive folder: ${folder}`
    : 'No Google Drive folder set (optional) — showing phone photos only.';
  await refreshGallery();
  galleryPollTimer = setInterval(refreshGallery, 5000);
});

async function chooseGalleryFolder() {
  const folder = await window.kiosk.gallery.chooseFolder();
  if (!folder) return;
  document.getElementById('galleryFolderLabel').textContent = `Google Drive folder: ${folder}`;
  await refreshGallery();
}
document.getElementById('chooseFolderBtn').addEventListener('click', chooseGalleryFolder);
document.getElementById('refreshGalleryBtn').addEventListener('click', refreshGallery);

document.getElementById('clearPhoneBtn').addEventListener('click', async () => {
  if (!confirm(
    'Delete all photos received from the phone camera?\n\n' +
    'Photos already added to the current job stay, but saved jobs that use them will no longer reopen.'
  )) return;
  await window.kiosk.phone.clearInbox();
  newPhonePaths.clear();
  await refreshGallery();
});

async function refreshGallery() {
  galleryPhotos = await window.kiosk.gallery.list();

  // Anything from the phone we haven't seen before is "new" (the very first
  // load only sets the baseline, so photos already there at startup aren't).
  if (knownGalleryPaths) {
    for (const p of galleryPhotos) {
      if (p.source === 'phone' && !knownGalleryPaths.has(p.path)) newPhonePaths.add(p.path);
    }
  }
  knownGalleryPaths = new Set(galleryPhotos.map(p => p.path));

  // Don't build a grid of thumbnails nobody can see.
  if (!document.getElementById('galleryPanel').hidden) renderGalleryGrid();
  updateGalleryToggleLabel();
}

// A photo just arrived from the phone: refresh now, don't wait for the poll.
window.kiosk.phone.onUploaded(() => { refreshGallery().catch(() => {}); });

function renderGalleryGrid() {
  const grid = document.getElementById('galleryGrid');
  if (galleryPhotos.length === 0) {
    grid.innerHTML =
      '<p class="muted">No photos yet. Take one with the phone camera page (scan the QR code above), ' +
      'or add some to the Google Drive folder and click Refresh.</p>';
    return;
  }
  grid.innerHTML = '';
  for (const photo of galleryPhotos) {
    const inPool = wizard.photoPool.some(p => p.path === photo.path);
    const isNew = !inPool && newPhonePaths.has(photo.path);
    const card = document.createElement('div');
    card.className = 'card' + (inPool ? ' selected' : '');
    card.innerHTML = `
      ${inPool ? '<span class="badge">&check;</span>' : isNew ? '<span class="badge new">NEW</span>' : ''}
      <img src="file://${photo.path}" />
      <p>${new Date(photo.datetime).toLocaleString()}</p>
    `;
    card.addEventListener('click', () => toggleGalleryPhoto(photo));
    grid.appendChild(card);
  }
}

async function toggleGalleryPhoto(photo) {
  newPhonePaths.delete(photo.path); // they've seen it now
  updateGalleryToggleLabel();

  const idx = wizard.photoPool.findIndex(p => p.path === photo.path);
  if (idx >= 0) {
    wizard.photoPool.splice(idx, 1);
  } else {
    let img;
    try {
      img = await loadImageFromPath(photo.path);
    } catch {
      return;
    }
    wizard.photoPool.push({ img, path: photo.path, name: photo.filename });
  }
  renderGalleryGrid();
  renderPhotosStep();
}

document.getElementById('photosBackBtn').addEventListener('click', () => {
  clearInterval(galleryPollTimer);
  goToStep('templates');
});
document.getElementById('photosNextBtn').addEventListener('click', () => {
  clearInterval(galleryPollTimer);
  // Order always starts fresh from the current pool — any earlier order
  // was for a possibly-different pool/template and would be stale.
  wizard.order = wizard.photoPool.map((_, i) => i);
  wizard.adjustments = [];
  advanceTo('order');
});

// =======================================================================
// Step 4: Order — arrange the gathered photos into slot order (drag or
// arrows), and replace individual photos if needed.
// =======================================================================
let orderDragFrom = null;
let orderReplaceIndex = null;

function renderOrderStep() {
  // Safety net: if we ever arrive here with a stale order, rebuild it.
  if (wizard.order.length !== wizard.photoPool.length) {
    wizard.order = wizard.photoPool.map((_, i) => i);
    wizard.adjustments = [];
  }

  const ranges = sideRanges();
  const wrap = document.getElementById('orderThumbs');
  wrap.innerHTML = '';

  wizard.order.forEach((poolIdx, i) => {
    const photo = wizard.photoPool[poolIdx];
    if (!photo) return;
    const sideIdx = ranges.findIndex(r => i >= r.start && i < r.start + r.count);
    const withinSide = sideIdx >= 0 ? i - ranges[sideIdx].start + 1 : i + 1;
    const label = ranges.length > 1 ? `${sideIdx === 0 ? 'Left' : 'Right'} #${withinSide}` : `Slot ${withinSide}`;

    const cell = document.createElement('div');
    cell.className = 'mini';
    cell.draggable = true;
    cell.innerHTML = `
      <img src="${photo.img.src}" alt="" draggable="false" />
      <span>${label}</span>
      <div class="mini-actions">
        <button data-act="left" ${i === 0 ? 'disabled' : ''} title="Move earlier">&larr;</button>
        <button data-act="replace" title="Replace this photo">&#8635;</button>
        <button data-act="right" ${i === wizard.order.length - 1 ? 'disabled' : ''} title="Move later">&rarr;</button>
      </div>
    `;
    cell.querySelector('[data-act="left"]').addEventListener('click', () => moveOrderTo(i, i - 1));
    cell.querySelector('[data-act="right"]').addEventListener('click', () => moveOrderTo(i, i + 1));
    cell.querySelector('[data-act="replace"]').addEventListener('click', () => {
      orderReplaceIndex = i;
      document.getElementById('replacePhotoInput').click();
    });

    cell.addEventListener('dragstart', () => {
      orderDragFrom = i;
      cell.classList.add('dragging');
    });
    cell.addEventListener('dragend', () => {
      orderDragFrom = null;
      wrap.querySelectorAll('.mini').forEach(m => m.classList.remove('dragging', 'drop-before', 'drop-after'));
    });
    cell.addEventListener('dragover', (e) => {
      if (orderDragFrom === null || orderDragFrom === i) return;
      e.preventDefault();
      const after = e.clientX > cell.getBoundingClientRect().left + cell.offsetWidth / 2;
      cell.classList.toggle('drop-before', !after);
      cell.classList.toggle('drop-after', after);
    });
    cell.addEventListener('dragleave', () => cell.classList.remove('drop-before', 'drop-after'));
    cell.addEventListener('drop', (e) => {
      e.preventDefault();
      if (orderDragFrom === null) return;
      const after = e.clientX > cell.getBoundingClientRect().left + cell.offsetWidth / 2;
      const to = i + (after ? 1 : 0) - (orderDragFrom < i ? 1 : 0);
      moveOrderTo(orderDragFrom, to);
    });

    wrap.appendChild(cell);
  });

  document.getElementById('orderNextBtn').disabled = wizard.order.length === 0;
}

// Move the photo at position `from` to final position `to`. Adjustments
// are cleared — after a reorder, a slot's crop no longer matches whatever
// photo now sits there, and fine-tuning happens on the Preview step,
// which comes after this one anyway.
function moveOrderTo(from, to) {
  const n = wizard.order.length;
  if (from < 0 || from >= n) return;
  to = Math.max(0, Math.min(n - 1, to));
  if (to === from) return;
  wizard.order.splice(to, 0, wizard.order.splice(from, 1)[0]);
  wizard.adjustments = [];
  renderOrderStep();
}

document.getElementById('replacePhotoInput').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  const i = orderReplaceIndex;
  orderReplaceIndex = null;
  if (!file || i == null) return;

  try {
    const img = await fileToImage(file);
    const poolIdx = wizard.order[i];
    wizard.photoPool[poolIdx] = { img, path: file.path || null, name: file.name };
    wizard.adjustments[i] = undefined; // only this slot's crop needs to reset
  } catch {
    return;
  }
  renderOrderStep();
});

document.getElementById('orderBackBtn').addEventListener('click', () => goToStep('photos'));
document.getElementById('orderNextBtn').addEventListener('click', () => advanceTo('preview'));

// =======================================================================
// Step 5: Preview — composite each side, fine-tune crops, print / save.
// =======================================================================

// -- Per-slot crop math (shared by every side canvas) --------------------
function coverScale(img, slot) {
  return Math.max(slot.w / img.width, slot.h / img.height);
}
// Lowest allowed zoom. 1 = photo exactly covers the slot; below that the
// whole photo fits inside the slot with white padding around it.
function minZoomFor(img, slot) {
  const contain = Math.min(slot.w / img.width, slot.h / img.height);
  return contain / coverScale(img, slot);
}
function defaultAdjust(img, slot) {
  const S = coverScale(img, slot);
  return {
    zoom: 1,
    panX: (slot.w - img.width * S) / 2,
    panY: (slot.h - img.height * S) / 2
  };
}
function clampAdjust(img, slot, adj) {
  adj.zoom = Math.min(5, Math.max(minZoomFor(img, slot), adj.zoom));
  const S = coverScale(img, slot) * adj.zoom;
  const dw = img.width * S;
  const dh = img.height * S;
  const clampPan = (span, dspan, v) => dspan >= span
    ? Math.min(0, Math.max(span - dspan, v))
    : Math.max(0, Math.min(span - dspan, v));
  adj.panX = clampPan(slot.w, dw, adj.panX);
  adj.panY = clampPan(slot.h, dh, adj.panY);
  return adj;
}
function drawSlot(ctx, img, slot, adj) {
  const S = coverScale(img, slot) * adj.zoom;
  ctx.save();
  ctx.beginPath();
  ctx.rect(slot.x, slot.y, slot.w, slot.h);
  ctx.clip();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(slot.x, slot.y, slot.w, slot.h);
  ctx.drawImage(img, slot.x + adj.panX, slot.y + adj.panY, img.width * S, img.height * S);
  ctx.restore();
}

// -- Per-side canvas: state + compositing --------------------------------
let sideStates = []; // one per active side, rebuilt each time Preview is (re)entered

async function buildSideState(range) {
  const canvas = document.createElement('canvas');
  canvas.width = range.template.canvasWidth;
  canvas.height = range.template.canvasHeight;
  const borderImg = await loadImageFromPath(range.template.borderPath, true);
  return { range, tpl: range.template, canvas, borderImg, activeSlotIndex: null };
}

function renderSideStrip(state) {
  const ctx = state.canvas.getContext('2d');
  ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);

  const drawPhotos = () => {
    state.tpl.slots.forEach((slot, si) => {
      const gi = state.range.start + si;
      const photo = wizard.photoPool[wizard.order[gi]];
      if (!photo) return;
      if (!wizard.adjustments[gi]) wizard.adjustments[gi] = defaultAdjust(photo.img, slot);
      drawSlot(ctx, photo.img, slot, wizard.adjustments[gi]);
    });
  };

  drawPhotos();
  if (state.borderImg) ctx.drawImage(state.borderImg, 0, 0, state.canvas.width, state.canvas.height);
  // Opaque-border (white-fallback) templates have no holes, so the border
  // just painted over the photos — redraw them clipped to each slot.
  if (state.tpl.opaqueBorder) drawPhotos();
}

// -- Editing happens on the sheet preview itself --------------------------
// The sheet preview is what will print, so it is also where photos get
// adjusted: a click lands on the sheet, is mapped back into the strip it
// hit, and from there it's the usual per-slot drag / zoom / reset. (A
// separate canvas per strip would only show the same picture twice.)

// Where each strip copy sits on the sheet, in sheet pixels. Mirrors what
// buildSheetCanvas draws — both go through containRect(), so they can't
// drift apart. For "identical copies" the same strip appears twice.
function sheetPlacements() {
  const [left, right] = sheetCanvasArgs();
  const place = (canvas, x, y, w, h) => ({
    state: sideStates.find(s => s.canvas === canvas),
    ...containRect(canvas, x, y, w, h)
  });
  let placements = [];
  if (left && right) {
    const cellW = SHEET_W_PX / 2;
    placements = [place(left, 0, 0, cellW, SHEET_H_PX), place(right, cellW, 0, cellW, SHEET_H_PX)];
  } else if (left || right) {
    placements = [place(left || right, 0, 0, SHEET_W_PX, SHEET_H_PX)];
  }
  return placements.filter(pl => pl.state);
}

// Outline every photo slot over the sheet (the one being edited is solid).
function updateSheetOverlay() {
  const overlay = document.getElementById('sheetOverlay');
  overlay.innerHTML = '';
  for (const pl of sheetPlacements()) {
    const k = pl.w / pl.state.canvas.width; // strip pixels -> sheet pixels
    pl.state.tpl.slots.forEach((slot, i) => {
      const hi = document.createElement('div');
      hi.className = 'slot-hi' + (i === pl.state.activeSlotIndex ? ' active' : '');
      hi.style.left = ((pl.x + slot.x * k) / SHEET_W_PX * 100) + '%';
      hi.style.top = ((pl.y + slot.y * k) / SHEET_H_PX * 100) + '%';
      hi.style.width = (slot.w * k / SHEET_W_PX * 100) + '%';
      hi.style.height = (slot.h * k / SHEET_H_PX * 100) + '%';
      overlay.appendChild(hi);
    });
  }
}

function slotAtOn(tpl, x, y) {
  for (let i = tpl.slots.length - 1; i >= 0; i--) {
    const s = tpl.slots[i];
    if (x >= s.x && x <= s.x + s.w && y >= s.y && y <= s.y + s.h) return i;
  }
  return -1;
}

function afterSideAdjust(state) {
  renderSideStrip(state);
  renderSheetPreview();
  updateSheetOverlay();
}

// The mouse position in sheet pixels, and — given a placement — in that
// strip's own pixels.
function sheetPointer(e, placement) {
  const canvas = document.getElementById('sheetPreviewCanvas');
  const r = canvas.getBoundingClientRect();
  const sx = (e.clientX - r.left) / r.width * canvas.width;
  const sy = (e.clientY - r.top) / r.height * canvas.height;
  if (!placement) return { sx, sy };
  return {
    sx, sy,
    x: (sx - placement.x) / placement.w * placement.state.canvas.width,
    y: (sy - placement.y) / placement.h * placement.state.canvas.height
  };
}

// The photo slot under the cursor, if any: { placement, index, x, y } with
// x/y in that strip's pixels.
function slotUnderPointer(e) {
  const { sx, sy } = sheetPointer(e);
  for (const pl of sheetPlacements()) {
    if (sx < pl.x || sx > pl.x + pl.w || sy < pl.y || sy > pl.y + pl.h) continue;
    const p = sheetPointer(e, pl);
    const index = slotAtOn(pl.state.tpl, p.x, p.y);
    if (index >= 0) return { placement: pl, index, x: p.x, y: p.y };
  }
  return null;
}

function setActiveSlot(state, index) {
  for (const s of sideStates) s.activeSlotIndex = null;
  if (state) state.activeSlotIndex = index;
}

// Every listener here is tied to `signal`: the sheet canvas is one
// long-lived element and the move/up listeners live on `window`, so they'd
// otherwise pile up each time the Preview step is rendered.
function wireSheetEditing(signal) {
  const canvas = document.getElementById('sheetPreviewCanvas');
  let drag = null; // { placement, index, x, y } — x/y = last pointer position, strip pixels

  canvas.addEventListener('mousedown', (e) => {
    const hit = slotUnderPointer(e);
    setActiveSlot(hit ? hit.placement.state : null, hit ? hit.index : null);
    updateSheetOverlay();
    if (hit) {
      drag = hit;
      canvas.style.cursor = 'grabbing';
    }
  }, { signal });

  window.addEventListener('mousemove', (e) => {
    if (!drag) return;
    const { state } = drag.placement;
    const p = sheetPointer(e, drag.placement);
    const slot = state.tpl.slots[drag.index];
    const gi = state.range.start + drag.index;
    const photo = wizard.photoPool[wizard.order[gi]];
    const adj = wizard.adjustments[gi] || (wizard.adjustments[gi] = defaultAdjust(photo.img, slot));
    adj.panX += p.x - drag.x;
    adj.panY += p.y - drag.y;
    drag.x = p.x;
    drag.y = p.y;
    clampAdjust(photo.img, slot, adj);
    afterSideAdjust(state);
  }, { signal });

  window.addEventListener('mouseup', () => {
    if (!drag) return;
    drag = null;
    canvas.style.cursor = 'grab';
  }, { signal });

  canvas.addEventListener('wheel', (e) => {
    const hit = slotUnderPointer(e);
    if (!hit) return;
    e.preventDefault();

    const { state } = hit.placement;
    const slot = state.tpl.slots[hit.index];
    const gi = state.range.start + hit.index;
    const photo = wizard.photoPool[wizard.order[gi]];
    const adj = wizard.adjustments[gi] || (wizard.adjustments[gi] = defaultAdjust(photo.img, slot));
    const cs = coverScale(photo.img, slot);
    const oldZoom = adj.zoom;
    adj.zoom = Math.min(5, Math.max(minZoomFor(photo.img, slot), adj.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));

    // Keep the point under the cursor fixed while zooming.
    const imgX = (hit.x - slot.x - adj.panX) / (cs * oldZoom);
    const imgY = (hit.y - slot.y - adj.panY) / (cs * oldZoom);
    adj.panX = hit.x - slot.x - imgX * cs * adj.zoom;
    adj.panY = hit.y - slot.y - imgY * cs * adj.zoom;

    clampAdjust(photo.img, slot, adj);
    setActiveSlot(state, hit.index);
    afterSideAdjust(state);
  }, { passive: false, signal });

  canvas.addEventListener('dblclick', (e) => {
    const hit = slotUnderPointer(e);
    if (!hit) return;
    const { state } = hit.placement;
    const gi = state.range.start + hit.index;
    const photo = wizard.photoPool[wizard.order[gi]];
    wizard.adjustments[gi] = defaultAdjust(photo.img, state.tpl.slots[hit.index]);
    setActiveSlot(state, hit.index);
    afterSideAdjust(state);
  }, { signal });

  canvas.addEventListener('mousemove', (e) => {
    if (drag) return;
    canvas.style.cursor = slotUnderPointer(e) ? 'grab' : 'default';
  }, { signal });
}

// Put every photo back to its default crop.
document.getElementById('resetAdjustBtn').addEventListener('click', () => {
  for (const state of sideStates) {
    state.tpl.slots.forEach((slot, si) => {
      const gi = state.range.start + si;
      const photo = wizard.photoPool[wizard.order[gi]];
      if (photo) wizard.adjustments[gi] = defaultAdjust(photo.img, slot);
    });
    state.activeSlotIndex = null;
    renderSideStrip(state);
  }
  renderSheetPreview();
  updateSheetOverlay();
});

// -- Sheet assembly (10cm x 14.8cm, one or two prints side by side) ------
const SHEET_DPI = 300;                  // SELPHY CP1500 native print resolution
const SHEET_WIDTH_MM = 100;             // 10cm
const SHEET_HEIGHT_MM = 148;            // 14.8cm
const SHEET_W_PX = Math.round(SHEET_WIDTH_MM / 25.4 * SHEET_DPI);   // ~1181
const SHEET_H_PX = Math.round(SHEET_HEIGHT_MM / 25.4 * SHEET_DPI);  // ~1748
// Millimetres in microns (1 mm = 1000 µm), for Electron's print pageSize.
const SHEET_PAGE_SIZE = { widthMicrons: SHEET_WIDTH_MM * 1000, heightMicrons: SHEET_HEIGHT_MM * 1000 };

// The rectangle a contain-fit (centred, aspect preserved) lands in.
function containRect(src, x, y, w, h) {
  const scale = Math.min(w / src.width, h / src.height);
  const dw = src.width * scale;
  const dh = src.height * scale;
  return { x: x + (w - dw) / 2, y: y + (h - dh) / 2, w: dw, h: dh };
}

function drawContain(ctx, src, x, y, w, h) {
  const r = containRect(src, x, y, w, h);
  ctx.drawImage(src, r.x, r.y, r.w, r.h);
}

// Builds the full sheet canvas. `right` is null for a single 10x14.8cm
// print; otherwise each side is contain-fitted into its half. `showGuide`
// draws a dashed cut line down the middle — on-screen only, never printed.
function buildSheetCanvas(left, right, showGuide) {
  const sheet = document.createElement('canvas');
  sheet.width = SHEET_W_PX;
  sheet.height = SHEET_H_PX;
  const ctx = sheet.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, sheet.width, sheet.height);

  if (left && right) {
    const cellW = sheet.width / 2;
    drawContain(ctx, left, 0, 0, cellW, sheet.height);
    drawContain(ctx, right, cellW, 0, cellW, sheet.height);
    if (showGuide) {
      ctx.strokeStyle = 'rgba(0,0,0,0.25)';
      ctx.lineWidth = 2;
      ctx.setLineDash([14, 14]);
      ctx.beginPath();
      ctx.moveTo(cellW, 0);
      ctx.lineTo(cellW, sheet.height);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  } else {
    drawContain(ctx, left || right, 0, 0, sheet.width, sheet.height);
  }
  return sheet;
}

// ---------------------------------------------------------------------
// Printer calibration sheet: a measurable ruler/crosshair/registration
// pattern, built at the exact same pixel size (SHEET_W_PX x SHEET_H_PX)
// and pushed through the exact same print:image pipeline as a real job
// (same pageSize, same margins:none). If a real print shows content
// landing outside where it should, print this once and measure it: it
// isolates whether the problem is in this app's compositing (this
// pattern would print fine) or in the printer driver/paper setup (this
// pattern would show the same offset/cropping a real job does).
// ---------------------------------------------------------------------
function buildCalibrationSheet() {
  const mmToPx = (mm) => mm / 25.4 * SHEET_DPI;
  const sheet = document.createElement('canvas');
  sheet.width = SHEET_W_PX;
  sheet.height = SHEET_H_PX;
  const ctx = sheet.getContext('2d');
  const w = sheet.width, h = sheet.height;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);

  // Full-sheet edge: a 1px frame touching the very first/last pixel row
  // and column. If the printed paper shows white space inside this line,
  // or the line itself is cut off, that's your registration/crop error.
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  // Corner registration marks (small L's right at each corner) — the
  // first thing to go missing if the driver insets or crops the page.
  const CORNER = mmToPx(8);
  const corners = [[0, 0, 1, 1], [w, 0, -1, 1], [0, h, 1, -1], [w, h, -1, -1]];
  ctx.lineWidth = 2;
  for (const [cx, cy, dx, dy] of corners) {
    ctx.beginPath();
    ctx.moveTo(cx, cy + dy * CORNER);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + dx * CORNER, cy);
    ctx.stroke();
  }

  // Ruler ticks every 10mm along the top and left edges, numbered every
  // 20mm, so a measured offset reads directly in millimetres.
  ctx.strokeStyle = '#000000';
  ctx.fillStyle = '#000000';
  ctx.font = `${Math.round(mmToPx(3.2))}px system-ui, sans-serif`;
  ctx.textBaseline = 'top';
  for (let mm = 0; mm <= SHEET_WIDTH_MM; mm += 10) {
    const x = mmToPx(mm);
    const long = mm % 20 === 0;
    ctx.lineWidth = long ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, mmToPx(long ? 6 : 3));
    ctx.stroke();
    if (long && mm > 0 && mm < SHEET_WIDTH_MM) ctx.fillText(String(mm), x + 3, mmToPx(7));
  }
  ctx.textAlign = 'left';
  for (let mm = 0; mm <= SHEET_HEIGHT_MM; mm += 10) {
    const y = mmToPx(mm);
    const long = mm % 20 === 0;
    ctx.lineWidth = long ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(mmToPx(long ? 6 : 3), y);
    ctx.stroke();
    if (long && mm > 0 && mm < SHEET_HEIGHT_MM) ctx.fillText(String(mm), mmToPx(7), y + 3);
  }

  // Dashed vertical line at the half-width point — where a 2-strip sheet
  // gets cut. Useful even for a 1-print job, to sanity-check the mm scale.
  ctx.strokeStyle = 'rgba(0,0,0,0.4)';
  ctx.lineWidth = 2;
  ctx.setLineDash([14, 14]);
  ctx.beginPath();
  ctx.moveTo(w / 2, 0);
  ctx.lineTo(w / 2, h);
  ctx.stroke();
  ctx.setLineDash([]);

  // Center crosshair.
  const cx = w / 2, cyMid = h / 2, r = mmToPx(6);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(cx - r, cyMid);
  ctx.lineTo(cx + r, cyMid);
  ctx.moveTo(cx, cyMid - r);
  ctx.lineTo(cx, cyMid + r);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx, cyMid, r * 0.6, 0, Math.PI * 2);
  ctx.stroke();

  // Inset rings: concentric rectangles 2, 4, 6, 8 and 10mm in from every
  // edge, each labelled. The outermost ring you can still see on a given
  // side of the printed paper IS how many mm that side is losing — no
  // ruler needed, and it works even when the very edge is cropped.
  ctx.strokeStyle = '#000000';
  ctx.fillStyle = '#000000';
  ctx.font = `${Math.round(mmToPx(1.8))}px system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;
  for (const mm of [2, 4, 6, 8, 10]) {
    const d = mmToPx(mm);
    ctx.strokeRect(d + 0.5, d + 0.5, w - 2 * d - 1, h - 2 * d - 1);
    // Label each side's ring where it won't collide with the ruler
    // labels (top/left) or the centre cut line/crosshair.
    ctx.fillText(String(mm), mmToPx(35), d + mmToPx(1)); // top
    ctx.fillText(String(mm), mmToPx(35), h - d - mmToPx(1)); // bottom
    ctx.fillText(String(mm), d + mmToPx(1), h * 0.6); // left
    ctx.fillText(String(mm), w - d - mmToPx(1), h * 0.6); // right
  }

  // Title block — kept well clear of the left-ruler labels (20mm, 40mm...)
  // and narrow enough (~75mm) that it leaves a visible margin even if the
  // page is being enlarged a few percent.
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `bold ${Math.round(mmToPx(4))}px system-ui, sans-serif`;
  ctx.fillText('XMMBRIDGE Calibration', cx, mmToPx(32));
  ctx.font = `${Math.round(mmToPx(2.8))}px system-ui, sans-serif`;
  ctx.fillText(`${SHEET_WIDTH_MM} × ${SHEET_HEIGHT_MM} mm — rings = mm in from edge`, cx, mmToPx(37));
  ctx.textAlign = 'left';

  return sheet;
}

// ---------------------------------------------------------------------
// Printer enlargement compensation. A borderless driver typically
// enlarges the image a few percent so no white edge shows, which crops
// content off every side. The operator measures how long a "20 mm" mark
// actually printed (e.g. 21.5mm => the printer enlarges by 7.5%) and
// enters it; every print is then pre-shrunk by that factor and centred,
// so the driver's enlargement brings it back to exactly the paper size.
// The gap that leaves around the image is filled by extending the
// sheet's own edge pixels outward (so it's a bleed, not a white frame —
// if the driver enlarges a touch less than expected, no sliver shows).
// ---------------------------------------------------------------------
const PRINT_MEASURED_KEY = 'printMeasured20mm';

function getMeasured20() {
  try {
    const v = parseFloat(localStorage.getItem(PRINT_MEASURED_KEY));
    if (Number.isFinite(v)) return v;
  } catch { /* storage unavailable — fall through to no correction */ }
  return 20;
}

// >= 1. Only handles printers that enlarge; 20mm measuring under 20 is
// treated as "no correction".
function printScaleFactor() {
  return Math.min(1.3, Math.max(1, getMeasured20() / 20));
}

function compensateForPrinter(src) {
  const k = printScaleFactor();
  if (k < 1.001) return src;

  const W = src.width, H = src.height;
  const iw = W / k, ih = H / k;
  const ox = (W - iw) / 2, oy = (H - ih) / 2;

  const out = document.createElement('canvas');
  out.width = W;
  out.height = H;
  const ctx = out.getContext('2d');

  // Bleed: stretch the sheet's outermost pixel row/column (and corner
  // pixel) across the margin. Drawn first, the shrunken sheet covers the
  // middle.
  ctx.drawImage(src, 0, 0, W, 1, ox, 0, iw, oy);                       // top
  ctx.drawImage(src, 0, H - 1, W, 1, ox, oy + ih, iw, H - oy - ih);    // bottom
  ctx.drawImage(src, 0, 0, 1, H, 0, oy, ox, ih);                       // left
  ctx.drawImage(src, W - 1, 0, 1, H, ox + iw, oy, W - ox - iw, ih);    // right
  ctx.drawImage(src, 0, 0, 1, 1, 0, 0, ox, oy);                        // corners
  ctx.drawImage(src, W - 1, 0, 1, 1, ox + iw, 0, W - ox - iw, oy);
  ctx.drawImage(src, 0, H - 1, 1, 1, 0, oy + ih, ox, H - oy - ih);
  ctx.drawImage(src, W - 1, H - 1, 1, 1, ox + iw, oy + ih, W - ox - iw, H - oy - ih);

  ctx.drawImage(src, ox, oy, iw, ih);
  return out;
}

{
  const input = document.getElementById('printMeasuredInput');
  input.value = String(getMeasured20());
  input.addEventListener('change', () => {
    const v = parseFloat(input.value);
    if (!Number.isFinite(v) || v < 20 || v > 26) {
      input.value = String(getMeasured20()); // reject nonsense, keep the last good value
      return;
    }
    try { localStorage.setItem(PRINT_MEASURED_KEY, String(v)); } catch { /* ignore */ }
  });
}

document.getElementById('printCalibrationBtn').addEventListener('click', async () => {
  const status = document.getElementById('printStatus');
  const deviceName = document.getElementById('printerSelect').value;
  // Goes through the same compensation as a real print, so printing it
  // again with a correction set verifies the correction.
  const dataUrl = compensateForPrinter(buildCalibrationSheet()).toDataURL('image/png');

  status.textContent = 'Printing calibration sheet…';
  try {
    await window.kiosk.print.image(dataUrl, deviceName, false, SHEET_PAGE_SIZE);
    status.textContent = 'Calibration sheet sent — measure it against the printed paper.';
  } catch (err) {
    status.textContent = `Calibration print failed: ${err.message}`;
  }
});

// [left, right] canvases for the sheet. Normally one per side (or just
// `left` for a single sheet); for "duplicate photos" there's only one
// editable strip, so it's drawn into both halves.
function sheetCanvasArgs() {
  const canvases = sideStates.map(s => s.canvas);
  if (wizard.layout === 'double' && wizard.duplicatePhotos) return [canvases[0], canvases[0]];
  return canvases.length > 1 ? [canvases[0], canvases[1]] : [canvases[0], null];
}

function renderSheetPreview() {
  const [left, right] = sheetCanvasArgs();
  const sheet = buildSheetCanvas(left, right, true);
  const view = document.getElementById('sheetPreviewCanvas');
  view.width = sheet.width;
  view.height = sheet.height;
  view.getContext('2d').drawImage(sheet, 0, 0);
}

// Listeners for dragging/zooming on the sheet preview (see wireSheetEditing).
// renderPreviewStep can run many times in a session (switching template,
// revisiting the step, ...); aborting the previous controller drops the
// old listeners so they don't pile up and fire against stale strips.
let previewEditAbort = null;

async function renderPreviewStep() {
  previewEditAbort?.abort();
  previewEditAbort = new AbortController();

  sideStates = [];
  for (const range of sideRanges()) {
    const state = await buildSideState(range);
    sideStates.push(state);
    renderSideStrip(state);
  }

  document.getElementById('sheetCaption').textContent =
    wizard.layout === 'single'
      ? 'One 10×14.8 cm print.'
      : wizard.duplicatePhotos
        ? 'Two identical 5×14.8 cm strips — adjusting either one adjusts both. Dashed line = where to cut.'
        : 'Left and right 5×14.8 cm strips. Dashed line = where to cut.';

  wireSheetEditing(previewEditAbort.signal);
  renderSheetPreview();
  updateSheetOverlay();
  await populatePrinters();
}

async function populatePrinters() {
  const printers = await window.kiosk.printers.list();
  const select = document.getElementById('printerSelect');
  select.innerHTML = '';

  if (printers.length === 0) {
    select.innerHTML = '<option value="">No printers found</option>';
    return;
  }

  for (const p of printers) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.displayName || p.name;
    // Pre-select anything with "SELPHY" in the name.
    if (/selphy/i.test(p.name) || /selphy/i.test(p.displayName || '')) {
      opt.selected = true;
    }
    select.appendChild(opt);
  }
}

document.getElementById('previewBackBtn').addEventListener('click', () => goToStep('order'));

document.getElementById('printBtn').addEventListener('click', async () => {
  const status = document.getElementById('printStatus');
  const deviceName = document.getElementById('printerSelect').value;
  const [left, right] = sheetCanvasArgs();
  const sheet = compensateForPrinter(buildSheetCanvas(left, right, false));
  const dataUrl = sheet.toDataURL('image/png');

  status.textContent = 'Printing…';
  try {
    // Set `silent` to true once you've confirmed the correct printer +
    // paper cassette in testing, so customers never see a print dialog.
    await window.kiosk.print.image(dataUrl, deviceName, false, SHEET_PAGE_SIZE);
    status.textContent = 'Sent to printer!';
  } catch (err) {
    status.textContent = `Print failed: ${err.message}`;
  }
});

// A small JPEG of the assembled sheet, for the "Saved jobs" gallery.
function sheetThumbnail() {
  const src = document.getElementById('sheetPreviewCanvas');
  const t = document.createElement('canvas');
  const scale = 240 / src.width;
  t.width = 240;
  t.height = Math.round(src.height * scale);
  t.getContext('2d').drawImage(src, 0, 0, t.width, t.height);
  return t.toDataURL('image/jpeg', 0.7);
}

document.getElementById('saveStripBtn').addEventListener('click', async () => {
  const status = document.getElementById('printStatus');
  const paths = wizard.order.map(idx => wizard.photoPool[idx].path);
  if (paths.some(p => !p)) {
    status.textContent =
      "Can't save this job — a photo has no file path on disk (drag-dropped or pasted images can't be reloaded).";
    return;
  }

  const name = await askName('Name this job (e.g. "Booth 3 — Alice & Ben"):');
  if (!name) return; // cancelled / blank

  const tpls = activeTemplates();
  const templateIds = wizard.layout === 'single'
    ? [tpls[0].id]
    : [tpls[0].id, tpls[1].id];

  const rec = await window.kiosk.strips.save({
    name,
    layout: wizard.layout,
    templateIds,
    duplicatePhotos: wizard.layout === 'double' && wizard.duplicatePhotos,
    photoPaths: paths,
    adjustments: wizard.adjustments.map(a => a && { zoom: a.zoom, panX: a.panX, panY: a.panY }),
    thumbnail: sheetThumbnail()
  });
  status.textContent = `Saved as "${rec.name}".`;
  await refreshSavedJobs();
});

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
(async () => {
  await refreshTemplatesList();
  await refreshSavedJobs();
  renderLayoutStep();
  refreshTabsEnabled();
  refreshGallery().catch(() => {}); // baseline, so later phone photos are flagged NEW
})();
