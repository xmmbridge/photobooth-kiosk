// Receives photos from a phone over the local network.
//
// A tiny HTTP server (no Electron dependency, so it can be tested on its
// own). The phone opens  http://<this-pc>:<port>/u/<token>/  — a small
// camera page — and each photo it takes is POSTed back to
// /u/<token>/upload as a raw image body. Files land in `inboxDir`, which
// the gallery reads alongside the Google Drive folder.
//
// Deliberately upload-only: nothing here lists or serves files back, and
// every route requires the secret token, so being on the same Wi-Fi isn't
// enough to see or inject anything.

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const MAX_BYTES = 25 * 1024 * 1024;
const EXT_BY_TYPE = {
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/heic': '.heic',
  'image/heif': '.heif'
};

function tokensEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// --- Finding an address the phone can actually reach ----------------------
const VIRTUAL_NAME = /vethernet|wsl|virtualbox|vmware|hyper-v|docker|tailscale|zerotier|loopback|bluetooth|vpn|tap-|npcap/i;
const isPrivate = (ip) =>
  /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

// Virtual adapters often have an innocuous name ("Ethernet 4") but a giveaway
// MAC vendor prefix: VirtualBox, VMware, Hyper-V, Parallels, QEMU, Xen.
const VIRTUAL_MAC = /^(0a:00:27|08:00:27|00:50:56|00:0c:29|00:05:69|00:1c:14|00:15:5d|00:1c:42|52:54:00|00:16:3e)/i;
const WIFI_NAME = /wi-?fi|wlan|wireless|^en0$|^wl/i;

// LAN IPv4 addresses, best guess first. A phone can only reach the real
// network, so virtual adapters (WSL / Hyper-V / VirtualBox / VPN — they have
// private addresses too) go last; Wi-Fi goes first (that's where the phone
// is), then wired; within those, 192.168.x.x (typical home router) before
// 10.x / 172.x. The caller shows every candidate, so a wrong guess is
// recoverable.
function lanAddresses(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs || []) {
      const v4 = a.family === 'IPv4' || a.family === 4;
      if (!v4 || a.internal || !isPrivate(a.address)) continue;
      const virtual = VIRTUAL_NAME.test(name) || VIRTUAL_MAC.test(a.mac || '');
      const rank =
        (virtual ? 100 : 0) +
        (WIFI_NAME.test(name) ? 0 : 10) +
        (a.address.startsWith('192.168.') ? 0 : 1);
      found.push({ name, address: a.address, rank });
    }
  }
  return found.sort((x, y) => x.rank - y.rank).map(({ name, address }) => ({ name, address }));
}

