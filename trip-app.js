
/*
 * REV EV Trip Planner
 * Route: public OSRM routing service.
 * Charging stations: REV Cloudflare D1 API first, then dedicated REV Online Stations Worker.
 * No private API keys are embedded in this public page.
 */
const REV_API = "https://rev-api.mojtaba-alimi64.workers.dev";
const map = L.map("map").setView([32.4, 53.7], 5);
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
}).addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const stationLayer = L.layerGroup().addTo(map);
const businessLayer = L.layerGroup().addTo(map);
window.revAltRouteLayer=L.layerGroup().addTo(map);
function setMapLayerVisibility(layer,visible){if(visible){if(!map.hasLayer(layer))layer.addTo(map)}else if(map.hasLayer(layer)){map.removeLayer(layer)}}

let lastRoute = null;
const $ = id => document.getElementById(id);
const toggleStations=$("toggleStations");
const toggleBusinesses=$("toggleBusinesses");
if(toggleStations)toggleStations.addEventListener("change",()=>setMapLayerVisibility(stationLayer,toggleStations.checked));
if(toggleBusinesses)toggleBusinesses.addEventListener("change",()=>setMapLayerVisibility(businessLayer,toggleBusinesses.checked));
(function initRoutePreferences(){
  const ids=["routeMajorRoads","routeFastest","routeAvoidLocal"];
  try{const saved=JSON.parse(localStorage.getItem("rev_route_preferences_v1")||"{}");ids.forEach(id=>{const el=$(id);if(el&&typeof saved[id]==="boolean")el.checked=saved[id];});}catch(e){}
  ids.forEach(id=>{const el=$(id);if(el)el.addEventListener("change",()=>{const prefs={};ids.forEach(key=>{const input=$(key);if(input)prefs[key]=input.checked;});try{localStorage.setItem("rev_route_preferences_v1",JSON.stringify(prefs));}catch(e){}});});
})();
function setStatus(message){ $("status").textContent = message; }
function num(id, fallback){ const n=Number($(id).value); return Number.isFinite(n)&&n>0?n:fallback; }
function escapeHTML(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
async function geocode(place){
  const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=ir&q="+encodeURIComponent(place);
  const r=await fetch(url,{headers:{"Accept":"application/json"}});
  if(!r.ok) throw new Error("خطا در پیدا کردن مکان: "+place);
  const data=await r.json();
  if(!data.length) throw new Error("مکان پیدا نشد: "+place+"؛ نام شهر یا نشانی دقیق‌تری وارد کنید.");
  return [Number(data[0].lat),Number(data[0].lon)];
}
function routePreference(id, fallback=false){const el=$(id);return el?el.checked:fallback;}
function scoreRoute(route, prefs){
  const km=Math.max(0.1,(Number(route.distance)||0)/1000);
  const minutes=Math.max(1,(Number(route.duration)||0)/60);
  const steps=(route.legs||[]).flatMap(leg=>leg.steps||[]);
  const roads=steps.map(s=>String(s.name||"")+" "+String(s.ref||"")).join(" ").toLowerCase();
  const majorTerms=/(آزادراه|بزرگراه|جاده اصلی|راه اصلی|highway|motorway|trunk|expressway|autostrada|\b[ema]-?\d+\b|\b[ema]\s?\d+\b)/i;
  const localTerms=/(کوچه|محلی|خاکی|دسترسی محلی|service road|residential|living_street|track|unclassified)/i;
  let score=prefs.fastest?minutes:km;
  if(prefs.major&&majorTerms.test(roads))score*=0.88;
  if(prefs.avoidLocal&&localTerms.test(roads))score*=1.22;
  return score;
}
async function getRoute(start,end){
  const coords=`${start[1]},${start[0]};${end[1]},${end[0]}`;
  const prefs={major:routePreference("routeMajorRoads",true),fastest:routePreference("routeFastest",true),avoidLocal:routePreference("routeAvoidLocal",false)};
  const url=`https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=true&alternatives=3`;
  const r=await fetch(url);
  if(!r.ok)throw new Error("سرویس مسیریابی پاسخ نداد.");
  const data=await r.json();
  if(data.code!=="Ok"||!data.routes?.length)throw new Error("مسیر جاده‌ای پیدا نشد.");
  const ranked=data.routes.map((route,index)=>({route,index,score:scoreRoute(route,prefs)})).sort((a,b)=>a.score-b.score);
  window.revRouteCandidates=ranked.map(x=>x.route);
  const requested=Number.isInteger(window.revSelectedRouteIndex)?window.revSelectedRouteIndex:0;
  const selected=ranked[Math.max(0,Math.min(ranked.length-1,requested))].route;
  selected.revAlternativesCount=ranked.length;
  selected.revPreferenceLabel=prefs.major?"با اولویت جاده‌های اصلی":"بر اساس زمان/مسافت";
  selected.revComparedRoutes=ranked.map((x,i)=>({distance:x.route.distance,duration:x.route.duration,selected:x.route===selected,index:i}));
  return selected;
}
function renderRouteVisuals(routes, selectedRoute){
  const panel=$("routeVisualPanel");
  if(!panel||!routes||!routes.length||!window.revAltRouteLayer||!window.L)return;
  panel.hidden=false;
  const colors=["#1684e8","#f59e0b","#10a477","#8b5cf6"];
  const usable=routes.map((route,index)=>({route,index,coords:route.geometry&&route.geometry.coordinates||[]})).filter(x=>x.coords.length>1);
  if(!usable.length)return;
  window.revAltRouteLayer.clearLayers();
  usable.forEach(({route,index,coords})=>{
    const selected=route===selectedRoute;
    const line=L.polyline(coords.map(p=>[p[1],p[0]]),{
      color:colors[index%colors.length],
      weight:selected?9:6,
      opacity:selected?1:.78,
      lineCap:"round",
      lineJoin:"round",
      bubblingMouseEvents:false,
      interactive:true
    }).addTo(window.revAltRouteLayer);
    line.on("click",function(){
      if(route===lastRoute||route===selectedRoute)return;
      window.revSelectedRouteIndex=index;
      planTrip();
    });
    line.on("mouseover",function(){if(!selected)line.setStyle({weight:9,opacity:1});});
    line.on("mouseout",function(){if(!selected)line.setStyle({weight:6,opacity:.78});});
    line.bindTooltip("مسیر "+(index+1)+(selected?" · انتخاب‌شده":" · برای انتخاب لمس کنید"),{sticky:true,direction:"top"});
  });
  const first=usable[0].coords;
  const last=first[first.length-1];
  L.marker([first[0][1],first[0][0]]).addTo(window.revAltRouteLayer).bindPopup("مبدأ");
  L.marker([last[1],last[0]]).addTo(window.revAltRouteLayer).bindPopup("مقصد");
  const bounds=L.latLngBounds(usable.flatMap(x=>x.coords.filter((_,n)=>n%Math.max(1,Math.floor(x.coords.length/250))===0).map(p=>[p[1],p[0]])));
  if(bounds.isValid())map.fitBounds(bounds,{padding:[24,24]});
  setTimeout(()=>map.invalidateSize(),160);
}
function haversine(a,b){
  const rad=x=>x*Math.PI/180, R=6371;
  const dLat=rad(b[0]-a[0]),dLon=rad(b[1]-a[1]);
  const x=Math.sin(dLat/2)**2+Math.cos(rad(a[0]))*Math.cos(rad(b[0]))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}
function pointSegmentDistanceKm(p,a,b){
  // Local equirectangular approximation for point-to-segment distance.
  const lat0=(p[0]+a[0]+b[0])/3*Math.PI/180;
  const xy=q=>[q[1]*111.32*Math.cos(lat0),q[0]*110.57];
  const P=xy(p),A=xy(a),B=xy(b),dx=B[0]-A[0],dy=B[1]-A[1];
  const den=dx*dx+dy*dy;
  const t=den?Math.max(0,Math.min(1,((P[0]-A[0])*dx+(P[1]-A[1])*dy)/den)):0;
  return Math.hypot(P[0]-(A[0]+t*dx),P[1]-(A[1]+t*dy));
}
function distanceToRoute(point, routeCoords){
  let min=Infinity;
  for(let i=1;i<routeCoords.length;i++){
    const a=[routeCoords[i-1][1],routeCoords[i-1][0]],b=[routeCoords[i][1],routeCoords[i][0]];
    min=Math.min(min,pointSegmentDistanceKm(point,a,b));
    if(min<0.3) break;
  }
  return min;
}
function parseConnectors(value){
  if(Array.isArray(value)) return value.map(x=>typeof x==='string'?x:(x?.title||x?.name||x?.type||'')).filter(Boolean);
  if(typeof value==='string'){
    try{const j=JSON.parse(value);if(Array.isArray(j))return parseConnectors(j)}catch{}
    return value.split(/[,،;|]/).map(x=>x.trim()).filter(Boolean);
  }
  return [];
}
function normalizeRevStation(raw){
  const lat=Number(raw.latitude??raw.lat??raw.Latitude), lon=Number(raw.longitude??raw.lon??raw.lng??raw.Longitude);
  if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return null;
  return {
    id:String(raw.id??raw.source_id??raw.ID??`${lat},${lon}`),
    name:raw.name||raw.title||raw.station_name||"ایستگاه شارژ",
    address:raw.address||raw.AddressInfo?.AddressLine1||"",
    lat,lon,
    operator:raw.operator||raw.operator_name||"",
    status:raw.status||raw.status_name||"وضعیت نامشخص",
    power:Number(raw.power_kw??raw.power??raw.PowerKW)>0?Number(raw.power_kw??raw.power??raw.PowerKW):null,
    connectors:parseConnectors(raw.connectors??raw.connector_types),
    url:raw.source_url||raw.url||`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}`,
    source:raw.source||"REV",
    updatedAt:raw.updated_at||raw.updatedAt||raw.last_updated||raw.lastUpdated||raw.modified_at||""
  };
}
function formatStationUpdatedAt(value){
  if(!value)return "تاریخ به‌روزرسانی نامشخص";
  const time=Date.parse(value);
  if(!Number.isFinite(time))return "تاریخ به‌روزرسانی نامشخص";
  return "آخرین به‌روزرسانی: "+new Date(time).toLocaleDateString("fa-IR");
}
function routeFilter(stations,routeCoords,radiusKm){
  return stations.filter(Boolean)
    .map(s=>({...s,routeDistance:distanceToRoute([s.lat,s.lon],routeCoords)}))
    .filter(s=>s.routeDistance<=radiusKm)
    .sort((a,b)=>a.routeDistance-b.routeDistance);
}
async function getRevStations(routeCoords,radiusKm){
  const r=await fetch(REV_API+"/api/stations",{method:"GET",cache:"no-store",headers:{"Accept":"application/json"}});
  if(!r.ok)throw new Error("Cloudflare stations API HTTP "+r.status);
  const payload=await r.json();
  // Accept several common Worker response shapes.
  const candidates=[payload,payload?.data,payload?.result,payload?.data?.data];
  let rows=[];
  for(const item of candidates){
    if(Array.isArray(item)){rows=item;break;}
    if(Array.isArray(item?.stations)){rows=item.stations;break;}
    if(Array.isArray(item?.results)){rows=item.results;break;}
  }
  return routeFilter(rows.map(normalizeRevStation),routeCoords,radiusKm);
}
function routeSamplePoints(routeCoords,spacingKm=20,maxPoints=80){
  // Sample evenly along the entire route. The previous implementation sampled
  // only up to 18 points, leaving large gaps on long trips.
  if(!routeCoords.length)return [];
  const points=routeCoords.map(c=>[Number(c[1]),Number(c[0])]); // [lat, lon]
  if(points.length===1)return [points[0]];
  const cumulative=[0];
  for(let i=1;i<points.length;i++) cumulative[i]=cumulative[i-1]+haversine(points[i-1],points[i]);
  const total=cumulative[cumulative.length-1];
  if(!Number.isFinite(total)||total===0)return [points[0],points[points.length-1]];
  const count=Math.min(maxPoints,Math.max(2,Math.ceil(total/Math.max(1,spacingKm))+1));
  const samples=[];
  let seg=1;
  for(let n=0;n<count;n++){
    const target=total*n/(count-1);
    while(seg<cumulative.length-1&&cumulative[seg]<target)seg++;
    const prev=seg-1, span=cumulative[seg]-cumulative[prev];
    const t=span?(target-cumulative[prev])/span:0;
    samples.push([
      points[prev][0]+(points[seg][0]-points[prev][0])*t,
      points[prev][1]+(points[seg][1]-points[prev][1])*t
    ]);
  }
  return samples;
}
function sampleRouteCoordinates(routeCoords,maxPoints=16){
  // Reduce the number of coordinates sent to the Worker while preserving the
  // route's full length and direction. Input/output format remains [lon, lat].
  if(!Array.isArray(routeCoords)||routeCoords.length===0)return [];
  if(routeCoords.length<=maxPoints)return routeCoords;
  const points=routeCoords.map(c=>[Number(c[1]),Number(c[0])]); // [lat, lon] for distance calculations
  const cumulative=[0];
  for(let i=1;i<points.length;i++) cumulative[i]=cumulative[i-1]+haversine(points[i-1],points[i]);
  const total=cumulative[cumulative.length-1];
  if(!Number.isFinite(total)||total<=0){
    const out=[];
    for(let i=0;i<maxPoints;i++)out.push(routeCoords[Math.round(i*(routeCoords.length-1)/(maxPoints-1))]);
    return out;
  }
  const out=[];let seg=1;
  for(let n=0;n<maxPoints;n++){
    const target=total*n/(maxPoints-1);
    while(seg<cumulative.length-1&&cumulative[seg]<target)seg++;
    const prev=seg-1,span=cumulative[seg]-cumulative[prev];
    const t=span?(target-cumulative[prev])/span:0;
    const lat=points[prev][0]+(points[seg][0]-points[prev][0])*t;
    const lon=points[prev][1]+(points[seg][1]-points[prev][1])*t;
    out.push([lon,lat]); // Worker expects [longitude, latitude]
  }
  return out;
}
async function getIranStations(routeCoords,radiusKm){
  // Public route planning intentionally uses only the approved REV station API.
  // Do not silently merge content.json seeds, public OSM listings, or stale external cache.
  try{
    const stations=await getRevStations(routeCoords,radiusKm);
    window.revStationCacheNote="";
    window.revStationSourceWarning=stations.length
      ? ""
      : "در بانک تأییدشده REV ایستگاهی در محدوده انتخاب‌شده پیدا نشد؛ این نتیجه به معنی نبود شارژر واقعی نیست.";
    return stations.map(s=>({...s,source:"REV"}));
  }catch(e){
    console.warn("REV approved station API unavailable:",e);
    window.revStationCacheNote="";
    window.revStationSourceWarning="بانک تأییدشده REV موقتاً در دسترس نیست؛ برای جلوگیری از نمایش داده تأییدنشده، فهرست جایگزین بارگذاری نشد.";
    return [];
  }
}

async function renderFuelStations(routeCoords,radiusKm){
  // Petrol stations are map markers only; they are not charging stops or a fuel-stop plan.
  // Keep the Overpass query small enough to avoid timeouts, and try the backup
  // provider when the primary responds successfully but has no matching records.
  const sampled=sampleRouteCoordinates(routeCoords,Number(radiusKm)>10?12:20);
  if(sampled.length<2)return 0;
  const radiusKmEffective=Math.max(2,Math.min(50,Number(radiusKm)||5));
  const radiusMeters=radiusKmEffective*1000;
  const query='[out:json][timeout:30];('+sampled.map(p=>'nwr(around:'+radiusMeters+','+Number(p[1]).toFixed(5)+','+Number(p[0]).toFixed(5)+')[amenity=fuel];').join('')+');out center tags;';
  const endpoints=["https://overpass-api.de/api/interpreter","https://overpass.kumi.systems/api/interpreter"];
  let elements=[],lastError=null,hadValidResponse=false;
  for(const endpoint of endpoints){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),30000);
    try{
      const response=await fetch(endpoint,{method:"POST",mode:"cors",cache:"no-store",signal:controller.signal,headers:{"Content-Type":"application/x-www-form-urlencoded;charset=UTF-8","Accept":"application/json"},body:"data="+encodeURIComponent(query)});
      if(!response.ok)throw new Error("HTTP "+response.status);
      const payload=await response.json();
      if(!Array.isArray(payload.elements))throw new Error("پاسخ جایگاه‌های سوخت معتبر نیست");
      hadValidResponse=true;
      elements.push(...payload.elements);
      // Empty data from one mirror is not proof that the other mirror is empty too.
      if(payload.elements.length)break;
    }catch(e){lastError=e;}
    finally{clearTimeout(timer);}
  }
  if(!hadValidResponse){
    console.warn("REV fuel station map unavailable:",lastError);
    return 0;
  }
  const seen=new Set();
  const stations=elements.map(el=>{
    const lat=Number(el.lat??el.center?.lat),lon=Number(el.lon??el.center?.lon);
    if(!Number.isFinite(lat)||!Number.isFinite(lon))return null;
    const key=lat.toFixed(4)+","+lon.toFixed(4);
    if(seen.has(key))return null;seen.add(key);
    const offRoute=distanceToRoute([lat,lon],routeCoords);
    if(offRoute>radiusKmEffective)return null;
    return {lat,lon,name:el.tags?.name||el.tags?.brand||el.tags?.operator||"جایگاه سوخت",brand:el.tags?.brand||"",operator:el.tags?.operator||"",offRoute,kind:el.type,id:el.id};
  }).filter(Boolean).sort((a,b)=>a.offRoute-b.offRoute);
  stations.slice(0,150).forEach(s=>{
    const marker=L.circleMarker([s.lat,s.lon],{radius:8,color:"#20140a",weight:2,fillColor:"#ff9f43",fillOpacity:1}).addTo(stationLayer);
    marker.bindPopup('<b>⛽ '+escapeHTML(s.name)+'</b><br>جایگاه سوخت در نزدیکی مسیر<br>فاصله مستقیم از مسیر: '+s.offRoute.toFixed(1)+' کیلومتر<br>'+(s.operator?'اپراتور: '+escapeHTML(s.operator)+'<br>':'')+'<a target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat='+s.lat+'&mlon='+s.lon+'#map=16/'+s.lat+'/'+s.lon+'">مشاهده در OpenStreetMap</a>');
  });
  console.info("REV fuel stations shown on map:",stations.length);
  if(!stations.length)window.revFuelStationWarning="در داده‌های نقشه، جایگاه ثبت‌شده‌ای در شعاع "+radiusKmEffective+" کیلومتری مسیر پیدا نشد.";
  else window.revFuelStationWarning="";
  return stations.length;
}
async function renderBusinessDirectory(routeCoords,radiusKm){
 businessLayer.clearLayers();const box=$('businessDirectory');if(!box)return;box.innerHTML='<div class="sub">در حال بررسی فهرست تعمیرگاه‌ها و فروشگاه‌های قطعات…</div>';
 try{const response=await fetch('./content.json?v='+Date.now(),{cache:'no-store'});if(!response.ok)throw new Error('فهرست عمومی در دسترس نیست');const data=await response.json();
 const entries=[...(Array.isArray(data.serviceCenters)?data.serviceCenters.map(x=>({...x,_category:'تعمیرگاه مجاز',_key:'serviceCenters'})):[]),...(Array.isArray(data.partsStores)?data.partsStores.map(x=>({...x,_category:'فروشگاه قطعات',_key:'partsStores'})):[])];const metrics=routeMetrics(routeCoords);
 const near=entries.map(x=>({...x,lat:Number(x.latitude??x.lat),lon:Number(x.longitude??x.lon)})).filter(x=>(x.status==='verified'||x.testProfile===true)&&Number.isFinite(x.lat)&&Number.isFinite(x.lon)&&x.lat>=-90&&x.lat<=90&&x.lon>=-180&&x.lon<=180).map(x=>({...x,...stationAlongRouteKm({lat:x.lat,lon:x.lon},metrics),_ratingId:String(x.id||((x.title||x.name||"فروشگاه")+"|"+(x.address||""))).slice(0,240)})).filter(x=>x.offRouteKm<=Math.min(50,Number(radiusKm)||5));
 // Ratings contribute to ordering, with Bayesian smoothing so one vote has limited influence.
 await Promise.all(near.slice(0,30).map(async x=>{try{const rr=await fetch("https://rev-ratings-api.mojtaba-alimi64.workers.dev/api/ratings?type=store&id="+encodeURIComponent(x._ratingId),{cache:"no-store"});const jj=await rr.json();if(rr.ok&&jj.success){x._ratingCount=Number(jj.count)||0;x._ratingAverage=jj.average==null?null:Number(jj.average);const n=x._ratingCount,avg=x._ratingAverage===null?3.5:x._ratingAverage;x._ratingScore=(avg*n+3.5*3)/(n+3);}else{x._ratingCount=0;x._ratingAverage=null;x._ratingScore=3.5;}}catch(e){x._ratingCount=0;x._ratingAverage=null;x._ratingScore=3.5;}}));
 near.sort((a,b)=>(b._ratingScore-a._ratingScore)||((a.offRouteKm-b.offRouteKm)*0.15)||a.routeKm-b.routeKm);
 near.forEach(x=>{const color=x._key==='serviceCenters'?'#ff9f43':'#c084fc';const marker=L.circleMarker([x.lat,x.lon],{radius:8,color:'#101820',weight:2,fillColor:color,fillOpacity:1}).addTo(businessLayer);const profile=x.profileSlug?'<br><a href="./businesses.html?id='+encodeURIComponent(x.profileSlug)+'">مشاهده پروفایل REV</a>':'';const link=x.website?'<br><a target="_blank" rel="noopener" href="'+escapeHTML(x.website)+'">وب‌سایت / سفارش</a>':'';marker.bindPopup((x.image?'<img src="'+escapeHTML(x.image)+'" alt="" style="display:block;width:190px;max-height:120px;object-fit:cover;border-radius:8px;margin-bottom:7px">':'')+'<b>'+escapeHTML(x.title||x.name)+'</b><br>'+escapeHTML(x._category)+(x.testProfile?'<br><b>پروفایل آزمایشی REV</b>':'')+'<br>'+escapeHTML(x.address||'نشانی ثبت نشده')+'<br>★ '+(x._ratingAverage==null?'بدون امتیاز':Number(x._ratingAverage).toLocaleString('fa-IR',{maximumFractionDigits:1})+'/۵ · '+Number(x._ratingCount||0).toLocaleString('fa-IR')+' رأی')+'<br>'+escapeHTML(x.phone||'شماره تماس ثبت نشده')+profile+link)});
 if(!near.length){box.innerHTML='<div class="sub">فعلاً کسب‌وکار تأییدشده‌ای در فهرست عمومی REV و در شعاع انتخاب‌شده از مسیر ثبت نشده است. فقط موارد تأییدشده نمایش داده می‌شوند.</div>';return}
 box.innerHTML=near.map((x,i)=>'<div class="station">'+(x.image?'<img src="'+escapeHTML(x.image)+'" alt="'+escapeHTML(x.title||x.name)+'" loading="lazy" style="width:100%;max-height:170px;object-fit:cover;border-radius:9px;margin-bottom:8px">':'')+'<strong>'+(i===0?'★ پیشنهاد برتر · ':'')+escapeHTML(x._category)+' · '+escapeHTML(x.title||x.name)+(x.testProfile?' <span class="pill">تست REV</span>':'')+' <span class="pill" style="display:inline-block">'+(x._ratingCount?('★ '+(x._ratingAverage==null?'—':x._ratingAverage.toFixed(1))+'/۵ · '+x._ratingCount+' رأی'):'بدون امتیاز')+'</span></strong><small>'+escapeHTML(x.address||'نشانی ثبت نشده')+'</small><div class="sub">'+escapeHTML(x.phone||'شماره تماس ثبت نشده')+' · فاصله از مسیر '+x.offRouteKm.toFixed(1)+' کیلومتر</div>'+(x.website?'<a target="_blank" rel="noopener" href="'+escapeHTML(x.website)+'">وب‌سایت / سفارش</a>':'')+(x.profileSlug?' · <a href="./businesses.html?id='+encodeURIComponent(x.profileSlug)+'">پروفایل</a>':'')+'</div>').join('');
 near.forEach((x,i)=>{const item=box.querySelectorAll(".station")[i];if(!item)return;const ratingBox=document.createElement("div");ratingBox.addEventListener("click",event=>event.stopPropagation());item.appendChild(ratingBox);if(window.REVRating)window.REVRating.mount(ratingBox,"store",x._ratingId);});
 }catch(e){box.innerHTML='<div class="sub">فهرست تعمیرگاه‌ها و فروشگاه‌ها بارگذاری نشد. '+escapeHTML(e.message||'')+'</div>'}
}

