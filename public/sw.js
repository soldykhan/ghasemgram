/**
 * قاسم‌گرام — Service Worker
 * فراهم‌کننده قابلیت‌های PWA، پشتیبانی آفلاین و زیرساخت نوتیفیکیشن
 */

const CACHE_NAME = 'ghasemgram-cache-v7';

// لیست فایل‌های پوسته اصلی برنامه (App Shell) برای کش اولیه
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/css/style.css',
  '/js/constants.js',
  '/js/state.js',
  '/js/voice.js',
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

// کلیک روی اعلان: باز کردن یا فوکوس روی پنجره برنامه
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const notifData = event.notification.data || {};
  const targetUrl = notifData.url || '/';
  const chatId = notifData.chatId;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clientList) => {
      // ۱. اگر پنجره‌ای از برنامه باز است، فوکوس کن و پیام برو به چت بفرست
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          await client.focus();
          if (chatId) {
            client.postMessage({
              type: 'NAVIGATE_CHAT',
              chatId: chatId,
              url: targetUrl
            });
          }
          return;
        }
      }

      // ۲. در غیر این صورت پنجره جدید باز کن
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
