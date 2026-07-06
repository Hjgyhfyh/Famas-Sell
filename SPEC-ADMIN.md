# SPEC-ADMIN — веб-админка «кто что купил» (только для владельца)

Дополнение к SPEC*. Красивая защищённая панель: список покупок с покупателями (аватар + @username +
id), их VPN (регионы ×qty), сортировка «новые/дорогие», сводная статистика. Только совместимые
добавления; существующие маршруты/схему/цены не трогать. Русский, дизайн — как SPEC-V2 (ЧБ/Dracula
+ стекло, скруглённое, анимации).

## 1. Доступ и безопасность

- Открывается из бота: в `/admin` добавить кнопку `📊 Открыть админку` (web_app URL
  `PUBLIC_BASE + '/admin/'`, только в личке). Страница = Telegram WebApp, берёт `Telegram.WebApp.initData`.
- Статика `/famas/admin/` (html/css/js) — публична (в ней НЕТ секретов). ВСЕ данные — только через
  admin-API, которые СТРОГО проверяют: `tgauth.validateInitData(initData)` И `user.id ∈ config.ADMIN_IDS`.
  Не админ / нет initData → `403 {ok:false,error:'Доступ только для администратора'}`.
- Если страница открыта не в Telegram (нет initData) или не админом — показать экран «Доступ только
  для администратора», без данных.

## 2. server.js — admin-эндпоинты (все под `/famas/admin/`, порядок ДО дефолтного 404)

Хелпер `requireAdmin(initData)` -> `{ok:true,user}` | `{ok:false}` (validateInitData + ADMIN_IDS).
`initData` берётся из query `?initData=` или заголовка `X-Init-Data`.

- `GET /famas/admin/api/summary?initData=` →
  `{ok, stats:{ordersPaid, revenueStars, salesToday, uniqueBuyers, activeConfigs, regionsCount,
  ordersTotal, freeActive}}` (uniqueBuyers = DISTINCT user_id по paid/gift; freeActive = сумма
  users.free_regions; остальное из db.statsSummary). Cache-Control no-store.
- `GET /famas/admin/api/orders?initData=&sort=new|price&limit=&offset=&q=` →
  `{ok, total, orders:[{
     id, userId, username, firstName, kind, stars, servers,
     regions:[{iso,nameRu,flag,qty}], createdAt, paidAt, expiresAt, active, token, page
  }]}`
  - выборка: заказы `status IN ('paid','gift')` (это все выданные — оплаченные, промо и ручные gift).
  - `kind`: `status==='gift'` → `'gift'`; `charge_id==='FREE'` (или stars===0) → `'free'`; иначе `'paid'`.
  - `regions`: из `qty` JSON `{iso:count}` → массив `{iso,nameRu,flag,qty}` (nameRu=util.nameRuOf,
    flag=util.isoToFlag); старый заказ (qty NULL) → по `regions` с `qty:null` (кол-во серверов = число
    конфигов, показывать без ×N либо servers из configsForRegions).
  - `servers`: Σqty (или число конфигов для старых).
  - `active`: `status` выдан И `now<=expires_at`.
  - `sort`: `new` (дефолт) = `COALESCE(paid_at,created_at) DESC`; `price` = `stars DESC, id DESC`.
  - `q` (опц.): фильтр по `username` LIKE или `user_id` = q.
  - `limit` дефолт 50 (макс 200), `offset` дефолт 0. `total` = всего подходящих (без limit).
- `GET /famas/admin/avatar/:userId?initData=` → аватар покупателя, ПРОКСИ через бота:
  requireAdmin; userId должен встречаться в orders/users (иначе 404); `botApi.getUserProfilePhotos(userId,
  {limit:1})` → первый размер (например photos[0][1] или последний ≤ 320px) → `botApi.getFile(file_id)`
  → скачать `https://api.telegram.org/file/bot<token>/<file_path>` (token из config.BOT_TOKEN,
  глобальный fetch) → отдать байты с `Content-Type` (image/jpeg) и `Cache-Control: private, max-age=3600`.
  Нет фото/ошибка → `404` (клиент рисует инициал-заглушку). Кэш в памяти: `Map userId → {buf,type,ts}`
  TTL ~1ч, ограничение размера (напр. ≤200 записей, простая эвикция). Токен НИКОГДА не отдавать клиенту.

## 3. db.js — хелпер (аддитивно)

`ordersForAdmin({sort='new', limit=50, offset=0, q=''}) -> {total, rows}` — JOIN users, выборка/сортировка
как §2 (SQL). rows содержат сырые поля (id,user_id,username,first_name,regions,qty,stars,charge_id,
status,created_at,paid_at,expires_at,token); маппинг в API-форму (kind/regions[]/servers/active) — в
server.js. `total` — отдельный COUNT с тем же WHERE. Ничего существующего не менять.

