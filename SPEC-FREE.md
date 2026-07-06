# SPEC-FREE — бесплатные регионы (скидка) + команда /free

Дополнение к SPEC.md / SPEC-V2.md. Добавляет админскую раздачу бесплатных регионов.
Только ДОБАВЛЕНИЯ (новые колонки/функции/поля/ветки), существующие сигнатуры и маршруты не менять.
Всё на русском. Деньги — критично, считать в ОДНОМ месте (db.quoteOrder).

## 1. Механика (простыми словами)

Админ даёт юзеру пул бесплатных регионов: `/free <кол-во> <user_id|@username>`.
У юзера копится `free_regions` (пул). При оформлении заказа первые `min(free, выбрано)` регионов
бесплатны, за остальные платит `price × остаток`. Пул тратится по факту выдачи.
«1 регион = 0, купит 1 бесплатно» = начислить 1.

## 2. Хранилище (миграция в db.init, идемпотентно)

Через `PRAGMA table_info(...)` проверить и при отсутствии добавить:
- `ALTER TABLE users ADD COLUMN free_regions INTEGER DEFAULT 0`
- `ALTER TABLE orders ADD COLUMN free_applied INTEGER DEFAULT 0`

Миграция не должна падать на уже существующей БД (проверять наличие колонки перед ALTER).

## 3. db.js — новые экспорты (существующие не трогать)

```js
getFree(userId) -> int                 // 0 если юзера нет
setFree(userId, n) -> int              // upsert user-строки при необходимости (id + free_regions=max(0,n),
                                        //   first_seen/last_seen=now если создаём); вернуть установленное
addFree(userId, delta) -> int          // вернуть новое значение (не ниже 0)
consumeFree(userId, n) -> int          // списать min(текущее, max(0,n)); вернуть фактически списанное
usersWithFree() -> [{id, username, first_name, free_regions}]   // free_regions>0, по убыванию
findUserByUsername(name) -> user|null  // регистронезависимо, name без ведущего '@'
quoteOrder(userId, regionsCount) -> {  // ЕДИНЫЙ расчёт цены со скидкой — зовут и бот, и сервер
  price,            // db.priceStars()
  freeAvail,        // getFree(userId)
  freeUsed,         // min(freeAvail, regionsCount)
  payableCount,     // regionsCount - freeUsed
  stars,            // price * payableCount   (0 => полностью бесплатно)
  fullyFree         // stars === 0 && regionsCount > 0
}
```
`createOrder(opts)` — расширить: принимать `opts.freeApplied` (int, default 0) и писать в
`orders.free_applied`. Для полностью бесплатного заказа вызывающий передаёт
`{status:'paid', stars:0, days, freeApplied, chargeId:'FREE'}` — createOrder уже умеет paid
(проставляет paid_at/expires_at). `ordersOfUser`/`statsSummary`/`markOrderPaid` НЕ менять
(status='paid' с charge_id='FREE' корректно попадёт в профиль/статистику, revenue += 0).

## 4. bot.js — команда /free (только ADMIN_IDS) + учёт скидки

### /free
- `/free` без аргументов → карточка: список `usersWithFree()` (`@user (id) — N рег.`) или «пусто»,
  плюс подсказка формата. ЧБ-стиль.
- `/free <кол-во> <user>` → начислить (SET, не add) юзеру `кол-во` (0..100; 0 = снять скидку).
  Определение аргументов: токен с ведущим `@` ИЛИ длиной ≥6 цифр = юзер; короткое число = кол-во
  (порядок аргументов гибкий). `@username` → `db.findUserByUsername` (не найден → ответ:
  «Юзер @x не найден в базе. Пусть напишет боту /start, либо укажи числовой id.»). Числовой id →
  `db.setFree(id, n)` напрямую. Ответ админу: `🎁 @user (id): было X → стало N бесплатных регионов`.
  Уведомить юзера (try/catch): `🎁 Тебе начислено N бесплатных регионов! Открой /vpn или магазин,
  выбери регионы и оформи — скидка спишется автоматически.` Событие в журнал `logEvent('free_grant',{admin,user,n})`.
- Гейт: не-админ → тихий игнор (как /admin).

