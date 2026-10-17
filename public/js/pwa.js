/**
 * قاسم‌گرام — ماژول PWA و چرخه نصب
 */
'use strict';

(function () {
  let deferredInstallPrompt = null;

  // بررسی اجرای اپلیکیشن در حالت مستقل (نصب‌شده)
  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.matchMedia('(display-mode: fullscreen)').matches ||
      window.navigator.standalone === true ||
      document.referrer.includes('android-app://')
    );
  }

  // ثبت Service Worker
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker
          .register('/sw.js', { scope: '/' })
          .then((registration) => {
            console.log('[PWA] Service Worker فعال شد با دامنه:', registration.scope);

            // بررسی به‌روزرسانی سرویس ورکر در پس‌زمینه
            registration.addEventListener('updatefound', () => {
              const newWorker = registration.installing;
              if (newWorker) {
                newWorker.addEventListener('statechange', () => {
                  if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                    console.log('[PWA] نسخه جدید در دسترس است.');
                  }
                });
              }
            });
          })
          .catch((err) => {
            console.warn('[PWA] خطا در ثبت Service Worker:', err);
          });
      });
    }
  }

  // نمایش یا عدم نمایش دکمه‌های نصب
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

  // فراخوانی پنجره نصب با کلیک کاربر
  async function installPWA() {
    if (!deferredInstallPrompt) {
      // اگر پرامپت خودکار مرورگر در دسترس نباشد (مثلاً مرورگرهای خاص یا iOS)
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
          'از منوی مرورگر خود (سه نقطه بالا/پایین)، گزینه «نصب برنامه» یا «Install app» را انتخاب کنید.'
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

  // دریافت رویداد قبل از نصب از سوی مرورگر (کروم/اندروید/دسکتاپ)
  window.addEventListener('beforeinstallprompt', (e) => {
    // جلوگیری از نمایش بنر پیش‌فرض مزاحم مرورگر
    e.preventDefault();
    deferredInstallPrompt = e;
    console.log('[PWA] رویداد beforeinstallprompt ثبت شد.');
    updateInstallUI();
  });

  // رویداد اتمام موفقیت‌آمیز نصب
  window.addEventListener('appinstalled', () => {
    console.log('[PWA] اپلیکیشن قاسم‌گرام با موفقیت نصب شد!');
    deferredInstallPrompt = null;
    updateInstallUI();
    if (typeof showToast === 'function') {
      showToast('🎉 قاسم‌گرام با موفقیت روی دستگاه شما نصب شد.');
    }
  });

  // تغییر وضعیت بین مرورگر و حالت مستقل
  try {
    window.matchMedia('(display-mode: standalone)').addEventListener('change', () => {
      updateInstallUI();
    });
  } catch {}

  // شروع اولیه
  registerServiceWorker();

  // قرار دادن متد سراسری برای دکمه‌های رابط کاربری
  window.installPWA = installPWA;

  document.addEventListener('DOMContentLoaded', () => {
    const installMenuBtn = document.getElementById('menu-install');
    if (installMenuBtn) {
      installMenuBtn.addEventListener('click', () => {
        // بستن دراپ‌داون منو و اجرای نصب
        const menuDropdown = document.getElementById('menu-dropdown');
        if (menuDropdown) menuDropdown.classList.add('hidden');
        installPWA();
      });
    }

    const installSettingsItem = document.getElementById('item-install-pwa');
    if (installSettingsItem) {
      installSettingsItem.addEventListener('click', () => {
        installPWA();
      });
    }

    updateInstallUI();
  });
})();
