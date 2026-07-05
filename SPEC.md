# FAMAS STORE — Telegram-магазин VLESS-ключей (бот + mini app)

Канонический контракт. Все модули следуют ему ТОЧНО: имена экспортов, сигнатуры, маршруты,
схема БД — менять нельзя (иначе интеграция развалится). Язык всего UI — русский.
Стиль всего визуала — строгий ЧБ (чёрно-белый, премиум, см. §9).

## 0. Факты

- Бот: **@FamasSellerBot** («Famas Sell», id 8042339772). Токен приходит из `.env` (BOT_TOKEN).
- Владелец/админ: Telegram id **927937870** (@sigmatik323).
- Прод: VDS Ubuntu, Node 18, публичная база: **https://telepasta.ru/famas** (nginx проксирует
  `location ^~ /famas/` → `http://127.0.0.1:4488`). Префикс `/famas` ВХОДИТ в пути express.
- Источник товара: текстовый список VLESS-URI (обновляется ~раз в час):
  `https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/BLACK_VLESS_RUS_mobile.txt`
  Локальная копия для тестов: `fixtures/sample-source.txt` (150 строк).
- Оплата: **Telegram Stars (XTR)** — валюта `XTR`, `provider_token` пустой.
- Товар: пользователь выбирает НЕСКОЛЬКО регионов (стран); цена = `price_stars × кол-во регионов`;
  после оплаты получает ОДНУ ссылку-подписку, внутри — ровно конфиги купленных регионов,
  контент подписки живой (при обновлении источника конфиги в подписке обновляются сами).
  Срок действия — `sub_days` дней (по умолчанию 30).

## 1. Дерево файлов (кто что пишет)

```
FamasShop/
├── SPEC.md                     ← этот файл
├── package.json                ← агент CORE
├── .env.example                ← CORE
├── .gitignore                  ← CORE
├── index.js                    ← CORE (композиция)
├── src/
│   ├── config.js               ← CORE
│   ├── util.js                 ← CORE (ЧИСТЫЙ: без require сторонних либ и других src-модулей)
│   ├── db.js                   ← CORE
│   ├── inventory.js            ← CORE
│   ├── subscription.js         ← CORE
│   ├── tgauth.js               ← CORE
│   ├── bot.js                  ← агент BOT
│   └── server.js               ← агент SERVER
├── public/
│   ├── app/index.html          ← агент UI (mini app)
│   ├── app/app.css             ← UI
│   ├── app/app.js              ← UI
│   └── key.html                ← UI (страница товара, самодостаточная: CSS/JS инлайном)
├── scripts/
│   ├── parse-check.js          ← CORE (чистый тест парсера, без npm-зависимостей)
│   ├── selftest.js             ← CORE (полный self-test: db+inventory+subscription)
│   └── gift.js                 ← CORE (ручная выдача заказа: node scripts/gift.js <tgId> <ISO,ISO|all> <days>)
├── fixtures/sample-source.txt  ← уже лежит
├── deploy/
│   ├── famas-shop.service      ← агент DEPLOY
│   ├── famas-locations.conf    ← DEPLOY (nginx snippet)
│   └── deploy.sh               ← DEPLOY
└── README.md                   ← DEPLOY
```

Стек: Node 18+, CommonJS (`require`), без TypeScript, без сборщиков.
Зависимости ТОЛЬКО: `grammy` (^1), `better-sqlite3` (^11), `express` (^4), `qrcode` (^1), `dotenv` (^16).
HTTP-клиент — глобальный `fetch` Node 18.

## 2. .env (config.js)

```
BOT_TOKEN=...                        # обязателен
ADMIN_IDS=927937870                  # через запятую
SUPPORT_USERNAME=sigmatik323
PORT=4488
PUBLIC_BASE=https://telepasta.ru/famas   # без хвостового /
SOURCE_URL=https://raw.githubusercontent.com/igareck/vpn-configs-for-russia/refs/heads/main/BLACK_VLESS_RUS_mobile.txt
FETCH_INTERVAL_MIN=10
DEFAULT_PRICE_STARS=25               # цена за 1 регион
DEFAULT_SUB_DAYS=30
DB_PATH=./data/famas.db
SKIP_BOT=0                           # 1 = поднять только HTTP (локальная проверка)
BOT_USERNAME=FamasSellerBot
```

