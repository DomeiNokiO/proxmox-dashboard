#!/usr/bin/env bash
# ============================================================
# create-ct.sh — Buat LXC Ubuntu 24.04 + install Proxmox
#                Dashboard otomatis. JALANKAN DI HOST PROXMOX.
# ============================================================
# Contoh:
#   REPO_URL=https://github.com/USER/proxmox-dashboard.git \
#   CTID=950 bash create-ct.sh
# ============================================================
set -euo pipefail

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
REPO_URL="${REPO_URL:-}"
DASH_PORT="${DASH_PORT:-3000}"

info() { echo -e "\e[36m[INFO]\e[0m $*"; }
ok()   { echo -e "\e[32m[ OK ]\e[0m $*"; }
err()  { echo -e "\e[31m[ERR ]\e[0m $*" >&2; }

command -v pct >/dev/null || { err "pct tidak ditemukan — jalankan di host Proxmox."; exit 1; }
[[ -z "$REPO_URL" ]] && { err "REPO_URL wajib diisi (URL git repo dashboard)."; exit 1; }
if pct status "$CTID" >/dev/null 2>&1; then err "CTID $CTID sudah dipakai."; exit 1; fi
[[ -z "$PASSWORD" ]] && PASSWORD="$(openssl rand -base64 12)"

# --- 1. Pastikan template Ubuntu 24.04 tersedia ---
info "Cek template Ubuntu 24.04…"
TMPL=$(pveam list "$TMPL_STORAGE" 2>/dev/null | grep -oP 'ubuntu-24\.04-standard[^ ]*' | head -1 || true)
if [[ -z "$TMPL" ]]; then
  info "Mengunduh template Ubuntu 24.04…"
  pveam update >/dev/null
  AVAIL=$(pveam available --section system | grep -oP 'ubuntu-24\.04-standard[^ ]*' | head -1)
  pveam download "$TMPL_STORAGE" "$AVAIL"
  TMPL="$AVAIL"
fi
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
sleep 8   # tunggu jaringan siap

# --- 4. Install dashboard di dalam CT ---
info "Memasang dependensi & dashboard di dalam CT…"
pct exec "$CTID" -- bash -c "
  set -e
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq curl git ca-certificates gnupg >/dev/null
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
  rm -rf /opt/proxmox-dashboard
  git clone --depth 1 '$REPO_URL' /opt/proxmox-dashboard
  cd /opt/proxmox-dashboard
  bash scripts/install.sh
"

# --- 5. Info akhir ---
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
