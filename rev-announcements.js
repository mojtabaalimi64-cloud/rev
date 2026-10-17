(function(){
'use strict';
const API='https://rev-auth-api.mojtaba-alimi64.workers.dev';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function sessionId(){try{let v=localStorage.getItem('rev_live_session_id');if(v&&/^[a-zA-Z0-9_-]{16,100}$/.test(v))return v;v=(crypto.randomUUID?crypto.randomUUID().replace(/-/g,''):Math.random().toString(36).slice(2)+Date.now().toString(36));localStorage.setItem('rev_live_session_id',v);return v}catch(e){return Math.random().toString(36).slice(2)+Date.now().toString(36)}}
const sid=sessionId();
const canShowAnnouncements=location.pathname.endsWith("/nearby-map.html");
let lastItems=[];let announcementItems=[];let groupNoticeItems=[];let seenGroupNoticeIds=[];try{seenGroupNoticeIds=JSON.parse(localStorage.getItem('rev_seen_group_banner_ids')||'[]')}catch(e){}
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
 Object.assign(banner.style,{position:'fixed',top:'max(8px, env(safe-area-inset-top))',left:'12px',right:'12px',zIndex:'2147483647',maxWidth:'760px',margin:'0 auto',padding:'7px 40px 7px 10px',border:'1px solid rgba(190,225,255,.42)',borderRight:'3px solid '+accent,borderRadius:'12px',background:'rgba(8,28,52,.62)',color:'#ffffff',backdropFilter:'blur(18px) saturate(150%)',WebkitBackdropFilter:'blur(18px) saturate(150%)',boxShadow:'0 8px 22px rgba(0,0,0,.2)',font:'12px/1.45 Vazirmatn,Vazir,Tahoma,sans-serif',direction:'rtl',textAlign:'right',pointerEvents:'auto'});
 banner.innerHTML='<div style="display:flex;align-items:center;gap:5px;margin-bottom:1px"><span aria-hidden="true" style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:6px;background:'+accent+';color:#fff;font-size:13px;font-weight:900">⚡</span><span style="font-size:10px;font-weight:900;letter-spacing:.5px;color:#ffffff">REV</span><span style="font-size:9px;font-weight:800;color:#ffffff;background:rgba(83,157,255,.22);border:1px solid rgba(190,225,255,.28);border-radius:20px;padding:1px 6px">'+esc(item.bannerLabel||'اعلان')+'</span></div><button type="button" aria-label="بستن اعلان" style="position:absolute;left:6px;top:6px;width:24px;height:24px;border:0;border-radius:9px;background:rgba(91,158,255,.18);color:#ffffff;font-size:19px;line-height:1;cursor:pointer">×</button><strong style="display:block;color:#ffffff;font-size:13px;font-weight:900">'+esc(item.title)+'</strong><span style="display:block;margin-top:1px;color:rgba(255,255,255,.94)">'+esc(item.body)+'</span>'+(item.link_url?'<a href="'+esc(item.link_url)+'" style="display:inline-flex;align-items:center;gap:5px;margin-top:4px;padding:3px 8px;border-radius:8px;background:'+accent+';color:#fff;font-weight:800;text-decoration:none">'+esc(item.link_label||'مشاهده')+' ←</a>':'');
 banner.querySelector('button').onclick=()=>{seen[item.id]=1;try{sessionStorage.setItem('rev_dismissed_announcements',JSON.stringify(seen))}catch(e){}showBanner(lastItems)};
}
async function announcements(){if(!canShowAnnouncements)return;try{const r=await fetch(API+'/api/announcements',{credentials:'include',cache:'no-store'});const j=await r.json();if(r.ok&&j.success){announcementItems=j.announcements||[];showBanner([...groupNoticeItems,...announcementItems])}}catch(e){}}
async function groupTravelNotifications(){if(!canShowAnnouncements)return;try{const r=await fetch(API+'/api/driver/notifications',{credentials:'include',cache:'no-store'});if(!r.ok)return;const j=await r.json();if(!j.success)return;const fresh=(j.notifications||[]).filter(n=>['group_accepted','group_declined'].includes(n.type)&&!seenGroupNoticeIds.includes(n.id));if(!fresh.length)return;const notices=fresh.map(n=>({id:'group-notice-'+n.id,title:n.title||'به‌روزرسانی سفر گروهی REV',body:n.body||'',kind:n.type==='group_accepted'?'success':'warning',bannerLabel:'سفر گروهی',link_url:'./nearby-map.html#groupTripPanel',link_label:'مشاهده سفر'}));groupNoticeItems=[...notices,...groupNoticeItems].slice(0,10);seenGroupNoticeIds=[...new Set([...seenGroupNoticeIds,...fresh.map(n=>n.id)])].slice(-100);try{localStorage.setItem('rev_seen_group_banner_ids',JSON.stringify(seenGroupNoticeIds))}catch(e){}showBanner([...groupNoticeItems,...announcementItems])}catch(e){}}
window.addEventListener('rev:group-notice',e=>{const d=e.detail||{},accepted=d.accepted===true;groupNoticeItems=[{id:'group-local-'+Date.now(),title:accepted?'سفر گروهی پذیرفته شد':'دعوت سفر گروهی رد شد',body:accepted?'دعوت را پذیرفتید؛ برای اشتراک موقعیت، اجازه GPS را فعال کنید.':'دعوت سفر گروهی را رد کردید.',kind:accepted?'success':'warning',bannerLabel:'سفر گروهی',link_url:'./nearby-map.html#groupTripPanel',link_label:'مشاهده سفر'},...groupNoticeItems].slice(0,10);showBanner([...groupNoticeItems,...announcementItems])});
heartbeat();announcements();groupTravelNotifications();setInterval(heartbeat,30000);setInterval(announcements,15000);setInterval(groupTravelNotifications,12000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){heartbeat();announcements()}});
document.addEventListener('fullscreenchange',()=>showBanner(lastItems));
})();