// --- The page the phone sees ---------------------------------------------
function phonePageHtml() {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#111827">
<title>XMMBRIDGE Camera</title>
<style>
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,sans-serif;background:#111827;color:#f3f4f6;
       display:flex;flex-direction:column;align-items:center;min-height:100vh;padding:20px}
  h1{font-size:16px;margin:6px 0 18px;color:#9ca3af;font-weight:600}
  .big{display:flex;align-items:center;justify-content:center;width:100%;max-width:420px;
       height:36vh;min-height:170px;background:#6366f1;color:#fff;border-radius:24px;
       font-size:28px;font-weight:700;cursor:pointer;user-select:none;-webkit-tap-highlight-color:transparent}
  .big:active{background:#4f46e5}
  .row{display:flex;gap:10px;margin:16px 0 6px;width:100%;max-width:420px}
  .seg{flex:1;padding:12px;text-align:center;border-radius:12px;background:#1f2937;
       border:2px solid transparent;cursor:pointer;user-select:none}
  .seg.on{border-color:#22c55e}
  .link{color:#a5b4fc;text-decoration:underline;cursor:pointer;margin:10px 0}
  ul{list-style:none;padding:0;margin:8px 0;width:100%;max-width:420px}
  li{padding:10px 12px;margin:6px 0;background:#1f2937;border-radius:10px;
     display:flex;justify-content:space-between;gap:8px;font-size:14px}
  .ok{color:#22c55e}.err{color:#f87171;cursor:pointer}.wait{color:#9ca3af}
  input[type=file]{display:none}
</style></head><body>
<h1>XMMBRIDGE Photobooth Camera</h1>
<label class="big" for="cam">&#128247; Take photo</label>
<input type="file" id="cam" accept="image/*" capture="user">
<div class="row">
  <div class="seg on" id="front">Front camera</div>
  <div class="seg" id="back">Back camera</div>
</div>
<label class="link" for="pick">Choose existing photos&hellip;</label>
<input type="file" id="pick" accept="image/*" multiple>
<ul id="log"></ul>
<script>
(function () {
  var MAX_DIM = 2400; // the print is only ~1181x1748, so this loses nothing
  var base = location.pathname.replace(/\\/$/, '');
  var cam = document.getElementById('cam');
  var pick = document.getElementById('pick');
  var front = document.getElementById('front');
  var back = document.getElementById('back');
  var log = document.getElementById('log');
  var mode = 'user';
  try { mode = localStorage.getItem('camMode') || 'user'; } catch (e) {}

  function applyMode() {
    cam.setAttribute('capture', mode);
    front.classList.toggle('on', mode === 'user');
    back.classList.toggle('on', mode === 'environment');
  }
  function setMode(m) {
    mode = m;
    try { localStorage.setItem('camMode', m); } catch (e) {}
    applyMode();
  }
  front.onclick = function () { setMode('user'); };
  back.onclick = function () { setMode('environment'); };
  applyMode();

  // Shrink big camera shots before sending — much faster over Wi-Fi.
  // Drawing through an <img> applies the photo's EXIF rotation.
  function shrink(file) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        try {
          var s = Math.min(1, MAX_DIM / Math.max(img.naturalWidth, img.naturalHeight));
          if (s >= 1) { URL.revokeObjectURL(url); resolve(file); return; }
          var c = document.createElement('canvas');
          c.width = Math.round(img.naturalWidth * s);
          c.height = Math.round(img.naturalHeight * s);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          URL.revokeObjectURL(url);
          c.toBlob(function (b) { resolve(b || file); }, 'image/jpeg', 0.9);
        } catch (e) { resolve(file); }
      };
      img.onerror = function () { URL.revokeObjectURL(url); resolve(file); };
      img.src = url;
    });
  }

  function addItem(name) {
    var li = document.createElement('li');
    var a = document.createElement('span');
    var b = document.createElement('span');
    a.textContent = name;
    li.appendChild(a); li.appendChild(b);
    log.insertBefore(li, log.firstChild);
    return {
      set: function (text, cls) { b.textContent = text; b.className = cls; },
      onTap: function (fn) { li.onclick = fn; }
    };
  }

  // row is passed on a retry, so the same list entry flips back from
  // "Failed" to "Sending" instead of piling up a duplicate.
  function send(file, row) {
    var item = row || addItem(file.name || 'photo');
    item.set('Sending\\u2026', 'wait');
    return shrink(file).then(function (body) {
      return fetch(base + '/upload', {
        method: 'POST',
        headers: { 'Content-Type': body.type || file.type || 'image/jpeg' },
        body: body
      });
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      item.set('Sent \\u2713', 'ok');
      item.onTap(null);
    }).catch(function () {
      item.set('Failed \\u2014 tap to retry', 'err');
      item.onTap(function () { item.onTap(null); send(file, item); });
    });
  }

  // One at a time, in order, so a burst of photos doesn't flood the Wi-Fi.
  var queue = Promise.resolve();
  function handle(input) {
    var files = Array.prototype.slice.call(input.files);
    input.value = '';
    files.forEach(function (f) { queue = queue.then(function () { return send(f); }); });
  }
  cam.onchange = function () { handle(cam); };
  pick.onchange = function () { handle(pick); };
})();
</script>
</body></html>`;
}

// --- The server -----------------------------------------------------------
function createPhoneServer({ inboxDir, token, onUpload }) {
  fs.mkdirSync(inboxDir, { recursive: true });

  const server = http.createServer((req, res) => {
    const send = (code, body, type = 'text/plain') => {
      res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };

    const { pathname } = new URL(req.url, 'http://x');
    const m = /^\/u\/([^/]+)(\/upload)?\/?$/.exec(pathname);
    // Same answer for "no such route" and "wrong token" — reveals nothing.
    if (!m || !tokensEqual(m[1], token)) return send(404, 'Not found');

    if (req.method === 'GET' && !m[2]) {
      return send(200, phonePageHtml(), 'text/html; charset=utf-8');
    }
    if (req.method === 'POST' && m[2]) {
      return receiveUpload(req, res, send);
    }
    return send(404, 'Not found');
  });

  function receiveUpload(req, res, send) {
    const type = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = EXT_BY_TYPE[type];
    if (!ext) { req.resume(); return send(415, 'Unsupported type'); }

    const declared = parseInt(req.headers['content-length'] || '0', 10);
    if (declared > MAX_BYTES) { req.resume(); return send(413, 'Too large'); }

    // Never use the client's filename — name it ourselves, so nothing a
    // phone sends can influence where the file lands.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const finalName = `${stamp}-${crypto.randomBytes(3).toString('hex')}${ext}`;
    const tmpPath = path.join(inboxDir, `${finalName}.part`); // .part isn't an image extension, so the gallery ignores it
    const out = fs.createWriteStream(tmpPath);

    let bytes = 0;
    let failed = false;
    const fail = (code, msg) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.unlink(tmpPath, () => {});
      if (!res.headersSent) {
        res.writeHead(code, { 'Content-Type': 'text/plain', Connection: 'close' });
        res.end(msg);
      }
      req.destroy();
    };

    req.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) fail(413, 'Too large');
    });
    req.on('error', () => fail(400, 'Upload interrupted'));
    req.on('aborted', () => fail(400, 'Upload interrupted'));
    req.pipe(out);

    out.on('error', () => fail(500, 'Could not save'));
    out.on('finish', () => {
      if (failed) return;
      if (bytes === 0) { fs.unlink(tmpPath, () => {}); return send(400, 'Empty upload'); }
      const finalPath = path.join(inboxDir, finalName);
      fs.rename(tmpPath, finalPath, (err) => {
        if (err) { fs.unlink(tmpPath, () => {}); return send(500, 'Could not save'); }
        send(200, JSON.stringify({ ok: true, name: finalName }), 'application/json');
        try { onUpload && onUpload({ path: finalPath, name: finalName }); } catch { /* never let a listener break an upload */ }
      });
    });
  }

  return server;
}

function listenOn(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', reject);
      resolve(server.address().port);
    });
  });
}

// Tries `preferredPort`, then the next few, if it's already taken.
async function startPhoneServer(opts, preferredPort = 8787) {
  for (let i = 0; i < 10; i++) {
    const server = createPhoneServer(opts);
    try {
      const port = await listenOn(server, preferredPort + i);
      return { server, port };
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  throw new Error(`No free port from ${preferredPort} to ${preferredPort + 9}`);
}

module.exports = { startPhoneServer, createPhoneServer, lanAddresses, phonePageHtml, MAX_BYTES };
