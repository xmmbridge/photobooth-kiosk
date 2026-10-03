# Photobooth Kiosk

An Electron desktop app for a PC-based photobooth kiosk. The photo
paper is a fixed **10cm × 14.8cm** sheet, and the app is a 5-step
wizard — **Layout → Templates → Photos → Order → Preview** — always
shown as tabs, so the operator can jump back to any earlier step to
make changes:

1. **Layout** — exactly two choices: one 10×14.8cm print, or two
   5×14.8cm strips side by side (cut apart after printing).
2. **Templates** — pick the border template(s) for that layout (border
   PNGs with transparent/white photo slots, auto-detected).
3. **Photos** — gather exactly as many photos as the template(s) need,
   from this device (any number of picks, any folder) and/or a Google
   Drive gallery.
4. **Order** — drag (or use the arrows) to put the photos in slot
   order; replace any one of them.
5. **Preview** — per-slot crop/zoom, live sheet preview, print, and save
   each strip for later (left and right strips save separately).

## Setup

```bash
npm install
npm start
```

`npm start` runs the app in a normal window. A packaged build (see
**Building a deployable copy**) launches **fullscreen kiosk** mode
automatically.

- Force kiosk on while developing: `KIOSK=1 npm start`
  (PowerShell: `$env:KIOSK=1; npm start`)
- Force it off in a packaged build: set `KIOSK=0` in the environment
- Kiosk mode traps the user — press **Ctrl/Cmd + Shift + Q** to quit.

## Building a deployable copy

```bash
npm install
npm run dist
```

This runs [electron-builder](https://www.electron.build/) and writes
installers to `dist/`:

- **Windows** — an NSIS installer (`XMMBRIDGE Photobooth Setup <ver>.exe`,
  lets the operator choose the install folder) and a single-file
  `portable` `.exe` that runs without installing.
- **macOS** — a `.dmg`. **Linux** — an `AppImage`.

By default electron-builder targets the OS you run it on. Notes:

- `npm run pack` produces an unpacked app in `dist/<platform>-unpacked/`
  without building an installer — handy for a quick test.
- App icon: drop `build/icon.ico` (Windows, 256×256) and/or
  `build/icon.icns` (macOS) and rebuild; otherwise the default Electron
  icon is used.
- Templates, saved strips and the gallery-folder setting are **not**
  bundled — they live in the per-user data folder on whatever machine
  the app runs on, so each kiosk PC is configured once after install.
- The `build` block in `package.json` holds appId, product name,
  targets and NSIS options.

## Printer setup (one-time, on the kiosk PC)

1. Install Canon's official driver for the SELPHY CP1500 and connect it
   over USB or Wi-Fi so it shows up as a normal printer in Windows/macOS.
2. Load the correct paper cassette for your print size.
3. In the driver's printing preferences set the paper to **100 × 148mm
   (Postcard)** and enable **Borderless / no margins**. The app asks
   Chromium for zero margins and a 100mm × 148mm page and stretches the
   image edge-to-edge, but if the driver itself is set to a bordered
   layout you'll still get a white frame — that setting lives in the
   driver, not the app.
4. Launch the app — the printer dropdown on the Preview step lists all
   installed printers and auto-selects anything with "SELPHY" in the name.
5. Test a print with the print dialog visible first (`silent: false`,
   already the default). Once you've confirmed the right printer/paper
   size prints correctly, flip `silent` to `true` in `main.js`'s
   `print:image` call site so customers never see a system dialog.
6. **Print a calibration sheet** (button on the Preview step, below
   Print — works with any job loaded) before trusting real prints. It's
   a ruler/crosshair/registration pattern sent through the exact same
   print path as a real job, at the exact same 100×148mm size. Measure
   the printed result:
   - The outer line should land exactly at the paper edge after any
     trim, with all four corner marks present.
   - The concentric **rings** (labelled 2, 4, 6, 8, 10) are mm in from
     the page edge. The outermost ring still visible on each side is
     how many mm that side is losing — read it straight off the print,
     no ruler needed. Equal loss on all sides suggests the driver is
     enlarging the image (borderless "overscan"); loss on one side
     only suggests an offset.
   - The numbered ticks should measure true to their millimetre labels.
   - If content is offset, cropped, or runs past the paper edge, the
     driver's paper size doesn't match ours — a common culprit is the
     driver reporting "4×6 in" (101.6×152.4mm, the US size) for paper
     that's physically 100×148mm (the JIS/ISO postcard size most
     SELPHY cassettes actually use), or vice versa. Check the exact
     size listed for your loaded cassette and set the driver's paper
     size to match it precisely, not just the closest named preset.
   **Correcting an enlarging driver:** if a "20 mm" interval measures
   longer than 20mm on the print (say 21.5mm), the driver is enlarging
   the image (here 7.5%) and cropping every edge. Enter that measurement
   in the **Measured "20 mm" mark** box on the Preview step (saved
   between runs). Every print — including the calibration sheet — is
   then pre-shrunk by that factor and centred, with the margin filled by
   extending the sheet's own edge pixels (`compensateForPrinter()` in
   `renderer/app.js`), so the driver's enlargement lands it exactly on
   the paper. Leave it at 20 for no correction. Assumes the same scale
   horizontally and vertically.

   This isolates printer/driver setup from the app itself — the pattern
   renders from `buildCalibrationSheet()` in `renderer/app.js`, not from
   any job data, so if it prints correctly but real jobs don't, the bug
   is in this app's compositing, not the print pipeline.

