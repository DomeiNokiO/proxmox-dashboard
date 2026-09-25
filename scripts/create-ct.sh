#!/usr/bin/env bash
# ============================================================
# create-ct.sh — Buat LXC Ubuntu 24.04 + install Proxmox
#                Dashboard otomatis. JALANKAN DI HOST PROXMOX.
# ============================================================
# Contoh:
#   REPO_URL=https://github.com/DomeiNokiO/proxmox-dashboard.git \
#   CTID=950 bash create-ct.sh
# ============================================================
set -Eeuo pipefail

# --- Parameter (override via env) ---
CTID="${CTID:-950}"
HOSTNAME_CT="${HOSTNAME_CT:-pve-dashboard}"
CORES="${CORES:-1}"
MEMORY="${MEMORY:-512}"
DISK="${DISK:-4}"
STORAGE="${STORAGE:-local-lvm}"
BRIDGE="${BRIDGE:-vmbr0}"
IP="${IP:-dhcp}"                      # dhcp atau 192.168.1.240/24
GW="${GW:-}"                          # wajib bila IP statis
TMPL_STORAGE="${TMPL_STORAGE:-local}"
PASSWORD="${PASSWORD:-}"              # kosong = generate acak
REPO_URL="${REPO_URL:-https://github.com/DomeiNokiO/proxmox-dashboard.git}"
DASH_PORT="${DASH_PORT:-3000}"

info() { echo -e "\e[36m[INFO]\e[0m $*"; }
ok()   { echo -e "\e[32m[ OK ]\e[0m $*"; }
err()  { echo -e "\e[31m[ERR ]\e[0m $*" >&2; }
trap 'err "Gagal di baris $LINENO (perintah: ${BASH_COMMAND})."' ERR

command -v pct >/dev/null || { err "pct tidak ditemukan — jalankan di host Proxmox."; exit 1; }
[[ -z "$REPO_URL" ]] && { err "REPO_URL wajib diisi (URL git repo dashboard)."; exit 1; }
if pct status "$CTID" >/dev/null 2>&1; then err "CTID $CTID sudah dipakai. Pilih CTID lain."; exit 1; fi
[[ "$IP" != "dhcp" && -z "$GW" ]] && { err "IP statis butuh GW. Set GW=<gateway>."; exit 1; }
[[ -z "$PASSWORD" ]] && PASSWORD="$(openssl rand -base64 12)"

# --- 1. Pastikan template Ubuntu 24.04 tersedia ---
info "Memeriksa template Ubuntu 24.04…"
TMPL=$(pveam list "$TMPL_STORAGE" 2>/dev/null | grep -oP 'ubuntu-24\.04-standard[^ ]*' | head -1 || true)
if [[ -z "$TMPL" ]]; then
  info "Template belum ada — mengunduh…"
  pveam update >/dev/null
  AVAIL=$(pveam available --section system | grep -oP 'ubuntu-24\.04-standard[^ ]*' | head -1)
  [[ -z "$AVAIL" ]] && { err "Template Ubuntu 24.04 tidak tersedia di katalog pveam."; exit 1; }
  pveam download "$TMPL_STORAGE" "$AVAIL"
  TMPL="$AVAIL"
fi
# Rapikan bila 'pveam list' mengembalikan path lengkap (storage:vztmpl/nama)
TMPL="${TMPL##*/}"
OSTEMPLATE="${TMPL_STORAGE}:vztmpl/${TMPL}"
ok "Template: $OSTEMPLATE"

# --- 2. Susun konfigurasi network ---
NET="name=eth0,bridge=${BRIDGE},ip=${IP}"
[[ "$IP" != "dhcp" && -n "$GW" ]] && NET="${NET},gw=${GW}"

# --- 3. Buat container ---
info "Membuat CT $CTID ($HOSTNAME_CT)…"
pct create "$CTID" "$OSTEMPLATE" \
  --hostname "$HOSTNAME_CT" \
  --cores "$CORES" --memory "$MEMORY" \
  --rootfs "${STORAGE}:${DISK}" \
  --net0 "$NET" \
  --password "$PASSWORD" \
  --unprivileged 1 --features nesting=1 \
  --onboot 1 >/dev/null
ok "CT dibuat"

info "Menyalakan CT…"
pct start "$CTID"

# --- 4. Tunggu jaringan CT benar-benar siap (bukan sleep buta) ---
info "Menunggu jaringan CT siap…"
net_ready=0
for i in $(seq 1 30); do
  if pct exec "$CTID" -- bash -c 'getent hosts deb.nodesource.com >/dev/null 2>&1 || ping -c1 -W1 1.1.1.1 >/dev/null 2>&1'; then
    net_ready=1; break
  fi
  sleep 2
done
[[ "$net_ready" -eq 1 ]] || { err "Jaringan CT tidak siap setelah 60 dtk. Cek bridge/DHCP."; exit 1; }
ok "Jaringan siap"

# --- 5. Install dashboard di dalam CT ---
info "Memasang dependensi & dashboard di dalam CT…"
pct exec "$CTID" -- bash -c "
  set -Eeuo pipefail
  export DEBIAN_FRONTEND=noninteractive
  export LC_ALL=C.UTF-8 LANG=C.UTF-8
  apt-get update -qq
  apt-get install -y -qq curl git ca-certificates gnupg openssl >/dev/null
  rm -rf /opt/proxmox-dashboard
  git clone --depth 1 '$REPO_URL' /opt/proxmox-dashboard
  cd /opt/proxmox-dashboard
  bash scripts/install.sh
"
ok "Dashboard terpasang di CT"

# --- 6. Info akhir ---
CT_IP=$(pct exec "$CTID" -- hostname -I 2>/dev/null | awk '{print $1}' || echo '?')
echo
ok "Container dashboard siap!"
echo "==========================================================="
echo " CTID          : $CTID  ($HOSTNAME_CT)"
echo " Root password : $PASSWORD"
echo " IP            : $CT_IP"
echo " Dashboard     : http://${CT_IP}:${DASH_PORT}"
echo "-----------------------------------------------------------"
echo " LANGKAH TERAKHIR — set kredensial Proxmox di dalam CT:"
echo "   pct exec $CTID -- nano /opt/proxmox-dashboard/.env"
echo "   pct exec $CTID -- systemctl restart proxmox-dashboard"
echo "==========================================================="
