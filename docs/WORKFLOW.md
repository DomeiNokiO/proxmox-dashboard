# Workflow Pengembangan & Operasional — Proxmox Dashboard

Panduan alur kerja end-to-end: setup dev, uji, deploy ke CT/VM, keamanan login,
dan troubleshooting. Semua perintah sudah diuji.

---

## 1. Arsitektur singkat

- **Backend**: Node.js + Express + WebSocket (`ws`). Semua panggilan ke Proxmox API
  memakai `https.request` (bukan `fetch`, karena `fetch` bawaan Node **mengabaikan**
  `https.Agent`/opsi TLS).
- **Frontend**: Vanilla JS + Tailwind (CDN) + Chart.js + noVNC + xterm.js. **Zero-build**
  (tanpa bundler). File statis di `public/`.
- **Konfigurasi**: `.env` (di-`.gitignore`). Contoh lengkap di `.env.example`.

### Struktur
```
src/         server.js (HTTP+WS+auth), routes.js (API PVE), proxmox.js (klien PVE),
             auth.js (scrypt+sesi), config.js (.env loader)
public/      index.html, app.js, features.js (console/terminal/VNC), style.css
scripts/     install.sh, update.sh, set-password.mjs, create-ct.sh
docs/        WORKFLOW.md, UI-THEMING.md
```

---

## 2. Setup development lokal

```bash
git clone https://github.com/DomeiNokiO/proxmox-dashboard.git
cd proxmox-dashboard
npm install          # dependensi minimal (express, ws)
cp .env.example .env # lalu isi PVE_HOST/PVE_NODE/token
npm run dev          # node --watch, auto-reload saat file berubah
```
Buka `http://127.0.0.1:3000`.

---

## 3. Alur mengubah UI (aman & minim error)

1. Edit `public/*.js` / `public/*.html` / `public/style.css`.
2. **Naikkan cache-bust** `?v=N` di `index.html` (lihat `docs/UI-THEMING.md` §5).
3. Verifikasi syntax:
   ```bash
   node --check public/app.js && node --check public/features.js
   ```
4. Uji nyata (server sementara di port lain + browser):
   ```bash
   PORT=3995 node src/server.js   # di terminal lain / background
   ```
   Cek: menu ⋮ buka-tutup, toggle tema (atribut `data-theme` + `localStorage`),
   warna tombol berubah, dan fallback Orange kembali.
5. Commit + push.

> **Prinsip tema**: jangan mengganti nama class warna di JS. Remap lewat CSS
> `html[data-theme="..."]`. Detail di `docs/UI-THEMING.md`.

---

## 4. Keamanan login

### Mengaktifkan / mengganti password (CARA UTAMA — anti-drama)
```bash
cd /opt/proxmox-dashboard
npm run set-password        # ketik username & password di prompt (tersembunyi)
systemctl restart proxmox-dashboard
```
CLI meng-hash password (scrypt) dan menulis `DASHBOARD_USER` + `DASHBOARD_PASSWORD_HASH`
ke `.env` sendiri — **tidak ada hash panjang untuk disalin**.

### Ganti password dari dashboard
Menu ⋮ → 🔑 **Ganti Password** (butuh login aktif). Verifikasi password lama,
simpan hash baru, berlaku langsung tanpa restart.

### Menonaktifkan login (LAN terisolasi)
Kosongkan `DASHBOARD_USER` & `DASHBOARD_PASSWORD*` di `.env`, restart. Dashboard terbuka.

### Model keamanan (ringkas)
- Password: **scrypt** (N=16384, salt acak), verifikasi `timingSafeEqual`. Tak pernah plaintext.
- Sesi: cookie `HttpOnly; SameSite=Strict` + tanda tangan **HMAC-SHA256** + expiry 12 jam.
  Flag `Secure` dipasang hanya di HTTPS (atau di belakang proxy tepercaya).
- **Rate-limit** login & ganti-password per-IP (lock 8× / 15 menit).
- `TRUST_PROXY` (default `false`): set `true` **hanya** di belakang reverse-proxy/Cloudflare
  Tunnel tepercaya. Jika akses langsung (IP lokal / tunnel VPN), biarkan `false` agar
  header `X-Forwarded-For` tidak bisa dipalsukan untuk menembus rate-limit.

> Catatan akses via **IP lokal + VPN (HTTP)**: enkripsi disediakan oleh tunnel VPN
> (WireGuard/OpenVPN). Cookie tetap tersimpan karena flag `Secure` tidak dipaksakan di HTTP.

---

## 5. Deploy ke CT/VM

### Instalasi baru (sekali paste)
Jalankan `scripts/install.sh` di CT/VM target (Ubuntu 22.04/24.04). Installer
interaktif: minta koneksi Proxmox, opsi buat user+password login, lalu pasang service
`systemd` `proxmox-dashboard` dan tampilkan ringkasan.

### Update ke versi terbaru (sekali paste)
```bash
bash <(curl -fsSL https://raw.githubusercontent.com/DomeiNokiO/proxmox-dashboard/main/scripts/update.sh)
```
Lalu **hard-refresh** di HP (cache-bust menjaga JS/CSS baru termuat).

### Service
```bash
systemctl status proxmox-dashboard
journalctl -u proxmox-dashboard -n 50 --no-pager
systemctl restart proxmox-dashboard
```

---

## 6. Hak akses token Proxmox (role `Automational`)

Untuk fitur create/kontrol + terminal node, role token butuh minimal:
```bash
pveum role modify Automational -privs "VM.Allocate VM.Config.Disk VM.Config.CPU \
VM.Config.Memory VM.Config.Network VM.Config.Options VM.Config.Cloudinit VM.PowerMgmt \
VM.Snapshot VM.Clone VM.Migrate VM.Audit VM.Console Datastore.AllocateSpace \
Datastore.Audit Sys.Audit Sys.Console SDN.Use"
```
- `Sys.Console` → wajib untuk **Terminal Node** (`/nodes/<node>/termproxy`).
- `SDN.Use` → wajib bila membuat guest pada bridge SDN.

---

## 7. Checklist rilis

- [ ] `node --check` semua file `src/*.js` & `public/*.js` OK.
- [ ] Cache-bust `?v=N` dinaikkan bila `public/` berubah.
- [ ] Uji login (200 benar / 401 salah) + rate-limit (429).
- [ ] Uji tema (hijau ⇄ orange) & menu mobile.
- [ ] `git commit` deskriptif + `git push origin main`.
- [ ] Update di CT lewat `update.sh`, hard-refresh HP, cek `journalctl`.

---

## 8. Troubleshooting cepat

| Gejala | Sebab umum | Solusi |
|---|---|---|
| Tombol/warna baru tak muncul di HP | cache browser | naikkan `?v=N`, hard-refresh |
| Login selalu 401 | hash salah tempel / plaintext | `npm run set-password` (jangan tempel hash manual) |
| Terminal Node 403 `Sys.Console` | role token kurang priv | `pveum role modify` (§6) |
| Cookie sesi tak tersimpan | `Secure` dipaksa di HTTP | pastikan `TRUST_PROXY=false` saat HTTP langsung |
| Rate-limit tertembus via header | `TRUST_PROXY=true` tanpa proxy | set `TRUST_PROXY=false` |
