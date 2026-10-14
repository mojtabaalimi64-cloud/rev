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
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
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
async function currentUser(request,env) {
  const raw=(request.headers.get("Cookie")||"").split(";").map(x=>x.trim()).find(x=>x.startsWith(COOKIE_NAME+"="))?.slice(COOKIE_NAME.length+1);
  if(!raw) return null;
  const hash=await sha256(decodeURIComponent(raw));
  return await env.DB.prepare("SELECT u.id,u.display_name,u.email_normalized,u.email_verified_at,u.phone_verified_at,u.account_status,u.role FROM rev_sessions s JOIN rev_users u ON u.id=s.user_id WHERE s.session_token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.account_status='active' AND u.email_verified_at IS NOT NULL LIMIT 1")
    .bind(hash,new Date().toISOString()).first();
}
export default {
 async fetch(request,env) {
  const url=new URL(request.url), path=url.pathname, method=request.method;
  if(method==="OPTIONS") return new Response(null,{status:204,headers:corsHeaders(request,env)});
  try {
   if(path==="/api/health" && method==="GET") return response(request,env,{success:true,service:"REV Auth",database:"configured"});
   if(path==="/api/auth/status" && method==="GET") return response(request,env,{success:true,enabled:await enabled(env),emailConfigured:!!(env.RESEND_API_KEY&&env.EMAIL_FROM&&env.SITE_URL)});
   if(path==="/api/admin/auth-settings" && method==="GET") {
    if(!await admin(request,env)) return response(request,env,{success:false,error:"Unauthorized"},401);
    const r=await env.DB.prepare("SELECT enabled,updated_at,updated_by FROM rev_auth_settings WHERE id=1").first();
    return response(request,env,{success:true,data:r||{enabled:0}});
   }
   if(path==="/api/admin/auth-settings" && method==="POST") {
    if(!await admin(request,env)) return response(request,env,{success:false,error:"Unauthorized"},401);
    const body=await request.json().catch(()=>null);
    if(!body || typeof body.enabled!=="boolean") return response(request,env,{success:false,error:"enabled must be boolean"},400);
    if(body.enabled && !(env.RESEND_API_KEY&&env.EMAIL_FROM&&env.SITE_URL)) return response(request,env,{success:false,error:"ایمیل هنوز تنظیم نشده است؛ فعال‌سازی ممکن نیست."},409);
    await env.DB.prepare("INSERT INTO rev_auth_settings(id,enabled,updated_at,updated_by) VALUES(1,?,?,?) ON CONFLICT(id) DO UPDATE SET enabled=excluded.enabled,updated_at=excluded.updated_at,updated_by=excluded.updated_by")
      .bind(body.enabled?1:0,new Date().toISOString(),"admin").run();
    return response(request,env,{success:true,enabled:body.enabled});
   }
   if(path==="/api/auth/register" && method==="POST") {
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
