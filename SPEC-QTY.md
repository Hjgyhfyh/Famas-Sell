# SPEC-QTY — серверов на регион (доп. ссылки +10⭐) + сортировки витрины

Дополнение к SPEC.md / SPEC-V2.md / SPEC-FREE.md. Меняет модель заказа: теперь покупается
не «весь регион», а заданное КОЛИЧЕСТВО серверов (ссылок) в каждом регионе. Только совместимые
добавления/расширения; существующие маршруты/имена не ломать; старые заказы (без qty) должны
продолжать работать. Всё на русском, деньги критичны, расчёт цены — в ОДНОМ месте.

## 1. Ценовая модель

- `base` = `db.priceStars()` (дефолт 20⭐) — первый сервер региона.
- `extra` = `db.extraStars()` (новый, дефолт 10⭐) — каждый доп. сервер ТОГО ЖЕ региона.
- Стоимость региона с `q` серверами: `base + extra*(q-1)`.
- Итог заказа: `Σ по регионам (base + extra*(q_i-1))`.
- Пример: США×1=20; США×2=30; США×2 + Германия×1 = 30+20 = 50.
- `q_i` в диапазоне `1..available_i` (available = кол-во активных серверов региона; больше купить нельзя).

Free-регионы (SPEC-FREE) сосуществуют: `freeUsed = min(getFree(user), regionsCount)`,
скидка `= freeUsed*base` (обнуляет base у freeUsed регионов; доп. серверы `extra` остаются платными).
`stars = max(0, totalCost - freeUsed*base)`; `fullyFree = stars===0 && regionsCount>0`
(возможно только когда все выбранные регионы по 1 серверу и free покрывает их число).

## 2. Хранилище (миграция в db.init, идемпотентно)

- `ALTER TABLE orders ADD COLUMN qty TEXT` (JSON-объект `{iso:count}`; NULL у старых заказов).
- `orders.regions` СМЫСЛ НЕ МЕНЯЕТСЯ — JSON-массив ISO (ключи qty). Старый заказ: `qty IS NULL`
  → трактуется как «все серверы региона» (обратная совместимость buildSub).
- Настройка `extra_stars` в таблице settings (как `price_stars`/`sub_days`).

## 3. db.js — новое/изменённое (существующие сигнатуры не ломать)

```js
extraStars() -> int                      // getSetting('extra_stars', config.EXTRA_STARS(=10))
setExtra(n)                              // setSetting('extra_stars', n)  (для /admin)
regionsSummary() -> [{iso,name,nameRu,flag,count, popularity}]   // + popularity (см. §4)
regionPopularity() -> Map<iso,int>       // вес продаж + базовый вес (см. §4)
quoteOrder(userId, qtyMap) -> {          // ЧИСТЫЙ (без списания) — для отображения/превью
  base, extra, totalCost, regionsCount, freeAvail, freeUsed, discount, stars, fullyFree, servers
}   // qtyMap = {iso:count}; servers = Σcount; totalCost = Σ(base+extra*(count-1))
reserveOrder(userId, qtyMap) -> {同上 без freeAvail}   // АТОМАРНО (транзакция) списывает freeUsed
   // (SPEC-FREE §7b) и возвращает по-настоящему применённый freeUsed/discount/stars/fullyFree
createOrder(opts)                        // opts.qty:{iso:count} -> orders.qty (JSON); regions:[iso...]
configsForRegionsQty(qtyMap) -> [config] // РОВНО count серверов на регион, СТАБИЛЬНО (см. §5)
```
- `quoteOrder`/`reserveOrder` валидируют: каждый iso активен, `1<=count<=available`. При нарушении —
  бросают Error с понятным сообщением (server → 400). Пустой qtyMap → ошибка.
- Обе функции должны принимать qtyMap как объект `{iso:count}`. Для совместимости допускается вход
  массивом ISO (тогда каждый count=1) — привести к map внутри.

## 4. Популярность (для сортировки)

`regionPopularity()`: посчитать по заказам (`status IN ('paid','gift')` и FREE-заказам) частоту региона:
за каждый такой заказ, где регион присутствует в `regions`, +`W_SALE` (напр. 10) — читать regions
из orders (JSON) в JS (заказов немного). Плюс базовый статичный вес топ-локаций (VPN, аудитория РФ),
чтобы при нуле продаж сортировка была осмысленной. `REGION_WEIGHT` (0..100), высокий для:
NL, DE, US, FI, SE, FR, GB, LV, LT, PL, EE, CH, AT, ES, TR, UA, KZ (примерные веса — задать разумно).
`popularity(iso) = salesCount(iso)*W_SALE + (REGION_WEIGHT[iso]||0)`. Тай-брейк при равенстве — `count` desc.
`regionsSummary()` добавляет поле `popularity` каждому региону.

