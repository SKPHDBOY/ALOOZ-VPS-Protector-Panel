#!/usr/bin/env bash
set -Eeuo pipefail

# ============================================================
# ALOOZ ULTIMATE MAX
# One-Click Docker Panel Installer
# Repository:
# https://github.com/SKPHDBOY/ALOOZ-VPS-Protector-Panel
# ============================================================

APP_NAME="ALOOZ Ultimate MAX"
APP_DIR="/opt/alooz"
PANEL_DIR="$APP_DIR/panel"
DATA_DIR="$APP_DIR/data"
SERVER_DIR="$APP_DIR/servers"
BACKUP_DIR="$APP_DIR/backups"
LOG_DIR="$APP_DIR/logs"
CONFIG_DIR="$APP_DIR/config"
COMPOSE_FILE="$APP_DIR/docker-compose.yml"
ENV_FILE="$APP_DIR/.env"

REPO_RAW="https://raw.githubusercontent.com/SKPHDBOY/ALOOZ-VPS-Protector-Panel/main"

PANEL_PORT="${PANEL_PORT:-3000}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BLUE='\033[0;34m'
NC='\033[0m'

log() {
    echo -e "${CYAN}[ALOOZ]${NC} $*"
}

ok() {
    echo -e "${GREEN}[OK]${NC} $*"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $*"
}

die() {
    echo -e "${RED}[ERROR]${NC} $*"
    exit 1
}

trap 'echo -e "\n${RED}[ERROR] Installation failed on line $LINENO${NC}"' ERR

# ------------------------------------------------------------
# ROOT CHECK
# ------------------------------------------------------------

if [ "$(id -u)" != "0" ]; then
    die "Please run this installer as root."
fi

# ------------------------------------------------------------
# OS DETECTION
# ------------------------------------------------------------

if [ -f /etc/os-release ]; then
    . /etc/os-release
    OS="${ID:-unknown}"
    VERSION="${VERSION_ID:-unknown}"
else
    OS="unknown"
fi

log "Detected OS: $OS $VERSION"

# ------------------------------------------------------------
# CPU / RAM / DISK
# ------------------------------------------------------------

CPU_COUNT="$(nproc 2>/dev/null || echo 1)"
RAM_MB="$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo 2>/dev/null || echo 0)"
DISK_FREE="$(df -Pm / | awk 'NR==2 {print $4}')"

log "CPU: ${CPU_COUNT} cores"
log "RAM: ${RAM_MB} MB"
log "Free Disk: ${DISK_FREE} MB"

# ------------------------------------------------------------
# INSTALL BASIC PACKAGES
# ------------------------------------------------------------

install_packages() {

    if command -v apt-get >/dev/null 2>&1; then

        export DEBIAN_FRONTEND=noninteractive

        apt-get update -y

        apt-get install -y \
            ca-certificates \
            curl \
            wget \
            git \
            jq \
            openssl \
            unzip \
            zip \
            tar \
            gzip \
            procps \
            util-linux \
            coreutils \
            sed \
            grep \
            awk

    elif command -v dnf >/dev/null 2>&1; then

        dnf install -y \
            ca-certificates \
            curl \
            wget \
            git \
            jq \
            openssl \
            unzip \
            zip \
            tar \
            gzip \
            procps \
            util-linux

    elif command -v yum >/dev/null 2>&1; then

        yum install -y \
            ca-certificates \
            curl \
            wget \
            git \
            jq \
            openssl \
            unzip \
            zip \
            tar \
            gzip \
            procps \
            util-linux

    else
        warn "Package manager not detected. Continuing..."
    fi
}

install_packages

# ------------------------------------------------------------
# DOCKER DETECTION
# ------------------------------------------------------------

if ! command -v docker >/dev/null 2>&1; then

    log "Docker not found. Installing Docker..."

    if command -v curl >/dev/null 2>&1; then
        curl -fsSL https://get.docker.com | sh
    else
        die "curl is required to install Docker."
    fi
fi

if ! command -v docker >/dev/null 2>&1; then
    die "Docker installation failed."
fi

ok "Docker detected: $(docker --version)"

# ------------------------------------------------------------
# DOCKER COMPOSE
# ------------------------------------------------------------

if docker compose version >/dev/null 2>&1; then
    COMPOSE_CMD="docker compose"
else

    warn "Docker Compose plugin not detected."

    if command -v apt-get >/dev/null 2>&1; then
        apt-get update -y
        apt-get install -y docker-compose-plugin || true
    fi

    if docker compose version >/dev/null 2>&1; then
        COMPOSE_CMD="docker compose"
    else
        die "Docker Compose is required."
    fi
fi