## Adding border templates

Click **"+ Upload Template"** (top-right, available from any step) and
pick a PNG. The best case is one where the areas meant to hold photos
are **fully transparent** (alpha = 0) — like a picture frame with
cut-out holes — but that's not required; see below.

A working example is included at
`sample-assets/example-4-slot-border.png` — a plain white strip with
4 transparent slots — so you can try the flow end-to-end before making
real artwork.

**You're asked how many photo slots the template has** right after
picking it (pre-filled with a quick guess). That number drives the
detection: `detectSlotsForCount()` in `main.js` tries a series of
strategies against the image and keeps the first one that finds
*exactly* that many slots —

1. **Real transparency** — a true alpha cut-out hole in the PNG.
2. **Near-white regions** — a placeholder flattened onto a white
   background.
3. **Any homogeneous-color region** — a placeholder filled with a
   *single flat color*, whatever that color is (not just white) —
   pixels are grouped by closeness to whichever color a region started
   with, so this doesn't need to know the color in advance.

Whichever strategy wins is shown for confirmation — the region need not
be rectangular; ellipses, stars, hearts, house shapes etc. are fine, as
long as each one is filled solid through its middle (a frame / ring /
L-shape is rejected as decoration, not a slot) and its bounding box
becomes the photo slot.

**Your count always wins over the raw detector.** If a strategy finds
*more* regions than you said, the app trusts you, not the detector —
it keeps only that many, dropping whichever regions are the size
outliers of the group (`trimToCount()` in `main.js`; a stray decoration
that happened to pass the shape checks is usually the odd one out,
size-wise). Only if nothing reaches your count at all does it fall back
to showing its closest attempt, flagged so you check it carefully. For
a white-detected uniform vertical strip, detection also predicts boxes
in any gap and just past each end — this recovers a slot whose border
was broken by overlapping artwork. Predicted boxes show with a dashed
amber
outline in the confirmation dialog — eyeball them.

**If detection got a box wrong, fix it right there** — the confirmation
canvas is a live editor, not just a preview:
- **drag** a box to move it
- **drag a corner** to resize it
- click its **×** to delete it
- **drag on empty space** to draw a new one
- **Reset to detected** throws away your edits and starts over from
  what detection found

Moving or resizing a box clears its "predicted" flag (it's now a
manual call, not a guess). "Yes, use these" is disabled while zero
boxes remain — you can't accept an empty template.

