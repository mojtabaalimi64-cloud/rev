(function(){
'use strict';
const API='https://rev-auth-api.mojtaba-alimi64.workers.dev';
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function sessionId(){try{let v=localStorage.getItem('rev_live_session_id');if(v&&/^[a-zA-Z0-9_-]{16,100}$/.test(v))return v;v=(crypto.randomUUID?crypto.randomUUID().replace(/-/g,''):Math.random().toString(36).slice(2)+Date.now().toString(36));localStorage.setItem('rev_live_session_id',v);return v}catch(e){return Math.random().toString(36).slice(2)+Date.now().toString(36)}}
const sid=sessionId();
async function heartbeat(){if(document.visibilityState==='hidden')return;try{await fetch(API+'/api/engagement/heartbeat',{method:'POST',credentials:'include',cache:'no-store',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:sid,page:location.pathname+location.hash})})}catch(e){}}
function showBanner(items){
 let banner=document.getElementById('revAnnouncementBanner');
 if(!items.length){if(banner)banner.remove();return}
 let seen={};try{seen=JSON.parse(sessionStorage.getItem('rev_dismissed_announcements')||'{}')||{}}catch(e){}
 const item=items.find(x=>!seen[x.id]);
 if(!item){if(banner)banner.remove();return}
 if(!banner){banner=document.createElement('aside');banner.id='revAnnouncementBanner';banner.setAttribute('role','region');banner.setAttribute('aria-label','اعلان‌های REV');document.body.appendChild(banner)}
 const colors={info:['#163b35','#b7f5d2'],success:['#123d2b','#c5ffdc'],warning:['#4b3513','#ffe2a1'],offer:['#163c58','#d3efff']};
 const c=colors[item.kind]||colors.info;
 Object.assign(banner.style,{position:'fixed',top:'8px',left:'10px',right:'10px',zIndex:'2147483000',maxWidth:'980px',margin:'0 auto',padding:'12px 44px 12px 14px',border:'1px solid '+c[1],borderRadius:'14px',background:c[0],color:'#fff',boxShadow:'0 10px 35px #0005',font:'14px/1.65 Vazirmatn,Vazir,Tahoma,sans-serif',direction:'rtl'});
 banner.innerHTML='<button type="button" aria-label="بستن اعلان" style="position:absolute;left:8px;top:8px;border:0;background:transparent;color:'+c[1]+';font-size:23px;cursor:pointer">×</button><strong style="display:block;color:'+c[1]+';font-size:14px">'+esc(item.title)+'</strong><span style="display:block;margin-top:2px">'+esc(item.body)+'</span>'+(item.link_url?'<a href="'+esc(item.link_url)+'" style="display:inline-block;margin-top:5px;color:'+c[1]+';font-weight:800;text-decoration:underline">'+esc(item.link_label||'مشاهده')+' ←</a>':'');
 banner.querySelector('button').addEventListener('click',()=>{seen[item.id]=1;try{sessionStorage.setItem('rev_dismissed_announcements',JSON.stringify(seen))}catch(e){}showBanner(items)});
}
async function announcements(){try{const r=await fetch(API+'/api/announcements',{credentials:'include',cache:'no-store'});const j=await r.json();if(r.ok&&j.success)showBanner(j.announcements||[])}catch(e){}}
heartbeat();announcements();setInterval(heartbeat,30000);setInterval(announcements,60000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){heartbeat();announcements()}});
})();
