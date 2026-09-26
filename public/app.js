// app.js — Frontend realtime Proxmox Dashboard (vanilla JS)
'use strict';

// Token auth opsional: simpan di localStorage bila diperlukan
const TOKEN = localStorage.getItem('pve_dash_token') || '';
const authHeaders = TOKEN ? { 'X-Auth-Token': TOKEN } : {};

const state = { guests: [], nodeStatus: null, nodeStatuses: {}, nodes: [], filter: 'all', nodeFilter: 'all', search: '', meta: null };

// ---------- Util ----------
const $ = (s) => document.querySelector(s);
// Escape HTML — WAJIB untuk semua data dari Proxmox (nama VM/CT, snapshot, dsb)
// sebelum masuk ke innerHTML. Mencegah XSS via nama guest berisi markup.
const esc = (s) => String(s == null ? '' : s)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
window.esc = esc;
const fmtBytes = (b) => {
  if (b == null) return '-';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0; let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
};
const fmtUptime = (s) => {
  if (!s) return '-';
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}h ${h}j` : h > 0 ? `${h}j ${m}m` : `${m}m`;
};
const pct = (a, b) => (b ? Math.min(100, (a / b) * 100) : 0);

function toast(msg, kind = 'info') {
  const colors = { info: 'bg-slate-800', ok: 'bg-emerald-700', err: 'bg-red-700', warn: 'bg-amber-700' };
  const el = document.createElement('div');
  el.className = `toast ${colors[kind]} text-white text-sm px-4 py-2 rounded-lg shadow-lg max-w-xs`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// Pelacak task asinkron (backup/snapshot/migrasi): tampilkan snackbar progres yang
// hidup sampai task selesai, lalu berubah jadi sukses/gagal. Poll ringan tiap 2s.
async function trackTask(upid, label, onDone) {
  if (!upid || typeof upid !== 'string' || !upid.includes(':')) {
    toast(`${label}: dimulai`, 'ok');
    if (onDone) onDone();
    return;
  }
  // UPID format: UPID:node:....  → ambil node
  const node = upid.split(':')[1];
  const el = document.createElement('div');
  el.className = 'toast bg-slate-800 text-white text-sm px-4 py-3 rounded-lg shadow-lg max-w-xs flex items-center gap-3';
  el.innerHTML = `<span class="inline-block w-4 h-4 border-2 border-slate-500 border-t-orange-400 rounded-full animate-spin"></span>
    <span><span class="font-medium">${esc(label)}</span><br><span class="text-xs text-slate-400" data-tstate>berjalan…</span></span>`;
  $('#toasts').appendChild(el);
  const setDone = (ok, txt) => {
    el.querySelector('span').outerHTML = ok ? '<span class="text-emerald-400">✓</span>' : '<span class="text-red-400">✕</span>';
    el.className = `toast ${ok ? 'bg-emerald-800' : 'bg-red-800'} text-white text-sm px-4 py-3 rounded-lg shadow-lg max-w-xs flex items-center gap-3`;
    const st = el.querySelector('[data-tstate]'); if (st) st.textContent = txt;
    setTimeout(() => el.remove(), 5000);
  };
  const started = Date.now();
  const poll = async () => {
    try {
      const s = await api(`/tasks/${node}/${encodeURIComponent(upid)}/status`);
      if (s.status === 'stopped') {
        if (s.exitstatus === 'OK') { setDone(true, 'selesai'); if (onDone) onDone(); }
        else setDone(false, `gagal: ${s.exitstatus || '?'}`);
        return;
      }
    } catch (e) {
      // task mungkin sudah lewat / tak bisa diakses — anggap selesai setelah beberapa saat
      if (Date.now() - started > 8000) { setDone(true, 'selesai (tak terlacak)'); if (onDone) onDone(); return; }
    }
    if (Date.now() - started > 30 * 60 * 1000) { setDone(false, 'timeout pelacakan'); return; }
    setTimeout(poll, 2000);
  };
  poll();
}
window.trackTask = trackTask;

// Cache IP guest agar tak fetch berulang tiap render (TTL 60s)
const ipCache = new Map();
async function loadGuestIP(vmid, el) {
  const c = ipCache.get(vmid);
  if (c && Date.now() - c.ts < 60000) { renderIP(el, c.ips); return; }
  try {
    const r = await api(`/guests/${vmid}/ips`);
    ipCache.set(vmid, { ips: r.ips || [], ts: Date.now() });
    renderIP(el, r.ips || []);
  } catch { renderIP(el, []); }
}
function renderIP(el, ips) {
  if (!el) return;
  if (ips.length) {
    el.innerHTML = ips.slice(0, 2).map((ip) => `<span class="font-mono">${esc(ip)}</span>`).join(' ');
    el.className = 'text-xs text-emerald-400/90 mt-0.5 cursor-pointer';
    el.title = 'Klik untuk salin';
    el.onclick = () => { navigator.clipboard?.writeText(ips[0]); toast(`IP ${ips[0]} disalin`, 'ok'); };
  } else {
    el.innerHTML = '<span class="text-slate-600">IP: -</span>';
    el.className = 'text-xs mt-0.5';
  }
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...authHeaders, ...(opts.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !path.startsWith('/auth/')) {
    // Sesi kedaluwarsa / belum login → tampilkan overlay login.
    if (typeof showLogin === 'function') showLogin();
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- WebSocket realtime ----------
let ws;
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${proto}://${location.host}/ws${TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''}`;
  ws = new WebSocket(url);
  ws.onopen = () => setWs(true);
  ws.onclose = () => { setWs(false); setTimeout(connectWS, 2000); };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'snapshot') {
      state.guests = msg.data.guests || [];
      state.nodeStatus = msg.data.nodeStatus;
      state.nodeStatuses = msg.data.nodeStatuses || {};
      state.nodes = msg.data.nodes || [];
      $('#nodeLabel').textContent = state.nodes.length > 1
        ? `${state.nodes.length} node · ${state.nodes.filter((n) => n.status === 'online').length} online`
        : `node: ${msg.data.node}`;
      $('#lastUpdate').textContent = `diperbarui ${new Date(msg.data.ts).toLocaleTimeString('id-ID')}`;
      renderNodeFilter();
      renderNodeStats();
      renderGuests();
    } else if (msg.type === 'error') {
      toast(`Proxmox: ${msg.message}`, 'err');
    }
  };
}
function setWs(on) {
  $('#wsDot').className = `w-2 h-2 rounded-full ${on ? 'bg-emerald-400' : 'bg-red-500'}`;
  $('#wsText').textContent = on ? 'realtime' : 'reconnect…';
}

