#!/usr/bin/env bash
set -e

APP="/opt/alooz-panel"
PORT=3000

echo "======================================"
echo "     ALOOZ VPS PROTECTOR PANEL"
echo "          ONE CLICK INSTALL"
echo "======================================"

[ "$(id -u)" = "0" ] || {
  echo "ERROR: Run as root."
  exit 1
}

command -v docker >/dev/null 2>&1 || {
  echo "ERROR: Docker is not installed."
  exit 1
}

mkdir -p "$APP"
cd "$APP"

cat > package.json <<'EOF'
{
  "name": "alooz-vps-protector-panel",
  "version": "1.0.0",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^5.1.0",
    "systeminformation": "^5.27.11"
  }
}
EOF

cat > server.js <<'EOF'
const express = require("express");
const si = require("systeminformation");
const {exec} = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

function cmd(command) {
  return new Promise(resolve => {
    exec(command, {timeout:10000}, (err, stdout, stderr) => {
      resolve(stdout || stderr || "");
    });
  });
}

app.get("/", async (req,res) => {
  const cpu = await si.currentLoad();
  const mem = await si.mem();
  const disk = await si.fsSize();
  const containers = await cmd(
    "docker ps --format '{{.Names}} | {{.Status}} | {{.Image}}'"
  );

  const root = disk.find(x => x.mount === "/") || disk[0] || {};
  const cpuUse = (cpu.currentLoad || 0).toFixed(1);
  const ramUse = ((mem.active / mem.total) * 100).toFixed(1);
  const diskUse = (root.use || 0).toFixed(1);

  res.send(`
<!DOCTYPE html>
<html>
<head>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ALOOZ VPS Protector</title>
<style>
body{
  margin:0;
  padding:20px;
  background:#080d18;
  color:white;
  font-family:Arial,sans-serif
}
h1{font-size:25px}
.grid{
  display:grid;
  grid-template-columns:repeat(auto-fit,minmax(160px,1fr));
  gap:15px
}
.card{
  background:#121a2b;
  border:1px solid #263452;
  border-radius:15px;
  padding:20px
}
.value{
  font-size:30px;
  font-weight:bold;
  margin-top:10px
}
pre{
  background:#050912;
  padding:15px;
  border-radius:12px;
  overflow:auto
}
</style>
</head>
<body>

<h1>🛡️ ALOOZ VPS Protector Panel</h1>

<div class="grid">

<div class="card">
CPU
<div class="value">${cpuUse}%</div>
</div>

<div class="card">
RAM
<div class="value">${ramUse}%</div>
</div>

<div class="card">
DISK
<div class="value">${diskUse}%</div>
</div>

<div class="card">
DOCKER
<div class="value">ONLINE</div>
</div>

</div>

<div class="card" style="margin-top:15px">
<h2>🐳 Docker Containers</h2>
<pre>${containers || "No running containers."}</pre>
</div>

</body>
</html>
`);
});

app.listen(PORT,"0.0.0.0",()=>{
  console.log("ALOOZ Panel running on port "+PORT);
});
EOF

cat > Dockerfile <<'EOF'
FROM node:22-alpine

WORKDIR /app

COPY package.json .

RUN npm install --omit=dev

COPY server.js .

EXPOSE 3000

CMD ["node","server.js"]
EOF

cat > docker-compose.yml <<'EOF'
services:
  alooz-panel:
    build: .
    container_name: alooz-vps-protector-panel
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
EOF

echo "Building panel..."

docker compose down 2>/dev/null || true
docker compose up -d --build

IP=$(curl -4 -fsS --max-time 5 ifconfig.me 2>/dev/null || echo "YOUR-VPS-IP")

echo
echo "======================================"
echo "       ALOOZ PANEL INSTALLED"
echo "======================================"
echo
echo "Panel URL:"
echo "http://$IP:$PORT"
echo
echo "Container:"
echo "alooz-vps-protector-panel"
echo
echo "======================================"