### Учёт скидки в покупке
- `/vpn` (shopView) и строка итога: считать через `db.quoteOrder(userId, selected.size)`. Показать:
  если `freeAvail>0` — строку `🎁 Бесплатных регионов: F`; итог `▸ Выбрано: N · Итого: <stars> ⭐`
  и при `freeUsed>0` дописать ` (−F бесплатно)`. Кнопка оплаты: `fullyFree` → `🎁 ПОЛУЧИТЬ БЕСПЛАТНО`,
  иначе `⭐ ОПЛАТИТЬ <stars>`.
- cb `pay`:
  - пустой выбор → алерт (как было).
  - `q = quoteOrder(...)`. Если `q.fullyFree`: создать заказ
    `createOrder({userId, regions, stars:0, status:'paid', days:subDays(), freeApplied:q.freeUsed, chargeId:'FREE'})`,
    `db.consumeFree(userId, q.freeUsed)`, `sendDelivery`, `notifyAdmins('🎁 Бесплатная выдача #id · @user · N рег.')`,
    ответить пользователю успехом (как после оплаты). БЕЗ инвойса (XTR на 0 нельзя!).
  - иначе: `createOrder(pending, freeApplied:q.freeUsed)`, инвойс на `q.stars` (в prices label
    `VLESS · <payableCount> регион(ов)`, при `freeUsed>0` в описании инвойса упомянуть «−F бесплатно»).
- `successful_payment`: после `markOrderPaid`, если `order.free_applied>0` →
  `db.consumeFree(order.user_id, order.free_applied)` (идемпотентно к дубль-апдейту:
  списывать по флагу wasPending, как уже сделано для notify/log).
- `pre_checkout_query`: без изменений (одобряет pending).

### /admin
Добавить кнопку `🎁 Бесплатные` (cb `adm:free`) → показать `usersWithFree()` + формат `/free N user`.
(Начисление — самой командой /free, чтобы не плодить ForceReply-состояний; кнопка информативная.)

## 5. server.js — POST /famas/api/order (учёт скидки) + /api/me (баланс)

- `POST /famas/api/order`: после валидации регионов — `q = db.quoteOrder(userId, regions.length)`.
  - `q.fullyFree`: создать `createOrder({userId, regions, stars:0, status:'paid', days:subDays,
    freeApplied:q.freeUsed, chargeId:'FREE'})`, `db.consumeFree(userId, q.freeUsed)`,
    `logEvent('free_order',...)`. Ответ `{ok:true, free:true, orderId, page:pageUrl, sub:subUrl,
    servers, regions:[iso...]}` — БЕЗ invoiceLink, БЕЗ вызова botApi. (Бот-уведомление админам не
    обязательно из сервера; допустимо не слать.)
  - иначе: `createOrder(pending, freeApplied:q.freeUsed)`, `createInvoiceLink(...)` на `q.stars`
    (label по payableCount). Ответ как раньше + доп. поля `{invoiceLink, orderId, stars:q.stars,
    freeApplied:q.freeUsed, payableCount:q.payableCount}`.
- `GET /famas/api/me`: в ответ добавить поле `free` = `db.getFree(userId)` (int). Остальное как есть.
- Прочие маршруты не трогать.

## 6. mini app (app.js + index.html) — отображение и бесплатный путь

- При старте и после сделки грузить `/api/me` (уже грузится для «МОИ КЛЮЧИ») и брать `free`.
  На вкладке МАГАЗИН при `free>0` показать бейдж `🎁 N бесплатных регионов`.
- Панель оплаты: `payable = max(0, selected - free)`, `stars = payable * price`, подпись
  `ИТОГО: <stars> ⭐` и при `selected>0 && free>0`: `<min(free,selected)> бесплатно`. Кнопка:
  `stars===0 && selected>0` → `🎁 ПОЛУЧИТЬ БЕСПЛАТНО`, иначе `ОПЛАТИТЬ <stars> ⭐`. Каунт-ап учитывает 0.
- POST `/api/order`:
  - ответ `{free:true, ...}` → НЕ звать `openInvoice`; сразу экран успеха (тот же, что после оплаты),
    обновить `free`-баланс (перезапросить /api/me), показать `page`/`sub` из ответа.
  - ответ с `invoiceLink` → `openInvoice` как сейчас; при `paid` — обновить free-баланс.
