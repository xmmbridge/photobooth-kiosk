const { app, BrowserWindow, ipcMain, dialog, webContents } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Jimp = require('jimp');
const exifr = require('exifr');

// All template borders + their computed slot layouts live here.
const TEMPLATES_DIR = path.join(app.getPath('userData'), 'templates');
if (!fs.existsSync(TEMPLATES_DIR)) fs.mkdirSync(TEMPLATES_DIR, { recursive: true });

// Saved strips: a template id + the photo file paths + per-slot
// zoom/pan adjustments + a small thumbnail, one JSON file each.
const STRIPS_DIR = path.join(app.getPath('userData'), 'strips');
if (!fs.existsSync(STRIPS_DIR)) fs.mkdirSync(STRIPS_DIR, { recursive: true });

// Small persisted config (currently just the Google Drive sync folder path).
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif']);

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

function writeConfig(partial) {
  const current = readConfig();
  const next = { ...current, ...partial };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2));
  return next;
}

let mainWindow;

// Kiosk (fullscreen, no window chrome) is ON by default in a packaged
// build and OFF for `npm start` during development. Override either way
// with KIOSK=1 / KIOSK=0.
const kioskMode =
  process.env.KIOSK === '1' ? true :
  process.env.KIOSK === '0' ? false :
  app.isPackaged;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 900,
    title: 'XMMBRIDGE Photobooth',
    fullscreen: kioskMode,
    kiosk: kioskMode,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.setMenuBarVisibility(false);

  // Kiosk mode traps the user, so give the operator a way out:
  // Ctrl/Cmd + Shift + Q quits the app.
  mainWindow.webContents.on('before-input-event', (_event, input) => {
    const mod = process.platform === 'darwin' ? input.meta : input.control;
    if (mod && input.shift && input.key.toLowerCase() === 'q') app.quit();
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* ---------------------------------------------------------------------- *
 *  Recover missing slots in a uniform vertical photo strip.
 *  Given the boxes flood fill *did* find, if they're uniform in size and
 *  evenly pitched, probe for boxes in any interior gap and just past each
 *  end. A probe is accepted only if its inset interior is almost entirely
 *  white AND enough of its perimeter is non-white (i.e. it has a drawn
 *  border) — so genuine slots whose frame was broken by artwork come
 *  back, without inventing boxes out in the blank page margin.
 * ---------------------------------------------------------------------- */
function extrapolateUniformStrip(regions, w, h, isWhite) {
  const byY = [...regions].sort((a, b) => a.y - b.y);
  const ws = byY.map(r => r.w);
  const hs = byY.map(r => r.h);
  const mw = median(ws);
  const mh = median(hs);

  const uniform = (arr, m) => arr.every(v => Math.abs(v - m) <= 0.15 * m);
  if (!uniform(ws, mw) || !uniform(hs, mh)) return [];

  const centers = byY.map(r => r.y + r.h / 2);
  const gaps = [];
  for (let i = 1; i < centers.length; i++) gaps.push(centers[i] - centers[i - 1]);
  const pitch = median(gaps);
  if (!(pitch > mh * 0.8)) return [];

  const mx = median(byY.map(r => r.x));
  const found = [];

  const interiorWhiteRatio = (x, y, bw, bh) => {
    const ix0 = Math.round(x + bw * 0.12), iy0 = Math.round(y + bh * 0.12);
    const ix1 = Math.round(x + bw * 0.88), iy1 = Math.round(y + bh * 0.88);
    if (ix0 < 0 || iy0 < 0 || ix1 >= w || iy1 >= h || ix1 <= ix0 || iy1 <= iy0) return -1;
    let white = 0, total = 0;
    for (let yy = iy0; yy < iy1; yy += 2) {
      for (let xx = ix0; xx < ix1; xx += 2) {
        total++;
        if (isWhite(xx, yy)) white++;
      }
    }
    return total ? white / total : -1;
  };

  // Fraction of perimeter positions that have a non-white pixel (the drawn
  // frame) within a few px of the assumed edge — tolerant of the predicted
  // box being slightly mis-sized/offset from the real one.
  const perimeterBorderRatio = (x, y, bw, bh) => {
    let hit = 0, total = 0;
    const scan = (sx, sy, dx, dy) => {
      total++;
      for (let d = -4; d <= 10; d++) {
        const xx = Math.round(sx + dx * d), yy = Math.round(sy + dy * d);
        if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
        if (!isWhite(xx, yy)) { hit++; return; }
      }
    };
    for (let i = 0; i <= 40; i++) {
      const t = i / 40;
      scan(x + t * bw, y, 0, 1);            // top edge, scan inward
      scan(x + t * bw, y + bh - 1, 0, -1);  // bottom edge
      scan(x, y + t * bh, 1, 0);            // left edge
      scan(x + bw - 1, y + t * bh, -1, 0);  // right edge
    }
    return total ? hit / total : 0;
  };

  const near = (cy, arr) => arr.some(c => Math.abs(c - cy) < pitch * 0.5);

  const tryAt = (cy) => {
    if (cy < 0 || cy > h) return false;
    if (near(cy, centers) || near(cy, found.map(r => r.y + r.h / 2))) return false;
    const x = Math.round(mx);
    const y = Math.round(cy - mh / 2);
    if (interiorWhiteRatio(x, y, mw, mh) < 0.85) return false;
    if (perimeterBorderRatio(x, y, mw, mh) < 0.35) return false;
    found.push({
      x, y, w: Math.round(mw), h: Math.round(mh),
      area: Math.round(mw * mh), extrapolated: true
    });
    return true;
  };

  // Interior gaps (a missed middle box).
  for (let i = 1; i < centers.length; i++) {
    if (centers[i] - centers[i - 1] > pitch * 1.6) tryAt(centers[i - 1] + pitch);
  }
  // Past each end, stopping at the first probe that doesn't look like a box.
  for (let k = 1; k <= 3; k++) if (!tryAt(centers[0] - pitch * k)) break;
  for (let k = 1; k <= 3; k++) if (!tryAt(centers[centers.length - 1] + pitch * k)) break;

  return found;
}

/* ---------------------------------------------------------------------- *
 *  Slot auto-detection
 *  Finds connected "slot-like" regions via flood fill and returns their
 *  bounding boxes sorted in reading order (top-to-bottom, then
 *  left-to-right).
 *
 *  mode 'alpha' (default): a slot pixel is a transparent one (alpha <=
 *    threshold) — a real cut-out hole in the PNG.
 *  mode 'white': a slot pixel is a near-white opaque one. This is a
 *    best-effort guess for templates that were flattened onto a white
 *    background instead of exported with transparency; the operator is
 *    asked to confirm the result before it's saved.
 * ---------------------------------------------------------------------- */
async function detectSlots(imagePath, opts = {}) {
  const image = await Jimp.read(imagePath);
  return detectSlotsFromImage(image, opts);
}

// Same as detectSlots, but on an already-loaded Jimp image — lets a caller
// (detectSlotsForCount) try many parameter combinations against one image
// without re-reading/decoding the PNG each time.
function detectSlotsFromImage(image, opts = {}) {
  const mode = opts.mode ?? 'alpha';
  const alphaThreshold = opts.alphaThreshold ?? 10; // pixels with alpha <= this count as "hole"
  const whiteThreshold = opts.whiteThreshold ?? 240; // min R,G,B for a pixel to count as "white"
  const minAreaFraction = opts.minAreaFraction ?? 0.005; // ignore tiny stray specks
  // Cap only applies to region-guessing modes, where a huge blob is the
  // background rather than a photo slot. Alpha holes have no upper bound.
  const maxAreaFraction = opts.maxAreaFraction ?? (mode === 'alpha' ? 1 : 0.85);
  // Region-guessing shape sanity: reject a slit / sliver (very low bbox
  // fill), and reject frames / rings / L-shapes by requiring the region to
  // be solid across the middle. A real slot — rectangle, ellipse, star,
  // heart, house — is filled along its centre row and centre column; a
  // border ring or an L is not.
  const minRectFill = opts.minRectFill ?? 0.30;
  const minCenterFill = opts.minCenterFill ?? 0.70;
  // 'flat' mode: how far (per RGBA channel) a pixel may drift from a
  // region's first pixel and still count as "the same solid colour".
  const colorTolerance = opts.colorTolerance ?? 16;

  const w = image.bitmap.width;
  const h = image.bitmap.height;
  const data = image.bitmap.data;
  const totalPixels = w * h;
  const minArea = totalPixels * minAreaFraction;
  const maxArea = totalPixels * maxAreaFraction;

  const visited = new Uint8Array(w * h);
  const isSlotPixel = (x, y) => {
    const idx = image.getPixelIndex(x, y);
    if (mode === 'white') {
      return (
        data[idx + 3] >= 128 && // opaque
        data[idx] >= whiteThreshold &&
        data[idx + 1] >= whiteThreshold &&
        data[idx + 2] >= whiteThreshold
      );
    }
    return data[idx + 3] <= alphaThreshold;
  };

  const regions = [];

  // Shared shape check once a region's bounding box + area are known:
  // reject slivers, reject a blob hugging 3+ image edges (that's the
  // outer margin / background frame, not a slot — a real slot can touch
  // at most 2, a corner), and reject frames/rings/L-shapes by requiring
  // the centre row + column to be mostly inside the region.
  function passesShapeCheck(minX, minY, maxX, maxY, area, bw, bh, inRegion) {
    if (area < minArea || area > maxArea) return false;
    const edgesTouched =
      (minX === 0 ? 1 : 0) + (minY === 0 ? 1 : 0) +
      (maxX === w - 1 ? 1 : 0) + (maxY === h - 1 ? 1 : 0);
    if (edgesTouched >= 3) return false;
    if (area / (bw * bh) < minRectFill) return false;
    const cx = (minX + maxX) >> 1;
    const cy = (minY + maxY) >> 1;
    let rowHit = 0;
    for (let x = minX; x <= maxX; x++) if (inRegion(x, cy)) rowHit++;
    let colHit = 0;
    for (let y = minY; y <= maxY; y++) if (inRegion(cx, y)) colHit++;
    return rowHit / bw >= minCenterFill && colHit / bh >= minCenterFill;
  }

  if (mode === 'flat') {
    // Homogeneous-color slots: no fixed target color (white or otherwise)
    // — this segments the *whole* image into same-color connected regions
    // (comparing each pixel to the color the region started with, so a
    // gradient or photo doesn't get treated as one giant "flat" area),
    // then keeps whichever ones pass the same size/shape checks used
    // above. Catches a placeholder box filled with any solid color.
    const labels = new Int32Array(w * h).fill(-1);
    const colorAt = (x, y) => {
      const i = image.getPixelIndex(x, y);
      return [data[i], data[i + 1], data[i + 2], data[i + 3]];
    };
    const closeEnough = (a, b) =>
      Math.abs(a[0] - b[0]) <= colorTolerance && Math.abs(a[1] - b[1]) <= colorTolerance &&
      Math.abs(a[2] - b[2]) <= colorTolerance && Math.abs(a[3] - b[3]) <= colorTolerance;

    let regionIndex = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const flatIdx = y * w + x;
        if (visited[flatIdx]) continue;

        const seed = colorAt(x, y);
        let minX = x, maxX = x, minY = y, maxY = y, area = 0;
        const queue = [[x, y]];
        visited[flatIdx] = 1;
        labels[flatIdx] = regionIndex;

        while (queue.length) {
          const [cx, cy] = queue.pop();
          area++;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          const neighbors = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
          for (const [nx, ny] of neighbors) {
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const nIdx = ny * w + nx;
            if (visited[nIdx] || !closeEnough(colorAt(nx, ny), seed)) continue;
            visited[nIdx] = 1;
            labels[nIdx] = regionIndex;
            queue.push([nx, ny]);
          }
        }

        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;
        const thisRegion = regionIndex;
        regionIndex++;

        if (passesShapeCheck(minX, minY, maxX, maxY, area, bw, bh,
          (px, py) => labels[py * w + px] === thisRegion)) {
          regions.push({ x: minX, y: minY, w: bw, h: bh, area });
        }
      }
    }
  } else {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const flatIdx = y * w + x;
        if (visited[flatIdx]) continue;
        if (!isSlotPixel(x, y)) {
          visited[flatIdx] = 1;
          continue;
        }

        // BFS flood fill to find the extent of this region.
        let minX = x, maxX = x, minY = y, maxY = y, area = 0;
        const queue = [[x, y]];
        visited[flatIdx] = 1;

        while (queue.length) {
          const [cx, cy] = queue.pop();
          area++;
          if (cx < minX) minX = cx;
          if (cx > maxX) maxX = cx;
          if (cy < minY) minY = cy;
          if (cy > maxY) maxY = cy;

          const neighbors = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
          for (const [nx, ny] of neighbors) {
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const nIdx = ny * w + nx;
            if (visited[nIdx]) continue;
            if (!isSlotPixel(nx, ny)) {
              visited[nIdx] = 1;
              continue;
            }
            visited[nIdx] = 1;
            queue.push([nx, ny]);
          }
        }

        const bw = maxX - minX + 1;
        const bh = maxY - minY + 1;

        if (mode === 'white') {
          if (!passesShapeCheck(minX, minY, maxX, maxY, area, bw, bh, isSlotPixel)) continue;
        } else if (area < minArea || area > maxArea) {
          continue;
        }

        regions.push({ x: minX, y: minY, w: bw, h: bh, area });
      }
    }
  }

  // A slot whose border was broken by a decoration leaks into the page
  // background during flood fill, so its merged blob gets rejected and the
  // slot goes missing. Photo strips are near-always a uniform vertical
  // stack, so if what we found looks like one, predict the missing boxes
  // from the pattern and keep those that are white inside with a border.
  if (mode === 'white' && regions.length >= 2) {
    const isWhite = (x, y) => {
      const idx = (y * w + x) * 4;
      return (
        data[idx + 3] >= 128 &&
        data[idx] >= whiteThreshold &&
        data[idx + 1] >= whiteThreshold &&
        data[idx + 2] >= whiteThreshold
      );
    };
    for (const r of extrapolateUniformStrip(regions, w, h, isWhite)) regions.push(r);
  }

  // Reading order: sort by row (bucketed) then column, so slot 1 is
  // top-left, slot 2 is next along, etc. Bucket rows using half the
  // average slot height as tolerance so slightly-offset rows still group.
  const avgH = regions.reduce((s, r) => s + r.h, 0) / (regions.length || 1);
  const rowTolerance = avgH * 0.5;
  regions.sort((a, b) => {
    if (Math.abs(a.y - b.y) > rowTolerance) return a.y - b.y;
    return a.x - b.x;
  });

  return { canvasWidth: w, canvasHeight: h, slots: regions };
}

