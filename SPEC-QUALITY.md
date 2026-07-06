# SPEC-QUALITY — фильтр качества серверов (продаём только рабочие)

Проблема: публичный источник содержит мусор — регионы, где все серверы на нестабильных free-хостингах
(*.railway.app и т.п.) или просто мёртвые. Клиенты покупают → «не грузит». Решение: помечать «живость»
каждого сервера и продавать/выдавать ТОЛЬКО живые. Только совместимые добавления; цены/маршруты/схему
заказов не менять. Русский.

## 1. Конфиг (config.js + .env.example)

- `HOST_BLACKLIST` — список подстрок доменов, которые считаем заведомо ненадёжными (free-хостинги,
  туннели). Дефолт (через запятую, env `HOST_BLACKLIST` может переопределить):
  `up.railway.app, railway.app, onrender.com, render.com, herokuapp.com, glitch.me, repl.co,
  replit.dev, trycloudflare.com, ngrok.io, ngrok-free.app, serveo.net, localhost.run, loca.lt,
  cfargotunnel.com, workers.dev, pagekite.me, telebit.io`. Экспортировать как массив строк (lowercase).
- `HEALTHCHECK_ENABLED` (env, дефолт `1`) — включает TCP-проверку живости.
- `HEALTHCHECK_TIMEOUT_MS` (дефолт `4000`), `HEALTHCHECK_CONCURRENCY` (дефолт `24`).

## 2. Схема (миграция в db.init, идемпотентно)

- `ALTER TABLE configs ADD COLUMN alive INTEGER DEFAULT 1` (columnExists-guard). `alive=1` — сервер
  прошёл фильтр (не в блэклисте и доступен); `alive=0` — мусор/недоступен. Новые конфиги — alive=1
  до первой проверки (чтобы не пропадали мгновенно).

## 3. db.js — фильтрация по alive (везде, где выбираются продаваемые/выдаваемые конфиги)

«Продаваемый/выдаваемый» сервер = `active=1 AND alive=1`. Изменить ТОЛЬКО выборки (не логику заказов):
- `regionsSummary()` — count и наличие региона считать по `active=1 AND alive=1` (регион с 0 живых
  серверов НЕ показывается/не продаётся).
- `configsForRegions(isos)`, `configsForRegionsQty(qtyMap)` — брать `active=1 AND alive=1`.
- `fallbackForRegions` — по-прежнему на случай, когда живых нет (deep fallback), но приоритет — живым.
- Новые экспорты для healthcheck:
  - `hostsToCheck()` -> уникальные `{host, port}` среди `active=1` конфигов (для проверки).
  - `setAliveByHostPort(host, port, alive)` -> обновить `alive` всем конфигам с этим host:port.
  - `setAliveByHostPattern(pattern, alive)` -> `alive=0` всем, где host LIKE %pattern% (для блэклиста).
  - `aliveStats()` -> `{active, alive, deadBlacklist, deadUnreachable}` (для логов/админа).
- `upsertConfigs`: при появлении/оживлении конфига alive НЕ сбрасывать в 1 принудительно, если он уже
  0 из-за блэклиста host — но проще: новые строки alive=1, healthcheck сам расставит. Достаточно, чтобы
  ALTER задавал DEFAULT 1 и upsert новых давал 1.

## 4. inventory.js — прогон здоровья после каждого refresh

После `upsertConfigs`:
1. **Блэклист** (быстро, синхронно): для каждого паттерна `HOST_BLACKLIST` → `db.setAliveByHostPattern(p, 0)`.
2. **TCP-живость** (если `HEALTHCHECK_ENABLED`): взять `db.hostsToCheck()` (исключив уже
   заблэклисченные), проверять пулом (`HEALTHCHECK_CONCURRENCY`) через `net.connect({host,port})` с
   таймаутом `HEALTHCHECK_TIMEOUT_MS`: успешное TCP-соединение → alive=1, иначе alive=0
   (`db.setAliveByHostPort`). Резолв домена — ок (net сам резолвит).
   - **Сейфгард**: если доля недоступных > 85% от проверенных (вероятный сетевой сбой на VDS/резолвере),
     НЕ применять TCP-результаты этого прогона (оставить прежний alive), только блэклист. Залогировать.
   - Не блокировать event loop надолго: проверка асинхронная, ошибки глотать, процесс не ронять.
3. `logEvent('healthcheck', db.aliveStats())`; обновить `lastRefresh` (добавить в него `alive` число).
4. Первый прогон — при старте (в refreshNow). Периодичность — вместе с refresh (каждые FETCH_INTERVAL_MIN).

## 5. Бот/сервер/выдача

- Ничего в контрактах не меняем: т.к. db-выборки теперь фильтруют `alive=1`, магазин (bot /vpn, mini app
  /api/regions), расчёт цены (quoteOrder/reserveOrder по available=живые), выдача (buildSub через
  configsForRegionsQty) — автоматически показывают/продают/выдают только живые серверы.
- Уже выданные подписки (живые ссылки) при следующем запросе автоматически подтянут только живые сервера
  региона — т.е. у пожаловавшихся NL/SK ключ сам починится, ЕСЛИ в регионе есть живые; если живых нет —
  регион исчезнет (и это честно: не продаём то, что не работает).
- `/admin`: в статистику добавить строку «живых серверов: A из B» (aliveStats) — по возможности.

## 6. Тесты (E2E-агент)

1. node --check config/db/inventory/subscription; selftest зелёный; миграция `alive` идемпотентна,
   старую БД не ломает.
2. Блэклист: засеять конфиг с host `x.up.railway.app` (active=1, alive=1) → после
   setAliveByHostPattern('up.railway.app',0) он alive=0 и НЕ попадает в regionsSummary/configsForRegionsQty.
3. TCP-живость (замок net.connect на детерминированный стаб ИЛИ реальный локальный порт): доступный
   host:port → alive=1; недоступный (закрытый порт, таймаут) → alive=0. Сейфгард: если >85% «мертвы» —
   alive не меняется.
4. Регион, где все серверы в блэклисте → исчезает из regionsSummary (count 0) и не продаётся
   (reserveOrder на него → ошибка «нет доступных серверов»/недоступен).
5. Регион с частью живых → продаётся, configsForRegionsQty отдаёт только живые, ровно qty.
6. selftest/parse-check не сломаны; buildSub старого заказа отдаёт живые. Убрать тестовые БД.

## 7. Приёмка

- Мусорные free-хостинги (railway и т.п.) и недоступные серверы не продаются и не выдаются.
- Регион без живых серверов пропадает из каталога. Клиентские подписки самочинятся к живым.
- Ни оплата, ни выдача, ни существующие тесты не сломаны; сетевой сбой не обнуляет каталог (сейфгард).
