# FAMAS STORE ⁂

Telegram-магазин VLESS-ключей: бот **@FamasSellerBot** + mini app. Оплата — Telegram Stars (XTR).
Прод: **https://telepasta.ru/famas** → nginx проксирует `/famas/` на `127.0.0.1:4488` (systemd-сервис `famas-shop`).
Полный контракт проекта — в [SPEC.md](SPEC.md).

## Первый запуск на сервере

```bash
# код лежит в /home/ubuntuuser/famas-shop
cd /home/ubuntuuser/famas-shop
cp .env.example .env        # заполнить BOT_TOKEN (остальное можно не трогать)
bash deploy/deploy.sh
```

`deploy.sh` идемпотентный: ставит зависимости, systemd-unit, nginx-сниппет, подключает
`include famas-locations.conf` в `/etc/nginx/sites-enabled/telepasta` (после якоря sig-stats,
во все server-блоки), проверяет `nginx -t`, перезагружает nginx и перезапускает сервис.
Гонять можно сколько угодно раз.

## Задеплоить обновление

```bash
cd /home/ubuntuuser/famas-shop
git pull                    # или залить код rsync/scp
bash deploy/deploy.sh
```

## Логи и статус

```bash
journalctl -u famas-shop -f                  # живые логи
journalctl -u famas-shop -n 100 --no-pager   # последние 100 строк
systemctl status famas-shop                  # статус сервиса
curl -s http://127.0.0.1:4488/famas/health   # health: аптайм + последнее обновление базы
```

Управление: `sudo systemctl restart|stop|start famas-shop`.

## .env — главное

| Ключ | Что это |
|---|---|
| `BOT_TOKEN` | токен бота — **обязателен** |
| `ADMIN_IDS` | id админов через запятую (927937870) |
| `PORT` | 4488 — не менять без правки nginx-сниппета |
| `PUBLIC_BASE` | `https://telepasta.ru/famas` — без хвостового `/` |
| `SOURCE_URL` | источник конфигов; `file:путь` — локальный файл для тестов |
| `FETCH_INTERVAL_MIN` | период обновления базы конфигов (мин) |
| `DEFAULT_PRICE_STARS` / `DEFAULT_SUB_DAYS` | только значения по умолчанию; рабочие цена и срок задаются через `/admin` и хранятся в БД |
| `SKIP_BOT` | `1` — поднять только HTTP без бота (локальная проверка) |

## Цена, срок, выдача — через бота

`/admin` в боте (только для ADMIN_IDS):

- **Обновить базу** — форс-обновление списка конфигов из источника;
- **Цена: N** — новая цена за 1 регион в звёздах (ответом на сообщение бота);
- **Срок: N дн** — срок действия подписки;
- **Рассылка** — текст → превью → отправка всем пользователям;
- **Последние заказы** — 10 последних;
- **Выдать ключ** — ответом в формате `<user_id> <DE,NL|all> [дней]`.

`/refund <order_id>` — возврат звёзд по заказу (только админ).

Ручная выдача с сервера: `node scripts/gift.js <tgId> <DE,NL|all> [days]` — напечатает ссылки ключа.

## Локальная проверка (без прода)

```bash
npm install
node scripts/parse-check.js     # парсер источника на fixtures
node scripts/selftest.js        # полный self-test (db + inventory + subscription)
SKIP_BOT=1 node index.js        # только HTTP на 4488: /famas/api/regions, /famas/health
```

## Данные и бэкап

- БД: `data/famas.db` (SQLite WAL, рядом `-wal`/`-shm`).
- Живой бэкап: `sqlite3 data/famas.db ".backup /home/ubuntuuser/famas-backup.db"`.

## Файлы деплоя

| Файл | Куда встаёт |
|---|---|
| `deploy/famas-shop.service` | `/etc/systemd/system/famas-shop.service` |
| `deploy/famas-locations.conf` | `/etc/nginx/snippets/famas-locations.conf` |
| `deploy/deploy.sh` | запускается из корня: `bash deploy/deploy.sh` |

Правишь `deploy.sh` на Windows — следи, чтобы остались LF-переводы строк.