function routeMetrics(routeCoords){
  const points=routeCoords.map(c=>[Number(c[1]),Number(c[0])]);
  const cumulative=[0];
  for(let i=1;i<points.length;i++) cumulative[i]=cumulative[i-1]+haversine(points[i-1],points[i]);
  return {points,cumulative,total:cumulative[cumulative.length-1]||0};
}
function stationAlongRouteKm(station,metrics){
  const p=[station.lat,station.lon];
  let best=Infinity,bestKm=0;
  for(let i=1;i<metrics.points.length;i++){
    const a=metrics.points[i-1],b=metrics.points[i];
    const lat0=(p[0]+a[0]+b[0])/3*Math.PI/180;
    const xy=q=>[q[1]*111.32*Math.cos(lat0),q[0]*110.57];
    const P=xy(p),A=xy(a),B=xy(b),dx=B[0]-A[0],dy=B[1]-A[1];
    const den=dx*dx+dy*dy;
    const t=den?Math.max(0,Math.min(1,((P[0]-A[0])*dx+(P[1]-A[1])*dy)/den)):0;
    const dist=Math.hypot(P[0]-(A[0]+t*dx),P[1]-(A[1]+t*dy));
    if(dist<best){
      best=dist;
      bestKm=metrics.cumulative[i-1]+(metrics.cumulative[i]-metrics.cumulative[i-1])*t;
    }
  }
  return {routeKm:bestKm,offRouteKm:best};
}
function estimateChargingMinutes(batteryKwh,arrivalSoc,targetSoc,stationPowerKw){
  const battery=Number(batteryKwh),from=Number(arrivalSoc),to=Number(targetSoc),power=Number(stationPowerKw);
  if(!Number.isFinite(battery)||battery<=0||!Number.isFinite(from)||!Number.isFinite(to)||from<0||to>100||to<=from||!Number.isFinite(power)||power<=0)return null;
  // Generic DC fast-charge taper. This is an estimate, not a vehicle-specific charging curve.
  const bands=[{limit:50,factor:0.8},{limit:80,factor:0.6},{limit:100,factor:0.35}];
  let soc=from,minutes=0;
  for(const band of bands){
    const end=Math.min(to,band.limit);
    if(end<=soc)continue;
    const energy=battery*(end-soc)/100;
    minutes+=energy/(power*band.factor)*60;
    soc=end;
    if(soc>=to)break;
  }
  if(to>from)minutes+=5; // connection / authentication overhead
  return Math.max(1,Math.ceil(minutes));
}

