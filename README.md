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
- **Filter & cari** — per tipe (VM/CT), status (running/stopped), atau nama/VMID.
- **Aman** — token API Proxmox (bukan password), opsi proteksi token dashboard, systemd hardening.

---

## Instalasi

### Opsi A — Otomatis penuh dari host Proxmox (paling mudah)

Membuat LXC Ubuntu 24.04 **dan** memasang dashboard di dalamnya dengan satu perintah. Jalankan **di host Proxmox** (shell node):

```bash
REPO_URL=https://github.com/USER/proxmox-dashboard.git \
CTID=950 IP=dhcp bash <(curl -fsSL https://raw.githubusercontent.com/USER/proxmox-dashboard/main/scripts/create-ct.sh)
```

Atau dengan IP statis:

```bash
REPO_URL=https://github.com/USER/proxmox-dashboard.git \
CTID=950 IP=192.168.1.240/24 GW=192.168.1.1 CORES=1 MEMORY=512 DISK=4 \
bash scripts/create-ct.sh
```

Setelah selesai, set kredensial Proxmox:

```bash
pct exec 950 -- nano /opt/proxmox-dashboard/.env
pct exec 950 -- systemctl restart proxmox-dashboard
```

### Opsi B — Manual di dalam CT/VM Ubuntu 24.04 yang sudah ada

```bash
git clone https://github.com/USER/proxmox-dashboard.git /opt/proxmox-dashboard
cd /opt/proxmox-dashboard
bash scripts/install.sh        # pasang Node.js, service, systemd
nano .env                      # isi PVE_HOST, token, dll
systemctl start proxmox-dashboard
```

### Opsi C — Development lokal

```bash
git clone https://github.com/USER/proxmox-dashboard.git
cd proxmox-dashboard
npm install
cp .env.example .env && nano .env
npm start        # atau: npm run dev (auto-reload)
```

Buka `http://<IP>:3000`.

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
pveum role add DashAdmin -privs "VM.Allocate VM.Config.Disk VM.Config.CPU VM.Config.Memory VM.Config.Network VM.Config.Options VM.Config.Cloudinit VM.PowerMgmt VM.Snapshot VM.Clone VM.Audit VM.Console Datastore.AllocateSpace Datastore.Audit Sys.Audit SDN.Use"
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

## Manajemen service

```bash
systemctl status proxmox-dashboard
systemctl restart proxmox-dashboard
journalctl -u proxmox-dashboard -f      # log realtime
```

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

## Lisensi

MIT
