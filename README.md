# Proxmox Dashboard

Dashboard **realtime** untuk mengelola VM (QEMU) & Container (LXC) di Proxmox VE — buat, lihat, kontrol, dan resize resource dari satu tampilan web yang responsif.

Backend **Node.js + Express + WebSocket**, frontend **Vanilla JS + Tailwind (zero-build)**. Ringan, cocok dijalankan di dalam LXC kecil (1 core / 512 MB).

---

## Fitur

- **Realtime** — status semua guest & metrik node di-push via WebSocket tiap beberapa detik (tanpa refresh).
- **Buat VM & CT customable** — pilih vCPU, RAM, disk, storage, bridge, ISO/template, IP, SSH key, dsb dari form.
- **Kontrol penuh** — start, shutdown, reboot, reset, stop, hapus (dengan konfirmasi ganda).
- **Ubah resource on-the-fly** — tambah/kurangi vCPU & RAM, perbesar disk (`+GB`).
- **Monitor node** — CPU, RAM, root FS, uptime, load average.
- **Multi-node** — deteksi semua node cluster otomatis, filter guest per node, aksi memakai node asli tiap guest.
- **Grafik histori** — CPU, RAM, jaringan & disk I/O dari data RRD Proxmox (rentang jam/hari/minggu/bulan/tahun), digambar dengan Chart.js.
- **Snapshot** — lihat, buat (opsi sertakan RAM/vmstate), rollback, dan hapus snapshot.
- **Backup** — jalankan vzdump ke storage pilihan (mode snapshot/suspend/stop, kompresi zstd/gzip/lzo).
- **Migrasi** — pindahkan guest antar node (online/offline) langsung dari UI.
- **Console VNC** — akses layar VM interaktif via noVNC, di-proxy aman lewat server (ticket tak bocor ke Proxmox langsung).
- **Terminal shell** — xterm.js (guest & node Proxmox), responsif untuk HP, mode pilih-teks 1 jari & copy berlapis.
- **Tema Orange/Hijau** — toggle 🎨 di menu ⋮ (Orange default, Hijau opsional; tersimpan di browser). Lihat [`docs/UI-THEMING.md`](docs/UI-THEMING.md).
- **UI mobile-friendly** — aksi utama tetap terlihat, tombol sekunder di menu dropdown ⋮.
- **Login aman (opsional)** — scrypt hash, sesi cookie HMAC + `SameSite=Strict`, rate-limit; kelola via `npm run set-password` atau menu 🔑. Lihat [`docs/WORKFLOW.md`](docs/WORKFLOW.md) §4.
- **Filter & cari** — per tipe (VM/CT), status (running/stopped), atau nama/VMID.
- **Aman** — token API Proxmox (bukan password), opsi proteksi token dashboard, systemd hardening.

---

## Dokumentasi

- [`docs/WORKFLOW.md`](docs/WORKFLOW.md) — alur dev, uji, deploy, keamanan login, troubleshooting.
- [`docs/UI-THEMING.md`](docs/UI-THEMING.md) — sistem tema (Orange/Hijau), mobile, cara tambah tema, fallback.

---

## Instalasi

### Opsi A — Otomatis penuh dari host Proxmox (paling mudah)

Membuat LXC Ubuntu 24.04 **dan** memasang dashboard di dalamnya dengan satu perintah. Jalankan **di host Proxmox** (shell node) — tinggal tempel, sudah mengarah ke repo ini:

```bash
CTID=950 IP=dhcp bash <(curl -fsSL https://raw.githubusercontent.com/DomeiNokiO/proxmox-dashboard/main/scripts/create-ct.sh)
```

Atau dengan IP statis:

```bash
CTID=950 IP=192.168.1.240/24 GW=192.168.1.1 CORES=1 MEMORY=512 DISK=4 \
bash <(curl -fsSL https://raw.githubusercontent.com/DomeiNokiO/proxmox-dashboard/main/scripts/create-ct.sh)
```

Setelah selesai, set kredensial Proxmox:

```bash
pct exec 950 -- nano /opt/proxmox-dashboard/.env
pct exec 950 -- systemctl restart proxmox-dashboard
```

