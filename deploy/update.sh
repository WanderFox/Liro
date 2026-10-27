#!/usr/bin/env bash
# Updates an installed Liro server (Linux) to the version this script is part of.
# Boards, settings (/etc/liro/liro.env) and the systemd service are kept.
#
#   sudo bash deploy/update.sh
set -euo pipefail

PREFIX=/opt/liro
SRC="$(cd "$(dirname "$0")/.." && pwd)"

if [[ $EUID -ne 0 ]]; then
  echo "Запустите с правами root: sudo bash $0" >&2
  exit 1
fi
if [[ ! -d "$PREFIX/server" ]] || ! systemctl cat liro >/dev/null 2>&1; then
  echo "Liro не установлен. Используйте deploy/install.sh" >&2
  exit 1
fi

echo "Останавливаю сервер…"
systemctl stop liro

echo "Обновляю $PREFIX…"
rm -rf "$PREFIX/server.new" "$PREFIX/web.new"
cp -r "$SRC/server" "$PREFIX/server.new"
cp -r "$SRC/web" "$PREFIX/web.new"
rm -rf "$PREFIX/server.new/node_modules" "$PREFIX/server.new/data" "$PREFIX/server.new/test"
(cd "$PREFIX/server.new" && npm install --omit=dev --no-fund --no-audit)
rm -rf "$PREFIX/server.old" "$PREFIX/web.old"
mv "$PREFIX/server" "$PREFIX/server.old"
mv "$PREFIX/web" "$PREFIX/web.old"
mv "$PREFIX/server.new" "$PREFIX/server"
mv "$PREFIX/web.new" "$PREFIX/web"

systemctl start liro
sleep 2
port=$(grep -E '^\s*LIRO_PORT=' /etc/liro/liro.env 2>/dev/null | tail -1 | cut -d= -f2 | tr -d ' "')
if curl -fsS "http://127.0.0.1:${port:-1919}/api/info" >/dev/null 2>&1; then
  rm -rf "$PREFIX/server.old" "$PREFIX/web.old"
  echo "Готово: сервер обновлён и работает."
else
  echo "Сервер не отвечает после обновления — возвращаю предыдущую версию." >&2
  systemctl stop liro
  rm -rf "$PREFIX/server" "$PREFIX/web"
  mv "$PREFIX/server.old" "$PREFIX/server"
  mv "$PREFIX/web.old" "$PREFIX/web"
  systemctl start liro
  echo "Журнал: journalctl -u liro -n 50" >&2
  exit 1
fi
