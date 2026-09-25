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

  _req(method, path, body) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.base + path);
      const headers = { Authorization: this.authHeader };
      let payload;
      if (body) {
        payload = new URLSearchParams(body).toString();
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = https.request(
        {
          hostname: url.hostname,
          port: url.port || 8006,
          path: url.pathname + url.search,
          method,
          headers,
          agent: this.agent, // https.Agent menghormati rejectUnauthorized (self-signed cert)
        },
        (res) => {
          let text = '';
          res.on('data', (c) => { text += c; });
          res.on('end', () => {
            let json;
            try {
              json = text ? JSON.parse(text) : {};
            } catch {
              return reject(new Error(`Respons non-JSON dari Proxmox (${res.statusCode}): ${text.slice(0, 200)}`));
            }
            if (res.statusCode < 200 || res.statusCode >= 300) {
              const msg = json?.errors ? JSON.stringify(json.errors) : (text || `HTTP ${res.statusCode}`);
              const err = new Error(`Proxmox ${res.statusCode} ${method} ${path}: ${msg}`);
              err.status = res.statusCode;
              return reject(err);
            }
            return resolve(json.data);
          });
        },
      );
      req.on('error', (e) => reject(new Error(`Koneksi ke Proxmox gagal: ${e.message}`)));
      req.setTimeout(15000, () => req.destroy(new Error('Timeout menghubungi Proxmox (15s)')));
      if (payload) req.write(payload);
      req.end();
    });
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

  // ===== Snapshot =====
  listSnapshots(node, type, vmid) {
    return this.get(`/nodes/${node}/${type}/${vmid}/snapshot`);
  }
  createSnapshot(node, type, vmid, { snapname, description = '', vmstate = 0 }) {
    const body = { snapname, description };
    if (type === 'qemu') body.vmstate = vmstate ? 1 : 0;
    return this.post(`/nodes/${node}/${type}/${vmid}/snapshot`, body);
  }
  rollbackSnapshot(node, type, vmid, snapname) {
    return this.post(`/nodes/${node}/${type}/${vmid}/snapshot/${snapname}/rollback`);
  }
  deleteSnapshot(node, type, vmid, snapname) {
    return this.del(`/nodes/${node}/${type}/${vmid}/snapshot/${snapname}`);
  }

  // ===== Backup (vzdump) & restore =====
  backup(node, { vmid, storage, mode = 'snapshot', compress = 'zstd', notes }) {
    const body = { vmid, storage, mode, compress };
    if (notes) body['notes-template'] = notes;
    return this.post(`/nodes/${node}/vzdump`, body);
  }
  // Daftar file backup di storage (content=backup)
  listBackups(node, storage) {
    return this.get(`/nodes/${node}/storage/${storage}/content?content=backup`);
  }

  // ===== Migrasi antar node =====
  migrate(node, type, vmid, target, { online = false, withLocalDisks = false, restart = false } = {}) {
    const body = { target };
    if (type === 'qemu') {
      if (online) body.online = 1;
      if (withLocalDisks) body['with-local-disks'] = 1;
    } else if (restart) {
      body.restart = 1;
    }
    return this.post(`/nodes/${node}/${type}/${vmid}/migrate`, body);
  }
  migratePreconditions(node, vmid) {
    return this.get(`/nodes/${node}/qemu/${vmid}/migrate`);
  }

  // ===== Grafik histori (RRD data) =====
  // timeframe: hour|day|week|month|year ; cf: AVERAGE|MAX
  rrdData(node, type, vmid, timeframe = 'hour', cf = 'AVERAGE') {
    return this.get(`/nodes/${node}/${type}/${vmid}/rrddata?timeframe=${timeframe}&cf=${cf}`);
  }
  nodeRrdData(node, timeframe = 'hour', cf = 'AVERAGE') {
    return this.get(`/nodes/${node}/rrddata?timeframe=${timeframe}&cf=${cf}`);
  }

  // ===== VNC console =====
  // Untuk QEMU: /vncproxy dgn websocket=1 ; LXC: /vncproxy (termproxy juga ada)
  vncProxy(node, type, vmid) {
    return this.post(`/nodes/${node}/${type}/${vmid}/vncproxy`, { websocket: 1 });
  }
  // Buka koneksi WS mentah ke Proxmox vncwebsocket (dipakai server sbg proxy)
  vncWebsocketURL(node, type, vmid, port, vncticket) {
    const base = this.base.replace('/api2/json', '').replace('https://', 'wss://');
    return `${base}/api2/json/nodes/${node}/${type}/${vmid}/vncwebsocket?port=${port}&vncticket=${encodeURIComponent(vncticket)}`;
  }
}
