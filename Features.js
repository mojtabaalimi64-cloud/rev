        if (city && s.city !== city) return false;
        if (type && String(s.type || '').toLowerCase() !== type) return false;
        if (q && ((s.title || '') + ' ' + (s.address || '') + ' ' + (s.city || '')).indexOf(q) === -1) return false;
        return true;
      });
      $('#rf-list').innerHTML = list.length
        ? '<div class="grid">' + list.map(stationCard).join('') + '</div>'
        : '<div class="empty">جایگاهی با این فیلتر پیدا نشد. فهرست جایگاه‌ها در حال تکمیل است.</div>';
      if (map && window.L) {
        if (layer) map.removeLayer(layer);
        layer = L.layerGroup();
        list.forEach(function (s) {
          var la = num(s.lat), lo = num(s.lng);
          if (la == null || lo == null) return;
          L.circleMarker([la, lo], { radius: 8, color: '#080B0D', weight: 2, fillColor: '#39FF88', fillOpacity: 1 })
            .addTo(layer).bindPopup('<b>' + esc(s.title) + '</b><br>' + esc(s.city || '') + '<br><a href="' + esc(navUrl(s)) + '" target="_blank" rel="noopener">مسیریابی</a>');
        });
        layer.addTo(map);
      }
    }
    ['rf-city', 'rf-type', 'rf-q'].forEach(function (id) {
      var e = document.getElementById(id);
      if (e) e.addEventListener('input', renderList);
    });
    loadLeaflet().then(function () {
      map = makeMap('rf-smap', 32.4, 53.7, 5);
      renderList();
    });
  }

  /* ================= چسب افزونه به سایت ================= */
  function routeName() {
    var h = location.hash || '#/';
    return (h.split('/')[1] || '');
  }
  function app() { return document.getElementById('app'); }

  function renderMine() {
    var r = routeName(), a = app();
    if (!a) return;
    if (r === 'trip') { a.innerHTML = tripHtml(); tripBind(); window.scrollTo(0, 0); }
    else if (r === 'stations') { a.innerHTML = stationsHtml(); stationsBind(); window.scrollTo(0, 0); }
  }
  function injectHome() {
    var a = app();
    if (!a || routeName() !== '' || document.getElementById('rf-home')) return;
    var sec = document.createElement('section');
    sec.className = 'blk';
    sec.id = 'rf-home';
    sec.style.paddingTop = '0';
    sec.innerHTML = '<div class="wrap"><h2>سفر و شارژ</h2><div class="grid">'
      + '<a class="card" href="#/trip"><h3>برنامه‌ریزی سفر برقی</h3><p>مسافت جاده‌ای از نشان، توقف‌های شارژ و هزینه‌ی سفر — با فرمول رانش: مصرف = ظرفیت باتری ÷ برد واقعی × ۱۰۰.</p><span class="btn">شروع برنامه‌ریزی</span></a>'
      + '<a class="card" href="#/stations"><h3>جایگاه‌های شارژ</h3><p>جایگاه‌های شارژ عمومی روی نقشه، با فیلتر شهر و نوع شارژر و دکمه‌ی مسیریابی مستقیم.</p><span class="btn">پیدا کردن جایگاه</span></a>'
      + '</div></div>';
    a.appendChild(sec);
  }
  function footerLinks() {
    var f = document.querySelector('footer .foot');
    if (!f || document.getElementById('rf-foot')) return;
    var d = document.createElement('div');
    d.id = 'rf-foot';
    d.innerHTML = '<a href="#/trip">برنامه‌ریزی سفر</a> · <a href="#/stations">جایگاه‌های شارژ</a>';
    f.appendChild(d);
  }

  function observe() {
    var a = app();
    if (!a || !window.MutationObserver) return;
    var busy = false;
    var ob = new MutationObserver(function () {
      if (busy) return;
      var r = routeName();
      if ((r === 'trip' || r === 'stations') && !a.querySelector('[data-rf]')) {
        busy = true; renderMine(); setTimeout(function () { busy = false; }, 60);
      } else if (r === '') {
        injectHome();
      }
    });
    ob.observe(a, { childList: true });
  }

  function init() {
    injectCss();
    footerLinks();
    var src = window.RF_PREVIEW_DATA
      ? Promise.resolve(window.RF_PREVIEW_DATA)
      : fetch('content.json?' + Date.now()).then(function (r) { return r.json(); });
    src.then(function (c) { DATA = c || {}; })
      .catch(function () { DATA = {}; })
      .then(function () {
        observe();
        renderMine();
        injectHome();
      });
    window.addEventListener('hashchange', function () {
      setTimeout(function () { renderMine(); injectHome(); }, 30);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
