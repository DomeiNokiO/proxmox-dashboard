// features.js — Fitur lanjutan: histori grafik, snapshot, backup, migrasi, VNC console.
// Memakai helper global dari app.js: $, api, toast, modal, closeModal, fmtBytes, inputCls, field.
'use strict';

// ---------- 1. Histori grafik (Chart.js + RRD) ----------
let _chart;
async function openHistory(vmid, name) {
  modal(`
    <div class="p-5">
      <div class="flex items-center justify-between mb-3">
        <h2 class="font-semibold text-lg">Histori #${vmid} <span class="text-xs text-slate-500">${name || ''}</span></h2>
        <select id="h_tf" class="bg-slate-800 border border-slate-700 rounded-md px-2 py-1 text-sm">
          <option value="hour">1 Jam</option><option value="day">1 Hari</option>
          <option value="week">1 Minggu</option><option value="month">1 Bulan</option>
        </select>
      </div>
      <div class="h-64"><canvas id="h_cpu"></canvas></div>
      <div class="h-64 mt-4"><canvas id="h_mem"></canvas></div>
      <button onclick="closeModal()" class="w-full mt-4 text-sm text-slate-400 hover:text-white">Tutup</button>
    </div>`, 'max-w-2xl');
  const draw = async () => {
    const tf = $('#h_tf').value;
    let data;
    try { data = await api(`/guests/${vmid}/rrd?timeframe=${tf}`); }
    catch (e) { return toast(e.message, 'err'); }
    const labels = data.map((d) => new Date(d.time * 1000).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }));
    renderChart('h_cpu', 'CPU %', labels, data.map((d) => ((d.cpu || 0) * 100).toFixed(1)), '#f97316');
    renderChart('h_mem', 'RAM (MB)', labels, data.map((d) => ((d.mem || 0) / 1048576).toFixed(0)), '#38bdf8');
  };
  $('#h_tf').onchange = draw;
  draw();
}
function renderChart(canvasId, label, labels, values, color) {
  const ctx = document.getElementById(canvasId);
  if (!ctx || !window.Chart) return;
  if (ctx._chart) ctx._chart.destroy();
  ctx._chart = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ label, data: values, borderColor: color, backgroundColor: color + '22', fill: true, tension: 0.3, pointRadius: 0, borderWidth: 2 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#94a3b8' } } },
      scales: { x: { ticks: { color: '#64748b', maxTicksLimit: 8 }, grid: { color: '#1e293b' } }, y: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' }, beginAtZero: true } },
    },
  });
}

// ---------- 2. Snapshot ----------
async function openSnapshots(vmid, name) {
  modal(`<div class="p-5"><h2 class="font-semibold text-lg mb-4">Snapshot #${vmid} <span class="text-xs text-slate-500">${name || ''}</span></h2>
    <div class="flex gap-2 mb-4">
      <input id="s_name" placeholder="nama-snapshot" class="${inputCls} flex-1">
      <button id="s_create" class="px-4 bg-emerald-600 hover:bg-emerald-500 rounded-md text-sm">Buat</button>
    </div>
    <input id="s_desc" placeholder="deskripsi (opsional)" class="${inputCls} mb-4">
    <div id="s_list" class="space-y-2 max-h-72 overflow-y-auto text-sm"><p class="text-slate-500">memuat…</p></div>
    <button onclick="closeModal()" class="w-full mt-4 text-sm text-slate-400 hover:text-white">Tutup</button></div>`);
  const load = async () => {
    try {
      const snaps = (await api(`/guests/${vmid}/snapshots`)).filter((s) => s.name !== 'current');
      $('#s_list').innerHTML = snaps.length ? snaps.map((s) => `
        <div class="flex items-center justify-between bg-slate-800 rounded-md px-3 py-2">
          <div><div class="font-medium">${s.name}</div>
          <div class="text-xs text-slate-500">${s.snaptime ? new Date(s.snaptime * 1000).toLocaleString('id-ID') : ''} ${s.description ? '· ' + s.description : ''}</div></div>
          <div class="flex gap-1">
            <button data-snaproll="${s.name}" class="px-2 py-1 rounded bg-amber-700/60 hover:bg-amber-700 text-xs">Rollback</button>
            <button data-snapdel="${s.name}" class="px-2 py-1 rounded bg-red-800/60 hover:bg-red-800 text-xs">Hapus</button>
          </div></div>`).join('') : '<p class="text-slate-500">Belum ada snapshot.</p>';
    } catch (e) { $('#s_list').innerHTML = `<p class="text-red-400">${e.message}</p>`; }
  };
  $('#s_create').onclick = async () => {
    const snapname = $('#s_name').value.trim();
    if (!snapname) return toast('Isi nama snapshot', 'warn');
    try { await api(`/guests/${vmid}/snapshots`, { method: 'POST', body: JSON.stringify({ snapname, description: $('#s_desc').value }) }); toast('Snapshot dibuat', 'ok'); $('#s_name').value = ''; load(); }
    catch (e) { toast(e.message, 'err'); }
  };
  $('#s_list').onclick = async (e) => {
    const roll = e.target.dataset.snaproll; const del = e.target.dataset.snapdel;
    if (roll && confirm(`Rollback ke snapshot "${roll}"? State saat ini akan hilang.`)) {
      try { await api(`/guests/${vmid}/snapshots/${roll}/rollback`, { method: 'POST' }); toast('Rollback dikirim', 'ok'); }
      catch (er) { toast(er.message, 'err'); }
    } else if (del && confirm(`Hapus snapshot "${del}"?`)) {
      try { await api(`/guests/${vmid}/snapshots/${del}`, { method: 'DELETE' }); toast('Snapshot dihapus', 'ok'); load(); }
      catch (er) { toast(er.message, 'err'); }
    }
  };
  load();
}

