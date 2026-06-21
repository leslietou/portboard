#!/usr/bin/env node
'use strict';

/*
 * portboard - a phone-friendly dashboard of your live local dev servers,
 * labeled by git worktree/branch, tappable from your phone on the same WiFi.
 *
 *   npx portboard-cli            run the dashboard (default port 7878)
 *   npx portboard-cli install    start automatically at login (background)
 *   npx portboard-cli uninstall  remove the login item
 *
 * No dependencies. macOS-native (uses lsof + ps + git, already on your machine).
 */

const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const dgram = require('dgram');
const { execFileSync } = require('child_process');

// launchd hands background processes a bare PATH, so make sure git/lsof/ps
// (and Homebrew tools) resolve whether run by hand or at login.
const EXTRA_PATHS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
process.env.PATH = Array.from(new Set((process.env.PATH || '').split(':').concat(EXTRA_PATHS))).filter(Boolean).join(':');

// ---- config -------------------------------------------------------------

const DEV_PORT_MIN = 3000;
const DEV_PORT_MAX = 19999;
const DEV_RUNTIME_HINTS = [
  'node', 'bun', 'deno', 'vite', 'next', 'npm', 'pnpm', 'yarn',
  'python', 'ruby', 'rails', 'puma', 'php', 'webpack', 'esbuild',
  'rollup', 'ng', 'expo', 'metro', 'dotnet', 'java', 'serve',
];

const HOME = os.homedir();
const APP_DIR = path.join(HOME, '.portboard');
const NAMES_PATH = path.join(APP_DIR, 'names.json');
const LABEL = 'com.portboard.dashboard';
const PLIST = path.join(HOME, 'Library', 'LaunchAgents', LABEL + '.plist');

let LAN_IP = '127.0.0.1';
let LOCAL_HOST = null;
let DASHBOARD_PORT = 7878;

// ---- helpers ------------------------------------------------------------

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) {
    return '';
  }
}

function fallbackIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const ni of ifaces[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) return ni.address;
    }
  }
  return '127.0.0.1';
}

function getLanIp() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ip) => { if (!done) { done = true; resolve(ip); } };
    try {
      const s = dgram.createSocket('udp4');
      s.on('error', () => { try { s.close(); } catch (e) {} finish(fallbackIp()); });
      s.connect(80, '8.8.8.8', () => {
        try { const a = s.address().address; s.close(); finish(a || fallbackIp()); }
        catch (e) { finish(fallbackIp()); }
      });
      setTimeout(() => finish(fallbackIp()), 300).unref();
    } catch (e) {
      finish(fallbackIp());
    }
  });
}

function localHostname() {
  // Bonjour/mDNS name (e.g. macbook.local) that resolves on the LAN no
  // matter what the IP is, so a bookmark survives DHCP changes.
  let n = run('scutil', ['--get', 'LocalHostName']).trim();
  if (n) return n.toLowerCase() + '.local';
  n = (os.hostname() || '').trim();
  if (!n || n === 'localhost') return null;
  return n.indexOf('.') !== -1 ? n.toLowerCase() : n.toLowerCase() + '.local';
}

// ---- custom names -------------------------------------------------------

function loadNames() {
  try { return JSON.parse(fs.readFileSync(NAMES_PATH, 'utf8')); }
  catch (e) { return {}; }
}

function saveNames(d) {
  fs.mkdirSync(path.dirname(NAMES_PATH), { recursive: true });
  const tmp = NAMES_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2));
  fs.renameSync(tmp, NAMES_PATH);
}

function setName(key, name) {
  const n = loadNames();
  if (name) n[key] = name; else delete n[key];
  saveNames(n);
}

// ---- scanning -----------------------------------------------------------

const ADDR_RE = /^(.*):(\d+)$/;
const ALL_HOSTS = new Set(['*', '0.0.0.0', '[::]', '::']);

function scanListening() {
  const out = run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-Fpcn']);
  const rows = [];
  let pid = null, command = null;
  for (const line of out.split('\n')) {
    const tag = line[0], val = line.slice(1);
    if (tag === 'p') { pid = val; command = null; }
    else if (tag === 'c') { command = val; }
    else if (tag === 'n') {
      const m = ADDR_RE.exec(val);
      if (!m) continue;
      const host = m[1], port = parseInt(m[2], 10);
      rows.push({ pid, command: command || '', port, reachable: ALL_HOSTS.has(host), host });
    }
  }
  return rows;
}

