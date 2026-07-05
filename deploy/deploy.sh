#!/usr/bin/env bash
#
# FAMAS STORE — деплой на прод-сервер (Ubuntu, systemd + nginx).
# Идемпотентный: можно гонять сколько угодно раз.
#
# Запуск на сервере:
#   cd /home/ubuntuuser/famas-shop && bash deploy/deploy.sh
#
# Что делает:
#   1) npm install --omit=dev
#   2) ставит systemd-unit  -> /etc/systemd/system/famas-shop.service
#   3) ставит nginx-сниппет -> /etc/nginx/snippets/famas-locations.conf
#   4) добавляет include famas-locations.conf во ВСЕ server-блоки
#      /etc/nginx/sites-enabled/telepasta после якоря sig-stats (если ещё нет)
#   5) nginx -t + reload nginx
#   6) daemon-reload + enable + restart famas-shop
#   7) статус и проверка /famas/health
#
set -euo pipefail

# ── Константы ────────────────────────────────────────────────────────────────
SERVICE_NAME="famas-shop"
UNIT_DST="/etc/systemd/system/${SERVICE_NAME}.service"
SNIPPET_DST="/etc/nginx/snippets/famas-locations.conf"
SITE_FILE="/etc/nginx/sites-enabled/telepasta"
ANCHOR='include /etc/nginx/snippets/sig-stats-locations.conf;'
FAMAS_INCLUDE='include /etc/nginx/snippets/famas-locations.conf;'
HEALTH_URL="http://127.0.0.1:4488/famas/health"

log()  { echo "[deploy] $*"; }
warn() { echo "[deploy][ВНИМАНИЕ] $*" >&2; }
die()  { echo "[deploy][ОШИБКА] $*" >&2; exit 1; }

# sudo не нужен, если уже root
SUDO="sudo"
if [ "$(id -u)" -eq 0 ]; then SUDO=""; fi

# ── 0. Корень проекта и проверки окружения ──────────────────────────────────
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
log "корень проекта: $ROOT_DIR"

[ -f index.js ]                    || die "index.js не найден — запускай из корня famas-shop"
[ -f deploy/famas-shop.service ]   || die "deploy/famas-shop.service не найден"
[ -f deploy/famas-locations.conf ] || die "deploy/famas-locations.conf не найден"
command -v node  >/dev/null 2>&1   || die "node не найден (нужен Node 18+)"
command -v npm   >/dev/null 2>&1   || die "npm не найден"
command -v nginx >/dev/null 2>&1   || die "nginx не найден"

NODE_MAJOR="$(node -e 'console.log(process.versions.node.split(".")[0])')"
[ "$NODE_MAJOR" -ge 18 ] || die "нужен Node >= 18, сейчас: $(node -v)"
[ -x /usr/bin/node ] || warn "нет /usr/bin/node, а unit использует именно его — сделай симлинк: sudo ln -s \"\$(command -v node)\" /usr/bin/node"

if [ ! -f .env ]; then
  die "нет .env — скопируй .env.example в .env, заполни BOT_TOKEN и запусти деплой снова"
fi

# ── 1. Зависимости ───────────────────────────────────────────────────────────
log "npm install --omit=dev ..."
npm install --omit=dev --no-audit --no-fund

# ── 2. systemd unit ──────────────────────────────────────────────────────────
log "ставлю unit: $UNIT_DST"
$SUDO install -m 644 deploy/famas-shop.service "$UNIT_DST"

# ── 3. nginx-сниппет ─────────────────────────────────────────────────────────
log "ставлю nginx-сниппет: $SNIPPET_DST"
$SUDO install -D -m 644 deploy/famas-locations.conf "$SNIPPET_DST"

# ── 4. include в сайт telepasta (после якоря, во все server-блоки) ───────────
PATCHED=0
BACKUP=""
SITE_REAL=""
if [ ! -e "$SITE_FILE" ]; then
  warn "$SITE_FILE не найден — правку сайта пропускаю; добавь вручную: $FAMAS_INCLUDE"
else
  # sites-enabled обычно симлинк на sites-available — правим оригинал, симлинк не ломаем
  SITE_REAL="$($SUDO readlink -f "$SITE_FILE")"
  if $SUDO grep -qF "famas-locations.conf" "$SITE_REAL"; then
    log "include уже подключён в $SITE_REAL — пропускаю"
  elif ! $SUDO grep -qF "$ANCHOR" "$SITE_REAL"; then
    warn "якорь «$ANCHOR» не найден в $SITE_REAL — добавь include вручную в нужные server-блоки"
  else
    BACKUP="${SITE_REAL}.bak.famas.$(date +%Y%m%d%H%M%S)"
    $SUDO cp "$SITE_REAL" "$BACKUP"
    log "бэкап сайта: $BACKUP"
    # после КАЖДОЙ строки-якоря вставляем наш include с тем же отступом
    $SUDO sed -i \
      's#^\([[:space:]]*\)include /etc/nginx/snippets/sig-stats-locations\.conf;#\1include /etc/nginx/snippets/sig-stats-locations.conf;\n\1include /etc/nginx/snippets/famas-locations.conf;#' \
      "$SITE_REAL"
    PATCHED=1
    ANCHORS_N="$($SUDO grep -cF "$ANCHOR" "$SITE_REAL" || true)"
    FAMAS_N="$($SUDO grep -cF "$FAMAS_INCLUDE" "$SITE_REAL" || true)"
    log "include добавлен: якорей в файле — $ANCHORS_N, famas-include — $FAMAS_N"
  fi
fi

# ── 5. Проверка конфига nginx и reload ───────────────────────────────────────
if ! $SUDO nginx -t; then
  if [ "$PATCHED" -eq 1 ] && [ -n "$BACKUP" ]; then
    warn "nginx -t провалился — откатываю правку $SITE_REAL из бэкапа"
    $SUDO cp "$BACKUP" "$SITE_REAL"
  fi
  die "конфиг nginx не прошёл проверку (nginx -t), деплой остановлен"
fi
log "nginx -t: ОК — перезагружаю nginx"
$SUDO systemctl reload nginx

# ── 6. Сервис ────────────────────────────────────────────────────────────────
log "systemd: daemon-reload + enable + restart $SERVICE_NAME"
$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SERVICE_NAME"
$SUDO systemctl restart "$SERVICE_NAME"

# ── 7. Статус и health ───────────────────────────────────────────────────────
$SUDO systemctl --no-pager --full status "$SERVICE_NAME" || true

if command -v curl >/dev/null 2>&1; then
  HEALTH_OK=0
  for _try in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 5 "$HEALTH_URL" >/dev/null 2>&1; then HEALTH_OK=1; break; fi
    sleep 1
  done
  if [ "$HEALTH_OK" -eq 1 ]; then
    log "health: ОК → $HEALTH_URL"
    log "готово ⁂ https://telepasta.ru/famas/app/"
  else
    warn "health не ответил за 10 секунд — смотри логи: journalctl -u $SERVICE_NAME -n 50 --no-pager"
    exit 1
  fi
else
  warn "curl не найден — health-проверку пропускаю; проверь вручную: $HEALTH_URL"
fi
