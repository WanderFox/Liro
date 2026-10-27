#!/usr/bin/env bash
# Installs the Liro server as a systemd service on Linux.
#
#   sudo ./deploy/install.sh            # install or update
#   sudo ./deploy/install.sh --uninstall
#
# Layout:  /opt/liro (code), /var/lib/liro (boards + media), /etc/liro/liro.env (settings)
set -euo pipefail

PREFIX=/opt/liro
DATA=/var/lib/liro
CONF=/etc/liro
SRC="$(cd "$(dirname "$0")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Запустите с правами root: sudo $0" >&2
  exit 1
fi

if [[ "${1:-}" == "--uninstall" ]]; then
  systemctl disable --now liro 2>/dev/null || true
  rm -f /etc/systemd/system/liro.service
  systemctl daemon-reload
  rm -rf "$PREFIX"
  echo "Liro удалён. Данные досок остались в $DATA, настройки в $CONF."
  exit 0
fi

# --- Node.js ---------------------------------------------------------------
NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]] || (( $("$NODE_BIN" -p 'process.versions.node.split(".")[0]') < 18 )); then
  echo "Нужен Node.js >= 18."
  if command -v apt-get >/dev/null; then
    echo "Устанавливаю Node.js 22 из NodeSource…"
    apt-get update -y && apt-get install -y curl ca-certificates
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y nodejs
  elif command -v dnf >/dev/null; then
    dnf install -y nodejs npm
  else
    echo "Установите Node.js >= 18 вручную и запустите скрипт снова." >&2
    exit 1
  fi
  NODE_BIN="$(command -v node)"
fi
echo "Node.js: $("$NODE_BIN" -v) ($NODE_BIN)"

# --- user, files -----------------------------------------------------------
id liro >/dev/null 2>&1 || useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin liro
mkdir -p "$PREFIX" "$DATA" "$CONF"
rm -rf "$PREFIX/server" "$PREFIX/web"
cp -r "$SRC/server" "$PREFIX/server"
cp -r "$SRC/web" "$PREFIX/web"
rm -rf "$PREFIX/server/node_modules" "$PREFIX/server/data" "$PREFIX/server/test"
(cd "$PREFIX/server" && npm install --omit=dev --no-fund --no-audit)
chown -R liro:liro "$DATA"

if [[ ! -f "$CONF/liro.env" ]]; then
  cp "$SRC/deploy/liro.env" "$CONF/liro.env"
  echo "Создан $CONF/liro.env — отредактируйте при необходимости."
fi

# --- service ---------------------------------------------------------------
sed "s#@NODE@#$NODE_BIN#g" "$SRC/deploy/liro.service" > /etc/systemd/system/liro.service
systemctl daemon-reload
systemctl enable liro >/dev/null
systemctl restart liro

# --- firewall --------------------------------------------------------------
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  ufw allow 1919/tcp comment 'Liro HTTP' >/dev/null
  ufw allow 1919/udp comment 'Liro discovery' >/dev/null
  ufw allow 5353/udp comment 'mDNS' >/dev/null
  ufw allow 80/tcp comment 'Liro HTTP (port 80)' >/dev/null
  ufw allow 53/udp comment 'Liro DNS (liro.loc)' >/dev/null
  echo "Правила ufw добавлены."
elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
  for p in 1919/tcp 1919/udp 5353/udp 80/tcp 53/udp; do firewall-cmd --permanent --add-port=$p >/dev/null; done
  firewall-cmd --reload >/dev/null
  echo "Правила firewalld добавлены."
fi

sleep 1
systemctl --no-pager --lines=0 status liro || true
echo
echo "Liro запущен. Адреса:"
for ip in $(hostname -I); do
  [[ "$ip" == *:* ]] || echo "  http://$ip:1919"
done
echo "  http://liro.loc:1919  (если DNS настроен — см. README)"
echo "Логи: journalctl -u liro -f"