## 5. Стабильная выдача N серверов (configsForRegionsQty)

Для каждого региона взять РОВНО `count` серверов, детерминированно (чтобы подписка при обновлении
источника давала те же/актуальные сервера, а не скакала):
- активные конфиги региона отсортировать СТАБИЛЬНО по `hash` (ASC), взять первые `count`;
- если активных `< count` — добрать из fallback (неактивные, самые свежие по last_seen) до `count`
  или сколько есть (подписка не пустеет);
- если `count > available` (не должно проходить валидацию, но на всякий) — вернуть сколько есть.
`buildSub(order)`: если `order.qty` задан → `configsForRegionsQty(JSON.parse(order.qty))`;
иначе (старый заказ) → прежний `configsForRegions(regions)` (все сервера). Ребрендинг фрагмента
FAMAS ⁂ … — как раньше.

## 6. server.js

- `GET /famas/api/regions` → добавить поля: `extra` (=extraStars), и в каждом регионе `popularity`.
  Итог: `{ok, regions:[{iso,name,nameRu,flag,count,popularity}], price(base), extra, subDays, total, updatedAt}`.
- `POST /famas/api/order` — принять НОВЫЙ формат тела (совместимо):
  - `{initData, items:[{iso,qty}]}` — предпочтительно; ИЛИ `{initData, qty:{iso:count}}`; ИЛИ старое
    `{initData, regions:[iso]}` (каждый qty=1). Собрать qtyMap. Валидация: ≥1 регион, каждый count
    1..available, лимит регионов 100, сумма серверов разумна (напр. ≤500).
  - `q = db.reserveOrder(userId, qtyMap)` (атомарно, SPEC-FREE §7b).
  - `q.fullyFree` → `createOrder({userId, regions:[iso...], qty, stars:0, status:'paid',
    days:subDays, freeApplied:q.freeUsed, chargeId:'FREE'})`, ответ `{ok, free:true, orderId,
    page, sub, servers:q.servers, regions}` (без invoiceLink/botApi).
  - иначе → `createOrder(pending, qty, freeApplied:q.freeUsed)` + `createInvoiceLink` на `q.stars`
    (label: `VLESS · <servers> серв. в <regionsCount> стр.`), ответ `{ok, invoiceLink, orderId,
    stars:q.stars, servers:q.servers, freeApplied:q.freeUsed}`. Инвойс на 0 не создаётся.
- `GET /famas/api/key/:token` — `servers` = Σqty (для новых) / configs len (старых);
  `regions:[{iso,nameRu,flag,count}]` где `count` = КУПЛЕННОЕ qty региона (для старых — available).
- `GET /famas/api/me` — `servers` каждого заказа = Σqty (или как в buildSub); поле `free` как есть.

## 7. bot.js — /vpn с количеством + сортировка + /admin extra

- Состояние выбора: `Map userId -> Map(iso->qty)` (было Set). TTL 2ч как раньше.
- `shopView` (/vpn): список регионов (только count>0). Заголовок + переключатель сортировки —
  циклическая кнопка `⇅ Сортировка: <Популярные|А-Я|Серверов ↓>` (cb `sort`), состояние в памяти
  на userId (дефолт «Популярные»). Регион не выбран → кнопка `☐ 🇺🇸 США · 12` (cb `r:US`, добавляет qty=1).
  Выбран → строка с количеством: `🇺🇸 США ×2` + кнопки `[−]`(cb `q-:US`) `[＋]`(cb `q+:US`, максимум
  available) и `[✕]`(cb `r:US` снять). Итог: `▸ Стран: N · Серверов: S · Итого: <stars> ⭐`
  (+ `(−F бесплатно)` при free). Кнопка оплаты: fullyFree → `🎁 ПОЛУЧИТЬ БЕСПЛАТНО`,
  иначе `⭐ ОПЛАТИТЬ <stars>`. Расчёт — `db.quoteOrder(userId, qtyMap)`. Всё редактированием сообщения.
  Клавиатуру держать компактной (выбранные регионы сверху со степперами, прочие — сеткой 2-в-ряд;
  при большом числе — разумно ограничить/пагинировать, не обязательно все сразу).
- cb `pay`: `db.reserveOrder(userId, qtyMap)`; fullyFree → выдача сразу (как SPEC-FREE);
  иначе инвойс на stars (label по серверам/странам, `−F бесплатно` в описании при freeUsed>0).
