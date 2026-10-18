// لودر maplibre از قسمت‌ها (مسیر مطلق)
(function(){
  var base = 'https://mojtabaalimi64-cloud.github.io/rev/';
  var parts = [];
  for(var i=1; i<=9; i++) parts.push(base + 'maplibre-gl.p'+i+'.js');
  var loaded = [];
  function loadNext(idx){
    if(idx >= parts.length){
      var code = loaded.join('');
      var s = document.createElement('script');
      s.textContent = code;
      document.head.appendChild(s);
      window.dispatchEvent(new Event('maplibre-ready'));
      return;
    }
    fetch(parts[idx]).then(function(r){return r.text();}).then(function(t){
      loaded[idx] = t;
      loadNext(idx+1);
    }).catch(function(e){
      console.error('خطا در لود قسمت', idx+1, e);
    });
  }
  loadNext(0);
})();
