# SPEC-V3 — логгер действий + раздел «нестабильные серверы» (7⭐)

Две фичи. Экономно, только совместимые добавления; оплату/цены(black 20/white 50)/выдачу/merge/
stability/рефералку не ломать. Русский.

## A. ЛОГГЕР ДЕЙСТВИЙ (для расследований и контроля админов)

Цель: видеть все действия в боте (как возник баг, что делают админы), фильтровать по юзеру/id/действию,
активность (сколько всего людей и сколько заходило).

1. Схема (миграция, идемпотентно):
   `CREATE TABLE IF NOT EXISTS actions(id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, user_id INTEGER,
   username TEXT, is_admin INTEGER DEFAULT 0, kind TEXT, action TEXT, detail TEXT)`.
   `CREATE INDEX IF NOT EXISTS idx_actions_user ON actions(user_id, ts)`.
   `CREATE INDEX IF NOT EXISTS idx_actions_action ON actions(action, ts)`.
2. db.js: `logAction({userId,username,isAdmin,kind,action,detail})` (быстрый insert, try/catch, НЕ ронять
   бота); `actionsQuery({user,action,admin,limit,offset})->{total,rows}` (фильтр по user_id ИЛИ username
   LIKE, по action, только админы; сорт ts DESC; limit≤200); `activityStats()->{totalUsers, activeToday,
   active7d, actionsToday, admins}` (totalUsers=COUNT(users), activeToday=DISTINCT user_id за МСК-сутки из
   actions, и т.п.).
3. bot.js: единый middleware (в начале, ДО хэндлеров) логирует КАЖДЫЙ апдейт: kind='command'|'callback'|
   'message', action = имя команды ('/start','/vpn',…) ИЛИ callback-данные ('pay','r:DE','adm:free',…)
   ИЛИ 'text', detail = краткая суть (аргументы команды/текст обрезать до ~120 симв, эскейпить не нужно —
   это хранилище). isAdmin = user∈ADMIN_IDS. Всё в try/catch, логирование НЕ влияет на обработку.
   Не логировать служебные бот-апдейты без from.
4. server.js (админ-гейт как в SPEC-ADMIN, requireAdmin):
   - `GET /famas/admin/api/log?initData=&user=&action=&admin=&limit=&offset=` → {ok,total,rows:[{ts,
     userId,username,isAdmin,kind,action,detail}]}. no-store.
   - `GET /famas/admin/api/activity?initData=` → {ok, ...activityStats()}.
5. Фронт (Fable, БЫСТРО и КРАСИВО, дизайн как admin-панель ЧБ/Dracula/стекло): новая страница
   `public/admin/log.html` (самодостаточная, Telegram WebApp, initData, admin-гейт как в admin) ЛИБО
   вкладка в существующей `public/admin/`. Показывает: плитки активности (всего людей, заходили сегодня/
   7д, действий сегодня, админов); фильтры — поиск по @username/id, выпадашка/чипы по действию, чекбокс
   «только админы»; лента действий (время МСК, аватар/юз/id, бейдж kind, action, detail), бесконечный
   скролл/показать ещё. Бот в /admin получает кнопку «�operations Логи» (web_app на /famas/admin/log/ или
   якорь). Русский, тап-зоны ≥44px, XSS-safe (textContent).

## B. РАЗДЕЛ «НЕСТАБИЛЬНЫЕ СЕРВЕРЫ» (7⭐)

Регионы, где ЖИВЫХ серверов ≤ порога — отдельный дешёвый раздел с предупреждением «сервер может в любой
момент перестать работать». Это те самые хрупкие регионы (сейчас скрыты MIN_ALIVE) — теперь продаются
дёшево и честно.

1. Конфиг: `UNSTABLE_PRICE_STARS`(env, дефолт 7), `UNSTABLE_MAX_ALIVE`(env, дефолт 3).
2. Три «раздела» каталога (параметр `list`): 
   - `main` (он же 'black' — обратная совместимость): black-пул, регионы с alive **>** UNSTABLE_MAX, цена 20.
   - `unstable`: black-пул, регионы с alive в диапазоне **1..UNSTABLE_MAX**, цена 7, флаг предупреждения.
   - `white`: white-пул, цена 50 (как есть).
3. db.js:
   - `priceStars(section)`: main/black→20, unstable→UNSTABLE_PRICE_STARS(7), white→50.
   - `regionsSummary(section)` и `availabilityMap(section)`: main→`HAVING alive > UNSTABLE_MAX`;
     unstable→`HAVING alive BETWEEN 1 AND UNSTABLE_MAX` (black-пул); white→white-пул. (Существующий вызов
     без арг/=black/=main → main. Заменяет прежний MIN_ALIVE_TO_SELL-гейт для main; MIN_ALIVE больше не
     скрывает — хрупкие уходят в unstable.)
   - `quoteOrder/reserveOrder(userId, qtyMap, section)`: base=priceStars(section); валидация по
     availabilityMap(section); ДЕЛИВЕРИ-пул: main+unstable → black (list_type='black'), white → 'white'.
     createOrder listType: 'black' для main/unstable, 'white' для white (доставка из правильного пула;
     unstable по доставке = black, отличается только ценой/предупреждением на витрине).
4. server.js: POST /api/order принимает `list:'main'|'unstable'|'white'` (дефолт main); /api/regions?list=
   отдаёт соответствующие регионы + `price` + `unstable:true` для нестабильного (для предупреждения).
5. bot.js: команда `/unstable` и кнопка «⚠️ Нестабильные · 7⭐» в /start и /catalog → shopView(section=
   'unstable') (цена 7, регионы 1..3 живых, ЯВНОЕ предупреждение в тексте «⚠️ серверы могут в любой момент
   перестать работать, берёшь на свой риск»). Существующие main(20)/white(50) не тронуты.
6. Фронт mini app: добавить в переключатель каталогов третий вариант «⚠️ НЕСТАБИЛЬНЫЕ · от 7 ⭐» рядом с
   ОСНОВНОЙ/БЕЛЫЕ; при выборе — предупреждающая плашка «может в любой момент перестать работать»; цена/
   регионы из /api/regions?list=unstable; покупка POST {list:'unstable'}. Дизайн как везде.

## Тесты (E2E)
- Логгер: logAction пишет; actionsQuery фильтрует по user/action/admin; activityStats считает; middleware
  логирует command/callback (мок-апдейты); /admin/api/log и /activity под requireAdmin (не-админ 403).
- Нестабильные: priceStars('unstable')=7; regionsSummary('unstable') = только регионы 1..3 живых,
  regionsSummary('main') = только >3; reserveOrder unstable base=7, доставка из black-пула; white=50/main=20
  не тронуты; POST /api/order {list:'unstable'} создаёт заказ на 7.
- node --check; selftest/parse-check зелёные; оплата/цены/merge/free/bonus/рефералка/stability целы. Убрать
  тестовые БД.

## Приёмка
- Красивый логгер: все действия, фильтр по юзеру/id/действию, активность (сколько людей/заходов); видно
  действия админов. Открывается из /admin.
- Нестабильные регионы (≤3 живых) — отдельный раздел, 7⭐, с предупреждением; основной(20)/белые(50) целы.
