#!/data/data/com.termux/files/usr/bin/env bash
# setup-termux.sh
# One-shot installer untuk webaff-video-fokus di Termux (Android).
# Jalankan dari folder repo (yang berisi server.js dan package.json):
#   bash setup-termux.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-3000}"
ADMIN_PIN_DEFAULT="${ADMIN_PIN:-1234}"
ENV_FILE="$SCRIPT_DIR/.env"

color() { printf "\033[%sm%s\033[0m\n" "$1" "$2"; }
info()  { color "36" "[info] $*"; }
ok()    { color "32" "[ok]   $*"; }
warn()  { color "33" "[warn] $*"; }
err()   { color "31" "[err]  $*" 1>&2; }

if [ -z "${PREFIX:-}" ] || ! echo "$PREFIX" | grep -qi "termux"; then
    err "Script ini harus dijalankan di dalam Termux."
    exit 1
fi

cd "$SCRIPT_DIR"

if [ ! -f package.json ] || [ ! -f server.js ]; then
    err "Tidak menemukan package.json/server.js di $SCRIPT_DIR. Jalankan script dari folder repo."
    exit 1
fi

info "Update repo Termux dan install dependency sistem (nodejs, ffmpeg, git, jq, termux-api)..."
yes | pkg update >/dev/null
yes | pkg upgrade >/dev/null
pkg install -y nodejs ffmpeg git jq termux-api termux-tools coreutils
ok "Dependency sistem terinstall."

info "Mengaktifkan akses ke storage internal HP (jika belum)..."
if [ ! -d "$HOME/storage" ]; then
    termux-setup-storage || warn "termux-setup-storage gagal otomatis. Buka Termux dan jalankan manual sekali."
fi

info "Install dependency Node.js (npm install)..."
npm install --no-fund --no-audit
ok "npm install selesai."

if [ ! -f "$ENV_FILE" ]; then
    info "Membuat .env contoh dengan default Android-friendly..."
    cat > "$ENV_FILE" <<EOF
PORT=$PORT
ADMIN_PIN=$ADMIN_PIN_DEFAULT
COMPRESS_CPU_PERCENT=25
COMPRESS_PRESET=fast
COMPRESS_NICENESS=15
# Telegram backup (opsional, isi kalau mau pakai backup ke Telegram):
# TELEGRAM_API_ID=
# TELEGRAM_API_HASH=
# TELEGRAM_SESSION=
# TELEGRAM_BACKUP_CHAT=
# TELEGRAM_USE_FORUM_TOPICS=true
EOF
    ok ".env baru dibuat di $ENV_FILE. Edit kalau perlu sebelum start."
else
    info ".env sudah ada, tidak ditimpa."
fi

# Install Termux:Boot autostart hook jika folder boot tersedia
BOOT_DIR="$HOME/.termux/boot"
mkdir -p "$BOOT_DIR"
BOOT_SCRIPT="$BOOT_DIR/start-webaff.sh"
info "Memasang script auto-start ke $BOOT_SCRIPT (butuh Termux:Boot dari F-Droid)."
cat > "$BOOT_SCRIPT" <<EOF
#!$PREFIX/bin/sh
termux-wake-lock
cd "$SCRIPT_DIR"
if [ -f .env ]; then
    set -a
    . ./.env
    set +a
fi
exec node server.js >> "$SCRIPT_DIR/data/server.log" 2>&1
EOF
chmod +x "$BOOT_SCRIPT"
ok "Auto-start script siap."

# Helper script: start, stop, status, logs
mkdir -p "$SCRIPT_DIR/scripts"
cat > "$SCRIPT_DIR/scripts/start.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
mkdir -p data
termux-wake-lock || true
if [ -f .env ]; then set -a; . ./.env; set +a; fi
exec node server.js
EOF
chmod +x "$SCRIPT_DIR/scripts/start.sh"

cat > "$SCRIPT_DIR/scripts/start-bg.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
cd "$HERE"
mkdir -p data
termux-wake-lock || true
if [ -f .env ]; then set -a; . ./.env; set +a; fi
nohup node server.js >> "$HERE/data/server.log" 2>&1 &
echo "$!" > "$HERE/data/server.pid"
echo "PID: $(cat "$HERE/data/server.pid")"
EOF
chmod +x "$SCRIPT_DIR/scripts/start-bg.sh"

cat > "$SCRIPT_DIR/scripts/stop.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/env bash
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$HERE/data/server.pid"
if [ -f "$PIDFILE" ]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
fi
pkill -f "node $HERE/server.js" 2>/dev/null || true
termux-wake-unlock || true
echo "Server dimatikan."
EOF
chmod +x "$SCRIPT_DIR/scripts/stop.sh"

cat > "$SCRIPT_DIR/scripts/status.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/env bash
HERE="$(cd "$(dirname "$0")/.." && pwd)"
PIDFILE="$HERE/data/server.pid"
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    echo "running pid $(cat "$PIDFILE")"
else
    PID="$(pgrep -f "node $HERE/server.js" | head -n 1 || true)"
    if [ -n "$PID" ]; then
        echo "running pid $PID"
    else
        echo "stopped"
    fi
fi
EOF
chmod +x "$SCRIPT_DIR/scripts/status.sh"

cat > "$SCRIPT_DIR/scripts/logs.sh" <<'EOF'
#!/data/data/com.termux/files/usr/bin/env bash
HERE="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$HERE/data/server.log"
if [ ! -f "$LOG" ]; then
    echo "Belum ada log."
    exit 0
fi
exec tail -n 200 -f "$LOG"
EOF
chmod +x "$SCRIPT_DIR/scripts/logs.sh"

ok "Helper scripts dibuat di $SCRIPT_DIR/scripts/ (start, start-bg, stop, status, logs)."

info "Cek versi tools..."
node -v || true
ffmpeg -version | head -n 1 || true

echo ""
ok "Setup Termux selesai."
echo ""
echo "Langkah berikutnya:"
echo "  1. Edit $ENV_FILE bila ingin ubah PORT, ADMIN_PIN, atau env Telegram."
echo "  2. Jalankan server foreground: bash scripts/start.sh"
echo "     Atau background:            bash scripts/start-bg.sh"
echo "  3. Cek status:                 bash scripts/status.sh"
echo "  4. Lihat log:                  bash scripts/logs.sh"
echo "  5. Matikan:                    bash scripts/stop.sh"
echo ""
echo "Auto-start saat HP boot: install Termux:Boot dari F-Droid, lalu buka satu kali."
echo "Script boot sudah ada di: $BOOT_SCRIPT"
echo ""
echo "Untuk akses publik aman tanpa buka port: install cloudflared (pkg install cloudflared)"
echo "lalu jalankan: cloudflared tunnel --url http://localhost:$PORT"