// The operator knows the real answer ("this template has 4 slots") better
// than any single detection pass does. Given that count, sweep a handful
// of alpha/white parameter combinations against the same loaded image and
// return whichever gets exactly that many slots — the plain defaults are
// tried first, so a normal template still resolves on the first try, just
// like before this existed. If nothing hits the exact count, return the
// closest attempt so the operator still has something concrete to review
// (and, if needed, discard) rather than an outright failure.
async function detectSlotsForCount(imagePath, expectedCount) {
  const target = Math.max(1, Math.round(expectedCount) || 1);
  const image = await Jimp.read(imagePath);

  const attempts = [
    { mode: 'alpha' },
    { mode: 'white' },
    // 'flat' covers a placeholder box filled with any solid color, not
    // just white — a genuine homogeneous-color region, wherever it sits
    // in color space.
    { mode: 'flat' },
    { mode: 'alpha', alphaThreshold: 30 },
    { mode: 'alpha', alphaThreshold: 60 },
    { mode: 'alpha', alphaThreshold: 5 },
    { mode: 'white', whiteThreshold: 230 },
    { mode: 'white', whiteThreshold: 248 },
    { mode: 'white', minAreaFraction: 0.002 },
    { mode: 'white', minAreaFraction: 0.012 },
    { mode: 'white', minRectFill: 0.18, minCenterFill: 0.55 },
    { mode: 'flat', colorTolerance: 8 },
    { mode: 'flat', colorTolerance: 30 },
    { mode: 'flat', minRectFill: 0.18, minCenterFill: 0.55 }
  ];

  // The operator's count outranks the detector's opinion: if an attempt
  // finds more slots than they said, trust them and keep only the
  // `target` most plausible ones rather than insisting on the extra
  // region. "Most plausible" = closest in size to the group's own
  // median — an outlier region (much smaller/larger than its peers) is
  // more likely a false positive than a genuine slot.
  let exactMatch = null;
  let bestOver = null;  // smallest overshoot — least trimming needed
  let bestUnder = null; // smallest shortfall, for when nothing reaches the count at all

  for (const opts of attempts) {
    let result;
    try {
      result = detectSlotsFromImage(image, opts);
    } catch {
      continue;
    }
    const n = result.slots.length;

    if (n === target) {
      exactMatch = { ...result, mode: opts.mode, matched: true, trimmed: false };
      break; // first exact match wins — attempts are ordered "most normal first"
    }
    if (n > target) {
      const overshoot = n - target;
      if (!bestOver || overshoot < bestOver.overshoot) {
        bestOver = { ...result, mode: opts.mode, overshoot };
      }
    } else {
      const shortfall = target - n;
      if (!bestUnder || shortfall < bestUnder.shortfall) {
        bestUnder = { ...result, mode: opts.mode, shortfall };
      }
    }
  }

  if (exactMatch) return exactMatch;

  if (bestOver) {
    return {
      canvasWidth: bestOver.canvasWidth,
      canvasHeight: bestOver.canvasHeight,
      slots: trimToCount(bestOver.slots, target),
      mode: bestOver.mode,
      matched: true,
      trimmed: true
    };
  }

  if (bestUnder) return { ...bestUnder, matched: false, trimmed: false };

  return { canvasWidth: image.bitmap.width, canvasHeight: image.bitmap.height, slots: [], mode: 'alpha', matched: false, trimmed: false };
}

