// src/server.js — Express + WebSocket (status realtime + VNC proxy), multi-node
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config.js';
import { ProxmoxClient } from './proxmox.js';
import { buildRouter } from './routes.js';
import {
  hashPassword, verifyPassword, loadSessionSecret, SessionManager,
  parseCookies, LoginRateLimiter, SESSION_COOKIE,
} from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pve = new ProxmoxClient(config.proxmox);

// ===== Auth login (sesi cookie ber-tandatangan) =====
const loginEnabled = !!(config.auth.username && (config.auth.password || config.auth.passwordHash));
const sessions = new SessionManager(config.auth.sessionSecret || loadSessionSecret());
const loginLimiter = new LoginRateLimiter();
// Hash password: pakai hash siap-pakai bila ada, else hash plaintext dari .env sekali saat boot.
let storedHash = config.auth.passwordHash || (config.auth.password ? hashPassword(config.auth.password) : '');

const TRUST_PROXY = String(process.env.TRUST_PROXY || '').toLowerCase() === 'true';
function clientIp(req) {
  // Hanya percaya X-Forwarded-For bila di belakang proxy tepercaya (mis. Cloudflare Tunnel).
  // Tanpa itu, XFF bisa dipalsukan untuk mengelabui rate-limit → pakai IP soket langsung.
  if (TRUST_PROXY) {
    const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (xff) return xff;
  }
  return req.socket?.remoteAddress || 'unknown';
}
function hasValidSession(req) {
  const tok = parseCookies(req)[SESSION_COOKIE];
  return tok ? sessions.verify(tok) : null;
}

// Perbandingan token tahan-timing (cegah timing attack tebak token dashboard)
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

const app = express();
app.disable('x-powered-by'); // jangan bocorkan "Express"
app.use(express.json({ limit: '256kb' })); // batasi ukuran body (anti-DoS payload besar)

// Security headers dasar (tanpa dependency tambahan)
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY'); // cegah clickjacking
  res.setHeader('Referrer-Policy', 'no-referrer');
  // CSP: pertahanan berlapis atas XSS. Izinkan CDN yg dipakai (Tailwind, Chart.js, noVNC).
  // 'unsafe-inline' diperlukan Tailwind CDN + atribut style; script dibatasi ke self + jsdelivr/cdn.tailwindcss.
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net https://cdn.tailwindcss.com 'unsafe-inline'",
    "style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; '));
  next();
});