ok "Docker Compose ready."

# ------------------------------------------------------------
# DIRECTORIES
# ------------------------------------------------------------

log "Creating ALOOZ directories..."

mkdir -p \
    "$APP_DIR" \
    "$PANEL_DIR" \
    "$DATA_DIR" \
    "$SERVER_DIR" \
    "$BACKUP_DIR" \
    "$LOG_DIR" \
    "$CONFIG_DIR"

chmod 755 "$APP_DIR"

# ------------------------------------------------------------
# RANDOM SECRETS
# ------------------------------------------------------------

generate_secret() {
    openssl rand -hex 32 2>/dev/null || \
    head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 64
}

generate_password() {
    openssl rand -base64 24 2>/dev/null | tr -dc 'A-Za-z0-9' | head -c 20
}

JWT_SECRET="$(generate_secret)"
POSTGRES_PASSWORD="$(generate_password)"
REDIS_PASSWORD="$(generate_password)"
ADMIN_PASSWORD="$(generate_password)"

# ------------------------------------------------------------
# SAVE ENV
# ------------------------------------------------------------

cat > "$ENV_FILE" <<EOF
# ============================================================
# ALOOZ ULTIMATE MAX ENVIRONMENT
# ============================================================

APP_NAME=ALOOZ
NODE_ENV=production

PANEL_PORT=${PANEL_PORT}

JWT_SECRET=${JWT_SECRET}

ADMIN_USERNAME=admin
ADMIN_PASSWORD=${ADMIN_PASSWORD}

POSTGRES_DB=alooz
POSTGRES_USER=alooz
POSTGRES_PASSWORD=${POSTGRES_PASSWORD}

REDIS_PASSWORD=${REDIS_PASSWORD}

TZ=Asia/Dhaka

DATA_DIR=/opt/alooz/data
SERVER_DIR=/opt/alooz/servers
BACKUP_DIR=/opt/alooz/backups
LOG_DIR=/opt/alooz/logs
CONFIG_DIR=/opt/alooz/config

MAX_UPLOAD_SIZE=10gb

ENABLE_REGISTRATION=true
ENABLE_2FA=true
ENABLE_API=true
ENABLE_WEBSOCKET=true
ENABLE_BACKUPS=true
ENABLE_MONITORING=true
ENABLE_MINECRAFT=true
ENABLE_RESELLER=true
ENABLE_BILLING=true
ENABLE_NOTIFICATIONS=true
EOF

chmod 600 "$ENV_FILE"

# ------------------------------------------------------------
# DOWNLOAD PANEL.JS
# ------------------------------------------------------------

log "Downloading ALOOZ panel backend..."

if curl -fsSL "$REPO_RAW/panel.js" -o "$PANEL_DIR/panel.js"; then
    ok "panel.js downloaded."
else
    warn "Could not download panel.js."
    warn "Create/upload panel.js to the repository first."
fi

# ------------------------------------------------------------
# PACKAGE.JSON
# ------------------------------------------------------------

cat > "$PANEL_DIR/package.json" <<'EOF'
{
  "name": "alooz-ultimate-max",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "start": "node panel.js"
  },
  "dependencies": {
    "express": "^5.1.0",
    "pg": "^8.16.3",
    "redis": "^5.8.2",
    "jsonwebtoken": "^9.0.2",
    "bcryptjs": "^3.0.2",
    "helmet": "^8.1.0",
    "cors": "^2.8.5",
    "multer": "^2.0.2",
    "ws": "^8.18.3",
    "uuid": "^11.1.0",
    "express-rate-limit": "^8.1.0",
    "archiver": "^7.0.1",
    "unzipper": "^0.12.3",
    "node-cron": "^4.2.1",
    "speakeasy": "^2.0.0"
  }
}
EOF

# ------------------------------------------------------------
# DOCKERFILE
# ------------------------------------------------------------

cat > "$PANEL_DIR/Dockerfile" <<'EOF'
FROM node:22-bookworm

ENV NODE_ENV=production

RUN apt-get update \
    && apt-get install -y \
       docker.io \
       procps \
       util-linux \
       curl \
       wget \
       unzip \
       zip \
       tar \
       gzip \
       bash \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./

RUN npm install --omit=dev

COPY panel.js ./

EXPOSE 3000

CMD ["node", "panel.js"]
EOF

# ------------------------------------------------------------
# DOCKER COMPOSE
# ------------------------------------------------------------