// Drops the least plausible regions until only `target` remain, keeping
// the ones closest in area to the group's median (an outlier size is
// more likely a false positive than a genuine slot), then restores
// reading order (top-to-bottom, then left-to-right).
function trimToCount(slots, target) {
  if (slots.length <= target) return slots;

  const byArea = [...slots].sort((a, b) => a.area - b.area);
  const medianArea = byArea[Math.floor(byArea.length / 2)].area;

  const kept = [...slots]
    .sort((a, b) => Math.abs(a.area - medianArea) - Math.abs(b.area - medianArea))
    .slice(0, target);

  const avgH = kept.reduce((s, r) => s + r.h, 0) / kept.length;
  const rowTolerance = avgH * 0.5;
  kept.sort((a, b) => (Math.abs(a.y - b.y) > rowTolerance ? a.y - b.y : a.x - b.x));
  return kept;
}

// Cuts real transparency into a flattened border PNG: for each slot rect,
// samples its own fill color from its center pixel, then sets alpha to 0
// for every pixel in that rect close to that color. Sampling per slot
// (rather than assuming white) means this works for a placeholder filled
// with any solid color, not just white. Pixels that don't match (e.g.
// decoration overlapping the slot) keep their alpha, so overlapping
// frame art is preserved.
async function punchAlphaSlots(imagePath, slots, opts = {}) {
  const tolerance = opts.colorTolerance ?? 24;
  const image = await Jimp.read(imagePath);
  const w = image.bitmap.width;
  const h = image.bitmap.height;
  const data = image.bitmap.data;

  for (const slot of slots) {
    const x0 = Math.max(0, Math.floor(slot.x));
    const y0 = Math.max(0, Math.floor(slot.y));
    const x1 = Math.min(w, Math.ceil(slot.x + slot.w));
    const y1 = Math.min(h, Math.ceil(slot.y + slot.h));
    if (x1 <= x0 || y1 <= y0) continue;

    const cx = Math.min(x1 - 1, Math.max(x0, Math.round(slot.x + slot.w / 2)));
    const cy = Math.min(y1 - 1, Math.max(y0, Math.round(slot.y + slot.h / 2)));
    const ci = (cy * w + cx) * 4;
    const tr = data[ci], tg = data[ci + 1], tb = data[ci + 2];

    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const idx = (y * w + x) * 4;
        if (
          Math.abs(data[idx] - tr) <= tolerance &&
          Math.abs(data[idx + 1] - tg) <= tolerance &&
          Math.abs(data[idx + 2] - tb) <= tolerance
        ) {
          data[idx + 3] = 0;
        }
      }
    }
  }

  await image.writeAsync(imagePath);
}

