#!/usr/bin/env bash
# ============================================================
# Proxmox Dashboard — Installer untuk LXC/VM Ubuntu 24.04
# ============================================================
# Jalankan DI DALAM container/VM Ubuntu 24.04 sebagai root:
#   bash install.sh
# Script ini: pasang Node.js 20 LTS, clone/pakai kode, buat
# user service, systemd unit, dan menyalakan dashboard.
# ============================================================
set -euo pipefail

APP_USER="pvedash"
APP_DIR="/opt/proxmox-dashboard"
NODE_MAJOR="20"
SERVICE="proxmox-dashboard"

info() { echo -e "\e[36m[INFO]\e[0m $*"; }
ok()   { echo -e "\e[32m[ OK ]\e[0m $*"; }
err()  { echo -e "\e[31m[ERR ]\e[0m $*" >&2; }

if [[ $EUID -ne 0 ]]; then err "Jalankan sebagai root."; exit 1; fi

# --- 1. Dependensi dasar ---
info "Update apt & pasang prasyarat…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git >/dev/null

# --- 2. Node.js LTS ---
if ! command -v node >/dev/null || [[ "$(node -v | grep -oP '\d+' | head -1)" -lt 18 ]]; then
  info "Memasang Node.js ${NODE_MAJOR}.x…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
ok "Node $(node -v), npm $(npm -v)"

# --- 3. User sistem ---
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
  ok "User $APP_USER dibuat"
fi

# --- 4. Kode aplikasi ---
# Bila script dijalankan dari dalam repo, salin; jika tidak, minta git clone.
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -f "$SRC_DIR/package.json" ]]; then
  info "Menyalin kode dari $SRC_DIR…"
  mkdir -p "$APP_DIR"
  cp -r "$SRC_DIR/src" "$SRC_DIR/public" "$SRC_DIR/package.json" "$APP_DIR/"
  [[ -f "$SRC_DIR/package-lock.json" ]] && cp "$SRC_DIR/package-lock.json" "$APP_DIR/"
else
  if [[ -z "${REPO_URL:-}" ]]; then
    err "package.json tidak ditemukan & REPO_URL tidak diset."
    err "Set: REPO_URL=https://github.com/USER/proxmox-dashboard.git bash install.sh"
    exit 1
  fi
  info "Clone dari $REPO_URL…"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
fi

# --- 5. Dependencies produksi ---
info "npm install (production)…"
cd "$APP_DIR"
npm install --omit=dev --no-audit --no-fund >/dev/null 2>&1
ok "Dependencies terpasang"

# --- 6. File .env ---
if [[ ! -f "$APP_DIR/.env" ]]; then
  cp "$APP_DIR/.env.example" "$APP_DIR/.env" 2>/dev/null || cp "$SRC_DIR/.env.example" "$APP_DIR/.env"
  info "File .env dibuat dari template — WAJIB diedit:"
  echo "     nano $APP_DIR/.env"
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 640 "$APP_DIR/.env"

# --- 7. systemd unit ---
info "Membuat systemd service…"
cat > "/etc/systemd/system/${SERVICE}.service" <<EOF
[Unit]
Description=Proxmox Dashboard (realtime VM/CT manager)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${APP_USER}
WorkingDirectory=${APP_DIR}
EnvironmentFile=${APP_DIR}/.env
ExecStart=$(command -v node) ${APP_DIR}/src/server.js
Restart=on-failure
RestartSec=5
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=${APP_DIR}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable "${SERVICE}" >/dev/null 2>&1

echo
ok "Instalasi selesai!"
echo "-----------------------------------------------------------"
echo " 1. Edit konfigurasi : nano $APP_DIR/.env"
echo " 2. Jalankan         : systemctl start ${SERVICE}"
echo " 3. Cek status       : systemctl status ${SERVICE}"
echo " 4. Lihat log        : journalctl -u ${SERVICE} -f"
echo " 5. Buka dashboard   : http://<IP-CT>:$(grep -oP 'PORT=\K\d+' "$APP_DIR/.env" 2>/dev/null || echo 3000)"
echo "-----------------------------------------------------------"
