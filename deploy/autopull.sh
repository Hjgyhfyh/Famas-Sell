#!/usr/bin/env bash
# Famas Store — авто-обновление из GitHub (для правок коллег).
# Каждый запуск: тянет origin/main; если появились новые коммиты —
# обновляет зависимости (при изменении lock), синтакс-проверяет ВСЕ js,
# и только при успешной проверке перезапускает сервис. При ошибке — откат, прод не трогается.
set -euo pipefail

APP_DIR="/home/ubuntuuser/famas-shop"
BRANCH="main"
SERVICE="famas-shop"
LOG="$APP_DIR/data/autopull.log"

cd "$APP_DIR"
mkdir -p "$APP_DIR/data"
log(){ echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" >> "$LOG"; }

export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/famas_deploy -o IdentitiesOnly=yes"

git fetch --quiet origin "$BRANCH" || { log "fetch FAILED"; exit 0; }

LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "origin/$BRANCH")
[ "$LOCAL" = "$REMOTE" ] && exit 0   # нечего катить

log "новые коммиты $LOCAL -> $REMOTE, обновляюсь"
LOCK_BEFORE=$(git hash-object package-lock.json 2>/dev/null || echo none)

# рабочее дерево может содержать локальные правки (.env защищён .gitignore) — жёстко на remote
git reset --hard "origin/$BRANCH" --quiet

LOCK_AFTER=$(git hash-object package-lock.json 2>/dev/null || echo none)
if [ "$LOCK_BEFORE" != "$LOCK_AFTER" ]; then
  log "package-lock изменился — npm install"
  npm install --omit=dev >> "$LOG" 2>&1 || { log "npm install FAILED — откат на $LOCAL"; git reset --hard "$LOCAL" --quiet; exit 0; }
fi

# синтакс-проверка всех js — гейт перед рестартом
CHECK_OK=1
for f in index.js src/*.js scripts/*.js public/app/app.js; do
  [ -f "$f" ] || continue
  node --check "$f" 2>>"$LOG" || { log "node --check FAILED: $f"; CHECK_OK=0; break; }
done
if [ "$CHECK_OK" != "1" ]; then
  log "проверка не прошла — откат на $LOCAL, прод не трогаю"
  git reset --hard "$LOCAL" --quiet
  exit 0
fi

sudo systemctl restart "$SERVICE"
sleep 2
if curl -fsS --max-time 8 http://127.0.0.1:4488/famas/health >/dev/null 2>&1; then
  log "деплой ОК, сервис жив ($REMOTE)"
else
  log "health не ответил после рестарта ($REMOTE) — проверь journalctl -u $SERVICE"
fi
