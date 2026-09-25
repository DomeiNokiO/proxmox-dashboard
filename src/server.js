// src/server.js — Express + WebSocket (status realtime + VNC proxy), multi-node
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import https from 'node:https';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { config } from './config.js';
import { ProxmoxClient } from './proxmox.js';
import { buildRouter } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pve = new ProxmoxClient(config.proxmox);

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

function authGuard(req, res, next) {
  if (!config.auth.token) return next();
  const provided = req.headers['x-auth-token'] || req.query.token;
  if (safeEqual(provided, config.auth.token)) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.use('/api', authGuard, buildRouter(pve));
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);

function checkWsAuth(req) {
  if (!config.auth.token) return true;
  const url = new URL(req.url, 'http://localhost');
  return safeEqual(url.searchParams.get('token'), config.auth.token);
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

// Routing upgrade berdasarkan path
server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (!checkWsAuth(req)) { socket.destroy(); return; }
  if (pathname === '/ws') {
    statusWss.handleUpgrade(req, socket, head, (ws) => statusWss.emit('connection', ws, req));
  } else if (pathname === '/vncws') {
    vncWss.handleUpgrade(req, socket, head, (ws) => vncWss.emit('connection', ws, req));
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
  console.log(`Auth dashboard: ${config.auth.token ? 'AKTIF' : 'NONAKTIF (LAN terbuka)'}`);
  try {
    const v = await pve.version();
    console.log(`Terhubung ke Proxmox VE versi ${v.version}\n`);
  } catch (e) {
    console.error(`[PERINGATAN] Gagal konek Proxmox: ${e.message}\n`);
  }
  // Polling dimulai on-demand saat client WS pertama connect (lihat statusWss.on('connection')).
});