// ===== Endpoint login/logout (sebelum authGuard) =====
const secureCookie = (req) => (TRUST_PROXY && req.headers['x-forwarded-proto'] === 'https') || req.secure;
function setSessionCookie(req, res, token) {
  const parts = [
    `${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=43200',
  ];
  if (secureCookie(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

app.get('/api/auth/status', (req, res) => {
  res.json({ loginEnabled, authenticated: !loginEnabled || !!hasValidSession(req) });
});

app.post('/api/auth/login', (req, res) => {
  if (!loginEnabled) return res.json({ ok: true }); // login nonaktif → langsung lolos
  const ip = clientIp(req);
  const gate = loginLimiter.check(ip);
  if (!gate.allowed) {
    return res.status(429).json({ error: `Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil(gate.retryMs / 60000)} menit.` });
  }
  const { username, password } = req.body || {};
  const userOk = safeEqual(username, config.auth.username);
  const passOk = verifyPassword(password || '', storedHash);
  if (userOk && passOk) {
    loginLimiter.reset(ip);
    setSessionCookie(req, res, sessions.create(config.auth.username));
    return res.json({ ok: true });
  }
  loginLimiter.fail(ip);
  return res.status(401).json({ error: 'Username atau password salah' });
});

app.post('/api/auth/logout', (req, res) => {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secureCookie(req)) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
  res.json({ ok: true });
});

// Ganti password login (butuh sesi aktif + verifikasi password lama). Persist ke .env sebagai hash.
function updateEnvVar(key, value) {
  const envPath = path.join(__dirname, '..', '.env');
  let lines = [];
  try { lines = fs.readFileSync(envPath, 'utf8').split('\n'); } catch { /* .env belum ada */ }
  let found = false;
  lines = lines.map((l) => {
    if (new RegExp(`^${key}=`).test(l)) { found = true; return `${key}=${value}`; }
    return l;
  });
  // Hapus DASHBOARD_PASSWORD plaintext bila kita menulis hash (hindari konflik/hash ganda).
  if (key === 'DASHBOARD_PASSWORD_HASH') lines = lines.filter((l) => !/^DASHBOARD_PASSWORD=/.test(l));
  if (!found) lines.push(`${key}=${value}`);
  fs.writeFileSync(envPath, lines.join('\n'), { mode: 0o640 });
}

app.post('/api/auth/change-password', (req, res) => {
  if (!loginEnabled) return res.status(400).json({ error: 'Login tidak aktif' });
  if (!hasValidSession(req)) return res.status(401).json({ error: 'Unauthorized' });
  const ip = clientIp(req);
  const gate = loginLimiter.check(ip);
  if (!gate.allowed) {
    return res.status(429).json({ error: `Terlalu banyak percobaan. Coba lagi dalam ${Math.ceil(gate.retryMs / 60000)} menit.` });
  }
  const { current, next: nextPass } = req.body || {};
  if (!verifyPassword(current || '', storedHash)) {
    loginLimiter.fail(ip);
    return res.status(401).json({ error: 'Password lama salah' });
  }
  if (!nextPass || String(nextPass).length < 8) {
    return res.status(400).json({ error: 'Password baru minimal 8 karakter' });
  }
  const newHash = hashPassword(String(nextPass));
  try {
    updateEnvVar('DASHBOARD_PASSWORD_HASH', newHash);
  } catch (e) {
    return res.status(500).json({ error: `Gagal menyimpan ke .env: ${e.message}` });
  }
  loginLimiter.reset(ip);
  storedHash = newHash; // berlaku langsung tanpa restart
  res.json({ ok: true });
});

function authGuard(req, res, next) {
  // Prioritas: sesi login (cookie). Fallback: token header legacy (bila dikonfigurasi).
  if (loginEnabled && hasValidSession(req)) return next();
  if (config.auth.token) {
    const provided = req.headers['x-auth-token'] || req.query.token;
    if (safeEqual(provided, config.auth.token)) return next();
  }
  if (!loginEnabled && !config.auth.token) return next(); // keduanya nonaktif = terbuka
  return res.status(401).json({ error: 'Unauthorized' });
}

app.use('/api', authGuard, buildRouter(pve));
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);

function checkWsAuth(req) {
  if (loginEnabled && hasValidSession(req)) return true;
  if (config.auth.token) {
    const url = new URL(req.url, 'http://localhost');
    if (safeEqual(url.searchParams.get('token'), config.auth.token)) return true;
  }
  if (!loginEnabled && !config.auth.token) return true;
  return false;
}

// ===== WS #1: broadcast status realtime =====
const statusWss = new WebSocketServer({ noServer: true });
statusWss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  if (lastSnapshot) ws.send(JSON.stringify({ type: 'snapshot', data: lastSnapshot }));
  startPolling(); // mulai poll saat ada client pertama
  ws.on('close', () => { if (statusWss.clients.size === 0) stopPolling(); });
});
setInterval(() => {
  statusWss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false; ws.ping(); return undefined;
  });
}, 30000);

// ===== WS #2: proxy VNC ke Proxmox =====
const vncWss = new WebSocketServer({ noServer: true });
vncWss.on('connection', async (client, req) => {
  const url = new URL(req.url, 'http://localhost');
  const vmid = url.searchParams.get('vmid');
  const port = url.searchParams.get('port');
  const vncticket = url.searchParams.get('vncticket');
  try {
    const res = await pve.clusterResources();
    const g = res.find((x) => String(x.vmid) === String(vmid) && x.type !== 'storage');
    if (!g) throw new Error('guest tidak ditemukan');
    const { node, type } = g;
    if (!port || !vncticket) throw new Error('port/vncticket wajib (ambil dari /api/guests/:vmid/vncticket)');
    const target = pve.vncWebsocketURL(node, type, vmid, port, vncticket);
    // Sambungkan ke Proxmox (binary), bawa header auth token
    const upstream = new WebSocket(target, {
      agent: new https.Agent({ rejectUnauthorized: config.proxmox.verifySSL }),
      headers: { Authorization: pve.authHeader },
    });
    upstream.binaryType = 'nodebuffer';
    client.binaryType = 'nodebuffer';
    const closeAll = () => { try { client.close(); } catch {} try { upstream.close(); } catch {} };
    upstream.on('open', () => client.send(JSON.stringify({ __proxy: 'ready' })));
    upstream.on('message', (d) => client.readyState === client.OPEN && client.send(d));
    client.on('message', (d) => upstream.readyState === upstream.OPEN && upstream.send(d));
    upstream.on('close', closeAll);
    client.on('close', closeAll);
    upstream.on('error', (e) => { client.send(JSON.stringify({ __proxy: 'error', message: e.message })); closeAll(); });
    client.on('error', closeAll);
  } catch (e) {
    client.send(JSON.stringify({ __proxy: 'error', message: e.message }));
    client.close();
  }
});

// ===== Terminal (xterm) WS proxy — untuk LXC via termproxy =====
const termWss = new WebSocketServer({ noServer: true });
termWss.on('connection', async (client, req) => {
  const url = new URL(req.url, 'http://localhost');
  const vmid = url.searchParams.get('vmid');
  const nodeParam = url.searchParams.get('node');
  const port = url.searchParams.get('port');
  const ticket = url.searchParams.get('vncticket');
  try {
    let node; let type;
    if (vmid) {
      const res = await pve.clusterResources();
      const g = res.find((x) => String(x.vmid) === String(vmid) && x.type !== 'storage');
      if (!g) throw new Error('guest tidak ditemukan');
      node = g.node; type = g.type;
    } else if (nodeParam) {
      node = nodeParam; type = 'node'; // terminal shell node
    } else {
      throw new Error('vmid atau node wajib');
    }
    if (!port || !ticket) throw new Error('port/ticket wajib');
    const target = pve.termWebsocketURL(node, type, vmid, port, ticket);
    const upstream = new WebSocket(target, {
      agent: new https.Agent({ rejectUnauthorized: config.proxmox.verifySSL }),
      headers: { Authorization: pve.authHeader },
    });
    upstream.binaryType = 'nodebuffer';
    client.binaryType = 'nodebuffer';
    const closeAll = () => { try { client.close(); } catch {} try { upstream.close(); } catch {} };
    upstream.on('open', () => client.send(JSON.stringify({ __proxy: 'ready' })));
    upstream.on('message', (d) => client.readyState === client.OPEN && client.send(d));
    client.on('message', (d) => upstream.readyState === upstream.OPEN && upstream.send(d));
    upstream.on('close', closeAll);
    client.on('close', closeAll);
    upstream.on('error', (e) => { try { client.send(JSON.stringify({ __proxy: 'error', message: e.message })); } catch {} closeAll(); });
    client.on('error', closeAll);
  } catch (e) {
    try { client.send(JSON.stringify({ __proxy: 'error', message: e.message })); } catch {}
    client.close();
  }
});

// Routing upgrade berdasarkan path
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (!checkWsAuth(req)) { socket.destroy(); return; }
  if (pathname === '/ws') {
    statusWss.handleUpgrade(req, socket, head, (ws) => statusWss.emit('connection', ws, req));
  } else if (pathname === '/vncws') {
    vncWss.handleUpgrade(req, socket, head, (ws) => vncWss.emit('connection', ws, req));
  } else if (pathname === '/termws') {
    termWss.handleUpgrade(req, socket, head, (ws) => termWss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

let lastSnapshot = null;
let pollTimer = null;
let polling = false; // guard anti-overlap: cegah request menumpuk bila Proxmox lambat

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  statusWss.clients.forEach((ws) => { if (ws.readyState === ws.OPEN) ws.send(msg); });
}

async function pollLoop() {
  if (polling) return; // siklus sebelumnya belum selesai — lewati, jangan menumpuk
  polling = true;
  try {
    const [guests, nodes] = await Promise.all([pve.clusterResources(), pve.nodes()]);
    // Status hanya untuk node online (multi-node) — hemat call ke node mati
    const nodeStatuses = {};
    await Promise.all((nodes || []).filter((n) => n.status === 'online').map(async (n) => {
      try { nodeStatuses[n.node] = await pve.nodeStatus(n.node); } catch { nodeStatuses[n.node] = null; }
    }));
    lastSnapshot = {
      ts: Date.now(),
      node: config.proxmox.node,
      nodes: (nodes || []).map((n) => ({ node: n.node, status: n.status })),
      nodeStatuses,
      nodeStatus: nodeStatuses[config.proxmox.node] || null, // kompat lama
      guests: guests.filter((g) => g.type !== 'storage').map((g) => ({
        vmid: g.vmid, name: g.name, type: g.type, status: g.status, node: g.node,
        cpu: g.cpu, maxcpu: g.maxcpu, mem: g.mem, maxmem: g.maxmem,
        disk: g.disk, maxdisk: g.maxdisk, uptime: g.uptime, template: g.template,
      })),
    };
    broadcast({ type: 'snapshot', data: lastSnapshot });
  } catch (e) {
    broadcast({ type: 'error', message: e.message });
  } finally {
    polling = false;
  }
}

// Poll HANYA saat ada client dashboard terbuka → Proxmox nol beban saat idle.
function startPolling() {
  if (pollTimer) return;
  pollLoop();
  pollTimer = setInterval(pollLoop, config.pollInterval);
  console.log(`[poll] mulai (client aktif, interval ${config.pollInterval}ms)`);
}
function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
  console.log('[poll] berhenti (tak ada client)');
}

server.listen(config.port, config.bindAddress, async () => {
  console.log(`\nProxmox Dashboard aktif di http://${config.bindAddress}:${config.port}`);
  console.log(`Target Proxmox: ${config.proxmox.host}:${config.proxmox.port} node=${config.proxmox.node}`);
  console.log(`Auth dashboard: ${loginEnabled ? 'LOGIN (username+password)' : (config.auth.token ? 'TOKEN header' : 'NONAKTIF (LAN terbuka)')}`);
  try {
    const v = await pve.version();
    console.log(`Terhubung ke Proxmox VE versi ${v.version}\n`);
  } catch (e) {
    console.error(`[PERINGATAN] Gagal konek Proxmox: ${e.message}\n`);
  }
  // Polling dimulai on-demand saat client WS pertama connect (lihat statusWss.on('connection')).
});