Click **"Yes, use these"** to accept. If the winning strategy wasn't
real transparency, the app cuts transparent holes into the stored copy
of the template at those spots — sampling each slot's own fill color
(`punchAlphaSlots()`), so it behaves like a natively-transparent border
from then on regardless of what color the placeholder was, and
regardless of whether the box came from detection or was hand-drawn.
Click **"No, discard"** to throw the template away and re-export from
your design tool, or re-upload with a different slot count.

**Which sheet size is a template for?** Every template is tagged
`printSize: 'full'` (10×14.8cm) or `'half'` (5×14.8cm), guessed from
the uploaded PNG's aspect ratio (`classifyPrintSize()` in `main.js`).
To remove a template, click the **×** in its top-right corner on the
Templates step (it asks first, and warns if saved strips use it —
those can't reopen once their template is gone). Hovering a template
shows a larger preview next to the cursor (it
follows the mouse and flips sides near a window edge). The Templates
step only offers templates matching the layout the
operator chose. If the guess is wrong, each template card has a **"Use
as …"** link to flip it.

**Design tips for templates:**
- The auto-crop fills each slot's **bounding box** with "cover"
  fitting (like CSS `object-fit: cover`).
- Keep each slot solid through its middle — a frame, ring, or L-shaped
  area is treated as decoration, not a slot.
- Keep each slot a single flat fill color distinct from its
  surroundings (any color — it doesn't have to be white), or fully
  transparent, so it isn't mistaken for decoration or merged with the
  background.
- Author at the sheet's real proportions for a full-bleed result: a
  10×14.8cm template at e.g. 1181×1748px, a 5×14.8cm one at e.g.
  590×1748px (300 DPI). Off-ratio templates still work — they're
  contain-fitted into the sheet with white margins.

## Phone camera (photos sent straight to the booth over Wi-Fi)

Use a phone as the booth camera: every photo it takes shows up in the
gallery within a second or two — no cloud, no accounts, no internet.

1. On the **Photos** step, click **Phone / Drive gallery**. A QR code
   appears at the top of the panel.
2. Scan it **once** with the phone's camera app and open the link. In
   Chrome, use ⋮ → **Add to Home screen** so it's a one-tap icon later.
3. Tap **Take photo** (front/back camera toggle below it). The photo
   uploads automatically; a row shows "Sent ✓", or "Failed — tap to
   retry" if the Wi-Fi hiccupped. Photos appear in the gallery marked
   **NEW** (the gallery button also shows a "(N new)" count while it's
   closed). Click one to add it to the job, like any gallery photo.

Notes:
- The phone and the PC must be on the **same Wi-Fi network**.
- **Scanning is a one-time step.** The link contains a secret token kept
  in `config.json` (it survives app restarts), so the home-screen
  shortcut keeps working. It breaks only if the PC's IP address changes
  (routers can reassign it after a restart) — either rescan the QR code,
  or give the PC a fixed IP in the router ("DHCP reservation").
- First run, Windows asks whether to allow the app on the network —
  choose **Private networks**. If the phone can't open the link, check
  that prompt wasn't dismissed (Windows Defender Firewall → allow
  XMMBRIDGE Photobooth / Electron on Private).
- If the PC has several network adapters (VirtualBox, WSL, VPN…) the QR
  uses the Wi-Fi one; the other candidate addresses are listed under the
  QR code in case the first guess is the wrong network.
- Set the phone's screen timeout to something long — a web page can't
  keep an Android screen awake over plain http.
- Phone shots are shrunk to at most 2400 px on the long side before
  sending (the print is only ~1181×1748, so nothing is lost, and
  uploads are much faster). Photos are saved to `phone-uploads/` in the
  app's data folder; **Clear phone photos** in the gallery panel empties
  it. Photos already added to the current job stay, but saved strips that
  used them can't reopen afterwards.
- Upload-only by design: the phone page can't list or download anything,
  every route requires the token, only images up to 25 MB are accepted,
  and the file name is always chosen by the app (never the phone).
- The Google Drive folder below still works alongside this; the gallery
  shows both together, newest first.

The server is `phone-server.js` (plain Node `http`, no Electron
dependency); `main.js` starts it with the app, and the gallery refreshes
the moment an upload lands (`gallery:changed`) instead of waiting for
the 5-second poll.

## Gallery / Google Drive folder setup

This app doesn't talk to Google Drive's API directly — it reads whatever
local folder **Google Drive Desktop** (or Drive for Desktop) is already
syncing to. That keeps things simple and offline-friendly: no Google
OAuth, no internet dependency at kiosk runtime, just a folder on disk.

1. Install [Google Drive Desktop](https://www.google.com/drive/download/)
   on the kiosk PC and sign in to whichever Google account/shared folder
   customers will upload their photos to.
2. Pick (or create) a dedicated folder for this — e.g. a shared Drive
   folder named "Photobooth uploads" — and make sure it's set to sync
   locally (not "online only").
3. On the **Photos** step, click **Phone / Drive gallery**, then
   **Set / change Drive folder** and choose that local synced folder.
   This is saved and reused after that. (The Drive folder is optional —
   the gallery works with phone uploads alone.)
4. Customers upload photos into that Drive folder from their phone (the
   Drive mobile app, or a shared upload link). The gallery panel
   auto-refreshes every 5 seconds while open, so new uploads show up
   without restarting the app. Click a photo to add it to the pool for
   this job; click again to remove it.

**Sorting**: photos are sorted newest-first using each photo's own EXIF
capture date (`DateTimeOriginal`) when available — i.e. when the
picture was actually taken, not when it happened to sync. Files
without EXIF data (screenshots, re-saved/edited images) fall back to
file-modified time.

**Supported formats**: `.jpg .jpeg .png .webp .heic .heif`. HEIC/HEIF
(the default format for iPhone photos) will list and sort correctly,
but note that Chromium's `<img>` tag can't always render HEIC directly
for the thumbnail/preview — if you see broken thumbnails for iPhone
uploads, either have customers export as JPEG when uploading, or add a
HEIC→JPEG conversion step server-side (flagging this as a known gap
rather than something already handled).

## The Photos → Order split

**Photos** is just gathering: add from device and/or gallery, in any
order, until the pool has exactly as many photos as the chosen
template(s) need (`wizard.photoPool` in `renderer/app.js`). **Order**
is a dedicated step for arranging that pool into slot order — drag a
thumbnail (or use the arrows), **⟳** replaces one photo. For the
2-strip layout, positions are labelled `Left #1, #2, … / Right #1, #2,
…` — left-strip slots come first in the flattened order, then the
right strip's.

Reordering resets crop adjustments (they're geometry-dependent, and
cropping happens next, on Preview) — a replace only resets that one
photo's crop.

## How compositing & the Preview step work

1. Each photo starts scaled and center-cropped to fill its slot's
   bounding box (no stretching/distortion) — `defaultAdjust()`.
2. Each strip (one for a single sheet, two for double) is composited
   off-screen by `renderSideStrip()`: photos into their slots, the
   border PNG drawn on top (its holes reveal the photos, its opaque
   design masks the edges).
3. The **sheet preview** is the one thing shown on the Preview step —
   the assembled 10×14.8cm sheet, with each strip contain-fitted into
   its half and a dashed cut guide (screen only, never printed;
   `buildSheetCanvas()`). It is also the editor, so there's no
   separate per-strip canvas duplicating it: **drag** a photo right on
   the sheet to reposition it, **scroll** to zoom, **double-click** a
   photo (or **Reset all**) to reset it. A click is mapped back into
   whichever strip it landed in (`sheetPlacements()`,
   `slotUnderPointer()`). With **identical copies**, both halves are
   the same strip, so adjusting either one adjusts both. Zooming out
   stops at "photo covers the slot" by default but can go further, down
   to the whole photo fitting inside the slot with white padding around
   it (`minZoomFor()`).
4. The printing controls (printer, Print, Save / use-a-saved-strip
   buttons, Start new order) are a compact last column; the printer-calibration tools are tucked into
   a collapsed **Printer calibration** section.
5. **Print** builds the same sheet, exports it as a PNG, and sends it
   with an explicit 100mm × 148mm page size. Each strip has its own
   **Save** button (see below). **Start new order** resets the wizard
   for the next customer.

When a template was accepted via the white- or flat-color fallback, its
`border.png` already has real cut alpha holes punched in at upload
time, so it composites exactly like a natively-transparent template —
no special-casing needed at print time.

## Saving strips, and mixing them

What gets saved is **one print** — a single 5×14.8cm strip, or a single
10×14.8cm design — not a whole sheet. So on a two-strip sheet the **left
and right strips are saved separately**: under *Save* on the Preview step
there's one button per strip (**Save left strip** / **Save right strip**;
just **Save strip** for identical copies; **Save print** for a single
10×14.8cm sheet). Each asks for a name, then stores the strip's template,
the file path of each of its photos (in slot order), each slot's crop,
and a thumbnail — one JSON file under Electron's userData folder
(`strips/<uuid>.json`). No photo pixels are copied, just paths.

Using a saved strip:

- **Saved strips** on the Layout step: click one to print it again as it
  was — a 5cm strip comes up as **two identical copies** on a sheet, a
  10cm print as a single sheet. (`useSavedStrip()`)
- **Under *Use a saved strip*** on the Preview step: **Replace left
  strip…** / **Replace right strip…** opens a picker of saved strips of
  the right size and swaps just that side, leaving the other as it was.
  Replace both sides with different strips and you've mixed two saved
  strips onto one sheet. (`replaceSide()`; identical copies are split
  into two separate sides the first time you do this.)

A 5cm strip can't be put on a 10cm print or vice-versa — you get a
message and nothing changes. Because only paths are stored:

- The photo files must still exist at the same location. If one was
  moved or deleted, loading is refused with a message and the sheet is
  left alone.
- Drag-dropped or pasted images have no path and can't be saved — Save
  says so instead of saving a broken strip.
- If the template was deleted, or its slot count changed since the
  save, loading is refused.

Older versions saved a whole sheet at once. Those records still show up
in the gallery (labelled "whole sheet") and still open; they just
aren't written any more.

IPC lives in `main.js` (`strips:list` / `strips:save` /
`strips:delete`); the renderer side is `saveStrip()`, `hydrateStrip()`,
`showStrips()`, `replaceSide()`, `useSavedStrip()` and
`refreshSavedJobs()` in `renderer/app.js`.

## Project structure

```
main.js              Electron main process: window/kiosk mode, slot
                      detection, print-size classification, template +
                      saved-job storage, gallery listing, printer IPC
phone-server.js       Phone camera upload server + the phone's camera
                      page (plain Node http; testable without Electron)
preload.js            Safe IPC bridge exposed to the renderer as
                      window.kiosk
renderer/
  index.html           The 5-step wizard shell (tabs + one <section>
                        per step) plus the template-name and slot-
                        confirmation dialogs
  style.css
  app.js               Wizard state + navigation, template picking
                        (grouped by print size / slot count), photo
                        gathering (device + gallery), drag-to-reorder,
                        per-slot crop editing, sheet compositing,
                        save/reload, print trigger
sample-assets/
  example-4-slot-border.png   Try-it-out template
```

## Notes / next steps

- Templates are stored under Electron's per-OS userData folder (so
  they persist across app restarts) as `templates/<uuid>/border.png` +
  `template.json` (canvas size, slot rectangles, print size). Saved
  jobs live alongside as `strips/<uuid>.json`.
- If a template's slots come out wrong (or you just want to tweak
  them), delete it and re-upload the same PNG — the confirmation
  dialog on upload is a full manual editor, not just a preview (see
  **Adding border templates**). There's no way to re-edit an
  already-saved template's slots without going through upload again.
- Packaging is wired up with `electron-builder` (`npm run dist`) — see
  **Building a deployable copy**.
