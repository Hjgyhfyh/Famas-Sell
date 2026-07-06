# SPEC-REFERRAL — реферальная программа + не-молчащие админ-команды

Дополнение к SPEC*. (A) У каждого юзера — уникальная реф-ссылка; за каждого приглашённого нового
пользователя пригласившему +10 ⭐ бонуса-скидки (копится, тратится на покупки). (B) Админ-команды
не молчат для не-админов, а отвечают как на неизвестную команду (не палим их существование).
Только совместимые добавления; base/extra/free-логику и маршруты не ломать. Русский, деньги критичны.

## 1. Конфиг

`config.js` + `.env.example`: `REF_BONUS_STARS` (env, дефолт `10`) — бонус за одного приглашённого.

## 2. Схема (миграция в db.init, идемпотентно, columnExists-guard)

- `ALTER TABLE users ADD COLUMN bonus_stars INTEGER DEFAULT 0` — пул бонусных звёзд-скидки.
- `ALTER TABLE users ADD COLUMN referred_by INTEGER` — кто пригласил (ставится один раз, NULL если сам).
- `ALTER TABLE users ADD COLUMN ref_count INTEGER DEFAULT 0` — сколько привёл (для отображения).
- `ALTER TABLE orders ADD COLUMN bonus_applied INTEGER DEFAULT 0` — сколько бонус-звёзд списано в заказе.

## 3. db.js — экспорты (аддитивно)

```js
getBonus(userId) -> int
addBonus(userId, delta) -> int              // итог не ниже 0
consumeBonus(userId, n) -> int              // списать min(текущее,max(0,n)); вернуть списанное
refInfo(userId) -> {count, bonus, referredBy}   // count=ref_count, bonus=bonus_stars
attributeReferral(newUserId, inviterId) -> {credited:bool, reason}
  // credited=true и inviter.bonus_stars += REF_BONUS_STARS, inviter.ref_count++, newUser.referred_by=inviter
  // ТОЛЬКО если: inviterId!=newUserId; inviter существует (есть строка users или создаётся); у newUser
  //   ещё нет referred_by; newUser «новый» (нет оплаченных/gift заказов И referred_by пуст).
  // Иначе credited=false с reason ('self'|'already'|'not_new'|'no_inviter'). Всё в транзакции.
refLeaders(limit) -> [{id,username,ref_count,bonus_stars}]   // для /admin (топ рефереров), опц.
```
`quoteOrder`/`reserveOrder` — РАСШИРИТЬ учётом бонуса (см. §4). `createOrder` — сохранять
`opts.bonusApplied` в `orders.bonus_applied`.

## 4. Ценовая модель со скидками (порядок: free-регионы → бонус-звёзды)

Пусть `qtyMap`, `base=priceStars`, `extra=extraStars`:
- `totalCost = Σ(base + extra*(q_i-1))`, `regionsCount = число регионов`, `servers = Σq_i`.
- `freeUsed = min(getFree(user), regionsCount)`; `discountFree = freeUsed*base`.
- `afterFree = max(0, totalCost - discountFree)`.
- `bonusAvail = getBonus(user)`; `bonusUsed = min(bonusAvail, afterFree)`.
- `stars = afterFree - bonusUsed`; `fullyFree = stars===0 && regionsCount>0`.
- `quoteOrder` (превью, НЕ списывает) возвращает: `{base,extra,totalCost,regionsCount,servers,
  freeAvail,freeUsed,discountFree, bonusAvail,bonusUsed, stars,fullyFree}`.
- `reserveOrder` (АТОМАРНО, транзакция) списывает И `freeUsed` (consumeFree) И `bonusUsed`
  (consumeBonus) по фактически доступному, пересчитывает stars по реально применённому; возвращает
  то же без `*Avail`. Сохранять в заказ `freeApplied=freeUsed`, `bonusApplied=bonusUsed`.
- `successful_payment` — НЕ списывать повторно (всё списано при создании, как в SPEC-FREE §7b).
- Инвойс на 0 не создаётся (fullyFree → выдача сразу).

## 5. bot.js — реферальные ссылки, начисление, отображение + не-молчащие команды

### Начисление (deep-link)
- Реф-ссылка юзера: `https://t.me/<BOT_USERNAME>?start=ref<userId>` (payload `ref<digits>`).
- `/start` парсит payload: если `^ref(\d+)$` → `inviterId`. На ПЕРВОМ старте нового юзера (до upsert
  выяснить, новый ли) вызвать `db.attributeReferral(ctx.from.id, inviterId)`. Если `credited` —
  уведомить пригласившего (`bot.api.sendMessage(inviterId, '🎉 По твоей ссылке пришёл новый пользователь!
  +<REF_BONUS_STARS> ⭐ бонуса. Всего приглашено: N, бонус: M ⭐')`, try/catch) и мягко сообщить новичку
  («ты пришёл по приглашению»). Обычный `/start` (без payload/не реф) — как раньше. Порядок: сначала
  upsertUser, но «новизну» определить ДО (по наличию referred_by/заказов), чтобы самоприглашения и
  повторы не проходили.