## 4. Фронт public/admin/ (index.html + admin.css + admin.js) — агент UI

Telegram WebApp (`telegram-web-app.js`), `ready()/expand()`, тема-хедер #000, initData из Telegram.
Дизайн-язык «FAMAS» (SPEC-V2): ЧБ (дефолт) + Dracula + жидкое стекло, всё скруглённое, анимации,
prefers-reduced-motion, тап-зоны ≥44px, безопасные зоны. Тексты русские. Никаких CDN кроме
telegram-web-app.js.

- Если нет initData → экран «⛔ Доступ только для администратора».
- Хедер: `FAMAS STORE ⁂ · АДМИНКА`. Блок сводки (карточки-плитки): 💰 Продаж, ⭐ Выручка,
  👥 Покупателей, 📈 Сегодня (из /admin/api/summary). Мягкая анимация чисел.
- Панель управления: чипы сортировки `🆕 Новые` (дефолт) · `💎 Дорогие`; поле поиска по @username/id
  (дебаунс). Переключатель темы/стекла (как в mini app, localStorage famas_theme/famas_glass).
- Лента покупок (из /admin/api/orders): карточка покупки —
  - слева круглый АВАТАР: `<img src="/famas/admin/avatar/<userId>?initData=...">`, `onerror` →
    красивый инициал-аватар (первая буква firstName/username в круге, цвет детерминирован от userId,
    в ЧБ — серый/контур, в Dracula — акцент);
  - `@username` (или «без ника») + `id: <userId>` моно, клик — копировать id (тост);
  - бейдж kind: `💰 Оплата` / `🎁 Промо` / `🛠 Выдача` (разные тонкие стили);
  - крупно сумма: `+X ⭐` (для free/gift — `бесплатно`);
  - строка VPN: чипы регионов с SVG-флагами (`/famas/flags/<iso>.svg`, скругл., эмодзи-фолбэк) и `×qty`;
    `S серверов`;
  - дата (dd.mm.yyyy HH:MM), статус `● активен до dd.mm` / `○ истёк`;
  - кнопка `Ключ` (openLink page) и `Подписка` (копировать sub? необяз.).
  - staggered fade-up, skeleton при загрузке, пустое состояние «покупок пока нет ⁂».
- Пагинация/ленивая догрузка (limit/offset) — по желанию: кнопка «Показать ещё» или бесконечный скролл.
- Ошибки/403 — дизайнерский экран.

## 5. bot.js

- В `/admin`-панели добавить кнопку `📊 Открыть админку` (web_app `PUBLIC_BASE+'/admin/'`) — только в
  приватном чате (иначе Telegram отклонит web_app). Существующие кнопки/логику не трогать.

## 6. Тесты (E2E-агент)

1. node --check server/db/bot/index; selftest зелёный.
2. Живой сервер (SKIP_BOT=1 с mock botApi для avatar): forged initData АДМИНА (id из ADMIN_IDS,
   реальный HMAC) и НЕ-админа.
   - `/admin/api/summary`: админ → 200 stats; не-админ → 403; без initData → 403.
   - `/admin/api/orders?sort=new` → отсортировано по дате desc; `sort=price` → по stars desc;
     kind вычислен верно (создать paid со stars, gift, free); regions с ×qty корректны; total верен;
     q-фильтр по username/id работает; limit/offset работают.
   - `/admin/avatar/:userId`: с mock botApi (getUserProfilePhotos/getFile + stub file fetch) → 200
     image; для юзера без фото → 404; неизвестный userId → 404; не-админ → 403; токен в ответе НЕ светится.
   - статика `/famas/admin/` отдаёт HTML.
3. Проверить: admin-эндпоинты ДО дефолтного 404; no-store на api; порядок регистрации не ломает
   существующие маршруты (/app, /flags, /s, /k, /qr, /api/* по-прежнему работают).
4. Фронт: node --check admin.js, валидность HTML, поля рендера совпадают с API, аватар-fallback,
   темы/стекло, XSS (textContent/esc для username/firstName).
5. Убрать тестовые БД. JSON-отчёт.

## 7. Приёмка

- Владелец открывает `/admin → 📊 Открыть админку` и видит все покупки: аватар + @username + id,
  VPN-регионы ×qty, сумма, дата, статус.
- Сортировка «Новые» и «Дорогие» работают. Доступ строго админский (initData + ADMIN_IDS).
- Аватарки грузятся (или красивый инициал-фолбэк). Дизайн — как весь проект. Ничего старого не сломано.
