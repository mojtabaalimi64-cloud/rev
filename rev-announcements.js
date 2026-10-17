(function(){
'use strict';
const API='https://rev-auth-api.mojtaba-alimi64.workers.dev';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function sessionId(){try{let v=localStorage.getItem('rev_live_session_id');if(v&&/^[a-zA-Z0-9_-]{16,100}$/.test(v))return v;v=(crypto.randomUUID?crypto.randomUUID().replace(/-/g,''):Math.random().toString(36).slice(2)+Date.now().toString(36));localStorage.setItem('rev_live_session_id',v);return v}catch(e){return Math.random().toString(36).slice(2)+Date.now().toString(36)}}
const sid=sessionId();
const canShowAnnouncements=/(^|\\/)nearby-map\\.html$/.test(location.pathname);
let lastItems=[];
function bannerHost(){return document.fullscreenElement||document.body}
async function heartbeat(){if(document.visibilityState==='hidden')return;try{await fetch(API+'/api/engagement/heartbeat',{method:'POST',credentials:'include',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sid,page:location.pathname+location.hash})})}catch(e){}}
function showBanner(items){
 lastItems=Array.isArray(items)?items:[];
 let banner=document.getElementById('revAnnouncementBanner');
 if(!lastItems.length){if(banner)banner.remove();return}
 let seen={};try{seen=JSON.parse(sessionStorage.getItem('rev_dismissed_announcements')||'{}')||{}}catch(e){}
 const item=lastItems.find(x=>!seen[x.id]);
 if(!item){if(banner)banner.remove();return}
 const host=bannerHost();
 if(!banner){banner=document.createElement('aside');banner.id='revAnnouncementBanner';banner.setAttribute('role','region');banner.setAttribute('aria-label','اعلان‌های REV')}
 if(banner.parentElement!==host)host.appendChild(banner);
 const colors={info:'#1769d2',success:'#087fbd',warning:'#1b63b5',offer:'#1558b0'};
 const accent=colors[item.kind]||colors.info;
 Object.assign(banner.style,{position:'fixed',top:'max(10px, env(safe-area-inset-top))',left:'10px',right:'10px',zIndex:'2147483647',maxWidth:'980px',margin:'0 auto',padding:'14px 48px 14px 14px',border:'1px solid #c9e1ff',borderRight:'5px solid '+accent,borderRadius:'16px',background:'#ffffff',color:'#17324f',boxShadow:'0 12px 34px rgba(16,77,145,.22)',font:'14px/1.7 Vazirmatn,Vazir,Tahoma,sans-serif',direction:'rtl',textAlign:'right',pointerEvents:'auto'});
 banner.innerHTML='<div style="display:flex;align-items:center;gap:7px;margin-bottom:5px"><span aria-hidden="true" style="display:inline-flex;align-items:center;justify-content:center;width:25px;height:25px;border-radius:8px;background:'+accent+';color:#fff;font-size:16px;font-weight:900">⚡</span><span style="font-size:11px;font-weight:900;letter-spacing:.5px;color:'+accent+'">REV</span><span style="font-size:10px;font-weight:800;color:#6280a1;background:#edf5ff;border-radius:20px;padding:2px 8px">اعلان</span></div><button type="button" aria-label="بستن اعلان" style="position:absolute;left:9px;top:9px;width:30px;height:30px;border:0;border-radius:9px;background:#edf5ff;color:'+accent+';font-size:23px;line-height:1;cursor:pointer">×</button><strong style="display:block;color:'+accent+';font-size:15px;font-weight:900">'+esc(item.title)+'</strong><span style="display:block;margin-top:3px;color:#17324f">'+esc(item.body)+'</span>'+(item.link_url?'<a href="'+esc(item.link_url)+'" style="display:inline-flex;align-items:center;gap:5px;margin-top:8px;padding:5px 10px;border-radius:8px;background:'+accent+';color:#fff;font-weight:800;text-decoration:none">'+esc(item.link_label||'مشاهده')+' ←</a>':'');
 banner.querySelector('button').onclick=()=>{seen[item.id]=1;try{sessionStorage.setItem('rev_dismissed_announcements',JSON.stringify(seen))}catch(e){}showBanner(lastItems)};
}
async function announcements(){if(!canShowAnnouncements)return;try{const r=await fetch(API+'/api/announcements',{credentials:'include',cache:'no-store'});const j=await r.json();if(r.ok&&j.success)showBanner(j.announcements||[])}catch(e){}}
heartbeat();announcements();setInterval(heartbeat,30000);setInterval(announcements,15000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){heartbeat();announcements()}});
document.addEventListener('fullscreenchange',()=>showBanner(lastItems));
})();
