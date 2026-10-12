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

module.exports = { USERNAME_RE, hashPassword, verifyPassword, newToken, fixFileName };
