# SPEC-CRYPTO — оплата через CryptoBot (Crypto Pay) как альтернатива Stars

Задача: при покупке дать ВЫБОР способа оплаты — ⭐ Telegram Stars (как сейчас) или 🪙 Crypto (через
@CryptoBot / Crypto Pay API). Самозанятость/СБП — позже. Только совместимые добавления; существующую
оплату Stars, free/bonus-логику, выдачу — не ломать. Русский.

## 0. Внешнее (от владельца)

- Токен Crypto Pay: создать в @CryptoBot → Crypto Pay → Create App → API Token. Кладётся в `.env`
  как `CRYPTO_BOT_TOKEN`. Пусто → способ «Crypto» ОТКЛЮЧЁН (показываем только Stars), бот работает.
- API base: mainnet `https://pay.crypt.bot/api`, testnet `https://testnet-pay.crypt.bot/api`
  (`CRYPTO_TESTNET=1` для теста). Заголовок `Crypto-Pay-API-Token: <token>`.

## 1. Конфиг (config.js + .env.example)

- `CRYPTO_BOT_TOKEN` (env, пусто = выключено).
- `CRYPTO_TESTNET` (дефолт 0).
- `CRYPTO_RUB_PER_STAR` (дефолт `1.6`) — курс: сумма к оплате в рублях = `stars * CRYPTO_RUB_PER_STAR`
  (CryptoBot умеет фиатный инвойс RUB с автоконвертацией в крипту на стороне плательщика).
- `CRYPTO_POLL_SEC` (дефолт 20) — период опроса статуса открытых крипто-инвойсов.

## 2. Новый модуль src/crypto.js (require ./config, ./db) — Crypto Pay клиент

```js
module.exports = { enabled, createInvoice, startPoller, checkInvoice }
enabled() -> bool                                  // CRYPTO_BOT_TOKEN задан
async createInvoice({orderId, stars, description}) -> {ok, payUrl, invoiceId} | {ok:false,error}
   // POST {api}/createInvoice: currency_type:'fiat', fiat:'RUB', amount: (stars*CRYPTO_RUB_PER_STAR).toFixed(2),
   //   description, payload: 'order:'+orderId, paid_btn_name:'callback'? (не обяз.), expires_in: 1800.
   //   Вернуть result.bot_invoice_url (или mini_app_invoice_url) + result.invoice_id.
async checkInvoice(invoiceId) -> 'paid'|'active'|'expired'|null   // getInvoices?invoice_ids=
startPoller(botApi, onPaid)                          // setInterval(CRYPTO_POLL_SEC) .unref():
   // взять из БД открытые крипто-инвойсы (pending, <30мин), getInvoices пачкой, для оплаченных → onPaid(order)
```
Всё в try/catch, ошибки глотать, наружу не ронять. Подпись вебхука не обязательна (используем поллинг).

## 3. Схема (миграция, идемпотентно)

- `ALTER TABLE orders ADD COLUMN pay_method TEXT` — 'stars' | 'crypto' (NULL у старых = stars).
- `ALTER TABLE orders ADD COLUMN crypto_invoice_id TEXT` — id инвойса Crypto Pay (для поллинга/дедупа).
- db-хелперы: `openCryptoOrders()` -> pending-заказы с pay_method='crypto' и crypto_invoice_id, созданные
  < 30 мин назад; `setOrderCryptoInvoice(orderId, invoiceId)`; `markOrderPaid` уже есть (переиспользовать,
  chargeId = 'CRYPTO:'+invoiceId).

## 4. Поток оплаты (bot.js + server.js)

Общее: цену/скидки (free→bonus→stars) считает `reserveOrder` как сейчас; `stars` — это «условные единицы»,
для крипты пересчитываются в RUB через курс. fully-free (stars=0) → выдача сразу, выбор способа не нужен.