// ---------- Render node stats ----------
function renderNodeStats() {
  const n = state.nodeStatus;
  const wrap = $('#nodeStats');
  if (!n) { wrap.innerHTML = ''; return; }
  const cpuPct = (n.cpu || 0) * 100;
  const memPct = pct(n.memory?.used, n.memory?.total);
  const rootPct = pct(n.rootfs?.used, n.rootfs?.total);
  const cards = [
    { label: 'CPU', val: `${cpuPct.toFixed(1)}%`, sub: `${n.cpuinfo?.cpus || '?'} core`, p: cpuPct, c: 'orange' },
    { label: 'RAM', val: `${memPct.toFixed(0)}%`, sub: `${fmtBytes(n.memory?.used)} / ${fmtBytes(n.memory?.total)}`, p: memPct, c: 'sky' },
    { label: 'Root FS', val: `${rootPct.toFixed(0)}%`, sub: `${fmtBytes(n.rootfs?.used)} / ${fmtBytes(n.rootfs?.total)}`, p: rootPct, c: 'violet' },
    { label: 'Uptime', val: fmtUptime(n.uptime), sub: `load ${n.loadavg?.[0] ?? '-'}`, p: null, c: 'emerald' },
  ];
  wrap.innerHTML = cards.map((c) => `
    <div class="bg-slate-900 border border-slate-800 rounded-xl p-4">
      <div class="flex justify-between items-baseline">
        <span class="text-xs text-slate-400">${c.label}</span>
        <span class="text-lg font-semibold">${c.val}</span>
      </div>
      ${c.p != null ? `<div class="mt-2 h-1.5 bg-slate-800 rounded-full overflow-hidden">
        <div class="h-full bg-${c.c}-500" style="width:${c.p}%"></div></div>` : ''}
      <div class="mt-1 text-xs text-slate-500">${c.sub}</div>
    </div>`).join('');
}

