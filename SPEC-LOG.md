# SPEC-LOG — логи продаж в канал + живая статистика

Дополнение к SPEC*. Бот пишет в приватный канал продаж: одно ЗАКРЕПЛЁННОЕ сообщение-статистику
(обновляется при каждой продаже) + на каждую покупку отдельное сообщение, которое самоудаляется
через N минут. Только совместимые добавления; существующие маршруты/схема/цены не трогать. Русский.

## 1. Конфиг

- `config.js` + `.env.example`: `SALES_CHANNEL_ID` (env, дефолт `-1004297326871`),
  `SALE_LOG_TTL_MIN` (env, дефолт `5`). Если `SALES_CHANNEL_ID` пуст/`0` — логирование ОТКЛЮЧЕНО
  (все функции saleslog становятся no-op, бот работает как раньше).
- Бот уже админ канала (post/edit/delete/pin). Все вызовы к каналу — в try/catch, ошибки только
  в консоль, НИКОГДА не ронять бота/оплату/выдачу.

## 2. Новый модуль src/saleslog.js  (require ./config, ./db, ./util)

```js
module.exports = { ensureStats, updateStats, logSale, enabled }
enabled() -> bool                       // SALES_CHANNEL_ID задан
async ensureStats(api)                  // гарантировать закреплённое сообщение статистики (см. §3)
async updateStats(api)                  // отредактировать сообщение статистики актуальными числами
async logSale(api, order, kind)         // kind: 'paid' | 'free' — пост о покупке + план удаления + updateStats
```
`order` — строка заказа из БД (поля id, user_id, regions, qty, stars, expires_at, status).
Все функции при `!enabled()` — немедленный return. Все — устойчивы к ошибкам сети/Telegram.

## 3. Сообщение статистики (одно, закреплённое, обновляемое)

- id хранится в settings ключ `stats_msg_id` (db.getSetting/setSetting).
- `ensureStats(api)`: если `stats_msg_id` есть — попытаться `updateStats` (editMessageText); при ошибке
  «message to edit not found»/«message can't be edited» — создать заново. Если id нет — создать:
  `api.sendMessage(SALES_CHANNEL_ID, formatStats(), {parse_mode:'HTML', disable_web_page_preview:true})`,
  сохранить message_id в settings, затем `api.pinChatMessage(SALES_CHANNEL_ID, id, {disable_notification:true})`
  (ошибку пина глотать). Вызывать один раз при старте бота (из index.js после запуска polling,
  fire-and-forget). Не плодить дубликаты при рестартах.
- `formatStats()` (HTML, ЧБ-стиль, из `db.statsSummary()` + уникальные покупатели):
  ```
  📊 <b>FAMAS STORE — статистика</b>
  ━━━━━━━━━━━━━━━━━━━
  💰 Продаж: <b>N</b>
  ⭐ Выручка: <b>X</b> ⭐
  📈 Сегодня: <b>M</b>
  👥 Покупателей: <b>U</b>
  🌍 Стран в базе: <b>R</b> · серверов: <b>S</b>
  🕒 обновлено HH:MM МСК
  ```
  N=ordersPaid, X=revenueStars, M=salesToday, R=regionsCount, S=activeConfigs (из statsSummary);
  U=уникальные user_id среди заказов status IN('paid','gift') (лёгкий запрос через db.db; НЕ менять
  statsSummary — можно добавить туда uniqueBuyers аддитивно ИЛИ считать в saleslog). Время — Москва
  (util.fmtDateTime/аналог). Экранировать через util.esc где нужно.
- `updateStats(api)`: `api.editMessageText(SALES_CHANNEL_ID, stats_msg_id, undefined, formatStats(),
  {...})`; при «message not found» → пересоздать (ensureStats-путь); «message is not modified» — глотать.

## 4. Сообщение о покупке (самоудаляемое)

`logSale(api, order, kind)`:
- собрать строку регионов с количеством: из `order.qty` (JSON `{iso:count}`) →
  `🇩🇪 Германия ×2 · 🇳🇱 Нидерланды ×1` (флаг `util.isoToFlag`, имя `util.nameRuOf`, `×count`);
  если `qty` пуст (старый заказ) — из `order.regions` без `×N`.
- servers = Σqty (или число регионов для старых), days = round((expires_at - paid/created)/86400) либо
  из subDays; бери разумно (можно `db.subDays()` если точного нет).
- текст:
  - `kind==='paid'` (stars>0):
    ```
    💰 <b>Новая покупка</b> · +<X> ⭐
    🌍 <регионы ×qty>
    📦 <S> серв. · <days> дней
    🧾 заказ #<id>
    ```
  - `kind==='free'` (stars==0):
    ```
    🎁 <b>Выдача по промо</b> · бесплатно
    🌍 <регионы ×qty>
    📦 <S> серв. · <days> дней
    🧾 заказ #<id>
    ```
- отправить `api.sendMessage(SALES_CHANNEL_ID, text, {parse_mode:'HTML', disable_web_page_preview:true})`;
- запланировать удаление: `setTimeout(()=>api.deleteMessage(SALES_CHANNEL_ID, msg.message_id).catch(()=>{}),
  SALE_LOG_TTL_MIN*60000)` (таймер `.unref?.()` чтобы не держать процесс). Переживание рестарта НЕ
  требуется (edge: при рестарте в течение TTL сообщение может остаться — приемлемо).
- затем `await updateStats(api)` (обновить закреплённую статистику).