### Opsi B — Di dalam CT/VM Ubuntu yang sudah ada (paste langsung)

Satu baris, langsung pasang semua dependensi + service (jalankan sebagai root di dalam CT):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/DomeiNokiO/proxmox-dashboard/main/scripts/install.sh)
```

Installer akan **menanyakan langsung** apakah ingin mengaktifkan login (username & password) — meski dijalankan via `curl | bash`. Password disimpan sebagai **hash scrypt** (bukan plaintext). Bisa juga non-interaktif:

```bash
DASH_USER=admin DASH_PASS='PasswordKuatAnda' \
bash <(curl -fsSL https://raw.githubusercontent.com/DomeiNokiO/proxmox-dashboard/main/scripts/install.sh)
```

Atau manual:

```bash
git clone https://github.com/DomeiNokiO/proxmox-dashboard.git /opt/proxmox-dashboard
cd /opt/proxmox-dashboard
bash scripts/install.sh        # pasang Node.js, service, systemd
nano .env                      # isi PVE_HOST, token, dll
systemctl start proxmox-dashboard
```

### Opsi C — Development lokal

```bash
git clone https://github.com/DomeiNokiO/proxmox-dashboard.git
cd proxmox-dashboard
npm install
cp .env.example .env && nano .env
npm start        # atau: npm run dev (auto-reload)
```

Buka `http://<IP>:3000`.

---

## Kredensial Proxmox (API Token)

Dashboard butuh **API Token** Proxmox (bukan password). Panduan lengkap cara membuatnya via CLI atau Web GUI: **[docs/PROXMOX-TOKEN.md](docs/PROXMOX-TOKEN.md)**.

Ringkas (di host Proxmox):

```bash
pveum user add automation@pve
pveum role add Automational -privs "VM.Allocate VM.Config.Disk VM.Config.CPU VM.Config.Memory VM.Config.Network VM.Config.Options VM.Config.Cloudinit VM.PowerMgmt VM.Snapshot VM.Clone VM.Migrate VM.Audit VM.Console Datastore.AllocateSpace Datastore.Audit Sys.Audit Sys.Console SDN.Use"
pveum aclmod / -user automation@pve -role Automational
pveum user token add automation@pve automate --privsep 0   # secret muncul SEKALI — catat!
```

---

## Konfigurasi (.env)

| Variabel | Wajib | Keterangan |
|---|---|---|
| `PVE_HOST` | ✅ | IP/hostname Proxmox |
| `PVE_NODE` | ✅ | Nama node (mis. `pve`) |
| `PVE_TOKEN_ID` | ✅ | `user@realm!tokenname` |
| `PVE_TOKEN_SECRET` | ✅ | Secret token |
| `PVE_VERIFY_SSL` | | `false` (default, self-signed) / `true` |
| `PORT` | | Port dashboard (default 3000) |
| `DASHBOARD_TOKEN` | | Isi untuk mengaktifkan proteksi akses |
| `DEFAULT_STORAGE` | | Storage default form create |
| `DEFAULT_BRIDGE` | | Bridge default (mis. `vmbr0`) |
| `POLL_INTERVAL` | | Interval broadcast realtime (ms) |

### Membuat API Token Proxmox

Di host Proxmox:

```bash
pveum user add automation@pve
pveum role add DashAdmin -privs "VM.Allocate VM.Config.Disk VM.Config.CPU VM.Config.Memory VM.Config.Network VM.Config.Options VM.Config.Cloudinit VM.PowerMgmt VM.Snapshot VM.Clone VM.Migrate VM.Audit VM.Console Datastore.AllocateSpace Datastore.Audit Sys.Audit Sys.Console SDN.Use"
pveum aclmod / -user automation@pve -role DashAdmin
pveum user token add automation@pve automate --privsep 0
# Salin value token -> PVE_TOKEN_SECRET
```

> `--privsep 0` membuat token mewarisi hak user. Untuk kontrol lebih ketat pakai `--privsep 1` lalu `pveum aclmod` ke token-nya langsung.

---

## Keamanan

- **Jangan** ekspos dashboard langsung ke internet tanpa proteksi. Set `DASHBOARD_TOKEN` (string acak panjang) dan/atau taruh di belakang reverse proxy (nginx + TLS) atau Cloudflare Tunnel.
- Token dashboard dikirim via header `X-Auth-Token`. Di browser, simpan lewat: `localStorage.setItem('pve_dash_token','...')`.
- Gunakan **API token** ber-privilege minimal, bukan `root@pam` password.
- `.env` di-set mode `640` dan dimiliki user service oleh installer.

---

## Login dashboard (opsional tapi disarankan)

Dashboard bisa dijalankan **tanpa login** (terbuka di LAN terisolasi) atau **dengan login** (username + password, hash scrypt + sesi cookie HMAC + rate-limit).

### Cara termudah mengaktifkan / mengganti kredensial — anti-drama

Jika saat install belum sempat mengisi login, atau **belum bisa login**, jalankan (sebagai root di dalam CT):

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/DomeiNokiO/proxmox-dashboard/main/scripts/update.sh)
cd /opt/proxmox-dashboard && npm run set-password
systemctl restart proxmox-dashboard
```

`npm run set-password` akan **menanyakan username & password langsung di terminal** (password diketik tersembunyi), lalu meng-hash-nya (scrypt) dan menuliskannya ke `.env`. **Tidak perlu menempel hash panjang** — semua otomatis.

### Ganti password dari dalam dashboard

Setelah login: buka menu **⋮ → 🔑 Ganti Password**. Verifikasi password lama, simpan password baru (hash scrypt), berlaku langsung tanpa restart.

### Menonaktifkan login

Kosongkan `DASHBOARD_USER` & `DASHBOARD_PASSWORD*` di `.env`, lalu `systemctl restart proxmox-dashboard`. Dashboard kembali terbuka.

> **Akses via IP lokal / tunnel VPN (HTTP non-secure)?** Biarkan `TRUST_PROXY=false` (default). Cookie sesi tetap tersimpan karena flag `Secure` tidak dipaksakan di HTTP; enkripsi disediakan oleh tunnel VPN Anda. Set `TRUST_PROXY=true` **hanya** bila di belakang reverse-proxy/Cloudflare Tunnel tepercaya.

---

## Troubleshooting

### Terminal Node error 403 `Sys.Console`

Gejala saat klik **⌨ Terminal Node**:

```
Terminal gagal dimuat: Proxmox 403 POST /nodes/<node>/termproxy:
{"message":"Permission check failed (/nodes/<node>, Sys.Console)","data":null}
```

Penyebab: role token Proxmox belum punya privilege **`Sys.Console`** (diperlukan untuk shell node-level). Perbaiki **di host Proxmox** (ganti `Automational` dengan nama role token Anda):

```bash
pveum role modify Automational -privs "VM.Allocate VM.Config.Disk VM.Config.CPU VM.Config.Memory VM.Config.Network VM.Config.Options VM.Config.Cloudinit VM.PowerMgmt VM.Snapshot VM.Clone VM.Migrate VM.Audit VM.Console Datastore.AllocateSpace Datastore.Audit Sys.Audit Sys.Console SDN.Use"
```

Tidak perlu restart Proxmox — coba klik Terminal Node lagi. (Cek role token: `pveum user token permissions <user>@<realm> <tokenname>`.)

### Gagal Create CT / VM — permission denied

Create CT/VM butuh privilege lengkap pada role token. Bila muncul error seperti
`Permission check failed (... SDN.Use)`, `... Datastore.AllocateSpace`, atau `... VM.Allocate`,
tambahkan semua privilege berikut sekali jalan **di host Proxmox**:

```bash
pveum role modify Automational -privs "VM.Allocate VM.Config.Disk VM.Config.CPU VM.Config.Memory VM.Config.Network VM.Config.Options VM.Config.Cloudinit VM.PowerMgmt VM.Snapshot VM.Clone VM.Migrate VM.Audit VM.Console Datastore.AllocateSpace Datastore.Audit Sys.Audit Sys.Console SDN.Use"
```

Arti privilege penting untuk create CT:
- `VM.Allocate` — membuat guest baru.
- `Datastore.AllocateSpace` — mengalokasikan disk/rootfs di storage.
- `VM.Config.*` — set CPU/RAM/disk/network/options/cloud-init.
- `SDN.Use` — **wajib bila bridge yang dipakai adalah SDN** (VNet). Tanpa ini create gagal di tahap network.
- `Sys.Console` — untuk Terminal Node (lihat di atas).

Bila token dibuat dengan `--privsep 1`, ACL harus dipasang ke **token**-nya, bukan hanya user:

```bash
pveum aclmod / -token 'automation@pve!automate' -role Automational
```

Login belum aktif tapi ingin aktif → lihat bagian **Login dashboard** di atas.

---

## Manajemen service

```bash
systemctl status proxmox-dashboard
systemctl restart proxmox-dashboard
journalctl -u proxmox-dashboard -f      # log realtime
```

### Update ke versi terbaru (sekali paste, tanpa drama)

Jalankan sebagai **root di dalam CT**:

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/DomeiNokiO/proxmox-dashboard/main/scripts/update.sh)
```

