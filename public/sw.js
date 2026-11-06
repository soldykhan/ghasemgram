/**
 * قاسم‌گرام — Service Worker
 * فراهم‌کننده قابلیت‌های PWA، پشتیبانی آفلاین و زیرساخت نوتیفیکیشن
 */

const CACHE_NAME = 'ghasemgram-cache-v11';

// لیست فایل‌های پوسته اصلی برنامه (App Shell) برای کش اولیه
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/constants.js',
  '/js/state.js',
  '/js/voice.js',
  '/js/call.js',
  '/js/messages.js',
  '/js/chats.js',
  '/js/modals.js',
  '/js/app.js',
  '/js/pwa.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png',
  '/icons/apple-touch-icon.png'
];

// رویداد نصب: دانلود و کش فایل‌های ضروری پوسته
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // کش کردن امن تک‌تک فایل‌ها تا خطای یک فایل مانع نصب نشود
      return Promise.allSettled(
        PRECACHE_ASSETS.map((url) =>
          cache.add(url).catch((err) => {
            console.warn('[SW] خطا در پیش‌کش کردن فایل:', url, err);
          })
        )
      );
    })
  );
});

// رویداد فعال‌سازی: کنترل فوری صفحات و پاکسازی نسخه‌های قدیمی کش
self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      self.clients.claim(),
      caches.keys().then((keys) =>
        Promise.all(
          keys.map((key) => {
            if (key !== CACHE_NAME) {
              console.log('[SW] پاکسازی نسخه قدیمی کش:', key);
              return caches.delete(key);
            }
          })
        )
      )
    ])
  );
});

// رویداد Fetch: مدیریت درخواست‌ها (شبکه و کش)
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // فقط درخواست‌های GET با پروتکل http/https را مدیریت می‌کنیم
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // درخواست‌های سوکت و ای‌پی‌آی و آپلودها همواره مستقیم از شبکه دریافت می‌شوند
  if (
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/uploads/')
  ) {
    return;
  }

  // برای درخواست‌های ناوبری (صفحات HTML): استراتژی Network-First با فال‌بک به کش
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.status === 200) {
            const clone = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone));
          }
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html')))
    );
    return;
  }

  // برای دارایی‌های استاتیک محلی (CSS, JS, Icons): اولویت با شبکه (Network First) با فال‌بک به کش در صورت آفلاین
  if (url.origin === self.location.origin) {
    event.respondWith(
      fetch(req)
        .then((networkRes) => {
          if (networkRes && networkRes.status === 200) {
            const clone = networkRes.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, clone));
          }
          return networkRes;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // برای منابع خارجی (مثل فونت‌های گوگل): Cache First با آپدیت در پس‌زمینه
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((networkRes) => {
        if (networkRes && networkRes.status === 200) {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((c) => c.put(req, clone));
        }
        return networkRes;
      });
    })
  );
});