`src/config.js`: грузит dotenv, экспортирует объект со ВСЕМИ полями выше (числа — числами,
ADMIN_IDS — массив чисел). `SOURCE_URL` может начинаться с `file:` — тогда это путь к локальному
файлу (используется в тестах). Каталог `path.dirname(DB_PATH)` создаёт при старте (recursive).

## 3. БД (src/db.js, better-sqlite3, WAL)

```sql
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT, first_name TEXT,
  first_seen INTEGER, last_seen INTEGER, is_admin INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS configs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hash TEXT UNIQUE, uri TEXT, host TEXT, port INTEGER,
  flag TEXT, country_iso TEXT, country_name TEXT, city TEXT, label TEXT,
  active INTEGER DEFAULT 1, first_seen INTEGER, last_seen INTEGER);
CREATE INDEX IF NOT EXISTS idx_configs_region ON configs(country_iso, active);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER, regions TEXT,          -- JSON-массив ISO: ["DE","NL"]
  stars INTEGER, status TEXT DEFAULT 'pending',  -- pending|paid|refunded|gift
  token TEXT UNIQUE, charge_id TEXT,
  created_at INTEGER, paid_at INTEGER, expires_at INTEGER);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, type TEXT, data TEXT);
```

Экспорты db.js (все синхронные, better-sqlite3):
```js
init()                                    // открыть БД (config.DB_PATH), PRAGMA journal_mode=WAL, создать таблицы
db                                        // сам инстанс (после init)
upsertUser({id,username,first_name})      // insert or update last_seen=now
getUser(id)
allUserIds() -> [int]
getSetting(key, def)                      // из settings, иначе def (строкой); числа парсит вызывающий
setSetting(key, value)
priceStars() -> int                       // getSetting('price_stars', config.DEFAULT_PRICE_STARS)
subDays() -> int                          // getSetting('sub_days', config.DEFAULT_SUB_DAYS)
upsertConfigs(parsed) -> {added, revived, deactivated, total}
   // parsed = массив из util.parseSource().configs; одна транзакция:
   // новые hash → insert(active=1, first_seen=last_seen=now); существующие → active=1,last_seen=now,uri/label обновить;
   // hash, которых нет в parsed → active=0. total = активных после.
regionsSummary() -> [{iso,name,nameRu,flag,count}]  // active=1, count>0, сортировка по nameRu
configsForRegions(isos) -> [config...]    // active=1, WHERE country_iso IN (...), сорт. по country_name,city
fallbackForRegions(isos) -> [config...]   // для ISO из списка, у которых НЕТ активных: по 1 самому свежему (max last_seen) неактивному
createOrder({userId, regions, stars, status='pending', days}) -> {id, token}
   // token = util.genToken(); если status='paid'/'gift' сразу проставить paid_at/expires_at (now + days*86400)
getOrder(id), getOrderByToken(token)
markOrderPaid(id, chargeId) -> order      // status='paid', paid_at=now, expires_at=now+subDays()*86400
setOrderStatus(id, status)
ordersOfUser(userId) -> [orders paid|gift, новые сверху]
statsSummary() -> {users, ordersPaid, revenueStars, activeConfigs, regionsCount, salesToday}
logEvent(type, dataObj)
```
`nameRu`: db.js берёт из `util.COUNTRY_RU[name] || name`.

## 4. src/util.js — ЧИСТЫЙ модуль (только стандартные модули node: crypto)

