/**
 * REV Auth Worker — separate from the existing rev-api Worker.
 * Bind D1 database rev-db as DB.
 * Secrets: ADMIN_TOKEN, RESEND_API_KEY, MELIPAYAMAK_USERNAME, MELIPAYAMAK_PASSWORD
 * Variables: ALLOWED_ORIGINS, SITE_URL, EMAIL_FROM, MELIPAYAMAK_FROM
 * Keep registration disabled until domain, email DNS and Resend sender are verified.
 */
const DEFAULT_ORIGIN = "https://mojtabaalimi64-cloud.github.io";
const COOKIE_NAME = "__Host-rev_session";
const SESSION_DAYS = 7;
// حالت موقت توسعه: همه امکانات پلن‌ها باز است؛ پس از پایان آزمایش فقط این مقدار را false کنید.
const TEMPORARY_OPEN_ACCESS = true;
const VERIFY_MINUTES = 30;
const PBKDF2_ITERATIONS = 310000;

function allowedOrigins(env) {
  return (env.ALLOWED_ORIGINS || DEFAULT_ORIGIN).split(",").map(s => s.trim()).filter(Boolean);
}
function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const ok = allowedOrigins(env).includes(origin);
  return {
    "Vary": "Origin",
    ...(ok ? {"Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials":"true"} : {}),
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age": "86400"
  };
}
function response(request, env, data, status=200, extra={}) {
  return new Response(JSON.stringify(data), {status, headers: {
    "Content-Type":"application/json; charset=utf-8",
    "Cache-Control":"no-store",
    ...corsHeaders(request, env), ...extra
  }});
}
function cookie(token, maxAge) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${maxAge}`;
}
function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=0`;
}
function b64url(bytes) {
  let s=""; for (const b of new Uint8Array(bytes)) s+=String.fromCharCode(b);
  return btoa(s).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
}
function randomToken(n=32) { const b=new Uint8Array(n); crypto.getRandomValues(b); return b64url(b); }
async function sha256(s) {
  const d=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b=>b.toString(16).padStart(2,"0")).join("");
}
async function passwordHash(password, salt, iterations=PBKDF2_ITERATIONS) {
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(password),"PBKDF2",false,["deriveBits"]);
  const bits=await crypto.subtle.deriveBits({name:"PBKDF2",hash:"SHA-256",salt:Uint8Array.from(atob(salt.replace(/-/g,"+").replace(/_/g,"/")),c=>c.charCodeAt(0)),iterations},key,256);
  return b64url(bits);
}
function validEmail(s) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) && s.length<=254; }
function normalizedEmail(s) { return String(s||"").trim().toLowerCase(); }
function normalizeIranPhone(value) {
  let s=String(value||"").replace(/[\s()-]/g,"").replace(/[۰-۹]/g,d=>"۰۱۲۳۴۵۶۷۸۹".indexOf(d)).replace(/[٠-٩]/g,d=>"٠١٢٣٤٥٦٧٨٩".indexOf(d));
  if(s.startsWith("+98")) s="0"+s.slice(3);
  else if(s.startsWith("0098")) s="0"+s.slice(4);
  else if(s.startsWith("98") && s.length===12) s="0"+s.slice(2);
  return /^09[0-9]{9}$/.test(s) ? {local:s,e164:"+98"+s.slice(1)} : null;
}
function passwordValid(s) { return typeof s==="string" && s.length>=12 && s.length<=128; }
function sameOrigin(request, env) {
  const origin=request.headers.get("Origin");
  return !!origin && allowedOrigins(env).includes(origin);
}
async function rateLimited(request, env, action, maxAttempts, windowSeconds=60) {
  const ip=request.headers.get("CF-Connecting-IP") || "unknown";
  const bucket=Math.floor(Date.now()/(windowSeconds*1000));
  const key=await sha256(action+":"+ip+":"+bucket);
  const expires=new Date((bucket+1)*windowSeconds*1000).toISOString();
  await env.DB.prepare("DELETE FROM rev_auth_rate_limits WHERE expires_at < ?").bind(new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO rev_auth_rate_limits(bucket_key,attempt_count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket_key) DO UPDATE SET attempt_count=attempt_count+1")
    .bind(key,expires).run();
  const row=await env.DB.prepare("SELECT attempt_count FROM rev_auth_rate_limits WHERE bucket_key=?").bind(key).first();
  return Number(row?.attempt_count||0)>maxAttempts;
}
async function enabled(env) {
  const r=await env.DB.prepare("SELECT enabled FROM rev_auth_settings WHERE id=1").first();
  return Number(r?.enabled||0)===1;
}
async function admin(request, env) {
  const h=request.headers.get("Authorization")||"";
  return !!env.ADMIN_TOKEN && h==="Bearer "+env.ADMIN_TOKEN;
}
async function sendOtpPattern(env,phone,code) {
  if(!(env.MELIPAYAMAK_USERNAME&&env.MELIPAYAMAK_PASSWORD))
    throw new Error("SMS_NOT_CONFIGURED");
  const bodyId=String(env.MELIPAYAMAK_OTP_BODY_ID||"557785").trim();
  const form=new URLSearchParams({
    username:env.MELIPAYAMAK_USERNAME,
    password:env.MELIPAYAMAK_PASSWORD,
    text:String(code),
    to:phone,
    bodyId
  });
  const res=await fetch("https://rest.payamak-panel.com/api/SendSMS/BaseServiceNumber",{
    method:"POST",
    headers:{"Content-Type":"application/x-www-form-urlencoded"},
    body:form.toString()
  });
  const raw=await res.text();
  if(!res.ok) throw new Error("SMS_SEND_FAILED");
  let value=raw;
  try { value=JSON.parse(raw); } catch {}
  const numeric=typeof value==="number"?value:(typeof value==="string"&&/^-?\\d+$/.test(value.trim())?Number(value):Number(value?.Value??value?.value??value?.RetStatus??NaN));
  if(Number.isFinite(numeric) && numeric<=0) throw new Error("SMS_SEND_FAILED");
  if(typeof value==="object" && value && (value.IsSuccess===false || value.success===false)) throw new Error("SMS_SEND_FAILED");
}
async function sendVerification(env,email,token) {
  if(!env.RESEND_API_KEY || !env.EMAIL_FROM || !env.SITE_URL) throw new Error("EMAIL_NOT_CONFIGURED");
  const url=env.SITE_URL.replace(/\/$/,"")+"/verify-email.html?token="+encodeURIComponent(token)+"&email="+encodeURIComponent(email);
  const res=await fetch("https://api.resend.com/emails",{
    method:"POST",
    headers:{"Authorization":"Bearer "+env.RESEND_API_KEY,"Content-Type":"application/json"},
    body:JSON.stringify({from:env.EMAIL_FROM,to:[email],subject:"تأیید ایمیل حساب REV",text:"برای تأیید ایمیل حساب REV، این پیوند را در مرورگر باز کنید. پیوند تا ۳۰ دقیقه معتبر است:\n\n"+url+"\n\nاگر شما این درخواست را نداده‌اید، این ایمیل را نادیده بگیرید."})
  });
  if(!res.ok) throw new Error("EMAIL_SEND_FAILED");
}
async function createSession(request,env,userId) {
  const raw=randomToken(32), now=new Date(), exp=new Date(now.getTime()+SESSION_DAYS*86400000);
  await env.DB.prepare("INSERT INTO rev_sessions (id,user_id,session_token_hash,created_at,expires_at,revoked_at) VALUES (?,?,?,?,?,NULL)")
    .bind(crypto.randomUUID(),userId,await sha256(raw),now.toISOString(),exp.toISOString()).run();
  return response(request,env,{success:true,user:{id:userId}},200,{"Set-Cookie":cookie(raw,SESSION_DAYS*86400)});
}
function isPlanActive(a, now=Date.now()) {
  if (TEMPORARY_OPEN_ACCESS) return true;
  return !!a && a.plan_status==="active" && ["paid","waived"].includes(a.payment_status) && Number.isFinite(Date.parse(a.expires_at||"")) && Date.parse(a.expires_at)>now && (!a.starts_at || Date.parse(a.starts_at)<=now);
}
function effectiveFeatures(a, now=Date.now()) {
  const free={listing:true,contact:true,edit:true,product_catalog:false,logo:false,photos:false,hours:false,services:false,links:false,stats:false,highlight:false,priority:false,map_pin:false,report:false,campaign:false,banner:false,sponsored:false,social:false,custom:false};
  if (TEMPORARY_OPEN_ACCESS) return Object.fromEntries(Object.keys(free).map(key=>[key,true]));
  if(!isPlanActive(a,now)) return free;
  try { const f=JSON.parse(a.features_json||"{}"); return {...free,...f}; } catch { return free; }
}
async function currentUser(request,env) {
  const raw=(request.headers.get("Cookie")||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(COOKIE_NAME+"="))?.slice(COOKIE_NAME.length+1);
  if(!raw) return null;
  const hash=await sha256(decodeURIComponent(raw));
  return await env.DB.prepare("SELECT u.id,u.display_name,u.email_normalized,u.phone_e164,u.email_verified_at,u.phone_verified_at,u.account_status,u.role,u.created_at FROM rev_sessions s JOIN rev_users u ON u.id=s.user_id WHERE s.session_token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.account_status='active' AND (u.email_verified_at IS NOT NULL OR u.phone_verified_at IS NOT NULL) LIMIT 1")
    .bind(hash,new Date().toISOString()).first();
}

async function ensureDriverTripsSchema(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rev_driver_trips (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    vehicle_name TEXT NOT NULL DEFAULT 'خودروی ثبت‌نشده',
    vehicle_type TEXT NOT NULL DEFAULT 'bev' CHECK (vehicle_type IN ('bev','phev','hev','mhev')),
    started_at TEXT NOT NULL,
    ended_at TEXT NOT NULL,
    distance_km REAL NOT NULL CHECK (distance_km > 0 AND distance_km <= 5000),
    energy_kwh REAL NOT NULL CHECK (energy_kwh >= 0 AND energy_kwh <= 2000),
    start_soc REAL CHECK (start_soc IS NULL OR (start_soc >= 0 AND start_soc <= 100)),
    end_soc REAL CHECK (end_soc IS NULL OR (end_soc >= 0 AND end_soc <= 100)),
    energy_source TEXT NOT NULL DEFAULT 'manual' CHECK (energy_source IN ('obd','vehicle_api','gps_estimate','manual')),
    route_json TEXT,
    route_saved INTEGER NOT NULL DEFAULT 0 CHECK (route_saved IN (0,1)),
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES rev_users(id) ON DELETE CASCADE
  )`).run();
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_rev_driver_trips_user_date ON rev_driver_trips(user_id, ended_at DESC)").run();
  try { await env.DB.prepare("ALTER TABLE rev_driver_trips ADD COLUMN driving_stats_json TEXT").run(); } catch (e) { /* Column already exists on upgraded databases. */ }
}
function validIsoDate(value) {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}
function validOptionalSoc(value) {
  return value === null || value === undefined || (Number.isFinite(Number(value)) && Number(value) >= 0 && Number(value) <= 100);
}
function boundedMetric(value,min,max){const n=Number(value);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):0;}

async function ensureDriverShareSchema(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS rev_live_trip_shares (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    latitude REAL,
    longitude REAL,
    accuracy_m REAL,
    location_updated_at TEXT,
    FOREIGN KEY (user_id) REFERENCES rev_users(id) ON DELETE CASCADE
  )`).run();
  for (const sql of [
    "ALTER TABLE rev_live_trip_shares ADD COLUMN speed_kmh REAL",
    "ALTER TABLE rev_live_trip_shares ADD COLUMN eta_minutes REAL",
    "ALTER TABLE rev_live_trip_shares ADD COLUMN distance_remaining_km REAL",
    "ALTER TABLE rev_live_trip_shares ADD COLUMN destination TEXT",
    "ALTER TABLE rev_live_trip_shares ADD COLUMN trip_started_at TEXT",
    "ALTER TABLE rev_live_trip_shares ADD COLUMN trip_ended_at TEXT"
  ]) { try { await env.DB.prepare(sql).run(); } catch (e) { if (!/duplicate column/i.test(String(e?.message||e))) throw e; } }
  await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_rev_live_trip_shares_user ON rev_live_trip_shares(user_id, created_at DESC)").run();
}
async function driverShareApi(request, env, url, method, user) {
  await ensureDriverShareSchema(env);
  if (url.pathname === "/api/driver/shares/view" && method === "GET") {
    const token=String(url.searchParams.get("token")||"");
    if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) return response(request,env,{success:false,error:"پیوند اشتراک معتبر نیست یا منقضی شده است."},404);
    const row=await env.DB.prepare("SELECT latitude,longitude,accuracy_m,location_updated_at,expires_at,speed_kmh,eta_minutes,distance_remaining_km,destination,trip_started_at,trip_ended_at FROM rev_live_trip_shares WHERE token_hash=? AND revoked_at IS NULL AND expires_at>? LIMIT 1").bind(await sha256(token),new Date().toISOString()).first();
    if(!row) return response(request,env,{success:false,error:"این اشتراک پایان یافته یا لغو شده است."},404);
    return response(request,env,{success:true,location:row.latitude==null||row.longitude==null?null:{latitude:row.latitude,longitude:row.longitude,accuracy_m:row.accuracy_m,updated_at:row.location_updated_at},telemetry:{speed_kmh:row.speed_kmh,eta_minutes:row.eta_minutes,distance_remaining_km:row.distance_remaining_km,destination:row.destination,trip_started_at:row.trip_started_at,trip_ended_at:row.trip_ended_at},expires_at:row.expires_at});
  }
  if (!user) return response(request,env,{success:false,error:"برای اشتراک زنده باید وارد حساب REV شوید."},401);
  if (method !== "GET" && !sameOrigin(request, env)) return response(request,env,{success:false,error:"درخواست از مبدأ مجاز نیست."},403);
  if (url.pathname === "/api/driver/shares" && method === "POST") {
    let body={};try{body=await request.json();}catch{}
    if(!body || typeof body!=="object" || Array.isArray(body)) body={};
    if(await rateLimited(request,env,"driver-share-create",5,60)) return response(request,env,{success:false,error:"تعداد درخواست‌های اشتراک زیاد است؛ کمی بعد تلاش کنید."},429);
    const hours=Math.max(1,Math.min(8,Number(body.hours)||2));
    const id=crypto.randomUUID(),token=randomToken(32),now=new Date(),expires=new Date(now.getTime()+hours*3600000).toISOString();
    await env.DB.prepare("INSERT INTO rev_live_trip_shares (id,user_id,token_hash,created_at,expires_at,revoked_at,latitude,longitude,accuracy_m,location_updated_at) VALUES (?,?,?,?,?,NULL,NULL,NULL,NULL,NULL)")
      .bind(id,user.id,await sha256(token),now.toISOString(),expires).run();
    return response(request,env,{success:true,id,token,expires_at:expires,message:"اشتراک زنده ساخته شد؛ برای شروع ارسال موقعیت، اجازه مکان‌یابی را تأیید کنید."},201);
  }
  const locationMatch=url.pathname.match(/^\/api\/driver\/shares\/([0-9a-f-]{36})\/location$/i);
  if(locationMatch && method==="POST"){
    let body;try{body=await request.json();}catch{return response(request,env,{success:false,error:"بدنه JSON معتبر نیست."},400);}
    const lat=Number(body.latitude),lon=Number(body.longitude),accuracy=body.accuracy_m==null?null:Number(body.accuracy_m);
    const speed=body.speed_kmh==null?null:Number(body.speed_kmh),eta=body.eta_minutes==null?null:Number(body.eta_minutes),remaining=body.distance_remaining_km==null?null:Number(body.distance_remaining_km);
    const destination=String(body.destination||"").trim().slice(0,160),tripStarted=String(body.trip_started_at||"").trim(),tripEnded=body.trip_ended_at?String(body.trip_ended_at).trim():null;
    if(!Number.isFinite(lat)||Math.abs(lat)>90||!Number.isFinite(lon)||Math.abs(lon)>180||(accuracy!==null&&(!Number.isFinite(accuracy)||accuracy<0||accuracy>100000))||(speed!==null&&(!Number.isFinite(speed)||speed<0||speed>400))||(eta!==null&&(!Number.isFinite(eta)||eta<0||eta>10080))||(remaining!==null&&(!Number.isFinite(remaining)||remaining<0||remaining>100000))||(tripStarted&&!Number.isFinite(Date.parse(tripStarted)))||(tripEnded&&!Number.isFinite(Date.parse(tripEnded))))return response(request,env,{success:false,error:"مختصات یا اطلاعات سفر معتبر نیست."},400);
    const result=await env.DB.prepare("UPDATE rev_live_trip_shares SET latitude=?,longitude=?,accuracy_m=?,location_updated_at=?,speed_kmh=?,eta_minutes=?,distance_remaining_km=?,destination=?,trip_started_at=COALESCE(NULLIF(? ,''),trip_started_at),trip_ended_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL AND expires_at>?").bind(lat,lon,accuracy,new Date().toISOString(),speed,eta,remaining,destination||null,tripStarted,tripEnded,locationMatch[1],user.id,new Date().toISOString()).run();
    return response(request,env,{success:true,updated:Number(result.meta?.changes||0)>0},Number(result.meta?.changes||0)>0?200:404);
  }
  const revokeMatch=url.pathname.match(/^\/api\/driver\/shares\/([0-9a-f-]{36})\/revoke$/i);
  if(revokeMatch && method==="POST"){
    const result=await env.DB.prepare("UPDATE rev_live_trip_shares SET revoked_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL").bind(new Date().toISOString(),revokeMatch[1],user.id).run();
    return response(request,env,{success:true,revoked:Number(result.meta?.changes||0)>0});
  }
  return response(request,env,{success:false,error:"متد یا مسیر اشتراک پشتیبانی نمی‌شود."},405);
}