// ---------- Render guest cards ----------
function statusBadge(s) {
  const map = { running: 'bg-emerald-500/20 text-emerald-400', stopped: 'bg-slate-600/30 text-slate-400', paused: 'bg-amber-500/20 text-amber-400' };
  return `<span class="px-2 py-0.5 rounded text-xs ${map[s] || 'bg-slate-700'}">${s}</span>`;
}

// Node filter bar (multi-node)
function renderNodeFilter() {
  const wrap = $('#nodeFilterWrap');
  if (state.nodes.length <= 1) { wrap.classList.add('hidden'); return; }
  wrap.classList.remove('hidden');
  const btn = (val, label, online) => `<button data-nodefilter="${esc(val)}" class="px-3 py-1 rounded-md ${state.nodeFilter === val ? 'active bg-orange-600' : 'bg-slate-800 hover:bg-slate-700'}">${esc(label)}${online === false ? ' <span class="text-red-400">●</span>' : ''}</button>`;
  $('#nodeFilter').innerHTML = btn('all', 'Semua node')
    + state.nodes.map((n) => btn(n.node, n.node, n.status === 'online')).join('');
}

function renderGuests() {
  const grid = $('#guestGrid');
  let list = state.guests.filter((g) => !g.template);
  if (state.nodeFilter && state.nodeFilter !== 'all') list = list.filter((g) => g.node === state.nodeFilter);
  if (state.filter === 'qemu' || state.filter === 'lxc') list = list.filter((g) => g.type === state.filter);
  if (state.filter === 'running' || state.filter === 'stopped') list = list.filter((g) => g.status === state.filter);
  if (state.search) {
    const q = state.search.toLowerCase();
    list = list.filter((g) => `${g.name} ${g.vmid}`.toLowerCase().includes(q));
  }
  list.sort((a, b) => a.vmid - b.vmid);

  $('#emptyState').classList.toggle('hidden', list.length > 0);
  grid.innerHTML = list.map((g) => {
    const run = g.status === 'running';
    const cpuP = pct(g.cpu, 1);
    const memP = pct(g.mem, g.maxmem);
    const diskP = pct(g.disk, g.maxdisk);
    const typeColor = g.type === 'qemu' ? 'text-orange-400 bg-orange-500/10' : 'text-sky-400 bg-sky-500/10';
    return `
    <div class="bg-slate-900 border border-slate-800 rounded-xl p-4 hover:border-slate-700 transition">
      <div class="flex items-start justify-between">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <span class="px-1.5 py-0.5 rounded text-[10px] font-bold uppercase ${typeColor}">${g.type === 'qemu' ? 'VM' : 'CT'}</span>
            <span class="font-semibold truncate">${esc(g.name) || '(tanpa nama)'}</span>
          </div>
          <div class="text-xs text-slate-500 mt-0.5">#${g.vmid} · ${fmtUptime(g.uptime)}</div>
          <div class="guest-ip text-xs mt-0.5" data-ipfor="${g.vmid}">${run ? '<span class="text-slate-600">IP: …</span>' : '<span class="text-slate-600">IP: -</span>'}</div>
        </div>
        ${statusBadge(g.status)}
      </div>

      <div class="mt-3 space-y-1.5 text-xs">
        <div class="flex justify-between text-slate-400"><span>CPU</span><span>${run ? (g.cpu * 100).toFixed(1) + '%' : '-'} · ${g.maxcpu} core</span></div>
        <div class="h-1 bg-slate-800 rounded-full overflow-hidden"><div class="h-full bg-orange-500" style="width:${run ? cpuP : 0}%"></div></div>
        <div class="flex justify-between text-slate-400"><span>RAM</span><span>${fmtBytes(g.mem)} / ${fmtBytes(g.maxmem)}</span></div>
        <div class="h-1 bg-slate-800 rounded-full overflow-hidden"><div class="h-full bg-sky-500" style="width:${memP}%"></div></div>
        <div class="flex justify-between text-slate-400"><span>Disk</span><span>${fmtBytes(g.disk)} / ${fmtBytes(g.maxdisk)}</span></div>
        <div class="h-1 bg-slate-800 rounded-full overflow-hidden"><div class="h-full bg-violet-500" style="width:${diskP}%"></div></div>
      </div>

      <div class="mt-3 flex flex-wrap gap-1.5">
        ${run
          ? `<button data-act="shutdown" data-id="${g.vmid}" class="act-btn px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs">Shutdown</button>
             <button data-act="reboot" data-id="${g.vmid}" class="act-btn px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs">Reboot</button>
             ${g.type === 'qemu' ? `<button data-act="reset" data-id="${g.vmid}" class="act-btn px-2 py-1 rounded bg-amber-700/60 hover:bg-amber-700 text-xs">Reset</button>` : ''}
             <button data-act="stop" data-id="${g.vmid}" class="act-btn px-2 py-1 rounded bg-red-800/60 hover:bg-red-800 text-xs">Stop</button>`
          : `<button data-act="start" data-id="${g.vmid}" class="act-btn px-2 py-1 rounded bg-emerald-700/70 hover:bg-emerald-700 text-xs">Start</button>`}
        <button data-edit="${g.vmid}" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs">⚙ Resource</button>
        <button data-del="${g.vmid}" data-name="${esc(g.name)}" class="px-2 py-1 rounded bg-slate-800 hover:bg-red-900 text-xs ml-auto">🗑</button>
      </div>
      <div class="mt-1.5 flex flex-wrap gap-1.5 border-t border-slate-800 pt-2">
        ${run ? `<button data-console="${g.vmid}" data-name="${esc(g.name)}" data-ctype="${g.type}" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs">🖥 Console</button>` : ''}
        <button data-hist="${g.vmid}" data-name="${esc(g.name)}" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs">📈 Histori</button>
        <button data-snap="${g.vmid}" data-name="${esc(g.name)}" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs">📸 Snapshot</button>
        <button data-backup="${g.vmid}" data-name="${esc(g.name)}" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs">💾 Backup</button>
        <button data-migrate="${g.vmid}" data-name="${esc(g.name)}" data-node="${esc(g.node)}" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs">↔ Migrasi</button>
        <button data-netedit="${g.vmid}" data-name="${esc(g.name)}" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs">🌐 IP</button>
      </div>
    </div>`;
  }).join('');

  // Muat IP address untuk guest yang berjalan (async, non-blocking)
  const running = new Set(list.filter((g) => g.status === 'running').map((g) => String(g.vmid)));
  grid.querySelectorAll('[data-ipfor]').forEach((el) => {
    if (running.has(el.dataset.ipfor)) loadGuestIP(el.dataset.ipfor, el);
  });
}

// ---------- Aksi lifecycle ----------
async function doAction(vmid, act) {
  if (act === 'stop' && !confirm(`Stop paksa #${vmid}? (tidak graceful)`)) return;
  try {
    await api(`/guests/${vmid}/action/${act}`, { method: 'POST' });
    toast(`${act} #${vmid} dikirim`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

async function doDelete(vmid, name) {
  if (!confirm(`HAPUS PERMANEN #${vmid} (${name})?\nData tidak bisa dikembalikan.`)) return;
  if (!confirm(`Konfirmasi sekali lagi: hapus #${vmid}?`)) return;
  try {
    await api(`/guests/${vmid}`, { method: 'DELETE' });
    toast(`#${vmid} dihapus`, 'ok');
  } catch (e) { toast(e.message, 'err'); }
}

// ---------- Modal ----------
function modal(html, maxW = 'max-w-md') {
  $('#modalRoot').innerHTML = `
    <div class="fixed inset-0 z-40 bg-black/60 flex items-center justify-center p-4" id="modalBg">
      <div class="bg-slate-900 border border-slate-700 rounded-xl w-full ${maxW} max-h-[90vh] overflow-y-auto" onclick="event.stopPropagation()">
        ${html}
      </div>
    </div>`;
  $('#modalBg').onclick = closeModal;
}
window.modal = modal;
function closeModal() { $('#modalRoot').innerHTML = ''; }
window.closeModal = closeModal;

function field(label, inner) {
  return `<label class="block mb-3"><span class="text-xs text-slate-400">${label}</span>${inner}</label>`;
}
const inputCls = 'mt-1 w-full bg-slate-800 border border-slate-700 rounded-md px-3 py-2 text-sm focus:outline-none focus:border-orange-500';

// ---- Modal edit resource (CPU/RAM/Disk) ----
async function editResource(vmid) {
  let detail;
  try { detail = await api(`/guests/${vmid}`); } catch (e) { return toast(e.message, 'err'); }
  const cfg = detail.config;
  const diskKey = detail.type === 'qemu' ? 'scsi0' : 'rootfs';
  modal(`
    <div class="p-5">
      <h2 class="font-semibold text-lg mb-4">Resource #${vmid} <span class="text-xs text-slate-500">${detail.type}</span></h2>
      ${field('vCPU (cores)', `<input id="f_cores" type="number" min="1" value="${cfg.cores || 1}" class="${inputCls}">`)}
      ${field('RAM (MB)', `<input id="f_mem" type="number" min="256" step="256" value="${cfg.memory || 512}" class="${inputCls}">`)}
      <button id="saveRes" class="w-full mt-1 mb-5 bg-orange-600 hover:bg-orange-500 rounded-md py-2 text-sm font-medium">Simpan CPU/RAM</button>
      <hr class="border-slate-800 mb-4">
      <p class="text-xs text-slate-400 mb-2">Tambah disk (<b>${diskKey}</b>). Hanya bisa memperbesar.</p>
      <div class="flex gap-2">
        <input id="f_diskadd" type="number" min="1" value="10" class="${inputCls} flex-1">
        <span class="self-center text-sm text-slate-400">GB</span>
        <button id="addDisk" class="px-4 bg-violet-600 hover:bg-violet-500 rounded-md text-sm">Tambah</button>
      </div>
      <button onclick="closeModal()" class="w-full mt-5 text-sm text-slate-400 hover:text-white">Tutup</button>
    </div>`);

  $('#saveRes').onclick = async () => {
    try {
      await api(`/guests/${vmid}/resources`, {
        method: 'PUT',
        body: JSON.stringify({ cores: +$('#f_cores').value, memory: +$('#f_mem').value }),
      });
      toast('CPU/RAM diperbarui (reboot bila perlu)', 'ok'); closeModal();
    } catch (e) { toast(e.message, 'err'); }
  };
  $('#addDisk').onclick = async () => {
    try {
      await api(`/guests/${vmid}/disk`, {
        method: 'PUT',
        body: JSON.stringify({ disk: diskKey, size: `+${+$('#f_diskadd').value}G` }),
      });
      toast('Disk diperbesar', 'ok'); closeModal();
    } catch (e) { toast(e.message, 'err'); }
  };
}

// ---- Modal edit IP / Gateway ----
async function editNetwork(vmid, name) {
  let info;
  try { info = await api(`/guests/${vmid}/network`); } catch (e) { return toast(e.message, 'err'); }
  const nets = info.nets || [];
  if (!nets.length) return toast('Tidak ada interface jaringan ditemukan', 'warn');
  const isVM = info.type === 'qemu';
  const opts = nets.map((n, i) => `<option value="${esc(n.iface)}">${esc(n.iface)}${n.bridge ? ` (${esc(n.bridge)})` : ''}</option>`).join('');
  const first = nets[0];
  modal(`
    <div class="p-5">
      <h2 class="font-semibold text-lg mb-1">🌐 Konfigurasi IP</h2>
      <p class="text-xs text-slate-500 mb-4">#${vmid} · ${esc(name || '')} <span class="uppercase">${esc(info.type)}</span></p>
      ${field('Interface', `<select id="n_iface" class="${inputCls}">${opts}</select>`)}
      <label class="flex items-center gap-2 mb-3 text-sm"><input id="n_dhcp" type="checkbox" class="accent-orange-500" ${first.ip === 'dhcp' ? 'checked' : ''}> Pakai DHCP (otomatis)</label>
      <div id="n_static">
        ${field('IP Address (CIDR, mis. 192.168.1.50/24)', `<input id="n_ip" value="${esc(first.ip === 'dhcp' ? '' : first.ip)}" placeholder="192.168.1.50/24" class="${inputCls}">`)}
        ${field('Gateway', `<input id="n_gw" value="${esc(first.gw)}" placeholder="192.168.1.1" class="${inputCls}">`)}
      </div>
      <p class="text-xs text-amber-400/80 mb-4">${isVM ? '⚠ VM: IP diterapkan via cloud-init, perlu reboot & template cloud-init.' : 'ℹ CT: perubahan langsung diterapkan ke config; reboot bila tak aktif.'}</p>
      <button id="n_save" class="w-full bg-orange-600 hover:bg-orange-500 rounded-md py-2.5 text-sm font-medium">Simpan IP</button>
      <button onclick="closeModal()" class="w-full mt-2 text-sm text-slate-400 hover:text-white">Batal</button>
    </div>`);

  const netByIface = Object.fromEntries(nets.map((n) => [n.iface, n]));
  const syncFields = () => {
    const n = netByIface[$('#n_iface').value] || first;
    const dhcp = n.ip === 'dhcp';
    $('#n_dhcp').checked = dhcp;
    $('#n_ip').value = dhcp ? '' : n.ip;
    $('#n_gw').value = n.gw || '';
    $('#n_static').style.display = dhcp ? 'none' : '';
  };
  $('#n_iface').onchange = syncFields;
  $('#n_dhcp').onchange = () => { $('#n_static').style.display = $('#n_dhcp').checked ? 'none' : ''; };
  $('#n_static').style.display = first.ip === 'dhcp' ? 'none' : '';

  $('#n_save').onclick = async () => {
    const btn = $('#n_save'); btn.disabled = true; btn.textContent = 'Menyimpan…';
    const dhcp = $('#n_dhcp').checked;
    const body = { iface: $('#n_iface').value, ip: dhcp ? 'dhcp' : $('#n_ip').value.trim(), gw: dhcp ? '' : $('#n_gw').value.trim() };
    try {
      const r = await api(`/guests/${vmid}/network`, { method: 'PUT', body: JSON.stringify(body) });
      toast(r.note || 'IP diperbarui', 'ok'); closeModal();
      ipCache.delete(String(vmid));
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Simpan IP'; }
  };
}

// ---- Modal create VM ----
async function createVMModal() {
  const meta = await api('/meta').catch(() => null);
  const stores = (meta?.storages || []).filter((s) => (s.content || '').includes('images'));
  const nextid = meta?.nextid || '';
  modal(`
    <div class="p-5">
      <h2 class="font-semibold text-lg mb-4 text-orange-400">Buat VM Baru</h2>
      ${field('VMID', `<input id="v_vmid" type="number" value="${nextid}" class="${inputCls}">`)}
      ${field('Nama', `<input id="v_name" placeholder="web-01" class="${inputCls}">`)}
      <div class="grid grid-cols-2 gap-3">
        ${field('vCPU', `<input id="v_cores" type="number" value="2" min="1" class="${inputCls}">`)}
        ${field('RAM (MB)', `<input id="v_mem" type="number" value="2048" step="256" class="${inputCls}">`)}
      </div>
      <div class="grid grid-cols-2 gap-3">
        ${field('Disk (GB)', `<input id="v_disk" type="number" value="20" min="1" class="${inputCls}">`)}
        ${field('Storage', `<select id="v_storage" class="${inputCls}">${stores.map((s) => `<option value="${esc(s.storage)}">${esc(s.storage)}</option>`).join('')}</select>`)}
      </div>
      ${field('Bridge', `<input id="v_bridge" value="${esc(meta?.defaults?.bridge || 'vmbr0')}" class="${inputCls}">`)}
      ${field('ISO (opsional, mis. local:iso/ubuntu.iso)', `<input id="v_iso" placeholder="kosongkan bila pakai template" class="${inputCls}">`)}
      <label class="flex items-center gap-2 mb-4 text-sm"><input id="v_start" type="checkbox" class="accent-orange-500"> Start setelah dibuat</label>
      <button id="v_submit" class="w-full bg-orange-600 hover:bg-orange-500 rounded-md py-2.5 text-sm font-medium">Buat VM</button>
      <button onclick="closeModal()" class="w-full mt-2 text-sm text-slate-400 hover:text-white">Batal</button>
    </div>`);
  $('#v_submit').onclick = async () => {
    const btn = $('#v_submit'); btn.disabled = true; btn.textContent = 'Membuat…';
    try {
      const r = await api('/vms', {
        method: 'POST',
        body: JSON.stringify({
          vmid: $('#v_vmid').value, name: $('#v_name').value,
          cores: $('#v_cores').value, memory: $('#v_mem').value,
          diskSize: $('#v_disk').value, storage: $('#v_storage').value,
          bridge: $('#v_bridge').value, isoImage: $('#v_iso').value || undefined,
          start: $('#v_start').checked,
        }),
      });
      toast(`VM #${r.vmid} dibuat`, 'ok'); closeModal();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Buat VM'; }
  };
}

// ---- Modal create CT ----
async function createCTModal() {
  const meta = await api('/meta').catch(() => null);
  const stores = (meta?.storages || []).filter((s) => (s.content || '').includes('rootdir'));
  const tmpls = meta?.templates || [];
  const nextid = meta?.nextid || '';
  modal(`
    <div class="p-5">
      <h2 class="font-semibold text-lg mb-4 text-sky-400">Buat Container (LXC)</h2>
      ${field('VMID', `<input id="c_vmid" type="number" value="${nextid}" class="${inputCls}">`)}
      ${field('Hostname', `<input id="c_host" placeholder="app-ct" class="${inputCls}">`)}
      ${field('Template OS', `<select id="c_tmpl" class="${inputCls}">${tmpls.length ? tmpls.map((t) => `<option value="${esc(t.volid)}">${esc(t.volid.split('/').pop())}</option>`).join('') : `<option value="">(unduh template dulu di Proxmox)</option>`}</select>`)}
      <div class="grid grid-cols-2 gap-3">
        ${field('vCPU', `<input id="c_cores" type="number" value="2" min="1" class="${inputCls}">`)}
        ${field('RAM (MB)', `<input id="c_mem" type="number" value="2048" step="256" class="${inputCls}">`)}
      </div>
      <div class="grid grid-cols-2 gap-3">
        ${field('Disk (GB)', `<input id="c_disk" type="number" value="8" min="1" class="${inputCls}">`)}
        ${field('Storage', `<select id="c_storage" class="${inputCls}">${stores.map((s) => `<option value="${esc(s.storage)}">${esc(s.storage)}</option>`).join('')}</select>`)}
      </div>
      ${field('Password root', `<input id="c_pass" type="password" placeholder="min 5 karakter" class="${inputCls}">`)}
      ${field('SSH Public Key (opsional)', `<textarea id="c_ssh" rows="2" placeholder="ssh-ed25519 AAAA…" class="${inputCls}"></textarea>`)}
      <div class="grid grid-cols-2 gap-3">
        ${field('IP (dhcp / CIDR)', `<input id="c_ip" value="dhcp" class="${inputCls}">`)}
        ${field('Gateway', `<input id="c_gw" placeholder="192.168.1.1" class="${inputCls}">`)}
      </div>
      ${field('Bridge', `<input id="c_bridge" value="${esc(meta?.defaults?.bridge || 'vmbr0')}" class="${inputCls}">`)}
      <div class="flex gap-4 mb-4 text-sm">
        <label class="flex items-center gap-2"><input id="c_unpriv" type="checkbox" checked class="accent-sky-500"> Unprivileged</label>
        <label class="flex items-center gap-2"><input id="c_nest" type="checkbox" checked class="accent-sky-500"> Nesting</label>
        <label class="flex items-center gap-2"><input id="c_start" type="checkbox" class="accent-sky-500"> Start</label>
      </div>
      <button id="c_submit" class="w-full bg-sky-600 hover:bg-sky-500 rounded-md py-2.5 text-sm font-medium">Buat Container</button>
      <button onclick="closeModal()" class="w-full mt-2 text-sm text-slate-400 hover:text-white">Batal</button>
    </div>`);
  $('#c_submit').onclick = async () => {
    const btn = $('#c_submit'); btn.disabled = true; btn.textContent = 'Membuat…';
    try {
      const r = await api('/cts', {
        method: 'POST',
        body: JSON.stringify({
          vmid: $('#c_vmid').value, hostname: $('#c_host').value,
          ostemplate: $('#c_tmpl').value, cores: $('#c_cores').value, memory: $('#c_mem').value,
          diskSize: $('#c_disk').value, storage: $('#c_storage').value,
          password: $('#c_pass').value || undefined, sshKey: $('#c_ssh').value || undefined,
          ip: $('#c_ip').value, gw: $('#c_gw').value || undefined, bridge: $('#c_bridge').value,
          unprivileged: $('#c_unpriv').checked, nesting: $('#c_nest').checked, start: $('#c_start').checked,
        }),
      });
      toast(`CT #${r.vmid} dibuat`, 'ok'); closeModal();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Buat Container'; }
  };
}

// ---------- Event delegation ----------
document.addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  const d = t.dataset;
  if (d.act) doAction(d.id, d.act);
  else if (d.edit) editResource(d.edit);
  else if (d.del) doDelete(d.del, d.name);
  else if (d.hist) Features.openHistory(d.hist, d.name);
  else if (d.snap) Features.openSnapshots(d.snap, d.name);
  else if (d.backup) Features.openBackup(d.backup, d.name);
  else if (d.migrate) Features.openMigrate(d.migrate, d.name, d.node);
  else if (d.netedit) editNetwork(d.netedit, d.name);
  else if (d.console) Features.openConsole(d.console, d.name, d.ctype);
  else if (d.nodefilter != null) {
    state.nodeFilter = d.nodefilter;
    document.querySelectorAll('#nodeFilter button').forEach((b) => b.classList.toggle('active', b === t));
    renderGuests();
  } else if (d.filter) {
    state.filter = d.filter;
    document.querySelectorAll('.filter-btn').forEach((b) => b.classList.toggle('active', b === t));
    renderGuests();
  }
});
$('#btnCreateVM').onclick = createVMModal;
$('#btnCreateCT').onclick = createCTModal;
$('#search').oninput = (e) => { state.search = e.target.value; renderGuests(); };

// ---------- Auth login gate ----------
async function initAuth() {
  let st;
  try { st = await api('/auth/status'); } catch { st = { loginEnabled: false, authenticated: true }; }
  if (st.loginEnabled) {
    $('#btnLogout').classList.remove('hidden');
    if (!st.authenticated) { showLogin(); return false; }
  }
  return true;
}
function showLogin() {
  const ov = $('#loginOverlay');
  ov.classList.remove('hidden');
  const err = $('#li_err');
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    err.classList.add('hidden');
    const btn = $('#li_submit'); btn.disabled = true; btn.textContent = 'Memeriksa…';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: $('#li_user').value, password: $('#li_pass').value }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Login gagal');
      ov.classList.add('hidden');
      startApp();
    } catch (ex) {
      err.textContent = ex.message; err.classList.remove('hidden');
      btn.disabled = false; btn.textContent = 'Masuk';
    }
  };
  $('#li_user').focus();
}
async function doLogout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch {}
  location.reload();
}

function startApp() {
  document.querySelector('[data-filter="all"]').classList.add('active');
  connectWS();
}

// init
$('#btnLogout').onclick = doLogout;
$('#btnNodeTerm').onclick = () => Features.openNodeTerminal(state.nodeFilter !== 'all' ? state.nodeFilter : (state.nodes[0]?.node || ''));
(async () => { if (await initAuth()) startApp(); })();
