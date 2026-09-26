// features.js — Fitur lanjutan: histori grafik (4 metrik), snapshot, backup, migrasi, VNC console.
// Memakai helper global dari app.js: $, api, toast, trackTask, modal, closeModal, fmtBytes, inputCls, field, esc.
'use strict';

// ---------- 1. Histori grafik (Chart.js + RRD) — CPU, RAM, Network, Disk I/O ----------
async function openHistory(vmid, name) {
  modal(`
    <div class="p-5">
      <div class="flex items-center justify-between mb-4">
        <div>
          <h2 class="font-semibold text-lg">Histori Performa</h2>
          <p class="text-xs text-slate-500">#${vmid} · ${esc(name) || ''}</p>
        </div>
        <select id="h_tf" class="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-orange-500">
          <option value="hour">1 Jam</option><option value="day">1 Hari</option>
          <option value="week">1 Minggu</option><option value="month">1 Bulan</option>
        </select>
      </div>
      <div id="h_wrap" class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div class="bg-slate-950/40 rounded-lg p-3"><div class="text-xs text-slate-400 mb-1">CPU</div><div class="h-44"><canvas id="h_cpu"></canvas></div></div>
        <div class="bg-slate-950/40 rounded-lg p-3"><div class="text-xs text-slate-400 mb-1">RAM</div><div class="h-44"><canvas id="h_mem"></canvas></div></div>
        <div class="bg-slate-950/40 rounded-lg p-3"><div class="text-xs text-slate-400 mb-1">Network (Rx/Tx)</div><div class="h-44"><canvas id="h_net"></canvas></div></div>
        <div class="bg-slate-950/40 rounded-lg p-3"><div class="text-xs text-slate-400 mb-1">Disk I/O (Read/Write)</div><div class="h-44"><canvas id="h_disk"></canvas></div></div>
      </div>
      <button onclick="closeModal()" class="w-full mt-4 text-sm text-slate-400 hover:text-white">Tutup</button>
    </div>`, 'max-w-4xl');
  const draw = async () => {
    const tf = $('#h_tf').value;
    let data;
    try { data = await api(`/guests/${vmid}/rrd?timeframe=${tf}`); }
    catch (e) { return toast(e.message, 'err'); }
    const labels = data.map((d) => new Date(d.time * 1000).toLocaleTimeString('id-ID', tf === 'hour' || tf === 'day' ? { hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: 'short' }));
    renderChart('h_cpu', labels, [
      { label: 'CPU %', data: data.map((d) => ((d.cpu || 0) * 100).toFixed(1)), color: '#f97316' },
    ]);
    renderChart('h_mem', labels, [
      { label: 'RAM (MB)', data: data.map((d) => ((d.mem || 0) / 1048576).toFixed(0)), color: '#38bdf8' },
    ]);
    renderChart('h_net', labels, [
      { label: 'Rx (KB/s)', data: data.map((d) => ((d.netin || 0) / 1024).toFixed(1)), color: '#34d399' },
      { label: 'Tx (KB/s)', data: data.map((d) => ((d.netout || 0) / 1024).toFixed(1)), color: '#fbbf24' },
    ]);
    renderChart('h_disk', labels, [
      { label: 'Read (KB/s)', data: data.map((d) => ((d.diskread || 0) / 1024).toFixed(1)), color: '#a78bfa' },
      { label: 'Write (KB/s)', data: data.map((d) => ((d.diskwrite || 0) / 1024).toFixed(1)), color: '#f472b6' },
    ]);
  };
  $('#h_tf').onchange = draw;
  draw();
}

function renderChart(canvasId, labels, series) {
  const ctx = document.getElementById(canvasId);
  if (!ctx || !window.Chart) return;
  if (ctx._chart) ctx._chart.destroy();
  ctx._chart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: series.map((s) => ({
        label: s.label, data: s.data, borderColor: s.color, backgroundColor: s.color + '22',
        fill: series.length === 1, tension: 0.3, pointRadius: 0, borderWidth: 2,
      })),
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: { legend: { display: series.length > 1, labels: { color: '#94a3b8', boxWidth: 12, font: { size: 10 } } } },
      scales: {
        x: { ticks: { color: '#64748b', maxTicksLimit: 6, font: { size: 9 } }, grid: { color: '#1e293b' } },
        y: { ticks: { color: '#64748b', font: { size: 9 } }, grid: { color: '#1e293b' }, beginAtZero: true },
      },
    },
  });
}

