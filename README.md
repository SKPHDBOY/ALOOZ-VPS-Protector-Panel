# ALOOZ Hosting Panel v1

Responsive Minecraft hosting panel starter for mobile + desktop.

## Included
- Login/session authentication
- Dashboard
- Server list
- Start / Stop / Restart
- Console command endpoint
- Server create/delete
- Plugin upload/list/delete
- Minecraft version/software changer UI
- Automatic server backup before version change
- File manager API with path traversal protection
- Docker-based server runtime
- Paper/Purpur/Vanilla/Fabric/Forge/NeoForge software catalog
- Install script for Ubuntu/Debian

## Requirements
- Linux VPS
- Node.js 20+
- Docker
- Root or a user allowed to use Docker

## Install
```bash
chmod +x install.sh
sudo ./install.sh
```

Then open:
http://YOUR_VPS_IP:3000

Default credentials come from `.env`:
ADMIN_USER=admin
ADMIN_PASSWORD=change-this-password

Change the password before exposing the panel publicly.

## Important
This is an MVP/starter, not a production-ready public hosting platform. Put it behind HTTPS/reverse proxy, use a strong secret/password, and add a real database, CSRF protection, rate limiting, audit logs, and a separate node agent before selling hosting.
