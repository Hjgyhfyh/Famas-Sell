'use strict';
/**
 * index.js — композиция FAMAS STORE (SPEC §10).
 * Порядок: db.init() → inventory.start() → createBot() → HTTP listen → long polling (если не SKIP_BOT).
 */
const config = require('./src/config');
const dbmod = require('./src/db');
const inventory = require('./src/inventory');
const botmod = require('./src/bot');
const saleslog = require('./src/saleslog');
const { createServer } = require('./src/server');

const ts = () => new Date().toISOString();
const log = (...a) => console.log(`[${ts()}]`, ...a);
const logErr = (...a) => console.error(`[${ts()}]`, ...a);

process.on('unhandledRejection', (err) => {
  logErr('unhandledRejection:', (err && err.stack) || err);
});
process.on('uncaughtException', (err) => {
  logErr('uncaughtException:', (err && err.stack) || err);
});

async function main() {
  log('⬛ FAMAS STORE ⁂ запуск…');

  if (!config.BOT_TOKEN && !config.SKIP_BOT) {
    logErr('FATAL: BOT_TOKEN не задан (см. .env.example). Для запуска без бота поставь SKIP_BOT=1.');
    process.exit(1);
  }

  // 1. БД
  dbmod.init();
  log(`БД готова: ${config.DB_PATH}`);

  // 2. Инвентарь (первое обновление + периодика)
  inventory.start();
  log(`Инвентарь: обновление каждые ${config.FETCH_INTERVAL_MIN} мин, источник: ${config.SOURCE_URL}`);

  // 3. Бот (без запуска polling)
  let bot = null;
  try {
    bot = botmod.createBot();
  } catch (e) {
    if (!config.SKIP_BOT) {
      logErr('FATAL: не удалось создать бота:', (e && e.message) || e);
      process.exit(1);
    }
    logErr('createBot не удался (SKIP_BOT=1 — продолжаем только с HTTP):', (e && e.message) || e);
  }

  // 4. HTTP
  const app = createServer(bot ? bot.api : null);
  const server = app.listen(config.PORT, '127.0.0.1', () => {
    log(`HTTP слушает http://127.0.0.1:${config.PORT} (публично: ${config.PUBLIC_BASE})`);
  });
  server.on('error', (e) => {
    logErr('FATAL: HTTP-сервер не поднялся:', (e && e.message) || e);
    process.exit(1);
  });

  // 5. Long polling
  if (!config.SKIP_BOT) {
    await bot.api.deleteWebhook({ drop_pending_updates: true }).catch(() => {});
    bot
      .start({
        allowed_updates: ['message', 'callback_query', 'pre_checkout_query'],
        onStart: (me) => {
          log(`Бот запущен: @${me.username} (long polling)`);
          // SPEC-LOG §5: гарантировать закреплённое сообщение статистики в канале продаж.
          // onStart => bot.init() уже прошёл, bot.api готов. Fire-and-forget, ошибки глотаем —
          // канал не должен влиять на работу бота. При выключенной фиче — no-op.
          saleslog.ensureStats(bot.api).catch(() => {});
        },
      })
      .catch((e) => logErr('Бот: polling завершился с ошибкой:', (e && e.message) || e));
  } else {
    log('SKIP_BOT=1 — бот не запускается, поднят только HTTP.');
  }

  // 6. Аккуратная остановка
  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`Получен ${sig}, останавливаемся…`);
    try {
      if (bot && !config.SKIP_BOT) await bot.stop();
    } catch (e) {
      logErr('Ошибка при остановке бота:', (e && e.message) || e);
    }
    try {
      server.close();
    } catch (e) {
      // уже закрыт
    }
    try {
      if (dbmod.db) dbmod.db.close();
    } catch (e) {
      // уже закрыта
    }
    log('Остановлено.');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  logErr('FATAL при старте:', (e && e.stack) || e);
  process.exit(1);
});