// ---------- 2. Snapshot ----------
async function openSnapshots(vmid, name) {
  modal(`<div class="p-5"><h2 class="font-semibold text-lg mb-1">Snapshot</h2><p class="text-xs text-slate-500 mb-4">#${vmid} · ${esc(name) || ''}</p>
    <div class="flex gap-2 mb-2">
      <input id="s_name" placeholder="nama-snapshot" class="${inputCls} flex-1">
      <button id="s_create" class="px-4 bg-emerald-600 hover:bg-emerald-500 rounded-lg text-sm font-medium">Buat</button>
    </div>
    <input id="s_desc" placeholder="deskripsi (opsional)" class="${inputCls} mb-4">
    <div id="s_list" class="space-y-2 max-h-72 overflow-y-auto text-sm"><p class="text-slate-500">memuat…</p></div>
    <button onclick="closeModal()" class="w-full mt-4 text-sm text-slate-400 hover:text-white">Tutup</button></div>`);
  const load = async () => {
    try {
      const snaps = (await api(`/guests/${vmid}/snapshots`)).filter((s) => s.name !== 'current');
      $('#s_list').innerHTML = snaps.length ? snaps.map((s) => `
        <div class="flex items-center justify-between bg-slate-800 rounded-lg px-3 py-2">
          <div><div class="font-medium">${esc(s.name)}</div>
          <div class="text-xs text-slate-500">${s.snaptime ? new Date(s.snaptime * 1000).toLocaleString('id-ID') : ''} ${s.description ? '· ' + esc(s.description) : ''}</div></div>
          <div class="flex gap-1">
            <button data-snaproll="${esc(s.name)}" class="px-2 py-1 rounded bg-amber-700/60 hover:bg-amber-700 text-xs">Rollback</button>
            <button data-snapdel="${esc(s.name)}" class="px-2 py-1 rounded bg-red-800/60 hover:bg-red-800 text-xs">Hapus</button>
          </div></div>`).join('') : '<p class="text-slate-500">Belum ada snapshot.</p>';
    } catch (e) { $('#s_list').innerHTML = `<p class="text-red-400">${esc(e.message)}</p>`; }
  };
  $('#s_create').onclick = async () => {
    const snapname = $('#s_name').value.trim();
    if (!snapname) return toast('Isi nama snapshot', 'warn');
    const btn = $('#s_create'); btn.disabled = true;
    try {
      const r = await api(`/guests/${vmid}/snapshots`, { method: 'POST', body: JSON.stringify({ snapname, description: $('#s_desc').value }) });
      $('#s_name').value = '';
      trackTask(r.upid, `Snapshot "${snapname}" #${vmid}`, load);
    } catch (e) { toast(e.message, 'err'); }
    btn.disabled = false;
  };
  $('#s_list').onclick = async (e) => {
    const roll = e.target.dataset.snaproll; const del = e.target.dataset.snapdel;
    if (roll && confirm(`Rollback ke snapshot "${roll}"? State saat ini akan hilang.`)) {
      try { const r = await api(`/guests/${vmid}/snapshots/${roll}/rollback`, { method: 'POST' }); trackTask(r.upid, `Rollback "${roll}" #${vmid}`, load); }
      catch (er) { toast(er.message, 'err'); }
    } else if (del && confirm(`Hapus snapshot "${del}"?`)) {
      try { const r = await api(`/guests/${vmid}/snapshots/${del}`, { method: 'DELETE' }); trackTask(r.upid, `Hapus snapshot "${del}"`, load); }
      catch (er) { toast(er.message, 'err'); }
    }
  };
  load();
}