Script otomatis: set `safe.directory`, `git pull` **sebagai pemilik repo** (pvedash) sehingga kepemilikan file tidak rusak, pasang ulang dependency bila berubah, `chown`, lalu restart service dan tampilkan status.

> Jangan `git pull` manual sebagai root — file baru jadi milik root dan service (jalan sebagai `pvedash`) bisa gagal baca. Pakai `update.sh`.

---

## Arsitektur

```
Browser ──HTTP/REST──► Express ──► ProxmoxClient ──HTTPS──► Proxmox API :8006
   ▲                      │
   └──────WebSocket───────┘   (poll tiap POLL_INTERVAL, broadcast snapshot)
```

- `src/proxmox.js` — client API (token, native fetch, polling UPID task).
- `src/routes.js` — REST endpoints (guests, actions, resources, create).
- `src/server.js` — Express + WebSocket + loop broadcast.
- `public/` — UI vanilla JS + Tailwind CDN.
- `scripts/install.sh` — installer di dalam CT/VM.
- `scripts/create-ct.sh` — buat CT + install otomatis dari host Proxmox.

Lihat [docs/API.md](docs/API.md) untuk daftar endpoint REST.

---

## Performa & Beban (ringan di Proxmox)

Dashboard dirancang agar **nyaris tak membebani** Proxmox:

