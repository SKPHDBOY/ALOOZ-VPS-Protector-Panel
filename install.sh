#!/bin/bash
set -e

# ============================================================
# ALOOZ VPS PROTECTOR PANEL
# One-Command Installer
# ============================================================

APP_DIR="/opt/alooz-protector"
CONTAINER="alooz-protector"
IMAGE="alooz-protector:latest"
PORT="${PORT:-3000}"

echo "=========================================="
echo "       ALOOZ VPS PROTECTOR PANEL"
echo "=========================================="

if [ "$EUID" -ne 0 ]; then
    echo "Please run as root."
    exit 1
fi

command -v docker >/dev/null 2>&1 || {
    echo "Docker is not installed."
    echo "Install Docker first."
    exit 1
}

docker info >/dev/null 2>&1 || {
    echo "Docker daemon is not available."
    exit 1
}

mkdir -p "$APP_DIR"
cd "$APP_DIR"

# ------------------------------------------------------------
# package.json
# ------------------------------------------------------------

cat > package.json <<'EOF'
{
  "name": "alooz-vps-protector-panel",
  "version": "1.0.0",
  "private": true,
  "main": "server.js",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^5.1.0"
  }
}
EOF

# ------------------------------------------------------------
# server.js
# ------------------------------------------------------------

cat > server.js <<'EOF'
const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFile } = require("child_process");

const app = express();

const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "change-me";

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

/* =========================================================
   AUTH
   ========================================================= */

function unauthorized(res) {
    res.set("WWW-Authenticate", 'Basic realm="ALOOZ Protector"');
    return res.status(401).send("Authentication required");
}

function auth(req, res, next) {
    const header = req.headers.authorization || "";

    if (!header.startsWith("Basic ")) {
        return unauthorized(res);
    }

    try {
        const decoded = Buffer.from(
            header.slice(6),
            "base64"
        ).toString();

        const index = decoded.indexOf(":");

        if (index === -1) {
            return unauthorized(res);
        }

        const user = decoded.slice(0, index);
        const pass = decoded.slice(index + 1);

        if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
            return unauthorized(res);
        }

        next();
    } catch {
        return unauthorized(res);
    }
}

/* =========================================================
   HELPERS
   ========================================================= */

function docker(args, options = {}) {
    return new Promise((resolve, reject) => {
        execFile(
            "docker",
            args,
            {
                timeout: options.timeout || 30000,
                maxBuffer: options.maxBuffer || 20 * 1024 * 1024
            },
            (error, stdout, stderr) => {
                if (error) {
                    reject(
                        new Error(
                            (stderr || error.message).trim()
                        )
                    );
                    return;
                }

                resolve(stdout);
            }
        );
    });
}

function safeName(name) {
    return String(name || "")
        .replace(/[^a-zA-Z0-9_.-]/g, "-")
        .slice(0, 64);
}

