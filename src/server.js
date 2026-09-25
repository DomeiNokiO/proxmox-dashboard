// src/server.js — Express + WebSocket, broadcast status guest realtime
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { config } from './config.js';
import { ProxmoxClient } from './proxmox.js';
import { buildRouter } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pve = new ProxmoxClient(config.proxmox);

const app = express();
app.use(express.json());

// --- Auth middleware sederhana (opsional, aktif bila DASHBOARD_TOKEN diset) ---
function authGuard(req, res, next) {
  if (!config.auth.token) return next();
  const provided = req.headers['x-auth-token'] || req.query.token;
  if (provided === config.auth.token) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// API routes (dilindungi)
app.use('/api', authGuard, buildRouter(pve));

// Healthcheck (tanpa auth)
app.get('/healthz', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// Static frontend
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);

// --- WebSocket: broadcast daftar guest + status node tiap pollInterval ---
const wss = new WebSocketServer({ server, path: '/ws' });

function checkWsAuth(req) {
  if (!config.auth.token) return true;
  const url = new URL(req.url, 'http://localhost');
  return url.searchParams.get('token') === config.auth.token;
}

wss.on('connection', (ws, req) => {
  if (!checkWsAuth(req)) {
    ws.close(4401, 'Unauthorized');
    return;
  }
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  // Kirim snapshot terakhir langsung saat connect
  if (lastSnapshot) ws.send(JSON.stringify({ type: 'snapshot', data: lastSnapshot }));
});

// Heartbeat: tutup koneksi mati
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
    return undefined;
  });
}, 30000);

let lastSnapshot = null;

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  wss.clients.forEach((ws) => {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  });
}

async function pollLoop() {
  try {
    const [guests, nodeStatus] = await Promise.all([
      pve.clusterResources(),
      pve.nodeStatus(config.proxmox.node).catch(() => null),
    ]);
    lastSnapshot = {
      ts: Date.now(),
      node: config.proxmox.node,
      nodeStatus,
      guests: guests.map((g) => ({
        vmid: g.vmid, name: g.name, type: g.type, status: g.status,
        node: g.node, cpu: g.cpu, maxcpu: g.maxcpu, mem: g.mem,
        maxmem: g.maxmem, disk: g.disk, maxdisk: g.maxdisk,
        uptime: g.uptime, template: g.template,
      })),
    };
    broadcast({ type: 'snapshot', data: lastSnapshot });
  } catch (e) {
    broadcast({ type: 'error', message: e.message });
  }
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
  pollLoop();
  setInterval(pollLoop, config.pollInterval);
});
