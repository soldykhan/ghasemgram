/**
 * قاسم‌گرام — Service Worker
 * فراهم‌کننده قابلیت‌های PWA، پشتیبانی آفلاین و زیرساخت نوتیفیکیشن
 */

const CACHE_NAME = 'ghasemgram-cache-v1';

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

  // برای دارایی‌های استاتیک محلی (CSS, JS, Icons): Stale-While-Revalidate
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req)
          .then((networkRes) => {
            if (networkRes && networkRes.status === 200) {
              const clone = networkRes.clone();
              caches.open(CACHE_NAME).then((c) => c.put(req, clone));
            }
            return networkRes;
          })
          .catch(() => cached);

        return cached || fetchPromise;
      })
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
  let data = {};
  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data = { title: 'قاسم‌گرام', body: event.data.text() };
    }
  }

  const title = data.title || 'پیام جدید در قاسم‌گرام';
  const options = {
    body: data.body || 'یک پیام جدید دریافت کردید.',
    icon: data.icon || '/icons/icon-192.png',
    badge: data.badge || '/icons/icon-192.png',
    data: data.data || { url: '/' },
    dir: 'rtl',
    lang: 'fa',
    vibrate: [100, 50, 100]
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

// کلیک روی اعلان: باز کردن یا فوکوس روی پنجره برنامه
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(targetUrl) && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});
