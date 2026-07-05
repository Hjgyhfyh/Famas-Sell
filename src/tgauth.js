'use strict';
/**
 * src/tgauth.js — проверка initData Telegram WebApp.
 * secret = HMAC_SHA256(key='WebAppData', msg=BOT_TOKEN);
 * data_check_string — отсортированные пары кроме hash; сравнение через timingSafeEqual;
 * auth_date не старше 24 часов.
 */
const crypto = require('node:crypto');
const config = require('./config');

const MAX_AGE_SEC = 24 * 3600;

/**
 * validateInitData(initDataString)
 *   -> {ok:false}
 *   -> {ok:true, user:{id,username,first_name}, auth_date}
 */
function validateInitData(initDataString) {
  try {
    if (!initDataString || typeof initDataString !== 'string') return { ok: false };
    if (!config.BOT_TOKEN) return { ok: false };

    const params = new URLSearchParams(initDataString);
    const gotHash = params.get('hash');
    if (!gotHash) return { ok: false };

    const pairs = [];
    for (const [k, v] of params.entries()) {
      if (k === 'hash') continue;
      pairs.push([k, v]);
    }
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join('\n');

    const secret = crypto.createHmac('sha256', 'WebAppData').update(config.BOT_TOKEN).digest();
    const calcHex = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

    const a = Buffer.from(calcHex, 'hex');
    const b = Buffer.from(String(gotHash), 'hex');
    if (a.length !== b.length || a.length === 0) return { ok: false };
    if (!crypto.timingSafeEqual(a, b)) return { ok: false };

    const authDate = Number(params.get('auth_date') || 0);
    const nowSec = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(authDate) || authDate <= 0) return { ok: false };
    if (nowSec - authDate > MAX_AGE_SEC) return { ok: false };

    let user = null;
    try {
      user = JSON.parse(params.get('user') || 'null');
    } catch (e) {
      user = null;
    }
    if (!user || !user.id) return { ok: false };

    return {
      ok: true,
      user: {
        id: Number(user.id),
        username: user.username || '',
        first_name: user.first_name || '',
      },
      auth_date: authDate,
    };
  } catch (e) {
    return { ok: false };
  }
}

module.exports = { validateInitData };