// The photo paper is a fixed 10cm x 14.8cm sheet. A template is either
// meant to fill the whole sheet ('full') or one of the two 5cm x 14.8cm
// strips it's cut into ('half'). Guess which from the uploaded PNG's
// aspect ratio — whichever of the two target ratios it's closer to.
const PRINT_SIZE_RATIOS = { full: 100 / 148, half: 50 / 148 };
function classifyPrintSize(canvasWidth, canvasHeight) {
  const ratio = canvasWidth / canvasHeight;
  const dFull = Math.abs(Math.log(ratio / PRINT_SIZE_RATIOS.full));
  const dHalf = Math.abs(Math.log(ratio / PRINT_SIZE_RATIOS.half));
  return dFull <= dHalf ? 'full' : 'half';
}

ipcMain.handle('templates:list', async () => {
  const entries = fs.readdirSync(TEMPLATES_DIR, { withFileTypes: true })
    .filter(e => e.isDirectory());

  const templates = [];
  for (const entry of entries) {
    const dir = path.join(TEMPLATES_DIR, entry.name);
    const metaPath = path.join(dir, 'template.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      // Templates saved before printSize existed: guess it now rather than
      // forcing a re-upload (not persisted here — just for this response).
      if (meta.printSize !== 'full' && meta.printSize !== 'half') {
        meta.printSize = classifyPrintSize(meta.canvasWidth, meta.canvasHeight);
      }
      templates.push({ id: entry.name, ...meta, borderPath: path.join(dir, 'border.png') });
    }
  }
  return templates;
});