// ---------- 3. Backup ----------
async function openBackup(vmid, name) {
  let storages = []; let backups = [];
  try { [storages, backups] = await Promise.all([api(`/backup-storages`), api(`/guests/${vmid}/backups`)]); } catch (e) { return toast(e.message, 'err'); }
  modal(`<div class="p-5"><h2 class="font-semibold text-lg mb-4">Backup #${vmid} <span class="text-xs text-slate-500">${name || ''}</span></h2>
    <div class="flex gap-2 mb-2">
      <select id="b_storage" class="${inputCls} flex-1">${storages.map((s) => `<option value="${s.storage}">${s.storage} (${fmtBytes(s.avail)} free)</option>`).join('') || '<option value="">(tak ada storage backup)</option>'}</select>
      <select id="b_mode" class="${inputCls} w-32"><option value="snapshot">snapshot</option><option value="suspend">suspend</option><option value="stop">stop</option></select>
      <button id="b_run" class="px-4 bg-violet-600 hover:bg-violet-500 rounded-md text-sm">Backup</button>
    </div>
    <p class="text-xs text-slate-500 mb-4">Backup berjalan di background (bisa beberapa menit).</p>
    <h3 class="text-sm font-medium mb-2">Backup tersedia</h3>
    <div class="space-y-2 max-h-56 overflow-y-auto text-sm">${backups.length ? backups.map((b) => `
      <div class="bg-slate-800 rounded-md px-3 py-2"><div class="font-mono text-xs truncate">${(b.volid || '').split('/').pop()}</div>
      <div class="text-xs text-slate-500">${b.ctime ? new Date(b.ctime * 1000).toLocaleString('id-ID') : ''} · ${fmtBytes(b.size)} · ${b.storage}</div></div>`).join('') : '<p class="text-slate-500">Belum ada backup.</p>'}</div>
    <button onclick="closeModal()" class="w-full mt-4 text-sm text-slate-400 hover:text-white">Tutup</button></div>`);
  $('#b_run').onclick = async () => {
    const storage = $('#b_storage').value;
    if (!storage) return toast('Pilih storage', 'warn');
    const btn = $('#b_run'); btn.disabled = true; btn.textContent = '…';
    try { await api(`/guests/${vmid}/backup`, { method: 'POST', body: JSON.stringify({ storage, mode: $('#b_mode').value }) }); toast('Backup dimulai (background)', 'ok'); closeModal(); }
    catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Backup'; }
  };
}