// زیرساخت دریافت پوش‌نوتیفیکیشن
self.addEventListener('push', (event) => {
  if (!event.data) return;

  let data = {};
  try {
    data = event.data.json();
  } catch {
    data = { title: 'قاسم‌گرام', body: event.data.text() };
  }

  // ۱. لغو یا انصراف تماس (تماس بی‌پاسخ ماند یا قطع شد)
  if (data.type === 'cancel_call') {
    const callTag = data.tag || (data.callId ? `incoming-call-${data.callId}` : null);
    event.waitUntil(
      self.registration.getNotifications().then((notifications) => {
        notifications.forEach((notif) => {
          if (!callTag || notif.tag === callTag) {
            notif.close();
          }
        });
      })
    );
    return;
  }

  // ۲. تماس صوتی ورودی (بیدار کردن دستگاه و زنگ خوردن در پس‌زمینه)
  if (data.type === 'incoming_call') {
    const callId = data.callId || (data.data && data.data.callId);
    const chatId = data.chatId || (data.data && data.data.chatId);
    const callerName = data.callerName || (data.data && data.data.callerName) || 'یک کاربر';
    const callerAvatar = data.callerAvatar || (data.data && data.data.callerAvatar) || '/icons/icon-192.png';
    const targetUrl = `/#c=${chatId || 0}&call=${callId}`;

    const callOptions = {
      body: `📞 ${callerName} در حال تماس با شما است...`,
      icon: callerAvatar,
      badge: '/icons/icon-192.png',
      tag: `incoming-call-${callId}`,
      renotify: true,
      requireInteraction: true, // تا زمان پاسخ یا رد، در صفحه قفل/نوتیفیکیشن بماند
      // الگوی ویبره طولانی شبیه به زنگ تلفن
      vibrate: [500, 250, 500, 250, 500, 250, 500, 250, 500],
      dir: 'rtl',
      lang: 'fa',
      data: {
        type: 'incoming_call',
        callId: callId,
        chatId: chatId,
        callerName: callerName,
        url: targetUrl
      },
      actions: [
        { action: 'answer', title: '📞 پاسخ' },
        { action: 'reject', title: '❌ رد تماس' }
      ]
    };

    event.waitUntil(
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
        // ارسال پیام به تب‌های باز برنامه
        clientList.forEach((c) => {
          c.postMessage({
            type: 'INCOMING_CALL_PUSH',
            callId,
            chatId,
            callerName,
            callerAvatar
          });
        });

        // نمایش اعلان با اولویت بالا و ویبره حتی اگر پنجره بسته باشد
        return self.registration.showNotification(`📞 تماس صوتی از ${callerName}`, callOptions);
      })
    );
    return;
  }

  // ۳. پیام‌های متنی و عادی چت
  const title = data.title || 'پیام جدید در قاسم‌گرام';
  const chatId = (data.data && data.data.chatId) || data.chatId || 0;
  const targetUrl = (data.data && data.data.url) || data.url || (chatId ? `/#c=${chatId}` : '/');

  const options = {
    body: data.body || 'یک پیام جدید دریافت کردید.',
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/icon-192.png',
    tag: data.tag || (chatId ? `chat-${chatId}` : 'general'),
    renotify: data.renotify !== false,
    vibrate: data.vibrate || [120, 60, 120],
    dir: 'rtl',
    lang: 'fa',
    data: {
      url: targetUrl,
      chatId: chatId,
      messageId: (data.data && data.data.messageId) || data.messageId
    },
    actions: [
      { action: 'open', title: 'مشاهده گفتگو' }
    ]
  };

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      // اگر کاربر در حال حاضر روی همین صفحه و چت فوکوس فعال دارد، نیازی به پراندن اعلان سیستمی نیست
      const isActivelyChatting = clientList.some((c) => {
        return c.focused && c.visibilityState === 'visible' && chatId && c.url.includes(`c=${chatId}`);
      });

      if (isActivelyChatting) {
        // پیام را فقط به صورت داخلی برای پخش صدای سبک ارسال می‌کنیم
        clientList.forEach((c) => {
          c.postMessage({ type: 'INCOMING_PUSH_ACTIVE', chatId, data });
        });
        return;
      }

      return self.registration.showNotification(title, options);
    })
  );
});

// کلیک روی اعلان یا دکمه‌های اقدام (پاسخ/رد تماس/باز کردن گفتگو)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notifData = event.notification.data || {};
  const action = event.action;

  // ۱. رد تماس از طریق اعلان پس‌زمینه
  if (action === 'reject' && notifData.callId) {
    event.waitUntil(
      fetch(`/api/calls/${encodeURIComponent(notifData.callId)}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      }).catch((err) => {
        console.warn('[SW] خطا در ارسال رد تماس به سرور:', err);
      })
    );
    return;
  }

  const targetUrl = notifData.url || '/';
  const chatId = notifData.chatId;
  const isCall = notifData.type === 'incoming_call';
  const callId = notifData.callId;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
      // اگر پنجره‌ای از برنامه باز است، فوکوس کن
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          await client.focus();

          if (isCall && callId) {
            client.postMessage({
              type: 'ANSWER_CALL',
              callId: callId,
              chatId: chatId,
              url: targetUrl
            });
          } else if (chatId) {
            client.postMessage({
              type: 'NAVIGATE_CHAT',
              chatId: chatId,
              url: targetUrl
            });
          }
          return;
        }
      }

      // در غیر این صورت پنجره جدید باز کن
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
