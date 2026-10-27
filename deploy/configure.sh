#!/usr/bin/env bash
# Changes Liro server settings (Linux). For now: moves the board storage to another folder.
#
#   sudo bash deploy/configure.sh --data /mnt/storage/liro
#
# The server is stopped, all boards/media/stickers/fonts are moved to the new folder, the settings file and
# the service sandbox (ReadWritePaths) are updated, and the server is started with the new path.
set -euo pipefail

ENV_FILE=/etc/liro/liro.env
NEW=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --data) NEW="$2"; shift 2 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) echo "Неизвестный параметр: $1" >&2; exit 1 ;;
  esac
done

if [[ $EUID -ne 0 ]]; then
  echo "Запустите с правами root: sudo bash $0 --data /новый/путь" >&2
  exit 1
fi
if [[ -z "$NEW" ]]; then
  echo "Укажите новую папку: --data /путь" >&2
  exit 1
fi

OLD=$(grep -E '^\s*LIRO_DATA=' "$ENV_FILE" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"' || true)
OLD=${OLD:-/var/lib/liro}
mkdir -p "$NEW"
NEW=$(realpath "$NEW")
OLD=$(realpath -m "$OLD")
if [[ "$NEW" == "$OLD" ]]; then
  echo "Хранилище уже находится в $NEW"
  exit 0
fi
case "$NEW/" in "$OLD"/*) echo "Новая папка не может быть внутри старой." >&2; exit 1 ;; esac

echo "Останавливаю сервер…"
systemctl stop liro

if [[ -d "$OLD" ]]; then
  echo "Переношу хранилище: $OLD -> $NEW"
  if command -v rsync >/dev/null; then
    rsync -a "$OLD"/ "$NEW"/
  else
    cp -a "$OLD"/. "$NEW"/
  fi
  # Remove the old copy only after a successful copy.
  rm -rf "$OLD"
fi
chown -R liro:liro "$NEW"

if grep -qE '^\s*LIRO_DATA=' "$ENV_FILE"; then
  sed -i -E "s|^\s*LIRO_DATA=.*|LIRO_DATA=$NEW|" "$ENV_FILE"
else
  echo "LIRO_DATA=$NEW" >> "$ENV_FILE"
fi

# The service may only write to its data folder: replace the allowed path (the empty line resets the
# list from the main unit, whose /var/lib/liro no longer exists after the move).
mkdir -p /etc/systemd/system/liro.service.d
cat > /etc/systemd/system/liro.service.d/data.conf <<EOF
[Service]
ReadWritePaths=
ReadWritePaths=$NEW
EOF
systemctl daemon-reload
systemctl start liro
sleep 2
systemctl --no-pager --lines=5 status liro || true
echo "Готово: хранилище теперь в $NEW"