// ---------- 4. Migrasi antar node ----------
async function openMigrate(vmid, name, curNode) {
  let nodes = [];
  try { nodes = (await api('/meta')).nodes || []; } catch { /* */ }
  const targets = nodes.filter((n) => n !== curNode);
  modal(`<div class="p-5"><h2 class="font-semibold text-lg mb-4">Migrasi #${vmid} <span class="text-xs text-slate-500">${name || ''}</span></h2>
    <p class="text-xs text-slate-400 mb-3">Dari node <b>${curNode || '?'}</b> ke:</p>
    <select id="m_target" class="${inputCls} mb-3">${targets.map((n) => `<option value="${n}">${n}</option>`).join('') || '<option value="">(tak ada node lain)</option>'}</select>
    <label class="flex items-center gap-2 mb-2 text-sm"><input id="m_online" type="checkbox" checked class="accent-orange-500"> Online/live (VM) atau restart (CT)</label>
    <label class="flex items-center gap-2 mb-4 text-sm"><input id="m_localdisk" type="checkbox" class="accent-orange-500"> Sertakan local disk (VM)</label>
    <button id="m_run" ${targets.length ? '' : 'disabled'} class="w-full bg-orange-600 hover:bg-orange-500 rounded-md py-2.5 text-sm font-medium disabled:opacity-40">Migrasi</button>
    <button onclick="closeModal()" class="w-full mt-2 text-sm text-slate-400 hover:text-white">Batal</button></div>`);
  $('#m_run').onclick = async () => {
    const target = $('#m_target').value;
    if (!target) return toast('Pilih node target', 'warn');
    const btn = $('#m_run'); btn.disabled = true; btn.textContent = 'Migrasi…';
    try { await api(`/guests/${vmid}/migrate`, { method: 'POST', body: JSON.stringify({ target, online: $('#m_online').checked, withLocalDisks: $('#m_localdisk').checked, restart: $('#m_online').checked }) }); toast(`Migrasi #${vmid} → ${target} dimulai`, 'ok'); closeModal(); }
    catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Migrasi'; }
  };
}

// ---------- 5. VNC Console (noVNC via CDN, lewat proxy /vncws) ----------
async function openConsole(vmid, name) {
  modal(`<div class="p-3">
    <div class="flex items-center justify-between mb-2 px-2">
      <h2 class="font-semibold">Console #${vmid} <span class="text-xs text-slate-500">${name || ''}</span></h2>
      <div class="flex gap-2 items-center">
        <span id="vnc_state" class="text-xs text-slate-400">menghubungkan…</span>
        <button onclick="closeModal()" class="px-2 py-1 rounded bg-slate-800 hover:bg-slate-700 text-xs">Tutup</button>
      </div>
    </div>
    <div id="vnc_screen" class="bg-black rounded-md overflow-hidden" style="height:60vh"></div>
    <p class="text-xs text-slate-500 mt-2 px-2">Console interaktif via noVNC. Klik layar untuk fokus keyboard.</p>
  </div>`, 'max-w-4xl');
  const setState = (t) => { const el = $('#vnc_state'); if (el) el.textContent = t; };
  try {
    const { default: RFB } = await import('https://cdn.jsdelivr.net/npm/@novnc/novnc@1.5.0/lib/rfb.js');
    setState('meminta tiket…');
    const t = await api(`/guests/${vmid}/vncticket`); // { ticket, port }
    const token = localStorage.getItem('pve_dash_token') || '';
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const qs = `vmid=${vmid}&port=${encodeURIComponent(t.port)}&vncticket=${encodeURIComponent(t.ticket)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
    const url = `${proto}://${location.host}/vncws?${qs}`;
    setState('menghubungkan…');
    const rfb = new RFB(document.getElementById('vnc_screen'), url, {
      wsProtocols: ['binary'],
      credentials: { password: t.ticket },
    });
    rfb.scaleViewport = true; rfb.resizeSession = false;
    rfb.addEventListener('connect', () => setState('terhubung'));
    rfb.addEventListener('disconnect', (e) => setState(e.detail?.clean ? 'terputus' : 'gagal konek'));
    rfb.addEventListener('securityfailure', () => setState('auth gagal'));
    window._rfb = rfb;
  } catch (e) {
    setState('error: ' + e.message);
    toast('Console gagal dimuat: ' + e.message, 'err');
  }
}

// Expose ke global untuk dipanggil app.js
window.Features = { openHistory, openSnapshots, openBackup, openMigrate, openConsole };