## 5. Провод (вызов logSale ровно на РЕАЛЬНЫЕ покупки юзера)

- `src/bot.js` `message:successful_payment` — ПОСЛЕ markOrderPaid, ВНУТРИ `if(wasPending)`
  (идемпотентно к дубль-апдейту): `saleslog.logSale(ctx.api, order, 'paid')` (order с обновлённым
  статусом/stars). Обернуть в try/catch (или .catch) — не ломать выдачу.
- `src/bot.js` fully-free ветка `cb pay` (юзер получил бесплатно по free-регионам):
  `saleslog.logSale(ctx.api, order, 'free')`.
- `src/server.js` fully-free ветка `POST /api/order` (юзер получил бесплатно через mini app):
  `saleslog.logSale(botApi, order, 'free')` (botApi уже есть в createServer).
- НЕ логировать: ручные gift через `/admin`/`gift.js`, повторные показы ключа (sendDelivery для
  /profile, key:<id>) — только первичные покупки юзером.
- `index.js`: после старта бота — `saleslog.ensureStats(bot.api).catch(()=>{})` (fire-and-forget,
  когда bot.api готов; при необходимости `await bot.init()` перед этим).

## 6. Тесты (E2E-агент — БЕЗ реальной отправки в канал)

1. node --check saleslog/bot/server/config/index; selftest зелёный.
2. Стаб `api` (объект с sendMessage/editMessageText/deleteMessage/pinChatMessage, записывающими вызовы):
   - `ensureStats`: при пустом settings — sendMessage + pin + сохранён stats_msg_id; повторный
     `ensureStats` — НЕ шлёт новое (editMessageText существующего). 
   - `logSale(api, paidOrder, 'paid')` с qty `{DE:2,NL:1}` → sendMessage содержит «Новая покупка»,
     «+50 ⭐», «🇩🇪 Германия ×2», «🇳🇱 Нидерланды ×1», «3 серв.»; запланирован deleteMessage
     (проверить, что через фейковый таймер/прямой вызов удаляет тот message_id); затем editMessageText
     статистики вызван.
   - `logSale(api, freeOrder, 'free')` → «Выдача по промо · бесплатно».
   - `enabled()===false` при пустом SALES_CHANNEL_ID → все функции no-op (ноль вызовов api).
   - Ошибка api (throw) внутри logSale не пробрасывается наружу (покупка/выдача не падает).
3. Формат статистики отражает statsSummary (создать пару gift/paid заказов, проверить N/выручку).
4. Убрать тестовые БД. JSON-отчёт.

## 7b. TTL 60 мин + ПЕРСИСТЕНТНОЕ удаление (переживает рестарт) — ОБЯЗАТЕЛЬНО

`SALE_LOG_TTL_MIN` дефолт = **60** (config.js + .env.example; `ttlMinutes()` фолбэк тоже 60).
За час бот может рестартнуться (деплой/автопул) — `setTimeout` не переживёт, сообщение зависнет
навсегда. Поэтому удаление — через персистентный свипер:
- db.js (миграция, идемпотентно): `CREATE TABLE IF NOT EXISTS sale_log_msgs(message_id INTEGER
  PRIMARY KEY, chat_id TEXT, delete_at INTEGER)`. Экспорты: `addSaleMsg(messageId, chatId, deleteAt)`,
  `dueSaleMsgs(nowSec) -> rows (delete_at<=now)`, `removeSaleMsg(messageId)`. Всё в try/catch.
- saleslog.js `logSale`: вместо `setTimeout` — `db.addSaleMsg(msgId, String(chat), nowSec + ttl*60)`
  (nowSec = Math.floor(Date.now()/1000)). Никаких per-message setTimeout.
- saleslog.js новый экспорт `startSweeper(api)`: (1) один немедленный `sweep(api)`; (2)
  `setInterval(()=>sweep(api), 60000)` с `.unref()`; хранить ссылку, не запускать интервал повторно.
  `sweep(api)`: для каждой `db.dueSaleMsgs(now)` — `api.deleteMessage(chatId, message_id)`;
  при успехе ИЛИ ошибке «message to delete not found»/«message not found» → `db.removeSaleMsg(id)`
  (просроченное убираем из очереди в любом случае, чтобы не копилось); прочие ошибки — оставить на
  следующий тик, залогировать. Всё в try/catch, наружу не бросать, при !enabled() — no-op.
- index.js: рядом с `ensureStats(bot.api)` вызвать `saleslog.startSweeper(bot.api)` (fire-and-forget).
- Тест выживания рестарта: записать sale-сообщение (addSaleMsg с delete_at в прошлом или近), НЕ
  вызывать таймер, эмулировать «рестарт» (новый вызов startSweeper с тем же файлом БД) → просроченное
  сообщение удаляется свипером; будущее (delete_at>now) — остаётся до срока. Идемпотентность
  повторного sweep (уже удалённое не удаляется дважды и вычищено из БД).

## 7. Приёмка

- В канале одно закреплённое сообщение-статистика, обновляется при каждой продаже.
- Каждая покупка юзера → отдельное сообщение «💰 Новая покупка на X ⭐ · регионы ×qty», удаляется
  через SALE_LOG_TTL_MIN минут.
- Ручные админ-выдачи и повторные показы ключа НЕ засоряют канал.
- Любая ошибка канала не влияет на оплату/выдачу. Пустой SALES_CHANNEL_ID = фича выключена.