- Показ: команда `/ref` (и кнопка «🎁 Пригласить» в /start и /profile) → карточка: реф-ссылка
  (моно, copy-friendly), «Приглашено: N», «Бонус: M ⭐», короткое объяснение «+<bonus> ⭐ за каждого
  друга, бонус тратится на покупки». Кнопка share (url `https://t.me/share/url?url=<ref>&text=...`).
- В /vpn shopView и итоге — учитывать бонус (через quoteOrder): строка `🎁 Бонус: M ⭐` при bonus>0,
  итог показывает применённый бонус; кнопка ПОЛУЧИТЬ БЕСПЛАТНО при fullyFree.
- `/profile` — добавить строку «Бонус: M ⭐ · Приглашено: N» + кнопку «🎁 Пригласить».

### Не-молчащие админ-команды (SPEC-REFERRAL §B)
- Вынести дефолтный ответ на неизвестную команду в helper `unknownCommandReply(ctx)` (тот самый текст
  «⬛️ FAMAS STORE ⁂ / Не понял. Вот что я умею: /vpn … /profile … /help … /support»).
- Хэндлеры `/admin`, `/free`, `/refund` (и любые будущие админские): если `ctx.from.id` НЕ в ADMIN_IDS —
  вместо тихого `return` вызвать `unknownCommandReply(ctx)` (как будто команды не существует). Для
  админа — работать как раньше. Catch-all неизвестных команд тоже через `unknownCommandReply`.
- Результат: твинк на `/admin`, `/free`, `/refund`, `/admins`, `/fr` и т.п. получает одинаковый
  «Не понял…», существование админ-команд не палится, бот не молчит.

## 6. server.js — бонус в API (для mini app)

- `GET /famas/api/me` — добавить в ответ `bonus` = `db.getBonus(userId)` и `ref` = `db.refInfo(userId)`
  (count, ссылка `https://t.me/<BOT_USERNAME>?start=ref<userId>`). Поле `free` уже есть.
- `POST /famas/api/order` — цена уже считается `reserveOrder` (учтёт бонус автоматически); в ответ
  платного пути добавить `bonusApplied`. Ничего в маршрутах не менять.

## 7. mini app (app.js/index.html/app.css) — реф-блок + бонус в оплате

- Новый компактный блок/экран «🎁 Пригласить друзей»: реф-ссылка (копировать + кнопка «Поделиться»
  через `Telegram.WebApp.openTelegramLink('https://t.me/share/url?url=...&text=...')`), «Приглашено: N»,
  «Бонус: M ⭐», пояснение «+10 ⭐ за друга — хватит на бесплатные серверы». Данные из `/api/me`
  (bonus, ref.count, ref.link). Разместить как отдельную вкладку ИЛИ секцию на вкладке ПОМОЩЬ/МОИ КЛЮЧИ
  (на выбор, но заметно и удобно — конверсия).
- Панель оплаты: учитывать бонус (payable = max(0, (selected*base + extraServers*extra) − free*base − bonus)),
  показывать «Бонус: M ⭐» и «применено X ⭐». Итог всё равно считает сервер (UI — предпросчёт).
- Стиль как везде (ЧБ/Dracula/стекло, скруглённое, анимации). Тексты русские.

## 8. Тесты (E2E-агент)

1. node --check; selftest/parse-check зелёные; миграция bonus_stars/referred_by/ref_count/bonus_applied
   идемпотентна, старую БД не ломает.
2. attributeReferral: A приглашает нового B → B.referred_by=A, A.bonus_stars+=10, A.ref_count=1, credited;
   повтор (B снова по ссылке A или C) → not credited (already); самоприглашение → not credited (self);
   приглашение существующего покупателя → not credited (not_new).
3. Цена: getBonus=10, quoteOrder({DE:1}) (base 20) → afterFree 20, bonusUsed 10, stars 10; getBonus=20
   → stars 0 fullyFree; free+bonus вместе: free=1 покрывает base, bonus добивает extra. reserveOrder
   списывает free и bonus атомарно, сохраняет free_applied/bonus_applied; невалид → ничего не списано.
4. Живой сервер: /api/me содержит bonus и ref{count,link}; POST /api/order с бонусом — stars уменьшены,
   bonus списан; fully-free (free+bonus покрыли) → free:true без инвойса.
5. Не-админ fallback: (мок ctx) /admin, /free, /refund от НЕ-админа → вызывает unknownCommandReply
   (тот же текст), НЕ молчит, НЕ выполняет админ-действие; админ → работает. Проверить по коду/юниту.
6. Фронт: node --check app.js, реф-ссылка/бонус рендерятся, оплата учитывает бонус, XSS-safe. Убрать БД.

## 9. Приёмка

- У каждого своя ссылка; приглашение нового → +10 ⭐ пригласившему (уведомление), бонус копится и
  тратится на покупки (много друзей → бесплатные серверы). Защита от самоприглашения/повторов/не-новых.
- /admin, /free, /refund для чужих отвечают «Не понял…» (не молчат, не палятся).
- Цена корректна (free → бонус → звёзды), инвойс на 0 не создаётся, старые тесты зелёные.
