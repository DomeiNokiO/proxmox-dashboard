// src/proxmox.js — Client API Proxmox VE (auth token, native fetch, task polling)
import https from 'node:https';

/**
 * Client Proxmox VE berbasis API Token.
 * Semua metode mutasi mengembalikan hasil setelah task (UPID) selesai bila applicable.
 */
export class ProxmoxClient {
  constructor({ host, port = 8006, tokenId, tokenSecret, verifySSL = false }) {
    if (!host || !tokenId || !tokenSecret) {
      throw new Error('ProxmoxClient butuh host, tokenId, tokenSecret');
    }
    this.base = `https://${host}:${port}/api2/json`;
    this.authHeader = `PVEAPIToken=${tokenId}=${tokenSecret}`;
    // Self-signed cert: bypass hanya bila verifySSL=false (jaringan terpercaya).
    this.agent = new https.Agent({ rejectUnauthorized: verifySSL });
  }

  async _req(method, path, body) {
    const opts = {
      method,
      headers: { Authorization: this.authHeader },
      agent: this.agent,
    };
    if (body) {
      opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opts.body = new URLSearchParams(body).toString();
    }
    const res = await fetch(this.base + path, opts);
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`Respons non-JSON dari Proxmox (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      const msg = json?.errors ? JSON.stringify(json.errors) : text;
      const err = new Error(`Proxmox ${res.status} ${method} ${path}: ${msg}`);
      err.status = res.status;
      throw err;
    }
    return json.data;
  }

  get(p) { return this._req('GET', p); }
  post(p, b) { return this._req('POST', p, b); }
  put(p, b) { return this._req('PUT', p, b); }
  del(p) { return this._req('DELETE', p); }

  // --- Info ---
  version() { return this.get('/version'); }
  nodes() { return this.get('/nodes'); }
  clusterResources() { return this.get('/cluster/resources?type=vm'); }
  async nextId() { return this.get('/cluster/nextid'); }

  nodeStatus(node) { return this.get(`/nodes/${node}/status`); }
  storages(node) { return this.get(`/nodes/${node}/storage`); }
  templates(node, storage) {
    return this.get(`/nodes/${node}/storage/${storage}/content?content=vztmpl`);
  }

  // --- Deteksi tipe guest (qemu/lxc) ---
  async detectType(node, vmid) {
    const res = await this.clusterResources();
    const hit = res.find((r) => String(r.vmid) === String(vmid));
    if (!hit) throw new Error(`VMID ${vmid} tidak ditemukan`);
    return hit.type; // 'qemu' | 'lxc'
  }

  // --- Status & config ---
  currentStatus(node, type, vmid) {
    return this.get(`/nodes/${node}/${type}/${vmid}/status/current`);
  }
  config(node, type, vmid) {
    return this.get(`/nodes/${node}/${type}/${vmid}/config`);
  }

  // --- Lifecycle (mengembalikan UPID) ---
  action(node, type, vmid, act) {
    return this.post(`/nodes/${node}/${type}/${vmid}/status/${act}`);
  }

  // --- Resize disk / rootfs ---
  resize(node, type, vmid, disk, size) {
    return this.put(`/nodes/${node}/${type}/${vmid}/resize`, { disk, size });
  }

  // --- Ubah CPU/RAM ---
  setConfig(node, type, vmid, cfg) {
    return this.put(`/nodes/${node}/${type}/${vmid}/config`, cfg);
  }

  // --- Buat VM (QEMU) ---
  createVM(node, cfg) {
    return this.post(`/nodes/${node}/qemu`, cfg);
  }

  // --- Buat Container (LXC) ---
  createCT(node, cfg) {
    return this.post(`/nodes/${node}/lxc`, cfg);
  }

  // --- Hapus ---
  async destroy(node, type, vmid, purge = true) {
    const path = `/nodes/${node}/${type}/${vmid}${purge ? '?purge=1&destroy-unreferenced-disks=1' : ''}`;
    return this.del(path);
  }

  // --- Poll task UPID sampai selesai ---
  async waitTask(node, upid, { timeout = 600000, interval = 1500 } = {}) {
    if (!upid) return null;
    const start = Date.now();
    for (;;) {
      const s = await this.get(`/nodes/${node}/tasks/${encodeURIComponent(upid)}/status`);
      if (s.status === 'stopped') {
        if (s.exitstatus !== 'OK') {
          throw new Error(`Task gagal (${upid}): ${s.exitstatus}`);
        }
        return s;
      }
      if (Date.now() - start > timeout) throw new Error(`Task timeout: ${upid}`);
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  taskLog(node, upid) {
    return this.get(`/nodes/${node}/tasks/${encodeURIComponent(upid)}/log`);
  }
}