- Баланс `free` — только для отображения/расчёта в UI; итоговая цена ВСЕГДА проверяется сервером
  (сервер сам зовёт quoteOrder), UI-число не доверяется.

## 7. Тесты (E2E-агент, локально SKIP_BOT=1 + forged initData)

1. `node --check` всех изменённых js; `node scripts/selftest.js` — зелёный (миграция не ломает).
2. Прямые db-тесты: setFree(u,2)→getFree=2; quoteOrder(u,1)={stars:0,fullyFree:true,freeUsed:1};
   quoteOrder(u,3)={payableCount:1,stars:price,freeUsed:2}; consumeFree(u,2)→0; usersWithFree.
3. Живой сервер: forged initData юзера с free=1 →
   - POST /api/order regions=['DE'] → `{free:true, orderId, sub, page}` (без invoiceLink);
     GET /api/key/<token> active:true; /s/<token> отдаёт vless; getFree стал 0.
   - Затем POST /api/order regions=['DE','NL'] с free=0 → обычный invoiceLink (или 502 на фейк-токене — ок).
   - GET /api/me → поле `free` присутствует.
   - Частичный: setFree(u,1), POST regions=['DE','NL','GB'] → invoiceLink, ответ payableCount:2,
     freeApplied:1, order.free_applied=1 в БД, free НЕ списан (ещё не оплачено).
4. Edge: free больше выбранного (free=5, выбрано 2 → всё бесплатно, спишется 2); free=0 → обычный путь;
   пустые регионы → 400 как раньше.
5. Все находки чинить на месте; контракты §1-6 держать. Убрать тестовые данные/БД.

## 7b. АТОМАРНОЕ списание (закрытие абьюза) — ОБЯЗАТЕЛЬНО

Проблема прежней схемы «списывать при выдаче»: на ЧАСТИЧНОМ пути (выбрано больше free)
юзер мог открыть несколько pending-инвойсов со скидкой из одного пула, а `consumeFree`
списывал бы лишь раз при первой оплате → скидка на больше регионов, чем начислено (потеря звёзд).

Решение: списывать free **в момент оформления заказа, атомарно**, а не при выдаче.
- Новый db-экспорт `reserveOrder(userId, regionsCount) -> {price, freeUsed, payableCount, stars, fullyFree}`
  — ВНУТРИ ОДНОЙ транзакции: `freeUsed = consumeFree(userId, min(getFree(userId), regionsCount))`
  (фактически списанное!), `payableCount = regionsCount - freeUsed`, `stars = price*payableCount`,
  `fullyFree = stars===0 && regionsCount>0`. Списывает СРАЗУ и возвращает по-настоящему применённое.
- `quoteOrder` остаётся ЧИСТЫМ (без списания) и используется ТОЛЬКО для отображения:
  shopView-превью в боте, `updatePaybar` во фронте, поле `free` в /api/me. Ничего не списывает.
- В МОМЕНТ создания заказа (bot cb `pay`, server POST /api/order) звать `reserveOrder` (не quoteOrder):
  `freeApplied = freeUsed`, инвойс/выдача считаются по возвращённому `stars`/`payableCount`.
- Убрать повторное `consumeFree` из `successful_payment` (free уже списан при создании заказа) —
  оставить там только markOrderPaid + notify/log. fully-free ветка тоже больше НЕ зовёт consumeFree
  отдельно (всё внутри reserveOrder).
- Следствие (задокументировать): открыл частичный инвойс и не оплатил → зарезервированные free
  «сгорают» (не возвращаются, pending не трекается). Для fully-free (главный кейс «1 регион бесплатно»)
  — мгновенная выдача, сгорания нет. Это честный компромисс без дыры.
- E2E: юзер free=1 открывает подряд ДВА частичных заказа [DE,NL,GB]: первый freeApplied=1 (инвойс 40),
  второй уже freeApplied=0 (инвойс 60) — суммарная скидка не превышает пул. Concurrent-абьюз закрыт.

## 8. Приёмка

- `/free 1 @user` (или id) начисляет; юзер оформляет 1 регион за 0⭐ и получает ключ без оплаты.
- Частичная скидка платит только за лишние регионы; free списывается лишь при фактической выдаче.
- Инвойс на 0 никогда не создаётся. Все прежние тесты (parse/self/E2E/security) остаются зелёными.