cat > "$COMPOSE_FILE" <<EOF
services:

  alooz-panel:
    build:
      context: ./panel
      dockerfile: Dockerfile

    container_name: alooz-panel
    restart: unless-stopped

    env_file:
      - .env

    environment:
      PANEL_PORT: 3000
      DATABASE_URL: postgresql://alooz:\${POSTGRES_PASSWORD}@alooz-db:5432/alooz
      REDIS_URL: redis://:\${REDIS_PASSWORD}@alooz-redis:6379

    ports:
      - "\${PANEL_PORT:-3000}:3000"

    volumes:
      - ./data:/opt/alooz/data
      - ./servers:/opt/alooz/servers
      - ./backups:/opt/alooz/backups
      - ./logs:/opt/alooz/logs
      - ./config:/opt/alooz/config

      # Docker control
      - /var/run/docker.sock:/var/run/docker.sock

    depends_on:
      alooz-db:
        condition: service_healthy
      alooz-redis:
        condition: service_healthy

    networks:
      - alooz-network

    healthcheck:
      test:
        [
          "CMD",
          "node",
          "-e",
          "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
        ]
      interval: 30s
      timeout: 10s
      retries: 5

  alooz-db:
    image: postgres:17-alpine

    container_name: alooz-db
    restart: unless-stopped

    environment:
      POSTGRES_DB: \${POSTGRES_DB}
      POSTGRES_USER: \${POSTGRES_USER}
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}

    volumes:
      - alooz-postgres:/var/lib/postgresql/data

    healthcheck:
      test:
        [
          "CMD-SHELL",
          "pg_isready -U \${POSTGRES_USER} -d \${POSTGRES_DB}"
        ]
      interval: 5s
      timeout: 5s
      retries: 20

    networks:
      - alooz-network

  alooz-redis:
    image: redis:7-alpine

    container_name: alooz-redis
    restart: unless-stopped

    command:
      - redis-server
      - --appendonly
      - yes
      - --requirepass
      - \${REDIS_PASSWORD}

    volumes:
      - alooz-redis:/data

    healthcheck:
      test:
        [
          "CMD",
          "redis-cli",
          "-a",
          "\${REDIS_PASSWORD}",
          "ping"
        ]
      interval: 5s
      timeout: 5s
      retries: 20

    networks:
      - alooz-network

networks:
  alooz-network:
    driver: bridge

volumes:
  alooz-postgres:
  alooz-redis:
EOF

# ------------------------------------------------------------
# DOCKER SOCKET CHECK
# ------------------------------------------------------------

if [ ! -S /var/run/docker.sock ]; then
    warn "Docker socket is not available."

    warn "The panel can still start, but Docker server management"
    warn "will not work until Docker socket is available."
fi

# ------------------------------------------------------------
# PANEL.JS CHECK
# ------------------------------------------------------------

if [ ! -f "$PANEL_DIR/panel.js" ]; then

    cat > "$PANEL_DIR/panel.js" <<'EOF'
import express from "express";

const app = express();

app.use(express.json());

app.get("/api/health", (req, res) => {
    res.json({
        status: "online",
        panel: "ALOOZ Ultimate MAX"
    });
});

app.get("/", (req, res) => {
    res.send(`
        <html>
        <head>
            <title>ALOOZ Ultimate MAX</title>
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <style>
                body {
                    background:#080b12;
                    color:#fff;
                    font-family:Arial;
                    padding:30px;
                }
                .box {
                    max-width:700px;
                    margin:auto;
                    padding:30px;
                    border-radius:20px;
                    background:#111827;
                }
            </style>
        </head>
        <body>
            <div class="box">
                <h1>ALOOZ Ultimate MAX</h1>
                <p>Panel is online.</p>
                <p>Upload the full panel.js to enable all features.</p>
            </div>
        </body>
        </html>
    `);
});

app.listen(process.env.PANEL_PORT || 3000, "0.0.0.0", () => {
    console.log("ALOOZ Ultimate MAX running.");
});
EOF

    warn "A temporary panel.js was created."
fi

# ------------------------------------------------------------
# BUILD
# ------------------------------------------------------------

log "Building ALOOZ Ultimate MAX..."

cd "$APP_DIR"

$COMPOSE_CMD --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    config >/dev/null

$COMPOSE_CMD --env-file "$ENV_FILE" \
    -f "$COMPOSE_FILE" \
    up -d --build

# ------------------------------------------------------------
# WAIT FOR PANEL
# ------------------------------------------------------------

log "Waiting for panel..."

READY=0

for i in $(seq 1 60); do

    if curl -fsS \
        "http://127.0.0.1:${PANEL_PORT}/api/health" \
        >/dev/null 2>&1; then

        READY=1
        break
    fi

    sleep 2
done

# ------------------------------------------------------------
# INSTALL UPDATE COMMAND
# ------------------------------------------------------------

