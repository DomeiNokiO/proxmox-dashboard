#!/usr/bin/env bash
# ============================================================
# Proxmox Dashboard — Installer untuk LXC/VM Ubuntu 22.04/24.04
# ============================================================
# Jalankan DI DALAM container/VM sebagai root, salah satu cara:
#   1) Dari dalam repo   :  bash scripts/install.sh
#   2) Sekali tempel     :  REPO_URL=https://github.com/DomeiNokiO/proxmox-dashboard.git \
#                           bash -c "$(curl -fsSL <raw-url>/scripts/install.sh)"
# Script memasang Node.js 20 LTS, dependensi, user service,
# systemd unit, lalu menampilkan ringkasan instalasi.
# ============================================================
set -Eeuo pipefail

# Locale aman: cegah warning perl/apt di image minimal tanpa en_US.UTF-8.
# C.UTF-8 selalu tersedia di Debian/Ubuntu.
export LC_ALL=C.UTF-8 LANG=C.UTF-8

APP_USER="pvedash"
APP_DIR="/opt/proxmox-dashboard"
NODE_MAJOR="20"
SERVICE="proxmox-dashboard"
REPO_URL="${REPO_URL:-https://github.com/DomeiNokiO/proxmox-dashboard.git}"

info() { echo -e "\e[36m[INFO]\e[0m $*"; }
ok()   { echo -e "\e[32m[ OK ]\e[0m $*"; }
warn() { echo -e "\e[33m[WARN]\e[0m $*"; }
err()  { echo -e "\e[31m[ERR ]\e[0m $*" >&2; }

# Tangkap error apa pun dan tampilkan baris penyebab — tanpa "drama" senyap.
trap 'err "Instalasi gagal di baris $LINENO (perintah: ${BASH_COMMAND}). Lihat pesan di atas."' ERR

if [[ $EUID -ne 0 ]]; then err "Jalankan sebagai root (mis. sudo bash scripts/install.sh)."; exit 1; fi

# --- 1. Dependensi dasar ---
info "Memperbarui apt & memasang prasyarat (curl, git, gnupg, openssl)…"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates gnupg git openssl >/dev/null
ok "Prasyarat terpasang"

# --- 2. Node.js LTS ---
need_node=1
if command -v node >/dev/null 2>&1; then
  cur="$(node -v 2>/dev/null | grep -oP '\d+' | head -1 || echo 0)"
  [[ "${cur:-0}" -ge 18 ]] && need_node=0
fi
if [[ "$need_node" -eq 1 ]]; then
  info "Memasang Node.js ${NODE_MAJOR}.x LTS…"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
command -v node >/dev/null || { err "Node.js gagal terpasang."; exit 1; }
ok "Node $(node -v), npm $(npm -v)"

# --- 3. User sistem ---
if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "/home/$APP_USER" --shell /usr/sbin/nologin "$APP_USER"
  ok "User sistem '$APP_USER' dibuat"
else
  ok "User sistem '$APP_USER' sudah ada"
fi

# --- 4. Kode aplikasi ---
# Sumber = lokasi script ini (../ dari scripts/). Bila belum ada package.json,
# clone dari REPO_URL.
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ ! -f "$SRC_DIR/package.json" ]]; then
  if [[ -z "${REPO_URL:-}" ]]; then
    err "package.json tak ditemukan & REPO_URL tidak diset."
    err "Set: REPO_URL=https://github.com/DomeiNokiO/proxmox-dashboard.git bash scripts/install.sh"
    exit 1
  fi
  info "Meng-clone dari $REPO_URL…"
  rm -rf "$APP_DIR"
  git clone --depth 1 "$REPO_URL" "$APP_DIR"
  SRC_DIR="$APP_DIR"
fi

mkdir -p "$APP_DIR"
# Salin kode ke APP_DIR — LEWATI bila sumber sudah sama dgn tujuan (mis. sudah di-clone
# langsung ke /opt/proxmox-dashboard). '-ef' membandingkan inode, jadi tahan symlink.
if [[ "$SRC_DIR" -ef "$APP_DIR" ]]; then
  info "Kode sudah berada di $APP_DIR — tak perlu menyalin."
