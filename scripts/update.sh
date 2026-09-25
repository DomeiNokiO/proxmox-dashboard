#!/usr/bin/env bash
# ============================================================
# update.sh — Perbarui Proxmox Dashboard ke versi terbaru.
#             Jalankan sebagai root DI DALAM CT/VM.
# ============================================================
#   bash <(curl -fsSL https://raw.githubusercontent.com/DomeiNokiO/proxmox-dashboard/main/scripts/update.sh)
# atau, dari dalam direktori:  bash scripts/update.sh
# ============================================================
set -Eeuo pipefail
export LC_ALL=C.UTF-8 LANG=C.UTF-8

APP_USER="pvedash"
APP_DIR="/opt/proxmox-dashboard"
SERVICE="proxmox-dashboard"

info() { echo -e "\e[36m[INFO]\e[0m $*"; }
ok()   { echo -e "\e[32m[ OK ]\e[0m $*"; }
err()  { echo -e "\e[31m[ERR ]\e[0m $*" >&2; }
trap 'err "Update gagal di baris $LINENO (perintah: ${BASH_COMMAND})."' ERR

[[ $EUID -ne 0 ]] && { err "Jalankan sebagai root."; exit 1; }
[[ -d "$APP_DIR/.git" ]] || { err "$APP_DIR bukan git repo. Instal dulu via install.sh."; exit 1; }

# Tandai direktori aman untuk git (root & user service).
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
sudo -u "$APP_USER" git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true

info "Menarik versi terbaru (sebagai $APP_USER)…"
# Pull sebagai pemilik repo agar kepemilikan file tetap benar (service jalan sebagai $APP_USER).
sudo -u "$APP_USER" git -C "$APP_DIR" pull --ff-only

info "Memasang dependencies bila berubah…"
cd "$APP_DIR"
if [[ -f package-lock.json ]]; then
  sudo -u "$APP_USER" npm ci --omit=dev --no-audit --no-fund
else
  sudo -u "$APP_USER" npm install --omit=dev --no-audit --no-fund
fi

# Pastikan kepemilikan konsisten (jaga-jaga bila pernah pull sbg root).
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

info "Merestart service…"
systemctl restart "$SERVICE"
sleep 2

if systemctl is-active --quiet "$SERVICE"; then
  ok "Update selesai — service BERJALAN."
  echo "  Versi commit: $(sudo -u "$APP_USER" git -C "$APP_DIR" rev-parse --short HEAD)"
else
  err "Service tidak aktif setelah update. Cek: journalctl -u $SERVICE -n 30 --no-pager"
  exit 1
fi
