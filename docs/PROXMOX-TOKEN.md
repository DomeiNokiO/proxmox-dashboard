# Mengambil Kredensial Proxmox (API Token)

Dashboard butuh **API Token** Proxmox — bukan password root. API Token lebih aman: hak aksesnya bisa dibatasi dan bisa dicabut kapan saja tanpa mengganggu akun lain.

Ada 2 cara: **CLI** (paling cepat) atau **Web GUI**.

---

## Cara 1 — CLI (jalankan di shell host Proxmox)

Login SSH ke node Proxmox sebagai `root`, lalu tempel:

```bash
# 1. Buat user khusus otomasi
pveum user add automation@pve

# 2. Buat role dengan hak minimal yang diperlukan dashboard
pveum role add Automational -privs "VM.Allocate VM.Config.Disk VM.Config.CPU VM.Config.Memory VM.Config.Network VM.Config.Options VM.Config.Cloudinit VM.PowerMgmt VM.Snapshot VM.Clone VM.Migrate VM.Audit VM.Console Datastore.AllocateSpace Datastore.Audit Sys.Audit"

# 3. Berikan role itu ke user di seluruh path (/)
pveum aclmod / -user automation@pve -role Automational

# 4. Buat token (privsep 0 = token mewarisi hak user)
pveum user token add automation@pve automate --privsep 0
```

Setelah perintah ke-4, Proxmox menampilkan tabel:

```
┌──────────────┬──────────────────────────────────────┐
│ key          │ value                                │
├──────────────┼──────────────────────────────────────┤
│ full-tokenid │ automation@pve!automate              │
│ value        │ 12345678-abcd-1234-abcd-1234567890ab │
└──────────────┴──────────────────────────────────────┘
```

> ⚠️ **`value` (secret) HANYA muncul sekali ini.** Catat sekarang — bila hilang, buat token baru (`pveum user token remove automation@pve automate` lalu ulangi langkah 4).

---

## Cara 2 — Web GUI

1. **Datacenter → Permissions → Users → Add** — buat user mis. `automation`, realm **Proxmox VE authentication server (pve)**.
2. **Datacenter → Permissions → Roles → Create** — nama `Automational`, centang privilege `VM.*` + `Datastore.*` + `Sys.Audit` (seperti daftar CLI di atas). Atau pakai role bawaan `PVEVMAdmin` bila ingin cepat (haknya lebih luas).
3. **Datacenter → Permissions → Add → API Token Permission** — path `/`, user `automation@pve`, role `Automational`.
4. **Datacenter → Permissions → API Tokens → Add** — pilih user `automation@pve`, Token ID `automate`, **hilangkan centang "Privilege Separation"**.
5. Dialog menampilkan **Token ID** dan **Secret** — salin secret sekarang (sekali muncul).

---

## Isi ke `.env`

Di dalam CT tempat dashboard terpasang:

```bash
nano /opt/proxmox-dashboard/.env
```

| Variabel            | Isi                                   | Cara dapat                          |
|---------------------|---------------------------------------|-------------------------------------|
| `PVE_HOST`          | IP node Proxmox                       | IP host Proxmox-mu                  |
| `PVE_PORT`          | `8006` (default)                      | biarkan bila standar                |
| `PVE_NODE`          | nama node, mis. `pve`                 | jalankan `hostname` di node         |
| `PVE_TOKEN_ID`      | `automation@pve!automate`             | baris `full-tokenid`                |
| `PVE_TOKEN_SECRET`  | `12345678-abcd-...`                   | baris `value` (rahasia, sekali muncul) |
| `PVE_VERIFY_SSL`    | `false`                               | biarkan `false` bila cert self-signed |

Lalu **nyalakan service** (wajib setelah mengisi `.env` pertama kali):

```bash
systemctl start proxmox-dashboard        # start pertama kali
# atau: systemctl restart proxmox-dashboard   (bila mengubah .env saat sudah jalan)
systemctl status proxmox-dashboard --no-pager   # pastikan: active (running)
journalctl -u proxmox-dashboard -n 30 --no-pager  # lihat log bila ada kendala
```

> Installer meng-*enable* service (auto-start saat boot) tapi TIDAK menyalakannya otomatis bila `.env` masih template. Jadi setelah mengisi kredensial, jangan lupa `systemctl start proxmox-dashboard`.

Buka dashboard di `http://<IP-CT>:<PORT>` (default port `3000`).

---

## Troubleshooting

**Web tidak bisa diakses / `ERR_CONNECTION_REFUSED`**
- Service belum jalan: `systemctl start proxmox-dashboard` (lihat di atas).
- VPN di perangkatmu memblok IP LAN CT (mis. `172.x`) — matikan VPN.
- Cek port terbuka di CT: `ss -tlnp | grep 3000` dan `curl -sS http://localhost:3000/healthz`.

**Dashboard muncul tapi "Failed to fetch" / daftar VM kosong**
Backend gagal menghubungi API Proxmox. Diagnosa dari dalam CT:

```bash
curl -sS http://localhost:3000/api/guests ; echo          # baca pesan error-nya
source /opt/proxmox-dashboard/.env
curl -sk -H "Authorization: PVEAPI...RET}" \
  https://${PVE_HOST}:${PVE_PORT:-8006}/api2/json/version ; echo
```

- `{"data":{"version":...}}` → token & jaringan OK. Cek `PVE_NODE` cocok dengan `hostname` node Proxmox.
- `401 authentication failure` → Token ID/secret salah, atau role belum ter-assign ke **token** (`pveum aclmod / -user automation@pve -role Automational`, dan token dibuat `--privsep 0`).
- `Connection refused`/timeout → CT tak bisa mencapai Proxmox. Cek `PVE_HOST` benar & `ping $PVE_HOST` dari CT.
- `SSL certificate problem` → set `PVE_VERIFY_SSL=false` di `.env` lalu restart.

Setelah memperbaiki `.env`: `systemctl restart proxmox-dashboard`.

---

## Verifikasi token (opsional)

Uji token langsung dari CT sebelum menyalakan service:

```bash
curl -sk -H "Authorization: PVEAPIToken=automation@pve!automate=SECRET_KAMU" \
  https://PVE_HOST:8006/api2/json/version
```

Balasan `{"data":{"version":...}}` berarti token valid. Bila `401`, cek: realm (`@pve`), Token ID benar, dan role sudah ter-assign ke token (langkah 3).

---

## Keamanan

- Token = kredensial rahasia. Jangan commit `.env`, jangan bagikan di chat.
- Cabut token bila bocor: `pveum user token remove automation@pve automate`.
- Untuk read-only (dashboard hanya memantau, tanpa kontrol), pakai privilege `VM.Audit Sys.Audit Datastore.Audit` saja.