```js
parseSource(text) -> { meta:{title,count,dateLine}, configs:[{
    uri,          // полная строка vless://... КАК ЕСТЬ, но с ПЕРЕБРЕНДИРОВАННЫМ фрагментом не тут (см. subscription) — тут ОРИГИНАЛ
    host, port,   // из authority
    flag,         // '🇩🇪' или ''
    countryIso,   // 'DE' | 'XX' если не определить
    countryName,  // 'Germany' (EN, из фрагмента)
    city,         // 'Frankfurt' | ''
    label,        // весь декодированный фрагмент
    hash          // sha256 hex от uri целиком
}]}
```
Парсинг строки: берём строки, начинающиеся с `vless://`. Фрагмент после `#` → decodeURIComponent.
Флаг: первая пара regional-indicator символов (`/\p{RI}\p{RI}/u`). ISO из кодпоинтов флага.
Остаток без флага: отрезать хвостовые бейджи `| ... |`-сегменты; первый сегмент до `|` →
`Country, City (Note)` → countryName = до первой запятой; city = после запятой, без `(...)`, trim.
Если флага нет — попытаться найти известное имя страны (map), иначе iso='XX'.
Host:port парсить аккуратно (uuid@host:port; host может быть доменом; IPv6 в скобках — учесть try/catch).

Остальные экспорты:
```js
flagToIso('🇩🇪')->'DE'; isoToFlag('DE')->'🇩🇪'
COUNTRY_RU        // map EN->RU минимум для: Belarus,Belgium,Bulgaria,Croatia,Ecuador,Finland,France,
                  // Germany,Hungary,Iceland,Italy,Kazakhstan,Latvia,Lithuania,Moldova,Netherlands,Norway,
                  // Poland,Romania,Russia,Serbia,Slovakia,Slovenia,Spain,Sweden,Switzerland,Turkey,Ukraine,
                  // United Kingdom,United States,Estonia,Czechia,Czech Republic,Austria,Portugal,Greece,
                  // Denmark,Ireland,Canada,Japan,Singapore,Hong Kong,Armenia,Georgia,Azerbaijan,Uzbekistan,
                  // Kyrgyzstan,Israel,UAE,United Arab Emirates,India,Brazil,Argentina,Mexico,Chile,Vietnam,
                  // Thailand,Indonesia,Malaysia,Philippines,South Korea,Taiwan,Australia,'New Zealand',
                  // Luxembourg,Monaco,Cyprus,Malta,Albania,'North Macedonia',Bosnia,Montenegro,'South Africa',Egypt
genToken()        // crypto.randomBytes(16).toString('base64url')
hashUri(uri)      // sha256 hex
esc(s)            // HTML-эскейп для parse_mode HTML
fmtDate(unixSec)  // 'DD.MM.YYYY' по Europe/Moscow (Intl.DateTimeFormat ru-RU)
fmtDateTime(unixSec) // 'DD.MM.YYYY, HH:MM' Moscow
b64utf8(s)        // Buffer.from(s,'utf8').toString('base64')
```

## 5. src/inventory.js

```js
start()            // сразу refreshNow(), затем setInterval каждые config.FETCH_INTERVAL_MIN минут (unref)
refreshNow() -> Promise<{ok:true, total, added, revived, deactivated, regions} | {ok:false, error}>
lastRefresh        // {at:unix, ok:bool, total:int, error:string|null} — обновляется каждым refreshNow
```
Загрузка: если SOURCE_URL начинается с `file:` → fs.readFileSync(путь после `file:`).
Иначе fetch с timeout 30s (AbortController), заголовок `user-agent: famas-shop/1.0`.
При НЕизменившемся контенте (sha256 тела == прошлому, хранить в settings key `source_hash`) —
можно пропустить upsert, но lastRefresh всё равно обновить. Ошибки сети НЕ роняют процесс.
После refresh писать logEvent('refresh', итоги).

## 6. src/subscription.js

