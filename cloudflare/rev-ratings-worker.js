/**
 * REV Ratings API — separate Worker; does not replace rev-api.
 * Bind D1 database rev-db as DB.
 * Set ALLOWED_ORIGINS=https://mojtabaalimi64-cloud.github.io
 */
const DEFAULT_ORIGIN = "https://mojtabaalimi64-cloud.github.io";
function origins(env){return (env.ALLOWED_ORIGINS||DEFAULT_ORIGIN).split(",").map(x=>x.trim()).filter(Boolean);}
function cors(req,env){
 const origin=req.headers.get("Origin")||"";
 return {Vary:"Origin",...(origins(env).includes(origin)?{"Access-Control-Allow-Origin":origin}:{}),
  "Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type",
  "Access-Control-Max-Age":"86400"};
}
function json(req,env,data,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store",...cors(req,env)}});}
async function hash(s){const b=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s));return [...new Uint8Array(b)].map(x=>x.toString(16).padStart(2,"0")).join("");}
function validType(t){return t==="station"||t==="store";}
function validId(s){return typeof s==="string"&&s.trim().length>0&&s.length<=240&&!/[\u0000-\u001f]/.test(s);}
async function rateLimited(req,env){
 const ip=req.headers.get("CF-Connecting-IP")||"unknown";
 const key=await hash(ip+":"+Math.floor(Date.now()/60000));
 await env.DB.prepare("DELETE FROM rev_rating_rate_limits WHERE expires_at < ?").bind(new Date(Date.now()-3600000).toISOString()).run();
 await env.DB.prepare("INSERT INTO rev_rating_rate_limits(bucket_key,attempt_count,expires_at) VALUES(?,1,?) ON CONFLICT(bucket_key) DO UPDATE SET attempt_count=attempt_count+1")
 .bind(key,new Date(Date.now()+120000).toISOString()).run();
 const row=await env.DB.prepare("SELECT attempt_count FROM rev_rating_rate_limits WHERE bucket_key=?").bind(key).first();
 return Number(row?.attempt_count||0)>8;
}
export default {async fetch(req,env){
 const url=new URL(req.url),path=url.pathname,method=req.method;
 if(method==="OPTIONS")return new Response(null,{status:204,headers:cors(req,env)});
 try{
  if(path==="/api/health"&&method==="GET")return json(req,env,{success:true,service:"REV Ratings API"});
  if(path!=="/api/ratings")return json(req,env,{success:false,error:"Not found"},404);
  if(method==="GET"){
   const type=url.searchParams.get("type"),id=url.searchParams.get("id");
   if(!validType(type)||!validId(id))return json(req,env,{success:false,error:"نوع یا شناسه نامعتبر است."},400);
   const row=await env.DB.prepare("SELECT COUNT(*) AS count, ROUND(AVG(rating),1) AS average FROM rev_ratings WHERE target_type=? AND target_id=?").bind(type,id).first();
   return json(req,env,{success:true,type,id,count:Number(row?.count||0),average:row?.average==null?null:Number(row.average)});
  }
  if(method==="POST"){
   const origin=req.headers.get("Origin")||"";
   if(!origins(env).includes(origin))return json(req,env,{success:false,error:"Origin نامعتبر است."},403);
   if(await rateLimited(req,env))return json(req,env,{success:false,error:"تعداد درخواست‌ها زیاد است؛ چند دقیقه بعد دوباره امتحان کنید."},429);
   const body=await req.json();
   const {type,id,rating,voter}=body||{};
   if(!validType(type)||!validId(id)||!Number.isInteger(rating)||rating<1||rating>5||typeof voter!=="string"||!/^[a-z0-9-]{20,100}$/i.test(voter))
    return json(req,env,{success:false,error:"اطلاعات امتیاز معتبر نیست."},400);
   const voterHash=await hash(voter);
   try{
    await env.DB.prepare("INSERT INTO rev_ratings(target_type,target_id,voter_hash,rating,created_at) VALUES(?,?,?,?,?)")
     .bind(type,id,voterHash,rating,new Date().toISOString()).run();
   }catch(e){
    if(String(e?.message||e).toLowerCase().includes("unique"))return json(req,env,{success:false,error:"با این مرورگر قبلاً برای این مورد امتیاز ثبت شده است."},409);
    throw e;
   }
   const row=await env.DB.prepare("SELECT COUNT(*) AS count, ROUND(AVG(rating),1) AS average FROM rev_ratings WHERE target_type=? AND target_id=?").bind(type,id).first();
   return json(req,env,{success:true,type,id,count:Number(row?.count||0),average:Number(row?.average||0)});
  }
  return json(req,env,{success:false,error:"Method not allowed"},405);
 }catch(e){return json(req,env,{success:false,error:"خطای داخلی سرویس امتیازدهی."},500);}
}};
