/*
=========================================================
 ALOOZ PROTECTOR PANEL
 Advanced Docker VPS Management Panel
=========================================================
*/

"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const os = require("os");
const { execFile } = require("child_process");
const util = require("util");

const execFileAsync = util.promisify(execFile);

const app = express();

const PORT = Number(process.env.PORT || 3000);
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "CHANGE-ME";

const APP_DIR = process.env.APP_DIR || "/opt/alooz-protector";
const DATA_DIR = path.join(APP_DIR, "data");
const BACKUP_DIR = path.join(APP_DIR, "backups");
const FILE_ROOT = process.env.FILE_ROOT || "/";

const MAX_BODY = "10mb";

app.use(express.json({ limit: MAX_BODY }));
app.use(express.urlencoded({ extended: true, limit: MAX_BODY }));

/* ======================================================
   DIRECTORY SETUP
====================================================== */

for (const dir of [APP_DIR, DATA_DIR, BACKUP_DIR]) {
    try {
        fs.mkdirSync(dir, { recursive: true });
    } catch {}
}

/* ======================================================
   DATABASE-LIKE JSON STORAGE
====================================================== */

const DB_FILE = path.join(DATA_DIR, "panel.json");

function defaultDB() {
    return {
        users: [
            {
                id: "admin",
                username: ADMIN_USER,
                password: ADMIN_PASS,
                role: "admin",
                createdAt: Date.now()
            }
        ],

        servers: [],

        allocations: [],

        databases: [],

        backups: [],

        settings: {
            panelName: "ALOOZ Protector",
            version: "2.0.0",
            maintenance: false,
            allowRegistration: false
        }
    };
}

function loadDB() {
    try {
        if (!fs.existsSync(DB_FILE)) {
            const db = defaultDB();
            saveDB(db);
            return db;
        }

        const data = fs.readFileSync(DB_FILE, "utf8");

        return {
            ...defaultDB(),
            ...JSON.parse(data)
        };

    } catch {
        return defaultDB();
    }
}

function saveDB(db) {
    fs.writeFileSync(
        DB_FILE,
        JSON.stringify(db, null, 2),
        "utf8"
    );
}

let db = loadDB();

/* ======================================================
   SECURITY
====================================================== */

function safeCompare(a, b) {
    const aa = Buffer.from(String(a));
    const bb = Buffer.from(String(b));

    if (aa.length !== bb.length) {
        return false;
    }

    return crypto.timingSafeEqual(aa, bb);
}

function auth(req, res, next) {

    const header = req.headers.authorization || "";

    if (!header.startsWith("Basic ")) {

        res.setHeader(
            "WWW-Authenticate",
            'Basic realm="ALOOZ Protector"'
        );

        return res.status(401).send("Authentication required");
    }

    try {

        const decoded = Buffer
            .from(header.substring(6), "base64")
            .toString();

        const index = decoded.indexOf(":");

        if (index < 0) {
            return res.status(401).send("Invalid authentication");
        }

        const username = decoded.substring(0, index);
        const password = decoded.substring(index + 1);

        const user = db.users.find(
            x => x.username === username
        );

        if (!user) {
            return res.status(401).send("Invalid username or password");
        }

        if (!safeCompare(user.password, password)) {
            return res.status(401).send("Invalid username or password");
        }

        req.user = user;

        next();

    } catch {
        return res.status(401).send("Invalid authentication");
    }
}

function adminOnly(req, res, next) {

    if (!req.user || req.user.role !== "admin") {
        return res.status(403).json({
            error: "Admin permission required"
        });
    }

    next();
}

app.use(auth);

/* ======================================================
   DOCKER HELPER
====================================================== */

async function docker(args, options = {}) {

    const result = await execFileAsync(
        "docker",
        args,
        {
            timeout: options.timeout || 30000,
            maxBuffer: options.maxBuffer || 20 * 1024 * 1024
        }
    );

    return result.stdout;
}