```js
subUrl(token)  -> `${config.PUBLIC_BASE}/s/${token}`
pageUrl(token) -> `${config.PUBLIC_BASE}/k/${token}`
deepLinks(subUrlStr) -> {
  happ:     'happ://add/' + subUrlStr,
  v2raytun: 'v2raytun://import/' + subUrlStr,
  v2rayng:  'v2rayng://install-sub?url=' + encodeURIComponent(subUrlStr) + '&name=FAMAS%20STORE'
}
buildSub(order) -> { lines, b64, headers, regions, expired }
```
`buildSub`: regions = JSON.parse(order.regions). configs = db.configsForRegions(regions)
+ db.fallbackForRegions(regions) (для стран, где активных нет — чтобы подписка не пустела).
Каждому uri ПЕРЕПИСАТЬ фрагмент: `FAMAS ⁂ <flag> <CountryRu> · <City>` (encodeURIComponent; city если есть).
lines = массив uri. b64 = b64utf8(lines.join('\n')).
expired = now > order.expires_at → тогда lines=[] и b64 от пустой строки.
headers (для ответа /s/):
```
profile-title: base64:<b64utf8('⁂ FAMAS STORE')>
profile-update-interval: 1
subscription-userinfo: upload=0; download=0; total=0; expire=<order.expires_at>
profile-web-page-url: <pageUrl(order.token)>
support-url: https://t.me/<SUPPORT_USERNAME>
content-disposition: attachment; filename=famas.txt
```

## 7. src/tgauth.js

`validateInitData(initDataString) -> {ok:false} | {ok:true, user:{id,username,first_name},
auth_date}` — стандартная проверка Telegram WebApp: secret = HMAC_SHA256(key='WebAppData',
msg=BOT_TOKEN); data_check_string из отсортированных пар кроме hash; сравнение hex HMAC c
`hash` (timingSafeEqual); auth_date не старше 24ч.

## 8. src/bot.js (grammY) — агент BOT

```js
createBot() -> bot        // НЕ запускает polling
sendDelivery(api, chatId, order)   // api = bot.api; отправка «товара» (см. ниже)
notifyAdmins(api, html)            // всем config.ADMIN_IDS, ошибки глотать
```
Общее: `parse_mode:'HTML'` везде; каждый входящий апдейт с message/callback → db.upsertUser.
bot.catch — лог в консоль, юзеру вежливая ЧБ-ошибка. Все callback_query отвечать answerCallbackQuery
(без текста), чтобы не крутился спиннер.

### Команды (ВСЕ обязательны — это зарегистрированный список бота)

- `/start` — ЧБ-хиро: бренд `⬛ FAMAS STORE ⁂`, тонкие линии `─────`, краткое «цифровой магазин.
  VPN-ключи VLESS. Моментальная выдача». Inline-клавиатура:
  ряд1: `⬛ ОТКРЫТЬ МАГАЗИН` (web_app: PUBLIC_BASE+'/app/')
  ряд2: `🔐 VPN-ключи` (cb `shop`) | `🛍 Каталог` (cb `catalog`)
  ряд3: `👤 Профиль` (cb `profile`) | `❓ Помощь` (cb `help`)
  ряд4: `💬 Поддержка` (url t.me/SUPPORT_USERNAME)
- `/catalog` (и cb `catalog`) — витрина: карточка «01 / VPN-КЛЮЧИ VLESS» (регионов: X, серверов: Y,
  от priceStars ⭐ за регион, кнопки «🔐 Выбрать регионы» cb `shop` + «⬛ Mini App» web_app) +
  тизер «02 / ─ скоро ─».
- `/vpn` (и cb `shop`) — выбор регионов: сетка inline-кнопок по 2 в ряд: `☐ 🇩🇪 Германия · 3`
  (cb `r:DE`), toggle → `☑`. Внизу: `▸ Выбрано: N · Итого: N×price ⭐` (cb noop), ряд:
  `✦ Выбрать всё` (cb `all`) | `✕ Сброс` (cb `clr`), затем `⭐ ОПЛАТИТЬ <сумма>` (cb `pay`).
  Состояние выбора — Map в памяти по userId (+ подчистка старше 2ч лениво). Только регионы count>0.
  Редактировать сообщение (editMessageReplyMarkup/Text), не слать новые.
- cb `pay` → если выбор пуст — алерт. Иначе db.createOrder(pending) →
  `replyWithInvoice(title:'FAMAS ⁂ VPN-ключ', description:'Регионы: 🇩🇪 🇳🇱 · 30 дней',
  payload:'order:<id>', currency:'XTR', prices:[{label:'VLESS · N регионов', amount: total}])`
  (provider_token НЕ передавать для XTR в grammY ^1: `ctx.replyWithInvoice(title, description, payload, 'XTR', prices)` — БЕЗ provider_token, сигнатура 5 аргументов; если версия требует — raw call).