function buildChargingPlan(stations,routeCoords,routeKm,params){
  const {battery,soc,consumption,reserve,targetSoc,radius}=params;
  const metrics=routeMetrics(routeCoords);
  const usableRange=pct=>Math.max(0,(pct-reserve)/100*battery/consumption*100);
  const candidates=stations.map(s=>({...s,...stationAlongRouteKm(s,metrics)}))
    .filter(s=>s.routeKm>2&&s.routeKm<routeKm-2&&s.offRouteKm<=radius+0.5)
    .sort((a,b)=>a.routeKm-b.routeKm);
  if(routeKm<=usableRange(soc)) return {status:'ok',message:`با شارژ اولیه ${soc}%، برد محاسباتی برای رسیدن به مقصد کافی است؛ توقف شارژ اجباری برآورد نمی‌شود.`,stops:[],candidates};
  if(!candidates.length) return {status:'alert',message:'مسافت از برد قابل‌استفاده بیشتر است، اما شارژر میانی در داده‌های فعلی پیدا نشد. اطلاعات نقشه ممکن است ناقص باشد؛ این نتیجه به معنی نبود شارژر واقعی نیست.',stops:[],candidates};
  const stops=[];
  let currentKm=0,currentSoc=soc;
  const remaining=[...candidates];
  for(let iteration=0;iteration<20;iteration++){
    const range=usableRange(currentSoc);
    if(routeKm-currentKm<=range) break;
    const reachable=remaining.filter(st=>st.routeKm>currentKm+2&&st.routeKm-currentKm<=range+0.1);
    if(!reachable.length){
      return {status:'alert',message:`از کیلومتر ${Math.round(currentKm)} به بعد، با شارژ فعلی و ذخیره ${reserve}% شارژر ثبت‌شده‌ای در برد قابل‌دسترسی پیدا نشد. ادامه مسیر را ایمن فرض نکنید.`,stops,candidates};
    }
    const nextRange=usableRange(targetSoc);
    // Prefer the furthest reachable station from which the destination or at least
    // another listed station is reachable after charging to targetSoc.
    let chosen=null;
    const viable=reachable.filter(st=>{
      const destinationReachable=routeKm-st.routeKm<=nextRange;
      const nextStationReachable=remaining.some(n=>n.routeKm>st.routeKm+2&&n.routeKm-st.routeKm<=nextRange+0.1);
      return destinationReachable||nextStationReachable;
    });
    if(viable.length){
      // Ratings only influence the choice among stations that preserve route feasibility.
      chosen=viable.sort((a,b)=>{
        const sa=(Number(a._ratingScore)||3.5)+0.2*(a.routeKm/Math.max(routeKm,1));
        const sb=(Number(b._ratingScore)||3.5)+0.2*(b.routeKm/Math.max(routeKm,1));
        return sb-sa;
      })[0];
    }
    if(!chosen) chosen=reachable[reachable.length-1];
    const legKm=chosen.routeKm-currentKm;
    const arrivalSoc=currentSoc-(legKm*consumption/battery);
    // The range test should protect reserve, but report an alert if data rounding or
    // route geometry causes the calculated arrival SOC to fall below reserve.
    if(arrivalSoc<reserve-0.5) return {status:'alert',message:'به‌دلیل فاصله ایستگاه‌ها یا خطای داده مسیر، رسیدن به ایستگاه بعدی با ذخیره ایمنی قابل تأیید نیست.',stops,candidates};
    const energyToTarget=Math.max(0,(targetSoc-arrivalSoc)/100*battery);
    const chargeMinutes=estimateChargingMinutes(battery,arrivalSoc,targetSoc,chosen.power);
    stops.push({...chosen,legKm,arrivalSoc,targetSoc,energyToTarget,chargeMinutes});
    currentKm=chosen.routeKm;
    currentSoc=targetSoc;
    for(let i=remaining.length-1;i>=0;i--) if(remaining[i].routeKm<=currentKm+2) remaining.splice(i,1);
    if(iteration===19) return {status:'alert',message:'تعداد توقف‌های محاسباتی از حد مجاز گذشت؛ داده مسیر یا ایستگاه‌ها را بررسی کنید.',stops,candidates};
  }
  const reached=routeKm-currentKm<=usableRange(currentSoc)+0.1;
  return {status:reached?'ok':'alert',message:reached?`برآورد اولیه: ${stops.length} توقف شارژ با هدف ${targetSoc}% و ذخیره ایمنی ${reserve}%.`:'با ایستگاه‌های پیدا‌شده، رسیدن به مقصد با ذخیره ایمنی قابل تأیید نیست. ممکن است پوشش شارژرها ناقص باشد.',stops,candidates};
}
function renderChargingPlan(plan){
  const box=document.createElement('section');box.className='plan-box';
  const heading=document.createElement('h2');heading.textContent='برنامه پیشنهادی توقف و شارژ';box.appendChild(heading);
  const intro=document.createElement('div');intro.className=plan.status==='ok'?'plan-ok':'plan-alert';intro.textContent=plan.message;box.appendChild(intro);
  plan.stops.forEach((s,i)=>{
    const item=document.createElement('div');item.className='plan-stop';
    const time=s.chargeMinutes==null?'زمان شارژ قابل برآورد نیست؛ توان ایستگاه ثبت نشده':`زمان شارژ تقریبی ${s.chargeMinutes} دقیقه`;
    item.innerHTML=`<strong>توقف ${i+1}: ${escapeHTML(s.name)}</strong>
      <div class="plan-meta">حدود کیلومتر ${Math.round(s.routeKm)} مسیر · ${s.legKm.toFixed(0)} کیلومتر از توقف قبلی · ${s.routeDistance.toFixed(1)} کیلومتر فاصله مستقیم از جاده</div>
      <div class="plan-meta">شارژ هنگام رسیدن: حدود ${Math.round(s.arrivalSoc)}٪ · هدف شارژ: ${s.targetSoc}٪ · انرژی نظری موردنیاز: ${s.energyToTarget.toFixed(1)} kWh</div>
      <div class="plan-meta">${time}${s.power?` · توان ثبت‌شده ${s.power} kW` : ''}</div>
      <div class="plan-meta">زمان شارژ، در صورت نمایش، با فرض میانگین ۷۰٪ توان نامی تخمین زده شده؛ زمان واقعی می‌تواند بیشتر باشد.</div>`;
    box.appendChild(item);
  });
  const note=document.createElement('div');note.className='plan-meta';note.style.marginTop='8px';
  note.textContent='این برنامه فقط برآورد انرژی بر اساس مسیر و داده‌های موجود است. فعال بودن شارژر، سازگاری کانکتور، ترافیک، آب‌وهوا، سرعت و مصرف واقعی تضمین نمی‌شود؛ پیش از حرکت وضعیت ایستگاه‌ها را بررسی کنید.';
  box.appendChild(note);return box;
}

