// src/config.js — Muat & validasi konfigurasi dari environment
import 'dotenv/config';

function req(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[FATAL] Env ${name} wajib diisi. Lihat .env.example`);
    process.exit(1);
  }
  return v;
}

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  bindAddress: process.env.BIND_ADDRESS || '0.0.0.0',

  proxmox: {
    host: req('PVE_HOST'),
    port: parseInt(process.env.PVE_PORT || '8006', 10),
    node: req('PVE_NODE'),
    tokenId: req('PVE_TOKEN_ID'),
    tokenSecret: req('PVE_TOKEN_SECRET'),
    verifySSL: (process.env.PVE_VERIFY_SSL || 'false').toLowerCase() === 'true',
  },

  // Auth dashboard: login username+password (sesi cookie) ATAU token header (legacy/API).
  auth: {
    // Token header opsional (legacy, untuk akses API programatik). Kosong = nonaktif.
    token: process.env.DASHBOARD_TOKEN || '',
    // Login berbasis form. Bila username & (password ATAU passwordHash) diisi → login WAJIB.
    username: process.env.DASHBOARD_USER || '',
    // Password plaintext di .env (di-hash saat boot; .env gitignored + mode 600) ATAU
    // hash scrypt siap-pakai via DASHBOARD_PASSWORD_HASH (lebih aman, tak simpan plaintext).
    password: process.env.DASHBOARD_PASSWORD || '',
    passwordHash: process.env.DASHBOARD_PASSWORD_HASH || '',
    sessionSecret: process.env.SESSION_SECRET || '',
  },

  // Default nilai saat create (bisa dioverride dari UI)
  defaults: {
    storage: process.env.DEFAULT_STORAGE || 'local-lvm',
    bridge: process.env.DEFAULT_BRIDGE || 'vmbr0',
    ctTemplate: process.env.DEFAULT_CT_TEMPLATE || '',
    ctTemplateStorage: process.env.DEFAULT_CT_TEMPLATE_STORAGE || 'local',
  },

  // Interval broadcast status realtime (ms)
  pollInterval: parseInt(process.env.POLL_INTERVAL || '5000', 10),
};