- `pre_checkout_query` → заказ существует и pending → answerPreCheckoutQuery(true), иначе (false,'Заказ не найден, начни заново: /vpn').
- `message:successful_payment` → payload order:<id> → markOrderPaid(id, telegram_payment_charge_id)
  → sendDelivery → notifyAdmins(`💰 Продажа #id · @user · N⭐ · регионы`).
- `/profile` (и cb `profile`) — `👤 ПРОФИЛЬ` ЧБ-карточка: имя, id, кол-во покупок, затем список
  заказов: `#12 · 🇩🇪🇳🇱 · до 05.08.2026 · ● активен / ○ истёк`, каждая — кнопка
  `Ключ #12` (cb `key:12`) → sendDelivery повторно (только своему user_id!).
- `/help` (и cb `help`) — «КАК ЭТО РАБОТАЕТ»: 01 выбери регионы → 02 оплати ⭐ → 03 получи одну
  ссылку → 04 вставь в приложение. Ниже краткие инструкции Happ / v2rayTun / v2rayNG (2-3 шага),
  кнопка `⬛ Открыть магазин` web_app.
- `/support` — карточка поддержки: кнопка `✉︎ Написать` url t.me/SUPPORT_USERNAME + «отвечаем 24/7».
- `/paysupport` — обязательный для Stars: политика («цифровой товар, выдача мгновенная; проблемы
  с оплатой — пиши в поддержку, разберём и вернём ⭐ при сбое»), кнопка поддержки.
- `/admin` — ТОЛЬКО config.ADMIN_IDS (иначе игнор). Панель: статистика (юзеры, продажи, выручка ⭐,
  продаж сегодня, активных конфигов, регионов, последнее обновление lastRefresh) + кнопки:
  `⟳ Обновить базу` (cb adm:refresh → inventory.refreshNow → отчёт),
  `💰 Цена: N⭐` (adm:price), `🗓 Срок: N дн` (adm:days), `📣 Рассылка` (adm:bcast),
  `📦 Последние заказы` (adm:orders — 10 последних),
  `🎁 Выдать ключ` (adm:gift — формат ответа: `<user_id> <ISO,ISO|all> [дней]`).
  price/days/gift/bcast — через «ответь на это сообщение» (ForceReply) + проверка reply контекста;
  Рассылка: принять текст → показать превью с `✓ Отправить` / `✕ Отмена` → отправка всем
  allUserIds с паузой 50мс, итог: отправлено/ошибок.
- `/refund <order_id>` — только админ: refundStarPayment(user_id, charge_id) через
  `bot.api.refundStarPayment(userId, chargeId)` (grammY метод; при отсутствии — raw). Статус → refunded, уведомить юзера.

### sendDelivery(api, chatId, order) — ВЫДАЧА ТОВАРА (яркая точка, строгий ЧБ)

```
⬛️ FAMAS STORE ⁂
━━━━━━━━━━━━━━━
ЗАКАЗ #12 · ОПЛАЧЕН
Регионы: 🇩🇪 Германия · 🇳🇱 Нидерланды
Серверов внутри: 7
Действует до: 05.08.2026

ТВОЯ ССЫЛКА — ОДНА НА ВСЁ:
<code>https://telepasta.ru/famas/s/XXXX</code>
(нажми — скопируется)

▸ Открой страницу ключа — там кнопки для
Happ / v2rayTun / v2rayNG и QR-код.
```
Кнопки: `⬛ СТРАНИЦА КЛЮЧА` (url pageUrl) / `❓ Как подключить` (cb help) / `👤 Профиль` (cb profile).

## 9. HTTP (src/server.js, express) — агент SERVER