- `successful_payment`: без изменений логики free (уже атомарно списан при создании).
- `sendDelivery`: показать `Регионы: 🇺🇸 США ×2 · 🇩🇪 Германия ×1` и `Серверов внутри: S`.
- `/admin`: добавить кнопку/пункт смены `extra` (доп. сервер ⭐), рядом с ценой/сроком (ForceReply как price).

## 8. mini app (app.js, index.html, app.css) — сортировки + количество

- **Сортировка** — сегмент/чипы над сеткой: `🔥 Популярные` (дефолт) · `А-Я` · `Серверов ↓`.
  Клиентская сортировка массива regions: популярные — `popularity` desc (тай-брейк count desc);
  А-Я — `nameRu` localeCompare('ru'); серверов — `count` desc. Плавная перестановка (FLIP/анимация
  либо мягкий re-render), сохранять выбор сортировки (localStorage `famas_sort`).
- **Количество серверов**: карточка региона показывает `N серверов` (доступно). При выборе —
  степпер `[−] q [＋]` (q: 1..count), клик по карточке = выбрать (q=1). Цена региона в карточке:
  `base + extra*(q-1)` ⭐, обновляется на лету. Максимум = count, `＋` дизейблится на max.
  Карточка целиком-кликабельна для выбора; степпер — отдельные тап-зоны ≥44px.
- **Панель оплаты**: `Стран: N · Серверов: S · ИТОГО: <stars> ⭐` (с учётом free: `M бесплатно`);
  кнопка `🎁 ПОЛУЧИТЬ БЕСПЛАТНО`/`ОПЛАТИТЬ X ⭐`. Каунт-ап суммы.
- **Отправка**: POST `/api/order` телом `{initData, items:[{iso,qty}]}`. Ответ `{free:true}` →
  экран успеха без openInvoice; `{invoiceLink}` → openInvoice. Обновить free/список после.
- Цена/популярность/extra берутся из `/api/regions` (не хардкод). Итоговую цену считает СЕРВЕР.
- Строгий ЧБ/Dracula + стекло, всё скруглённое, анимации, prefers-reduced-motion, тап-зоны ≥44px,
  как в SPEC-V2. key.html: строки регионов показывают купленное `×qty` (флаг + nameRu + ×N).

## 9. Тесты (E2E-агент, локально SKIP_BOT=1 + forged initData)

1. node --check всех js; selftest/parse-check зелёные; миграция `orders.qty` не ломает старую БД
   (заказ без qty → buildSub отдаёт все серверы, как раньше).
2. db: quoteOrder({US:1})=base(20); quoteOrder({US:2})=30; quoteOrder({US:2,DE:1})=50;
   valid: qty>available → ошибка; qty<1 → ошибка. reserveOrder списывает free (base) как §7b.
   configsForRegionsQty({US:2}) → ровно 2 конфига US, стабильно (два вызова — тот же набор).
   regionsSummary содержит popularity; regionPopularity растёт после paid-заказа с регионом.
3. Живой сервер: /api/regions отдаёт extra и popularity; POST /api/order items=[{iso:'DE',qty:2},
   {iso:'NL',qty:1}] → invoiceLink на stars=50 (или 502 на фейк-токене, но заказ pending с qty
   {DE:2,NL:1} и stars=50); GET /api/key → servers=3, регионы с ×qty; /s → РОВНО 3 строки vless://
   (2 DE + 1 NL), все с FAMAS. fully-free с free: setFree(u,1), items=[{DE,1}] → free:true, /s = 1 строка.
   Частичный: free=1, items=[{DE,2}] → stars=extra(10) (base покрыт free), /s=2 строки после «оплаты»/gift.
4. Сортировки (клиент) проверить юнитом логики если вынесена, иначе — что /api/regions даёт данные
   для всех трёх режимов (popularity, nameRu, count).
5. Инвойс на 0 не создаётся; qty>available отклоняется; старые заказы (#2 gift владельца) всё ещё
   отдают подписку. Чинить красное самому. Убрать тестовые БД.

## 10. Приёмка

- Регион по умолчанию = 1 сервер за base; доп. серверы по extra; каждая новая страна снова с base.
- Подписка содержит РОВНО купленное число серверов, стабильно.
- 3 сортировки в mini app (дефолт «Популярные»), степперы количества, живой пересчёт цены.
- Все прежние тесты (parse/self/E2E/security/free) зелёные; старые заказы не сломаны.
