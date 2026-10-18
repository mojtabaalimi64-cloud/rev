/* REV app-mode bridge: keeps app navigation and presentation consistent without changing normal website visits. */
(function () {
  'use strict';
  var params = new URLSearchParams(location.search);
  var isAppHome = /\/mobile-app\/index\.html$/.test(location.pathname);
\n  var appMode = params.get('app') === '1' || isAppHome;
  if (!appMode) return;
  document.documentElement.setAttribute('data-rev-app', '1');
  var style = document.createElement('style');
  style.id = 'rev-app-mode-style';
  style.textContent = `
    html[data-rev-app="1"],html[data-rev-app="1"] body{background:#fff!important;color:#17253b!important;color-scheme:light!important}
    html[data-rev-app="1"] body{font-family:Vazirmatn,Vazir,IRANSansX,Tahoma,sans-serif!important;padding-bottom:calc(82px + env(safe-area-inset-bottom))!important}
    html[data-rev-app="1"] body header,html[data-rev-app="1"] body .head,html[data-rev-app="1"] body .header,html[data-rev-app="1"] body .topbar{background:#fff!important;color:#17253b!important;border-color:#e2eaf4!important}
    html[data-rev-app="1"] body main,html[data-rev-app="1"] body .wrap,html[data-rev-app="1"] body section{color:#17253b}
    html[data-rev-app="1"] body h1,html[data-rev-app="1"] body h2,html[data-rev-app="1"] body h3,html[data-rev-app="1"] body p,html[data-rev-app="1"] body label,html[data-rev-app="1"] body small{color:inherit}
    html[data-rev-app="1"] body .panel,html[data-rev-app="1"] body .card,html[data-rev-app="1"] body .tile,html[data-rev-app="1"] body .box,html[data-rev-app="1"] body .trip-card,html[data-rev-app="1"] body .section-card{background:#fff!important;color:#17253b!important;border-color:#e2eaf4!important;box-shadow:0 4px 18px rgba(20,41,59,.055)!important}
    html[data-rev-app="1"] body button,html[data-rev-app="1"] body .btn.primary,html[data-rev-app="1"] body [type=submit],html[data-rev-app="1"] body .primary-btn{background:#0866ff!important;color:#fff!important;border-color:#0866ff!important}
    html[data-rev-app="1"] body input,html[data-rev-app="1"] body select,html[data-rev-app="1"] body textarea{background:#fff!important;color:#17253b!important;border-color:#d5e2ec!important}
    #rev-app-bottom-nav{position:fixed;z-index:99999;left:0;right:0;bottom:0;padding:7px 8px calc(7px + env(safe-area-inset-bottom));display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:4px;background:rgba(255,255,255,.97);border-top:1px solid #e2eaf4;box-shadow:0 -4px 18px rgba(20,41,59,.07);backdrop-filter:blur(14px)}
    #rev-app-bottom-nav a{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;padding:5px 2px;border-radius:11px;color:#64748b!important;font-size:10px;text-decoration:none!important}
    #rev-app-bottom-nav a span{font-size:19px;line-height:1.3}
    #rev-app-bottom-nav a[aria-current="page"]{color:#0866ff!important;background:#eaf1ff!important;font-weight:800}
    #rev-app-bottom-nav a:focus-visible{outline:2px solid #0866ff;outline-offset:2px}
    @media(min-width:700px){html[data-rev-app="1"] body{padding-bottom:82px!important}#rev-app-bottom-nav{left:50%;right:auto;transform:translateX(-50%);width:min(560px,100%);border:1px solid #e2eaf4;border-bottom:0;border-radius:16px 16px 0 0}}
  `;
  document.head.appendChild(style);
  function addAppFlag(raw) {
    try {
      var u = new URL(raw, location.href);
      if (u.origin !== location.origin || u.pathname.indexOf('/api/') >= 0 || u.hash && u.pathname === location.pathname) return raw;
      u.searchParams.set('app', '1');
      return u.href;
    } catch (_) { return raw; }
  }
  document.querySelectorAll('a[href]').forEach(function (a) {
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#' || /^javascript:|^mailto:|^tel:/i.test(href)) return;
    a.setAttribute('href', addAppFlag(href));
  });
  var current = location.pathname;
  var items = [
    {href:'/rev/mobile-app/index.html',label:'خانه',icon:'⌂',match:/\/mobile-app\/index\.html$/},
    {href:'/rev/nearby-map.html',label:'نقشه',icon:'⌖',match:/\/nearby-map\.html$/},
    {href:'/rev/travel-plans.html',label:'سفرها',icon:'🧭',match:/\/(trip|travel-plans|trips)\.html$/},
    {href:'/rev/businesses.html',label:'خدمات',icon:'🔧',match:/\/businesses\.html$/}
  ];
  if (isAppHome) { var oldNav = document.querySelector('.bottom-nav'); if (oldNav) oldNav.remove(); }
  var nav = document.createElement('nav');
  nav.id = 'rev-app-bottom-nav';
  nav.setAttribute('aria-label','ناوبری اصلی اپ REV');
  items.forEach(function (item) {
    var a = document.createElement('a');
    a.href = item.href + '?app=1';
    a.innerHTML = '<span aria-hidden="true">' + item.icon + '</span><span>' + item.label + '</span>';
    if (item.match.test(current)) a.setAttribute('aria-current','page');
    nav.appendChild(a);
  });
  document.body.appendChild(nav);
})();