ipcMain.handle('templates:add', async (_event, { name }) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select a border template (PNG with transparent photo slots)',
    filters: [{ name: 'PNG Images', extensions: ['png'] }],
    properties: ['openFile']
  });

  if (result.canceled || result.filePaths.length === 0) return null;

  const sourcePath = result.filePaths[0];
  const id = crypto.randomUUID();
  const dir = path.join(TEMPLATES_DIR, id);
  fs.mkdirSync(dir, { recursive: true });

  const borderDest = path.join(dir, 'border.png');
  fs.copyFileSync(sourcePath, borderDest);

  // A quick default-settings pass just to seed the "how many slots?"
  // prompt with a sensible starting number — not the final answer. The
  // renderer asks the operator to confirm/correct the count, then calls
  // templates:detectForCount to do the real, count-targeted detection.
  const detection = await detectSlots(borderDest);
  let guessCount = detection.slots.length;
  if (guessCount === 0) {
    guessCount = (await detectSlots(borderDest, { mode: 'white' })).slots.length;
  }
  if (guessCount === 0) {
    guessCount = (await detectSlots(borderDest, { mode: 'flat' })).slots.length;
  }
  guessCount = guessCount || 1;

  const meta = {
    name: name || path.basename(sourcePath, '.png'),
    canvasWidth: detection.canvasWidth,
    canvasHeight: detection.canvasHeight,
    slots: [], // finalized once the operator confirms a slot count and layout
    autoDetected: false,
    // Best-effort guess; the operator can flip it in the Templates step.
    printSize: classifyPrintSize(detection.canvasWidth, detection.canvasHeight),
    createdAt: new Date().toISOString()
  };

  fs.writeFileSync(path.join(dir, 'template.json'), JSON.stringify(meta, null, 2));

  return { id, ...meta, borderPath: borderDest, guessCount };
});