async function dockerJSON(args) {

    const output = await docker(args);

    if (!output.trim()) {
        return [];
    }

    return output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map(line => {
            try {
                return JSON.parse(line);
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

/* ======================================================
   SYSTEM INFORMATION
====================================================== */

function getMemory() {

    try {

        const text =
            fs.readFileSync(
                "/proc/meminfo",
                "utf8"
            );

        const total =
            Number(
                (text.match(
                    /^MemTotal:\s+(\d+)/m
                ) || [0, 0])[1]
            );

        const available =
            Number(
                (text.match(
                    /^MemAvailable:\s+(\d+)/m
                ) || [0, 0])[1]
            );

        return {
            totalMB: Math.round(total / 1024),
            usedMB: Math.round(
                (total - available) / 1024
            ),
            freeMB: Math.round(
                available / 1024
            )
        };

    } catch {

        return {
            totalMB: 0,
            usedMB: 0,
            freeMB: 0
        };
    }
}

function getDisk() {

    try {

        const stat =
            fs.statfsSync("/");

        const total =
            Number(stat.blocks) *
            Number(stat.bsize);

        const free =
            Number(stat.bavail) *
            Number(stat.bsize);

        return {
            totalGB:
                (total / 1024 ** 3).toFixed(2),

            freeGB:
                (free / 1024 ** 3).toFixed(2),

            usedGB:
                ((total - free) / 1024 ** 3)
                    .toFixed(2)
        };

    } catch {

        return {
            totalGB: "0",
            freeGB: "0",
            usedGB: "0"
        };
    }
}

function systemInfo() {

    return {
        hostname: os.hostname(),

        platform: os.platform(),

        architecture: os.arch(),

        cpu: os.cpus().length,

        load: os.loadavg(),

        uptime:
            Math.floor(os.uptime()),

        memory: getMemory(),

        disk: getDisk()
    };
}

/* ======================================================
   DASHBOARD
====================================================== */

app.get("/api/dashboard", async (req, res) => {

    try {

        const containers =
            await dockerJSON([
                "ps",
                "-a",
                "--format",
                "{{json .}}"
            ]);

        const running =
            containers.filter(
                x =>
                    String(x.Status)
                        .toLowerCase()
                        .startsWith("up")
            ).length;

        res.json({

            success: true,

            system: systemInfo(),

            docker: {
                total: containers.length,
                running,
                stopped:
                    containers.length - running
            },

            users: db.users.length,

            databases:
                db.databases.length,

            backups:
                db.backups.length,

            allocations:
                db.allocations.length,

            settings: db.settings

        });

    } catch (error) {

        res.status(500).json({
            error: error.message
        });
    }
});

/* ======================================================
   DOCKER SERVERS
====================================================== */

app.get("/api/servers", async (req, res) => {

    try {

        const servers =
            await dockerJSON([
                "ps",
                "-a",
                "--format",
                "{{json .}}"
            ]);

        res.json({
            success: true,
            servers
        });

    } catch (error) {

        res.status(500).json({
            error: error.message
        });
    }
});

/* ======================================================
   SERVER INSPECT
====================================================== */

app.get(
    "/api/servers/:id",
    async (req, res) => {

        try {

            const result =
                await docker([
                    "inspect",
                    req.params.id
                ]);

            res.json({
                success: true,
                server: JSON.parse(result)[0]
            });

        } catch (error) {

            res.status(404).json({
                error: error.message
            });
        }
    }
);

/* ======================================================
   START / STOP / RESTART / PAUSE / UNPAUSE
====================================================== */

app.post(
    "/api/servers/:id/action",
    async (req, res) => {

        const allowed = [
            "start",
            "stop",
            "restart",
            "pause",
            "unpause",
            "kill"
        ];

        const action = req.body.action;

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
                success: true,
                action
            });

        } catch (error) {

            res.status(500).json({
                error: error.message
            });
        }
    }
);

/* ======================================================
   DELETE SERVER
====================================================== */

app.delete(
    "/api/servers/:id",
    adminOnly,
    async (req, res) => {

        try {

            await docker([
                "rm",
                "-f",
                req.params.id
            ]);

            db.servers =
                db.servers.filter(
                    x => x.id !== req.params.id
                );

            saveDB(db);

            res.json({
                success: true
            });

        } catch (error) {

            res.status(500).json({
                error: error.message
            });
        }
    }
);

/* ======================================================
   SERVER LOGS / CONSOLE
====================================================== */

app.get(
    "/api/servers/:id/logs",
    async (req, res) => {

        try {

            const tail =
                Math.min(
                    Math.max(
                        Number(req.query.lines || 300),
                        1
                    ),
                    2000
                );

            const output =
                await docker([
                    "logs",
                    "--tail",
                    String(tail),
                    req.params.id
                ]);

            res.type("text/plain");
            res.send(output);

        } catch (error) {

            res.status(500).send(
                error.message
            );
        }
    }
);

/* ======================================================
   EXEC COMMAND
====================================================== */

app.post(
    "/api/servers/:id/command",
    async (req, res) => {

        const command =
            String(req.body.command || "").trim();

        if (!command) {

            return res.status(400).json({
                error: "Command required"
            });
        }

        if (command.length > 2000) {

            return res.status(400).json({
                error: "Command too long"
            });
        }

        try {

            const output =
                await docker([
                    "exec",
                    req.params.id,
                    "sh",
                    "-lc",
                    command
                ]);

            res.json({
                success: true,
                output
            });

        } catch (error) {

            res.status(500).json({
                error: error.message
            });
        }
    }
);

/* ======================================================
   SERVER STATS
====================================================== */

app.get(
    "/api/servers/:id/stats",
    async (req, res) => {

        try {

            const output =
                await docker([
                    "stats",
                    "--no-stream",
                    "--format",
                    "{{json .}}",
                    req.params.id
                ]);

            res.json({
                success: true,
                stats:
                    JSON.parse(output)
            });

        } catch (error) {

            res.status(500).json({
                error: error.message
            });
        }
    }
);

/* ======================================================
   CREATE SERVER
====================================================== */

app.post(
    "/api/servers",
    adminOnly,
    async (req, res) => {

        try {

            const name =
                String(
                    req.body.name || ""
                )
                .trim()
                .replace(/[^a-zA-Z0-9_.-]/g, "-");

            const image =
                String(
                    req.body.image ||
                    "ubuntu:22.04"
                ).trim();

            const memory =
                Number(
                    req.body.memory || 0
                );

            const cpus =
                Number(
                    req.body.cpus || 0
                );

            const ports =
                Array.isArray(req.body.ports)
                    ? req.body.ports
                    : [];

            if (!name) {

                return res.status(400).json({
                    error: "Server name required"
                });
            }

            const args = [
                "run",
                "-d",
                "--name",
                name,
                "--restart",
                "unless-stopped"
            ];

            if (memory > 0) {

                args.push(
                    "--memory",
                    `${memory}m`
                );
            }

            if (cpus > 0) {

                args.push(
                    "--cpus",
                    String(cpus)
                );
            }

            for (const p of ports) {

                if (
                    typeof p === "string" &&
                    /^[0-9]+:[0-9]+$/.test(p)
                ) {

                    args.push(
                        "-p",
                        p
                    );
                }
            }

            args.push(
                image,
                "sleep",
                "infinity"
            );

            const id =
                (await docker(args)).trim();

            db.servers.push({
                id,
                name,
                image,
                memory,
                cpus,
                createdAt: Date.now()
            });

            saveDB(db);

            res.json({
                success: true,
                id,
                name
            });

        } catch (error) {

            res.status(500).json({
                error: error.message
            });
        }
    }
);

/* ======================================================
   RESOURCE LIMITS
====================================================== */

app.post(
    "/api/servers/:id/resources",
    adminOnly,
    async (req, res) => {

        try {

            const memory =
                Number(
                    req.body.memory || 0
                );

            const cpus =
                Number(
                    req.body.cpus || 0
                );

            const args = [
                "update"
            ];

            if (memory > 0) {

                args.push(
                    "--memory",
                    `${memory}m`
                );
            }

            if (cpus > 0) {

                args.push(
                    "--cpus",
                    String(cpus)
                );
            }

            args.push(
                req.params.id
            );

            await docker(args);

            res.json({
                success: true
            });

        } catch (error) {

            res.status(500).json({
                error: error.message
            });
        }
    }
);

/* ======================================================
   FILE MANAGER
====================================================== */

function safePath(input) {

    let requested =
        String(input || "/");

    if (!requested.startsWith("/")) {
        requested = "/" + requested;
    }

    const normalized =
        path.normalize(requested);

    const root =
        path.resolve(FILE_ROOT);

    const target =
        path.resolve(
            root,
            "." + normalized
        );

    if (
        target !== root &&
        !target.startsWith(root + path.sep)
    ) {
        throw new Error(
            "Invalid path"
        );
    }

    return target;
}

app.get(
    "/api/files",
    async (req, res) => {

        try {

            const target =
                safePath(req.query.path || "/");

            const entries =
                fs.readdirSync(
                    target,
                    { withFileTypes: true }
                );

            res.json({
                success: true,
                path: target,
                files: entries.map(x => {

                    let size = 0;

                    try {

                        if (x.isFile()) {

                            size =
                                fs.statSync(
                                    path.join(
                                        target,
                                        x.name
                                    )
                                ).size;
                        }

                    } catch {}

                    return {
                        name: x.name,
                        directory: x.isDirectory(),
                        size
                    };
                })
            });

        } catch (error) {

            res.status(400).json({
                error: error.message
            });
        }
    }
);

/* ======================================================
   READ FILE
====================================================== */

app.get(
    "/api/files/read",
    async (req, res) => {

        try {

            const target =
                safePath(req.query.path);

            const stat =
                fs.statSync(target);

            if (!stat.isFile()) {

                return res.status(400).json({
                    error: "Not a file"
                });
            }

            if (stat.size > 5 * 1024 * 1024) {

                return res.status(400).json({
                    error: "File too large"
                });
            }

            res.json({
                success: true,
                path: target,
                content:
                    fs.readFileSync(
                        target,
                        "utf8"
                    )
            });

        } catch (error) {

            res.status(400).json({
                error: error.message
            });
        }
    }
);

/* ======================================================
   WRITE FILE
====================================================== */

app.post(
    "/api/files/write",
    async (req, res) => {

        try {

            const target =
                safePath(req.body.path);

            const content =
                String(
                    req.body.content || ""
                );

            fs.mkdirSync(
                path.dirname(target),
                { recursive: true }
            );

            fs.writeFileSync(
                target,
                content,
                "utf8"
            );

            res.json({
                success: true
            });

        } catch (error) {

            res.status(400).json({
                error: error.message
            });
        }
    }
);

/* ======================================================
   CREATE DIRECTORY
====================================================== */

app.post(
    "/api/files/mkdir",
    async (req, res) => {

        try {

            const target =
                safePath(req.body.path);

            fs.mkdirSync(
                target,
                { recursive: true }
            );

            res.json({
                success: true
            });

        } catch (error) {

            res.status(400).json({
                error: error.message
            });
        }
    }
);

/* ======================================================
   DELETE FILE/FOLDER
====================================================== */

app.delete(
    "/api/files",
    async (req, res) => {

        try {

            const target =
                safePath(req.query.path);

            if (target === path.resolve(FILE_ROOT)) {

                return res.status(400).json({
                    error: "Cannot delete root"
                });
            }

            fs.rmSync(
                target,
                {
                    recursive: true,
                    force: true
                }
            );

            res.json({
                success: true
            });

        } catch (error) {

            res.status(400).json({
                error: error.message
            });
        }
    }
);

/* ======================================================
   USERS
====================================================== */

app.get(
    "/api/users",
    adminOnly,
    (req, res) => {

        res.json({
            success: true,

            users:
                db.users.map(
                    ({
                        password,
                        ...user
                    }) => user
                )
        });
    }
);

/* ======================================================
   CREATE USER
====================================================== */

app.post(
    "/api/users",
    adminOnly,
    (req, res) => {

        const username =
            String(
                req.body.username || ""
            ).trim();

        const password =
            String(
                req.body.password || ""
            );

        const role =
            req.body.role === "admin"
                ? "admin"
                : "user";

        if (
            !username ||
            password.length < 6
        ) {

            return res.status(400).json({
                error:
                    "Username and 6+ character password required"
            });
        }

        if (
            db.users.some(
                x => x.username === username
            )
        ) {

            return res.status(409).json({
                error: "User already exists"
            });
        }

        const user = {

            id:
                crypto.randomUUID(),

            username,

            password,

            role,

            createdAt:
                Date.now()
        };

        db.users.push(user);

        saveDB(db);

        res.json({
            success: true,
            user: {
                id: user.id,
                username,
                role
            }
        });
    }
);

/* ======================================================
   DELETE USER
====================================================== */

app.delete(
    "/api/users/:id",
    adminOnly,
    (req, res) => {

        if (req.params.id === "admin") {

            return res.status(400).json({
                error: "Default admin cannot be removed"
            });
        }

        db.users =
            db.users.filter(
                x => x.id !== req.params.id
            );

        saveDB(db);

        res.json({
            success: true
        });
    }
);

/* ======================================================
   ALLOCATIONS
====================================================== */

app.get(
    "/api/allocations",
    (req, res) => {

        res.json({
            success: true,
            allocations:
                db.allocations
        });
    }
);

app.post(
    "/api/allocations",
    adminOnly,
    (req, res) => {

        const ip =
            String(
                req.body.ip || "0.0.0.0"
            );

        const port =
            Number(req.body.port);

        if (
            !Number.isInteger(port) ||
            port < 1 ||
            port > 65535
        ) {

            return res.status(400).json({
                error: "Invalid port"
            });
        }

        const allocation = {

            id:
                crypto.randomUUID(),

            ip,

            port,

            assignedTo:
                null,

            createdAt:
                Date.now()
        };

        db.allocations.push(
            allocation
        );

        saveDB(db);

        res.json({
            success: true,
            allocation
        });
    }
);

/* ======================================================
   DELETE ALLOCATION
====================================================== */

app.delete(
    "/api/allocations/:id",
    adminOnly,
    (req, res) => {

        db.allocations =
            db.allocations.filter(
                x => x.id !== req.params.id
            );

        saveDB(db);

        res.json({
            success: true
        });
    }
);

/* ======================================================
   DATABASE MANAGEMENT
====================================================== */

app.get(
    "/api/databases",
    adminOnly,
    (req, res) => {

        res.json({
            success: true,
            databases:
                db.databases
        });
    }
);

app.post(
    "/api/databases",
    adminOnly,
    (req, res) => {

        const database = {

            id:
                crypto.randomUUID(),

            name:
                String(
                    req.body.name ||
                    "database"
                ),

            type:
                String(
                    req.body.type ||
                    "mysql"
                ),

            host:
                String(
                    req.body.host ||
                    "localhost"
                ),

            port:
                Number(
                    req.body.port ||
                    3306
                ),

            username:
                String(
                    req.body.username ||
                    "root"
                ),

            password:
                String(
                    req.body.password ||
                    ""
                ),

            createdAt:
                Date.now()
        };

        db.databases.push(
            database
        );

        saveDB(db);

        res.json({
            success: true,
            database
        });
    }
);

/* ======================================================
   DELETE DATABASE RECORD
====================================================== */

app.delete(
    "/api/databases/:id",
    adminOnly,
    (req, res) => {

        db.databases =
            db.databases.filter(
                x => x.id !== req.params.id
            );

        saveDB(db);

        res.json({
            success: true
        });
    }
);

/* ======================================================
   BACKUPS
====================================================== */

app.get(
    "/api/backups",
    (req, res) => {

        res.json({
            success: true,
            backups:
                db.backups
        });
    }
);

/* ======================================================
   CREATE CONTAINER BACKUP
====================================================== */

app.post(
    "/api/servers/:id/backups",
    adminOnly,
    async (req, res) => {

        try {

            const name =
                `${req.params.id}-${Date.now()}.tar`;

            const destination =
                path.join(
                    BACKUP_DIR,
                    name
                );

            await docker([
                "export",
                "-o",
                destination,
                req.params.id
            ], {
                timeout: 120000
            });

            const stat =
                fs.statSync(destination);

            const backup = {

                id:
                    crypto.randomUUID(),

                server:
                    req.params.id,

                file:
                    destination,

                size:
                    stat.size,

                createdAt:
                    Date.now()
            };

            db.backups.push(
                backup
            );

            saveDB(db);

            res.json({
                success: true,
                backup
            });

        } catch (error) {

            res.status(500).json({
                error: error.message
            });
        }
    }
);

/* ======================================================
   DELETE BACKUP
====================================================== */

app.delete(
    "/api/backups/:id",
    adminOnly,
    (req, res) => {

        const backup =
            db.backups.find(
                x => x.id === req.params.id
            );

        if (!backup) {

            return res.status(404).json({
                error: "Backup not found"
            });
        }

        try {

            if (fs.existsSync(backup.file)) {
                fs.unlinkSync(backup.file);
            }

        } catch {}

        db.backups =
            db.backups.filter(
                x => x.id !== req.params.id
            );

        saveDB(db);

        res.json({
            success: true
        });
    }
);

/* ======================================================
   ADMIN SETTINGS
====================================================== */

app.get(
    "/api/settings",
    adminOnly,
    (req, res) => {

        res.json({
            success: true,
            settings:
                db.settings
        });
    }
);

app.post(
    "/api/settings",
    adminOnly,
    (req, res) => {

        if (
            typeof req.body.panelName ===
            "string"
        ) {

            db.settings.panelName =
                req.body.panelName;
        }

        if (
            typeof req.body.maintenance ===
            "boolean"
        ) {

            db.settings.maintenance =
                req.body.maintenance;
        }

        if (
            typeof req.body.allowRegistration ===
            "boolean"
        ) {

            db.settings.allowRegistration =
                req.body.allowRegistration;
        }

        saveDB(db);

        res.json({
            success: true,
            settings:
                db.settings
        });
    }
);

/* ======================================================
   HEALTH
====================================================== */

app.get(
    "/api/health",
    async (req, res) => {

        try {

            await docker([
                "info"
            ]);

            res.json({
                status: "online",
                docker: "online",
                uptime: os.uptime()
            });

        } catch {

            res.status(503).json({
                status: "online",
                docker: "offline"
            });
        }
    }
);

/* ======================================================
   PANEL HTML
====================================================== */

app.get("/", (req, res) => {

res.send(`

<!DOCTYPE html>

<html>

<head>

<meta charset="UTF-8">

<meta
name="viewport"
content="width=device-width,initial-scale=1"
>

<title>${escapeHTML(
    db.settings.panelName
)}</title>

<style>

*{
box-sizing:border-box;
}

body{
margin:0;
font-family:Arial,Helvetica,sans-serif;
background:#080b12;
color:#fff;
}

header{
padding:20px;
background:#101624;
border-bottom:1px solid #252d3d;
position:sticky;
top:0;
z-index:5;
}

header h1{
margin:0;
font-size:22px;
}

.container{
padding:20px;
max-width:1400px;
margin:auto;
}

.grid{
display:grid;
grid-template-columns:
repeat(auto-fit,minmax(190px,1fr));
gap:15px;
}

.card{
background:#111827;
border:1px solid #263044;
border-radius:14px;
padding:18px;
margin-bottom:15px;
}

.stat{
font-size:28px;
font-weight:bold;
margin-top:8px;
}

button{
border:0;
border-radius:8px;
padding:9px 13px;
margin:3px;
cursor:pointer;
background:#273449;
color:#fff;
}

button:hover{
opacity:.85;
}

input,select,textarea{
width:100%;
background:#080d17;
border:1px solid #2c374d;
border-radius:8px;
padding:10px;
color:#fff;
margin:5px 0 10px;
}

textarea{
min-height:150px;
resize:vertical;
}

pre{
background:#05070c;
padding:15px;
border-radius:10px;
overflow:auto;
min-height:180px;
white-space:pre-wrap;
}

.server{
padding:15px;
border:1px solid #29344a;
border-radius:12px;
margin-bottom:10px;
background:#0c1220;
}

.online{
color:#7CFC98;
}

.offline{
color:#ff7777;
}

.nav{
display:flex;
gap:8px;
flex-wrap:wrap;
margin-bottom:15px;
}

.nav button{
background:#182235;
}

.hidden{
display:none;
}

.small{
opacity:.7;
font-size:13px;
}

table{
width:100%;
border-collapse:collapse;
}

td,th{
padding:10px;
border-bottom:1px solid #263044;
text-align:left;
}

</style>

</head>

<body>

<header>

<h1>🛡️ ALOOZ Protector Panel</h1>

<div class="small">
Advanced VPS / Docker Management
</div>

</header>

<div class="container">

<div class="nav">

<button onclick="show('dashboard')">
📊 Dashboard
</button>

<button onclick="show('servers')">
🖥️ Servers
</button>

<button onclick="show('files')">
📁 Files
</button>

<button onclick="show('backups')">
💾 Backups
</button>

<button onclick="show('users')">
👥 Users
</button>

<button onclick="show('databases')">
🗄️ Databases
</button>

<button onclick="show('allocations')">
🌐 Allocations
</button>

<button onclick="show('settings')">
⚙️ Settings
</button>

</div>

<section id="dashboard">

<div class="grid">

<div class="card">
CPU
<div class="stat" id="cpu">-</div>
</div>

<div class="card">
RAM
<div class="stat" id="ram">-</div>
</div>

<div class="card">
DISK
<div class="stat" id="disk">-</div>
</div>

<div class="card">
SERVERS
<div class="stat" id="serversCount">-</div>
</div>

</div>

<div class="card">

<h2>System</h2>

<pre id="system">Loading...</pre>

</div>

</section>

<section id="servers"
class="hidden">

<div class="card">

<h2>🖥️ Server Management</h2>

<input id="newName"
placeholder="Server name">

<input id="newImage"
value="ubuntu:22.04"
placeholder="Docker image">

<input id="newMemory"
type="number"
placeholder="RAM MB">

<input id="newCpu"
type="number"
step="0.1"
placeholder="CPU cores">

<input id="newPorts"
placeholder="Example: 25565:25565">

<button onclick="createServer()">
➕ Create Server
</button>

</div>

<div id="serverList"></div>

<div class="card">

<h2>📜 Console</h2>

<pre id="console">
Select Logs or Command
</pre>

<input
id="command"
placeholder="Command">

<button onclick="sendCommand()">
▶ Execute
</button>

</div>

</section>

<section id="files"
class="hidden">

<div class="card">

<h2>📁 File Manager</h2>

<input
id="filePath"
value="/"
placeholder="/path">

<button onclick="loadFiles()">
🔄 Refresh
</button>

<button onclick="mkdirFile()">
📂 New Folder
</button>

</div>

<div id="filesList"></div>

<div class="card">

<h3>✏️ File Editor</h3>

<input id="editPath">

<textarea id="editor"></textarea>

<button onclick="saveFile()">
💾 Save
</button>

</div>

</section>

<section id="backups"
class="hidden">

<div class="card">

<h2>💾 Backups</h2>

<p>
Create backups from the server list.
</p>

</div>

<div id="backupList"></div>

</section>

<section id="users"
class="hidden">

<div class="card">

<h2>👥 Users</h2>

<input
id="username"
placeholder="Username">

<input
id="password"
placeholder="Password"
type="password">

<select id="role">

<option value="user">
User
</option>

<option value="admin">
Admin
</option>

</select>

<button onclick="createUser()">
➕ Create User
</button>

</div>

<div id="userList"></div>

</section>

<section id="databases"
class="hidden">

<div class="card">

<h2>🗄️ Database Records</h2>

<input
id="dbName"
placeholder="Database name">

<input
id="dbHost"
placeholder="Host">

<input
id="dbPort"
type="number"
value="3306">

<input
id="dbUser"
placeholder="Username">

<input
id="dbPass"
placeholder="Password">

<button onclick="createDatabase()">
➕ Add Database
</button>

</div>

<div id="databaseList"></div>

</section>

<section id="allocations"
class="hidden">

<div class="card">

<h2>🌐 Allocations</h2>

<input
id="allocationIP"
value="0.0.0.0"
placeholder="IP">

<input
id="allocationPort"
type="number"
placeholder="Port">

<button onclick="createAllocation()">
➕ Add Allocation
</button>

</div>

<div id="allocationList"></div>

</section>

<section id="settings"
class="hidden">

<div class="card">

<h2>⚙️ Admin Settings</h2>

<input
id="panelName"
placeholder="Panel Name">

<label>
Maintenance
</label>

<select id="maintenance">

<option value="false">
Disabled
</option>

<option value="true">
Enabled
</option>

</select>

<label>
Registration
</label>

<select id="registration">

<option value="false">
Disabled
</option>

<option value="true">
Enabled
</option>

</select>

<button onclick="saveSettings()">
💾 Save Settings
</button>

</div>

</section>

</div>

<script>

let selectedServer = null;

async function api(url, options={}){

    const response =
        await fetch(url, options);

    const text =
        await response.text();

    let data;

    try{
        data = JSON.parse(text);
    }catch{
        data = text;
    }

    if(!response.ok){

        throw new Error(
            typeof data === "string"
                ? data
                : data.error || "Request failed"
        );
    }

    return data;
}

function show(id){

    document
        .querySelectorAll("section")
        .forEach(x =>
            x.classList.add("hidden")
        );

    document
        .getElementById(id)
        .classList.remove("hidden");

    if(id === "dashboard")
        loadDashboard();

    if(id === "servers")
        loadServers();

    if(id === "files")
        loadFiles();

    if(id === "backups")
        loadBackups();

    if(id === "users")
        loadUsers();

    if(id === "databases")
        loadDatabases();

    if(id === "allocations")
        loadAllocations();

    if(id === "settings")
        loadSettings();
}

async function loadDashboard(){

    try{

        const d =
            await api("/api/dashboard");

        document.getElementById("cpu")
            .textContent =
            d.system.cpu + " cores";

        document.getElementById("ram")
            .textContent =
            d.system.memory.usedMB +
            " / " +
            d.system.memory.totalMB +
            " MB";

        document.getElementById("disk")
            .textContent =
            d.system.disk.freeGB +
            " GB free";

        document.getElementById("serversCount")
            .textContent =
            d.docker.running +
            " / " +
            d.docker.total;

        document.getElementById("system")
            .textContent =
JSON.stringify(d,null,2);

    }catch(e){

        document.getElementById("system")
            .textContent =
            e.message;
    }
}

async function loadServers(){

    const box =
        document.getElementById("serverList");

    try{

        const data =
            await api("/api/servers");

        if(!data.servers.length){

            box.innerHTML =
                '<div class="card">No servers found.</div>';

            return;
        }

        box.innerHTML =
            data.servers.map(s => {

                const status =
                    String(s.Status || "");

                const online =
                    status
                    .toLowerCase()
                    .startsWith("up");

                return \`
<div class="server">

<h3>
🖥️ \${escapeHTML(s.Names)}
</h3>

<div>
Status:
<span class="\${online ? "online" : "offline"}">
\${escapeHTML(status)}
</span>
</div>

<div class="small">
ID: \${escapeHTML(s.ID)}
</div>

<button onclick="serverAction(
'\${s.ID}',
'start'
)">
▶ Start
</button>

<button onclick="serverAction(
'\${s.ID}',
'stop'
)">
⏹ Stop
</button>

<button onclick="serverAction(
'\${s.ID}',
'restart'
)">
🔄 Restart
</button>

<button onclick="serverLogs(
'\${s.ID}'
)">
📜 Logs
</button>

<button onclick="serverStats(
'\${s.ID}'
)">
📊 Stats
</button>

<button onclick="backupServer(
'\${s.ID}'
)">
💾 Backup
</button>

<button onclick="selectServer(
'\${s.ID}'
)">
🎮 Console
</button>

<button onclick="deleteServer(
'\${s.ID}'
)">
🗑 Delete
</button>

</div>
\`;

            }).join("");

    }catch(e){

        box.innerHTML =
            '<div class="card">' +
            escapeHTML(e.message) +
            '</div>';
    }
}

async function serverAction(id, action){

    try{

        await api(
            "/api/servers/" +
            encodeURIComponent(id) +
            "/action",
            {
                method:"POST",
                headers:{
                    "Content-Type":
                        "application/json"
                },
                body:JSON.stringify({
                    action
                })
            }
        );

        loadServers();

    }catch(e){

        alert(e.message);
    }
}

async function serverLogs(id){

    selectedServer = id;

    try{

        const response =
            await fetch(
                "/api/servers/" +
                encodeURIComponent(id) +
                "/logs"
            );

        document.getElementById("console")
            .textContent =
            await response.text();

    }catch(e){

        alert(e.message);
    }
}

async function serverStats(id){

    try{

        const d =
            await api(
                "/api/servers/" +
                encodeURIComponent(id) +
                "/stats"
            );

        document.getElementById("console")
            .textContent =
            JSON.stringify(
                d,
                null,
                2
            );

    }catch(e){

        alert(e.message);
    }
}

function selectServer(id){

    selectedServer = id;

    alert(
        "Server selected for console."
    );
}

async function sendCommand(){

    if(!selectedServer){

        alert(
            "Select a server first."
        );

        return;
    }

    const command =
        document.getElementById(
            "command"
        ).value;

    try{

        const d =
            await api(
                "/api/servers/" +
                encodeURIComponent(
                    selectedServer
                ) +
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

        document.getElementById(
            "console"
        ).textContent =
            d.output || "Done";

    }catch(e){

        document.getElementById(
            "console"
        ).textContent =
            e.message;
    }
}

async function createServer(){

    const name =
        document.getElementById(
            "newName"
        ).value;

    const image =
        document.getElementById(
            "newImage"
        ).value;

    const memory =
        Number(
            document.getElementById(
                "newMemory"
            ).value || 0
        );

    const cpus =
        Number(
            document.getElementById(
                "newCpu"
            ).value || 0
        );

    const port =
        document.getElementById(
            "newPorts"
        ).value;

    try{

        await api(
            "/api/servers",
            {
                method:"POST",
                headers:{
                    "Content-Type":
                        "application/json"
                },
                body:JSON.stringify({
                    name,
                    image,
                    memory,
                    cpus,
                    ports:
                        port
                        ? [port]
                        : []
                })
            }
        );

        loadServers();

    }catch(e){

        alert(e.message);
    }
}

async function deleteServer(id){

    if(
        !confirm(
            "Delete this server?"
        )
    ) return;

    try{

        await api(
            "/api/servers/" +
            encodeURIComponent(id),
            {
                method:"DELETE"
            }
        );

        loadServers();

    }catch(e){

        alert(e.message);
    }
}

async function backupServer(id){

    if(
        !confirm(
            "Create backup?"
        )
    ) return;

    try{

        await api(
            "/api/servers/" +
            encodeURIComponent(id) +
            "/backups",
            {
                method:"POST"
            }
        );

        alert(
            "Backup created."
        );

        loadBackups();

    }catch(e){

        alert(e.message);
    }
}

async function loadFiles(){

    const p =
        document.getElementById(
            "filePath"
        ).value || "/";

    try{

        const d =
            await api(
                "/api/files?path=" +
                encodeURIComponent(p)
            );

        const box =
            document.getElementById(
                "filesList"
            );

        box.innerHTML =
            '<div class="card">' +
            d.files.map(f => \`

<div style="padding:8px;border-bottom:1px solid #263044">

\${f.directory ? "📁" : "📄"}

<b>
\${escapeHTML(f.name)}
</b>

\${f.directory
? ""
: "<span class='small'> " +
  f.size +
  " bytes</span>"
}

<button onclick="openFile(
'\${escapeJS(
    p.replace(/\\/$/,"") +
    "/" +
    f.name
)}'
)">
Open
</button>

<button onclick="deleteFile(
'\${escapeJS(
    p.replace(/\\/$/,"") +
    "/" +
    f.name
)}'
)">
Delete
</button>

</div>

\`).join("") +
            "</div>";

    }catch(e){

        alert(e.message);
    }
}

async function openFile(p){

    try{

        const d =
            await api(
                "/api/files/read?path=" +
                encodeURIComponent(p)
            );

        document.getElementById(
            "editPath"
        ).value = p;

        document.getElementById(
            "editor"
        ).value =
            d.content;

    }catch(e){

        alert(e.message);
    }
}

async function saveFile(){

    const p =
        document.getElementById(
            "editPath"
        ).value;

    const content =
        document.getElementById(
            "editor"
        ).value;

    try{

        await api(
            "/api/files/write",
            {
                method:"POST",
                headers:{
                    "Content-Type":
                        "application/json"
                },
                body:JSON.stringify({
                    path:p,
                    content
                })
            }
        );

        alert("Saved.");

    }catch(e){

        alert(e.message);
    }
}

async function deleteFile(p){

    if(
        !confirm(
            "Delete this file/folder?"
        )
    ) return;

    try{

        await api(
            "/api/files?path=" +
            encodeURIComponent(p),
            {
                method:"DELETE"
            }
        );

        loadFiles();

    }catch(e){

        alert(e.message);
    }
}

async function mkdirFile(){

    const name =
        prompt(
            "Folder path/name:"
        );

    if(!name) return;

    try{

        await api(
            "/api/files/mkdir",
            {
                method:"POST",
                headers:{
                    "Content-Type":
                        "application/json"
                },
                body:JSON.stringify({
                    path:name
                })
            }
        );

        loadFiles();

    }catch(e){

        alert(e.message);
    }
}

async function loadBackups(){

    const d =
        await api(
            "/api/backups"
        );

    const box =
        document.getElementById(
            "backupList"
        );

    box.innerHTML =
        '<div class="card">' +
        (d.backups.length
        ? d.backups.map(b => \`

<div style="padding:10px;border-bottom:1px solid #263044">

💾
<b>
\${escapeHTML(b.file)}
</b>

<br>

<span class="small">
Server: \${escapeHTML(b.server)}
<br>
Size: \${b.size} bytes
</span>

<button onclick="deleteBackup(
'\${b.id}'
)">
Delete
</button>

</div>

\`).join("")
        : "No backups") +
        "</div>";
}

async function deleteBackup(id){

    if(
        !confirm(
            "Delete backup?"
        )
    ) return;

    await api(
        "/api/backups/" +
        encodeURIComponent(id),
        {
            method:"DELETE"
        }
    );

    loadBackups();
}

async function loadUsers(){

    try{

        const d =
            await api(
                "/api/users"
            );

        const box =
            document.getElementById(
                "userList"
            );

        box.innerHTML =
            '<div class="card">' +
            d.users.map(u => \`

<div style="padding:10px;border-bottom:1px solid #263044">

👤
<b>\${escapeHTML(u.username)}</b>

<span class="small">
(\${escapeHTML(u.role)})
</span>

<button onclick="deleteUser(
'\${u.id}'
)">
Delete
</button>

</div>

\`).join("") +
            "</div>";

    }catch(e){

        alert(e.message);
    }
}

async function createUser(){

    try{

        await api(
            "/api/users",
            {
                method:"POST",
                headers:{
                    "Content-Type":
                        "application/json"
                },
                body:JSON.stringify({

                    username:
                        document.getElementById(
                            "username"
                        ).value,

                    password:
                        document.getElementById(
                            "password"
                        ).value,

                    role:
                        document.getElementById(
                            "role"
                        ).value
                })
            }
        );

        loadUsers();

    }catch(e){

        alert(e.message);
    }
}

async function deleteUser(id){

    if(
        !confirm(
            "Delete user?"
        )
    ) return;

    try{

        await api(
            "/api/users/" +
            encodeURIComponent(id),
            {
                method:"DELETE"
            }
        );

        loadUsers();

    }catch(e){

        alert(e.message);
    }
}

async function loadDatabases(){

    const d =
        await api(
            "/api/databases"
        );

    const box =
        document.getElementById(
            "databaseList"
        );

    box.innerHTML =
        '<div class="card">' +
        (d.databases.length
        ? d.databases.map(x => \`

<div style="padding:10px;border-bottom:1px solid #263044">

🗄️
<b>\${escapeHTML(x.name)}</b>

<br>

Host:
\${escapeHTML(x.host)}:\${x.port}

<br>

User:
\${escapeHTML(x.username)}

<button onclick="deleteDatabase(
'\${x.id}'
)">
Delete
</button>

</div>

\`).join("")
        : "No databases") +
        "</div>";
}

async function createDatabase(){

    try{

        await api(
            "/api/databases",
            {
                method:"POST",
                headers:{
                    "Content-Type":
                        "application/json"
                },
                body:JSON.stringify({

                    name:
                        document.getElementById(
                            "dbName"
                        ).value,

                    host:
                        document.getElementById(
                            "dbHost"
                        ).value,

                    port:
                        Number(
                            document.getElementById(
                                "dbPort"
                            ).value
                        ),

                    username:
                        document.getElementById(
                            "dbUser"
                        ).value,

                    password:
                        document.getElementById(
                            "dbPass"
                        ).value
                })
            }
        );

        loadDatabases();

    }catch(e){

        alert(e.message);
    }
}

async function deleteDatabase(id){

    if(
        !confirm(
            "Delete database record?"
        )
    ) return;

    await api(
        "/api/databases/" +
        encodeURIComponent(id),
        {
            method:"DELETE"
        }
    );

    loadDatabases();
}

async function loadAllocations(){

    const d =
        await api(
            "/api/allocations"
        );

    const box =
        document.getElementById(
            "allocationList"
        );

    box.innerHTML =
        '<div class="card">' +
        (d.allocations.length
        ? d.allocations.map(x => \`

<div style="padding:10px;border-bottom:1px solid #263044">

🌐
<b>
\${escapeHTML(x.ip)}:\${x.port}
</b>

<button onclick="deleteAllocation(
'\${x.id}'
)">
Delete
</button>

</div>

\`).join("")
        : "No allocations") +
        "</div>";
}

async function createAllocation(){

    try{

        await api(
            "/api/allocations",
            {
                method:"POST",
                headers:{
                    "Content-Type":
                        "application/json"
                },
                body:JSON.stringify({

                    ip:
                        document.getElementById(
                            "allocationIP"
                        ).value,

                    port:
                        Number(
                            document.getElementById(
                                "allocationPort"
                            ).value
                        )
                })
            }
        );

        loadAllocations();

    }catch(e){

        alert(e.message);
    }
}

async function deleteAllocation(id){

    if(
        !confirm(
            "Delete allocation?"
        )
    ) return;

    await api(
        "/api/allocations/" +
        encodeURIComponent(id),
        {
            method:"DELETE"
        }
    );

    loadAllocations();
}

async function loadSettings(){

    try{

        const d =
            await api(
                "/api/settings"
            );

        document.getElementById(
            "panelName"
        ).value =
            d.settings.panelName;

        document.getElementById(
            "maintenance"
        ).value =
            String(
                d.settings.maintenance
            );

        document.getElementById(
            "registration"
        ).value =
            String(
                d.settings.allowRegistration
            );

    }catch(e){

        alert(e.message);
    }
}

async function saveSettings(){

    try{

        await api(
            "/api/settings",
            {
                method:"POST",
                headers:{
                    "Content-Type":
                        "application/json"
                },
                body:JSON.stringify({

                    panelName:
                        document.getElementById(
                            "panelName"
                        ).value,

                    maintenance:
                        document.getElementById(
                            "maintenance"
                        ).value === "true",

                    allowRegistration:
                        document.getElementById(
                            "registration"
                        ).value === "true"
                })
            }
        );

        alert(
            "Settings saved. Refresh panel."
        );

    }catch(e){

        alert(e.message);
    }
}

function escapeHTML(value){

    return String(value)
        .replace(/&/g,"&amp;")
        .replace(/</g,"&lt;")
        .replace(/>/g,"&gt;")
        .replace(/"/g,"&quot;")
        .replace(/'/g,"&#039;");
}

function escapeJS(value){

    return String(value)
        .replace(/\\\\/g,"\\\\\\\\")
        .replace(/'/g,"\\\\'")
        .replace(/\\n/g,"\\\\n")
        .replace(/\\r/g,"\\\\r");
}

loadDashboard();

setInterval(
    loadDashboard,
    10000
);

</script>

</body>

</html>

`);

});

/* ======================================================
   404
====================================================== */

app.use(
    (req, res) => {

        res.status(404).json({
            error: "Not found"
        });
    }
);

/* ======================================================
   ERROR HANDLER
====================================================== */

app.use(
    (error, req, res, next) => {

        console.error(error);

        res.status(500).json({
            error:
                "Internal server error"
        });
    }
);

/* ======================================================
   START
====================================================== */

app.listen(
    PORT,
    "0.0.0.0",
    () => {

        console.log(
            "======================================"
        );

        console.log(
            "     ALOOZ PROTECTOR PANEL"
        );

        console.log(
            "======================================"
        );

        console.log(
            "Panel running on port " +
            PORT
        );

        console.log(
            "Admin user: " +
            ADMIN_USER
        );

        console.log(
            "======================================"
        );
    }
);
