const $=s=>document.querySelector(s);
let servers=[];
const versions=["1.21.11","1.21.10","1.21.8","1.21.1","1.20.6","1.20.4","1.19.4"];
const software=["PAPER","PURPUR","VANILLA","FABRIC","FORGE","NEOFORGE"];

async function api(url,opt={}){const r=await fetch(url,{...opt,headers:{"Content-Type":"application/json",...(opt.headers||{})}});let d={};try{d=await r.json()}catch{}if(r.status===401){showLogin();throw Error("Unauthorized")}if(!r.ok)throw Error(d.error||"Request failed");return d}
function showLogin(){$("#login").classList.remove("hidden");$("#app").classList.add("hidden")}
function showApp(){$("#login").classList.add("hidden");$("#app").classList.remove("hidden")}
function showPage(name){document.querySelectorAll(".page").forEach(x=>x.classList.add("hidden"));$("#"+name).classList.remove("hidden");document.querySelectorAll("nav button").forEach(b=>b.classList.toggle("active",b.dataset.page===name));$("#pageTitle").textContent=name==="create"?"Create Server":name==="versions"?"Version Changer":name[0].toUpperCase()+name.slice(1)}
document.querySelectorAll("nav button").forEach(b=>b.onclick=()=>showPage(b.dataset.page));
$("#refresh").onclick=load;
$("#logout").onclick=async()=>{await api("/api/logout",{method:"POST"});showLogin()};

$("#loginForm").onsubmit=async e=>{e.preventDefault();$("#loginErr").textContent="";try{await api("/api/login",{method:"POST",body:JSON.stringify({username:$("#user").value,password:$("#pass").value})});showApp();load()}catch(x){$("#loginErr").textContent=x.message}};

function fillSelects(){
  $("#sversion").innerHTML=versions.map(v=>`<option>${v}</option>`).join("");
  $("#versionSelect").innerHTML=versions.map(v=>`<option>${v}</option>`).join("");
  $("#ssoftware").innerHTML=software.map(v=>`<option>${v}</option>`).join("");
  $("#softwareSelect").innerHTML=software.map(v=>`<option>${v}</option>`).join("");
}
function card(s){
 const on=s.status==="running";
 return `<div class="server-card"><h3>${esc(s.name)}</h3><p>${esc(s.id)} • :${s.port} • ${s.ram}GB RAM</p><span class="pill ${on?"":"off"}">${on?"● Running":"● Stopped"}</span><div class="actions">
 <button class="start" onclick="act('${s.id}','start')">Start</button><button class="stop" onclick="act('${s.id}','stop')">Stop</button><button onclick="act('${s.id}','restart')">Restart</button><button onclick="act('${s.id}','kill')">Kill</button><button onclick="delServer('${s.id}')">Delete</button></div></div>`
}
function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
async function load(){try{servers=await api("/api/servers");$("#total").textContent=servers.length;$("#running").textContent=servers.filter(s=>s.status==="running").length;$("#stopped").textContent=servers.filter(s=>s.status!=="running").length;$("#serverGrid").innerHTML=servers.length?servers.map(card).join(""):`<div class="form-card"><p class="muted">No servers yet. Create your first server.</p></div>`;$("#serverList").innerHTML=servers.map(card).join("")||"<p class='muted'>No servers.</p>";["pluginServer","versionServer"].forEach(id=>{$("#"+id).innerHTML=servers.map(s=>`<option value="${s.id}">${esc(s.name)}</option>`).join("")});}catch(e){}}
async function act(id,a){try{await api(`/api/servers/${id}/${a}`,{method:"POST"});load()}catch(e){alert(e.message)}}
async function delServer(id){if(!confirm("Delete server and its files?"))return;try{await api(`/api/servers/${id}`,{method:"DELETE"});load()}catch(e){alert(e.message)}}

$("#createForm").onsubmit=async e=>{e.preventDefault();$("#createMsg").textContent="Creating Docker server...";try{await api("/api/servers",{method:"POST",body:JSON.stringify({id:$("#sid").value,name:$("#sname").value,port:Number($("#sport").value),ram:Number($("#sram").value),version:$("#sversion").value,software:$("#ssoftware").value})});$("#createMsg").textContent="Server created.";e.target.reset();load();showPage("servers")}catch(x){$("#createMsg").textContent=x.message}};

async function changeVersion(){const id=$("#versionServer").value;if(!id)return alert("Select a server");$("#versionMsg").textContent="Creating backup and changing version...";try{const d=await api(`/api/servers/${id}/version`,{method:"POST",body:JSON.stringify({version:$("#versionSelect").value,software:$("#softwareSelect").value})});$("#versionMsg").textContent=`Done. Backup: ${d.backup}`;load()}catch(e){$("#versionMsg").textContent=e.message}}
function fakeUpload(){alert("Upload UI is ready. Wire this button to a multipart upload endpoint for production plugin installation.");}
setInterval(()=>$("#clock").textContent=new Date().toLocaleTimeString(),1000);
fillSelects();api("/api/me").then(()=>{showApp();load()}).catch(()=>showLogin());
