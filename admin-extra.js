/* ============================================================
   REV — افزونه‌ی پنل مدیریت: تب «جایگاه‌های شارژ» + فیلد «کلید API نشان»
   فایل مستقل؛ در admin.html قبل از </body> لود شود:
   <script src="admin-extra.js"></script>
   هیچ‌کدام از توابع اصلی پنل را تغییر نمی‌دهد؛ فقط رویشان می‌نشیند.
   ============================================================ */
(function () {
  'use strict';

  /* --- تب و فرم جایگاه‌ها (با همان موتور فرم‌ساز پنل) --- */
  if (typeof TYPES !== 'undefined' && typeof TABS !== 'undefined') {
    TYPES.stations = {
      label: 'جایگاه‌های شارژ',
      one: 'جایگاه',
      fields: [
        ['title', 'نام جایگاه', 'text'],
        ['city', 'شهر', 'text'],
        ['type', 'نوع شارژ', 'sel:dc|شارژ سریع DC,ac|شارژ AC,both|AC و DC'],
        ['power', 'توان شارژر (kW، فقط عدد)', 'text'],
        ['connector', 'نوع کانکتور (مثلاً CCS2)', 'text'],
        ['address', 'آدرس', 'area'],
        ['lat', 'عرض جغرافیایی (مثل 35.6892)', 'text'],
        ['lng', 'طول جغرافیایی (مثل 51.3890)', 'text'],
        ['taxi', 'دسترسی', 'sel:no|عمومی,yes|مخصوص تاکسی — در سایت نمایش داده نمی‌شود'],
        ['source', 'منبع اطلاعات (مثلاً مپنا)', 'text'],
        ['updated', 'تاریخ به‌روزرسانی (مثلاً ۱۴۰۵/۰۷/۱۸)', 'text']
      ]
    };
    TABS.stations = 'جایگاه‌های شارژ';
  }

  /* --- فیلد کلید نشان در تب تنظیمات --- */
  function injectKeyField() {
    if (document.getElementById('nk')) return;
    var box = document.querySelector('#root .box');
    if (!box) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = '<label for="nk">کلید API نشان</label>'
      + '<input type="text" id="nk" dir="ltr" autocomplete="off" value="">'
      + '<p class="hint">کلید رایگان نشان (پنل توسعه‌دهندگان نشان) با سرویس‌های «مسیریابی» و «جست‌وجو» فعال؛ دامنه‌ی مجاز را روی دامنه‌ی سایت بگذارید. کلید فقط داخل content.json ذخیره و روی سایت خودتان استفاده می‌شود.</p>';
    box.appendChild(wrap);
    var inp = document.getElementById('nk');
    try { inp.value = (typeof c !== 'undefined' && c && c.neshanKey) || ''; } catch (e) {}
    inp.addEventListener('input', function () {
      try {
        if (typeof c !== 'undefined' && c) { c.neshanKey = inp.value.trim(); dirty = true; }
        var pub = document.querySelector('.pub');
        if (pub && pub.textContent.indexOf('●') === -1) pub.textContent += ' ●';
      } catch (e) {}
    });
  }

  /* --- روکش draw: مقداردهی stations، پاک‌سازی فیلد اضافی، تزریق فیلد کلید --- */
  if (typeof draw === 'function') {
    var _draw = draw;
    draw = function () {
      try {
        if (typeof c !== 'undefined' && c && !Array.isArray(c.stations)) c.stations = [];
        if (typeof edit !== 'undefined' && edit && typeof tab !== 'undefined' && tab === 'stations' && edit.item) delete edit.item.part;
      } catch (e) {}
      _draw();
      try {
        if (typeof tab !== 'undefined' && tab === 'set') injectKeyField();
        /* در فهرست جایگاه‌ها، شهر و تاریخ زیر هر ردیف دیده شود */
        if (typeof tab !== 'undefined' && tab === 'stations' && typeof c !== 'undefined' && c && !edit) {
          var rows = document.querySelectorAll('#root .row small');
          rows.forEach(function (sm, i) {
            var s = c.stations[i];
            if (s) sm.textContent = [s.city || '', s.updated || ''].filter(Boolean).join(' · ');
          });
        }
      } catch (e) {}
    };
  }
})();
