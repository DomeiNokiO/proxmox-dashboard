// src/routes.js — REST API endpoints untuk dashboard
import express from 'express';
import { config } from './config.js';

export function buildRouter(pve) {
  const r = express.Router();
  const NODE = config.proxmox.node;

  // Wrapper async agar error tertangkap
  const h = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error('[API ERROR]', e.message);
    res.status(e.status || 500).json({ error: e.message });
  });

  // --- Info cluster / node ---
  r.get('/info', h(async (_req, res) => {
    const [version, nodes] = await Promise.all([pve.version(), pve.nodes()]);
    res.json({ version, nodes, node: NODE });
  }));

  r.get('/node-status', h(async (_req, res) => {
    res.json(await pve.nodeStatus(NODE));
  }));

  // --- Daftar semua VM & CT ---
  r.get('/guests', h(async (_req, res) => {
    const list = await pve.clusterResources();
    res.json(list.map((g) => ({
      vmid: g.vmid,
      name: g.name,
      type: g.type,
      status: g.status,
      node: g.node,
      cpu: g.cpu,
      maxcpu: g.maxcpu,
      mem: g.mem,
      maxmem: g.maxmem,
      disk: g.disk,
      maxdisk: g.maxdisk,
      uptime: g.uptime,
      template: g.template,
    })));
  }));

  // --- Detail satu guest ---
  r.get('/guests/:vmid', h(async (req, res) => {
    const { vmid } = req.params;
    const type = await pve.detectType(NODE, vmid);
    const [status, cfg] = await Promise.all([
      pve.currentStatus(NODE, type, vmid),
      pve.config(NODE, type, vmid),
    ]);
    res.json({ vmid, type, status, config: cfg });
  }));

  // --- Aksi lifecycle: start/stop/shutdown/reboot/reset/suspend/resume ---
  const ALLOWED = new Set(['start', 'stop', 'shutdown', 'reboot', 'reset', 'suspend', 'resume']);
  r.post('/guests/:vmid/action/:act', h(async (req, res) => {
    const { vmid, act } = req.params;
    if (!ALLOWED.has(act)) return res.status(400).json({ error: `Aksi tidak valid: ${act}` });
    const type = await pve.detectType(NODE, vmid);
    // reset/suspend/resume hanya untuk qemu
    if (['reset', 'suspend', 'resume'].includes(act) && type !== 'qemu') {
      return res.status(400).json({ error: `Aksi ${act} hanya untuk VM (qemu)` });
    }
    const upid = await pve.action(NODE, type, vmid, act);
    res.json({ ok: true, upid });
    return undefined;
  }));

  // --- Ubah CPU / RAM ---
  r.put('/guests/:vmid/resources', h(async (req, res) => {
    const { vmid } = req.params;
    const { cores, memory } = req.body; // memory dalam MB
    const type = await pve.detectType(NODE, vmid);
    const cfg = {};
    if (cores != null) cfg.cores = parseInt(cores, 10);
    if (memory != null) cfg.memory = parseInt(memory, 10);
    if (Object.keys(cfg).length === 0) {
      return res.status(400).json({ error: 'Butuh cores dan/atau memory' });
    }
    await pve.setConfig(NODE, type, vmid, cfg);
    res.json({ ok: true, applied: cfg });
    return undefined;
  }));

  // --- Tambah disk (resize) ---
  r.put('/guests/:vmid/disk', h(async (req, res) => {
    const { vmid } = req.params;
    const { disk, size } = req.body; // disk mis. 'scsi0'/'rootfs', size mis. '+10G'
    if (!disk || !size) return res.status(400).json({ error: 'Butuh disk & size (mis. +10G)' });
    const type = await pve.detectType(NODE, vmid);
    await pve.resize(NODE, type, vmid, disk, size);
    res.json({ ok: true });
    return undefined;
  }));

  // --- Hapus guest (auto-stop bila running) ---
  r.delete('/guests/:vmid', h(async (req, res) => {
    const { vmid } = req.params;
    const type = await pve.detectType(NODE, vmid);
    const st = await pve.currentStatus(NODE, type, vmid);
    if (st.status === 'running') {
      const stopUpid = await pve.action(NODE, type, vmid, 'stop');
      await pve.waitTask(NODE, stopUpid);
    }
    const upid = await pve.destroy(NODE, type, vmid, true);
    res.json({ ok: true, upid });
  }));

  // --- Data pendukung untuk form create ---
  r.get('/meta', h(async (_req, res) => {
    const [storages, nextid] = await Promise.all([pve.storages(NODE), pve.nextId()]);
    let templates = [];
    try {
      templates = await pve.templates(NODE, config.defaults.ctTemplateStorage);
    } catch { /* storage template mungkin beda */ }
    res.json({
      storages: storages.map((s) => ({
        storage: s.storage, type: s.type, content: s.content,
        avail: s.avail, total: s.total,
      })),
      templates: templates.map((t) => ({ volid: t.volid, size: t.size })),
      nextid,
      defaults: config.defaults,
    });
  }));

  // --- Create VM (QEMU) ---
  r.post('/vms', h(async (req, res) => {
    const {
      vmid, name, cores = 2, memory = 2048, diskSize = 20,
      storage = config.defaults.storage, bridge = config.defaults.bridge,
      isoImage, ostype = 'l26', start = false,
    } = req.body;
    if (!vmid || !name) return res.status(400).json({ error: 'Butuh vmid & name' });

    const cfg = {
      vmid: parseInt(vmid, 10),
      name,
      cores: parseInt(cores, 10),
      memory: parseInt(memory, 10),
      net0: `virtio,bridge=${bridge}`,
      scsihw: 'virtio-scsi-pci',
      scsi0: `${storage}:${parseInt(diskSize, 10)}`,
      ostype,
      agent: 'enabled=1',
    };
    if (isoImage) {
      cfg.ide2 = `${isoImage},media=cdrom`;
      cfg.boot = 'order=scsi0;ide2';
    }
    const upid = await pve.createVM(NODE, cfg);
    await pve.waitTask(NODE, upid);
    if (start) {
      const s = await pve.action(NODE, 'qemu', vmid, 'start');
      await pve.waitTask(NODE, s);
    }
    res.json({ ok: true, vmid: cfg.vmid, upid });
    return undefined;
  }));

  // --- Create Container (LXC) ---
  r.post('/cts', h(async (req, res) => {
    const {
      vmid, hostname, cores = 2, memory = 2048, diskSize = 8,
      storage = config.defaults.storage, bridge = config.defaults.bridge,
      ostemplate = config.defaults.ctTemplate,
      password, sshKey, ip = 'dhcp', gw, unprivileged = true, nesting = true,
      start = false,
    } = req.body;
    if (!vmid || !hostname) return res.status(400).json({ error: 'Butuh vmid & hostname' });
    if (!ostemplate) return res.status(400).json({ error: 'Butuh ostemplate (pilih dari /meta)' });
    if (!password && !sshKey) {
      return res.status(400).json({ error: 'Butuh password atau sshKey' });
    }

    let netStr = `name=eth0,bridge=${bridge},ip=${ip}`;
    if (ip !== 'dhcp' && gw) netStr += `,gw=${gw}`;

    const cfg = {
      vmid: parseInt(vmid, 10),
      hostname,
      cores: parseInt(cores, 10),
      memory: parseInt(memory, 10),
      rootfs: `${storage}:${parseInt(diskSize, 10)}`,
      ostemplate,
      net0: netStr,
      unprivileged: unprivileged ? 1 : 0,
      features: nesting ? 'nesting=1' : undefined,
    };
    if (password) cfg.password = password;
    if (sshKey) cfg['ssh-public-keys'] = sshKey;

    const upid = await pve.createCT(NODE, cfg);
    await pve.waitTask(NODE, upid);
    if (start) {
      const s = await pve.action(NODE, 'lxc', vmid, 'start');
      await pve.waitTask(NODE, s);
    }
    res.json({ ok: true, vmid: cfg.vmid, upid });
    return undefined;
  }));

  return r;
}