async function driverTripsApi(request, env, url, method, user) {
  if (!user) return response(request, env, {success:false,error:"برای استفاده از تاریخچه سفر وارد حساب کاربری شوید."}, 401);
  if (method !== "GET" && !sameOrigin(request, env)) return response(request, env, {success:false,error:"درخواست از مبدأ مجاز نیست."}, 403);
  await ensureDriverTripsSchema(env);
  if (url.pathname === "/api/driver/trips" && method === "GET") {
    const limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get("limit") || "50", 10) || 50));
    const rows = await env.DB.prepare("SELECT id,vehicle_name,vehicle_type,started_at,ended_at,distance_km,energy_kwh,start_soc,end_soc,energy_source,route_saved,driving_stats_json,created_at FROM rev_driver_trips WHERE user_id=? ORDER BY ended_at DESC LIMIT ?").bind(user.id, limit).all();
    const trips=(rows.results||[]).map(row=>{let driving_stats=null;try{driving_stats=row.driving_stats_json?JSON.parse(row.driving_stats_json):null;}catch{}const {driving_stats_json,...safe}=row;return {...safe,driving_stats};});
    return response(request, env, {success:true,trips});
  }
  if (url.pathname === "/api/driver/trips" && method === "POST") {
    let body;
    try { body = await request.json(); } catch { return response(request,env,{success:false,error:"بدنه JSON معتبر نیست."},400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) return response(request,env,{success:false,error:"ساختار اطلاعات سفر معتبر نیست."},400);
    if (await rateLimited(request,env,"driver-trip-create",20,60)) return response(request,env,{success:false,error:"تعداد درخواست‌ها زیاد است؛ کمی بعد دوباره تلاش کنید."},429);
    const vehicleType = ["bev","phev","hev","mhev"].includes(body.vehicle_type) ? body.vehicle_type : "bev";
    const vehicleName = String(body.vehicle_name || "خودروی ثبت‌نشده").trim().slice(0,100) || "خودروی ثبت‌نشده";
    const distance = Number(body.distance_km), energy = Number(body.energy_kwh);
    const started = body.started_at, ended = body.ended_at;
    const source = ["obd","vehicle_api","gps_estimate","manual"].includes(body.energy_source) ? body.energy_source : "manual";
    const saveRoute = body.save_route === true;
    const points = Array.isArray(body.route_points) ? body.route_points.slice(0,5000) : [];
    const routeJson = saveRoute && points.length ? JSON.stringify(points.filter(p=>p && Number.isFinite(Number(p.lat)) && Math.abs(Number(p.lat))<=90 && Number.isFinite(Number(p.lon)) && Math.abs(Number(p.lon))<=180).map(p=>({lat:Number(p.lat),lon:Number(p.lon),ts:Number(p.ts)||null,accuracy:Number.isFinite(Number(p.accuracy))?Number(p.accuracy):null,speed_kmh:Number.isFinite(Number(p.speed_kmh))?Math.max(0,Math.min(350,Number(p.speed_kmh))):null}))) : null;
    const ds=body.driving_stats&&typeof body.driving_stats==="object"&&!Array.isArray(body.driving_stats)?body.driving_stats:{};
    const drivingStats={max_speed_kmh:boundedMetric(ds.max_speed_kmh,0,350),average_speed_kmh:boundedMetric(ds.average_speed_kmh,0,250),gps_speed_sample_count:boundedMetric(ds.gps_speed_sample_count,0,5000),hard_acceleration_events:boundedMetric(ds.hard_acceleration_events,0,10000),hard_braking_events:boundedMetric(ds.hard_braking_events,0,10000),speed_source:"phone_gps",estimated:true};
    if (!Number.isFinite(distance) || distance <= 0 || distance > 5000 || !Number.isFinite(energy) || energy < 0 || energy > 2000 || !validIsoDate(started) || !validIsoDate(ended) || Date.parse(ended) < Date.parse(started) || !validOptionalSoc(body.start_soc) || !validOptionalSoc(body.end_soc)) {
      return response(request,env,{success:false,error:"اطلاعات سفر معتبر نیست؛ مسافت، انرژی، زمان‌ها و درصد باتری را بررسی کنید."},400);
    }
    const id = crypto.randomUUID(), now = new Date().toISOString();
    await env.DB.prepare("INSERT INTO rev_driver_trips (id,user_id,vehicle_name,vehicle_type,started_at,ended_at,distance_km,energy_kwh,start_soc,end_soc,energy_source,route_json,route_saved,created_at,driving_stats_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(id,user.id,vehicleName,vehicleType,new Date(started).toISOString(),new Date(ended).toISOString(),distance,energy,body.start_soc == null ? null : Number(body.start_soc),body.end_soc == null ? null : Number(body.end_soc),source,routeJson,routeJson?1:0,now,JSON.stringify(drivingStats)).run();
    return response(request,env,{success:true,id,message:"سفر در تاریخچه خصوصی حساب شما ثبت شد."},201);
  }
  const match = url.pathname.match(/^\/api\/driver\/trips\/([0-9a-f-]{36})$/i);
  if (match && method === "DELETE") {
    const result = await env.DB.prepare("DELETE FROM rev_driver_trips WHERE id=? AND user_id=?").bind(match[1],user.id).run();
    return response(request,env,{success:true,deleted:Number(result.meta?.changes || 0) > 0});
  }
  if (url.pathname === "/api/driver/insights" && method === "GET") {
    const rows = await env.DB.prepare("SELECT distance_km,energy_kwh,vehicle_type,energy_source,ended_at FROM rev_driver_trips WHERE user_id=? ORDER BY ended_at DESC LIMIT 100").bind(user.id).all();
    const trips = rows.results || [];
    const usable = trips.filter(t => Number(t.distance_km)>0 && Number(t.energy_kwh)>=0);
    const rates = usable.map(t => Number(t.energy_kwh)/Number(t.distance_km)*100).filter(Number.isFinite);
    const sorted = [...rates].sort((a,b)=>a-b);
    const median = sorted.length ? (sorted.length%2 ? sorted[(sorted.length-1)/2] : (sorted[sorted.length/2-1]+sorted[sorted.length/2])/2) : null;
    const totalKm = usable.reduce((sum,t)=>sum+Number(t.distance_km),0);
    const totalKwh = usable.reduce((sum,t)=>sum+Number(t.energy_kwh),0);
    return response(request,env,{success:true,sample_count:usable.length,total_distance_km:Math.round(totalKm*10)/10,total_energy_kwh:Math.round(totalKwh*10)/10,average_kwh_per_100km:totalKm>0?Math.round(totalKwh/totalKm*1000)/10:null,median_kwh_per_100km:median===null?null:Math.round(median*10)/10,confidence:usable.length<3?"نمونه کم؛ این آمار برای پیش‌بینی قابل اتکا نیست.":usable.length<8?"برآورد اولیه بر اساس سفرهای ثبت‌شده شما.":"برآورد شخصی بر اساس تاریخچه ثبت‌شده؛ شرایط مسیر و هوا همچنان اثرگذارند.",recent:usable.slice(0,5)});
  }
  return response(request,env,{success:false,error:"متد یا مسیر پشتیبانی نمی‌شود."},405);
}

export default {
 async fetch(request,env) {
  const url=new URL(request.url), path=url.pathname, method=request.method;
  if(method==="OPTIONS") return new Response(null,{status:204,headers:corsHeaders(request,env)});
  try {
   if(path==="/api/health" && method==="GET") {
    try {
     await env.DB.prepare("SELECT 1 AS ok").first();
     return response(request,env,{success:true,service:"REV Auth",database:"connected"});
    } catch(e) {
     return response(request,env,{success:false,service:"REV Auth",database:"unavailable"},503);
    }
   }
   if(path==="/api/auth/status" && method==="GET") return response(request,env,{success:true,enabled:await enabled(env),emailConfigured:!!(env.RESEND_API_KEY&&env.EMAIL_FROM&&env.SITE_URL),smsConfigured:!!(env.MELIPAYAMAK_USERNAME&&env.MELIPAYAMAK_PASSWORD),smsPatternConfigured:!!(env.MELIPAYAMAK_OTP_BODY_ID||"557785")});
   if(path==="/api/driver/shares" || path==="/api/driver/shares/view" || /^\/api\/driver\/shares\/[0-9a-f-]{36}\/(location|revoke)$/i.test(path)) {
    const user=path==="/api/driver/shares/view" ? null : await currentUser(request,env);
    return await driverShareApi(request,env,url,method,user);
   }
   if(path==="/api/driver/trips" || /^\/api\/driver\/trips\/[0-9a-f-]{36}$/i.test(path) || path==="/api/driver/insights") {
    const user=await currentUser(request,env);
    return await driverTripsApi(request,env,url,method,user);
   }
   if(path==="/api/admin/users" && method==="GET") {
    if(!await admin(request,env)) return response(request,env,{success:false,error:"Unauthorized"},401);
    const q=String(url.searchParams.get("q")||"").trim().slice(0,160);
    const sortAllowed={created_at:"created_at",display_name:"display_name",email_normalized:"email_normalized",account_status:"account_status",last_login_at:"last_login_at"};
    const sort=sortAllowed[url.searchParams.get("sort")]||"created_at";
    const order=url.searchParams.get("order")==="asc"?"ASC":"DESC";
    const page=Math.max(1,Math.min(100000,parseInt(url.searchParams.get("page")||"1",10)||1));
    const limit=Math.max(1,Math.min(50,parseInt(url.searchParams.get("limit")||"50",10)||50));
    const offset=(page-1)*limit, like="%"+q.toLowerCase()+"%";
    const where=q?"WHERE lower(COALESCE(display_name,'')) LIKE ? OR lower(COALESCE(email_normalized,'')) LIKE ? OR lower(COALESCE(phone_e164,'')) LIKE ? OR lower(id) LIKE ? OR upper(replace(id,'-','')) LIKE ?":"";
    const binds=q?[like,like,like,like,"%"+q.replace(/^REV-US-/i,"").replace(/-/g,"").toUpperCase()+"%"]:[];
    const totalRow=await env.DB.prepare("SELECT COUNT(*) AS total FROM rev_users "+where).bind(...binds).first();
    const rows=await env.DB.prepare("SELECT id,display_name,email_normalized,phone_e164,email_verified_at,phone_verified_at,account_status,role,created_at,updated_at,last_login_at FROM rev_users "+where+" ORDER BY "+sort+" "+order+" LIMIT ? OFFSET ?").bind(...binds,limit,offset).all();
    const data=(rows.results||[]).map(u=>({...u,public_code:"REV-US-"+String(u.id||"").replace(/-/g,"").toUpperCase()}));
    return response(request,env,{success:true,data,total:Number(totalRow?.total)||0,page,limit});
   }
   if(path==="/api/admin/auth-settings" && method==="GET") {
    if(!await admin(request,env)) return response(request,env,{success:false,error:"Unauthorized"},401);
    const r=await env.DB.prepare("SELECT enabled,updated_at,updated_by FROM rev_auth_settings WHERE id=1").first();
    return response(request,env,{success:true,data:r||{enabled:0}});
   }
   if(path==="/api/admin/auth-settings" && method==="POST") {
    if(!await admin(request,env)) return response(request,env,{success:false,error:"Unauthorized"},401);
    const body=await request.json().catch(()=>null);
    if(!body || typeof body.enabled!=="boolean") return response(request,env,{success:false,error:"enabled must be boolean"},400);
    if(body.enabled && !(env.MELIPAYAMAK_USERNAME&&env.MELIPAYAMAK_PASSWORD)) return response(request,env,{success:false,error:"تنظیمات ملی‌پیامک هنوز کامل نیست؛ فعال‌سازی ممکن نیست."},409);
    await env.DB.prepare("INSERT INTO rev_auth_settings(id,enabled,updated_at,updated_by) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at,updated_by=excluded.updated_by")
      .bind(body.enabled?1:0,new Date().toISOString(),"admin").run();
    return response(request,env,{success:true,enabled:body.enabled});
   }
   if(path==="/api/auth/recover" && method==="POST") {
    if(await rateLimited(request,env,"recover",3)) return response(request,env,{success:false,error:"درخواست‌های بازیابی زیاد است؛ یک دقیقه دیگر تلاش کنید."},429);
    if(!sameOrigin(request,env)) return response(request,env,{success:false,error:"Origin not allowed"},403);
    if(!(env.RESEND_API_KEY&&env.EMAIL_FROM&&env.SITE_URL)) return response(request,env,{success:false,error:"سرویس ایمیل بازیابی هنوز پیکربندی نشده است."},503);
    const b=await request.json().catch(()=>null), email=normalizedEmail(b?.email);
    if(!validEmail(email)) return response(request,env,{success:false,error:"ایمیل معتبر وارد کنید."},400);
    const u=await env.DB.prepare("SELECT id FROM rev_users WHERE email_normalized=? AND account_status='active' AND email_verified_at IS NOT NULL LIMIT 1").bind(email).first();
    if(u){
      const now=new Date().toISOString(), token=randomToken(32), exp=new Date(Date.now()+30*60000).toISOString();
      await env.DB.prepare("UPDATE rev_verification_challenges SET consumed_at=? WHERE user_id=? AND purpose='recover' AND consumed_at IS NULL").bind(now,u.id).run();
      await env.DB.prepare("INSERT INTO rev_verification_challenges(id,user_id,channel,destination_normalized,purpose,token_hash,attempts,max_attempts,created_at,expires_at,consumed_at,request_window_key) VALUES(?,?, 'email',?,'recover',?,0,5,?,?,NULL,?)").bind(crypto.randomUUID(),u.id,email,await sha256(token),now,exp,email).run();
      const siteBase=env.SITE_URL.endsWith("/")?env.SITE_URL.slice(0,-1):env.SITE_URL; const link=siteBase+"/reset-password.html?token="+encodeURIComponent(token);
      const mail=await fetch("https://api.resend.com/emails",{method:"POST",headers:{"Authorization":"Bearer "+env.RESEND_API_KEY,"Content-Type":"application/json"},body:JSON.stringify({from:env.EMAIL_FROM,to:[email],subject:"بازیابی رمز عبور REV",text:"برای تعیین رمز عبور جدید REV، این پیوند را تا ۳۰ دقیقه در مرورگر باز کنید:\\n\\n"+link+"\\n\\nاگر شما این درخواست را نداده‌اید، این پیام را نادیده بگیرید."})});
      if(!mail.ok) return response(request,env,{success:false,error:"ارسال ایمیل بازیابی انجام نشد؛ تنظیمات ایمیل را بررسی کنید."},503);
    }
    return response(request,env,{success:true,message:"اگر حساب فعالی با این ایمیل وجود داشته باشد، راهنمای بازیابی ارسال می‌شود."});
   }
   if(path==="/api/auth/reset-password" && method==="POST") {
    if(!sameOrigin(request,env)) return response(request,env,{success:false,error:"Origin not allowed"},403);
    if(await rateLimited(request,env,"reset-password",5)) return response(request,env,{success:false,error:"تلاش‌های زیاد؛ کمی بعد دوباره تلاش کنید."},429);
    const b=await request.json().catch(()=>null), token=String(b?.token||""), password=b?.password;
    if(!token||token.length>200||!passwordValid(password)) return response(request,env,{success:false,error:"پیوند معتبر و رمز عبور حداقل ۱۲ کاراکتری لازم است."},400);
    const ch=await env.DB.prepare("SELECT id,user_id FROM rev_verification_challenges WHERE channel='email' AND purpose='recover' AND token_hash=? AND consumed_at IS NULL AND expires_at>? AND attempts<max_attempts LIMIT 1").bind(await sha256(token),new Date().toISOString()).first();
    if(!ch) return response(request,env,{success:false,error:"پیوند بازیابی منقضی یا نامعتبر است؛ دوباره درخواست دهید."},400);
    const salt=randomToken(16), hash=await passwordHash(password,salt), now=new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE rev_password_credentials SET password_hash=?,password_salt=?,iterations=?,updated_at=? WHERE user_id=?").bind(hash,salt,PBKDF2_ITERATIONS,now,ch.user_id),
      env.DB.prepare("UPDATE rev_verification_challenges SET consumed_at=? WHERE id=?").bind(now,ch.id),
      env.DB.prepare("UPDATE rev_sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL").bind(now,ch.user_id)
    ]);
    return response(request,env,{success:true,message:"رمز عبور تغییر کرد. اکنون با رمز جدید وارد شوید."});
   }
   if(path==="/api/billing/plans" && method==="GET") {
    return response(request,env,{success:true,plans:[
      {code:"navigation_monthly",name:"مسیریاب REV — ماهانه",amountToman:99000,durationDays:30,features:["دسترسی به صفحه مسیریابی و راهنمای مسیر","نمایش مسیر برنامه‌ریزی‌شده در پروفایل راننده","ثبت سفر GPS در حساب شخصی"]},
      {code:"navigation_yearly",name:"مسیریاب REV — سالانه",amountToman:990000,durationDays:365,features:["همه امکانات پلن ماهانه","دسترسی یک‌ساله"] }
    ]});
   }
   if(path==="/api/billing/me" && method==="GET") {
    const u=await currentUser(request,env);
    if(!u) return response(request,env,{success:false,error:"برای مشاهده اشتراک وارد حساب شوید."},401);
    const now=new Date().toISOString();
    const sub=await env.DB.prepare("SELECT id,plan_code,status,starts_at,ends_at,created_at FROM rev_user_subscriptions WHERE user_id=? AND status='active' AND starts_at<=? AND ends_at>? ORDER BY ends_at DESC LIMIT 1").bind(u.id,now,now).first();
    const orders=await env.DB.prepare("SELECT id,plan_code,amount_toman,status,created_at,updated_at,reference,admin_note FROM rev_payment_orders WHERE user_id=? ORDER BY created_at DESC LIMIT 10").bind(u.id).all();
    return response(request,env,{success:true,subscription:sub||null,orders:orders.results||[]});
   }
   if(path==="/api/navigation/access" && method==="GET") {
    const u=await currentUser(request,env);
    if(!u) return response(request,env,{success:true,allowed:false,reason:"login"});
    const now=new Date().toISOString();
    const sub=await env.DB.prepare("SELECT plan_code,ends_at FROM rev_user_subscriptions WHERE user_id=? AND status='active' AND starts_at<=? AND ends_at>? AND plan_code IN ('navigation_monthly','navigation_yearly') ORDER BY ends_at DESC LIMIT 1").bind(u.id,now,now).first();
    return response(request,env,{success:true,allowed:!!sub,subscription:sub||null,reason:sub?null:"plan_required"});
   }
   if(path==="/api/billing/orders" && method==="POST") {
    if(!sameOrigin(request,env)) return response(request,env,{success:false,error:"Origin not allowed"},403);
    const u=await currentUser(request,env);
    if(!u) return response(request,env,{success:false,error:"برای درخواست پلن ابتدا وارد حساب شوید."},401);
    const b=await request.json().catch(()=>null), code=String(b?.planCode||"");
    const plans={navigation_monthly:{amount:99000,name:"مسیریاب REV — ماهانه"},navigation_yearly:{amount:990000,name:"مسیریاب REV — سالانه"}};
    if(!plans[code]) return response(request,env,{success:false,error:"پلن انتخاب‌شده معتبر نیست."},400);
    const id=crypto.randomUUID(),now=new Date().toISOString();
    await env.DB.prepare("INSERT INTO rev_payment_orders(id,user_id,plan_code,amount_toman,status,created_at,updated_at,reference,admin_note,verified_by) VALUES(?,?,?,?, 'pending',?,?,NULL,NULL,NULL)").bind(id,u.id,code,plans[code].amount,now,now).run();
    return response(request,env,{success:true,order:{id,planCode:code,amountToman:plans[code].amount,status:"pending"},message:"درخواست خرید ثبت شد؛ درگاه پرداخت آنلاین هنوز متصل نیست. دسترسی تا تأیید پرداخت توسط مدیریت فعال نمی‌شود."},201);
   }
   if(path==="/api/admin/billing/orders" && method==="GET") {
    if(!await admin(request,env)) return response(request,env,{success:false,error:"Unauthorized"},401);
    const rows=await env.DB.prepare("SELECT o.id,o.plan_code,o.amount_toman,o.status,o.created_at,o.updated_at,o.reference,o.admin_note,u.display_name,u.email_normalized FROM rev_payment_orders o JOIN rev_users u ON u.id=o.user_id ORDER BY CASE o.status WHEN 'pending' THEN 0 ELSE 1 END,o.created_at DESC LIMIT 300").all();
    return response(request,env,{success:true,orders:rows.results||[]});
   }
   if(path.startsWith("/api/admin/billing/orders/") && path.endsWith("/review") && method==="POST") {
    if(!await admin(request,env)) return response(request,env,{success:false,error:"Unauthorized"},401);
    const id=path.split("/")[5], b=await request.json().catch(()=>null), status=String(b?.status||"");
    if(!id||!["approved","rejected"].includes(status)) return response(request,env,{success:false,error:"شناسه یا وضعیت درخواست معتبر نیست."},400);
    const order=await env.DB.prepare("SELECT id,user_id,plan_code,status FROM rev_payment_orders WHERE id=? LIMIT 1").bind(id).first();
    if(!order) return response(request,env,{success:false,error:"درخواست پرداخت پیدا نشد."},404);
    if(order.status!=="pending") return response(request,env,{success:false,error:"این درخواست قبلاً بررسی شده است."},409);
    const now=new Date().toISOString(), note=String(b.note||"").slice(0,500), ref=String(b.reference||"").slice(0,120);
    if(status==="approved"){
      const days=order.plan_code==="navigation_yearly"?365:30;
      const active=await env.DB.prepare("SELECT ends_at FROM rev_user_subscriptions WHERE user_id=? AND plan_code IN ('navigation_monthly','navigation_yearly') AND status='active' AND ends_at>? ORDER BY ends_at DESC LIMIT 1").bind(order.user_id,now).first();
      const start=active?.ends_at&&active.ends_at>now?active.ends_at:now, end=new Date(Date.parse(start)+days*86400000).toISOString();
      await env.DB.batch([
        env.DB.prepare("UPDATE rev_payment_orders SET status='approved',updated_at=?,reference=?,admin_note=?,verified_by='admin' WHERE id=?").bind(now,ref,note,id),
        env.DB.prepare("UPDATE rev_user_subscriptions SET status='expired',updated_at=? WHERE user_id=? AND status='active'").bind(now,order.user_id),
        env.DB.prepare("INSERT INTO rev_user_subscriptions(id,user_id,plan_code,status,starts_at,ends_at,created_at,updated_at,source,payment_order_id) VALUES(?,?,?,'active',?,?,?,?, 'manual_review',?)").bind(crypto.randomUUID(),order.user_id,order.plan_code,start,end,now,now,id)
      ]);
    } else {
      await env.DB.prepare("UPDATE rev_payment_orders SET status='rejected',updated_at=?,reference=?,admin_note=?,verified_by='admin' WHERE id=?").bind(now,ref,note,id).run();
    }
    return response(request,env,{success:true,status,message:status==="approved"?"اشتراک فعال شد.":"درخواست رد شد."});
   }
   if(path==="/api/auth/sms/request" && method==="POST") {
    if(!sameOrigin(request,env)) return response(request,env,{success:false,error:"Origin not allowed"},403);
    if(!await enabled(env)) return response(request,env,{success:false,error:"ورود پیامکی فعلاً غیرفعال است؛ مدیر باید آن را فعال کند."},403);
    if(await rateLimited(request,env,"sms-request",5,600)) return response(request,env,{success:false,error:"درخواست کد بیش از حد است؛ کمی بعد دوباره تلاش کنید."},429);
    if(!(env.MELIPAYAMAK_USERNAME&&env.MELIPAYAMAK_PASSWORD)) return response(request,env,{success:false,error:"تنظیمات ملی‌پیامک کامل نیست."},503);
    const b=await request.json().catch(()=>null), parsed=normalizeIranPhone(b?.phone);
    if(!parsed) return response(request,env,{success:false,error:"شماره همراه معتبر ایران وارد کنید."},400);
    const phone=parsed.e164, now=new Date().toISOString();
    let u=await env.DB.prepare("SELECT id,account_status FROM rev_users WHERE phone_e164=? LIMIT 1").bind(phone).first();
    let created=false;
    if(u && ["suspended","deleted"].includes(u.account_status)) return response(request,env,{success:false,error:"این حساب در حال حاضر قابل استفاده نیست."},403);
    if(!u) {
      const id=crypto.randomUUID(), syntheticEmail=phone.replace("+","")+"@phone.rev.invalid";
      try {
        await env.DB.prepare("INSERT INTO rev_users(id,display_name,email_normalized,phone_e164,account_status,role,created_at,updated_at) VALUES(?,?,?,?, 'pending','member',?,?)")
          .bind(id,"کاربر REV",syntheticEmail,phone,now,now).run();
      } catch(e) {
        return response(request,env,{success:false,error:"ساخت حساب انجام نشد؛ ممکن است این شماره قبلاً ثبت شده باشد."},409);
      }
      u={id,account_status:"pending"}; created=true;
    }
    const code=String(crypto.getRandomValues(new Uint32Array(1))[0]%1000000).padStart(6,"0");
    const exp=new Date(Date.now()+5*60000).toISOString();
    await env.DB.prepare("UPDATE rev_verification_challenges SET consumed_at=? WHERE channel='sms' AND purpose='login' AND destination_normalized=? AND consumed_at IS NULL").bind(now,phone).run();
    const challengeId=crypto.randomUUID();
    await env.DB.prepare("INSERT INTO rev_verification_challenges(id,user_id,channel,destination_normalized,purpose,token_hash,attempts,max_attempts,created_at,expires_at,consumed_at,request_window_key) VALUES(?,?,'sms',?,'login',?,0,5,?,?,NULL,?)")
      .bind(challengeId,u.id,phone,await sha256(phone+":"+code),now,exp,phone).run();
    try { await sendOtpPattern(env,parsed.local,code); }
    catch(e) {
      await env.DB.prepare("UPDATE rev_verification_challenges SET consumed_at=? WHERE id=?").bind(new Date().toISOString(),challengeId).run();
      if(created) await env.DB.prepare("DELETE FROM rev_users WHERE id=?").bind(u.id).run();
      return response(request,env,{success:false,error:"ارسال کد انجام نشد؛ تنظیمات وب‌سرویس، اعتبار پنل و پترن 557785 را بررسی کنید."},502);
    }
    return response(request,env,{success:true,message:"اگر ارسال پیامک پذیرفته شده باشد، کد ورود تا ۵ دقیقه معتبر است.",phone:parsed.local});
   }
   if(path==="/api/auth/sms/verify" && method==="POST") {
    if(!sameOrigin(request,env)) return response(request,env,{success:false,error:"Origin not allowed"},403);
    if(await rateLimited(request,env,"sms-verify",10,600)) return response(request,env,{success:false,error:"تعداد تلاش‌ها زیاد است؛ کمی بعد دوباره تلاش کنید."},429);
    const b=await request.json().catch(()=>null), parsed=normalizeIranPhone(b?.phone), code=String(b?.code||"").replace(/[۰-۹]/g,d=>String("۰۱۲۳۴۵۶۷۸۹".indexOf(d))).replace(/[٠-٩]/g,d=>String("٠١٢٣٤٥٦٧٨٩".indexOf(d))).replace(/\D/g,"");
    if(!parsed || !/^\d{6}$/.test(code)) return response(request,env,{success:false,error:"شماره همراه یا کد شش‌رقمی معتبر نیست."},400);
    const now=new Date().toISOString(), phone=parsed.e164;
    const ch=await env.DB.prepare("SELECT id,user_id,token_hash,attempts,max_attempts FROM rev_verification_challenges WHERE channel='sms' AND purpose='login' AND destination_normalized=? AND consumed_at IS NULL AND expires_at>? AND attempts<max_attempts ORDER BY created_at DESC LIMIT 1").bind(phone,now).first();
    if(!ch) return response(request,env,{success:false,error:"کد منقضی یا نامعتبر است؛ دوباره کد بگیرید."},400);
    if(await sha256(phone+":"+code)!==ch.token_hash) {
      await env.DB.prepare("UPDATE rev_verification_challenges SET attempts=attempts+1 WHERE id=?").bind(ch.id).run();
      return response(request,env,{success:false,error:"کد واردشده صحیح نیست."},401);
    }
    const u=await env.DB.prepare("SELECT id,account_status FROM rev_users WHERE id=? AND phone_e164=? LIMIT 1").bind(ch.user_id,phone).first();
    if(!u || ["suspended","deleted"].includes(u.account_status)) return response(request,env,{success:false,error:"حساب کاربری قابل استفاده نیست."},403);
    await env.DB.batch([
      env.DB.prepare("UPDATE rev_verification_challenges SET consumed_at=? WHERE id=?").bind(now,ch.id),
      env.DB.prepare("UPDATE rev_users SET phone_verified_at=?,account_status='active',last_login_at=?,updated_at=? WHERE id=?").bind(now,now,now,u.id)
    ]);
    return await createSession(request,env,u.id);
   }
   if(path==="/api/auth/register" && method==="POST") {
    return response(request,env,{success:false,error:"ثبت‌نام از طریق شماره همراه و کد پیامکی انجام می‌شود."},410);
   }
   if(path==="/api/auth/register-email-disabled" && method==="POST") {
    if(await rateLimited(request,env,"register",3)) return response(request,env,{success:false,error:"تعداد درخواست‌ها زیاد است؛ یک دقیقه دیگر تلاش کنید."},429);
    if(!sameOrigin(request,env)) return response(request,env,{success:false,error:"Origin not allowed"},403);
    if(!await enabled(env)) return response(request,env,{success:false,error:"ثبت‌نام و ورود فعلاً غیرفعال است."},403);
    if(!(env.RESEND_API_KEY&&env.EMAIL_FROM&&env.SITE_URL)) return response(request,env,{success:false,error:"ارسال ایمیل هنوز راه‌اندازی نشده است."},503);
    const b=await request.json().catch(()=>null), email=normalizedEmail(b?.email), name=String(b?.displayName||"").trim().slice(0,80), password=b?.password;
    if(!validEmail(email)||!name||!passwordValid(password)) return response(request,env,{success:false,error:"نام، ایمیل معتبر و رمز عبور حداقل ۱۲ کاراکتری لازم است."},400);
    const old=await env.DB.prepare("SELECT id FROM rev_users WHERE email_normalized=? LIMIT 1").bind(email).first();
    if(old) return response(request,env,{success:false,error:"اگر امکان ثبت‌نام با این ایمیل وجود داشته باشد، راهنمای ادامه ارسال می‌شود."},409);
    const id=crypto.randomUUID(), now=new Date().toISOString(), salt=randomToken(16), hash=await passwordHash(password,salt);
    await env.DB.prepare("INSERT INTO rev_users(id,display_name,email_normalized,account_status,role,created_at,updated_at) VALUES(?,?,?,'pending','member',?,?)").bind(id,name,email,now,now).run();
    await env.DB.prepare("INSERT INTO rev_password_credentials(user_id,password_hash,password_salt,hash_algorithm,iterations,created_at,updated_at) VALUES(?,?,?,'PBKDF2-SHA256',?,?,?)").bind(id,hash,salt,PBKDF2_ITERATIONS,now,now).run();
    const token=randomToken(32), tokenHash=await sha256(token), exp=new Date(Date.now()+VERIFY_MINUTES*60000).toISOString();
    await env.DB.prepare("INSERT INTO rev_verification_challenges(id,user_id,channel,destination_normalized,purpose,token_hash,attempts,max_attempts,created_at,expires_at,consumed_at,request_window_key) VALUES(?,?, 'email',?,'verify_email',?,0,5,?,?,NULL,?)")
      .bind(crypto.randomUUID(),id,email,tokenHash,now,exp,email).run();
    try { await sendVerification(env,email,token); }
    catch(e) { await env.DB.prepare("DELETE FROM rev_users WHERE id=?").bind(id).run(); return response(request,env,{success:false,error:"ارسال ایمیل ناموفق بود؛ تنظیمات سرویس ایمیل را بررسی کنید."},503); }
    return response(request,env,{success:true,message:"حساب ساخته شد؛ ایمیل خود را برای تأیید بررسی کنید."},201);
   }
   if(path==="/api/auth/verify-email" && method==="POST") {
    if(!sameOrigin(request,env)) return response(request,env,{success:false,error:"Origin not allowed"},403);
    const b=await request.json().catch(()=>null), token=String(b?.token||"");
    if(!token || token.length>200) return response(request,env,{success:false,error:"پیوند تأیید نامعتبر است."},400);
    const ch=await env.DB.prepare("SELECT id,user_id FROM rev_verification_challenges WHERE channel='email' AND purpose='verify_email' AND token_hash=? AND consumed_at IS NULL AND expires_at>? AND attempts<max_attempts LIMIT 1").bind(await sha256(token),new Date().toISOString()).first();
    if(!ch) return response(request,env,{success:false,error:"پیوند منقضی یا نامعتبر است."},400);
    const now=new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE rev_verification_challenges SET consumed_at=? WHERE id=?").bind(now,ch.id),
      env.DB.prepare("UPDATE rev_users SET email_verified_at=?,account_status='active',updated_at=? WHERE id=? AND account_status='pending'").bind(now,now,ch.user_id)
    ]);
    return response(request,env,{success:true,message:"ایمیل تأیید شد؛ اکنون می‌توانید وارد شوید."});
   }
   if(path==="/api/auth/login" && method==="POST") {
    return response(request,env,{success:false,error:"ورود با ایمیل غیرفعال شده است؛ از ورود پیامکی استفاده کنید."},410);
   }
   if(path==="/api/auth/login-email-disabled" && method==="POST") {
    if(await rateLimited(request,env,"login",8)) return response(request,env,{success:false,error:"تلاش‌های ورود بیش از حد است؛ یک دقیقه دیگر تلاش کنید."},429);
    if(!sameOrigin(request,env)) return response(request,env,{success:false,error:"Origin not allowed"},403);
    if(!await enabled(env)) return response(request,env,{success:false,error:"ورود و ثبت‌نام فعلاً غیرفعال است."},403);
    const b=await request.json().catch(()=>null), email=normalizedEmail(b?.email), password=b?.password;
    if(!validEmail(email)||typeof password!=="string"||password.length>128) return response(request,env,{success:false,error:"ایمیل یا رمز عبور نادرست است."},400);
    const u=await env.DB.prepare("SELECT u.id,u.account_status,u.email_verified_at,c.password_hash,c.password_salt,c.iterations FROM rev_users u JOIN rev_password_credentials c ON c.user_id=u.id WHERE u.email_normalized=? LIMIT 1").bind(email).first();
    if(!u) { await passwordHash(password,randomToken(16)); return response(request,env,{success:false,error:"ایمیل یا رمز عبور نادرست است."},401); }
    const candidate=await passwordHash(password,u.password_salt,Number(u.iterations)||PBKDF2_ITERATIONS);
    if(candidate!==u.password_hash) return response(request,env,{success:false,error:"ایمیل یا رمز عبور نادرست است."},401);
    if(!u.email_verified_at||u.account_status!=="active") return response(request,env,{success:false,error:"ابتدا ایمیل خود را تأیید کنید."},403);
    await env.DB.prepare("UPDATE rev_users SET last_login_at=?,updated_at=? WHERE id=?").bind(new Date().toISOString(),new Date().toISOString(),u.id).run();
    return await createSession(request,env,u.id);
   }
   if(path==="/api/auth/me" && method==="GET") {
    const u=await currentUser(request,env);
    return u?response(request,env,{success:true,user:u}):response(request,env,{success:false,user:null},401);
   }
   // Private EV trip telemetry. Every route is scoped to the authenticated user.
   if(path==="/api/driver/profile" && method==="GET") {
    const u=await currentUser(request,env);
    if(!u) return response(request,env,{success:false,error:"برای مشاهده پروفایل راننده وارد حساب کاربری شوید."},401);
    const row=await env.DB.prepare("SELECT COUNT(*) AS trips, COALESCE(SUM(distance_km),0) AS distance_km, COALESCE(SUM(energy_kwh),0) AS energy_kwh, SUM(CASE WHEN distance_km>0 AND energy_kwh>0 THEN energy_kwh END) AS measured_energy, SUM(CASE WHEN distance_km>0 AND energy_kwh>0 THEN distance_km END) AS measured_distance, MAX(ended_at) AS last_trip_at FROM rev_driver_trips WHERE user_id=?").bind(u.id).first();
    const recent=await env.DB.prepare("SELECT id,vehicle_name,vehicle_type,started_at,ended_at,distance_km,energy_kwh,start_soc,end_soc,energy_source,route_saved,created_at FROM rev_driver_trips WHERE user_id=? ORDER BY COALESCE(ended_at,created_at) DESC LIMIT 100").bind(u.id).all();
    const md=Number(row?.measured_distance)||0, me=Number(row?.measured_energy)||0;
    return response(request,env,{success:true,profile:{tripCount:Number(row?.trips)||0,totalDistanceKm:Number(row?.distance_km)||0,totalEnergyKwh:Number(row?.energy_kwh)||0,averageKwhPer100Km:md>0&&me>0?me/md*100:null,lastTripAt:row?.last_trip_at||null},trips:recent.results||[]});
   }
   if(path==="/api/driver/trips" && method==="GET") {
    const u=await currentUser(request,env);
    if(!u) return response(request,env,{success:false,error:"برای مشاهده سفرها وارد حساب کاربری شوید."},401);
    const rows=await env.DB.prepare("SELECT id,vehicle_name,vehicle_type,started_at,ended_at,distance_km,energy_kwh,start_soc,end_soc,energy_source,route_saved,created_at FROM rev_driver_trips WHERE user_id=? ORDER BY created_at DESC LIMIT 100").bind(u.id).all();
    return response(request,env,{success:true,trips:rows.results||[]});
   }
   if(path==="/api/driver/trips" && method==="POST") {
    if(!sameOrigin(request,env)) return response(request,env,{success:false,error:"Origin not allowed"},403);
    const u=await currentUser(request,env);
    if(!u) return response(request,env,{success:false,error:"برای ثبت سفر وارد حساب کاربری شوید."},401);
    const b=await request.json().catch(()=>null);
    if(!b||typeof b!=="object") return response(request,env,{success:false,error:"داده سفر نامعتبر است."},400);
    const distance=Number(b.distanceKm), energy=Number(b.energyKwh), startSoc=b.startSoc==null?null:Number(b.startSoc), endSoc=b.endSoc==null?null:Number(b.endSoc);
    if(!Number.isFinite(distance)||distance<=0||distance>5000||!Number.isFinite(energy)||energy<0||energy>2000) return response(request,env,{success:false,error:"مسافت یا انرژی ثبت‌شده معتبر نیست."},400);
    if((startSoc!==null&&(!Number.isFinite(startSoc)||startSoc<0||startSoc>100))||(endSoc!==null&&(!Number.isFinite(endSoc)||endSoc<0||endSoc>100))) return response(request,env,{success:false,error:"درصد شارژ باید بین صفر تا ۱۰۰ باشد."},400);
    const started=String(b.startedAt||""); const ended=String(b.endedAt||"");
    if(!started||!Number.isFinite(Date.parse(started))||!ended||!Number.isFinite(Date.parse(ended))||Date.parse(ended)<Date.parse(started)) return response(request,env,{success:false,error:"زمان شروع یا پایان سفر معتبر نیست."},400);
    let routeJson=null;
    if(b.saveRoute===true&&Array.isArray(b.routePoints)){
      if(b.routePoints.length>5000) return response(request,env,{success:false,error:"تعداد نقاط مسیر بیش از حد مجاز است."},413);
      const pts=[];
      for(const p of b.routePoints){const lat=Number(p?.lat),lon=Number(p?.lon),ts=Number(p?.ts);if(!Number.isFinite(lat)||lat < -90||lat>90||!Number.isFinite(lon)||lon < -180||lon>180) return response(request,env,{success:false,error:"مختصات مسیر معتبر نیست."},400);pts.push({lat,lon,ts:Number.isFinite(ts)?ts:null});}
      routeJson=JSON.stringify(pts);
      if(routeJson.length>350000) return response(request,env,{success:false,error:"حجم مسیر بیش از حد مجاز است."},413);
    }
    const id=crypto.randomUUID(),now=new Date().toISOString(),vehicle=String(b.vehicleName||"خودروی ثبت‌نشده").trim().slice(0,100),vehicleType=["bev","phev","hev","mhev"].includes(b.vehicleType)?b.vehicleType:"bev",source=["obd","vehicle_api","gps_estimate","manual"].includes(b.energySource)?b.energySource:"gps_estimate";
    await env.DB.prepare("INSERT INTO rev_driver_trips(id,user_id,vehicle_name,vehicle_type,started_at,ended_at,distance_km,energy_kwh,start_soc,end_soc,energy_source,route_json,route_saved,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,u.id,vehicle,vehicleType,started,ended,distance,energy,startSoc,endSoc,source,routeJson,routeJson?1:0,now).run();
    return response(request,env,{success:true,id,routeSaved:!!routeJson,message:"سفر در پروفایل خصوصی شما ثبت شد."},201);
   }
   if(path.startsWith("/api/driver/trips/") && path.endsWith("/delete") && method==="POST") {
    if(!sameOrigin(request,env)) return response(request,env,{success:false,error:"Origin not allowed"},403);
    const u=await currentUser(request,env);
    if(!u) return response(request,env,{success:false,error:"ابتدا وارد حساب کاربری شوید."},401);
    const id=path.split("/")[4];
    if(!id||id==="delete") return response(request,env,{success:false,error:"شناسه سفر معتبر نیست."},400);
    const result=await env.DB.prepare("DELETE FROM rev_driver_trips WHERE id=? AND user_id=?").bind(id,u.id).run();
    return response(request,env,{success:true,deleted:Number(result.meta?.changes)||0});
   }
   if(path==="/api/auth/logout" && method==="POST") {
    if(!sameOrigin(request,env)) return response(request,env,{success:false,error:"Origin not allowed"},403);
    const raw=(request.headers.get("Cookie")||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(COOKIE_NAME+"="))?.slice(COOKIE_NAME.length+1);
    if(raw) await env.DB.prepare("UPDATE rev_sessions SET revoked_at=? WHERE session_token_hash=? AND revoked_at IS NULL").bind(new Date().toISOString(),await sha256(decodeURIComponent(raw))).run();
    return response(request,env,{success:true},200,{"Set-Cookie":clearCookie()});
   }
   // Public business directory: only approved profiles and approved products are exposed.
   if(path==="/api/businesses" && method==="GET") {
    const type=url.searchParams.get("type")||"";
    if(type&&!["store","repair","charging"].includes(type)) return response(request,env,{success:false,error:"نوع کسب‌وکار معتبر نیست."},400);
    const nowIso=new Date().toISOString();
    const rows=await env.DB.prepare("SELECT b.id,b.business_type,b.name,b.city,b.address,b.latitude,b.longitude,b.phone,b.website,b.description,b.services_json,b.brands_json,b.opening_hours,b.created_at,b.updated_at,a.plan_code,a.plan_status,a.payment_status,a.starts_at,a.expires_at,a.features_json FROM rev_business_profiles b LEFT JOIN rev_business_plan_assignments a ON a.business_id=b.id WHERE b.status='approved' AND (?='' OR b.business_type=?) ORDER BY b.name LIMIT 500").bind(type,type).all();
    const now=Date.now(), businesses=(rows.results||[]).filter(b=>effectiveFeatures(b,now).listing!==false).map(b=>{
     const f=effectiveFeatures(b,now), x={...b,plan_features:f};
     if(f.contact===false){x.phone=null;x.address=null;}
     if(f.hours===false)x.opening_hours=null;
     if(f.services===false){x.services_json='[]';x.brands_json='[]';}
     if(f.links===false)x.website=null;
     return x;
    });
    const prods=await env.DB.prepare("SELECT p.id,p.business_id,p.title,p.description,p.price_text,p.image_url,p.product_url,p.stock_status,p.updated_at FROM rev_business_products p JOIN rev_business_profiles b ON b.id=p.business_id WHERE p.status='approved' AND b.status='approved' ORDER BY p.updated_at DESC LIMIT 500").all();
    return response(request,env,{success:true,businesses,products:prods.results||[]});
   }
   if(path==="/api/portal/profile" && method==="POST") {
    if(!sameOrigin(request,env)) return response(request,env,{success:false,error:"Origin not allowed"},403);
    const u=await currentUser(request,env);
    if(!u) return response(request,env,{success:false,error:"برای تغییر پروفایل وارد حساب شوید."},401);
    const b=await request.json().catch(()=>null), displayName=String(b?.displayName||"").trim().slice(0,80);
    if(!displayName) return response(request,env,{success:false,error:"نام نمایشی را وارد کنید."},400);
    const avatar=b?.avatarData;
    if(avatar!==undefined && avatar!==null && avatar!=="" && (typeof avatar!=="string" || avatar.length>350000 || !/^data:image\/(jpeg|png|webp);base64,/.test(avatar))) return response(request,env,{success:false,error:"تصویر نامعتبر یا بیش از حد بزرگ است."},400);
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS rev_user_profiles (user_id TEXT PRIMARY KEY, avatar_data TEXT, updated_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES rev_users(id))").run();
    const existing=await env.DB.prepare("SELECT avatar_data FROM rev_user_profiles WHERE user_id=?").bind(u.id).first();
    const avatarData=avatar===undefined?(existing?.avatar_data||null):avatar;
    const now=new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("UPDATE rev_users SET display_name=?,updated_at=? WHERE id=?").bind(displayName,now,u.id),
      env.DB.prepare("INSERT INTO rev_user_profiles(user_id,avatar_data,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET avatar_data=excluded.avatar_data,updated_at=excluded.updated_at").bind(u.id,avatarData,now)
    ]);
    return response(request,env,{success:true,user:{...u,display_name:displayName,avatar_data:avatarData}});
   }
   if(path==="/api/portal/me" && method==="GET") {
    const u=await currentUser(request,env);
    if(!u) return response(request,env,{success:false,error:"برای ورود به پنل ابتدا وارد حساب کاربری شوید."},401);
    await env.DB.prepare("CREATE TABLE IF NOT EXISTS rev_user_profiles (user_id TEXT PRIMARY KEY, avatar_data TEXT, updated_at TEXT NOT NULL, FOREIGN KEY(user_id) REFERENCES rev_users(id))").run();
    const profile=await env.DB.prepare("SELECT avatar_data FROM rev_user_profiles WHERE user_id=?").bind(u.id).first();
    u.avatar_data=profile?.avatar_data||null;
    const businesses=await env.DB.prepare("SELECT b.*,a.plan_code,a.plan_name,a.plan_status,a.payment_status AS plan_payment_status,a.starts_at AS plan_starts_at,a.expires_at AS plan_expires_at,a.features_json AS plan_features_json,a.admin_note AS plan_admin_note FROM rev_business_profiles b LEFT JOIN rev_business_plan_assignments a ON a.business_id=b.id WHERE b.owner_user_id=? ORDER BY b.updated_at DESC LIMIT 100").bind(u.id).all();
    const now=Date.now(), businessRows=(businesses.results||[]).map(b=>({...b,plan_features:effectiveFeatures({plan_status:b.plan_status,payment_status:b.plan_payment_status,starts_at:b.plan_starts_at,expires_at:b.plan_expires_at,features_json:b.plan_features_json},now),plan_is_active:isPlanActive({plan_status:b.plan_status,payment_status:b.plan_payment_status,starts_at:b.plan_starts_at,expires_at:b.plan_expires_at},now)}));
    const products=await env.DB.prepare("SELECT p.*,b.name AS business_name FROM rev_business_products p JOIN rev_business_profiles b ON b.id=p.business_id WHERE b.owner_user_id=? ORDER BY p.updated_at DESC LIMIT 200").bind(u.id).all();
    return response(request,env,{success:true,user:u,businesses:businessRows,products:products.results||[]});
   }
   if(path==="/api/portal/businesses" && method==="POST") {
    if(!sameOrigin(request,env)) return response(request,env,{success:false,error:"Origin not allowed"},403);
    const u=await currentUser(request,env);
    if(!u) return response(request,env,{success:false,error:"برای ثبت کسب‌وکار وارد حساب شوید."},401);
    const b=await request.json().catch(()=>null), type=String(b?.businessType||""), name=String(b?.name||"").trim(), city=String(b?.city||"").trim(), address=String(b?.address||"").trim();
    if(!b||!["store","repair","charging"].includes(type)||!name||name.length>120||!city||city.length>80||!address||address.length>1000) return response(request,env,{success:false,error:"نوع کسب‌وکار، نام، شهر و نشانی معتبر الزامی است."},400);
    const phone=String(b.phone||"").trim().slice(0,40), website=String(b.website||"").trim().slice(0,300), description=String(b.description||"").trim().slice(0,3000), opening=String(b.openingHours||"").trim().slice(0,200), license=String(b.licenseDetails||"").trim().slice(0,500);
    for(const v of [website]) if(v && !/^https?:\/\//i.test(v)) return response(request,env,{success:false,error:"آدرس وب‌سایت باید با https:// یا http:// شروع شود."},400);
    const lat=b.latitude==null||b.latitude===""?null:Number(b.latitude), lon=b.longitude==null||b.longitude===""?null:Number(b.longitude);
    if((lat!==null&&(!Number.isFinite(lat)||lat < -90||lat>90))||(lon!==null&&(!Number.isFinite(lon)||lon < -180||lon>180))||((lat===null)!==(lon===null))) return response(request,env,{success:false,error:"مختصات جغرافیایی نامعتبر است؛ هر دو مقدار را وارد کنید."},400);
    const asList=v=>Array.isArray(v)?v.slice(0,50).map(x=>String(x).trim().slice(0,100)).filter(Boolean):[];
    const services=JSON.stringify(asList(b.services)), brands=JSON.stringify(asList(b.brands)), now=new Date().toISOString();
    let id=String(b.id||"").trim();
    if(id){
     const old=await env.DB.prepare("SELECT id,status FROM rev_business_profiles WHERE id=? AND owner_user_id=? LIMIT 1").bind(id,u.id).first();
     if(!old) return response(request,env,{success:false,error:"این پروفایل متعلق به حساب شما نیست."},404);
     const assignment=await env.DB.prepare("SELECT plan_status,payment_status,starts_at,expires_at,features_json FROM rev_business_plan_assignments WHERE business_id=? LIMIT 1").bind(id).first();
     if(assignment && isPlanActive(assignment,Date.now()) && effectiveFeatures(assignment,Date.now()).edit!==true)
       return response(request,env,{success:false,error:"ویرایش پروفایل در پلن فعلی غیرفعال است؛ با مدیریت REV هماهنگ کنید."},403);
     await env.DB.prepare("UPDATE rev_business_profiles SET business_type=?,name=?,city=?,address=?,latitude=?,longitude=?,phone=?,website=?,description=?,services_json=?,brands_json=?,opening_hours=?,license_details=?,status='pending',moderation_note=NULL,updated_at=? WHERE id=? AND owner_user_id=?").bind(type,name,city,address,lat,lon,phone,website,description,services,brands,opening,license,now,id,u.id).run();
     await env.DB.prepare("UPDATE rev_business_products SET status='pending',updated_at=? WHERE business_id=? AND status='approved'").bind(now,id).run();
    } else {
     id=crypto.randomUUID();
     await env.DB.prepare("INSERT INTO rev_business_profiles(id,owner_user_id,business_type,name,city,address,latitude,longitude,phone,website,description,services_json,brands_json,opening_hours,license_details,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)").bind(id,u.id,type,name,city,address,lat,lon,phone,website,description,services,brands,opening,license,now,now).run();
    }
    return response(request,env,{success:true,id,status:"pending",message:"درخواست ثبت شد و پس از بررسی مدیریت REV نمایش داده می‌شود."},201);
   }
   if(path.startsWith("/api/portal/businesses/") && path.endsWith("/plan-request") && method==="POST") {
    if(TEMPORARY_OPEN_ACCESS) return response(request,env,{success:false,error:"پلن‌های پولی REV در دوره توسعه موقتاً غیرفعال هستند؛ همه امکانات بدون نیاز به پلن در دسترس‌اند."},503);
    if(!sameOrigin(request,env)) return response(request,env,{success:false,error:"Origin not allowed"},403);
    const u=await currentUser(request,env);
    if(!u) return response(request,env,{success:false,error:"برای درخواست پلن ابتدا وارد حساب شوید."},401);
    const parts=path.split("/"), id=parts[4], b=await request.json().catch(()=>null), code=String(b?.planCode||"");
    const plans={professional:"پلن حرفه‌ای",featured:"پلن ویژه",sponsor:"پلن حامی / تبلیغاتی"};
    if(!id||!plans[code]) return response(request,env,{success:false,error:"پلن انتخاب‌شده معتبر نیست."},400);
    const business=await env.DB.prepare("SELECT id,business_type,status FROM rev_business_profiles WHERE id=? AND owner_user_id=? LIMIT 1").bind(id,u.id).first();
    if(!business) return response(request,env,{success:false,error:"کسب‌وکار متعلق به حساب شما نیست."},404);
    const current=await env.DB.prepare("SELECT plan_status,payment_status,starts_at,expires_at FROM rev_business_plan_assignments WHERE business_id=? LIMIT 1").bind(id).first();
    if(current && isPlanActive(current,Date.now())) return response(request,env,{success:false,error:"این کسب‌وکار پلن فعال دارد؛ برای تغییر پلن با مدیریت REV هماهنگ کنید."},409);
    const now=new Date().toISOString(), expires=new Date(Date.now()+365*86400000).toISOString();
    const features={listing:false,contact:false,edit:false,logo:false,photos:false,hours:false,services:false,links:false,stats:false,highlight:false,priority:false,map_pin:false,report:false,campaign:false,banner:false,sponsored:false,social:false,custom:false,product_catalog:false};
    await env.DB.prepare("INSERT INTO rev_business_plan_assignments(business_id,plan_code,plan_name,plan_status,payment_status,starts_at,expires_at,features_json,admin_note,assigned_by,created_at,updated_at) VALUES(?,?,?,'pending_payment','pending',?,?,?,?,?,?,?) ON CONFLICT(business_id) DO UPDATE SET plan_code=excluded.plan_code,plan_name=excluded.plan_name,plan_status='pending_payment',payment_status='pending',starts_at=excluded.starts_at,expires_at=excluded.expires_at,features_json=excluded.features_json,admin_note='درخواست پلن توسط صاحب کسب‌وکار؛ نیازمند بررسی و تأیید مدیر.',assigned_by=excluded.assigned_by,updated_at=excluded.updated_at")
      .bind(id,code,plans[code],now,expires,JSON.stringify(features),"درخواست پلن توسط صاحب کسب‌وکار؛ نیازمند بررسی و تأیید مدیر.",u.id,now,now).run();
    return response(request,env,{success:true,status:"pending_payment",message:"درخواست پلن ثبت شد و برای بررسی مدیریت REV ارسال شد. هیچ دسترسی پولی تا تأیید مدیر فعال نخواهد شد."},201);
   }
   if(path==="/api/portal/products" && method==="POST") {
    if(!sameOrigin(request,env)) return response(request,env,{success:false,error:"Origin not allowed"},403);
    const u=await currentUser(request,env);
    if(!u) return response(request,env,{success:false,error:"برای ثبت محصول وارد حساب شوید."},401);
    const b=await request.json().catch(()=>null), businessId=String(b?.businessId||""), title=String(b?.title||"").trim();
    if(!businessId||!title||title.length>160) return response(request,env,{success:false,error:"فروشگاه و نام محصول الزامی است."},400);
    const shop=await env.DB.prepare("SELECT id,status,business_type FROM rev_business_profiles WHERE id=? AND owner_user_id=? LIMIT 1").bind(businessId,u.id).first();
    if(!shop||shop.business_type!=="store") return response(request,env,{success:false,error:"فروشگاه انتخاب‌شده متعلق به شما نیست."},403);
    if(shop.status!=="approved") return response(request,env,{success:false,error:"ابتدا فروشگاه باید توسط مدیریت REV تأیید شود."},409);
    const assignment=await env.DB.prepare("SELECT plan_code,plan_status,payment_status,starts_at,expires_at,features_json FROM rev_business_plan_assignments WHERE business_id=? LIMIT 1").bind(businessId).first();
    if(!TEMPORARY_OPEN_ACCESS && (!assignment || !isPlanActive(assignment,Date.now()) || effectiveFeatures(assignment,Date.now()).product_catalog!==true))
      return response(request,env,{success:false,error:"ثبت محصول در پلن فعلی فعال نیست. برای فعال‌سازی پلن حرفه‌ای یا بالاتر را از مدیریت REV پیگیری کنید."},403);
    const price=String(b.priceText||"").trim().slice(0,100), image=String(b.imageUrl||"").trim().slice(0,500), productUrl=String(b.productUrl||"").trim().slice(0,500), desc=String(b.description||"").trim().slice(0,2000), stock=["in_stock","out_of_stock","preorder","unknown"].includes(b.stockStatus)?b.stockStatus:"unknown";
    if((image&&!/^https?:\/\//i.test(image))||(productUrl&&!/^https?:\/\//i.test(productUrl))) return response(request,env,{success:false,error:"لینک تصویر و محصول باید با http:// یا https:// شروع شود."},400);
    const id=crypto.randomUUID(),now=new Date().toISOString();
    await env.DB.prepare("INSERT INTO rev_business_products(id,business_id,title,description,price_text,image_url,product_url,stock_status,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'pending',?,?)").bind(id,businessId,title,desc,price,image,productUrl,stock,now,now).run();
    return response(request,env,{success:true,id,status:"pending",message:"محصول برای بررسی مدیر REV ارسال شد."},201);
   }
   if(path==="/api/admin/businesses" && method==="GET") {
    if(!await admin(request,env)) return response(request,env,{success:false,error:"Unauthorized"},401);
    const businesses=await env.DB.prepare("SELECT b.*,u.display_name AS owner_name,u.email_normalized AS owner_email,a.plan_code,a.plan_name,a.plan_status,a.payment_status AS plan_payment_status,a.starts_at AS plan_starts_at,a.expires_at AS plan_expires_at,a.features_json AS plan_features_json,a.admin_note AS plan_admin_note FROM rev_business_profiles b JOIN rev_users u ON u.id=b.owner_user_id LEFT JOIN rev_business_plan_assignments a ON a.business_id=b.id ORDER BY CASE b.status WHEN 'pending' THEN 0 WHEN 'needs_review' THEN 1 ELSE 2 END,b.updated_at DESC LIMIT 500").all();
    const products=await env.DB.prepare("SELECT p.*,b.name AS business_name,u.email_normalized AS owner_email FROM rev_business_products p JOIN rev_business_profiles b ON b.id=p.business_id JOIN rev_users u ON u.id=b.owner_user_id ORDER BY CASE p.status WHEN 'pending' THEN 0 ELSE 1 END,p.updated_at DESC LIMIT 500").all();
    return response(request,env,{success:true,businesses:businesses.results||[],products:products.results||[]});
   }
   if(path.startsWith("/api/admin/businesses/") && path.endsWith("/plan") && method==="POST") {
    if(!await admin(request,env)) return response(request,env,{success:false,error:"Unauthorized"},401);
    const id=path.split("/")[4], b=await request.json().catch(()=>null);
    const code=String(b?.planCode||""), planName=String(b?.planName||"").trim().slice(0,120);
    const planStatus=String(b?.planStatus||"pending_payment"), paymentStatus=String(b?.paymentStatus||"pending");
    const expiresAt=String(b?.expiresAt||""), features=b?.features;
    if(!id||!["free","professional","featured","sponsor"].includes(code)||!planName||!["active","pending_payment","expired","suspended","cancelled"].includes(planStatus)||!["paid","pending","waived","failed","refunded"].includes(paymentStatus)||!Number.isFinite(Date.parse(expiresAt))||!features||typeof features!=="object"||Array.isArray(features))
      return response(request,env,{success:false,error:"اطلاعات پلن، پرداخت یا تاریخ انقضا معتبر نیست."},400);
    if(planStatus==="active"&&!["paid","waived"].includes(paymentStatus))
      return response(request,env,{success:false,error:"برای فعال‌کردن پلن، وضعیت پرداخت باید «پرداخت‌شده» یا «معاف/رایگان» باشد."},409);
    const business=await env.DB.prepare("SELECT id FROM rev_business_profiles WHERE id=? LIMIT 1").bind(id).first();
    if(!business)return response(request,env,{success:false,error:"کسب‌وکار پیدا نشد."},404);
    const allowed=["listing","contact","edit","logo","photos","hours","services","links","stats","highlight","priority","map_pin","report","campaign","banner","sponsored","social","custom","product_catalog"];
    const safeFeatures={}; for(const key of allowed) safeFeatures[key]=features[key]===true;
    const now=new Date().toISOString(), startsAt=String(b.startsAt||now);
    if(!Number.isFinite(Date.parse(startsAt)))return response(request,env,{success:false,error:"تاریخ شروع پلن معتبر نیست."},400);
    await env.DB.prepare("INSERT INTO rev_business_plan_assignments(business_id,plan_code,plan_name,plan_status,payment_status,starts_at,expires_at,features_json,admin_note,assigned_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(business_id) DO UPDATE SET plan_code=excluded.plan_code,plan_name=excluded.plan_name,plan_status=excluded.plan_status,payment_status=excluded.payment_status,starts_at=excluded.starts_at,expires_at=excluded.expires_at,features_json=excluded.features_json,admin_note=excluded.admin_note,assigned_by=excluded.assigned_by,updated_at=excluded.updated_at")
      .bind(id,code,planName,planStatus,paymentStatus,startsAt,new Date(expiresAt).toISOString(),JSON.stringify(safeFeatures),String(b.note||"").trim().slice(0,500)||null,"admin",now,now).run();
    return response(request,env,{success:true,message:"پلن، وضعیت پرداخت و تاریخ انقضا ذخیره شد."});
   }
   if(path.startsWith("/api/admin/businesses/") && path.endsWith("/review") && method==="POST") {
    if(!await admin(request,env)) return response(request,env,{success:false,error:"Unauthorized"},401);
    const id=path.split("/")[4], b=await request.json().catch(()=>null), status=String(b?.status||""), note=String(b?.note||"").trim().slice(0,500);
    if(!id||!["approved","rejected","needs_review","suspended"].includes(status)) return response(request,env,{success:false,error:"وضعیت بررسی نامعتبر است."},400);
    const now=new Date().toISOString();
    const result=await env.DB.prepare("UPDATE rev_business_profiles SET status=?,moderation_note=?,updated_at=? WHERE id=?").bind(status,note||null,now,id).run();
    if(!Number(result.meta?.changes)) return response(request,env,{success:false,error:"کسب‌وکار پیدا نشد."},404);
    return response(request,env,{success:true,status});
   }
   if(path.startsWith("/api/admin/products/") && path.endsWith("/review") && method==="POST") {
    if(!await admin(request,env)) return response(request,env,{success:false,error:"Unauthorized"},401);
    const id=path.split("/")[4], b=await request.json().catch(()=>null), status=String(b?.status||""), note=String(b?.note||"").trim().slice(0,500);
    if(!id||!["approved","rejected","suspended"].includes(status)) return response(request,env,{success:false,error:"وضعیت بررسی محصول نامعتبر است."},400);
    const now=new Date().toISOString();
    const result=await env.DB.prepare("UPDATE rev_business_products SET status=?,moderation_note=?,updated_at=? WHERE id=?").bind(status,note||null,now,id).run();
    if(!Number(result.meta?.changes)) return response(request,env,{success:false,error:"محصول پیدا نشد."},404);
    return response(request,env,{success:true,status});
   }
   if(path==="/api/admin/send-owner-code" && method==="POST") {
    if(!await admin(request,env)) return response(request,env,{success:false,error:"Unauthorized"},401);
    const b=await request.json().catch(()=>null);
    const phone=String(b?.phone||"").replace(/[\\s()-]/g,"");
    const code=String(b?.publicCode||"").trim();
    const name=String(b?.displayName||"صاحب کسب‌وکار").trim().slice(0,80);
    if(!/^09[0-9]{9}$/.test(phone) || !/^REV-(ST|RP|CH)-[A-Z0-9-]{4,32}$/.test(code))
      return response(request,env,{success:false,error:"شماره همراه یا شناسه اختصاصی معتبر نیست."},400);
    if(!(env.MELIPAYAMAK_USERNAME&&env.MELIPAYAMAK_PASSWORD&&env.MELIPAYAMAK_FROM))
      return response(request,env,{success:false,error:"تنظیمات ملی پیامک کامل نیست؛ نام کاربری، رمز عبور و شماره فرستنده را در Secrets/Variables تنظیم کنید."},503);
    if(await rateLimited(request,env,"owner-code-sms",5,3600))
      return response(request,env,{success:false,error:"محدودیت ارسال پیامک فعال شد؛ یک ساعت دیگر تلاش کنید."},429);
    const textMessage="REV | "+name+"\nشناسه اختصاصی پروفایل شما: "+code+"\nاین شناسه برای پیگیری پروفایل است و رمز ورود نیست.";
    const form=new URLSearchParams({username:env.MELIPAYAMAK_USERNAME,password:env.MELIPAYAMAK_PASSWORD,to:phone,from:env.MELIPAYAMAK_FROM,text:textMessage,isflash:"false"});
    const sms=await fetch("https://rest.payamak-panel.com/api/SendSMS/SendSMS",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body:form.toString()});
    const raw=await sms.text();
    if(!sms.ok) return response(request,env,{success:false,error:"درخواست ارسال پیامک از ملی پیامک ناموفق بود."},502);
    let result=raw;
    try { result=JSON.parse(raw); } catch {}
    const providerValue=typeof result==="number"?result:(typeof result==="string"&&/^-?\\d+$/.test(result.trim())?Number(result):Number(result?.Value??result?.value??result?.RetStatus??NaN));
    if(Number.isFinite(providerValue)&&providerValue<=0)
      return response(request,env,{success:false,error:"ملی پیامک پیامک را نپذیرفت؛ اعتبار پنل، شماره فرستنده و گزارش سرویس را بررسی کنید."},502);
    return response(request,env,{success:true,message:"درخواست ارسال پیامک به ملی پیامک تحویل داده شد."});
   }
   return response(request,env,{success:false,error:"Not found"},404);
  } catch(e) {
   const message=e?.message||"Internal error";
   return response(request,env,{success:false,error:message==="EMAIL_NOT_CONFIGURED"?"Email provider is not configured":"Internal server error"},500);
  }
 }
};