function number(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

/* =========================================================
   HEALTH
   ========================================================= */

app.get("/api/health", (req, res) => {
    res.json({
        ok: true,
        name: "ALOOZ VPS Protector Panel",
        version: "1.0.0"
    });
});

/* =========================================================
   SYSTEM
   ========================================================= */

app.get("/api/system", async (req, res) => {
    try {
        const total = os.totalmem();
        const free = os.freemem();
        const used = total - free;

        let disk = {
            total: 0,
            used: 0,
            available: 0
        };

        try {
            const df = await new Promise((resolve, reject) => {
                execFile(
                    "df",
                    ["-k", "/"],
                    (error, stdout, stderr) => {
                        if (error) return reject(error);
                        resolve(stdout);
                    }
                );
            });

            const lines = String(df).trim().split("\n");
            const row = lines[lines.length - 1]
                .trim()
                .split(/\s+/);

            disk.total = number(row[1]) * 1024;
            disk.used = number(row[2]) * 1024;
            disk.available = number(row[3]) * 1024;
        } catch {}

        res.json({
            hostname: os.hostname(),
            platform: os.platform(),
            arch: os.arch(),
            cpus: os.cpus().length,
            uptime: os.uptime(),
            memory: {
                total,
                used,
                free,
                percent: total
                    ? (used / total) * 100
                    : 0
            },
            disk
        });
    } catch (e) {
        res.status(500).json({
            error: e.message
        });
    }
});

/* =========================================================
   DOCKER INFO
   ========================================================= */

app.get("/api/docker/info", async (req, res) => {
    try {
        const info = await docker([
            "info",
            "--format",
            "{{json .}}"
        ]);

        res.type("application/json").send(info);
    } catch (e) {
        res.status(500).json({
            error: e.message
        });
    }
});

/* =========================================================
   SERVER LIST
   ========================================================= */

app.get("/api/servers", async (req, res) => {
    try {
        const output = await docker([
            "ps",
            "-a",
            "--format",
            "{{json .}}"
        ]);

        const servers = output
            .trim()
            .split("\n")
            .filter(Boolean)
            .map(line => JSON.parse(line));

        res.json(servers);
    } catch (e) {
        res.status(500).json({
            error: e.message
        });
    }
});

/* =========================================================
   CREATE SERVER
   ========================================================= */

app.post("/api/servers/create", async (req, res) => {
    try {
        const name = safeName(req.body.name);

        if (!name) {
            return res.status(400).json({
                error: "Server name required"
            });
        }

        const image =
            safeName(req.body.image || "alpine:latest");

        const command =
            req.body.command || "sh";

        const memory =
            number(req.body.memory, 512);

        const cpus =
            number(req.body.cpus, 1);

        const args = [
            "run",
            "-d",
            "--name",
            name,
            "--restart",
            "unless-stopped",
            "--memory",
            `${memory}m`,
            "--cpus",
            String(cpus)
        ];

        if (Array.isArray(req.body.ports)) {
            for (const p of req.body.ports) {
                const port = String(p)
                    .replace(/[^0-9:]/g, "");

                if (port) {
                    args.push("-p", port);
                }
            }
        }

        args.push(
            image,
            "sh",
            "-c",
            command
        );

        const id = (
            await docker(args)
        ).trim();

        res.json({
            success: true,
            id
        });
    } catch (e) {
        res.status(500).json({
            error: e.message
        });
    }
});

/* =========================================================
   SERVER ACTIONS
   ========================================================= */

app.post("/api/servers/:id/:action", async (req, res) => {
    const allowed = [
        "start",
        "stop",
        "restart",
        "kill",
        "pause",
        "unpause"
    ];

    const action = req.params.action;

    if (!allowed.includes(action)) {
        return res.status(400).json({
            error: "Invalid action"
        });
    }

    try {
        await docker([
            action,
            req.params.id
        ]);

        res.json({
            success: true
        });
    } catch (e) {
        res.status(500).json({
            error: e.message
        });
    }
});

/* =========================================================
   DELETE
   ========================================================= */

app.delete("/api/servers/:id", async (req, res) => {
    try {
        await docker([
            "rm",
            "-f",
            req.params.id
        ]);

        res.json({
            success: true
        });
    } catch (e) {
        res.status(500).json({
            error: e.message
        });
    }
});

/* =========================================================
   RENAME
   ========================================================= */

app.post("/api/servers/:id/rename", async (req, res) => {
    try {
        const name = safeName(req.body.name);

        if (!name) {
            return res.status(400).json({
                error: "Name required"
            });
        }

        await docker([
            "rename",
            req.params.id,
            name
        ]);

        res.json({
            success: true
        });
    } catch (e) {
        res.status(500).json({
            error: e.message
        });
    }
});

/* =========================================================
   CONSOLE COMMAND
   ========================================================= */

app.post("/api/servers/:id/command", async (req, res) => {
    try {
        const command = String(
            req.body.command || ""
        ).trim();

        if (!command) {
            return res.status(400).json({
                error: "Command required"
            });
        }

        const output = await docker([
            "exec",
            req.params.id,
            "sh",
            "-c",
            command
        ]);

        res.json({
            output
        });
    } catch (e) {
        res.status(500).json({
            error: e.message
        });
    }
});

/* =========================================================
   LOGS
   ========================================================= */

app.get("/api/servers/:id/logs", async (req, res) => {
    try {
        const lines = Math.min(
            number(req.query.lines, 200),
            5000
        );

        const output = await docker([
            "logs",
            "--tail",
            String(lines),
            req.params.id
        ]);

        res.type("text/plain").send(output);
    } catch (e) {
        res.status(500).send(e.message);
    }
});

/* =========================================================
   STATS
   ========================================================= */

app.get("/api/servers/:id/stats", async (req, res) => {
    try {
        const output = await docker([
            "stats",
            "--no-stream",
            "--format",
            "{{json .}}",
            req.params.id
        ]);

        res.type("application/json").send(output);
    } catch (e) {
        res.status(500).json({
            error: e.message
        });
    }
});

/* =========================================================
   FILE MANAGER
   ========================================================= */

const FILE_ROOT = "/opt/alooz-data";

fs.mkdirSync(FILE_ROOT, {
    recursive: true
});

function resolveFile(input) {
    const clean = String(input || "")
        .replace(/^\/+/, "");

    const target = path.resolve(
        FILE_ROOT,
        clean
    );

    if (
        target !== FILE_ROOT &&
        !target.startsWith(FILE_ROOT + path.sep)
    ) {
        throw new Error("Invalid path");
    }

    return target;
}

app.get("/api/files", auth, (req, res) => {
    try {
        const dir = resolveFile(
            req.query.path || ""
        );

        fs.mkdirSync(dir, {
            recursive: true
        });

        const items = fs.readdirSync(
            dir,
            { withFileTypes: true }
        ).map(item => ({
            name: item.name,
            type: item.isDirectory()
                ? "directory"
                : "file"
        }));

        res.json({
            path: req.query.path || "",
            items
        });
    } catch (e) {
        res.status(400).json({
            error: e.message
        });
    }
});

app.post("/api/files/folder", auth, (req, res) => {
    try {
        const target = resolveFile(
            path.join(
                req.body.path || "",
                safeName(req.body.name)
            )
        );

        fs.mkdirSync(target, {
            recursive: true
        });

        res.json({
            success: true
        });
    } catch (e) {
        res.status(400).json({
            error: e.message
        });
    }
});

app.get("/api/files/read", auth, (req, res) => {
    try {
        const target = resolveFile(
            req.query.path
        );

        const stat = fs.statSync(target);

        if (!stat.isFile()) {
            throw new Error("Not a file");
        }

        if (stat.size > 5 * 1024 * 1024) {
            throw new Error(
                "File too large for editor"
            );
        }

        res.json({
            content: fs.readFileSync(
                target,
                "utf8"
            )
        });
    } catch (e) {
        res.status(400).json({
            error: e.message
        });
    }
});

app.post("/api/files/write", auth, (req, res) => {
    try {
        const target = resolveFile(
            req.body.path
        );

        fs.writeFileSync(
            target,
            String(req.body.content || "")
        );

        res.json({
            success: true
        });
    } catch (e) {
        res.status(400).json({
            error: e.message
        });
    }
});

app.delete("/api/files", auth, (req, res) => {
    try {
        const target = resolveFile(
            req.body.path
        );

        if (target === FILE_ROOT) {
            throw new Error(
                "Cannot delete root directory"
            );
        }

        fs.rmSync(target, {
            recursive: true,
            force: true
        });

        res.json({
            success: true
        });
    } catch (e) {
        res.status(400).json({
            error: e.message
        });
    }
});

/* =========================================================
   PORTS
   ========================================================= */

app.get("/api/ports", auth, async (req, res) => {
    try {
        const output = await docker([
            "ps",
            "-a",
            "--format",
            "{{.Names}}\t{{.Ports}}"
        ]);

        res.type("text/plain").send(output);
    } catch (e) {
        res.status(500).json({
            error: e.message
        });
    }
});

/* =========================================================
   BACKUP
   ========================================================= */

const BACKUP_DIR =
    "/opt/alooz-backups";

fs.mkdirSync(BACKUP_DIR, {
    recursive: true
});

app.post("/api/servers/:id/backup", auth, async (req, res) => {
    try {
        const id = safeName(req.params.id);
        const filename =
            `${id}-${Date.now()}.tar`;

        const output =
            path.join(
                BACKUP_DIR,
                filename
            );

        await new Promise((resolve, reject) => {
            execFile(
                "docker",
                [
                    "export",
                    id,
                    "-o",
                    output
                ],
                (error, stdout, stderr) => {
                    if (error) {
                        reject(
                            new Error(
                                stderr ||
                                error.message
                            )
                        );
                    } else {
                        resolve();
                    }
                }
            );
        });

        res.json({
            success: true,
            backup: filename
        });
    } catch (e) {
        res.status(500).json({
            error: e.message
        });
    }
});

app.get("/api/backups", auth, (req, res) => {
    try {
        const files =
            fs.readdirSync(BACKUP_DIR);

        res.json(files);
    } catch (e) {
        res.status(500).json({
            error: e.message
        });
    }
});

/* =========================================================
   DASHBOARD
   ========================================================= */

app.get("/", auth, (req, res) => {
    res.send(`<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">

<title>ALOOZ Protector</title>

<style>
*{
 box-sizing:border-box;
}

body{
 margin:0;
 background:#0b1020;
 color:#fff;
 font-family:Arial,sans-serif;
}

header{
 padding:18px;
 background:#111936;
 border-bottom:1px solid #263052;
}

h1{
 margin:0;
 font-size:22px;
}

.container{
 padding:15px;
 max-width:1400px;
 margin:auto;
}

.grid{
 display:grid;
 grid-template-columns:
 repeat(auto-fit,minmax(180px,1fr));
 gap:12px;
}

.card{
 background:#121a35;
 border:1px solid #273052;
 border-radius:14px;
 padding:16px;
 margin-bottom:14px;
}

.stat{
 font-size:25px;
 font-weight:bold;
 margin-top:8px;
}

button{
 border:0;
 border-radius:9px;
 padding:9px 12px;
 margin:3px;
 cursor:pointer;
 background:#29365f;
 color:white;
}

button:hover{
 opacity:.85;
}

input,textarea,select{
 width:100%;
 background:#090e1d;
 color:white;
 border:1px solid #303b62;
 border-radius:8px;
 padding:10px;
 margin:5px 0;
}

textarea{
 min-height:150px;
 font-family:monospace;
}

.server{
 margin-top:12px;
 padding:14px;
 border:1px solid #28345b;
 border-radius:12px;
}

pre{
 background:#050814;
 padding:12px;
 border-radius:9px;
 overflow:auto;
 max-height:300px;
}

.small{
 color:#9ba6c7;
 font-size:13px;
}

.danger{
 background:#7d2635;
}

.green{
 background:#17633c;
}

@media(max-width:600px){
 .container{
   padding:10px;
 }
}
</style>
</head>

<body>

<header>
 <h1>🛡️ ALOOZ VPS Protector Panel</h1>
 <div class="small">
 Advanced Docker VPS Management
 </div>
</header>

<div class="container">

<div class="grid">

<div class="card">
 CPU
 <div id="cpu" class="stat">-</div>
</div>

<div class="card">
 RAM
 <div id="ram" class="stat">-</div>
</div>

<div class="card">
 Disk
 <div id="disk" class="stat">-</div>
</div>

<div class="card">
 Uptime
 <div id="uptime" class="stat">-</div>
</div>

</div>

<div class="card">

<h3>🚀 Create Server</h3>

<input
 id="name"
 placeholder="Server name">

<input
 id="image"
 placeholder="Docker image"
 value="alpine:latest">

<input
 id="memory"
 type="number"
 placeholder="RAM MB"
 value="512">

<input
 id="cpus"
 type="number"
 step="0.1"
 placeholder="CPU"
 value="1">

<input
 id="command"
 placeholder="Startup command"
 value="while true; do sleep 60; done">

<button
 class="green"
 onclick="createServer()">
 Create Server
</button>

</div>

<div class="card">

<h3>🖥️ Servers</h3>

<div id="servers">
Loading...
</div>

</div>

<div class="card">

<h3>💻 Console</h3>

<input
 id="serverId"
 placeholder="Container ID / Name">

<input
 id="consoleCommand"
 placeholder="Command">

<button
 onclick="sendCommand()">
 Send Command
</button>

<pre id="consoleOutput"></pre>

</div>

<div class="card">

<h3>📜 Logs</h3>

<button onclick="loadLogs()">
Refresh Logs
</button>

<pre id="logs"></pre>

</div>

<div class="card">

<h3>📁 File Manager</h3>

<input
id="filePath"
placeholder="Path inside /opt/alooz-data">

<button onclick="loadFiles()">
List Files
</button>

<div id="files"></div>

</div>

<div class="card">

<h3>💾 Backup</h3>

<input
id="backupServer"
placeholder="Container ID / Name">

<button onclick="backup()">
Create Backup
</button>

<div id="backups"></div>

</div>

<div class="card">

<h3>🌐 Allocations / Ports</h3>

<button onclick="loadPorts()">
Refresh Ports
</button>

<pre id="ports"></pre>

</div>

</div>

<script>

async function api(url, options={}){
 const r = await fetch(url,options);

 if(!r.ok){
   const t = await r.text();
   throw new Error(t);
 }

 const type =
   r.headers.get("content-type") || "";

 if(type.includes("application/json")){
   return r.json();
 }

 return r.text();
}

function bytes(n){
 if(!n) return "0 B";

 const u=[
  "B","KB","MB","GB","TB"
 ];

 let i=0;

 while(n>=1024 && i<u.length-1){
   n/=1024;
   i++;
 }

 return n.toFixed(1)+" "+u[i];
}

async function system(){

 try{

 const s =
   await api("/api/system");

 document.getElementById("cpu")
   .textContent =
   s.cpus+" cores";

 document.getElementById("ram")
   .textContent =
   s.memory.percent.toFixed(1)+"%";

 document.getElementById("disk")
   .textContent =
   bytes(s.disk.used);

 document.getElementById("uptime")
   .textContent =
   Math.floor(s.uptime/3600)+"h";

 }catch(e){
   console.log(e);
 }

}

async function servers(){

 try{

 const list =
   await api("/api/servers");

 const box =
   document.getElementById("servers");

 if(!list.length){
   box.innerHTML =
     "<p>No servers found.</p>";
   return;
 }

 box.innerHTML =
   list.map(s => {

 const id = s.ID || "";
 const name = s.Names || "";

 return \`
 <div class="server">

 <b>\${name}</b>

 <div class="small">
 ID: \${id}
 <br>
 Status: \${s.Status || ""}
 </div>

 <button
 onclick="action('\${id}','start')">
 Start
 </button>

 <button
 onclick="action('\${id}','stop')">
 Stop
 </button>

 <button
 onclick="action('\${id}','restart')">
 Restart
 </button>

 <button
 onclick="action('\${id}','kill')">
 Kill
 </button>

 <button
 onclick="showLogs('\${id}')">
 Logs
 </button>

 <button
 class="danger"
 onclick="removeServer('\${id}')">
 Delete
 </button>

 </div>
 \`;

 }).join("");

 }catch(e){
   document.getElementById("servers")
     .textContent=e.message;
 }

}

async function action(id,action){

 try{

 await api(
  "/api/servers/"+encodeURIComponent(id)+"/"+action,
  {method:"POST"}
 );

 await servers();

 }catch(e){
   alert(e.message);
 }

}

async function createServer(){

 try{

 const body={
  name:document.getElementById("name").value,
  image:document.getElementById("image").value,
  memory:document.getElementById("memory").value,
  cpus:document.getElementById("cpus").value,
  command:document.getElementById("command").value
 };

 await api(
  "/api/servers/create",
  {
   method:"POST",
   headers:{
    "Content-Type":
    "application/json"
   },
   body:JSON.stringify(body)
  }
 );

 alert("Server created");

 await servers();

 }catch(e){
   alert(e.message);
 }

}

async function removeServer(id){

 if(!confirm("Delete server?")) return;

 try{

 await api(
  "/api/servers/"+encodeURIComponent(id),
  {method:"DELETE"}
 );

 await servers();

 }catch(e){
   alert(e.message);
 }

}

async function sendCommand(){

 try{

 const id =
   document.getElementById("serverId").value;

 const command =
   document.getElementById("consoleCommand").value;

 const data =
   await api(
    "/api/servers/"+
    encodeURIComponent(id)+
    "/command",
    {
     method:"POST",
     headers:{
      "Content-Type":
      "application/json"
     },
     body:JSON.stringify({
       command
     })
    }
   );

 document.getElementById("consoleOutput")
   .textContent=data.output;

 }catch(e){
   document.getElementById("consoleOutput")
    .textContent=e.message;
 }

}

async function loadLogs(){

 const id =
   document.getElementById("serverId").value;

 if(!id) return;

 try{

 const text =
   await api(
    "/api/servers/"+
    encodeURIComponent(id)+
    "/logs"
   );

 document.getElementById("logs")
   .textContent=text;

 }catch(e){
   document.getElementById("logs")
    .textContent=e.message;
 }

}

function showLogs(id){

 document.getElementById("serverId")
   .value=id;

 loadLogs();

}

async function loadFiles(){

 try{

 const p =
   document.getElementById("filePath").value;

 const data =
   await api(
    "/api/files?path="+
    encodeURIComponent(p)
   );

 document.getElementById("files")
   .innerHTML =
   data.items.map(x =>
    "<div class='server'>"+
    (x.type==="directory"?"📁 ":"📄 ")+
    x.name+
    "</div>"
   ).join("");

 }catch(e){
   alert(e.message);
 }

}

async function backup(){

 try{

 const id =
   document.getElementById("backupServer").value;

 const data =
   await api(
    "/api/servers/"+
    encodeURIComponent(id)+
    "/backup",
    {method:"POST"}
   );

 alert(
  "Backup created: "+
  data.backup
 );

 }catch(e){
   alert(e.message);
 }

}

async function loadPorts(){

 try{

 const data =
   await api("/api/ports");

 document.getElementById("ports")
   .textContent=data;

 }catch(e){
   document.getElementById("ports")
    .textContent=e.message;
 }

}

system();
servers();

setInterval(system,5000);
setInterval(servers,10000);

</script>

</body>
</html>`);
});

/* =========================================================
   START
   ========================================================= */

app.listen(PORT, "0.0.0.0", () => {
    console.log(
        `ALOOZ Protector running on ${PORT}`
    );
});
EOF

# ------------------------------------------------------------
# Dockerfile
# ------------------------------------------------------------

cat > Dockerfile <<'EOF'
FROM node:22-alpine

WORKDIR /app

COPY package.json .

RUN npm install --omit=dev

COPY server.js .

EXPOSE 3000

CMD ["node", "server.js"]
EOF

# ------------------------------------------------------------
# ADMIN PASSWORD
# ------------------------------------------------------------

if [ ! -f "$APP_DIR/.env" ]; then

    ADMIN_PASS="$(openssl rand -base64 18 | tr -dc 'A-Za-z0-9' | head -c 16)"

    cat > "$APP_DIR/.env" <<EOF
ADMIN_USER=admin
ADMIN_PASS=$ADMIN_PASS
EOF

else

    ADMIN_PASS="$(grep '^ADMIN_PASS=' "$APP_DIR/.env" | cut -d= -f2-)"

fi

# ------------------------------------------------------------
# BUILD
# ------------------------------------------------------------

echo "[1/4] Building Docker image..."

docker build \
    -t "$IMAGE" \
    "$APP_DIR"

# ------------------------------------------------------------
# REMOVE OLD
# ------------------------------------------------------------

echo "[2/4] Removing old container..."

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

# ------------------------------------------------------------
# RUN
# ------------------------------------------------------------

echo "[3/4] Starting panel..."

docker run -d \
    --name "$CONTAINER" \
    --restart unless-stopped \
    -p "$PORT:3000" \
    --env-file "$APP_DIR/.env" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -v "$APP_DIR/data:/opt/alooz-data" \
    -v "$APP_DIR/backups:/opt/alooz-backups" \
    "$IMAGE"

# ------------------------------------------------------------
# FINISH
# ------------------------------------------------------------

echo "[4/4] Installation complete."
echo
echo "=========================================="
echo "       ALOOZ PROTECTOR PANEL"
echo "=========================================="
echo
echo "Panel:"
echo "http://YOUR-VPS-IP:$PORT"
echo
echo "Username:"
echo "admin"
echo
echo "Password:"
echo "$ADMIN_PASS"
echo
echo "Container:"
echo "$CONTAINER"
echo
echo "=========================================="
