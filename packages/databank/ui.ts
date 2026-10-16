/**
 * @file ui.ts
 * Single-page search UI served at GET /. The page itself holds no data and needs no token; the
 * token is typed in once, kept in sessionStorage, and sent as a Bearer header on every API call.
 */

export const UI_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Databank Search</title>
<style>
:root{--bg:#f6f7f9;--fg:#15181d;--mut:#667085;--card:#fff;--bd:#d9dde3;--ac:#2f5bea;--chip:#eef1f6}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e8eaee;--mut:#8b93a1;--card:#171a21;--bd:#2a2f3a;--ac:#6e8dff;--chip:#222733}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:16px}
form{display:grid;gap:10px;position:sticky;top:0;background:var(--bg);padding:8px 0 12px;z-index:2}
.row{display:flex;gap:8px;flex-wrap:wrap}
input,select,button{font:inherit;color:inherit;background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:9px 11px}
#q{flex:1 1 260px;font-size:16px}
button{cursor:pointer}button.primary{background:var(--ac);border-color:var(--ac);color:#fff}
label{display:flex;flex-direction:column;font-size:12px;color:var(--mut);gap:3px}
.hit{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px;margin:10px 0}
.hit h3{margin:0 0 4px;font-size:15px;word-break:break-word}
.meta{color:var(--mut);font-size:12px;display:flex;gap:8px;flex-wrap:wrap;margin-bottom:6px}
.chip{background:var(--chip);border-radius:999px;padding:1px 8px}
.snip{white-space:pre-wrap;word-break:break-word;font-size:13px;color:var(--mut)}
.thumb{max-width:220px;max-height:160px;border-radius:6px;display:block;margin:6px 0}
#status{color:var(--mut);font-size:13px;min-height:1.4em}
</style></head><body><main>
<form id="f">
 <div class="row"><input id="q" type="search" placeholder="Search the databank…" autocomplete="off" autofocus>
  <button class="primary" type="submit">Search</button></div>
 <div class="row">
  <label>Type<select id="kind"><option value="">All</option></select></label>
  <label>Source<select id="source"><option value="">All</option></select></label>
  <label>From<input id="since" type="date"></label>
  <label>To<input id="until" type="date"></label>
  <label>Results<select id="k"><option>10</option><option selected>20</option><option>50</option></select></label>
  <label>&nbsp;<button type="button" id="reset">Reset</button></label>
  <label>&nbsp;<button type="button" id="tok">Token</button></label>
 </div>
 <div id="status"></div>
</form>
<div id="out"></div>
</main>
<script>
(function(){
var $=function(i){return document.getElementById(i)};
var KEY="databank-token";
function tok(ask){var t="";try{t=sessionStorage.getItem(KEY)||""}catch(e){}
 if(!t||ask){t=prompt("Databank token")||"";try{sessionStorage.setItem(KEY,t)}catch(e){}}return t}
function api(path,body){
 return fetch(path,{method:body?"POST":"GET",headers:{Authorization:"Bearer "+tok(),"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined});
}
function esc(s){return String(s==null?"":s).replace(/[&<>"]/g,function(c){return{"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]})}
var MIME={pdf:"application/pdf",jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",gif:"image/gif",webp:"image/webp",heic:"image/heic",mp4:"video/mp4",mov:"video/quicktime",mp3:"audio/mpeg",m4a:"audio/mp4",wav:"audio/wav",txt:"text/plain",csv:"text/plain"};
function mime(p){var m=/\.([a-z0-9]+)$/i.exec(p||"");return MIME[m&&m[1].toLowerCase()]||"application/octet-stream"}
function fill(sel,counts){var el=$(sel),cur=el.value;
 Object.keys(counts).sort().forEach(function(k){var o=document.createElement("option");o.value=k;o.textContent=k+" ("+counts[k]+")";el.appendChild(o)});el.value=cur}
function status(t){$("status").textContent=t}
async function facets(){
 var r=await api("/health");
 if(r.status===401){status("Token rejected - click Token to re-enter.");return}
 var h=await r.json();fill("kind",h.byKind||{});fill("source",h.bySource||{});
 status(h.items.toLocaleString()+" items indexed.");
}
function day(v,end){return v?new Date(v+"T"+(end?"23:59:59.999":"00:00:00")).getTime():undefined}
async function search(e){
 if(e)e.preventDefault();
 var q=$("q").value.trim();if(!q){status("Type something to search.");return}
 status("Searching...");$("out").textContent="";
 var body={q:q,k:Number($("k").value)};
 if($("kind").value)body.kind=$("kind").value;if($("source").value)body.source=$("source").value;
 var s=day($("since").value),u=day($("until").value,true);if(s)body.since=s;if(u)body.until=u;
 var r;try{r=await api("/search",body)}catch(err){status("Network error: "+err.message);return}
 if(r.status===401){status("Token rejected - click Token to re-enter.");return}
 if(!r.ok){status("Error "+r.status);return}
 var hits=(await r.json()).hits||[];
 status(hits.length+" result"+(hits.length===1?"":"s"));
 $("out").innerHTML=hits.map(function(h,i){
  return '<div class="hit"><h3>'+esc(h.title||h.path||h.itemId)+'</h3><div class="meta"><span class="chip">'+esc(h.kind)+'</span><span class="chip">'+esc(h.source)+'</span>'
   +(h.ts?'<span>'+new Date(h.ts).toLocaleDateString()+'</span>':'')+'<span>score '+Number(h.score).toFixed(2)+'</span>'+(h.via?'<span>'+esc(h.via)+'</span>':'')+'</div>'
   +(h.path?'<div class="meta">'+esc(h.path)+'</div>':'')+(h.snippet?'<div class="snip">'+esc(h.snippet)+'</div>':'')
   +(h.blobId?'<button type="button" data-i="'+i+'">Open original</button>':'')+'<div></div></div>'}).join("");
 $("out").onclick=async function(ev){var b=ev.target.closest("button[data-i]");if(!b)return;
  var h=hits[b.dataset.i];b.disabled=true;b.textContent="Loading...";
  var br=await api("/blob/"+h.blobId);if(!br.ok){b.textContent="Failed ("+br.status+")";return}
  var blob=new Blob([await br.arrayBuffer()],{type:mime(h.path||h.title)}),url=URL.createObjectURL(blob);
  if(h.kind==="photo"){var im=new Image();im.src=url;im.className="thumb";b.parentNode.lastChild.appendChild(im);b.remove()}
  else{window.open(url,"_blank");b.textContent="Open original";b.disabled=false}};
}
$("f").addEventListener("submit",search);
$("tok").onclick=function(){tok(true);facets()};
$("reset").onclick=function(){["q","since","until","kind","source"].forEach(function(i){$(i).value=""});$("k").value="20";$("out").textContent="";$("q").focus()};
["kind","source","since","until","k"].forEach(function(i){$(i).addEventListener("change",function(){if($("q").value.trim())search()})});
facets();
})();
</script></body></html>`;