`createServer(botApi)` -> app. botApi нужен для createInvoiceLink. Все маршруты С ПРЕФИКСОМ `/famas`.
JSON body limit 64kb. Заголовки безопасности: `X-Content-Type-Options: nosniff`,
`Referrer-Policy: no-referrer`. Для /api — `Cache-Control: no-store`.

```
GET  /famas/api/regions            → {ok, regions:[{iso,name,nameRu,flag,count}],
                                      price, subDays, total, updatedAt}   // updatedAt = inventory.lastRefresh.at
POST /famas/api/order              body {initData, regions:[iso...]}
     → validateInitData; regions валидны и count>0 (или fallback есть); создать pending order;
       invoiceLink = await botApi.createInvoiceLink('FAMAS ⁂ VPN-ключ', 'Регионы: ...', 'order:<id>', '' /*provider*/, 'XTR', [{label,amount}])
       // grammY: createInvoiceLink(title, description, payload, provider_token, currency, prices)
     → {ok, invoiceLink, orderId}
GET  /famas/api/me?initData=...    → {ok, orders:[{id, regions:[iso], flags:'🇩🇪🇳🇱', status,
                                      expiresAt, active:bool, page:pageUrl, sub:subUrl, servers:N}]}
GET  /famas/api/key/:token         → 404 если нет; {ok, orderId, status, regions:[{iso,nameRu,flag,count}],
                                      servers, expiresAt, active, sub, page, links:{happ,v2raytun,v2rayng}, createdAt}
GET  /famas/s/:token               → подписка: buildSub(order); res.set(headers из §6);
                                      Content-Type: text/plain; body = b64. Неизвестный токен → 404 текст 'not found'.
GET  /famas/qr/:token.svg          → QR (qrcode.toString svg, margin 1, тёмный '#000', светлый '#fff')
                                      от subUrl(token); Content-Type image/svg+xml; cache 1h. 404 если токена нет.
GET  /famas/k/:token               → sendFile public/key.html (страница сама дёрнет /famas/api/key/:token)
GET  /famas/app/*                  → static public/app (index.html), cache 10 мин
GET  /famas/health                 → {ok:true, up:sec, lastRefresh}
```
Никаких других маршрутов. 404 по умолчанию — text/plain 'famas: not found'.

## 10. index.js (CORE)

dotenv уже в config. Порядок: db.init() → inventory.start() → bot = botmod.createBot() →
server = createServer(bot.api).listen(PORT,'127.0.0.1') → если !SKIP_BOT: сначала
`await bot.api.deleteWebhook({drop_pending_updates:true}).catch(()=>{})`, затем bot.start()
(long polling; allowed_updates: ['message','callback_query','pre_checkout_query']).
process.on('unhandledRejection'/'uncaughtException') — лог, НЕ падать (кроме fatal при старте).
SIGTERM/SIGINT → bot.stop(), server.close(), db close, exit 0. Логи console.log с ISO-временем.

## 11. ДИЗАЙН-ЯЗЫК «FAMAS ЧБ» (mini app + key.html) — агент UI

Строгое чёрно-белое. НИКАКИХ цветов кроме #000/#fff и серых (#0a0a0a,#111,#1a1a1a,#666,#999,#e5e5e5,#f5f5f5).
Единственный «цвет» на страницах — эмодзи-флаги стран (допустимо) и ⭐ в кнопке оплаты.
Типографика: дисплей — серифы `Georgia, 'Times New Roman', serif` (крупные заголовки, курсивные
акценты); текст/данные — `'SF Mono', 'Cascadia Mono', Consolas, monospace` для цифр/меток;
UI — системный sans. Табличные линии-волоски 1px #1a1a1a; уголки-скобки у карточек; знак бренда ⁂;
номера-индексы `01 /`, `02 /`; letter-spacing у капса 0.12em; лёгкий шум (CSS radial noise или
повторяющийся svg data-uri, opacity ~0.04); никаких скруглений больше 2px; никаких теней-глоу.
Тёмная тема принудительно: фон #000, текст #fff. Хедер: `FAMAS STORE` + `⁂` + слоган
`черно-белый магазин цифровых ключей`. Всё по-русски. Быстро, без фреймворков, без внешних
шрифтов/CDN (кроме telegram-web-app.js в mini app).

