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

  // Auth dashboard sederhana (Basic-like via header token)
  auth: {
    // Bila kosong, dashboard TERBUKA (hanya untuk LAN terisolasi). Set untuk produksi.
    token: process.env.DASHBOARD_TOKEN || '',
  },

  // Default nilai saat create (bisa dioverride dari UI)
  defaults: {
    storage: process.env.DEFAULT_STORAGE || 'local-lvm',
    bridge: process.env.DEFAULT_BRIDGE || 'vmbr0',
    ctTemplate: process.env.DEFAULT_CT_TEMPLATE || '',
    ctTemplateStorage: process.env.DEFAULT_CT_TEMPLATE_STORAGE || 'local',
  },

  // Interval broadcast status realtime (ms)
  pollInterval: parseInt(process.env.POLL_INTERVAL || '3000', 10),
};