### Бот (cb pay)
- Если `q.fullyFree` → как сейчас (мгновенная выдача).
- Иначе показать ВЫБОР способа (inline): `⭐ Оплатить <stars>` (cb `paystars`) и — если `crypto.enabled()`
  — `🪙 Оплатить криптой (~<rub>₽)` (cb `paycrypto`). Заказ создаём pending ДО выбора (или при выборе).
- `paystars` → текущий путь (replyWithInvoice XTR).
- `paycrypto` → `crypto.createInvoice({orderId, stars, description})`; сохранить
  `pay_method='crypto'`, `crypto_invoice_id`; ответить кнопкой-ссылкой «🪙 Оплатить» (url payUrl) +
  «Я оплатил / проверить» (cb `crchk:<orderId>`). При оплате (поллер или ручная проверка) → markOrderPaid
  (chargeId 'CRYPTO:'+id) → sendDelivery → saleslog.logSale(...,'paid') → уведомить.
- `startPoller` запускается в index.js (при `crypto.enabled()` и !SKIP_BOT), onPaid = выдать ключ
  (markOrderPaid если ещё pending + sendDelivery + saleslog + notify), идемпотентно (только если был pending).

### Server / mini app
- `POST /famas/api/order` — принять `method:'stars'|'crypto'` (дефолт 'stars'). Для 'crypto' и не-fullyFree:
  создать pending (pay_method='crypto'), `crypto.createInvoice`, вернуть `{ok, crypto:true, payUrl, orderId}`
  (без invoiceLink). Для 'stars' — как сейчас (invoiceLink). fully-free — как сейчас (free:true).
- mini app: экран выбора способа перед оплатой (⭐ Stars / 🪙 Crypto с ~₽). Stars → openInvoice(invoiceLink);
  Crypto → `Telegram.WebApp.openLink(payUrl)` (или openTelegramLink) + затем поллить `/api/me` до появления
  оплаченного заказа (как уже делается для success). После оплаты — экран успеха.
- `GET /famas/api/order-status?initData=&orderId=` (опц.) — вернуть статус заказа (для мини-аппа: pending/
  paid) чтобы показать успех после крипто-оплаты. Либо переиспользовать /api/me (появится активный ключ).

## 5. Тексты/UX

- Кнопки: `⭐ Telegram Stars` / `🪙 Криптой (USDT, TON…)`. Пометка «~<rub> ₽» у крипты. Русский, ЧБ-стиль.
- Инструкция при крипто-оплате: «оплати по кнопке в @CryptoBot, ключ придёт автоматически».

## 6. Тесты (E2E-агент, БЕЗ реальной оплаты)

- node --check; selftest/parse-check зелёные; миграция pay_method/crypto_invoice_id идемпотентна.
- crypto.enabled() false при пустом токене → способ Crypto не предлагается, всё работает на Stars;
  createInvoice/startPoller при !enabled — no-op.
- С МОК-fetch (застабить pay.crypt.bot): createInvoice возвращает payUrl+invoiceId, заказ помечается
  pay_method='crypto'+crypto_invoice_id; checkInvoice парсит 'paid'/'active'; startPoller при 'paid' зовёт
  onPaid → markOrderPaid(chargeId 'CRYPTO:..')+выдача, идемпотентно (повтор не выдаёт дважды).
- POST /api/order method:'crypto' → {crypto:true,payUrl,orderId} без invoiceLink; method:'stars' → invoiceLink;
  fully-free → free:true (способ игнор). Курс: stars*CRYPTO_RUB_PER_STAR корректно в RUB-строку.
- Существующая оплата Stars, free/bonus, выдача — не сломаны. Убрать тестовые БД.

## 7. Приёмка

- При платном заказе — выбор ⭐ Stars / 🪙 Crypto. Crypto создаёт инвойс в @CryptoBot, после оплаты ключ
  выдаётся автоматически (поллер). Пустой CRYPTO_BOT_TOKEN — крипта скрыта, Stars работает. Ничего старого
  не сломано.