### public/app (mini app)
- `<script src="https://telegram.org/js/telegram-web-app.js"></script>`, `Telegram.WebApp.ready(); expand();`
  `setHeaderColor('#000000'); setBackgroundColor('#000000')`.
- Вкладки снизу (fixed): `МАГАЗИН` / `МОИ КЛЮЧИ` / `ПОМОЩЬ` (моно, капс, активная — белая полоска сверху).
- МАГАЗИН: хиро-блок бренда; строка статуса `● N серверов · M регионов · обновлено HH:MM`;
  сетка регионов (2 колонки): карточка = флаг, название (RU), `N серв.`, чекбокс-квадрат ☐/☑
  (кастомный, анимация 120ms). Липкая нижняя панель (над табами): `ВЫБРАНО N · ИТОГО N×25 ⭐` и
  кнопка `ОПЛАТИТЬ ⭐` (белая, чёрный текст) → POST /famas/api/order (initData из
  Telegram.WebApp.initData) → Telegram.WebApp.openInvoice(invoiceLink, cb) → при status='paid':
  экран успеха: `✓ ОПЛАЧЕНО`, «ключ уже в чате с ботом», кнопка `ОТКРЫТЬ СТРАНИЦУ КЛЮЧА`
  (Telegram.WebApp.openLink(page)) — page взять свежим запросом /api/me (первый активный заказ);
  + кнопка `ЗАКРЫТЬ` (Telegram.WebApp.close()).
- МОИ КЛЮЧИ: GET /api/me → список карточек-«квитанций»: `#12`, флаги, `до 05.08.2026`,
  `● АКТИВЕН`/`○ ИСТЁК`, кнопки `ОТКРЫТЬ` (openLink page) и `КОПИРОВАТЬ ССЫЛКУ`
  (navigator.clipboard + фолбэк, тост «скопировано»). Пусто → красивое «пока пусто ⁂».
- ПОМОЩЬ: аккордеон 01/02/03: «Как купить», «Как подключить (Happ / v2rayTun / v2rayNG)»,
  «Вопросы» + кнопка поддержки (openTelegramLink t.me/sigmatik323).
- Ошибки сети → тонкая чёрно-белая плашка сверху.

### public/key.html — СТРАНИЦА ТОВАРА (главная красота, самодостаточный файл)
Открывается и в обычном браузере, и из Telegram. По `location.pathname` берёт token
(`/famas/k/<token>`), грузит `/famas/api/key/<token>`.
Макет — «чёрный конверт, белая квитанция»:
- фон #000 с едва заметным шумом и тонкой рамкой-паспарту (1px #1a1a1a inset по краю вьюпорта);
- по центру белая карточка-«тикет» (max-width 420): сверху `FAMAS STORE ⁂` серифом + номер заказа
  моно (`ЗАКАЗ № 000012`), перфорированная линия (dashed), статус-строка `● АКТИВЕН · до 05.08.2026`
  (или `○ ИСТЁК` + кнопка «Купить новый» → t.me/FamasSellerBot);
- блок регионов: строки `🇩🇪 Германия ……… 3 серв.` (dotted leaders);
- **QR-код** (img /famas/qr/<token>.svg) в белом квадрате с уголками-скобками, подпись
  `СКАНИРУЙ ИЗ ПРИЛОЖЕНИЯ`;
- ссылка-подписка в моно-боксе с кнопкой `⧉ КОПИРОВАТЬ` (крупная, тост);
- три кнопки-приложения (чёрные, белый текст, во всю ширину): `▸ ОТКРЫТЬ В HAPP` (links.happ),
  `▸ ОТКРЫТЬ В V2RAYTUN` (links.v2raytun), `▸ ОТКРЫТЬ В V2RAYNG` (links.v2rayng);
  под каждой мелко моно: «нет приложения? скачать» → сторы:
  Happ iOS https://apps.apple.com/app/id6504287215 · Happ Android
  https://play.google.com/store/apps/details?id=com.happproxy · v2rayTun Android
  https://play.google.com/store/apps/details?id=com.v2raytun.android · v2rayTun iOS
  https://apps.apple.com/app/id6476628951 · v2rayNG
  https://play.google.com/store/apps/details?id=com.v2ray.ang
  (детект платформы: iOS → показывать iOS-стор первым);
