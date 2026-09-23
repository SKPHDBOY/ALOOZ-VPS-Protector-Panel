const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFile, spawn } = require("child_process");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA = path.join(ROOT, "data");
const SERVERS = path.join(ROOT, "servers");
const PANEL_NAME = process.env.PANEL_NAME || "ALOOZ Hosting";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-this-password";
const SESSION_SECRET = process.env.SESSION_SECRET || "change-this-secret";

fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(SERVERS, { recursive: true });

const dbFile = path.join(DATA, "servers.json");
function readDB() {
  try { return JSON.parse(fs.readFileSync(dbFile, "utf8")); }
  catch { return []; }
}
function writeDB(v) { fs.writeFileSync(dbFile, JSON.stringify(v, null, 2)); }

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"});
  res.end(body);
}
function html(res, file) {
  const p = path.join(ROOT, "public", file);
  res.writeHead(200, {"Content-Type":"text/html; charset=utf-8"});
  fs.createReadStream(p).pipe(res);
}
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || "").split(";").forEach(x => {
    const i=x.indexOf("="); if(i>0) out[x.slice(0,i).trim()] = decodeURIComponent(x.slice(i+1).trim());
  });
  return out;
}
function sign(v) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("hex");
}
function makeSession() {
  const v = crypto.randomBytes(24).toString("hex");
  return v + "." + sign(v);
}
function auth(req) {
  const s = parseCookies(req).session || "";
  const [v, sig] = s.split(".");
  return v && sig && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(sign(v)));
}
function body(req) {
  return new Promise((resolve,reject)=>{
    let b=""; req.on("data",c=>{ b+=c; if(b.length>2e6) req.destroy(); });
    req.on("end",()=>{ try{resolve(b?JSON.parse(b):{});}catch(e){reject(e);} });
  });
}
function safeName(s) {
  return String(s||"").replace(/[^a-zA-Z0-9._-]/g,"-").slice(0,40);
}
function run(cmd,args,opts={}) {
  return new Promise((resolve)=>{
    execFile(cmd,args,{timeout: 15000, maxBuffer: 1024*1024,...opts},(error,stdout,stderr)=>{
      resolve({ok:!error, stdout, stderr, error:error?.message});
    });
  });
}
async function docker(args) { return run("docker",args); }

async function dockerState(name) {
  const r = await docker(["inspect","-f","{{.State.Status}}",name]);
  return r.ok ? r.stdout.trim() : "stopped";
}

async function createContainer(s) {
  const dir = path.join(SERVERS, s.id);
  fs.mkdirSync(dir,{recursive:true});
  const args = [
    "run","-d","--name",s.id,"--restart","unless-stopped",
    "-e","EULA=TRUE","-e",`MEMORY=${s.ram}G`,
    "-p",`${s.port}:25565/tcp`,"-p",`${s.port}:25565/udp`,
    "-v",`${dir}:/data`
  ];
  // itzg/minecraft-server reads VERSION and TYPE.
  args.push("-e",`VERSION=${s.version}`,"-e",`TYPE=${s.software}`);
  args.push("itzg/minecraft-server");
  return docker(args);
}

async function removeContainer(id) {
  await docker(["rm","-f",id]);
  const dir = path.join(SERVERS,id);
  if (fs.existsSync(dir)) fs.rmSync(dir,{recursive:true,force:true});
}

function validServer(s) {
  return s && /^[a-z0-9-]{3,40}$/.test(s.id) && Number.isInteger(s.port) && s.port>=1024 && s.port<=65535;
}