// The operator has now said how many slots this template should have —
// run the targeted detection sweep and hand back candidates for them to
// confirm (nothing is saved yet; that happens via templates:setSlots or
// templates:punchSlots once they accept).
ipcMain.handle('templates:detectForCount', async (_event, { id, expectedCount }) => {
  const dir = path.join(TEMPLATES_DIR, id);
  const metaPath = path.join(dir, 'template.json');
  if (!fs.existsSync(metaPath)) throw new Error('Template not found');

  const result = await detectSlotsForCount(path.join(dir, 'border.png'), expectedCount);
  return { slots: result.slots, mode: result.mode, matched: result.matched, trimmed: result.trimmed };
});

// Manual override for the auto-guessed printSize (aspect ratio can be
// ambiguous, e.g. a nearly-square multi-slot collage).
ipcMain.handle('templates:setPrintSize', async (_event, { id, printSize }) => {
  if (printSize !== 'full' && printSize !== 'half') throw new Error('Invalid printSize');
  const dir = path.join(TEMPLATES_DIR, id);
  const metaPath = path.join(dir, 'template.json');
  if (!fs.existsSync(metaPath)) throw new Error('Template not found');

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  meta.printSize = printSize;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return meta;
});

// Manual override: if auto-detection finds 0 or the wrong slots (e.g. the
// template has no true alpha holes), the renderer can let the operator
// draw rectangles by hand and save them here instead.
//
// opaqueBorder: set when the border PNG has no transparent holes (the
// white-rectangle fallback). The renderer then draws photos ON TOP of the
// border inside the slot rects, since drawing an opaque border over them
// would otherwise hide the photos entirely.
ipcMain.handle('templates:setSlots', async (_event, { id, slots, opaqueBorder }) => {
  const dir = path.join(TEMPLATES_DIR, id);
  const metaPath = path.join(dir, 'template.json');
  if (!fs.existsSync(metaPath)) throw new Error('Template not found');

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  meta.slots = slots;
  meta.autoDetected = false;
  meta.opaqueBorder = !!opaqueBorder;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return meta;
});

