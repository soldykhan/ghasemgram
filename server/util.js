'use strict';

const crypto = require('crypto');

const USERNAME_RE = /^[a-zA-Z0-9_]{3,24}$/;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  try {
    const [salt, hash] = String(stored).split(':');
    const test = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), test);
  } catch {
    return false;
  }
}

function newToken() {
  return crypto.randomBytes(32).toString('hex');
}

// نام فایل ممکن است در اثر multipart با کدگذاری latin1 برسد؛ برای فارسی اصلاح می‌شود
function fixFileName(name) {
  try {
    if (/[\u0100-\uFFFF]/.test(name)) return name;
    const decoded = Buffer.from(name, 'latin1').toString('utf8');
    return decoded || name;
  } catch {
    return name;
  }
}

function generateRecoveryKey(length = 10000) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+[]{}|;:,.<>?';
  const bytes = crypto.randomBytes(length);
  let str = '';
  for (let i = 0; i < length; i++) {
    str += chars[bytes[i] % chars.length];
  }
  return str;
}

function formatRemainingBanTime(ms) {
  if (ms <= 0) return 'کمتر از ۱ دقیقه';
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  const parts = [];
  if (days > 0) parts.push(`${days} روز`);
  if (hours > 0) parts.push(`${hours} ساعت`);
  if (minutes > 0 && days === 0) parts.push(`${minutes} دقیقه`);
  if (parts.length === 0) return 'کمتر از ۱ دقیقه';
  return parts.join(' و ');
}

function parseDevice(userAgent) {
  if (!userAgent) return { browser: 'مرورگر وب', os: 'دستگاه نامشخص', is_mobile: false };
  const ua = String(userAgent);
  let browser = 'مرورگر وب';
  if (/edg/i.test(ua)) browser = 'Edge';
  else if (/opr|opera/i.test(ua)) browser = 'Opera';
  else if (/chrome|crios/i.test(ua)) browser = 'Chrome';
  else if (/firefox|fxios/i.test(ua)) browser = 'Firefox';
  else if (/safari/i.test(ua)) browser = 'Safari';

  let os = 'رایانه';
  let is_mobile = false;
  if (/android/i.test(ua)) { os = 'اندروید'; is_mobile = true; }
  else if (/iphone|ipad|ipod/i.test(ua)) { os = 'آیفون / آیپد'; is_mobile = true; }
  else if (/windows nt 10/i.test(ua)) os = 'ویندوز ۱۰ / ۱۱';
  else if (/windows/i.test(ua)) os = 'ویندوز';
  else if (/macintosh|mac os x/i.test(ua)) os = 'مک (macOS)';
  else if (/linux/i.test(ua)) os = 'لینوکس';

  return { browser, os, is_mobile };
}

module.exports = {
  USERNAME_RE,
  hashPassword,
  verifyPassword,
  newToken,
  fixFileName,
  generateRecoveryKey,
  formatRemainingBanTime,
  parseDevice,
};
