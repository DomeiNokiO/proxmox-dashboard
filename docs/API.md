# API Reference

Base: `/api`. Bila `DASHBOARD_TOKEN` diset, sertakan header `X-Auth-Token: <token>`.

## Info

| Method | Endpoint | Keterangan |
|---|---|---|
| GET | `/api/info` | Versi Proxmox, daftar node |
| GET | `/api/node-status` | Metrik node (CPU, RAM, rootfs, uptime) |
| GET | `/api/meta` | Storage, template LXC, nextid, defaults (untuk form) |
| GET | `/healthz` | Healthcheck (tanpa auth) |

## Guests

| Method | Endpoint | Body | Keterangan |
|---|---|---|---|
| GET | `/api/guests` | — | Daftar semua VM & CT |
| GET | `/api/guests/:vmid` | — | Detail + config satu guest |
| POST | `/api/guests/:vmid/action/:act` | — | `act`: start, stop, shutdown, reboot, reset, suspend, resume |
| PUT | `/api/guests/:vmid/resources` | `{cores?, memory?}` | Ubah vCPU / RAM (MB) |
| PUT | `/api/guests/:vmid/disk` | `{disk, size}` | Perbesar disk, mis. `{disk:"scsi0", size:"+10G"}` |
| DELETE | `/api/guests/:vmid` | — | Hapus (auto-stop bila running) |

## Create

### POST `/api/vms` — buat VM (QEMU)

```json
{
  "vmid": 150, "name": "web-01",
  "cores": 2, "memory": 2048, "diskSize": 20,
  "storage": "local-lvm", "bridge": "vmbr0",
  "isoImage": "local:iso/ubuntu-24.04.iso",
  "ostype": "l26", "start": false
}
```

### POST `/api/cts` — buat Container (LXC)

```json
{
  "vmid": 250, "hostname": "app-ct",
  "ostemplate": "local:vztmpl/ubuntu-24.04-standard_24.04-2_amd64.tar.zst",
  "cores": 2, "memory": 2048, "diskSize": 8,
  "storage": "local-lvm", "bridge": "vmbr0",
  "password": "secret123", "sshKey": "ssh-ed25519 AAAA...",
  "ip": "192.168.1.250/24", "gw": "192.168.1.1",
  "unprivileged": true, "nesting": true, "start": false
}
```

Butuh salah satu dari `password` atau `sshKey`.

## Snapshot

| Method | Endpoint | Body | Keterangan |
|---|---|---|---|
| GET | `/api/guests/:vmid/snapshots` | — | Daftar snapshot |
| POST | `/api/guests/:vmid/snapshots` | `{snapname, description?, vmstate?}` | Buat snapshot (`vmstate:true` sertakan RAM) |
| POST | `/api/guests/:vmid/snapshots/:name/rollback` | — | Rollback ke snapshot |
| DELETE | `/api/guests/:vmid/snapshots/:name` | — | Hapus snapshot |

## Backup

| Method | Endpoint | Body | Keterangan |
|---|---|---|---|
| POST | `/api/guests/:vmid/backup` | `{storage, mode?, compress?}` | vzdump; `mode`: snapshot/suspend/stop, `compress`: zstd/gzip/lzo |

## Migrasi

| Method | Endpoint | Body | Keterangan |
|---|---|---|---|
| POST | `/api/guests/:vmid/migrate` | `{target, online?}` | Pindah ke node `target` (online untuk guest running) |

## Histori (RRD)

| Method | Endpoint | Query | Keterangan |
|---|---|---|---|
| GET | `/api/guests/:vmid/rrddata` | `?timeframe=hour\|day\|week\|month\|year` | Seri waktu CPU, RAM, net, disk I/O |

## Console VNC

| Method | Endpoint | Keterangan |
|---|---|---|
| GET | `/api/guests/:vmid/vncticket` | Ambil `{ticket, port}` untuk handshake noVNC |
| WS | `/vncws?vmid=&port=&vncticket=` | Proxy biner ke `vncwebsocket` Proxmox (auth token via `?token=`) |

## WebSocket

`ws://<host>/ws` (tambah `?token=<DASHBOARD_TOKEN>` bila auth aktif).

Pesan server → client:

```json
{ "type": "snapshot", "data": { "ts": 0, "node": "pve", "nodeStatus": {...}, "guests": [...] } }
{ "type": "error", "message": "..." }
```

Snapshot dikirim otomatis tiap `POLL_INTERVAL` ms dan sekali saat connect.

## Error

Semua error → HTTP status + `{ "error": "pesan" }`. Aksi mutasi Proxmox mengembalikan `{ ok: true, upid }`; server sudah mem-poll task create/delete sampai selesai sebelum membalas.