// White-rectangle fallback accepted by the operator: cut actual alpha
// holes into border.png at the detected rects, so it composites like a
// normal transparent template (photo behind, opaque frame in front).
ipcMain.handle('templates:punchSlots', async (_event, { id, slots }) => {
  const dir = path.join(TEMPLATES_DIR, id);
  const metaPath = path.join(dir, 'template.json');
  if (!fs.existsSync(metaPath)) throw new Error('Template not found');

  await punchAlphaSlots(path.join(dir, 'border.png'), slots);

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
  meta.slots = slots;
  meta.autoDetected = false;
  meta.opaqueBorder = false; // it now has real holes
  meta.alphaPunched = true;
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
  return meta;
});

ipcMain.handle('templates:delete', async (_event, { id }) => {
  const dir = path.join(TEMPLATES_DIR, id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  return true;
});

/* ---------------------------------------------------------------------- *
 *  Saved strips (template + photos + per-slot adjustments), one JSON
 *  file per strip under STRIPS_DIR.
 * ---------------------------------------------------------------------- */
// Keep ids to a safe filename charset — they end up in a path.
const safeStripId = (id) => String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');

ipcMain.handle('strips:list', async () => {
  return fs.readdirSync(STRIPS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(STRIPS_DIR, f), 'utf-8')); }
      catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
});

// A saved job = one whole sheet: its layout ('single' | 'double'), the
// template(s) used (one id, or two for independent left/right strips),
// and the flattened photos + adjustments across all of that sheet's slots
// (left strip's slots first, then right's, reading order within each).
ipcMain.handle('strips:save', async (_event, { id, name, layout, templateIds, photoPaths, adjustments, thumbnail }) => {
  const recId = safeStripId(id) || crypto.randomUUID();
  const record = {
    id: recId,
    name: name || 'Untitled job',
    layout: layout === 'double' ? 'double' : 'single',
    templateIds: Array.isArray(templateIds) ? templateIds.filter(Boolean) : [],
    photoPaths: Array.isArray(photoPaths) ? photoPaths : [],
    adjustments: Array.isArray(adjustments) ? adjustments : [],
    thumbnail: thumbnail || null,
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(STRIPS_DIR, `${recId}.json`), JSON.stringify(record, null, 2));
  return record;
});

ipcMain.handle('strips:delete', async (_event, { id }) => {
  const recId = safeStripId(id);
  if (!recId) return false;
  const p = path.join(STRIPS_DIR, `${recId}.json`);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return true;
});

/* ---------------------------------------------------------------------- *
 *  Gallery: browse a local folder (e.g. a Google Drive Desktop sync
 *  folder) that customers pre-upload their photos into.
 * ---------------------------------------------------------------------- */
ipcMain.handle('gallery:getFolder', async () => {
  return readConfig().galleryFolder || null;
});

ipcMain.handle('gallery:chooseFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Select the synced Google Drive folder customers upload photos to',
    properties: ['openDirectory']
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const folder = result.filePaths[0];
  writeConfig({ galleryFolder: folder });
  return folder;
});

