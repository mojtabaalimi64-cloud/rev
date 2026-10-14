/**
 * REV Ratings Worker.
 * Bind D1 database rev-db as DB.
 * Secrets: ADMIN_TOKEN
 * Variable: ALLOWED_ORIGINS=https://mojtabaalimi64-cloud.github.io
 * Deploy as rev-ratings-api. Never put ADMIN_TOKEN in site JavaScript.
 */
const DEFAULT_ORIGIN = "https://mojtabaalimi64-cloud.github.io";
const json = (data, status=200, headers={}) => new Response(JSON.stringify(data), {
  status, headers: {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...headers}
});
function cors(request, env) {
  const origin=request.headers.get("Origin")||"";
  const allowed=(env.ALLOWED_ORIGINS||DEFAULT_ORIGIN).split(",").map(x=>x.trim()).filter(Boolean);
  return {"Vary":"Origin",...(allowed.includes(origin)?{"Access-Control-Allow-Origin":origin}:{}),
    "Access-Control-Allow-Methods":"GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type,Authorization","Access-Control-Max-Age":"86400"};
}
function reply(request,env,data,status=200){return json(data,status,cors(request,env));}
function admin(request,env){return !!env.ADMIN_TOKEN && request.headers.get("Authorization")==="Bearer "+env.ADMIN_TOKEN;}
function validTarget(type,id){return ["store","station"].includes(type)&&typeof id==="string"&&id.trim().length>0&&id.length<=240;}
async function hash(s){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");}
async function limited(request,env){
  const ip=request.headers.get("CF-Connecting-IP")||"unknown", bucket=Math.floor(Date.now()/60000), key=await hash(ip+":"+bucket);
  const expires=new Date((bucket+1)*60000).toISOString();
  await env.DB.prepare("DELETE FROM rev_rating_rate_limits WHERE expires_at < ?").bind(new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO rev_rating_rate_limits(bucket_key,attempt_count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket_key) DO UPDATE SET attempt_count=attempt_count+1").bind(key,expires).run();
  const row=await env.DB.prepare("SELECT attempt_count FROM rev_rating_rate_limits WHERE bucket_key=?").bind(key).first();
  return Number(row?.attempt_count||0)>30;
}
async function summary(env,type,id){
  const override=await env.DB.prepare("SELECT public_code,display_name,manual_average,manual_count FROM rev_rating_overrides WHERE target_type=? AND target_id=?").bind(type,id).first();
  if(override)return {success:true,average:Number(override.manual_average),count:Number(override.manual_count),manual:true,publicCode:override.public_code,displayName:override.display_name};
  const r=await env.DB.prepare("SELECT AVG(rating) average,COUNT(*) count FROM rev_ratings WHERE target_type=? AND target_id=?").bind(type,id).first();
  return {success:true,average:Number(r?.average||0),count:Number(r?.count||0),manual:false};
}
export default {
 async fetch(request,env){
  const url=new URL(request.url),path=url.pathname,method=request.method;
  if(method==="OPTIONS")return new Response(null,{status:204,headers:cors(request,env)});
  try{
   if(path==="/api/health"&&method==="GET")return reply(request,env,{success:true,service:"REV Ratings",database:"configured"});
   if(path==="/api/ratings"&&method==="GET"){
    const type=url.searchParams.get("type"),id=url.searchParams.get("id");
    if(!validTarget(type,id))return reply(request,env,{success:false,error:"نوع یا شناسه نامعتبر است."},400);
    return reply(request,env,await summary(env,type,id));
   }
   if(path==="/api/ratings"&&method==="POST"){
    if(await limited(request,env))return reply(request,env,{success:false,error:"درخواست‌های زیاد؛ کمی بعد دوباره تلاش کنید."},429);
    const b=await request.json().catch(()=>null),type=String(b?.type||""),id=String(b?.id||""),rating=Number(b?.rating),voter=String(b?.voter||"");
    if(!validTarget(type,id)||!Number.isInteger(rating)||rating<1||rating>5||voter.length<8||voter.length>300)return reply(request,env,{success:false,error:"اطلاعات رأی معتبر نیست."},400);
    const exists=await env.DB.prepare("SELECT 1 ok FROM rev_ratings WHERE target_type=? AND target_id=? AND voter_hash=?").bind(type,id,await hash(voter)).first();
    if(exists)return reply(request,env,{success:false,error:"برای این مورد قبلاً رأی ثبت شده است."},409);
    await env.DB.prepare("INSERT INTO rev_ratings(target_type,target_id,voter_hash,rating,created_at) VALUES(?,?,?,?,?)").bind(type,id,await hash(voter),rating,new Date().toISOString()).run();
    return reply(request,env,await summary(env,type,id),201);
   }
   if(path==="/api/admin/ratings"&&method==="GET"){
    if(!admin(request,env))return reply(request,env,{success:false,error:"Unauthorized"},401);
    const type=url.searchParams.get("type"),limit=Math.max(1,Math.min(1000,Number(url.searchParams.get("limit")||1000)));
    if(!["store","station"].includes(type))return reply(request,env,{success:false,error:"نوع نامعتبر است."},400);
    const r=await env.DB.prepare("SELECT target_id id,rating,created_at FROM rev_ratings WHERE target_type=? ORDER BY created_at DESC LIMIT ?").bind(type,limit).all();
    return reply(request,env,{success:true,items:r.results||[]});
   }
   if(path==="/api/admin/overrides"&&method==="GET"){
    if(!admin(request,env))return reply(request,env,{success:false,error:"Unauthorized"},401);
    const search=(url.searchParams.get("search")||"").trim().slice(0,200);
    const r=search
      ? await env.DB.prepare("SELECT target_type,target_id,public_code,display_name,owner_phone,manual_average,manual_count,updated_at,updated_by FROM rev_rating_overrides WHERE public_code LIKE ? OR target_id LIKE ? OR display_name LIKE ? OR owner_phone LIKE ? ORDER BY updated_at DESC LIMIT 200").bind("%"+search+"%","%"+search+"%","%"+search+"%","%"+search+"%").all()
      : await env.DB.prepare("SELECT target_type,target_id,public_code,display_name,owner_phone,manual_average,manual_count,updated_at,updated_by FROM rev_rating_overrides ORDER BY updated_at DESC LIMIT 1000").all();
    return reply(request,env,{success:true,items:r.results||[]});
   }
   if(path==="/api/admin/overrides"&&method==="PUT"){
    if(!admin(request,env))return reply(request,env,{success:false,error:"Unauthorized"},401);
    const b=await request.json().catch(()=>null),type=String(b?.type||""),id=String(b?.id||""),code=String(b?.publicCode||"").trim(),name=String(b?.displayName||"").trim().slice(0,180),phone=String(b?.ownerPhone||"").trim().slice(0,40),avg=Number(b?.average),count=Number(b?.count);
    if(!validTarget(type,id)||!/^REV-(ST|RP|CH)-[A-Z0-9-]{4,32}$/.test(code)||!Number.isFinite(avg)||avg<0||avg>5||!Number.isInteger(count)||count<0||count>100000000)return reply(request,env,{success:false,error:"شناسه، میانگین (۰ تا ۵) یا تعداد رأی معتبر نیست."},400);
    const now=new Date().toISOString();
    await env.DB.prepare("INSERT INTO rev_rating_overrides(target_type,target_id,public_code,display_name,owner_phone,manual_average,manual_count,updated_at,updated_by) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(target_type,target_id) DO UPDATE SET public_code=excluded.public_code,display_name=excluded.display_name,owner_phone=excluded.owner_phone,manual_average=excluded.manual_average,manual_count=excluded.manual_count,updated_at=excluded.updated_at,updated_by=excluded.updated_by")
      .bind(type,id,code,name,phone,avg,count,now,"admin").run();
    return reply(request,env,{success:true,override:{type,id,publicCode:code,displayName:name,ownerPhone:phone,average:avg,count,updatedAt:now}});
   }

   // Public station-data report submission. Raw voter identifiers are never stored.
   if(path==="/api/station-reports"&&method==="POST"){
    if(await limited(request,env))return reply(request,env,{success:false,error:"درخواست‌های زیاد؛ کمی بعد دوباره تلاش کنید."},429);
    const b=await request.json().catch(()=>null);
    const stationId=String(b?.station_id||"").trim().slice(0,240);
    const stationName=String(b?.station_name||"").trim().slice(0,180);
    const type=String(b?.report_type||"");
    const rawDetails=String(b?.details||"");
    const details=rawDetails.trim().slice(0,600);
    const voter=String(b?.voter||"");
    const allowedTypes=["not_found","not_working","connector_wrong","power_wrong","location_wrong","duplicate","violation","other"];
    if(!stationId||!stationName||!allowedTypes.includes(type)||voter.length<8||voter.length>300||rawDetails.length>2000){
      return reply(request,env,{success:false,error:"اطلاعات گزارش معتبر نیست."},400);
    }
    const reporterHash=await hash("station-report:"+voter);
    try{
      const result=await env.DB.prepare(`
        INSERT INTO rev_station_reports
          (station_id,station_name,report_type,details,reporter_hash,status,created_at)
        VALUES(?,?,?,?,?,'new',?)
      `).bind(stationId,stationName,type,details,reporterHash,new Date().toISOString()).run();
      return reply(request,env,{success:true,message:"گزارش شما برای بررسی مدیر REV ثبت شد.",id:result.meta?.last_row_id||null},201);
    }catch(e){
      const exists=await env.DB.prepare("SELECT id FROM rev_station_reports WHERE station_id=? AND reporter_hash=?").bind(stationId,reporterHash).first();
      if(exists)return reply(request,env,{success:false,error:"برای این جایگاه قبلاً گزارشی از این مرورگر ثبت شده است."},409);
      throw e;
    }
   }
   // Admin-only list of station reports.
   if(path==="/api/admin/station-reports"&&method==="GET"){
    if(!admin(request,env))return reply(request,env,{success:false,error:"Unauthorized"},401);
    const status=url.searchParams.get("status")||"all";
    const limit=Math.max(1,Math.min(1000,Number(url.searchParams.get("limit")||500)));
    const validStatuses=["new","in_review","resolved","invalid"];
    if(status!=="all"&&!validStatuses.includes(status))return reply(request,env,{success:false,error:"وضعیت نامعتبر است."},400);
    const result=status==="all"
      ? await env.DB.prepare(`SELECT id,station_id,station_name,report_type,details,status,created_at,reviewed_at,reviewed_by,admin_note FROM rev_station_reports ORDER BY CASE status WHEN 'new' THEN 0 WHEN 'in_review' THEN 1 ELSE 2 END,created_at DESC LIMIT ?`).bind(limit).all()
      : await env.DB.prepare(`SELECT id,station_id,station_name,report_type,details,status,created_at,reviewed_at,reviewed_by,admin_note FROM rev_station_reports WHERE status=? ORDER BY created_at DESC LIMIT ?`).bind(status,limit).all();
    return reply(request,env,{success:true,items:result.results||[]});
   }
   // Admin marks a report as being reviewed, resolved, or invalid.
   const reportPrefix="/api/admin/station-reports/";
   if(path.startsWith(reportPrefix)&&method==="PUT"){
    if(!admin(request,env))return reply(request,env,{success:false,error:"Unauthorized"},401);
    const b=await request.json().catch(()=>null),id=Number(path.slice(reportPrefix.length)),status=String(b?.status||""),note=String(b?.admin_note||"").trim().slice(0,600);
    if(!Number.isSafeInteger(id)||id<1||!["new","in_review","resolved","invalid"].includes(status))return reply(request,env,{success:false,error:"شناسه یا وضعیت گزارش معتبر نیست."},400);
    const now=new Date().toISOString();
    const result=await env.DB.prepare("UPDATE rev_station_reports SET status=?,reviewed_at=?,reviewed_by='REV admin',admin_note=? WHERE id=?").bind(status,now,note,id).run();
    if(!result.meta?.changes)return reply(request,env,{success:false,error:"گزارش پیدا نشد."},404);
    return reply(request,env,{success:true,message:"وضعیت گزارش ذخیره شد.",status,reviewed_at:now});
   }
   return reply(request,env,{success:false,error:"Not found"},404);
  }catch(e){return reply(request,env,{success:false,error:"Internal server error"},500);}
 }
};