cat > /usr/local/bin/alooz <<'EOF'
#!/usr/bin/env bash

APP_DIR="/opt/alooz"

case "${1:-}" in

    start)
        cd "$APP_DIR"
        docker compose up -d
        ;;

    stop)
        cd "$APP_DIR"
        docker compose stop
        ;;

    restart)
        cd "$APP_DIR"
        docker compose restart
        ;;

    status)
        cd "$APP_DIR"
        docker compose ps
        ;;

    logs)
        cd "$APP_DIR"
        docker compose logs -f --tail=200
        ;;

    update)
        cd "$APP_DIR"

        if [ -f "$APP_DIR/panel/panel.js" ]; then
            cp "$APP_DIR/panel/panel.js" \
               "$APP_DIR/panel/panel.js.backup"
        fi

        curl -fsSL \
          "https://raw.githubusercontent.com/SKPHDBOY/ALOOZ-VPS-Protector-Panel/main/panel.js" \
          -o "$APP_DIR/panel/panel.js"

        docker compose up -d --build
        ;;

    backup)
        mkdir -p "$APP_DIR/backups/manual"

        tar \
          --exclude="$APP_DIR/backups" \
          -czf \
          "$APP_DIR/backups/manual/alooz-$(date +%Y%m%d-%H%M%S).tar.gz" \
          "$APP_DIR/data" \
          "$APP_DIR/config"

        echo "Backup created."
        ;;

    uninstall)
        echo "This removes ALOOZ containers."
        read -r -p "Continue? [y/N] " ans

        if [[ "$ans" =~ ^[Yy]$ ]]; then
            cd "$APP_DIR"
            docker compose down
            echo "Containers stopped."
        fi
        ;;

    *)
        echo ""
        echo "ALOOZ Ultimate MAX CLI"
        echo ""
        echo "Usage:"
        echo "  alooz start"
        echo "  alooz stop"
        echo "  alooz restart"
        echo "  alooz status"
        echo "  alooz logs"
        echo "  alooz update"
        echo "  alooz backup"
        echo ""
        ;;

esac
EOF

chmod +x /usr/local/bin/alooz

# ------------------------------------------------------------
# SAVE INSTALL INFO
# ------------------------------------------------------------

cat > "$CONFIG_DIR/install-info.txt" <<EOF
============================================================
ALOOZ ULTIMATE MAX
============================================================

Installed: $(date)

Panel:
http://YOUR_SERVER_IP:${PANEL_PORT}

Admin Username:
admin

Admin Password:
${ADMIN_PASSWORD}

Panel Directory:
${APP_DIR}

Servers:
${SERVER_DIR}

Backups:
${BACKUP_DIR}

Database:
PostgreSQL

Cache:
Redis

Docker:
Enabled

============================================================
IMPORTANT
============================================================

Change the admin password after first login.

Keep this file private.

Docker socket access gives the panel powerful
control over the Docker host.

============================================================
CLI
============================================================

alooz status
alooz logs
alooz restart
alooz update
alooz backup

============================================================
EOF

chmod 600 "$CONFIG_DIR/install-info.txt"

# ------------------------------------------------------------
# FIREWALL INFORMATION
# ------------------------------------------------------------

if command -v ufw >/dev/null 2>&1; then

    warn "UFW detected."

    echo ""
    echo "If port ${PANEL_PORT} is blocked, run:"
    echo ""
    echo "ufw allow ${PANEL_PORT}/tcp"
    echo ""

fi

# ------------------------------------------------------------
# RESULT
# ------------------------------------------------------------

echo ""
echo "============================================================"
echo -e "${GREEN}       ALOOZ ULTIMATE MAX INSTALLED${NC}"
echo "============================================================"
echo ""

if [ "$READY" = "1" ]; then
    ok "Panel is ONLINE."
else
    warn "Panel did not answer yet."
    warn "Check: alooz logs"
fi

echo ""
echo -e "${CYAN}Panel:${NC}"
echo "http://YOUR_SERVER_IP:${PANEL_PORT}"
echo ""

echo -e "${CYAN}Username:${NC}"
echo "admin"
echo ""

echo -e "${CYAN}Password:${NC}"
echo "$ADMIN_PASSWORD"
echo ""

echo -e "${CYAN}Management:${NC}"
echo "alooz status"
echo "alooz logs"
echo "alooz restart"
echo "alooz update"
echo "alooz backup"
echo ""

echo -e "${YELLOW}Credentials saved at:${NC}"
echo "$CONFIG_DIR/install-info.txt"

echo ""
echo "============================================================"
echo -e "${GREEN}ALOOZ ULTIMATE MAX READY${NC}"
echo "============================================================"
