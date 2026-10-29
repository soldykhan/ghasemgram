/**
 * قاسم‌گرام — ماژول PWA و وب‌پوش (Web Push Notifications)
 */
'use strict';

(function () {
  let deferredInstallPrompt = null;

  /* ═══════════════ توابع کمکی ═══════════════ */

  // تبدیل Base64 به Uint8Array برای کلید عمومی VAPID
  function urlB64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding)
      .replace(/-/g, '+')
      .replace(/_/g, '/');

    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);

    for (let i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  // بررسی اجرای اپلیکیشن در حالت مستقل (نصب‌شده)
  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      window.navigator.standalone === true ||
      document.referrer.includes('android-app://')
    );
  }

  /* ═══════════════ چرخه حیات Service Worker ═══════════════ */

  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker
          .register('/sw.js', { scope: '/' })
          .then((registration) => {
            console.log('[PWA] Service Worker فعال شد با دامنه:', registration.scope);

            // بررسی خودکار وضعیت سابسکرایبشن پس از لود کامل
            setTimeout(autoSyncPushSubscription, 1500);

            registration.addEventListener('updatefound', () => {
              const newWorker = registration.installing;
              if (newWorker) {
                newWorker.addEventListener('statechange', () => {
                  if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    console.log('[PWA] نسخه جدید سرویس‌ورکر دریافت شد.');
                  }
                });
              }
            });
          })
          .catch((err) => {
            console.warn('[PWA] خطا در ثبت Service Worker:', err);
          });

        // دریافت پیام‌های ارسالی از سرویس‌ورکر (مانند کلیک روی نوتیفیکیشن برای باز کردن چت)
        navigator.serviceWorker.addEventListener('message', (event) => {
          if (event.data && event.data.type === 'NAVIGATE_CHAT' && event.data.chatId) {
            console.log('[PWA] هدایت به چت از طریق کلیک روی اعلان:', event.data.chatId);
            if (typeof selectChat === 'function') {
              selectChat(event.data.chatId);
            }
          }
        });
      });
    }
  }

  /* ═══════════════ نصب PWA ═══════════════ */

  function updateInstallUI() {
    const installMenuBtn = document.getElementById('menu-install');
    const installSettingsItem = document.getElementById('item-install-pwa');

    if (isStandalone()) {
      if (installMenuBtn) installMenuBtn.classList.add('hidden');
      if (installSettingsItem) installSettingsItem.classList.add('hidden');
      return;
    }

    if (deferredInstallPrompt) {
      if (installMenuBtn) installMenuBtn.classList.remove('hidden');
      if (installSettingsItem) installSettingsItem.classList.remove('hidden');
    }
  }

  async function installPWA() {
    if (!deferredInstallPrompt) {
      const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
      if (isIOS) {
        alert(
          'برای نصب قاسم‌گرام روی آیفون:\n' +
          '۱. دکمه Share (اشتراک‌گذاری در پایین مرورگر سافاری) را بزنید.\n' +
          '۲. گزینه Add to Home Screen (افزودن به صفحه اصلی) را انتخاب کنید.'
        );
      } else {
        alert(
          'برای نصب قاسم‌گرام:\n' +
          'از منوی مرورگر خود (سه نقطه)، گزینه «نصب برنامه» یا «Install app» را انتخاب کنید.'
        );
      }
      return;
    }

    try {
      deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      console.log('[PWA] انتخاب کاربر برای نصب:', choice.outcome);
      if (choice.outcome === 'accepted') {
        deferredInstallPrompt = null;
        updateInstallUI();
      }
    } catch (err) {
      console.error('[PWA] خطا در نمایش پرامپت نصب:', err);
    }
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    console.log('[PWA] رویداد beforeinstallprompt ثبت شد.');
    updateInstallUI();
  });

  window.addEventListener('appinstalled', () => {
    console.log('[PWA] اپلیکیشن قاسم‌گرام با موفقیت نصب شد!');
    deferredInstallPrompt = null;
    updateInstallUI();
    if (typeof showToast === 'function') {
      showToast('🎉 قاسم‌گرام با موفقیت روی دستگاه شما نصب شد.');
    }
  });

  try {
    window.matchMedia('(display-mode: standalone)').addEventListener('change', () => {
      updateInstallUI();
    });
  } catch {}

  /* ═══════════════ ماژول Web Push ═══════════════ */

  async function getExistingPushSubscription() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    try {
      const reg = await navigator.serviceWorker.ready;
      return await reg.pushManager.getSubscription();
    } catch (e) {
      return null;
    }
  }

  async function subscribePush() {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      throw new Error('مرورگر شما از وب‌پوش پشتیبانی نمی‌کند.');
    }

    let permission = Notification.permission;
    if (permission === 'default') {
      permission = await Notification.requestPermission();
    }

    if (permission !== 'granted') {
      throw new Error('دسترسی اعلان‌ها توسط شما تایید نشد.');
    }

    // ۱. دریافت کلید عمومی VAPID از سرور
    const res = await api('/push/vapid-key');
    if (!res || !res.publicKey) {
      throw new Error('کلید عمومی سرور دریافت نشد.');
    }

    const applicationServerKey = urlB64ToUint8Array(res.publicKey);

    // ۲. ثبت اشتراک در PushManager مرورگر
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();

    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey
      });
    }

    // ۳. ارسال مشخصات سابسکرایبشن به سرور
    await api('/push/subscribe', {
      method: 'POST',
      body: { subscription: sub.toJSON() }
    });

    console.log('[WebPush] اشتراک با موفقیت در سرور ثبت شد.');
    updateNotificationUI();
    return sub;
  }

  async function unsubscribePush() {
    const sub = await getExistingPushSubscription();
    if (sub) {
      const endpoint = sub.endpoint;
      await sub.unsubscribe();
      await api('/push/unsubscribe', {
        method: 'POST',
        body: { endpoint }
      }).catch(() => {});
      console.log('[WebPush] اشتراک لغو شد.');
    }
    updateNotificationUI();
  }

  async function testPushNotification() {
    try {
      const res = await api('/push/test', { method: 'POST' });
      if (typeof showToast === 'function') {
        showToast(res.message || 'اعلان تستی ارسال شد.');
      } else {
        alert(res.message);
      }
    } catch (err) {
      alert('خطا در ارسال تست: ' + err.message);
    }
  }

  // همگام‌سازی خودکار در صورت ورود به حساب و داشتن دسترسی
  async function autoSyncPushSubscription() {
    if (!window.state || !window.state.token) return;
    if (Notification.permission === 'granted') {
      const sub = await getExistingPushSubscription();
      if (sub) {
        api('/push/subscribe', {
          method: 'POST',
          body: { subscription: sub.toJSON() }
        }).catch(() => {});
      }
    }
    updateNotificationUI();
  }

  // به‌روزرسانی وضعیت نمایشی اعلان‌ها در منوی تنظیمات
  async function updateNotificationUI() {
    const statusVal = document.getElementById('settings-notif-value');
    const toggle = document.getElementById('push-toggle');
    const warning = document.getElementById('push-denied-warning');
    const permStatus = document.getElementById('push-permission-status');

    if (!('Notification' in window) || !('PushManager' in window)) {
      if (statusVal) statusVal.textContent = 'غیرقابل پشتیبانی';
      if (toggle) {
        toggle.checked = false;
        toggle.disabled = true;
      }
      if (permStatus) permStatus.textContent = 'این مرورگر از وب‌پوش پشتیبانی نمی‌کند.';
      return;
    }

    const permission = Notification.permission;
    const sub = await getExistingPushSubscription();
    const isSubscribed = !!sub && permission === 'granted';

    if (toggle) {
      toggle.checked = isSubscribed;
      toggle.disabled = permission === 'denied';
    }

    if (warning) {
      warning.classList.toggle('hidden', permission !== 'denied');
    }

    if (statusVal) {
      if (permission === 'denied') {
        statusVal.textContent = 'مسدود شده';
      } else if (isSubscribed) {
        statusVal.textContent = 'فعال';
      } else {
        statusVal.textContent = 'غیرفعال';
      }
    }

    if (permStatus) {
      if (permission === 'denied') {
        permStatus.textContent = 'وضعیت: دسترسی در تنظیمات مرورگر مسدود شده است.';
        permStatus.style.color = '#e74c3c';
      } else if (isSubscribed) {
        permStatus.textContent = 'وضعیت: فعال و آماده دریافت پیام در پس‌زمینه.';
        permStatus.style.color = 'var(--accent)';
      } else {
        permStatus.textContent = 'وضعیت: غیرفعال. برای دریافت پیام‌های جدید کلید را فعال کنید.';
        permStatus.style.color = 'var(--text-secondary)';
      }
    }
  }

  /* ═══════════════ مقداردهی و اتصال رویدادهای UI ═══════════════ */

  registerServiceWorker();

  window.installPWA = installPWA;
  window.subscribePush = subscribePush;
  window.unsubscribePush = unsubscribePush;
  window.testPushNotification = testPushNotification;
  window.updateNotificationUI = updateNotificationUI;

  document.addEventListener('DOMContentLoaded', () => {
    // دکمه نصب در منوی دراپ‌داون
    const installMenuBtn = document.getElementById('menu-install');
    if (installMenuBtn) {
      installMenuBtn.addEventListener('click', () => {
        const menuDropdown = document.getElementById('menu-dropdown');
        if (menuDropdown) menuDropdown.classList.add('hidden');
        installPWA();
      });
    }

    // آیتم نصب در تنظیمات
    const installSettingsItem = document.getElementById('item-install-pwa');
    if (installSettingsItem) {
      installSettingsItem.addEventListener('click', installPWA);
    }

    // آیتم باز کردن مودال اعلان‌ها در تنظیمات
    const notifItem = document.getElementById('item-notifications');
    const notifModal = document.getElementById('modal-notifications');
    if (notifItem && notifModal) {
      notifItem.addEventListener('click', () => {
        updateNotificationUI();
        notifModal.classList.remove('hidden');
      });
    }

    // دکمه بستن مودال اعلان‌ها
    document.querySelectorAll('[data-close="modal-notifications"]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (notifModal) notifModal.classList.add('hidden');
      });
    });

    // سوئیچ فعال/غیرفعال‌سازی پوش
    const pushToggle = document.getElementById('push-toggle');
    if (pushToggle) {
      pushToggle.addEventListener('change', async () => {
        pushToggle.disabled = true;
        try {
          if (pushToggle.checked) {
            await subscribePush();
            if (typeof showToast === 'function') {
              showToast('🔔 دریافت اعلان‌های وب‌پوش با موفقیت فعال شد.');
            }
          } else {
            await unsubscribePush();
            if (typeof showToast === 'function') {
              showToast('🔕 اعلان‌های وب‌پوش غیرفعال گردید.');
            }
          }
        } catch (err) {
          alert('خطا در تنظیم اعلان: ' + err.message);
          pushToggle.checked = !pushToggle.checked;
        } finally {
          pushToggle.disabled = false;
          updateNotificationUI();
        }
      });
    }

    // دکمه ارسال پیام تستی
    const btnTestPush = document.getElementById('btn-test-push');
    if (btnTestPush) {
      btnTestPush.addEventListener('click', () => {
        testPushNotification();
      });
    }

    updateInstallUI();
    updateNotificationUI();
  });
})();