// Lists images in the configured folder, newest first. Prefers the
// photo's own EXIF capture date (DateTimeOriginal) so it reflects when
// the picture was actually taken; falls back to file modified time for
// images without EXIF data (screenshots, edited/re-exported files, etc.)
ipcMain.handle('gallery:list', async () => {
  const folder = readConfig().galleryFolder;
  if (!folder || !fs.existsSync(folder)) return [];

  const entries = fs.readdirSync(folder, { withFileTypes: true })
    .filter(e => e.isFile() && IMAGE_EXTENSIONS.has(path.extname(e.name).toLowerCase()));

  const photos = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(folder, entry.name);
    const stat = fs.statSync(fullPath);
    let datetime = stat.mtime;
    let dateSource = 'file modified time';

    try {
      const exifDate = await exifr.parse(fullPath, ['DateTimeOriginal', 'CreateDate']);
      if (exifDate?.DateTimeOriginal) {
        datetime = exifDate.DateTimeOriginal;
        dateSource = 'photo capture time (EXIF)';
      } else if (exifDate?.CreateDate) {
        datetime = exifDate.CreateDate;
        dateSource = 'photo capture time (EXIF)';
      }
    } catch {
      // Not all formats/files have parseable EXIF — mtime fallback is fine.
    }

    return {
      path: fullPath,
      filename: entry.name,
      datetime: datetime.toISOString(),
      dateSource
    };
  }));

  photos.sort((a, b) => new Date(b.datetime) - new Date(a.datetime));
  return photos;
});

/* ---------------------------------------------------------------------- *
 *  Printer handling
 * ---------------------------------------------------------------------- */
ipcMain.handle('printers:list', async () => {
  return mainWindow.webContents.getPrintersAsync();
});

// Prints the finished composited image by writing it (plus a tiny wrapper
// HTML) to temp files, loading that into a hidden window, and invoking
// Electron's print with an explicit device name so it can go straight to
// the SELPHY without a dialog. Temp files are used because inlining a
// multi-MB PNG data URL into a data:text/html URL overflows Chromium's
// URL length limit (ERR_INVALID_URL).
ipcMain.handle('print:image', async (_event, { dataUrl, deviceName, silent, pageSize }) => {
  const stamp = crypto.randomUUID();
  const tmpDir = app.getPath('temp');
  const imgPath = path.join(tmpDir, `pbk-print-${stamp}.png`);
  const htmlPath = path.join(tmpDir, `pbk-print-${stamp}.html`);

  // 1 mm = 1000 microns. Default to the 100mm x 148mm ("postcard") sheet
  // if the caller didn't pass an explicit size.
  const wMm = (pageSize?.widthMicrons || 100 * 1000) / 1000;
  const hMm = (pageSize?.heightMicrons || 148 * 1000) / 1000;

  const base64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  fs.writeFileSync(imgPath, Buffer.from(base64, 'base64'));
  // Force the image to fill the whole page: an @page box with zero margin
  // at the exact paper size, and an image stretched edge-to-edge over it.
  // (The composite is already built at the sheet's aspect ratio, so
  // "fill" isn't visibly distorting.)
  fs.writeFileSync(
    htmlPath,
    `<!doctype html><html><head><style>
      @page { size: ${wMm}mm ${hMm}mm; margin: 0; }
      html, body { margin: 0; padding: 0; width: 100%; height: 100%; }
      img { position: absolute; inset: 0; width: 100%; height: 100%;
            object-fit: fill; display: block; }
    </style></head><body><img src="${path.basename(imgPath)}" /></body></html>`
  );

  const cleanup = () => {
    for (const p of [imgPath, htmlPath]) {
      try { fs.unlinkSync(p); } catch { /* best effort */ }
    }
  };

  const printWindow = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
  await printWindow.loadFile(htmlPath);

  const printOptions = {
    silent: !!silent,
    deviceName: deviceName || undefined,
    // 'none' = zero margins (needs the printer set to borderless for a
    // true full-bleed edge). marginsType:0 was "default margins" — that's
    // what was shrinking the print inside the sheet.
    margins: { marginType: 'none' },
    landscape: false,
    scaleFactor: 100,
    printBackground: true
  };
  // Explicit paper size (microns) so the strip sheet prints at its
  // intended size regardless of the printer's default page size.
  if (pageSize?.widthMicrons && pageSize?.heightMicrons) {
    printOptions.pageSize = { width: pageSize.widthMicrons, height: pageSize.heightMicrons };
  }

  return new Promise((resolve, reject) => {
    printWindow.webContents.print(
      printOptions,
      (success, failureReason) => {
        printWindow.close();
        cleanup();
        if (success) resolve({ success: true });
        else reject(new Error(failureReason || 'Print was canceled'));
      }
    );
  });
});
