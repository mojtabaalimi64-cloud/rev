/* REV public rating widget. Uses a separate Worker API. */
(function(){
  const API="https://rev-ratings-api.mojtaba-alimi64.workers.dev/api/ratings";
  function voterId(){
    const key="rev_public_rating_voter_v1";
    try{
      let id=localStorage.getItem(key);
      if(!id){id=crypto.randomUUID?crypto.randomUUID():"rev-"+Date.now()+"-"+Math.random().toString(16).slice(2)+"-"+Math.random().toString(16).slice(2);localStorage.setItem(key,id);}
      return id;
    }catch(e){return "rev-"+Date.now()+"-"+Math.random().toString(16).slice(2)+"-"+Math.random().toString(16).slice(2);}
  }
  function mount(el,type,id){
    el.classList.add("rev-rating");
    el.style.cssText="margin-top:9px;padding:9px 10px;border:1px solid #33414a;border-radius:10px;background:rgba(10,17,22,.04)";
    const label=document.createElement("div");label.style.cssText="font-size:13px;font-weight:700;margin-bottom:4px";label.textContent="رضایت کاربران ";
    const summary=document.createElement("span");summary.style.cssText="font-size:12px;color:var(--muted);font-weight:400";summary.textContent="در حال دریافت…";label.appendChild(summary);el.appendChild(label);
    const controls=document.createElement("div");controls.style.cssText="display:flex;align-items:center;gap:5px;flex-wrap:wrap";el.appendChild(controls);
    const note=document.createElement("div");note.style.cssText="font-size:12px;color:var(--muted);margin-top:4px";el.appendChild(note);
    let voted=false,buttons=[];
    function stars(selected,disabled){
      controls.replaceChildren();buttons=[];
      for(let n=1;n<=5;n++){
        const b=document.createElement("button");b.type="button";b.textContent="★";b.title=n+" از ۵";b.setAttribute("aria-label",n+" ستاره از ۵");
        b.style.cssText="font-size:23px;line-height:1.2;padding:0 2px;color:"+(n<=selected?"#e0a000":"#9aa4aa")+";cursor:"+(disabled?"default":"pointer")+";background:none;border:0";
        b.disabled=!!disabled;b.addEventListener("click",()=>vote(n));buttons.push(b);controls.appendChild(b);
      }
    }
    async function refresh(){
      try{
        const r=await fetch(API+"?type="+encodeURIComponent(type)+"&id="+encodeURIComponent(id),{cache:"no-store"});
        const d=await r.json();if(!r.ok||!d.success)throw Error();
        summary.textContent=d.count?("★ "+Number(d.average).toLocaleString("fa-IR")+" از ۵ · "+Number(d.count).toLocaleString("fa-IR")+" رأی"):"هنوز رأیی ثبت نشده";
      }catch(e){summary.textContent="سرویس امتیازدهی پس از راه‌اندازی فعال می‌شود";}
    }
    async function vote(n){
      if(voted)return;buttons.forEach(b=>b.disabled=true);note.textContent="در حال ثبت امتیاز…";
      try{
        const r=await fetch(API,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({type:type,id:id,rating:n,voter:voterId()})});
        const d=await r.json();
        if(r.status===409){voted=true;note.textContent="قبلاً با این مرورگر رأی داده‌اید.";stars(n,true);return;}
        if(!r.ok||!d.success)throw Error(d.error||"ثبت رأی ناموفق بود");
        voted=true;summary.textContent="★ "+Number(d.average).toLocaleString("fa-IR")+" از ۵ · "+Number(d.count).toLocaleString("fa-IR")+" رأی";
        note.textContent="امتیاز شما ثبت شد. سپاس از مشارکت شما.";stars(n,true);
      }catch(e){buttons.forEach(b=>b.disabled=false);note.textContent=e.message||"ارتباط با سرویس امتیازدهی برقرار نشد.";}
    }
    stars(0,false);refresh();
  }
  window.REVRating={mount};
})();