function maneuverText(step){
  const m=step?.maneuver||{}, type=m.type||"", mod=m.modifier||"";
  const names={
    "depart":"حرکت از مبدأ","arrive":"رسیدن به مقصد","turn":"پیچیدن",
    "new name":"ادامه در مسیر","continue":"ادامه مسیر","merge":"ادغام با مسیر",
    "on ramp":"ورود به رمپ","off ramp":"خروج از رمپ","fork":"انتخاب شاخه مسیر",
    "end of road":"انتهای مسیر","roundabout":"ورود به میدان","rotary":"عبور از میدان",
    "roundabout turn":"خروج از میدان","notification":"ادامه مسیر","exit roundabout":"خروج از میدان"
  };
  const directions={"left":"به چپ","slight left":"اندکی به چپ","sharp left":"به چپ تند","right":"به راست","slight right":"اندکی به راست","sharp right":"به راست تند","straight":"مستقیم","uturn":"دوربرگردان"};
  let text=names[type]||"ادامه مسیر";
  if(directions[mod]) text += " " + directions[mod];
  if(type==="roundabout"||type==="rotary"){
    if(m.exit) text += "، خروجی شماره "+m.exit;
  }
  return text;
}
function maneuverSymbol(step){
  const m=step?.maneuver||{}, type=m.type||"", mod=m.modifier||"";
  if(type==="arrive") return "⚑";
  if(type==="depart") return "●";
  if(type.includes("roundabout")||type==="rotary") return "⟳";
  if(mod.includes("left")) return "↰";
  if(mod.includes("right")) return "↱";
  if(mod==="uturn"||type==="turnaround") return "↶";
  return "↑";
}
function renderDirections(route){
  const panel=$("directionsPanel");
  panel.innerHTML='<div class="directions-head"><h2>راهنمای مسیر</h2><span class="sub" id="directionsSummary"></span></div>';
  const steps=(route?.legs||[]).flatMap(leg=>leg.steps||[]);
  if(!steps.length){
    $("directionsSummary").textContent="راهنمای پیچ‌ها در دسترس نیست";
    const msg=document.createElement("div");msg.className="sub";msg.textContent="سرویس مسیریابی مسیر را برگرداند، اما دستورهای مرحله‌ای در دسترس نیستند.";
    panel.appendChild(msg);return;
  }
  const total=steps.length;
  $("directionsSummary").textContent=total+" مرحله · بررسی "+(route.revAlternativesCount||1)+" مسیر جایگزین";
  const list=document.createElement("div");
  steps.forEach((step,index)=>{
    const item=document.createElement("div");item.className="direction-item";
    const icon=document.createElement("div");icon.className="direction-icon";icon.textContent=maneuverSymbol(step);
    const main=document.createElement("div");main.className="direction-main";
    const text=document.createElement("span");text.textContent=maneuverText(step);main.appendChild(text);
    if(step.name){
      const road=document.createElement("span");road.className="direction-road";road.textContent="مسیر: "+step.name;main.appendChild(road);
    } else if(index===0){
      const road=document.createElement("span");road.className="direction-road";road.textContent="نام خیابان در داده نقشه ثبت نشده";main.appendChild(road);
    }
    const meta=document.createElement("div");meta.className="direction-meta";
    const km=(Number(step.distance)||0)/1000;
    meta.textContent=km>=1?km.toFixed(1)+" km":Math.round(Number(step.distance)||0)+" m";
    item.append(icon,main,meta);list.appendChild(item);
  });
  panel.appendChild(list);
  const note=document.createElement("div");note.className="sub";note.style.marginTop="10px";
  note.textContent="این فهرست راهنمای مسیر برنامه‌ریزی‌شده است؛ ناوبری زنده با موقعیت GPS، هشدار تغییر مسیر و ترافیک لحظه‌ای در فاز اپلیکیشن اضافه می‌شود.";
  panel.appendChild(note);
}
function bearingDegrees(a,b){
  const rad=x=>x*Math.PI/180, deg=x=>x*180/Math.PI;
  const p1=rad(a[0]),p2=rad(b[0]),dl=rad(b[1]-a[1]);
  const y=Math.sin(dl)*Math.cos(p2);
  const x=Math.cos(p1)*Math.sin(p2)-Math.sin(p1)*Math.cos(p2)*Math.cos(dl);
  return (deg(Math.atan2(y,x))+360)%360;
}
function compassDirection(deg){
  if(!Number.isFinite(deg))return "نامشخص";
  return ["شمال","شمال‌شرق","شرق","جنوب‌شرق","جنوب","جنوب‌غرب","غرب","شمال‌غرب"][Math.round(deg/45)%8];
}
function weatherDescription(code){
  const c=Number(code);
  if(c===0)return "آسمان صاف";
  if([1,2,3].includes(c))return "صاف تا ابری";
  if([45,48].includes(c))return "مه";
  if([51,53,55,56,57].includes(c))return "نم‌نم باران";
  if([61,63,65,66,67,80,81,82].includes(c))return "باران";
  if([71,73,75,77,85,86].includes(c))return "برف";
  if([95,96,99].includes(c))return "احتمال رعدوبرق";
  return "وضعیت جوی متغیر";
}
function localDateTimeValue(date){
  const pad=n=>String(n).padStart(2,"0");
  return date.getFullYear()+"-"+pad(date.getMonth()+1)+"-"+pad(date.getDate())+"T"+pad(date.getHours())+":"+pad(date.getMinutes());
}
function jalaliParts(date){
  const parts=new Intl.DateTimeFormat("en-US-u-ca-persian-nu-latn",{year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(date);
  const get=t=>Number(parts.find(p=>p.type===t)?.value);
  return {year:get("year"),month:get("month"),day:get("day")};
}
function jalaliDateText(date){
  const p=jalaliParts(date),pad=n=>String(n).padStart(2,"0");
  return p.year+"/"+pad(p.month)+"/"+pad(p.day);
}
function parseJalaliDate(text){
  const normalized=String(text||"").replace(/[۰-۹]/g,d=>"۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[٠-٩]/g,d=>"٠١٢٣٤٥٦٧٨٩".indexOf(d)).trim();
  const m=normalized.match(/^(\d{4})[\/.-](\d{1,2})[\/.-](\d{1,2})$/);
  if(!m)return null;
  const jy=Number(m[1]),jm=Number(m[2]),jd=Number(m[3]);
  if(jm<1||jm>12||jd<1||jd>31)return null;
  const target=jy+"-"+jm+"-"+jd;
  const start=new Date(Date.UTC(jy+621,2,1));
  for(let offset=-75;offset<310;offset++){
    const d=new Date(start.getTime()+offset*86400000),p=jalaliParts(d);
    if(p.year===jy&&p.month===jm&&p.day===jd)return {year:jy,month:jm,day:jd,date:d};
  }
  return null;
}
function syncDepartureInput(){
  const parsed=parseJalaliDate($("departureJalali").value);
  const time=$("departureClock").value;
  if(!parsed||!time){$("departure").value="";return false;}
  const [h,m]=time.split(":").map(Number);
  const d=new Date(parsed.date.getTime());
  d.setHours(h,m,0,0);
  $("departure").value=localDateTimeValue(d);
  return true;
}
let calendarView={year:1405,month:7};
function formatJalaliDate(p){return String(p.year).padStart(4,"0")+"/"+String(p.month).padStart(2,"0")+"/"+String(p.day).padStart(2,"0");}
function currentJalaliParts(){return jalaliParts(new Date());}
function renderJalaliCalendar(year,month){
 const title=$("calendarTitle"),grid=$("calendarGrid"),names=["فروردین","اردیبهشت","خرداد","تیر","مرداد","شهریور","مهر","آبان","آذر","دی","بهمن","اسفند"];
 title.textContent=names[month-1]+" "+year;grid.innerHTML="";
 ["ش","ی","د","س","چ","پ","ج"].forEach(x=>{const e=document.createElement("span");e.textContent=x;grid.appendChild(e);});
 const base=new Date(Date.UTC(year+621,2,1));let first=null,days=0;
 for(let k=-75;k<310;k++){const d=new Date(base.getTime()+k*86400000),p=jalaliParts(d);if(p.year===year&&p.month===month){if(p.day===1)first=d;days=Math.max(days,p.day);}}
 const start=first?((first.getUTCDay()+1)%7):0;for(let k=0;k<start;k++)grid.appendChild(document.createElement("span"));
 const sel=parseJalaliDate($("departureJalali").value),today=currentJalaliParts();
 for(let day=1;day<=days;day++){const b=document.createElement("button");b.type="button";b.textContent=day;if(sel&&sel.year===year&&sel.month===month&&sel.day===day)b.classList.add("selected");if(today.year===year&&today.month===month&&today.day===day)b.classList.add("today");b.addEventListener("click",()=>{$("departureJalali").value=formatJalaliDate({year,month,day});syncDepartureInput();$("calendarDialog").close();});grid.appendChild(b);}
}
function shiftCalendarMonth(delta){let y=calendarView.year,m=calendarView.month+delta;if(m<1){m=12;y--;}else if(m>12){m=1;y++;}calendarView={year:y,month:m};renderJalaliCalendar(y,m);}
function openJalaliCalendar(){const p=parseJalaliDate($("departureJalali").value)||currentJalaliParts();calendarView={year:p.year,month:p.month};renderJalaliCalendar(p.year,p.month);$("calendarDialog").showModal();}
function initDepartureInput(){
  // Leave date and time blank until the user explicitly chooses them.
  $("departureJalali").value="";
  $("departureClock").value="";
  $("departure").value="";
  $("departureJalali").addEventListener("change",syncDepartureInput);
  $("departureClock").addEventListener("change",syncDepartureInput);
  $("openDatePicker").addEventListener("click",openJalaliCalendar);$("departureJalali").addEventListener("click",openJalaliCalendar);
  $("prevMonth").addEventListener("click",()=>shiftCalendarMonth(-1));$("nextMonth").addEventListener("click",()=>shiftCalendarMonth(1));$("calendarToday").addEventListener("click",()=>{const p=currentJalaliParts();$("departureJalali").value=formatJalaliDate(p);syncDepartureInput();$("calendarDialog").close();});$("calendarCancel").addEventListener("click",()=>$("calendarDialog").close());
  
}
async function fetchWeatherAt(lat,lon,when){
  const date=when.toISOString().slice(0,10);
  const params=new URLSearchParams({
    latitude:String(lat),longitude:String(lon),
    hourly:"temperature_2m,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
    wind_speed_unit:"kmh",temperature_unit:"celsius",timezone:"auto",forecast_days:"16"
  });
  let response;
  for(let attempt=0;attempt<3;attempt++){
    response=await fetch("https://api.open-meteo.com/v1/forecast?"+params.toString(),{headers:{Accept:"application/json"}});
    if(response.ok)break;
    if(response.status!==429&&response.status<500)throw new Error("سرویس هواشناسی پاسخ نداد (HTTP "+response.status+").");
    if(attempt===2)throw new Error("سرویس هواشناسی موقتاً محدودیت درخواست اعمال کرده (HTTP "+response.status+"). چند دقیقه بعد دوباره تلاش کنید.");
    await new Promise(resolve=>setTimeout(resolve,1500*(attempt+1)));
  }
  const data=await response.json();
  if(data.error)throw new Error(data.reason||"سرویس هواشناسی خطا برگرداند.");
  const times=data?.hourly?.time||[];
  if(!times.length)throw new Error("برای این نقطه داده ساعتی هواشناسی وجود ندارد.");
  const target=when.getTime();
  let best=-1,delta=Infinity;
  for(let i=0;i<times.length;i++){
    const t=Date.parse(times[i]);
    if(!Number.isFinite(t))continue;
    const d=Math.abs(t-target);
    if(d<delta){delta=d;best=i;}
  }
  if(best<0||delta>90*60*1000)throw new Error("پیش‌بینی هواشناسی برای زمان عبور از این نقطه در دسترس نیست؛ تاریخ نزدیک‌تری انتخاب کنید.");
  const val=(key)=>data.hourly[key]?.[best];
  const result={
    time:times[best],temperature:Number(val("temperature_2m")),
    precipProb:Number(val("precipitation_probability")),precipitation:Number(val("precipitation")),
    code:Number(val("weather_code")),windSpeed:Number(val("wind_speed_10m")),
    windDirection:Number(val("wind_direction_10m")),gust:Number(val("wind_gusts_10m")),
    timezone:data.timezone||""
  };
  if(!Number.isFinite(result.windSpeed)||!Number.isFinite(result.windDirection))throw new Error("داده باد برای این زمان کامل نیست.");
  return result;
}
function estimateHvacLoadKw(temperature,mode){
  if(mode==="off"||!Number.isFinite(temperature))return 0;
  // Approximate average cabin HVAC load; actual demand varies by vehicle and heat-pump type.
  if(temperature<18)return Math.max(0.5,Math.min(3.0,0.5+(18-temperature)*0.12));
  if(temperature>24)return Math.max(0.4,Math.min(2.0,0.4+(temperature-24)*0.13));
  return 0;
}
function analyzeWind(sample,heading,speedKmh,baseConsumption,hvacMode="auto"){
  // wind_direction_10m is the direction the wind comes FROM.
  const delta=((sample.windDirection-heading+540)%360)-180;
  const headwind=sample.windSpeed*Math.cos(delta*Math.PI/180);
  const vehicleSpeed=Math.max(40,Math.min(110,speedKmh||80));
  // Approximation: 30% of baseline energy is treated as aerodynamic load.
  // This is a planning estimate, not a vehicle-specific physical simulation.
  const aeroRatio=((vehicleSpeed+headwind)/vehicleSpeed)**2;
  const factor=Math.max(0.80,Math.min(1.50,1+0.30*(aeroRatio-1)));
  const vehicleConsumptionSpeed=Math.max(40,Math.min(110,speedKmh||80));
  const hvacLoadKw=estimateHvacLoadKw(sample.temperature,hvacMode);
  const hvacConsumption=hvacLoadKw*100/vehicleConsumptionSpeed;
  return {headwind, factor, hvacLoadKw, hvacConsumption, adjustedConsumption:baseConsumption*factor+hvacConsumption};
}
function renderWeather(samples,baseConsumption,adjustedConsumption){
  const panel=$("weatherPanel");
  panel.classList.remove("weather-expanded");
  panel.innerHTML='<div class="directions-head"><h2>هواشناسی و تحلیل باد در مسیر</h2><span class="sub">پیش‌بینی ساعتی</span></div><div class="weather-content weather-fade" id="weatherContent"></div>';
  const content=$("weatherContent");
  const factors=samples.map(s=>s.wind.factor);
  const avgFactor=factors.reduce((a,b)=>a+b,0)/Math.max(1,factors.length);
  const avgHvac=samples.reduce((sum,s)=>sum+(s.wind.hvacConsumption||0),0)/Math.max(1,samples.length);
  const pct=(adjustedConsumption/baseConsumption-1)*100;
  const windPct=(avgFactor-1)*100;
  const summary=document.createElement("div");
  summary.className="weather-summary"+(samples.some(s=>s.weather.precipProb>=60)||samples.some(s=>s.weather.gust>=45)?" warn":"");
  const effect=pct>1?("افزایش تخمینی مصرف "+pct.toFixed(1)+"٪"):pct< -1?("کاهش تخمینی مصرف "+Math.abs(pct).toFixed(1)+"٪"):"تغییر متوسط مصرف ناشی از باد ناچیز برآورد می‌شود";
  summary.textContent=effect+" · مصرف پایه "+baseConsumption.toFixed(1)+"، اثر متوسط باد "+(windPct>=0?"+":"")+windPct.toFixed(1)+"٪، سهم تخمینی بخاری/کولر "+avgHvac.toFixed(1)+" و مصرف نهایی "+adjustedConsumption.toFixed(1)+" kWh/100km.";
  content.appendChild(summary);
  const grid=document.createElement("div");grid.className="weather-grid";
  samples.forEach((s,i)=>{
    const card=document.createElement("div");card.className="weather-card";
    const heading=document.createElement("strong");heading.textContent="حدود کیلومتر "+Math.round(s.routeKm)+" مسیر";
    const time=document.createElement("div");time.className="weather-time";
    time.textContent="زمان عبور: "+new Date(s.eta).toLocaleString("fa-IR",{dateStyle:"short",timeStyle:"short"});
    const conditions=document.createElement("div");conditions.className="weather-detail";
    const temp=Number.isFinite(s.weather.temperature)?Math.round(s.weather.temperature)+"°C":"دما نامشخص";
    const rain=Number.isFinite(s.weather.precipProb)?"احتمال بارش "+Math.round(s.weather.precipProb)+"٪":"احتمال بارش نامشخص";
    conditions.textContent=temp+" · "+weatherDescription(s.weather.code)+" · "+rain;
    const wind=document.createElement("div");wind.className="weather-wind";
    const relative=s.wind.headwind>3?"باد روبه‌رو":s.wind.headwind< -3?"باد پشت":"باد جانبی/متغیر";
    wind.textContent="باد "+Math.round(s.weather.windSpeed)+" km/h از "+compassDirection(s.weather.windDirection)+" · "+relative;
    const gust=document.createElement("div");gust.className="weather-detail";
    gust.textContent="تندباد: "+(Number.isFinite(s.weather.gust)?Math.round(s.weather.gust)+" km/h":"نامشخص")+" · اثر باد: "+((s.wind.factor-1)*100>=0?"+":"")+((s.wind.factor-1)*100).toFixed(1)+"٪ · بخاری/کولر: "+(s.wind.hvacLoadKw||0).toFixed(1)+" kW (حدود "+(s.wind.hvacConsumption||0).toFixed(1)+" kWh/100km)";
    card.append(heading,time,conditions,wind,gust);grid.appendChild(card);
  });
  content.appendChild(grid);
  const credit=document.createElement("div");credit.className="weather-credit";
  credit.innerHTML='منبع پیش‌بینی: <a href="https://open-meteo.com/" target="_blank" rel="noopener" style="color:#64b5ff">Open-Meteo</a>. پیش‌بینی قطعی نیست. اثر باد و بار مصرفی بخاری/کولر با مدل ساده و تقریبی محاسبه می‌شود؛ مصرف واقعی به مدل خودرو، نوع پمپ حرارتی یا بخاری مقاومتی، تنظیم دمای کابین، سرعت و شرایط جاده وابسته است.';
  content.appendChild(credit);
  const more=document.createElement("button");more.type="button";more.className="weather-more";more.textContent="نمایش بیشتر";
  more.addEventListener("click",()=>{const expanded=panel.classList.toggle("weather-expanded");content.classList.toggle("weather-expanded",expanded);content.classList.toggle("weather-fade",!expanded);more.textContent=expanded?"نمایش کمتر":"نمایش بیشتر";});
  panel.appendChild(more);
}
function summarizeDepartureWeather(analysis){
 const a=Array.isArray(analysis?.samples)?analysis.samples:[];
 const n=Math.max(1,a.length);
 const avg=k=>a.reduce((sum,x)=>{const v=Number(x?.weather?.[k]);return sum+(Number.isFinite(v)?v:0);},0)/n;
 const rain=avg("precipProb"),gust=avg("gust");
 const severe=a.filter(x=>[65,67,75,82,86,95,96,99].includes(Number(x?.weather?.code))).length;
 const consumption=Number(analysis?.adjustedConsumption);
 const safeConsumption=Number.isFinite(consumption)?consumption:0;
 return {score:safeConsumption+rain*.025+Math.max(0,gust-35)*.08+severe*2.5,rain,gust,consumption:safeConsumption,severe};
}
function weatherClock(d){return d.toLocaleTimeString("fa-IR",{hour:"2-digit",minute:"2-digit",hour12:false});}
async function recommendWeatherDeparture(coords,km,duration,selectedValue,baseConsumption){
 window.revBestWeatherRecommendation=null;
 const panel=$("weatherPanel"),box=document.createElement("div");
 box.className="weather-summary";box.textContent="در حال مقایسه ساعت‌های حرکت بر اساس پیش‌بینی هواشناسی مسیر…";panel.insertBefore(box,panel.firstChild);
 const selected=new Date(selectedValue),now=Date.now(),candidates=[];
 for(const offset of [0,2,4,1,3]){
  const d=new Date(selected.getTime()+offset*3600000);d.setMinutes(0,0,0);
  if(d.getTime()>=now+10*60000&&!candidates.some(x=>x.getTime()===d.getTime()))candidates.push(d);
  if(candidates.length===5)break;
 }
 if(candidates.length<2){box.className="weather-summary warn";box.textContent="برای این تاریخ ساعت‌های کافی در آینده جهت مقایسه هواشناسی وجود ندارد؛ تاریخ یا ساعت آینده‌تری انتخاب کنید.";return;}
 const results=[];
 for(const departure of candidates){
  try{
   const analysis=await getRouteWeather(coords,km,duration,localDateTimeValue(departure),baseConsumption,{maxSamples:2,delayMs:800});
   results.push({departure,analysis,...summarizeDepartureWeather(analysis)});
  }catch(e){console.warn("REV weather departure candidate failed",weatherClock(departure),e);}
 }
 if(!results.length){box.className="weather-summary warn";box.textContent="پیشنهاد ساعت حرکت آماده نشد؛ سرویس پیش‌بینی برای ساعت‌های جایگزین پاسخ کامل نداد. چند دقیقه بعد دوباره محاسبه کنید؛ ساعت انتخابی شما تغییر نکرده است.";return;}
 results.sort((a,b)=>a.score-b.score);
 const best=results[0],current=results.find(x=>Math.abs(x.departure-selected)<30*60000);
 window.revBestWeatherRecommendation={departure:best.departure.toISOString(),clock:weatherClock(best.departure),consumption:Number(best.consumption.toFixed(1)),rain:Math.round(best.rain),gust:Math.round(best.gust),score:best.score,checked:results.length,createdAt:Date.now(),origin:$("origin").value,destination:$("destination").value,basis:"پیش‌بینی ساعتی باد، دما و بارش در نقاط مسیر"};
 box.className="weather-summary"+(best.rain>=60||best.gust>=50||best.severe?" warn":"");
 box.replaceChildren();
 const title=document.createElement("strong");title.textContent="ساعت پیشنهادی حرکت بر اساس هواشناسی: "+weatherClock(best.departure);box.appendChild(title);
 const detail=document.createElement("div");detail.style.marginTop="6px";
 detail.textContent="از میان "+results.length+" زمان بررسی‌شده، این گزینه امتیاز جوی بهتری دارد؛ مصرف برآوردی "+best.consumption.toFixed(1)+" kWh/100 km، احتمال متوسط بارش "+Math.round(best.rain)+"٪ و تندباد میانگین "+Math.round(best.gust)+" km/h.";
 box.appendChild(detail);
 const note=document.createElement("div");note.style.marginTop="6px";
 note.textContent=current&&current.score-best.score>.2?"شرایط هوا در این برآورد نسبت به ساعت انتخابی بهتر است. برای اعمال پیشنهاد، این ساعت را در فیلد ساعت حرکت وارد و مسیر را دوباره محاسبه کنید.":"این زمان بهترین گزینه در میان ساعت‌های بررسی‌شده است. ساعت انتخابی شما خودکار تغییر نمی‌کند و ترافیک در این پیشنهاد لحاظ نشده است.";
 box.appendChild(note);
 const disclaimer=document.createElement("small");disclaimer.style.display="block";disclaimer.style.marginTop="6px";
 disclaimer.textContent="مقایسه بر اساس باد، دما و مصرف تهویه، بارش و شاخص‌های جوی است؛ ترافیک و وضعیت واقعی جاده لحاظ نشده‌اند.";
 box.appendChild(disclaimer);
}

async function getRouteWeather(routeCoords,routeKm,routeDurationSeconds,departureValue,baseConsumption,options={}){
  if(!departureValue)throw new Error("تاریخ شمسی و ساعت حرکت را درست وارد کنید؛ نمونه تاریخ: ۱۴۰۵/۰۷/۲۲.");
  const departure=new Date(departureValue);
  if(!Number.isFinite(departure.getTime()))throw new Error("تاریخ و ساعت حرکت معتبر نیست.");
  if(departure.getTime()<Date.now()-5*60*1000)throw new Error("زمان حرکت نمی‌تواند در گذشته باشد.");
  const arrival=new Date(departure.getTime()+routeDurationSeconds*1000);
  const maxForecastDays=15;
  if((departure.getTime()-Date.now())>maxForecastDays*24*60*60*1000 || (arrival.getTime()-Date.now())>16*24*60*60*1000){
    throw new Error("تاریخ سفر خارج از افق پیش‌بینی قابل اتکای این سرویس است. نزدیک‌تر به زمان سفر دوباره بررسی کنید.");
  }
  const samples=routeSamplePoints(routeCoords,Math.max(20,routeKm/7),options.maxSamples||8);
  if(samples.length<2)throw new Error("نقاط کافی برای تحلیل هواشناسی مسیر وجود ندارد.");
  const segmentKm=routeKm/(samples.length-1);
  const speedKmh=routeKm/Math.max(0.1,routeDurationSeconds/3600);
  const results=[];
  // Limit concurrent calls to avoid Open-Meteo HTTP 429 responses.
  for(let i=0;i<samples.length;i++){
    if(i>0) await new Promise(resolve=>setTimeout(resolve,Number.isFinite(options.delayMs)?options.delayMs:900));
    const point=samples[i],fraction=i/(samples.length-1);
    const eta=new Date(departure.getTime()+routeDurationSeconds*fraction*1000);
    const weather=await fetchWeatherAt(point[0],point[1],eta);
    const prev=samples[Math.max(0,i-1)],next=samples[Math.min(samples.length-1,i+1)];
    const heading=bearingDegrees(prev,next);
    const wind=analyzeWind(weather,heading,speedKmh,baseConsumption,$("hvacMode")?.value||"auto");
    results.push({lat:point[0],lon:point[1],routeKm:routeKm*fraction,eta,weather,wind});
  }
  // Weighted by distance between samples; endpoints count as half-segments.
  const weights=results.map((_,i)=>(i===0||i===results.length-1)?0.5:1);
  const weightTotal=weights.reduce((a,b)=>a+b,0);
  const avgFactor=results.reduce((sum,x,i)=>sum+x.wind.factor*weights[i],0)/weightTotal;
  const adjustedConsumption=results.reduce((sum,x,i)=>sum+x.wind.adjustedConsumption*weights[i],0)/weightTotal;
  return {samples:results,adjustedConsumption,avgFactor,departure,arrival};
}


let revTimeline = {coords:null,routeKm:0,durationSeconds:0,departure:null,weatherSamples:[],battery:60,soc:90,consumption:18,stops:[],stationList:[],carMarker:null,batteryMarker:null,vehicleType:"bev",electricKm:0,regenerationKwh:0,reserve:15};









function configureTimeline(data){revTimeline={...revTimeline,...data};}

function fmtDuration(seconds){
  const mins=Math.round(seconds/60), h=Math.floor(mins/60),m=mins%60;
  return h?`${h} ساعت و ${m} دقیقه`:`${m} دقیقه`;
}
async function loadStationRatings(stations){
  const api='https://rev-ratings-api.mojtaba-alimi64.workers.dev/api/ratings';
  await Promise.all(stations.map(async s=>{
    s._revRatingId=String(s.id||((s.source||"station")+":"+(s.name||"")+":"+(s.lat??"")+","+(s.lon??""))).slice(0,240);
    try{
      const r=await fetch(api+'?type=station&id='+encodeURIComponent(s._revRatingId),{cache:'no-store'});
      const j=await r.json();
      if(r.ok&&j.success){s._ratingCount=Number(j.count)||0;s._ratingAverage=j.average==null?null:Number(j.average);}
      else{s._ratingCount=0;s._ratingAverage=null;}
    }catch(e){s._ratingCount=0;s._ratingAverage=null;}
    const n=s._ratingCount,avg=s._ratingAverage==null?3.5:s._ratingAverage;
    s._ratingScore=(avg*n+3.5*3)/(n+3);
  }));
}
let revStationReportVoterId=null;
function stationReportVoterId(){
  if(revStationReportVoterId)return revStationReportVoterId;
  const key="rev_station_report_voter_v1";
  try{let id=localStorage.getItem(key);if(!id){id=(crypto.randomUUID?crypto.randomUUID():"rev-report-"+Date.now()+"-"+Math.random().toString(16).slice(2));localStorage.setItem(key,id);}revStationReportVoterId=id;return id;}
  catch(e){revStationReportVoterId="rev-report-"+Date.now()+"-"+Math.random().toString(16).slice(2)+"-"+Math.random().toString(16).slice(2);return revStationReportVoterId;}
}
async function getPublishedStationReports(){
  try{const r=await fetch("https://rev-ratings-api.mojtaba-alimi64.workers.dev/api/station-reports/published",{cache:"no-store"});if(!r.ok)return [];const j=await r.json();return j.success&&Array.isArray(j.items)?j.items:[]}catch(e){return []}
}
async function renderStations(stations,routeCoords,routeKm,params){
  const el=$('results');el.innerHTML='';
  const publishedReports=await getPublishedStationReports();
  const publishedFor=s=>publishedReports.filter(r=>String(r.station_id||"")===String(s.id||"")||String(r.station_name||"").trim().toLowerCase()===String(s.name||"").trim().toLowerCase());
  const metrics=routeMetrics(routeCoords);
  const listStations=stations.map(s=>({...s,...stationAlongRouteKm(s,metrics)})).sort((a,b)=>a.routeKm-b.routeKm);
  const plan=buildChargingPlan(listStations,routeCoords,routeKm,params);
  el.appendChild(renderChargingPlan(plan));
  const heading=document.createElement('h2');heading.style.marginTop='18px';heading.textContent=`شارژرهای نزدیک مسیر (${listStations.length})`;el.appendChild(heading);
  if(!listStations.length){
    const empty=document.createElement('div');empty.className='sub';
    empty.textContent='در بانک تأییدشده REV ایستگاهی در شعاع انتخاب‌شده از مسیر پیدا نشد. فاصله را افزایش دهید یا بعداً دوباره تلاش کنید؛ این نتیجه به معنی نبود شارژر واقعی نیست.';
    el.appendChild(empty);return;
  }
  const plannedIds=new Set(plan.stops.map(s=>String(s.id)));
  listStations.slice(0,50).forEach(s=>{
    const planned=plannedIds.has(String(s.id));
    const stationPublishedReports=publishedFor(s);
    const marker=L.circleMarker([s.lat,s.lon],{radius:planned?10:7,color:stationPublishedReports.length?'#d93025':'#0b1016',weight:stationPublishedReports.length?3:2,fillColor:stationPublishedReports.length?'#ff7043':(planned?'#64b5ff':'#d7ff3f'),fillOpacity:.98}).addTo(stationLayer);
    marker.bindPopup(`<div style="min-width:190px">${stationPublishedReports.length?'<div style="background:#fff0eb;color:#a12616;padding:7px;border-radius:7px;margin-bottom:8px;font-weight:800">⚠ هشدار تأییدشده توسط REV</div>'+stationPublishedReports.map(r=>'<div style="border-right:3px solid #d93025;padding:4px 7px;margin-bottom:6px"><b>'+escapeHTML(({not_found:'جایگاه در محل وجود ندارد',not_working:'خراب یا غیرفعال',connector_wrong:'کانکتور اشتباه',power_wrong:'توان شارژ اشتباه',location_wrong:'موقعیت اشتباه',duplicate:'جایگاه تکراری',violation:'تخلف یا اطلاعات مشکوک',other:'گزارش مشکل'})[r.report_type]||r.report_type||'گزارش مشکل')+'</b>'+(r.details?'<br>'+escapeHTML(r.details):'')+'</div>').join(''):''}${(s.image_url||s.image)?'<img src="'+escapeHTML(s.image_url||s.image)+'" alt="" style="display:block;width:220px;max-height:140px;object-fit:cover;border-radius:8px;margin-bottom:8px">':''}<b>${escapeHTML(s.name)}</b><br>${escapeHTML(s.address)}<br>امتیاز رضایت: ${s._ratingAverage==null?'بدون امتیاز':Number(s._ratingAverage).toLocaleString('fa-IR',{maximumFractionDigits:1})+'/۵ · '+Number(s._ratingCount||0).toLocaleString('fa-IR')+' رأی'}<br>فاصله مستقیم از مسیر: ${s.routeDistance.toFixed(1)} km<br>توان ثبت‌شده: ${s.power?s.power+' kW':'نامشخص'}<br>وضعیت ثبت‌شده: ${escapeHTML(s.status)}<br>منبع: ${escapeHTML(s.source||"نامشخص")}<br>${escapeHTML(formatStationUpdatedAt(s.updatedAt))}<br><a target="_blank" rel="noopener" href="${s.url}">جزئیات ایستگاه</a><br><button type="button" class="rev-map-report-button" style="margin-top:9px;padding:7px 10px;border:0;border-radius:7px;background:#0866ff;color:#ffffff;font-weight:800;cursor:pointer">گزارش خرابی یا تخلف این جایگاه</button></div>`);
    const item=document.createElement('div');item.className='station';
    const ratingLabel=s._ratingCount?('★ '+s._ratingAverage.toFixed(1)+'/۵ · '+s._ratingCount+' رأی'):'بدون امتیاز';
    item.innerHTML=`<strong>${planned?'★ توقف پیشنهادی: ':''}${escapeHTML(s.name)} <span class="pill" style="display:inline-block">${escapeHTML(ratingLabel)}</span></strong><small>${escapeHTML(s.address||'نشانی کامل ثبت نشده')}</small><div><span class="pill">${s.routeDistance.toFixed(1)} کیلومتر فاصله از جاده</span><span class="pill">کیلومتر ${Math.round(s.routeKm??0)} مسیر</span><span class="pill">${s.power?s.power+' kW':'توان نامشخص'}</span><span class="pill">${escapeHTML(s.status)}</span></div><div class="sub">${escapeHTML(s.connectors.join('، ')||'نوع کانکتور نامشخص')}${s.operator?' · '+escapeHTML(s.operator):''}</div><div class="sub">${escapeHTML(s.source||"منبع نامشخص")} · ${escapeHTML(formatStationUpdatedAt(s.updatedAt))}</div><div style="margin-top:6px"><a href="${s.url}" target="_blank" rel="noopener" style="color:#64b5ff">مشاهده جزئیات</a> · <a href="https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=16/${s.lat}/${s.lon}" target="_blank" rel="noopener" style="color:#64b5ff">نمایش روی نقشه</a></div>`;
    el.appendChild(item);
    const ratingBox=document.createElement("div");
    ratingBox.addEventListener("click",event=>event.stopPropagation());
    item.appendChild(ratingBox);
    const reportBox=document.createElement("details");
    reportBox.className="station-report-box";
    reportBox.style.cssText="margin-top:10px;padding:9px 11px;border:1px solid #394650;border-radius:10px;background:#0c131b;color:#e9f0f4";
    reportBox.innerHTML=`<summary style="cursor:pointer;font-size:13px;font-weight:700">ثبت گزارش خرابی، تخلف یا خطای اطلاعات</summary>
      <form class="station-report-form" style="display:grid;gap:8px;margin-top:10px">
        <label style="font-size:12px">نوع مشکل
          <select name="report_type" required style="display:block;width:100%;margin-top:4px;padding:8px;border-radius:8px;background:#101a22;color:#f5f7f8;border:1px solid #52616b">
            <option value="not_found">جایگاه در محل وجود ندارد</option><option value="not_working">جایگاه خراب یا غیرفعال است</option><option value="connector_wrong">نوع کانکتور اشتباه است</option><option value="power_wrong">توان شارژ اشتباه است</option><option value="location_wrong">موقعیت یا نشانی اشتباه است</option><option value="duplicate">جایگاه تکراری است</option><option value="violation">تخلف، اطلاعات جعلی یا رفتار مشکوک</option><option value="other">سایر موارد</option>
          </select>
        </label>
        <label style="font-size:12px">توضیح تکمیلی (اختیاری)
          <textarea name="details" maxlength="600" rows="2" placeholder="مثلاً جایگاه جابه‌جا شده یا شارژر خاموش است" style="display:block;width:100%;margin-top:4px;padding:8px;border-radius:8px;background:#101a22;color:#f5f7f8;border:1px solid #52616b;resize:vertical"></textarea>
        </label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button type="submit" style="padding:7px 12px;border:0;border-radius:8px;background:#0866ff;color:#ffffff;font-weight:800;cursor:pointer">ارسال گزارش</button><span class="station-report-message" role="status" style="font-size:12px;color:#b7c4cb"></span></div>
      </form>`;
    item.appendChild(reportBox);
    // Let users open the existing report form directly from a charging-station map popup.
    marker.on("popupopen",event=>{
      const popupEl=event.popup.getElement();
      const button=popupEl?.querySelector(".rev-map-report-button");
      if(!button||button.dataset.bound==="1")return;
      button.dataset.bound="1";
      button.addEventListener("click",ev=>{
        ev.preventDefault();ev.stopPropagation();
        let inlineForm=popupEl.querySelector(".rev-map-report-inline");
        if(inlineForm){inlineForm.hidden=!inlineForm.hidden;return;}
        inlineForm=document.createElement("form");
        inlineForm.className="rev-map-report-inline";
        inlineForm.style.cssText="display:grid;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid #52616b;min-width:220px";
        const typeLabel=document.createElement("label");
        typeLabel.textContent="نوع گزارش";
        typeLabel.style.cssText="display:grid;gap:4px;font-size:12px";
        const typeSelect=document.createElement("select");
        typeSelect.name="report_type";typeSelect.required=true;
        typeSelect.style.cssText="width:100%;padding:7px;border-radius:7px;background:#101a22;color:#f5f7f8;border:1px solid #52616b";
        [["not_found","جایگاه در محل وجود ندارد"],["not_working","جایگاه خراب یا غیرفعال است"],["connector_wrong","نوع کانکتور اشتباه است"],["power_wrong","توان شارژ اشتباه است"],["location_wrong","موقعیت یا نشانی اشتباه است"],["duplicate","جایگاه تکراری است"],["violation","تخلف، اطلاعات جعلی یا رفتار مشکوک"],["other","سایر موارد"]].forEach(([value,label])=>{const o=document.createElement("option");o.value=value;o.textContent=label;typeSelect.appendChild(o);});
        typeLabel.appendChild(typeSelect);
        const details=document.createElement("textarea");details.name="details";details.maxLength=600;details.rows=2;details.placeholder="توضیحات تکمیلی (اختیاری)";
        details.style.cssText="width:100%;padding:7px;border-radius:7px;background:#101a22;color:#f5f7f8;border:1px solid #52616b;resize:vertical";
        const submit=document.createElement("button");submit.type="submit";submit.textContent="ارسال گزارش";
        submit.style.cssText="padding:7px 10px;border:0;border-radius:7px;background:#0866ff;color:#ffffff;font-weight:800;cursor:pointer";
        const message=document.createElement("div");message.setAttribute("role","status");message.style.cssText="font-size:12px;color:#b7c4cb";
        inlineForm.append(typeLabel,details,submit,message);button.insertAdjacentElement("afterend",inlineForm);
        inlineForm.addEventListener("click",e=>e.stopPropagation());
        inlineForm.addEventListener("submit",async e=>{
          e.preventDefault();e.stopPropagation();if(submit.disabled)return;
          const reportId=String(s._revRatingId||s.id||((s.source||"station")+":"+(s.name||"")+":"+(s.lat??"")+","+(s.lon??""))).slice(0,240);
          submit.disabled=true;message.textContent="در حال ارسال گزارش…";
          try{
            const response=await fetch("https://rev-ratings-api.mojtaba-alimi64.workers.dev/api/station-reports",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({station_id:reportId,station_name:String(s.name||"ایستگاه شارژ").slice(0,180),report_type:typeSelect.value,details:details.value,voter:stationReportVoterId()})});
            const result=await response.json().catch(()=>({}));
            if(response.ok&&result.success){message.textContent="گزارش با موفقیت ثبت شد.";message.style.color="#0866ff";submit.textContent="ثبت شد";}
            else if(response.status===409){message.textContent="برای این ایستگاه قبلاً گزارشی ثبت کرده‌اید.";submit.disabled=true;}
            else throw new Error(result.error||"ارسال گزارش ناموفق بود");
          }catch(err){message.textContent=err.message||"خطا در ارسال گزارش؛ دوباره تلاش کنید.";submit.disabled=false;}
        });
      });
    });
    const reportForm=reportBox.querySelector("form"),reportMessage=reportBox.querySelector(".station-report-message"),reportSubmit=reportForm.querySelector('button[type="submit"]');
    const reportId=String(s._revRatingId||s.id||((s.source||"station")+":"+(s.name||"")+":"+(s.lat??"")+","+(s.lon??""))).slice(0,240);
    const reportKey="rev_station_report_sent_v1:"+reportId;
    try{if(localStorage.getItem(reportKey)==="1"){reportSubmit.disabled=true;reportMessage.textContent="از این مرورگر قبلاً برای این جایگاه گزارش ارسال شده است.";}}catch(e){}
    reportForm.addEventListener("submit",async event=>{
      event.preventDefault();event.stopPropagation();if(reportSubmit.disabled)return;
      reportSubmit.disabled=true;reportMessage.textContent="در حال ارسال گزارش…";
      try{
        const response=await fetch("https://rev-ratings-api.mojtaba-alimi64.workers.dev/api/station-reports",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({station_id:reportId,station_name:String(s.name||"ایستگاه شارژ").slice(0,180),report_type:reportForm.elements.report_type.value,details:reportForm.elements.details.value,voter:stationReportVoterId()})});
        const result=await response.json().catch(()=>({}));
        if(response.status===409){reportMessage.textContent="قبلاً برای این جایگاه گزارشی ثبت شده است.";return;}
        if(!response.ok||!result.success)throw new Error(result.error||("HTTP "+response.status));
        try{localStorage.setItem(reportKey,"1");}catch(e){}
        reportMessage.textContent="گزارش ثبت شد؛ از اطلاع‌رسانی شما سپاسگزاریم.";reportForm.querySelector("select").disabled=true;reportForm.querySelector("textarea").disabled=true;
      }catch(error){reportMessage.textContent=error.message||"ارسال گزارش ناموفق بود.";reportSubmit.disabled=false;}
    });
    item.addEventListener('click',()=>{map.setView([s.lat,s.lon],14);marker.openPopup();});
  });
}
function updateVehicleFields(){
  const type=$("vehicleType").value;
  const electric=type==="bev", plugIn=type==="phev", fuel=type!=="bev";
  $("electricFields").hidden=!electric;
  $("fuelFields").hidden=!fuel;
  $("tankFields").style.display=fuel?"grid":"none";
  $("phevRangeField").style.display=plugIn?"block":"none";
  $("phevBatteryFields").style.display=plugIn?"grid":"none";
  $("vehicleHelp").textContent=electric
    ?"برای خودروی تمام‌برقی، مصرف باتری، برد و توقف‌های شارژ محاسبه می‌شود."
    :plugIn
      ?"هیبرید شارژی: برآورد برد برقی و مصرف بنزین پس از اتمام برد برقی؛ شارژ عمومی اختیاری است."
      :type==="hev"
        ?"هیبرید معمولی: مصرف بنزین و برد باک محاسبه می‌شود؛ توقف شارژ در برنامه سفر الزامی نیست."
        :"هیبرید ملایم: مصرف بنزین و برد باک محاسبه می‌شود؛ باتری کوچک کمکی نیازمند شارژ عمومی نیست.";
  $("range").parentElement.querySelector("span").textContent=electric?"برد تخمینی برقی (km)":plugIn?"برد برقی + بنزینی (km)":"برد با باک (km)";
}
$("vehicleType").addEventListener("change",updateVehicleFields);
updateVehicleFields();
// Apply settings intentionally passed from the driver profile.
(function applyDriverSettings(){const q=new URLSearchParams(location.search);if(!q.has("vehicleType")&&!q.has("battery")&&!q.has("consumption"))return;const allowed=["bev","phev","hev","mhev"],type=q.get("vehicleType");if(allowed.includes(type))$("vehicleType").value=type;const setNumber=(id,key,min,max)=>{const raw=q.get(key);if(raw===null)return;const n=Number(raw);if(Number.isFinite(n)&&n>=min&&n<=max)$(id).value=String(n)};setNumber("battery","battery",10,250);setNumber("soc","soc",5,100);setNumber("consumption","consumption",5,50);if(["auto","off"].includes(q.get("hvac")))$("hvacMode").value=q.get("hvac");updateVehicleFields();const note=document.createElement("div");note.className="weather-summary";note.textContent="تنظیمات خودرو از پروفایل راننده وارد شد"+(q.get("vehicleName")?" · "+q.get("vehicleName"):"")+". مبدأ و مقصد را وارد و مسیر را محاسبه کنید.";const status=$("status");if(status)status.parentNode.insertBefore(note,status);history.replaceState(null,"",location.pathname+location.hash)})();
function showContinueTrip(){const b=$("continueTripBtn"),hint=$("continueTripHint");if(b)b.style.display="block";if(hint)hint.style.display="block";}
function continueToDriverProfile(){const origin=$("origin").value.trim(),destination=$("destination").value.trim();if(!origin||!destination||!lastRoute){setStatus("ابتدا مسیر را با موفقیت محاسبه کنید.");return;}if(!confirm("تمام تنظیمات سفر به پروفایل خصوصی راننده منتقل شود؟\nمبدأ: "+origin+"\nمقصد: "+destination+"\nGPS فقط پس از فشردن «شروع سفر» فعال می‌شود."))return;const type=$("vehicleType").value,isPhev=type==="phev";const q=new URLSearchParams({origin,destination,routeKm:String(lastRoute.distance/1000),routeDuration:$("duration").textContent,vehicleType:type,battery:isPhev?$("phevBattery").value:$("battery").value,soc:isPhev?$("phevSoc").value:$("soc").value,consumption:$("consumption").value,reserve:$("reserve").value,targetSoc:$("targetSoc").value,hvac:$("hvacMode").value,fuelConsumption:$("fuelConsumption").value,fuelPrice:$("fuelPrice").value,fuelTank:$("fuelTank").value,electricRange:$("electricRange").value,phevBattery:$("phevBattery").value,phevSoc:$("phevSoc").value,departure:$("departure").value,departureJalali:$("departureJalali").value});try{if(lastRoute&&lastRoute.geometry&&Array.isArray(lastRoute.geometry.coordinates)){const saved={coordinates:lastRoute.geometry.coordinates,origin,destination,distance:lastRoute.distance,duration:lastRoute.duration,createdAt:Date.now(),stops:(revTimeline.stops||[]).map(s=>({name:s.name||"ایستگاه شارژ",lat:Number(s.lat),lon:Number(s.lon),routeKm:Number(s.routeKm),arrivalSoc:Number(s.arrivalSoc),targetSoc:Number(s.targetSoc),chargeMinutes:s.chargeMinutes==null?null:Number(s.chargeMinutes),power:s.power==null?null:Number(s.power),connectors:Array.isArray(s.connectors)?s.connectors:[]})),battery:Number(revTimeline.battery),soc:Number(revTimeline.soc),consumption:Number(revTimeline.consumption),reserve:Number(revTimeline.reserve),vehicleType:revTimeline.vehicleType||type};sessionStorage.setItem("rev_planned_route",JSON.stringify(saved));localStorage.setItem("rev_planned_route",JSON.stringify(saved));}const settings=Object.fromEntries(q.entries());sessionStorage.setItem("rev_driver_trip_settings",JSON.stringify(settings));localStorage.setItem("rev_driver_trip_settings",JSON.stringify(settings));}catch(e){}try{sessionStorage.setItem("rev_nav_start",JSON.stringify({origin:origin,destination:destination}));}catch(e){}
const fromMobile=new URLSearchParams(window.location.search).get("from")==="rev-mobile";location.href=fromMobile?"https://mojtabaalimi64-cloud.github.io/rev-mobile/nearby-map.html?navstart=1":"./nearby-map.html?navstart=1";}
async function planTrip(){
  const next=$("continueTripBtn"),hint=$("continueTripHint");if(next)next.style.display="none";if(hint)hint.style.display="none";
  window.revStationSourceWarning = "";
  window.revStationCacheNote = "";
  $("planBtn").disabled=true;$("planBtn").textContent="در حال محاسبه…";
  if(!syncDepartureInput()){setStatus("تاریخ شمسی یا ساعت حرکت معتبر نیست. تاریخ را مانند ۱۴۰۵/۰۷/۲۲ وارد کنید.");$("planBtn").disabled=false;$("planBtn").textContent="محاسبه مسیر و یافتن شارژرها";return;}
  routeLayer.clearLayers();stationLayer.clearLayers();$("results").innerHTML="<h2 style='margin-top:18px'>شارژرهای نزدیک مسیر</h2>";$("directionsPanel").innerHTML='<div class="directions-head"><h2>راهنمای مسیر</h2><span class="sub">در حال محاسبه…</span></div>';
  try{
    const origin=$("origin").value.trim(), destination=$("destination").value.trim();
    if(!origin||!destination) throw new Error("مبدأ و مقصد را وارد کنید.");
    setStatus("در حال پیدا کردن مبدأ و مقصد…");
    const [start,end]=await Promise.all([geocode(origin),geocode(destination)]);
    // Reject identical/near-identical endpoints before routing or battery calculations.
    // This prevents a zero-distance trip from being misreported as an empty-battery issue.
    if(haversine(start,end)<0.5){
      lastRoute=null;
      routeLayer.clearLayers();stationLayer.clearLayers();
      $("distance").textContent="—";$("duration").textContent="—";$("range").textContent="—";
      $("results").innerHTML="<h2 style=\"margin-top:18px\">شارژرهای نزدیک مسیر</h2>";
      $("directionsPanel").innerHTML="<div class=\"directions-head\"><h2>راهنمای مسیر</h2></div><div class=\"weather-summary warn\">مبدأ و مقصد یکسان هستند؛ دو نقطه متفاوت انتخاب کنید.</div>";
      
      
      
      setStatus("⚠️ مبدأ و مقصد یکسان هستند. برای محاسبه سفر، دو نقطه متفاوت انتخاب کنید.");
      return;
    }
    setStatus("در حال محاسبه مسیر جاده‌ای…");
    const route=await getRoute(start,end);lastRoute=route;renderDirections(route);if(window.revRouteCandidates&&window.revRouteCandidates.length)renderRouteVisuals(window.revRouteCandidates,route);
    const coords=route.geometry.coordinates;
    const latlngs=coords.map(c=>[c[1],c[0]]);
    L.marker(start).addTo(routeLayer).bindPopup("مبدأ");
    L.marker(end).addTo(routeLayer).bindPopup("مقصد");
    L.polyline(latlngs,{color:"#d7ff3f",weight:5,opacity:.9}).addTo(routeLayer);
    map.fitBounds(L.latLngBounds(latlngs),{padding:[25,25]});
    const km=route.distance/1000, hours=route.duration;
    $("distance").textContent=km.toFixed(0);
    $("duration").textContent=fmtDuration(hours);
    const vehicleType=$("vehicleType").value;
    // Publish a usable route summary immediately after routing succeeds. Later weather,
    // charger, or business lookups are optional and must not block saving the route.
    let summaryDeparture=new Date($("departure").value);
    if(!Number.isFinite(summaryDeparture.getTime()))summaryDeparture=new Date();
    configureTimeline({coords,routeKm:km,durationSeconds:hours,departure:summaryDeparture,
      weatherSamples:[],battery:num("battery",60),soc:num("soc",90),consumption:num("consumption",18),
      stops:[],stationList:[],vehicleType,electricKm:0,regenerationKwh:0});
    if(window.ensurePlanActionsVisible)window.ensurePlanActionsVisible();
    if(vehicleType==="hev"||vehicleType==="mhev"||vehicleType==="phev"){
      const fuelRate=num("fuelConsumption",5.5),fuelPrice=num("fuelPrice",3000),tank=num("fuelTank",45);
      if(fuelRate<=0||tank<=0||fuelPrice<0)throw new Error("مصرف بنزین، ظرفیت باک و قیمت سوخت را بررسی کنید.");
      const nominalElectricRange=vehicleType==="phev"?num("electricRange",60):0;
      const initialElectricSoc=vehicleType==="phev"?num("phevSoc",90):0;
      const electricKm=vehicleType==="phev"?Math.min(km,nominalElectricRange*initialElectricSoc/100):0;
      // Conservative route-average estimates, not vehicle-specific measurements: HEV 0.7 and MHEV 0.25 kWh per 100 km.
      const regenerationRate=vehicleType==="hev"?0.7:vehicleType==="mhev"?0.25:0;
      const regenerationKwh=km*regenerationRate/100;
      const fuelKm=Math.max(0,km-electricKm);
      const liters=fuelKm*fuelRate/100,cost=liters*fuelPrice;
      const fuelRange=tank/fuelRate*100;
      const totalRange=vehicleType==="phev"?nominalElectricRange+fuelRange:fuelRange;
      $("range").textContent=Math.round(totalRange);
      $("weatherPanel").innerHTML='<div class="directions-head"><h2>هواشناسی مسیر</h2><span class="sub">در حال دریافت پیش‌بینی…</span></div><div class="weather-summary">محاسبه مسیر و شبیه‌ساز مستقل از سرویس هواشناسی اجرا می‌شوند.</div>';
      // Initialize route playback immediately; weather and fuel stations load in the background.
      const departureValue=$("departure").value;
      let departure=new Date(departureValue);
      if(!Number.isFinite(departure.getTime())||departure.getTime()<Date.now()-5*60*1000)departure=new Date();
      configureTimeline({coords,routeKm:km,durationSeconds:hours,departure,weatherSamples:[],battery:1,soc:100,consumption:0,stops:[],stationList:[],vehicleType,electricKm,regenerationKwh});
      if(window.ensurePlanActionsVisible)window.ensurePlanActionsVisible();
      const hybridRadius=num("radius",10);
      renderFuelStations(coords,hybridRadius).then(count=>{if(count===0)console.warn("REV: no mapped fuel stations returned for this route");}).catch(e=>console.warn("REV fuel layer:",e));
      renderBusinessDirectory(coords,hybridRadius).catch(e=>console.warn("REV business layer:",e));
      // Fetch weather asynchronously so a slow forecast API cannot block the route results.
      getRouteWeather(coords,km,hours,departureValue,18,{maxSamples:4,delayMs:200}).then(hybridWeather=>{
        const cards=hybridWeather.samples.map(x=>'<div class="weather-card"><strong>حدود کیلومتر '+Math.round(x.routeKm)+' مسیر</strong><div class="weather-time">زمان عبور: '+new Date(x.eta).toLocaleString("fa-IR",{dateStyle:"short",timeStyle:"short"})+'</div><div class="weather-detail">'+Math.round(x.weather.temperature)+'°C · '+escapeHTML(weatherDescription(x.weather.code))+' · احتمال بارش '+(Number.isFinite(x.weather.precipProb)?Math.round(x.weather.precipProb)+"٪":"نامشخص")+'</div><div class="weather-wind">باد '+Math.round(x.weather.windSpeed)+' km/h از '+escapeHTML(compassDirection(x.weather.windDirection))+'</div><div class="weather-detail">تندباد: '+(Number.isFinite(x.weather.gust)?Math.round(x.weather.gust)+" km/h":"نامشخص")+'</div></div>').join("");
        $("weatherPanel").innerHTML='<div class="directions-head"><h2>هواشناسی مسیر</h2><span class="sub">پیش‌بینی ساعتی</span></div><div class="weather-grid">'+cards+'</div><div class="weather-credit">منبع: <a href="https://open-meteo.com/" target="_blank" rel="noopener" style="color:#64b5ff">Open-Meteo</a>. پیش‌بینی تقریبی است؛ اثر آب‌وهوا بر هزینه بنزین لحاظ نشده است.</div>';
        revTimeline.weatherSamples=hybridWeather.samples;
      }).catch(wxError=>{$("weatherPanel").innerHTML='<div class="directions-head"><h2>هواشناسی مسیر</h2><span class="sub">داده در دسترس نیست</span></div><div class="weather-summary warn">'+escapeHTML(wxError?.message||"پیش‌بینی آب‌وهوا دریافت نشد")+'</div>';});
      showContinueTrip();
      setStatus("مسیر محاسبه شد: "+km.toFixed(0)+" کیلومتر · زمان رانندگی تخمینی: "+fmtDuration(hours)+".\\nمصرف بنزین برآوردی: "+liters.toFixed(1)+" لیتر · هزینه تقریبی: "+Math.round(cost).toLocaleString("fa-IR")+" تومان.\\n"+(vehicleType==="phev"?"سوییچ تخمینی به بنزین در کیلومتر "+Math.round(electricKm)+".\\n":(vehicleType==="hev"||vehicleType==="mhev"?"بازیابی برق تخمینی: "+regenerationKwh.toFixed(2)+" kWh (برآورد تقریبی).\\n":""))+"شبیه‌ساز حرکت آماده است؛ هواشناسی و جایگاه‌ها در پس‌زمینه بارگذاری می‌شوند.");
      return;
    }
    if($("timelineSlider"))$("timelineSlider").disabled=false;
    if($("timelineDetails"))$("timelineDetails").textContent="پس از محاسبه مسیر، زمان‌بندی پیشنهادی شارژ نمایش داده می‌شود.";
    const battery=num("battery",60),soc=num("soc",90),baseConsumption=num("consumption",18),reserve=num("reserve",15);
    let weatherAnalysis=null,consumption=baseConsumption,weatherWarning="";
    $("weatherPanel").innerHTML='<div class="directions-head"><h2>هواشناسی مسیر</h2><span class="sub">در حال دریافت پیش‌بینی ساعتی…</span></div>';
    setStatus("در حال دریافت پیش‌بینی آب‌وهوا برای زمان عبور از نقاط مسیر و تحلیل جهت باد…");
    try{
      weatherAnalysis=await getRouteWeather(coords,km,hours,$("departure").value,baseConsumption);
      consumption=weatherAnalysis.adjustedConsumption;
      renderWeather(weatherAnalysis.samples,baseConsumption,consumption);
      await recommendWeatherDeparture(coords,km,hours,$("departure").value,baseConsumption);
    }catch(weatherError){
      weatherWarning=weatherError?.message||"اطلاعات هواشناسی در دسترس نیست.";
      $("weatherPanel").innerHTML='<div class="directions-head"><h2>هواشناسی مسیر</h2><span class="sub">داده در دسترس نیست</span></div>';
      const msg=document.createElement("div");msg.className="weather-summary warn";msg.textContent=weatherWarning+" مصرف و توقف‌های شارژ در این محاسبه بر اساس مصرف مبنا انجام می‌شود؛ مقدار باد یا هوا حدس زده نمی‌شود."; $("weatherPanel").appendChild(msg);
      const credit=document.createElement("div");credit.className="weather-credit";credit.innerHTML='منبع پیش‌بینی مورد استفاده: <a href="https://open-meteo.com/" target="_blank" rel="noopener" style="color:#64b5ff">Open-Meteo</a>.';$("weatherPanel").appendChild(credit);
    }
    const range=battery*(soc-reserve)/100/consumption*100;
    $("range").textContent=range.toFixed(0);
    setStatus(`مسیر محاسبه شد: ${km.toFixed(0)} کیلومتر.\nبرد تخمینی تا رسیدن به ذخیره ${reserve}%: حدود ${range.toFixed(0)} کیلومتر.\nدر حال دریافت شارژرهای ثبت‌شده نزدیک مسیر…`);
    if(km>range) setStatus(`هشدار: مسافت سفر از برد تخمینی خودرو (${range.toFixed(0)} کیلومتر) بیشتر است؛ احتمالاً به شارژ بین‌راهی نیاز دارید.\nدر حال دریافت شارژرهای ثبت‌شده نزدیک مسیر…`);
    const radius=num("radius",10);
    const stations=await getIranStations(coords,radius);
    const targetSoc=Math.min(100,Math.max(reserve+5,num('targetSoc',80)));
    if(soc<=reserve) throw new Error('درصد شارژ اولیه باید از درصد ذخیره ایمنی بیشتر باشد.');
    if(targetSoc<=reserve) throw new Error('شارژ هدف باید از درصد ذخیره ایمنی بیشتر باشد.');
    const params={battery,soc,consumption,reserve,targetSoc,radius};
    await loadStationRatings(stations);
    renderStations(stations,coords,km,params);
    await renderBusinessDirectory(coords,radius);
    const plan=buildChargingPlan(stations,coords,km,params);
    const stationTimeline=stations.map(s=>({...s,...stationAlongRouteKm(s,routeMetrics(coords))}));
    configureTimeline({coords,routeKm:km,durationSeconds:hours,departure:weatherAnalysis?.departure||new Date($("departure").value),weatherSamples:weatherAnalysis?.samples||[],battery,soc,consumption,reserve,stops:plan.stops||[],stationList:stationTimeline,vehicleType:"bev",electricKm:0});
    if(window.ensurePlanActionsVisible)window.ensurePlanActionsVisible();
    
    const sourceNote = window.revStationSourceWarning
      ? `\nهشدار منبع آنلاین: ${window.revStationSourceWarning}\nفهرست ایستگاه‌ها ممکن است ناقص باشد؛ صفر ایستگاه به معنی نبود شارژر واقعی نیست.`
      : (window.revStationCacheNote ? `\n${window.revStationCacheNote}` : "");
    showContinueTrip();
    setStatus(`مسیر: ${km.toFixed(0)} کیلومتر · زمان رانندگی تخمینی: ${fmtDuration(hours)}.\nزمان حرکت: ${new Date($("departure").value).toLocaleString("fa-IR")} · زمان رسیدن تقریبی: ${new Date(new Date($("departure").value).getTime()+hours*1000).toLocaleString("fa-IR")}.\n${stations.length} ایستگاه تأییدشده از بانک REV در شعاع ${radius} کیلومتری مسیر پیدا شد؛ فهرست بر اساس فاصله از مسیر مرتب شده است.\nمصرف مبنا: ${baseConsumption.toFixed(1)} · ${weatherAnalysis ? `مصرف تعدیل‌شده با باد و بخاری/کولر: ${consumption.toFixed(1)} kWh/100 km.` : `تحلیل باد اعمال نشد: ${weatherWarning}`}\n${plan.message}${sourceNote}\nاطلاعات فعال بودن ایستگاه تضمین نمی‌شود؛ پیش از سفر بررسی کنید.`);
  }catch(e){setStatus("مشکل: "+e.message);console.error(e);}
  finally{$("planBtn").disabled=false;$("planBtn").textContent="محاسبه مسیر و یافتن شارژرها";}
}
function applySharedTripParams(){
  const q=new URLSearchParams(window.location.search);
  const fields={origin:"origin",destination:"destination",vehicleType:"vehicleType",battery:"battery",soc:"soc",consumption:"consumption",reserve:"reserve",targetSoc:"targetSoc",fuelConsumption:"fuelConsumption",fuelPrice:"fuelPrice",fuelTank:"fuelTank",electricRange:"electricRange",phevBattery:"phevBattery",phevSoc:"phevSoc",radius:"radius",hvac:"hvacMode",date:"departureJalali",time:"departureClock"};
  let applied=0;
  for(const [key,id] of Object.entries(fields)){
    const value=q.get(key),el=$(id);
    if(value===null||!el)continue;
    if(["origin","destination"].includes(key))el.value=value.slice(0,180);
    else if(key==="date"&&/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(value))el.value=value;
    else if(key==="time"&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value))el.value=value;
    else if(key==="hvac"&&["auto","off"].includes(value))el.value=value;
    else if(key==="vehicleType"&&["bev","phev","hev","mhev"].includes(value)){el.value=value;updateVehicleFields();}
    else if(["battery","soc","consumption","reserve","targetSoc","fuelConsumption","fuelPrice","fuelTank","electricRange","phevBattery","phevSoc","radius"].includes(key)&&Number.isFinite(Number(value)))el.value=value;
    applied++;
  }
  syncDepartureInput();
  if(applied)$("status").textContent="تنظیمات سفر از لینک اشتراکی بارگذاری شد. برای محاسبه مسیر، دکمه سبز را بزنید.";
}
function buildTripShareUrl(){
  const q=new URLSearchParams({origin:$("origin").value.trim(),destination:$("destination").value.trim(),vehicleType:$("vehicleType").value,battery:$("battery").value,soc:$("soc").value,consumption:$("consumption").value,reserve:$("reserve").value,targetSoc:$("targetSoc").value,fuelConsumption:$("fuelConsumption").value,fuelPrice:$("fuelPrice").value,fuelTank:$("fuelTank").value,electricRange:$("electricRange").value,phevBattery:$("phevBattery").value,phevSoc:$("phevSoc").value,radius:$("radius").value,hvac:$("hvacMode").value,date:$("departureJalali").value.trim(),time:$("departureClock").value});
  return window.location.origin+window.location.pathname+"?"+q.toString();
}
async function shareTrip(){
  if(!$("origin").value.trim()||!$("destination").value.trim()){setStatus("برای ساخت لینک اشتراک‌گذاری، مبدأ و مقصد را وارد کنید.");return;}
  if(!syncDepartureInput()){setStatus("تاریخ شمسی یا ساعت حرکت معتبر نیست؛ ابتدا آن را اصلاح کنید.");return;}
  const url=buildTripShareUrl();
  try{
    if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(url);setStatus("لینک سفر کپی شد. آن را برای دوستانتان بفرستید؛ مسیر و تنظیمات خودرو در لینک حفظ می‌شود.");}
    else{window.prompt("این لینک را کپی و ارسال کنید:",url);setStatus("لینک اشتراک‌گذاری آماده شد. در پنجره بازشده آن را کپی کنید.");}
  }catch(e){window.prompt("این لینک را کپی و ارسال کنید:",url);setStatus("لینک اشتراک‌گذاری آماده شد.");}
}
initDepartureInput();
applySharedTripParams();


$("planBtn").addEventListener("click",planTrip);
$("shareTripBtn").addEventListener("click",shareTrip);
$("continueTripBtn").addEventListener("click",continueToDriverProfile);
