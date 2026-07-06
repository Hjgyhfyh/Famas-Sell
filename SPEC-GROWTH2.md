# SPEC-GROWTH2 — анти-фрод рефералки + белые списки (раздел, 50⭐) + канал

Три задачи. Только совместимые добавления; существующую оплату/цены (для black)/выдачу/маршруты не
ломать. Русский. Деньги критичны.

## A. Анти-фрод реферальной программы

Проблема: сейчас +10⭐ бонуса начисляются пригласившему СРАЗУ при /start нового юзера → боты
накручивают массовыми фейк-стартами. Фикс: бонус только за РЕАЛЬНОГО, ПЛАТЯЩЕГО приглашённого + лимит.

1. Конфиг: `REF_REQUIRE_PURCHASE` (env, дефолт `1`), `REF_DAILY_CAP` (env, дефолт `20`) — максимум
   зачтённых рефералов на пригласившего в сутки.
2. Схема (миграция): `ALTER TABLE users ADD COLUMN ref_credited INTEGER DEFAULT 0` — начислен ли бонус
   за ЭТОГО приглашённого его пригласившему.
3. db.js:
   - `attributeReferral(newUserId, inviterId)` (на /start): ТЕПЕРЬ только ставит `referred_by` (с прежними
     проверками self/already/not_new/no_inviter) — БОНУС НЕ начисляет (при REF_REQUIRE_PURCHASE=1).
     Возврат `{linked:bool, reason}`. (При REF_REQUIRE_PURCHASE=0 — старое поведение: сразу бонус.)
   - Новый `creditReferralOnPurchase(buyerUserId) -> {credited:bool, inviter?, reason}`: вызывать при
     ПЕРВОЙ платной (paid, оплата ⭐/крипта — НЕ free/gift) покупке приглашённого. Если у buyer есть
     `referred_by`, `ref_credited=0`, и пригласивший НЕ превысил `REF_DAILY_CAP` зачтённых за сегодня
     (считать по событиям `ref_credit` за МСК-сутки ИЛИ по времени) → начислить пригласившему
     `REF_BONUS_STARS` в bonus_stars, `ref_count++`, `buyer.ref_credited=1`, `logEvent('ref_credit',
     {inviter,buyer})`; уведомить пригласившего (через возвращённые данные — бот шлёт). Всё в транзакции.
     Идемпотентно (ref_credited гейт — второй раз не начислит).
   - refInfo — добавить `pending` (referred_by есть, но ref_credited=0 — «приглашённый ещё не купил»).
4. bot.js/server.js: вызвать `creditReferralOnPurchase(order.user_id)` в `successful_payment` (и в
   крипто-оплате когда будет) СТРОГО для первой платной покупки (под wasPending, только stars>0/не FREE);
   при credited — уведомить пригласившего «твой друг совершил покупку, +10⭐». free/gift-выдачи НЕ
   триггерят реф-бонус (накрутка бесплатным бессмысленна). /ref и mini app показывают «приглашено (купили): N»
   и «ожидают покупки: pending» — чтобы честно.
5. Тексты в реф-блоке обновить: «+10⭐ за друга, который совершит покупку» (не просто «перейдёт»).

## B. Белые списки — отдельный раздел, цена 50⭐, сортировка по популярности

1. Конфиг/цена: настройка `price_stars_white` в settings (дефолт `WHITE_PRICE_STARS`=50 из config).
   `db.priceStars(listType)` — для 'white' вернуть whitePrice(50), иначе base(20). `extraStars` — общий
   (доп. сервер +10) ИЛИ отдельный `extra_stars_white` (дефолт = extra); для MVP доп.сервер тот же +10.
2. db.js: `quoteOrder(userId, qtyMap, listType)` и `reserveOrder(userId, qtyMap, listType)` — принимать
   listType, брать base=priceStars(listType); валидация qty по availabilityMap(listType); createOrder
   пишет orders.list_type (уже есть). free/bonus-скидки работают так же (free гасит base — для white base=50).
   regionsSummary(listType) уже есть; сортировка по популярности — клиент/бот поверх (популярность в ответе).
3. server.js: POST /api/order принимает `list:'black'|'white'` (дефолт black) → reserveOrder(...,list),
   createOrder listType=list; /api/regions?list=white уже отдаёт белый каталог + добавить `price`
   соответствующий (50 для white). /api/me/key — list_type заказа уже прокидывается в подписку.
4. bot.js: отдельный вход в белые списки — команда `/white` и кнопка «⚪ Белые списки 🆕» в /start и
   /catalog. shopView(listType) переиспользовать с listType='white' (цена 50, регионы белого пула,
   сортировка Популярные по умолчанию, бейдж NEW). Заказ создаётся с list_type='white'. Выдача/подписка
   из белого пула (buildSub по order.list_type — уже так).
5. mini app: отдельная ВКЛАДКА/раздел «⚪ Белые списки 🆕» (или переключатель black/white на витрине
   МАГАЗИН): грузит /api/regions?list=white (цена 50, популярность-сортировка по умолчанию), покупка
   шлёт POST /api/order {list:'white', items}. Заметный бейдж NEW, пояснение «премиум, работают через
   белые списки РФ». Дизайн как везде. Итог считает сервер (base=50 для white).

## C. Канал продаж

1. saleslog.logSale(api, order, kind): НЕ логировать, если `order.user_id ∈ config.ADMIN_IDS`
   (админские выдачи/тесты не палим в канале). Просто `return` в начале для админов.
2. Закреплённое сообщение статистики обновлять при КАЖДОМ обновлении регионов/серверов: inventory
   после успешного refresh вызывает хук; index.js регистрирует `inventory.onRefreshDone = () =>
   saleslog.updateStats(bot.api)` (fire-and-forget). formatStats уже показывает «Стран/серверов» —
   значит закреп будет отражать актуальные числа после каждого refresh. (Инвентарь не должен зависеть
   жёстко от saleslog — хук опционален, ошибки глотать.)

## Тесты (E2E)

- Anti-fraud: attributeReferral при REF_REQUIRE_PURCHASE=1 только линкует (bonus не начислен);
  creditReferralOnPurchase при первой paid-покупке приглашённого начисляет +10 пригласившему, повтор —
  нет (ref_credited); free/gift покупка приглашённого НЕ начисляет; лимит REF_DAILY_CAP соблюдается.
- White: priceStars('white')=50; quoteOrder white base=50 (qty1=50, qty2=60); reserveOrder white
  создаёт order.list_type='white', подписка из белого пула; /api/regions?list=white price=50; POST
  /api/order {list:'white'} создаёт белый заказ; black не затронут (20).
- Канал: logSale для админского order — 0 вызовов api; для обычного — логирует; inventory.onRefreshDone
  дёргает updateStats (мок).
- node --check; selftest/parse-check зелёные; существующее (black-оплата/цены/merge/free/bonus/выдача)
  не сломано. Убрать тестовые БД.

## Приёмка

- Реф-бонус только за приглашённого, который РЕАЛЬНО купил (paid), + суточный лимит — накрутка ботами
  бессмысленна.
- Белые списки — отдельный раздел, цена 50⭐, по популярности, бейдж NEW; чёрный каталог 20⭐ не тронут.
- В канал не попадают админские выдачи; закреп со статистикой обновляется при каждом обновлении каталога.
