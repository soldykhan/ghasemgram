'use strict';

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const DATA_DIR = path.join(__dirname, '..', 'data');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');

// بررسی یا تولید کلیدهای دائمی VAPID
function initVapidKeys() {
  if (fs.existsSync(VAPID_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
      if (saved.publicKey && saved.privateKey) {
        return saved;
      }
    } catch (e) {
      console.warn('[Push] خطا در خواندن vapid.json، کلیدهای جدید تولید می‌شود:', e.message);
    }
  }

  const generated = webpush.generateVAPIDKeys();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(VAPID_FILE, JSON.stringify(generated, null, 2), 'utf8');
  console.log('🔑 کلیدهای VAPID جدید تولید و در data/vapid.json ذخیره شدند.');
  return generated;
}

const vapidKeys = initVapidKeys();

const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:support@ghasemgram.local';

webpush.setVapidDetails(
  VAPID_SUBJECT,
  vapidKeys.publicKey,
  vapidKeys.privateKey
);

function getVapidPublicKey() {
  return vapidKeys.publicKey;
}

/**
 * ارسال اعلان به یک سابسکرایبشن خاص با حذف خودکار در صورت باطل شدن (410/404)
 */
async function sendToSubscription(db, subRow, payload) {
  const pushSubscription = {
    endpoint: subRow.endpoint,
    keys: {
      p256dh: subRow.p256dh,
      auth: subRow.auth
    }
  };

  const options = {
    TTL: 24 * 60 * 60, // ۲۴ ساعت اعتبار در سرور پوش
    urgency: 'high'    // اولویت بالا برای پیام‌رسان
  };

  try {
    const res = await webpush.sendNotification(
      pushSubscription,
      JSON.stringify(payload),
      options
    );
    return { success: true, statusCode: res.statusCode };
  } catch (err) {
    if (err.statusCode === 410 || err.statusCode === 404) {
      console.log(`[Push] اشتراک منقضی‌شده حذف شد (کد ${err.statusCode}): ${subRow.endpoint}`);
      try {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(subRow.endpoint);
      } catch (dbErr) {
        console.error('[Push] خطا در حذف اشتراک باطل‌شده:', dbErr);
      }
    } else {
      console.warn(`[Push] خطا در ارسال به ${subRow.endpoint} (کد ${err.statusCode}):`, err.message);
    }
    return { success: false, statusCode: err.statusCode, error: err.message };
  }
}

/**
 * ارسال اعلان به تمامی دستگاه‌های فعال یک کاربر
 */
async function sendPushToUser(db, userId, payload) {
  if (!userId) return;
  try {
    const subs = db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?').all(userId);
    if (!subs || subs.length === 0) return;

    await Promise.allSettled(subs.map((s) => sendToSubscription(db, s, payload)));
  } catch (err) {
    console.error(`[Push] خطا در ارسال اعلان به کاربر ${userId}:`, err);
  }
}

/**
 * ارسال پوش‌نوتیفیکیشن پیام جدید به اعضای چت (به جز فرستنده و چت‌های بی‌صدا)
 */
async function notifyNewMessage(db, chat, sender, message) {
  if (!chat || !sender || !message) return;
  // پیام‌های بی‌صدا اعلان ندارند
  if (message.is_silent) return;

  try {
    // یافتن اعضای چت به جز فرستنده
    const members = db.prepare(`
      SELECT cm.user_id, cm.muted_until
      FROM chat_members cm
      WHERE cm.chat_id = ? AND cm.user_id != ?
    `).all(chat.id, sender.id);

    if (!members || members.length === 0) return;

    const now = Date.now();

    for (const m of members) {
      // بررسی بی‌صدا بودن چت برای این کاربر
      const isMuted = m.muted_until === -1 || (Number(m.muted_until) > 0 && Number(m.muted_until) > now);
      if (isMuted) continue;

      // بررسی بلاک بودن: آیا این کاربر فرستنده را بلاک کرده؟
      const isBlocked = db.prepare('SELECT 1 FROM blocked_users WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)').get(m.user_id, sender.id, sender.id, m.user_id);
      if (isBlocked) continue;

      // آماده‌سازی عنوان و متن پیام
      let title = sender.display_name || sender.username || 'قاسم‌گرام';
      if (chat.type === 'group' || chat.type === 'channel') {
        title = `${chat.title || 'گروه'}: ${sender.display_name}`;
      }

      let body = message.text || '';
      if (!body && message.file_id) {
        body = '📎 فایل ضمیمه ارسال کرد.';
      } else if (!body) {
        body = 'یک پیام جدید ارسال کرد.';
      }
      // کوتاه کردن متن طولانی برای نوتیفیکیشن
      if (body.length > 120) {
        body = body.substring(0, 117) + '...';
      }

      const payload = {
        title,
        body,
        icon: sender.avatar_file_id ? `/api/files/${sender.avatar_file_id}` : '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        tag: `chat-${chat.id}`,
        renotify: true,
        data: {
          url: `/#c=${chat.id}`,
          chatId: chat.id,
          messageId: message.id
        }
      };

      sendPushToUser(db, m.user_id, payload);
    }
  } catch (err) {
    console.error('[Push] خطا در آماده‌سازی اعلان پیام جدید:', err);
  }
}

module.exports = {
  getVapidPublicKey,
  sendPushToUser,
  notifyNewMessage,
  sendToSubscription
};