- **Poll on-demand** — status di-poll HANYA saat ada browser dashboard terbuka. Tidak ada tab aktif = **0 request** ke Proxmox (bukan loop 24/7).
- **Beban per siklus** — `GET /cluster/resources` (1) + `GET /nodes` (1) + `GET /nodes/{n}/status` per node **online** saja. Cluster 1 node = **3 request tiap `POLL_INTERVAL`** (default 5 dtk) selama dashboard dibuka. Semuanya endpoint read-only ringan yang dilayani dari pvestatd cache Proxmox — bukan query berat.
- **Anti-overlap** — bila Proxmox lambat merespons, siklus berikutnya dilewati (tidak menumpuk request).
- **Node offline dilewati** — tak ada call status ke node yang mati.
- **Grafik histori** — data RRD di-fetch sekali saat modal dibuka (Proxmox sudah menyimpan RRD-nya sendiri; tak ada sampling tambahan dari dashboard).
- **Console VNC** — koneksi biner hanya hidup selama modal console terbuka, langsung ditutup di kedua sisi saat modal ditutup.
- **Footprint** — proses Node.js tunggal, RAM ± 50–70 MB, tanpa database. Cocok jalan di LXC kecil (1 vCPU / 512 MB).

Perkiraan: dengan default 5 dtk & 1 admin memantau, beban ke Proxmox < 1 request/detik dari endpoint status ringan — dapat diabaikan. Naikkan `POLL_INTERVAL` (mis. `10000`) bila ingin lebih hemat lagi.

---

## Lisensi

MIT