async function api(req,res,url) {
  if (url === "/api/login" && req.method === "POST") {
    const b=await body(req);
    if (b.username===ADMIN_USER && b.password===ADMIN_PASSWORD) {
      res.setHeader("Set-Cookie",`session=${encodeURIComponent(makeSession())}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
      return json(res,200,{ok:true});
    }
    return json(res,401,{ok:false,error:"Invalid credentials"});
  }
  if (url === "/api/logout" && req.method === "POST") {
    res.setHeader("Set-Cookie","session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    return json(res,200,{ok:true});
  }
  if (!auth(req)) return json(res,401,{ok:false,error:"Unauthorized"});

  if (url === "/api/me") return json(res,200,{ok:true,panel:PANEL_NAME,user:ADMIN_USER});

  if (url === "/api/servers" && req.method === "GET") {
    const list=readDB();
    const out=[];
    for(const s of list) out.push({...s,status:await dockerState(s.id)});
    return json(res,200,out);
  }

  if (url === "/api/servers" && req.method === "POST") {
    const b=await body(req);
    const s={
      id:safeName(b.id).toLowerCase(),
      name:String(b.name||b.id||"Minecraft Server").slice(0,60),
      port:Number(b.port||25565),
      ram:Number(b.ram||2),
      version:String(b.version||"1.21.11"),
      software:String(b.software||"PAPER").toUpperCase()
    };
    if(!validServer(s)) return json(res,400,{error:"Invalid server id/port"});
    const db=readDB();
    if(db.some(x=>x.id===s.id)) return json(res,409,{error:"Server already exists"});
    const r=await createContainer(s);
    if(!r.ok) return json(res,500,{error:r.stderr||r.error});
    db.push(s); writeDB(db);
    return json(res,201,{ok:true,server:s});
  }

  const m=url.match(/^\/api\/servers\/([^/]+)\/(start|stop|restart|kill)$/);
  if(m && req.method==="POST") {
    const id=m[1], action=m[2];
    if(!readDB().some(s=>s.id===id)) return json(res,404,{error:"Server not found"});
    const map={start:"start",stop:"stop",restart:"restart",kill:"kill"};
    const r=await docker([map[action],id]);
    return json(res,r.ok?200:500,{ok:r.ok,error:r.ok?undefined:r.stderr||r.error});
  }

  const cmdm=url.match(/^\/api\/servers\/([^/]+)\/command$/);
  if(cmdm && req.method==="POST") {
    const b=await body(req), id=cmdm[1], command=String(b.command||"").trim();
    if(!/^[\x20-\x7E]{1,300}$/.test(command)) return json(res,400,{error:"Invalid command"});
    if(!readDB().some(s=>s.id===id)) return json(res,404,{error:"Server not found"});
    const r=await docker(["exec",id,"rcon-cli",command]);
    return json(res,r.ok?200:500,{ok:r.ok,output:r.stdout||r.stderr});
  }

  const delm=url.match(/^\/api\/servers\/([^/]+)$/);
  if(delm && req.method==="DELETE") {
    const id=delm[1], db=readDB(), s=db.find(x=>x.id===id);
    if(!s) return json(res,404,{error:"Server not found"});
    await removeContainer(id); writeDB(db.filter(x=>x.id!==id));
    return json(res,200,{ok:true});
  }

  const plugm=url.match(/^\/api\/servers\/([^/]+)\/plugins$/);
  if(plugm && req.method==="GET") {
    const dir=path.join(SERVERS,plugm[1],"plugins");
    fs.mkdirSync(dir,{recursive:true});
    const items=fs.readdirSync(dir).filter(x=>x.toLowerCase().endsWith(".jar"));
    return json(res,200,items);
  }

  const verM=url.match(/^\/api\/servers\/([^/]+)\/version$/);
  if(verM && req.method==="POST") {
    const id=verM[1], b=await body(req), db=readDB(), s=db.find(x=>x.id===id);
    if(!s) return json(res,404,{error:"Server not found"});
    const allowedVersions=["1.21.11","1.21.10","1.21.8","1.21.1","1.20.6","1.20.4","1.19.4"];
    const allowedSoftware=["PAPER","PURPUR","VANILLA","FABRIC","FORGE","NEOFORGE"];
    if(!allowedVersions.includes(String(b.version)) || !allowedSoftware.includes(String(b.software).toUpperCase()))
      return json(res,400,{error:"Unsupported version/software in this MVP"});
    const backupDir=path.join(DATA,"backups",id);
    fs.mkdirSync(backupDir,{recursive:true});
    const stamp=new Date().toISOString().replace(/[:.]/g,"-");
    const src=path.join(SERVERS,id);
    const dest=path.join(backupDir,stamp);
    fs.cpSync(src,dest,{recursive:true});
    await docker(["stop",id]);
    await docker(["rm",id]);
    s.version=String(b.version); s.software=String(b.software).toUpperCase();
    const r=await createContainer(s);
    if(!r.ok) return json(res,500,{error:r.stderr||r.error,backup:dest});
    writeDB(db);
    return json(res,200,{ok:true,backup:dest,server:s});
  }

  return json(res,404,{error:"Not found"});
}

const server=http.createServer(async(req,res)=>{
  try{
    const u=new URL(req.url,`http://${req.headers.host}`);
    if(u.pathname.startsWith("/api/")) return await api(req,res,u.pathname);
    if(u.pathname==="/" || u.pathname==="/index.html") return html(res,"index.html");
    if(u.pathname==="/app.js") { res.writeHead(200,{"Content-Type":"application/javascript"}); return fs.createReadStream(path.join(ROOT,"public","app.js")).pipe(res); }
    if(u.pathname==="/styles.css") { res.writeHead(200,{"Content-Type":"text/css"}); return fs.createReadStream(path.join(ROOT,"public","styles.css")).pipe(res); }
    res.writeHead(404); res.end("Not found");
  }catch(e){ json(res,500,{error:e.message}); }
});
server.listen(PORT,()=>console.log(`${PANEL_NAME} listening on :${PORT}`));