- инструкция-раскрывашка «01 УСТАНОВИ · 02 НАЖМИ КНОПКУ · 03 ПОДКЛЮЧИСЬ»;
- футер: `⁂ FAMAS STORE · @FamasSellerBot · поддержка @sigmatik323`.
Анимации: fade-up карточки 400ms, пульс точки статуса. Печать (media print) — белый фон. 404 от
API → экран «ключ не найден ⁂» на чёрном.

## 12. Деплой — агент DEPLOY

- `deploy/famas-shop.service`:
  [Unit] Description=Famas Store bot+miniapp, After=network-online.target
  [Service] User=ubuntuuser, WorkingDirectory=/home/ubuntuuser/famas-shop,
  ExecStart=/usr/bin/node index.js, Restart=always, RestartSec=3,
  Environment=NODE_ENV=production, MemoryHigh=250M, MemoryMax=350M
  [Install] WantedBy=multi-user.target
- `deploy/famas-locations.conf` (в /etc/nginx/snippets/):
  ```
  location ^~ /famas/ {
      proxy_pass http://127.0.0.1:4488;
      proxy_http_version 1.1;
      proxy_set_header Host $host;
      proxy_set_header X-Real-IP $remote_addr;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_read_timeout 30s;
  }
  ```
- `deploy/deploy.sh` — идемпотентный, запускается на сервере из /home/ubuntuuser/famas-shop:
  npm install --omit=dev; sudo cp unit + snippet; в /etc/nginx/sites-enabled/telepasta во ВСЕ
  server-блоки с `include /etc/nginx/snippets/sig-stats-locations.conf;` добавить строку
  `include /etc/nginx/snippets/famas-locations.conf;` (если ещё нет, sed по якорю);
  sudo nginx -t && sudo systemctl reload nginx; sudo systemctl daemon-reload;
  sudo systemctl enable --now famas-shop; status.
- `README.md`: краткая шпаргалка (запуск, .env, где логи: journalctl -u famas-shop, как обновить
  цену через /admin, как задеплоить обновление).

## 13. Тесты

- `scripts/parse-check.js` (БЕЗ npm-зависимостей): читает fixtures/sample-source.txt, parseSource,
  ассерты: configs.length >= 100; у >=90% countryIso != 'XX'; уникальных hash == configs.length;
  flagToIso('🇩🇪')==='DE'; isoToFlag('NL')==='🇳🇱'; печатает таблицу регионов (iso, nameRu, count).
  Exit 1 при провале.
- `scripts/selftest.js`: process.env.DB_PATH='./data/test.db', SOURCE_URL='file:fixtures/sample-source.txt',
  SKIP_BOT=1 → db.init, inventory.refreshNow, проверить regionsSummary непусто; createOrder gift на
  2 региона; buildSub → b64 декодируется, каждая строка начинается с vless://, фрагменты содержат
  FAMAS; печать OK/FAIL, exit code. В конце удалить test.db*.
- `scripts/gift.js <tgId> <ISO,ISO|all> [days]`: db.init → регионы ('all' → все активные ISO) →
  createOrder({status:'gift', days}) → напечатать pageUrl и subUrl.

## 14. Критерии приёмки

1. `node --check` проходит для всех js.
2. `node scripts/parse-check.js` — OK на fixtures.
3. `node scripts/selftest.js` — OK.
4. `SKIP_BOT=1 node index.js` поднимает HTTP; `/famas/api/regions` отдаёт регионы; `/famas/k/<token>`
   и `/famas/s/<token>` работают для gift-заказа; `/famas/qr/<token>.svg` — валидный SVG.
5. Бот: все 6 команд списка + /paysupport + /admin + /refund; оплата Stars от invoice до выдачи.
6. Mini app и key.html — строгий ЧБ по §11, всё на русском, без внешних зависимостей.