else
  info "Menyalin kode dari $SRC_DIR → $APP_DIR…"
  cp -rT "$SRC_DIR/src" "$APP_DIR/src"
  cp -rT "$SRC_DIR/public" "$APP_DIR/public"
  cp -f  "$SRC_DIR/package.json" "$APP_DIR/package.json"
  [[ -f "$SRC_DIR/package-lock.json" ]] && cp -f "$SRC_DIR/package-lock.json" "$APP_DIR/"
  [[ -f "$SRC_DIR/.env.example" ]] && cp -f "$SRC_DIR/.env.example" "$APP_DIR/.env.example"
fi
ok "Kode aplikasi siap di $APP_DIR"

# --- 5. Dependencies produksi ---
cd "$APP_DIR"
info "Memasang dependencies produksi (npm)…"
# Pakai 'npm ci' bila ada lockfile (lebih cepat & deterministik); fallback ke install.
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev --no-audit --no-fund
else
  npm install --omit=dev --no-audit --no-fund
fi
ok "Dependencies terpasang"

# --- 6. File .env ---
if [[ ! -f "$APP_DIR/.env" ]]; then
  if [[ -f "$APP_DIR/.env.example" ]]; then
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
  else
    err ".env.example tidak ditemukan — tak bisa membuat .env."
    exit 1
  fi
  ENV_CREATED=1
else
  ENV_CREATED=0
fi

chown -R "$APP_USER:$APP_USER" "$APP_DIR"
chmod 640 "$APP_DIR/.env"

# --- 7. systemd unit ---
info "Membuat & mengaktifkan systemd service…"
NODE_BIN="$(command -v node)"
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
ExecStart=${NODE_BIN} ${APP_DIR}/src/server.js
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
ok "Service '${SERVICE}' aktif (enabled saat boot)"

# --- 8. Coba nyalakan bila .env sudah terisi (bukan template) ---
STARTED=0
if [[ "$ENV_CREATED" -eq 0 ]] && ! grep -q 'PVE_TOKEN_SECRET=xxxxxxxx' "$APP_DIR/.env" 2>/dev/null; then
  info "Menyalakan service…"
  if systemctl restart "${SERVICE}"; then
    sleep 2
    systemctl is-active --quiet "${SERVICE}" && STARTED=1
  fi
fi

PORT="$(grep -oP '^PORT=\K\d+' "$APP_DIR/.env" 2>/dev/null || echo 3000)"
IP_ADDR="$(hostname -I 2>/dev/null | awk '{print $1}' || echo '<IP-CT>')"

# --- 9. Ringkasan ---
echo
ok "Instalasi selesai."
echo "==========================================================="
echo "  Proxmox Dashboard — ringkasan instalasi"
echo "-----------------------------------------------------------"
echo "  Direktori   : $APP_DIR"
echo "  Node.js     : $(node -v)   npm $(npm -v)"
echo "  User service: $APP_USER"
echo "  Service     : ${SERVICE} (enabled)"
echo "  Port        : $PORT"
echo "  Alamat      : http://${IP_ADDR}:${PORT}"
echo "-----------------------------------------------------------"
if [[ "$STARTED" -eq 1 ]]; then
  echo -e "  Status      : \e[32mBERJALAN\e[0m ✓  — buka http://${IP_ADDR}:${PORT}"
else
  echo -e "  Status      : \e[33mBELUM JALAN\e[0m — kredensial Proxmox perlu diisi:"
  echo "    1) nano $APP_DIR/.env      # isi PVE_HOST, PVE_TOKEN_ID, PVE_TOKEN_SECRET"
  echo "    2) systemctl restart ${SERVICE}"
fi
echo "-----------------------------------------------------------"
echo "  Cek status  : systemctl status ${SERVICE}"
echo "  Lihat log   : journalctl -u ${SERVICE} -f"
echo "==========================================================="