// ---------- 3. Backup ----------
async function openBackup(vmid, name) {
  let storages = []; let backups = [];
  try { [storages, backups] = await Promise.all([api(`/backup-storages`), api(`/guests/${vmid}/backups`)]); } catch (e) { return toast(e.message, 'err'); }
  modal(`<div class="p-5"><h2 class="font-semibold text-lg mb-1">Backup</h2><p class="text-xs text-slate-500 mb-4">#${vmid} · ${esc(name) || ''}</p>
    <div class="flex gap-2 mb-2">
      <select id="b_storage" class="${inputCls} flex-1">${storages.map((s) => `<option value="${esc(s.storage)}">${esc(s.storage)} (${fmtBytes(s.avail)} free)</option>`).join('') || '<option value="">(tak ada storage backup)</option>'}</select>
      <select id="b_mode" class="${inputCls} w-32"><option value="snapshot">snapshot</option><option value="suspend">suspend</option><option value="stop">stop</option></select>
      <button id="b_run" class="px-4 bg-violet-600 hover:bg-violet-500 rounded-lg text-sm font-medium">Backup</button>
    </div>
    <p class="text-xs text-slate-500 mb-4">Backup berjalan di background — progresnya dilacak otomatis.</p>
    <h3 class="text-sm font-medium mb-2">Backup tersedia</h3>
    <div class="space-y-2 max-h-56 overflow-y-auto text-sm">${backups.length ? backups.map((b) => `
      <div class="bg-slate-800 rounded-lg px-3 py-2"><div class="font-mono text-xs truncate">${esc((b.volid || '').split('/').pop())}</div>
      <div class="text-xs text-slate-500">${b.ctime ? new Date(b.ctime * 1000).toLocaleString('id-ID') : ''} · ${fmtBytes(b.size)} · ${esc(b.storage)}</div></div>`).join('') : '<p class="text-slate-500">Belum ada backup.</p>'}</div>
    <button onclick="closeModal()" class="w-full mt-4 text-sm text-slate-400 hover:text-white">Tutup</button></div>`);
  $('#b_run').onclick = async () => {
    const storage = $('#b_storage').value;
    if (!storage) return toast('Pilih storage', 'warn');
    const btn = $('#b_run'); btn.disabled = true; btn.textContent = '…';
    try {
      const r = await api(`/guests/${vmid}/backup`, { method: 'POST', body: JSON.stringify({ storage, mode: $('#b_mode').value }) });
      trackTask(r.upid, `Backup #${vmid} → ${storage}`);
      closeModal();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Backup'; }
  };
}

// ---------- 4. Migrasi antar node ----------
async function openMigrate(vmid, name, curNode) {
  let nodes = [];
  try { nodes = (await api('/meta')).nodes || []; } catch { /* */ }
  const targets = nodes.filter((n) => n !== curNode);
  modal(`<div class="p-5"><h2 class="font-semibold text-lg mb-1">Migrasi</h2><p class="text-xs text-slate-500 mb-4">#${vmid} · ${esc(name) || ''}</p>
    <p class="text-xs text-slate-400 mb-3">Dari node <b>${esc(curNode) || '?'}</b> ke:</p>
    <select id="m_target" class="${inputCls} mb-3">${targets.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('') || '<option value="">(tak ada node lain)</option>'}</select>
    <label class="flex items-center gap-2 mb-2 text-sm"><input id="m_online" type="checkbox" checked class="accent-orange-500"> Online/live (VM) atau restart (CT)</label>
    <label class="flex items-center gap-2 mb-4 text-sm"><input id="m_localdisk" type="checkbox" class="accent-orange-500"> Sertakan local disk (VM)</label>
    <button id="m_run" ${targets.length ? '' : 'disabled'} class="w-full bg-orange-600 hover:bg-orange-500 rounded-lg py-2.5 text-sm font-medium disabled:opacity-40">Migrasi</button>
    <button onclick="closeModal()" class="w-full mt-2 text-sm text-slate-400 hover:text-white">Batal</button></div>`);
  $('#m_run').onclick = async () => {
    const target = $('#m_target').value;
    if (!target) return toast('Pilih node target', 'warn');
    const btn = $('#m_run'); btn.disabled = true; btn.textContent = 'Migrasi…';
    try {
      const r = await api(`/guests/${vmid}/migrate`, { method: 'POST', body: JSON.stringify({ target, online: $('#m_online').checked, withLocalDisks: $('#m_localdisk').checked, restart: $('#m_online').checked }) });
      trackTask(r.upid, `Migrasi #${vmid} → ${target}`);
      closeModal();
    } catch (e) { toast(e.message, 'err'); btn.disabled = false; btn.textContent = 'Migrasi'; }
  };
}

// ---------- 5. VNC Console (noVNC via CDN) — VM & CT, responsif, bisa paste ----------
async function openConsole(vmid, name) {
  modal(`<div id="vnc_root" class="flex flex-col" style="height:82vh">
    <div class="flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-800 shrink-0 flex-wrap">
      <div class="flex items-center gap-2 min-w-0">
        <span id="vnc_dot" class="inline-block w-2.5 h-2.5 rounded-full bg-amber-400 shrink-0" title="menghubungkan…"></span>
        <h2 class="font-semibold truncate text-sm">#${vmid} <span class="text-xs text-slate-500 font-normal">${esc(name) || ''}</span></h2>
        <span id="vnc_state" class="text-[11px] text-slate-400 shrink-0">menghubungkan…</span>
      </div>
      <div class="flex gap-1.5 items-center flex-wrap justify-end">
        <button id="vnc_kbd" title="Tampilkan keyboard" class="px-2.5 py-1 rounded-lg bg-emerald-700 hover:bg-emerald-600 text-xs">⌨</button>
        <button id="vnc_paste" title="Paste teks ke terminal" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs">📋 Paste</button>
        <button id="vnc_copy" title="Salin teks terseleksi dari terminal" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs">📄 Copy</button>
        <button id="vnc_cad" title="Kirim Ctrl+Alt+Del" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs">C-A-D</button>
        <button id="vnc_fit" title="Fit / actual size" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs">⤢</button>
        <button onclick="closeModal()" class="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs">✕</button>
      </div>
    </div>
    <div id="vnc_screen" class="bg-black flex-1 overflow-hidden relative"></div>
    <input id="vnc_kbd_in" type="text" inputmode="text" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
      class="absolute" style="left:0;top:0;height:1px;width:1px;opacity:0;border:0;padding:0;background:transparent;color:transparent" />
    <div class="px-4 py-1.5 text-[11px] text-slate-500 border-t border-slate-800 shrink-0">Tap <b>⌨</b> untuk mengetik · seleksi teks lalu <b>📄 Copy</b> · <b>📋 Paste</b> kirim clipboard. Sesi tersambung ulang otomatis.</div>
  </div>`, 'max-w-5xl');
  const DOT = { info: 'bg-amber-400', warn: 'bg-amber-400', ok: 'bg-emerald-400', err: 'bg-red-500' };
  const setState = (t, kind = 'info') => {
    const el = $('#vnc_state'); if (el) el.textContent = t;
    const d = $('#vnc_dot'); if (d) { d.className = `inline-block w-2.5 h-2.5 rounded-full shrink-0 ${DOT[kind] || DOT.info}`; d.title = t; }
  };
  try {
    const _m = await import('https://cdn.jsdelivr.net/npm/@novnc/novnc@1.5.0/lib/rfb.js/+esm');
    // Bundle CJS-transpile: kelas bisa di default, default.default, atau m.RFB
    const RFB = [_m.default && _m.default.default, _m.default, _m.RFB, _m]
      .find((c) => typeof c === 'function');
    if (typeof RFB !== 'function') throw new Error('RFB class tidak ditemukan di modul noVNC');
    setState('meminta tiket…');
    const token = localStorage.getItem('pve_dash_token') || '';
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    let rfb = null;
    let lastClip = '';          // teks clipboard terakhir dari server (untuk tombol Copy)
    let manualClose = false;    // true bila user menutup modal (jangan reconnect)
    let reconnecting = false;
    let retry = 0;

    const buildRFB = async () => {
      // Ambil tiket BARU setiap konek (tiket VNC Proxmox sekali-pakai & cepat kedaluwarsa)
      const t = await api(`/guests/${vmid}/vncticket`);
      const scr = document.getElementById('vnc_screen');
      if (scr) scr.innerHTML = ''; // buang canvas lama sebelum konek ulang
      const qs = `vmid=${vmid}&port=${encodeURIComponent(t.port)}&vncticket=${encodeURIComponent(t.ticket)}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
      const url = `${proto}://${location.host}/vncws?${qs}`;
      const r = new RFB(document.getElementById('vnc_screen'), url, {
        wsProtocols: ['binary'],
        credentials: { password: t.ticket },
      });
      r.scaleViewport = true; r.resizeSession = false; r.clipViewport = false;
      r.addEventListener('connect', () => { if (r !== rfb) return; reconnecting = false; retry = 0; setState('terhubung', 'ok'); r.focus(); });
      r.addEventListener('clipboard', (e) => { if (e.detail && typeof e.detail.text === 'string') lastClip = e.detail.text; });
      r.addEventListener('securityfailure', () => { if (r === rfb) setState('auth gagal', 'err'); });
      r.addEventListener('disconnect', (e) => {
        // Hanya RFB AKTIF yang boleh memicu reconnect — cegah loop dari objek lama yang di-teardown
        if (r !== rfb || manualClose) return;
        setState('menyambung ulang…', 'warn');
        scheduleReconnect();
      });
      return r;
    };

    const scheduleReconnect = () => {
      if (manualClose || reconnecting) return;
      reconnecting = true;
      retry++;
      const delay = Math.min(800 * retry, 5000); // backoff bertahap, maks 5s
      setTimeout(async () => {
        if (manualClose) return;
        try {
          const old = rfb; rfb = null;
          try { old && old.disconnect(); } catch { /* */ }
          rfb = await buildRFB(); window._rfb = rfb;
        }
        catch (err) { reconnecting = false; setState('gagal — coba lagi…', 'err'); if (!manualClose) setTimeout(scheduleReconnect, 3000); }
      }, delay);
    };

    setState('menghubungkan…');
    rfb = await buildRFB();
    window._rfb = rfb;

    // ===== Responsif terhadap soft-keyboard (visualViewport) =====
    const root = document.getElementById('vnc_root');
    const bg = document.getElementById('modalBg');
    // Align modal ke atas & buang padding supaya bisa memenuhi ruang saat keyboard muncul
    if (bg) { bg.classList.remove('items-center'); bg.classList.add('items-start'); bg.classList.remove('p-4'); bg.classList.add('p-0','sm:p-4'); }
    const card = root && root.parentElement; // container max-w-5xl
    if (card) { card.classList.remove('max-h-[90vh]'); }
    const vv = window.visualViewport;
    document.body.style.overflow = 'hidden';
    const fitToViewport = () => {
      const h = vv ? vv.height : window.innerHeight;
      const top = vv ? vv.offsetTop : 0;
      // Pin overlay ke visual viewport (mengikuti keyboard), bukan layout viewport
      if (bg) { bg.style.position = 'fixed'; bg.style.top = top + 'px'; bg.style.left = '0'; bg.style.right = '0'; bg.style.height = h + 'px'; bg.style.bottom = 'auto'; }
      root.style.height = Math.max(220, Math.round(h - 4)) + 'px';
      // Paksa noVNC hitung ulang skala terhadap container baru
      if (rfb) { try { rfb.scaleViewport = rfb.scaleViewport; } catch { /* */ } }
    };
    fitToViewport();
    if (vv) { vv.addEventListener('resize', fitToViewport); vv.addEventListener('scroll', fitToViewport); }
    else window.addEventListener('resize', fitToViewport);

    // ===== Auto-reconnect saat kembali ke tab/app (browser sering putus WS di background) =====
    const isDead = () => !rfb || rfb._rfbConnectionState === 'disconnected' || rfb._rfbConnectionState === 'disconnecting';
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !manualClose && !reconnecting && isDead()) {
        setState('menyambung ulang…', 'warn'); scheduleReconnect();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    // Bersihkan listener saat modal ditutup
    const modalRoot = document.getElementById('modalRoot');
    const mo = new MutationObserver(() => {
      if (!document.getElementById('vnc_root')) {
        manualClose = true;
        document.body.style.overflow = '';
        document.removeEventListener('visibilitychange', onVisible);
        if (vv) { vv.removeEventListener('resize', fitToViewport); vv.removeEventListener('scroll', fitToViewport); }
        else window.removeEventListener('resize', fitToViewport);
        try { rfb.disconnect(); } catch { /* */ }
        mo.disconnect();
      }
    });
    if (modalRoot) mo.observe(modalRoot, { childList: true, subtree: true });

    // Paste: ketikkan teks clipboard ke terminal (char-by-char via keyboard events)
    $('#vnc_paste').onclick = async () => {
      let text = '';
      try { text = await navigator.clipboard.readText(); } catch { text = prompt('Tempel teks untuk dikirim ke terminal:') || ''; }
      if (!text) return;
      // Metode andal lintas-OS: gunakan clipboard RFB bila didukung, plus ketik manual
      if (rfb.clipboardPasteFrom) { try { rfb.clipboardPasteFrom(text); } catch { /* */ } }
      for (const ch of text) {
        const code = ch.codePointAt(0);
        rfb.sendKey(code, null, true);
        rfb.sendKey(code, null, false);
      }
      toast('Teks dikirim ke terminal', 'ok');
    };
    // Copy: teks terseleksi di terminal dikirim server VNC via event 'clipboard'
    $('#vnc_copy').onclick = async () => {
      if (!lastClip) { toast('Belum ada teks. Seleksi teks di layar terminal dulu (klik-seret), baru tap Copy.', 'warn'); return; }
      try {
        if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(lastClip); toast('Tersalin ke clipboard', 'ok'); }
        else { window.prompt('Tahan untuk menyalin teks ini:', lastClip); }
      } catch { window.prompt('Tahan untuk menyalin teks ini:', lastClip); }
    };
    $('#vnc_cad').onclick = () => { rfb.sendCtrlAltDel(); toast('Ctrl+Alt+Del dikirim', 'info'); };
    let fit = true;
    $('#vnc_fit').onclick = () => { fit = !fit; rfb.scaleViewport = fit; rfb.clipViewport = !fit; $('#vnc_fit').textContent = fit ? '⤢ Fit' : '⤡ 1:1'; };

    // ===== Jembatan keyboard mobile: input tersembunyi memicu soft-keyboard =====
    const kin = document.getElementById('vnc_kbd_in');
    const sendKey = (code, keysym) => { rfb.sendKey(keysym || code, null, true); rfb.sendKey(keysym || code, null, false); };
    // Ketik karakter biasa via event 'input' (andal utk soft-keyboard yg tak kirim keydown per-char)
    kin.addEventListener('input', () => {
      const v = kin.value;
      for (const ch of v) sendKey(ch.codePointAt(0));
      kin.value = '';
    });
    // Tombol khusus (Enter, Backspace, Tab, panah, Esc) via keydown
    const SPECIAL = { Enter: 0xff0d, Backspace: 0xff08, Tab: 0xff09, Escape: 0xff1b,
      ArrowUp: 0xff52, ArrowDown: 0xff54, ArrowLeft: 0xff51, ArrowRight: 0xff53,
      Home: 0xff50, End: 0xff57, Delete: 0xffff };
    kin.addEventListener('keydown', (e) => {
      const ks = SPECIAL[e.key];
      if (ks) { e.preventDefault(); sendKey(0, ks); }
    });
    const showKbd = () => { kin.focus({ preventScroll: true }); };
    $('#vnc_kbd').onclick = showKbd;
    // Tap pada layar juga memunculkan keyboard (selain mengirim klik mouse ke VNC)
    $('#vnc_screen').addEventListener('touchend', showKbd, { passive: true });
  } catch (e) {
    setState('error: ' + e.message);
    toast('Console gagal dimuat: ' + e.message, 'err');
  }
}

// Expose ke global untuk dipanggil app.js
window.Features = { openHistory, openSnapshots, openBackup, openMigrate, openConsole };