function cwdForPids(pids) {
  const result = {};
  if (!pids.length) return result;
  const out = run('lsof', ['-a', '-p', pids.join(','), '-d', 'cwd', '-Fn']);
  let pid = null;
  for (const line of out.split('\n')) {
    const tag = line[0], val = line.slice(1);
    if (tag === 'p') pid = val;
    else if (tag === 'n' && pid) result[pid] = val;
  }
  return result;
}

const gitCache = new Map();
function gitLabel(p) {
  if (gitCache.has(p)) return gitCache.get(p);
  const top = run('git', ['-C', p, 'rev-parse', '--show-toplevel']).trim();
  let v;
  if (!top) {
    v = [null, null, null];
  } else {
    const branch = run('git', ['-C', p, 'rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const name = top.replace(/\/+$/, '').split('/').pop();
    v = [name, branch || 'detached', top];
  }
  gitCache.set(p, v);
  return v;
}

function isDevRuntime(cmd) {
  const c = (cmd || '').toLowerCase();
  return DEV_RUNTIME_HINTS.some((h) => c.indexOf(h) !== -1);
}

function etimeToSecs(s) {
  s = s.trim();
  let days = 0;
  if (s.indexOf('-') !== -1) { const parts = s.split('-'); days = parseInt(parts[0], 10); s = parts[1]; }
  const p = s.split(':').map((x) => parseInt(x, 10));
  while (p.length < 3) p.unshift(0);
  return days * 86400 + p[p.length - 3] * 3600 + p[p.length - 2] * 60 + p[p.length - 1];
}

function ago(sec) {
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.floor(sec / 60) + 'm';
  if (sec < 86400) return Math.floor(sec / 3600) + 'h';
  return Math.floor(sec / 86400) + 'd';
}

function procAges(pids) {
  const res = {};
  if (!pids.length) return res;
  const out = run('ps', ['-o', 'pid=,etime=', '-p', pids.join(',')]);
  for (let line of out.split('\n')) {
    line = line.trim();
    if (!line) continue;
    const m = line.match(/^(\d+)\s+(.+)$/);
    if (!m) continue;
    try { res[m[1]] = etimeToSecs(m[2]); } catch (e) {}
  }
  return res;
}

function collect() {
  const rows = scanListening();

  // Dedup by port (a server often listens on both IPv4 and IPv6).
  const byPort = new Map();
  for (const r of rows) {
    if (r.port === DASHBOARD_PORT) continue;
    if (!(r.port >= DEV_PORT_MIN && r.port <= DEV_PORT_MAX)) continue;
    const cur = byPort.get(r.port);
    if (!cur) byPort.set(r.port, r);
    else cur.reachable = cur.reachable || r.reachable;
  }

  const pids = Array.from(new Set(Array.from(byPort.values()).map((r) => r.pid).filter(Boolean)));
  const cwds = cwdForPids(pids);
  const ages = procAges(pids);
  const names = loadNames();

  const servers = [];
  for (const [port, r] of byPort) {
    const cwd = cwds[r.pid] || '';
    const [worktree, branch, top] = cwd ? gitLabel(cwd) : [null, null, null];
    const isGit = worktree !== null;
    if (!(isGit || isDevRuntime(r.command))) continue;  // skip system services
    const folder = cwd ? cwd.replace(/\/+$/, '').split('/').pop() : r.command;
    const auto = worktree || folder || r.command;
    const key = top || cwd || ('port:' + port);  // stable across port changes
    const custom = names[key];
    const ageSecs = (r.pid in ages) ? ages[r.pid] : null;
    servers.push({
      port,
      label: custom || auto,
      custom: !!custom,
      key,
      branch,
      command: r.command,
      reachable: r.reachable,
      url: 'http://' + LAN_IP + ':' + port,
      is_git: isGit,
      age: ageSecs !== null ? ago(ageSecs) : null,
      age_secs: ageSecs,
    });
  }

  // most recently started first; unknown start time sinks to the bottom
  servers.sort((a, b) => {
    const an = a.age_secs === null, bn = b.age_secs === null;
    if (an !== bn) return an ? 1 : -1;
    const av = a.age_secs === null ? 0 : a.age_secs;
    const bv = b.age_secs === null ? 0 : b.age_secs;
    if (av !== bv) return av - bv;
    const al = (a.label || '').toLowerCase(), bl = (b.label || '').toLowerCase();
    if (al < bl) return -1;
    if (al > bl) return 1;
    return a.port - b.port;
  });
  return servers;
}

// ---- phone home-screen app assets --------------------------------------

const ICON_B64 = 'iVBORw0KGgoAAAANSUhEUgAAALQAAAC0CAIAAACyr5FlAAAD1UlEQVR4nO3cMW7UaBjHYQftChEFaTtOQENBxX04AOfZA+x9qLbYhhPQIxCioRhpFCXzn3Vs5/Vr+3m6QKQZf/nNF4/HeW/uXv81wCUv1n4C9CUOInEQiYNIHETiIBIHkTiIxEEkDiJxEImDSBxE4iASB5E4iMRBJA4icRCJg0gcROIgEgeROIjEQSQOInEQiYNIHETiIBIHkTiIxEEkDiJxEImDSBxE4iASB9EfKz72q9u7FR99Q358/7bK464Tx/Usfr15+fgf//z689meTnen5apP5KZ+gvGVMi5mcd+RExnK+6g+55hTxsjv2bHiX8SlO0c6tgk/8iNvIWX7R905x5Oqf//Pp/tf/vvx76Wfzoa9ur2r6aNu5xi5bTzI4r4Hidg8nlvROcf8Mh7/75HPP2pOPhpdBLtexvjvYSlrxjH/pX/kzaNAl51j/JZg8yjTJQ4aEgeROIjEQdQljvHXQF0tLbNmHPMvcR75ImmBLjvHMG5LsG1UKoojfRbw4KV//Wfvs5Wzo3zwNly60Pm/n8oeuYxhf3EM7udYSNn9HNW3Cc68E2w4dhZD7Z2C1SekV45tzE9dGZUPt8INxoO7zyc5xN3nZ/5uZaRj/d3KyVrHzEiNLoLRjTiIxEEkDiJxEImDSBxE4iASB5E4iMRBJA4icRCJg8gc0lLbukuh4xzSHVtroug0K/xaOWwZZ1tZgUZzSA9lE+tQGscmVqRM/9Woi6P/WtRrvibeyhIVvVt56kvk7bsP97/88t/nRZ9OI2XjiCfouHM8KOPiv1CgXRypA33U6xXH9QL0UaxXHLQiDiJxEImDqFcc169n7PhqR0+94hhyAcqo1y6O4VIHylhFi1GTR9b22vnQc+egibo4Or9E1tJ8TUp3juZrUaz/ajSaQ3oom1iHFc45NrEuz2orK7DOnyacVueA71+2ksWJOaRE3soSiYNIHETiIBIHkTiIxEEkDiJxEImDSBxE4iASB5E4iMwhnegI9xuYQzrRtiaKTmMO6Sx7OpbHzCGda39HdGYO6QL2elzmkC5jl0fnrSyROaSL6TxRdJqOO4c5pE20i8Mc0j56xWEOaSu94qAVcRCJg0gcRL3iMIe0lV5xDOaQdtIujsEc0jbMIV3Mzq6dDz13Dpowh3QZuzw6c0gXsNfjMod0rv0d0Zk5pLPs6VgeM4d0on1ncWIOKZG3skTiIBIHkTiIxEEkDiJxEImDSBxE4iASB5E4iMRBJA4icRCJg0gcROIgEgeROIjEQSQOInEQiYNIHETiIBIHkTiIxEEkDiJxEImDSBxE4iD6DZM7/FyrC8AEAAAAAElFTkSuQmCC';

const MANIFEST = JSON.stringify({
  name: 'portboard',
  short_name: 'portboard',
  display: 'standalone',
  background_color: '#0c0d10',
  theme_color: '#0c0d10',
  start_url: '/',
  icons: [{ src: '/icon.png', sizes: '180x180', type: 'image/png' }],
});

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>portboard</title>
<meta name="theme-color" content="#0c0d10">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black">
<meta name="apple-mobile-web-app-title" content="portboard">
<link rel="apple-touch-icon" href="/icon.png">
<link rel="icon" href="/icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; -webkit-tap-highlight-color: transparent; }
  body {
    margin: 0; padding: max(20px, env(safe-area-inset-top)) 16px 48px;
    font: 16px/1.4 -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    background: #0c0d10; color: #e8eaf0;
  }
  header { display: flex; align-items: center; justify-content: space-between;
           margin: 4px 2px 18px; gap: 12px; }
  h1 { font-size: 17px; font-weight: 600; letter-spacing: .3px; margin: 0; color: #fff; }
  h1 span { color: #5b6472; font-weight: 500; }
  .hright { display: flex; align-items: center; gap: 10px; flex: none; }
  .meta { font-size: 12px; color: #5b6472; font-variant-numeric: tabular-nums; }
  .toggle { font: inherit; font-size: 11px; color: #7b8494; background: transparent;
            border: 1px solid #2a2f39; border-radius: 999px; padding: 4px 11px;
            cursor: pointer; -webkit-appearance: none; white-space: nowrap; }
  .toggle.on { color: #07130d; background: #3ecf8e; border-color: #3ecf8e; font-weight: 600; }
  .grid { display: flex; flex-direction: column; gap: 10px; }
  .card { display: flex; align-items: stretch; overflow: hidden;
          background: #15171c; border: 1px solid #20242c; border-radius: 14px; }
  .card.dead { opacity: .55; }
  .open { display: flex; align-items: center; gap: 14px; flex: 1; min-width: 0;
          padding: 14px 12px 14px 16px; text-decoration: none; color: inherit; }
  a.open:active { background: #1b1e25; }
  .copy { flex: none; width: 50px; border: none; border-left: 1px solid #20242c;
          background: transparent; color: #7b8494; -webkit-appearance: none;
          display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .copy:active, .edit:active { background: #1b1e25; color: #cfd6e4; }
  .copy.ok { color: #3ecf8e; }
  .edit { flex: none; width: 50px; border: none; border-left: 1px solid #20242c;
          background: transparent; color: #7b8494; -webkit-appearance: none;
          display: flex; align-items: center; justify-content: center; cursor: pointer; }
  .dot { width: 9px; height: 9px; border-radius: 50%; flex: none; }
  .dot.live { background: #3ecf8e; box-shadow: 0 0 0 3px rgba(62,207,142,.15); }
  .dot.local { background: #e0a44a; box-shadow: 0 0 0 3px rgba(224,164,74,.15); }
  .body { flex: 1; min-width: 0; }
  .label { font-size: 16px; font-weight: 600; color: #fff;
           white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub { font-size: 12.5px; color: #7b8494; margin-top: 2px;
         white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .branch { color: #9aa6f0; }
  .port { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums;
          color: #cfd6e4; flex: none; }
  .warn { display: inline-block; margin-left: 6px; font-size: 11px; color: #e0a44a; }
  .empty { text-align: center; color: #5b6472; padding: 56px 20px; font-size: 14px; }
  footer { margin-top: 22px; text-align: center; font-size: 11px; color: #444b57; }
</style>
</head>
<body>
  <header>
    <h1>portboard <span>· live dev servers</span></h1>
    <div class="hright">
      <button class="toggle" id="chrome" aria-label="Open links in Chrome">Chrome</button>
      <div class="meta" id="meta">scanning…</div>
    </div>
  </header>
  <div class="grid" id="grid"></div>
  <footer id="foot"></footer>
<script>
var ICON_COPY = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
var ICON_OK = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>';
var ICON_EDIT = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

var CHROME = false;
try { CHROME = localStorage.getItem('pb_chrome') === '1'; } catch (e) {}
function applyChromeBtn() {
  var b = document.getElementById('chrome');
  if (b) b.classList.toggle('on', CHROME);
}

function render(servers) {
  var grid = document.getElementById('grid');
  document.getElementById('meta').textContent =
    servers.length + (servers.length === 1 ? ' server' : ' servers') +
    ' · ' + new Date().toLocaleTimeString();
  if (!servers.length) {
    grid.innerHTML = '<div class="empty">No dev servers running right now.<br>Start one in a worktree and it shows up here.</div>';
    return;
  }
  grid.innerHTML = servers.map(function(s) {
    var meta = s.branch ? '<span class="branch">' + esc(s.branch) + '</span>' : esc(s.command);
    if (s.age) meta += ' · ' + esc(s.age);
    if (!s.reachable) meta += '<span class="warn">localhost only · bind 0.0.0.0 for phone</span>';
    var dot = s.reachable ? 'live' : 'local';
    var inner =
      '<span class="dot ' + dot + '"></span>' +
      '<div class="body"><div class="label">' + esc(s.label) + '</div>' +
      '<div class="sub">' + meta + '</div></div>' +
      '<div class="port">:' + s.port + '</div>';
    var base = 'http://' + location.hostname + ':' + s.port;
    var href = CHROME ? 'googlechrome' + base.slice(4) : base;
    var open = s.reachable
      ? '<a class="open" href="' + href + '">' + inner + '</a>'
      : '<div class="open">' + inner + '</div>';
    var edit = '<button class="edit" data-key="' + esc(s.key) + '" data-name="' + esc(s.label) + '" aria-label="Rename">' + ICON_EDIT + '</button>';
    var copy = '<button class="copy" data-url="' + base + '" aria-label="Copy ' + base + '">' + ICON_COPY + '</button>';
    return '<div class="card' + (s.reachable ? '' : ' dead') + '">' + open + edit + copy + '</div>';
  }).join('');
}
function esc(t) {
  return String(t == null ? '' : t).replace(/[&<>"]/g, function(c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c];
  });
}
function copyText(t, btn) {
  function done() {
    btn.classList.add('ok'); btn.innerHTML = ICON_OK;
    setTimeout(function(){ btn.classList.remove('ok'); btn.innerHTML = ICON_COPY; }, 1100);
  }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(t).then(done, function(){ legacyCopy(t, done); });
  } else { legacyCopy(t, done); }
}
function legacyCopy(t, cb) {
  var ta = document.createElement('textarea');
  ta.value = t; ta.setAttribute('readonly', '');
  ta.style.position = 'fixed'; ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select(); ta.setSelectionRange(0, t.length);
  try { document.execCommand('copy'); } catch (e) {}
  document.body.removeChild(ta); cb();
}
document.getElementById('grid').addEventListener('click', function(e) {
  if (!e.target.closest) return;
  var c = e.target.closest('.copy');
  if (c) { e.preventDefault(); copyText(c.getAttribute('data-url'), c); return; }
  var ed = e.target.closest('.edit');
  if (ed) { e.preventDefault(); renameCard(ed); return; }
});
function renameCard(btn) {
  var name = window.prompt('Name for this server (leave blank to reset):', btn.getAttribute('data-name') || '');
  if (name === null) return;
  fetch('/rename', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: btn.getAttribute('data-key'), name: name.trim() })
  }).then(function(){ tick(); });
}
function tick() {
  fetch('/api').then(function(r){return r.json();})
    .then(function(d){ render(d.servers); document.getElementById('foot').textContent = d.host; })
    .catch(function(){ document.getElementById('meta').textContent = 'lost connection…'; });
}
document.getElementById('chrome').addEventListener('click', function() {
  CHROME = !CHROME;
  try { localStorage.setItem('pb_chrome', CHROME ? '1' : '0'); } catch (e) {}
  applyChromeBtn();
  tick();
});
applyChromeBtn();
tick();
setInterval(tick, 3000);
</script>
</body>
</html>`;

// ---- web ----------------------------------------------------------------

function send(res, code, ctype, body, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': ctype }, extra || {}));
  res.end(body);
}

function startServer(port) {
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (req.method === 'POST' && url.indexOf('/rename') === 0) {
      let data = '';
      req.on('data', (c) => { data += c; if (data.length > 1e6) req.destroy(); });
      req.on('end', () => {
        try {
          const j = JSON.parse(data || '{}');
          setName(j.key || '', (j.name || '').trim());
          send(res, 200, 'application/json', '{"ok":true}');
        } catch (e) {
          send(res, 400, 'application/json', JSON.stringify({ ok: false, error: String(e) }));
        }
      });
      return;
    }
    if (url.indexOf('/api') === 0) {
      const payload = JSON.stringify({ servers: collect(), host: 'portboard · http://' + (LOCAL_HOST || LAN_IP) + ':' + port });
      send(res, 200, 'application/json', payload, { 'Cache-Control': 'no-store' });
    } else if (url.indexOf('/icon') === 0) {
      send(res, 200, 'image/png', Buffer.from(ICON_B64, 'base64'), { 'Cache-Control': 'max-age=86400' });
    } else if (url.indexOf('/manifest') === 0) {
      send(res, 200, 'application/manifest+json', MANIFEST);
    } else {
      send(res, 200, 'text/html; charset=utf-8', PAGE);
    }
  });
  server.on('error', (e) => {
    console.log('  could not start on port ' + port + ': ' + e.message);
    console.log('  try a different port:  npx portboard-cli ' + (port + 1) + '\n');
    process.exit(1);
  });
  server.listen(port, '0.0.0.0', () => {
    console.log('\n  portboard is live');
    console.log('  open on your phone (same WiFi):');
    if (LOCAL_HOST) console.log('     http://' + LOCAL_HOST + ':' + port + '   (stable, survives IP changes)');
    console.log('     http://' + LAN_IP + ':' + port + (LOCAL_HOST ? '       (or use the IP)' : ''));
    console.log('  Add to Home Screen for an app icon · Ctrl-C to stop\n');
  });
}

// ---- login item (launchd) ----------------------------------------------

function install(port) {
  fs.mkdirSync(APP_DIR, { recursive: true });
  const dest = path.join(APP_DIR, 'portboard.js');
  fs.copyFileSync(__filename, dest);
  fs.mkdirSync(path.dirname(PLIST), { recursive: true });
  const node = process.execPath;
  const log = path.join(APP_DIR, 'portboard.log');
  const plist =
'<?xml version="1.0" encoding="UTF-8"?>\n' +
'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
'<plist version="1.0">\n' +
'<dict>\n' +
'  <key>Label</key><string>' + LABEL + '</string>\n' +
'  <key>ProgramArguments</key>\n' +
'  <array>\n' +
'    <string>' + node + '</string>\n' +
'    <string>' + dest + '</string>\n' +
'    <string>' + port + '</string>\n' +
'  </array>\n' +
'  <key>RunAtLoad</key><true/>\n' +
'  <key>KeepAlive</key><true/>\n' +
'  <key>EnvironmentVariables</key>\n' +
'  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>\n' +
'  <key>StandardOutPath</key><string>' + log + '</string>\n' +
'  <key>StandardErrorPath</key><string>' + log + '</string>\n' +
'</dict>\n' +
'</plist>\n';
  fs.writeFileSync(PLIST, plist);
  try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch (e) {}
  try {
    execFileSync('launchctl', ['load', '-w', PLIST], { stdio: 'ignore' });
  } catch (e) {
    try { execFileSync('launchctl', ['bootstrap', 'gui/' + process.getuid(), PLIST], { stdio: 'ignore' }); } catch (e2) {}
  }
  console.log('\n  portboard installed. it will start automatically at every login.');
  console.log('  open on your phone (same WiFi):');
  if (LOCAL_HOST) console.log('     http://' + LOCAL_HOST + ':' + port + '   (stable, survives IP changes)');
  console.log('     http://' + LAN_IP + ':' + port);
  console.log('  remove it later with:  npx portboard-cli uninstall\n');
}

function uninstall() {
  try { execFileSync('launchctl', ['unload', PLIST], { stdio: 'ignore' }); } catch (e) {}
  try { execFileSync('launchctl', ['bootout', 'gui/' + process.getuid() + '/' + LABEL], { stdio: 'ignore' }); } catch (e) {}
  try { fs.unlinkSync(PLIST); } catch (e) {}
  try { fs.rmSync(APP_DIR, { recursive: true, force: true }); } catch (e) {}
  console.log('\n  portboard removed. it will no longer start at login.\n');
}

function help() {
  console.log([
    '',
    'portboard - live dashboard of your local dev servers, on your phone',
    '',
    'usage:',
    '  npx portboard-cli [port]      run the dashboard (default port 7878)',
    '  npx portboard-cli install     start automatically at login (background)',
    '  npx portboard-cli uninstall   remove the login item',
    '',
    'then open the printed http://<your-mac>:<port> on your phone (same WiFi).',
    '',
  ].join('\n'));
}

// ---- main ---------------------------------------------------------------

async function main() {
  LAN_IP = await getLanIp();
  LOCAL_HOST = localHostname();
  const arg = process.argv[2];
  if (arg === 'install') return install(parseInt(process.argv[3], 10) || 7878);
  if (arg === 'uninstall' || arg === 'remove') return uninstall();
  if (arg === '-h' || arg === '--help' || arg === 'help') return help();
  DASHBOARD_PORT = parseInt(arg, 10) || 7878;
  startServer(DASHBOARD_PORT);
}

main();
