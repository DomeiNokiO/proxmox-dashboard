// src/routes.js — REST API endpoints untuk dashboard (multi-node)
import express from 'express';
import { config } from './config.js';

export function buildRouter(pve) {
  const r = express.Router();
  const DEFAULT_NODE = config.proxmox.node;

  const h = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error('[API ERROR]', e.message);
    res.status(e.status || 500).json({ error: e.message });
  });

  // Resolusi node + type asli guest dari cluster (dukung multi-node)
  async function resolveGuest(vmid) {
    if (!/^\d+$/.test(String(vmid))) throw Object.assign(new Error('VMID harus angka'), { status: 400 });
    const res = await pve.clusterResources();
    const hit = res.find((g) => String(g.vmid) === String(vmid) && g.type !== 'storage');
    if (!hit) throw new Error(`VMID ${vmid} tidak ditemukan di cluster`);
    return { node: hit.node, type: hit.type };
  }

  // --- Info cluster / node ---
  r.get('/info', h(async (_req, res) => {
    const [version, nodes] = await Promise.all([pve.version(), pve.nodes()]);
    res.json({ version, nodes, node: DEFAULT_NODE });
  }));

  r.get('/nodes', h(async (_req, res) => {
    res.json(await pve.nodes());
  }));

  r.get('/node-status/:node?', h(async (req, res) => {
    res.json(await pve.nodeStatus(req.params.node || DEFAULT_NODE));
  }));

  // --- Daftar semua VM & CT (semua node) ---
  r.get('/guests', h(async (_req, res) => {
    const list = await pve.clusterResources();
    res.json(list.map((g) => ({
      vmid: g.vmid, name: g.name, type: g.type, status: g.status, node: g.node,
      cpu: g.cpu, maxcpu: g.maxcpu, mem: g.mem, maxmem: g.maxmem,
      disk: g.disk, maxdisk: g.maxdisk, uptime: g.uptime, template: g.template,
    })));
  }));

  // --- Detail satu guest ---
  r.get('/guests/:vmid', h(async (req, res) => {
    const { vmid } = req.params;
    const { node, type } = await resolveGuest(vmid);
    const [status, cfg] = await Promise.all([
      pve.currentStatus(node, type, vmid),
      pve.config(node, type, vmid),
    ]);
    res.json({ vmid, node, type, status, config: cfg });
  }));

  // --- Aksi lifecycle ---
  const ALLOWED = new Set(['start', 'stop', 'shutdown', 'reboot', 'reset', 'suspend', 'resume']);
  r.post('/guests/:vmid/action/:act', h(async (req, res) => {
    const { vmid, act } = req.params;
    if (!ALLOWED.has(act)) return res.status(400).json({ error: `Aksi tidak valid: ${act}` });
    const { node, type } = await resolveGuest(vmid);
    if (['reset', 'suspend', 'resume'].includes(act) && type !== 'qemu') {
      return res.status(400).json({ error: `Aksi ${act} hanya untuk VM (qemu)` });
    }
    const upid = await pve.action(node, type, vmid, act);
    res.json({ ok: true, upid });
    return undefined;
  }));

  // --- Ubah CPU / RAM ---
  r.put('/guests/:vmid/resources', h(async (req, res) => {
    const { vmid } = req.params;
    const { cores, memory } = req.body;
    const { node, type } = await resolveGuest(vmid);
    const cfg = {};
    if (cores != null) cfg.cores = parseInt(cores, 10);
    if (memory != null) cfg.memory = parseInt(memory, 10);
    if (Object.keys(cfg).length === 0) {
      return res.status(400).json({ error: 'Butuh cores dan/atau memory' });
    }
    await pve.setConfig(node, type, vmid, cfg);
    res.json({ ok: true, applied: cfg });
    return undefined;
  }));

  // --- Tambah disk ---
  r.put('/guests/:vmid/disk', h(async (req, res) => {
    const { vmid } = req.params;
    const { disk, size } = req.body;
    if (!disk || !size) return res.status(400).json({ error: 'Butuh disk & size (mis. +10G)' });
    const { node, type } = await resolveGuest(vmid);
    await pve.resize(node, type, vmid, disk, size);
    res.json({ ok: true });
    return undefined;
  }));

  // --- Hapus guest ---
  r.delete('/guests/:vmid', h(async (req, res) => {
    const { vmid } = req.params;
    const { node, type } = await resolveGuest(vmid);
    const st = await pve.currentStatus(node, type, vmid);
    if (st.status === 'running') {
      await pve.waitTask(node, await pve.action(node, type, vmid, 'stop'));
    }
    const upid = await pve.destroy(node, type, vmid, true);
    res.json({ ok: true, upid });
  }));

  // ===== Snapshot =====
  r.get('/guests/:vmid/snapshots', h(async (req, res) => {
    const { node, type } = await resolveGuest(req.params.vmid);
    res.json(await pve.listSnapshots(node, type, req.params.vmid));
  }));
  r.post('/guests/:vmid/snapshots', h(async (req, res) => {
    const { snapname, description, vmstate } = req.body;
    if (!snapname) return res.status(400).json({ error: 'Butuh snapname' });
    if (!/^[A-Za-z][\w-]{0,39}$/.test(snapname)) {
      return res.status(400).json({ error: 'snapname: huruf/angka/-/_ , mulai huruf, maks 40' });
    }
    const { node, type } = await resolveGuest(req.params.vmid);
    const upid = await pve.createSnapshot(node, type, req.params.vmid, { snapname, description, vmstate });
    res.json({ ok: true, upid });
    return undefined;
  }));
  const SNAPNAME_RE = /^[A-Za-z][\w-]{0,39}$/;
  r.post('/guests/:vmid/snapshots/:name/rollback', h(async (req, res) => {
    if (!SNAPNAME_RE.test(req.params.name)) return res.status(400).json({ error: 'Nama snapshot tidak valid' });
    const { node, type } = await resolveGuest(req.params.vmid);
    const upid = await pve.rollbackSnapshot(node, type, req.params.vmid, req.params.name);
    res.json({ ok: true, upid });
    return undefined;
  }));
  r.delete('/guests/:vmid/snapshots/:name', h(async (req, res) => {
    if (!SNAPNAME_RE.test(req.params.name)) return res.status(400).json({ error: 'Nama snapshot tidak valid' });
    const { node, type } = await resolveGuest(req.params.vmid);
    const upid = await pve.deleteSnapshot(node, type, req.params.vmid, req.params.name);
    res.json({ ok: true, upid });
    return undefined;
  }));

  // ===== Backup =====
  r.get('/backup-storages/:node?', h(async (req, res) => {
    const node = req.params.node || DEFAULT_NODE;
    const st = await pve.storages(node);
    res.json(st.filter((s) => (s.content || '').includes('backup'))
      .map((s) => ({ storage: s.storage, avail: s.avail, total: s.total })));
  }));
  r.get('/guests/:vmid/backups', h(async (req, res) => {
    const { node } = await resolveGuest(req.params.vmid);
    const storages = (await pve.storages(node)).filter((s) => (s.content || '').includes('backup'));
    const all = [];
    for (const s of storages) {
      try {
        const items = await pve.listBackups(node, s.storage);
        items.filter((b) => String(b.vmid) === String(req.params.vmid))
          .forEach((b) => all.push({ ...b, storage: s.storage }));
      } catch { /* skip */ }
    }
    res.json(all.sort((a, b) => (b.ctime || 0) - (a.ctime || 0)));
  }));
  r.post('/guests/:vmid/backup', h(async (req, res) => {
    const { storage, mode = 'snapshot', compress = 'zstd' } = req.body;
    if (!storage) return res.status(400).json({ error: 'Butuh storage tujuan backup' });
    const { node } = await resolveGuest(req.params.vmid);
    const upid = await pve.backup(node, { vmid: req.params.vmid, storage, mode, compress, notes: '{{guestname}}' });
    res.json({ ok: true, upid });
    return undefined;
  }));

  // ===== Migrasi antar node =====
  r.post('/guests/:vmid/migrate', h(async (req, res) => {
    const { target, online = true, withLocalDisks = false, restart = true } = req.body;
    if (!target) return res.status(400).json({ error: 'Butuh node target' });
    const nodeList = (await pve.nodes()).map((n) => n.node);
    if (!nodeList.includes(target)) return res.status(400).json({ error: 'Node target tidak dikenal' });
    const { node, type } = await resolveGuest(req.params.vmid);
    if (node === target) return res.status(400).json({ error: 'Guest sudah di node target' });
    const upid = await pve.migrate(node, type, req.params.vmid, target, { online, withLocalDisks, restart });
    res.json({ ok: true, upid, from: node, to: target });
    return undefined;
  }));

  // ===== Grafik histori (RRD) =====
  r.get('/guests/:vmid/rrd', h(async (req, res) => {
    const tf = req.query.timeframe || 'hour';
    const { node, type } = await resolveGuest(req.params.vmid);
    res.json(await pve.rrdData(node, type, req.params.vmid, tf));
  }));
  r.get('/node-rrd/:node?', h(async (req, res) => {
    const tf = req.query.timeframe || 'hour';
    res.json(await pve.nodeRrdData(req.params.node || DEFAULT_NODE, tf));
  }));

  // ===== Data pendukung form create =====
  r.get('/meta', h(async (req, res) => {
    const node = req.query.node || DEFAULT_NODE;
    const [storages, nextid, nodes] = await Promise.all([
      pve.storages(node), pve.nextId(), pve.nodes(),
    ]);
    let templates = [];
    try { templates = await pve.templates(node, config.defaults.ctTemplateStorage); } catch { /* */ }
    res.json({
      storages: storages.map((s) => ({ storage: s.storage, type: s.type, content: s.content, avail: s.avail, total: s.total })),
      templates: templates.map((t) => ({ volid: t.volid, size: t.size })),
      nodes: nodes.map((n) => n.node),
      nextid, defaults: config.defaults,
    });
  }));

  // ===== Create VM =====
  r.post('/vms', h(async (req, res) => {
    const {
      node = DEFAULT_NODE, vmid, name, cores = 2, memory = 2048, diskSize = 20,
      storage = config.defaults.storage, bridge = config.defaults.bridge,
      isoImage, ostype = 'l26', start = false,
    } = req.body;
    if (!vmid || !name) return res.status(400).json({ error: 'Butuh vmid & name' });
    const cfg = {
      vmid: parseInt(vmid, 10), name, cores: parseInt(cores, 10), memory: parseInt(memory, 10),
      net0: `virtio,bridge=${bridge}`, scsihw: 'virtio-scsi-pci',
      scsi0: `${storage}:${parseInt(diskSize, 10)}`, ostype, agent: 'enabled=1',
    };
    if (isoImage) { cfg.ide2 = `${isoImage},media=cdrom`; cfg.boot = 'order=scsi0;ide2'; }
    const upid = await pve.createVM(node, cfg);
    await pve.waitTask(node, upid);
    if (start) await pve.waitTask(node, await pve.action(node, 'qemu', vmid, 'start'));
    res.json({ ok: true, vmid: cfg.vmid, upid });
    return undefined;
  }));

  // ===== VNC ticket (untuk noVNC RFB credentials) =====
  r.get('/guests/:vmid/vncticket', h(async (req, res) => {
    const { node, type } = await resolveGuest(req.params.vmid);
    const vnc = await pve.vncProxy(node, type, req.params.vmid);
    // ticket dipakai browser sbg password RFB; port dipakai server saat proxy
    res.json({ ticket: vnc.ticket, port: vnc.port, node, type });
    return undefined;
  }));

  // ===== Create CT =====
  r.post('/cts', h(async (req, res) => {
    const {
      node = DEFAULT_NODE, vmid, hostname, cores = 2, memory = 2048, diskSize = 8,
      storage = config.defaults.storage, bridge = config.defaults.bridge,
      ostemplate = config.defaults.ctTemplate,
      password, sshKey, ip = 'dhcp', gw, unprivileged = true, nesting = true, start = false,
    } = req.body;
    if (!vmid || !hostname) return res.status(400).json({ error: 'Butuh vmid & hostname' });
    if (!ostemplate) return res.status(400).json({ error: 'Butuh ostemplate (pilih dari /meta)' });
    if (!password && !sshKey) return res.status(400).json({ error: 'Butuh password atau sshKey' });
    let netStr = `name=eth0,bridge=${bridge},ip=${ip}`;
    if (ip !== 'dhcp' && gw) netStr += `,gw=${gw}`;
    const cfg = {
      vmid: parseInt(vmid, 10), hostname, cores: parseInt(cores, 10), memory: parseInt(memory, 10),
      rootfs: `${storage}:${parseInt(diskSize, 10)}`, ostemplate, net0: netStr,
      unprivileged: unprivileged ? 1 : 0, features: nesting ? 'nesting=1' : undefined,
    };
    if (password) cfg.password = password;
    if (sshKey) cfg['ssh-public-keys'] = sshKey;
    const upid = await pve.createCT(node, cfg);
    await pve.waitTask(node, upid);
    if (start) await pve.waitTask(node, await pve.action(node, 'lxc', vmid, 'start'));
    res.json({ ok: true, vmid: cfg.vmid, upid });
    return undefined;
  }));

  // ===== Status task async (untuk indikator progres backup/snapshot/migrasi) =====
  r.get('/tasks/:node/:upid/status', h(async (req, res) => {
    const { node, upid } = req.params;
    if (!/^[a-zA-Z0-9.-]+$/.test(node)) return res.status(400).json({ error: 'Node tidak valid' });
    res.json(await pve.taskStatus(node, decodeURIComponent(upid)));
    return undefined;
  }));

  // ===== IP address guest (untuk ditampilkan di kartu) =====
  r.get('/guests/:vmid/ips', h(async (req, res) => {
    const { node, type } = await resolveGuest(req.params.vmid);
    const ips = [];
    try {
      if (type === 'lxc') {
        const cfg = await pve.config(node, type, req.params.vmid);
        // net0..netN: "name=eth0,bridge=vmbr0,ip=192.168.1.5/24,gw=..."
        for (const k of Object.keys(cfg)) {
          if (!/^net\d+$/.test(k)) continue;
          const m = /(?:^|,)ip=([^,]+)/.exec(cfg[k]);
          if (m && m[1] && m[1] !== 'dhcp' && m[1] !== 'manual') ips.push(m[1].split('/')[0]);
        }
      } else {
        // QEMU: butuh guest-agent aktif
        const data = await pve.agentInterfaces(node, req.params.vmid);
        const list = data?.result || data?.['result'] || [];
        for (const iface of list) {
          if (iface.name === 'lo') continue;
          for (const a of iface['ip-addresses'] || []) {
            if (a['ip-address-type'] === 'ipv4' && !a['ip-address'].startsWith('127.')) {
              ips.push(a['ip-address']);
            }
          }
        }
      }
    } catch (e) {
      return res.json({ ips: [], note: type === 'qemu' ? 'guest-agent tidak aktif' : e.message });
    }
    res.json({ ips: [...new Set(ips)] });
    return undefined;
  }));

  return r;
}
