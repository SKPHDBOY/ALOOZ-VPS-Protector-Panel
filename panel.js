/*
==========================================================
 ALOOZ VPS PROTECTOR PANEL
 Single-file backend + API + embedded frontend
==========================================================
*/

import express from "express";
import http from "http";
import crypto from "crypto";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import pg from "pg";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import multer from "multer";
import { WebSocketServer } from "ws";

const execFileAsync = promisify(execFile);
const { Pool } = pg;

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";

const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgres://alooz:alooz@db:5432/alooz";

const JWT_SECRET =
  process.env.JWT_SECRET ||
  crypto.randomBytes(48).toString("hex");

const ADMIN_USERNAME =
  process.env.ADMIN_USERNAME || "admin";

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD || "ChangeMe123!";

const PANEL_NAME =
  process.env.PANEL_NAME || "ALOOZ VPS Protector";

const DATA_DIR =
  process.env.DATA_DIR || "/opt/alooz/data";

const BACKUP_DIR =
  process.env.BACKUP_DIR || "/opt/alooz/backups";

const SERVER_DATA_DIR =
  process.env.SERVER_DATA_DIR || "/opt/alooz/servers";

const UPLOAD_DIR =
  process.env.UPLOAD_DIR || "/opt/alooz/uploads";

for (const dir of [
  DATA_DIR,
  BACKUP_DIR,
  SERVER_DATA_DIR,
  UPLOAD_DIR
]) {
  fs.mkdirSync(dir, { recursive: true });
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000
});

/* ======================================================
   DATABASE
====================================================== */

async function db(sql, params = []) {
  return pool.query(sql, params);
}

async function waitForDatabase() {
  for (let i = 1; i <= 60; i++) {
    try {
      await db("SELECT 1");
      console.log("Database connected.");
      return;
    } catch (err) {
      console.log(`Waiting for database... ${i}/60`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }

  throw new Error("Database connection failed.");
}

async function migrate() {
  await db(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      active BOOLEAN NOT NULL DEFAULT TRUE,
      twofa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      twofa_secret TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS nodes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      hostname TEXT,
      address TEXT,
      port INTEGER DEFAULT 22,
      status TEXT DEFAULT 'online',
      memory_limit BIGINT DEFAULT 0,
      disk_limit BIGINT DEFAULT 0,
      cpu_limit INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS servers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      identifier TEXT UNIQUE NOT NULL,
      container_id TEXT,
      owner_id UUID REFERENCES users(id) ON DELETE SET NULL,
      node_id UUID REFERENCES nodes(id) ON DELETE SET NULL,
      image TEXT DEFAULT 'itzg/minecraft-server:latest',
      status TEXT DEFAULT 'offline',
      memory_limit BIGINT DEFAULT 2048,
      cpu_limit INTEGER DEFAULT 100,
      disk_limit BIGINT DEFAULT 10240,
      port INTEGER,
      auto_restart BOOLEAN DEFAULT TRUE,
      environment JSONB DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS backups (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      server_id UUID REFERENCES servers(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      size BIGINT DEFAULT 0,
      status TEXT DEFAULT 'completed',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS backup_schedules (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      server_id UUID REFERENCES servers(id) ON DELETE CASCADE,
      interval_minutes INTEGER DEFAULT 1440,
      retention INTEGER DEFAULT 7,
      enabled BOOLEAN DEFAULT TRUE,
      last_run TIMESTAMPTZ
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS allocations (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      ip TEXT DEFAULT '0.0.0.0',
      port INTEGER UNIQUE NOT NULL,
      assigned_server UUID REFERENCES servers(id) ON DELETE SET NULL,
      available BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID,
      action TEXT NOT NULL,
      details JSONB DEFAULT '{}'::jsonb,
      ip TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS plans (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      price NUMERIC DEFAULT 0,
      memory BIGINT DEFAULT 2048,
      disk BIGINT DEFAULT 10240,
      cpu INTEGER DEFAULT 100,
      servers INTEGER DEFAULT 1,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS orders (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id UUID REFERENCES users(id) ON DELETE SET NULL,
      plan_id UUID REFERENCES plans(id) ON DELETE SET NULL,
      amount NUMERIC DEFAULT 0,
      status TEXT DEFAULT 'pending',
      payment_method TEXT,
      external_id TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS webhooks (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      event TEXT DEFAULT '*',
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await db(`
    CREATE TABLE IF NOT EXISTS server_commands (
      id BIGSERIAL PRIMARY KEY,
      server_id UUID REFERENCES servers(id) ON DELETE CASCADE,
      user_id UUID,
      command TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const admin = await db(
    "SELECT id FROM users WHERE username=$1",
    [ADMIN_USERNAME]
  );

  if (admin.rowCount === 0) {
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12);

    await db(
      `INSERT INTO users
       (username,email,password_hash,role)
       VALUES($1,$2,$3,'admin')`,
      [
        ADMIN_USERNAME,
        `${ADMIN_USERNAME}@localhost`,
        hash
      ]
    );

    console.log("Admin account created.");
  }

  const node = await db("SELECT id FROM nodes LIMIT 1");

  if (node.rowCount === 0) {
    await db(
      `INSERT INTO nodes
       (name,hostname,address,status)
       VALUES($1,$2,$3,'online')`,
      [
        "Local Node",
        os.hostname(),
        "127.0.0.1"
      ]
    );
  }
}

/* ======================================================
   EXPRESS
====================================================== */

const app = express();
const server = http.createServer(app);

app.disable("x-powered-by");

app.use(
  helmet({
    contentSecurityPolicy: false
  })
);

app.use(cors({
  origin: true,
  credentials: true
}));

app.use(express.json({
  limit: "25mb"
}));

app.use(express.urlencoded({
  extended: true,
  limit: "25mb"
}));

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false
}));

const upload = multer({
  dest: UPLOAD_DIR,
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024
  }
});

/* ======================================================
   HELPERS
====================================================== */

function json(res, data, status = 200) {
  return res.status(status).json(data);
}

function error(res, message, status = 400) {
  return res.status(status).json({
    success: false,
    error: message
  });
}

function success(res, data = {}) {
  return json(res, {
    success: true,
    ...data
  });
}

function signToken(user) {
  return jwt.sign(
    {
      id: user.id,
      username: user.username,
      role: user.role
    },
    JWT_SECRET,
    {
      expiresIn: "7d"
    }
  );
}

function getToken(req) {
  const auth = req.headers.authorization || "";

  if (auth.startsWith("Bearer ")) {
    return auth.slice(7);
  }

  if (req.query && req.query.token) {
    return String(req.query.token);
  }

  return null;
}

async function auth(req, res, next) {
  try {
    const token = getToken(req);

    if (!token) {
      return error(res, "Authentication required.", 401);
    }

    let payload;

    try {
      payload = jwt.verify(token, JWT_SECRET);
    } catch {
      return error(res, "Invalid or expired token.", 401);
    }

    const result = await db(
      `SELECT id,username,email,role,active,twofa_enabled
       FROM users WHERE id=$1`,
      [payload.id]
    );

    if (!result.rowCount || !result.rows[0].active) {
      return error(res, "User is disabled.", 403);
    }

    req.user = result.rows[0];
    next();

  } catch (err) {
    console.error(err);
    return error(res, "Authentication error.", 500);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return error(res, "Unauthorized.", 401);
    }

    if (!roles.includes(req.user.role)) {
      return error(res, "Permission denied.", 403);
    }

    next();
  };
}

function safeName(value) {
  return String(value || "")
    .replace(/[^\w.\- ]/g, "_")
    .slice(0, 100);
}

function safePath(base, target) {
  const resolvedBase = path.resolve(base);
  const resolved = path.resolve(
    resolvedBase,
    String(target || "")
  );

  if (
    resolved !== resolvedBase &&
    !resolved.startsWith(resolvedBase + path.sep)
  ) {
    throw new Error("Invalid path.");
  }

  return resolved;
}

async function audit(req, action, details = {}) {
  try {
    await db(
      `INSERT INTO audit_logs
       (user_id,action,details,ip)
       VALUES($1,$2,$3,$4)`,
      [
        req.user?.id || null,
        action,
        JSON.stringify(details),
        req.ip
      ]
    );
  } catch {}
}

async function docker(args, options = {}) {
  return execFileAsync(
    "docker",
    args,
    {
      timeout: options.timeout || 120000,
      maxBuffer: options.maxBuffer || 50 * 1024 * 1024
    }
  );
}

async function dockerExists() {
  try {
    await docker(["version"]);
    return true;
  } catch {
    return false;
  }
}

function serverDir(serverId) {
  return path.join(
    SERVER_DATA_DIR,
    String(serverId)
  );
}

/* ======================================================
   HEALTH
====================================================== */

app.get("/api/health", async (req, res) => {
  let database = false;
  let dockerStatus = false;

  try {
    await db("SELECT 1");
    database = true;
  } catch {}

  dockerStatus = await dockerExists();

  return success(res, {
    name: PANEL_NAME,
    version: "1.0.0",
    uptime: process.uptime(),
    database,
    docker: dockerStatus,
    node: os.hostname()
  });
});

/* ======================================================
   LOGIN
====================================================== */

app.post("/api/login", async (req, res) => {
  try {
    const {
      username,
      password
    } = req.body;

    if (!username || !password) {
      return error(
        res,
        "Username and password required."
      );
    }

    const result = await db(
      `SELECT * FROM users
       WHERE username=$1 OR email=$1
       LIMIT 1`,
      [username]
    );

    if (!result.rowCount) {
      return error(
        res,
        "Invalid username or password.",
        401
      );
    }

    const user = result.rows[0];

    const valid = await bcrypt.compare(
      password,
      user.password_hash
    );

    if (!valid) {
      return error(
        res,
        "Invalid username or password.",
        401
      );
    }

    if (!user.active) {
      return error(
        res,
        "Account disabled.",
        403
      );
    }

    const token = signToken(user);

    const hash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    await db(
      `INSERT INTO sessions
       (user_id,token_hash,expires_at)
       VALUES($1,$2,NOW()+INTERVAL '7 days')`,
      [
        user.id,
        hash
      ]
    );

    return success(res, {
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role
      }
    });

  } catch (err) {
    console.error(err);
    return error(res, "Login failed.", 500);
  }
});

app.post("/api/logout", auth, async (req, res) => {
  const token = getToken(req);

  if (token) {
    const hash = crypto
      .createHash("sha256")
      .update(token)
      .digest("hex");

    await db(
      "DELETE FROM sessions WHERE token_hash=$1",
      [hash]
    );
  }

  return success(res);
});

app.get("/api/me", auth, async (req, res) => {
  return success(res, {
    user: req.user
  });
});

/* ======================================================
   SYSTEM
====================================================== */

app.get("/api/system", auth, async (req, res) => {
  let disk = {};

  try {
    const { stdout } = await execFileAsync(
      "df",
      ["-B1", "/"]
    );

    const line = stdout
      .trim()
      .split("\n")
      .pop()
      .trim()
      .split(/\s+/);

    disk = {
      total: Number(line[1] || 0),
      used: Number(line[2] || 0),
      free: Number(line[3] || 0),
      percent: line[4] || "0%"
    };
  } catch {}

  return success(res, {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
    cpu: os.cpus().length,
    load: os.loadavg(),
    memory: {
      total: os.totalmem(),
      free: os.freemem(),
      used:
        os.totalmem() - os.freemem()
    },
    disk,
    uptime: os.uptime(),
    panelUptime: process.uptime()
  });
});

/* ======================================================
   USERS
====================================================== */

app.get(
  "/api/users",
  auth,
  requireRole("admin"),
  async (req, res) => {
    const result = await db(
      `SELECT id,username,email,role,active,
              twofa_enabled,created_at
       FROM users
       ORDER BY created_at DESC`
    );

    return success(res, {
      users: result.rows
    });
  }
);

app.post(
  "/api/users",
  auth,
  requireRole("admin"),
  async (req, res) => {
    const {
      username,
      email,
      password,
      role = "user"
    } = req.body;

    if (!username || !password) {
      return error(
        res,
        "Username and password required."
      );
    }

    if (
      !["admin", "reseller", "user"].includes(role)
    ) {
      return error(res, "Invalid role.");
    }

    const hash = await bcrypt.hash(
      password,
      12
    );

    try {
      const result = await db(
        `INSERT INTO users
         (username,email,password_hash,role)
         VALUES($1,$2,$3,$4)
         RETURNING id,username,email,role,active`,
        [
          username,
          email || null,
          hash,
          role
        ]
      );

      await audit(req, "user.create", {
        user: username
      });

      return success(res, {
        user: result.rows[0]
      });

    } catch (err) {
      return error(
        res,
        err.code === "23505"
          ? "Username or email already exists."
          : err.message
      );
    }
  }
);

app.patch(
  "/api/users/:id",
  auth,
  requireRole("admin"),
  async (req, res) => {
    const {
      role,
      active,
      password,
      email
    } = req.body;

    const fields = [];
    const values = [];
    let index = 1;

    if (role) {
      fields.push(`role=$${index++}`);
      values.push(role);
    }

    if (typeof active === "boolean") {
      fields.push(`active=$${index++}`);
      values.push(active);
    }

    if (email !== undefined) {
      fields.push(`email=$${index++}`);
      values.push(email);
    }

    if (password) {
      fields.push(`password_hash=$${index++}`);
      values.push(
        await bcrypt.hash(password, 12)
      );
    }

    if (!fields.length) {
      return error(res, "Nothing to update.");
    }

    values.push(req.params.id);

    const result = await db(
      `UPDATE users
       SET ${fields.join(",")}
       WHERE id=$${index}
       RETURNING id,username,email,role,active`,
      values
    );

    if (!result.rowCount) {
      return error(res, "User not found.", 404);
    }

    await audit(req, "user.update", {
      userId: req.params.id
    });

    return success(res, {
      user: result.rows[0]
    });
  }
);

app.delete(
  "/api/users/:id",
  auth,
  requireRole("admin"),
  async (req, res) => {
    if (req.params.id === req.user.id) {
      return error(
        res,
        "You cannot delete yourself."
      );
    }

    await db(
      "DELETE FROM users WHERE id=$1",
      [req.params.id]
    );

    await audit(req, "user.delete", {
      userId: req.params.id
    });

    return success(res);
  }
);

/* ======================================================
   API TOKENS
====================================================== */

app.get(
  "/api/tokens",
  auth,
  async (req, res) => {
    const result = await db(
      `SELECT id,name,created_at,last_used_at
       FROM api_tokens
       WHERE user_id=$1
       ORDER BY created_at DESC`,
      [req.user.id]
    );

    return success(res, {
      tokens: result.rows
    });
  }
);

app.post(
  "/api/tokens",
  auth,
  async (req, res) => {
    const name =
      req.body.name || "API Token";

    const raw =
      "alooz_" +
      crypto.randomBytes(32)
        .toString("hex");

    const hash = crypto
      .createHash("sha256")
      .update(raw)
      .digest("hex");

    const result = await db(
      `INSERT INTO api_tokens
       (user_id,name,token_hash)
       VALUES($1,$2,$3)
       RETURNING id,name,created_at`,
      [
        req.user.id,
        name,
        hash
      ]
    );

    return success(res, {
      token: raw,
      info: result.rows[0]
    });
  }
);

app.delete(
  "/api/tokens/:id",
  auth,
  async (req, res) => {
    await db(
      `DELETE FROM api_tokens
       WHERE id=$1 AND user_id=$2`,
      [
        req.params.id,
        req.user.id
      ]
    );

    return success(res);
  }
);

/* ======================================================
   NODES
====================================================== */

app.get(
  "/api/nodes",
  auth,
  async (req, res) => {
    const result = await db(`
      SELECT n.*,
      COUNT(s.id)::int AS server_count
      FROM nodes n
      LEFT JOIN servers s
      ON s.node_id=n.id
      GROUP BY n.id
      ORDER BY n.created_at DESC
    `);

    return success(res, {
      nodes: result.rows
    });
  }
);

app.post(
  "/api/nodes",
  auth,
  requireRole("admin"),
  async (req, res) => {
    const {
      name,
      hostname,
      address,
      port = 22,
      memory_limit = 0,
      disk_limit = 0,
      cpu_limit = 0
    } = req.body;

    if (!name) {
      return error(res, "Node name required.");
    }

    const result = await db(
      `INSERT INTO nodes
       (name,hostname,address,port,
        memory_limit,disk_limit,cpu_limit)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [
        name,
        hostname || null,
        address || null,
        port,
        memory_limit,
        disk_limit,
        cpu_limit
      ]
    );

    await audit(req, "node.create", {
      node: name
    });

    return success(res, {
      node: result.rows[0]
    });
  }
);

app.delete(
  "/api/nodes/:id",
  auth,
  requireRole("admin"),
  async (req, res) => {
    await db(
      "DELETE FROM nodes WHERE id=$1",
      [req.params.id]
    );

    return success(res);
  }
);

/* ======================================================
   SERVER HELPERS
====================================================== */

async function findServer(id) {
  const result = await db(
    "SELECT * FROM servers WHERE id=$1",
    [id]
  );

  return result.rows[0] || null;
}

async function getContainerState(container) {
  try {
    const { stdout } = await docker([
      "inspect",
      "-f",
      "{{.State.Status}}",
      container
    ]);

    return stdout.trim();
  } catch {
    return "not_found";
  }
}

async function serverAction(server, action) {
  if (!server.container_id) {
    throw new Error(
      "Server container is not created."
    );
  }

  const allowed = [
    "start",
    "stop",
    "restart",
    "kill",
    "pause",
    "unpause"
  ];

  if (!allowed.includes(action)) {
    throw new Error("Invalid action.");
  }

  await docker([
    action,
    server.container_id
  ]);

  const state =
    await getContainerState(
      server.container_id
    );

  await db(
    "UPDATE servers SET status=$1 WHERE id=$2",
    [state, server.id]
  );

  return state;
}

/* ======================================================
   SERVERS
====================================================== */

app.get(
  "/api/servers",
  auth,
  async (req, res) => {
    let query = `
      SELECT s.*,u.username AS owner_name,
             n.name AS node_name
      FROM servers s
      LEFT JOIN users u
      ON u.id=s.owner_id
      LEFT JOIN nodes n
      ON n.id=s.node_id
    `;

    const params = [];

    if (
      req.user.role !== "admin"
    ) {
      query += " WHERE s.owner_id=$1";
      params.push(req.user.id);
    }

    query += " ORDER BY s.created_at DESC";

    const result = await db(
      query,
      params
    );

    return success(res, {
      servers: result.rows
    });
  }
);

app.get(
  "/api/servers/:id",
  auth,
  async (req, res) => {
    const serverData =
      await findServer(req.params.id);

    if (!serverData) {
      return error(
        res,
        "Server not found.",
        404
      );
    }

    if (
      req.user.role !== "admin" &&
      serverData.owner_id !== req.user.id
    ) {
      return error(
        res,
        "Permission denied.",
        403
      );
    }

    if (serverData.container_id) {
      serverData.status =
        await getContainerState(
          serverData.container_id
        );
    }

    return success(res, {
      server: serverData
    });
  }
);

/* ======================================================
   CREATE MINECRAFT SERVER
====================================================== */

app.post(
  "/api/servers",
  auth,
  async (req, res) => {
    try {
      const {
        name,
        memory = 2048,
        cpu = 100,
        disk = 10240,
        version = "LATEST",
        type = "PAPER",
        port
      } = req.body;

      if (!name) {
        return error(
          res,
          "Server name required."
        );
      }

      const identifier =
        safeName(name)
          .toLowerCase()
          .replace(/\s+/g, "-") +
        "-" +
        crypto.randomBytes(3)
          .toString("hex");

      const serverId =
        crypto.randomUUID();

      const dataPath =
        path.join(
          SERVER_DATA_DIR,
          serverId
        );

      await fsp.mkdir(
        dataPath,
        { recursive: true }
      );

      const image =
        "itzg/minecraft-server:latest";

      const selectedPort =
        Number(port) ||
        25565 +
        Math.floor(
          Math.random() * 1000
        );

      const env = {
        EULA: "TRUE",
        TYPE: type,
        VERSION: version,
        MEMORY: `${Math.max(
          512,
          Number(memory)
        )}M`,
        ENABLE_RCON: "true",
        RCON_PASSWORD:
          crypto.randomBytes(18)
            .toString("hex")
      };

      const result = await db(
        `INSERT INTO servers
        (id,name,identifier,owner_id,node_id,
         image,status,memory_limit,cpu_limit,
         disk_limit,port,environment)
        VALUES($1,$2,$3,$4,
        (SELECT id FROM nodes LIMIT 1),
        $5,'creating',$6,$7,$8,$9,$10)
        RETURNING *`,
        [
          serverId,
          name,
          identifier,
          req.user.id,
          image,
          memory,
          cpu,
          disk,
          selectedPort,
          JSON.stringify(env)
        ]
      );

      const args = [
        "run",
        "-d",
        "--name",
        identifier,
        "--restart",
        "unless-stopped",

        "--memory",
        `${Number(memory)}m`,

        "--cpus",
        String(
          Math.max(
            0.1,
            Number(cpu) / 100
          )
        ),

        "-p",
        `${selectedPort}:25565`,

        "-v",
        `${dataPath}:/data`
      ];

      for (const [
        key,
        value
      ] of Object.entries(env)) {
        args.push(
          "-e",
          `${key}=${value}`
        );
      }

      args.push(image);

      await docker(args);

      const containerResult =
        await docker([
          "inspect",
          "-f",
          "{{.Id}}",
          identifier
        ]);

      const containerId =
        containerResult.stdout.trim();

      await db(
        `UPDATE servers
         SET container_id=$1,status='running'
         WHERE id=$2`,
        [
          containerId,
          serverId
        ]
      );

      await db(
        `INSERT INTO allocations
         (ip,port,assigned_server,available)
         VALUES('0.0.0.0',$1,$2,false)
         ON CONFLICT(port) DO NOTHING`,
        [
          selectedPort,
          serverId
        ]
      );

      await audit(
        req,
        "server.create",
        {
          serverId,
          name
        }
      );

      return success(res, {
        serverId,
        identifier,
        port: selectedPort
      });

    } catch (err) {
      console.error(err);

      return error(
        res,
        err.message,
        500
      );
    }
  }
);

/* ======================================================
   SERVER ACTION
====================================================== */

app.post(
  "/api/servers/:id/action",
  auth,
  async (req, res) => {
    try {
      const {
        action
      } = req.body;

      const serverData =
        await findServer(
          req.params.id
        );

      if (!serverData) {
        return error(
          res,
          "Server not found.",
          404
        );
      }

      if (
        req.user.role !== "admin" &&
        serverData.owner_id !== req.user.id
      ) {
        return error(
          res,
          "Permission denied.",
          403
        );
      }

      const state =
        await serverAction(
          serverData,
          action
        );

      await audit(
        req,
        `server.${action}`,
        {
          serverId:
            serverData.id
        }
      );

      return success(res, {
        status: state
      });

    } catch (err) {
      return error(
        res,
        err.message,
        500
      );
    }
  }
);

/* ======================================================
   SERVER UPDATE
====================================================== */

app.patch(
  "/api/servers/:id",
  auth,
  async (req, res) => {
    const serverData =
      await findServer(
        req.params.id
      );

    if (!serverData) {
      return error(
        res,
        "Server not found.",
        404
      );
    }

    if (
      req.user.role !== "admin" &&
      serverData.owner_id !== req.user.id
    ) {
      return error(
        res,
        "Permission denied.",
        403
      );
    }

    const allowed = [
      "name",
      "memory_limit",
      "cpu_limit",
      "disk_limit",
      "auto_restart"
    ];

    const fields = [];
    const values = [];
    let i = 1;

    for (const key of allowed) {
      if (req.body[key] !== undefined) {
        fields.push(
          `${key}=$${i++}`
        );
        values.push(req.body[key]);
      }
    }

    if (!fields.length) {
      return error(
        res,
        "Nothing to update."
      );
    }

    values.push(req.params.id);

    await db(
      `UPDATE servers
       SET ${fields.join(",")}
       WHERE id=$${i}`,
      values
    );

    await audit(
      req,
      "server.update",
      {
        serverId:
          req.params.id
      }
    );

    return success(res);
  }
);

/* ======================================================
   DELETE SERVER
====================================================== */

app.delete(
  "/api/servers/:id",
  auth,
  async (req, res) => {
    try {
      const serverData =
        await findServer(
          req.params.id
        );

      if (!serverData) {
        return error(
          res,
          "Server not found.",
          404
        );
      }

      if (
        req.user.role !== "admin" &&
        serverData.owner_id !== req.user.id
      ) {
        return error(
          res,
          "Permission denied.",
          403
        );
      }

      if (serverData.container_id) {
        try {
          await docker([
            "rm",
            "-f",
            serverData.container_id
          ]);
        } catch {}
      }

      await db(
        "DELETE FROM servers WHERE id=$1",
        [req.params.id]
      );

      await audit(
        req,
        "server.delete",
        {
          serverId:
            req.params.id
        }
      );

      return success(res);

    } catch (err) {
      return error(
        res,
        err.message,
        500
      );
    }
  }
);

/* ======================================================
   SERVER LOGS
====================================================== */

app.get(
  "/api/servers/:id/logs",
  auth,
  async (req, res) => {
    const serverData =
      await findServer(
        req.params.id
      );

    if (!serverData) {
      return error(
        res,
        "Server not found.",
        404
      );
    }

    if (
      req.user.role !== "admin" &&
      serverData.owner_id !== req.user.id
    ) {
      return error(
        res,
        "Permission denied.",
        403
      );
    }

    try {
      const { stdout, stderr } =
        await docker([
          "logs",
          "--tail",
          String(
            Math.min(
              5000,
              Number(
                req.query.lines || 300
              )
            )
          ),
          serverData.container_id
        ]);

      return success(res, {
        logs: stdout + stderr
      });

    } catch (err) {
      return error(
        res,
        err.message
      );
    }
  }
);

/* ======================================================
   SEND COMMAND
====================================================== */

app.post(
  "/api/servers/:id/command",
  auth,
  async (req, res) => {
    const serverData =
      await findServer(
        req.params.id
      );

    if (!serverData) {
      return error(
        res,
        "Server not found.",
        404
      );
    }

    if (
      req.user.role !== "admin" &&
      serverData.owner_id !== req.user.id
    ) {
      return error(
        res,
        "Permission denied.",
        403
      );
    }

    const command =
      String(req.body.command || "")
        .trim();

    if (!command) {
      return error(
        res,
        "Command required."
      );
    }

    /*
      Minecraft console command.
      Do not expose this endpoint publicly
      without authentication.
    */

    try {
      await docker([
        "exec",
        serverData.container_id,
        "rcon-cli",
        command
      ]);

      await db(
        `INSERT INTO server_commands
         (server_id,user_id,command)
         VALUES($1,$2,$3)`,
        [
          serverData.id,
          req.user.id,
          command
        ]
      );

      await audit(
        req,
        "server.command",
        {
          serverId:
            serverData.id,
          command
        }
      );

      return success(res);

    } catch (err) {
      return error(
        res,
        err.message
      );
    }
  }
);

/* ======================================================
   SERVER STATS
====================================================== */

app.get(
  "/api/servers/:id/stats",
  auth,
  async (req, res) => {
    const serverData =
      await findServer(
        req.params.id
      );

    if (!serverData) {
      return error(
        res,
        "Server not found.",
        404
      );
    }

    if (
      req.user.role !== "admin" &&
      serverData.owner_id !== req.user.id
    ) {
      return error(
        res,
        "Permission denied.",
        403
      );
    }

    try {
      const { stdout } =
        await docker([
          "stats",
          "--no-stream",
          "--format",
          "{{json .}}",
          serverData.container_id
        ]);

      const data =
        JSON.parse(
          stdout.trim()
        );

      return success(res, {
        stats: data
      });

    } catch (err) {
      return error(
        res,
        err.message
      );
    }
  }
);

/* ======================================================
   FILE MANAGER
====================================================== */

app.get(
  "/api/servers/:id/files",
  auth,
  async (req, res) => {
    const serverData =
      await findServer(
        req.params.id
      );

    if (!serverData) {
      return error(
        res,
        "Server not found.",
        404
      );
    }

    if (
      req.user.role !== "admin" &&
      serverData.owner_id !== req.user.id
    ) {
      return error(
        res,
        "Permission denied.",
        403
      );
    }

    try {
      const relative =
        req.query.path || "";

      const dir =
        safePath(
          serverDir(serverData.id),
          relative
        );

      await fsp.mkdir(
        dir,
        {
          recursive: true
        }
      );

      const entries =
        await fsp.readdir(
          dir,
          {
            withFileTypes: true
          }
        );

      const files = [];

      for (const entry of entries) {
        const full =
          path.join(
            dir,
            entry.name
          );

        let stat;

        try {
          stat =
            await fsp.stat(full);
        } catch {
          continue;
        }

        files.push({
          name: entry.name,
          type: entry.isDirectory()
            ? "directory"
            : "file",
          size: stat.size,
          modified:
            stat.mtime
        });
      }

      return success(res, {
        path: relative,
        files
      });

    } catch (err) {
      return error(
        res,
        err.message
      );
    }
  }
);

app.get(
  "/api/servers/:id/file",
  auth,
  async (req, res) => {
    const serverData =
      await findServer(
        req.params.id
      );

    if (!serverData) {
      return error(
        res,
        "Server not found.",
        404
      );
    }

    try {
      const file =
        safePath(
          serverDir(serverData.id),
          req.query.path
        );

      const stat =
        await fsp.stat(file);

      if (!stat.isFile()) {
        return error(
          res,
          "Not a file."
        );
      }

      const content =
        await fsp.readFile(
          file,
          "utf8"
        );

      return success(res, {
        path: req.query.path,
        content
      });

    } catch (err) {
      return error(
        res,
        err.message
      );
    }
  }
);

app.put(
  "/api/servers/:id/file",
  auth,
  async (req, res) => {
    const serverData =
      await findServer(
        req.params.id
      );

    if (!serverData) {
      return error(
        res,
        "Server not found.",
        404
      );
    }

    try {
      const file =
        safePath(
          serverDir(serverData.id),
          req.body.path
        );

      await fsp.mkdir(
        path.dirname(file),
        {
          recursive: true
        }
      );

      await fsp.writeFile(
        file,
        String(
          req.body.content || ""
        )
      );

      await audit(
        req,
        "file.write",
        {
          serverId:
            serverData.id,
          path:
            req.body.path
        }
      );

      return success(res);

    } catch (err) {
      return error(
        res,
        err.message
      );
    }
  }
);

app.post(
  "/api/servers/:id/files",
  auth,
  async (req, res) => {
    const serverData =
      await findServer(
        req.params.id
      );

    if (!serverData) {
      return error(
        res,
        "Server not found.",
        404
      );
    }

    try {
      const target =
        safePath(
          serverDir(serverData.id),
          req.body.path
        );

      if (req.body.type === "folder") {
        await fsp.mkdir(
          target,
          {
            recursive: true
          }
        );
      } else {
        await fsp.mkdir(
          path.dirname(target),
          {
            recursive: true
          }
        );

        await fsp.writeFile(
          target,
          ""
        );
      }

      return success(res);

    } catch (err) {
      return error(
        res,
        err.message
      );
    }
  }
);

app.delete(
  "/api/servers/:id/file",
  auth,
  async (req, res) => {
    const serverData =
      await findServer(
        req.params.id
      );

    if (!serverData) {
      return error(
        res,
        "Server not found.",
        404
      );
    }

    try {
      const target =
        safePath(
          serverDir(serverData.id),
          req.body.path
        );

      await fsp.rm(
        target,
        {
          recursive: true,
          force: true
        }
      );

      return success(res);

    } catch (err) {
      return error(
        res,
        err.message
      );
    }
  }
);

app.post(
  "/api/servers/:id/upload",
  auth,
  upload.single("file"),
  async (req, res) => {
    const serverData =
      await findServer(
        req.params.id
      );

    if (!serverData) {
      return error(
        res,
        "Server not found.",
        404
      );
    }

    if (!req.file) {
      return error(
        res,
        "File required."
      );
    }

    try {
      const target =
        safePath(
          serverDir(serverData.id),
          req.body.path || req.file.originalname
        );

      await fsp.mkdir(
        path.dirname(target),
        {
          recursive: true
        }
      );

      await fsp.rename(
        req.file.path,
        target
      );

      return success(res, {
        file:
          req.file.originalname
      });

    } catch (err) {
      return error(
        res,
        err.message
      );
    }
  }
);

/* ======================================================
   RENAME FILE
====================================================== */

app.post(
  "/api/servers/:id/rename",
  auth,
  async (req, res) => {
    const serverData =
      await findServer(
        req.params.id
      );

    if (!serverData) {
      return error(
        res,
        "Server not found."
      );
    }

    try {
      const oldPath =
        safePath(
          serverDir(serverData.id),
          req.body.oldPath
        );

      const newPath =
        safePath(
          serverDir(serverData.id),
          req.body.newPath
        );

      await fsp.rename(
        oldPath,
        newPath
      );

      return success(res);

    } catch (err) {
      return error(
        res,
        err.message
      );
    }
  }
);

/* ======================================================
   BACKUPS
====================================================== */

app.get(
  "/api/servers/:id/backups",
  auth,
  async (req, res) => {
    const result = await db(
      `SELECT * FROM backups
       WHERE server_id=$1
       ORDER BY created_at DESC`,
      [req.params.id]
    );

    return success(res, {
      backups: result.rows
    });
  }
);

app.post(
  "/api/servers/:id/backups",
  auth,
  async (req, res) => {
    const serverData =
      await findServer(
        req.params.id
      );

    if (!serverData) {
      return error(
        res,
        "Server not found."
      );
    }

    const name =
      safeName(
        req.body.name ||
        `backup-${Date.now()}`
      );

    const source =
      serverDir(
        serverData.id
      );

    const destination =
      path.join(
        BACKUP_DIR,
        `${serverData.identifier}-${name}.tar.gz`
      );

    try {
      await fsp.mkdir(
        BACKUP_DIR,
        {
          recursive: true
        }
      );

      await new Promise(
        (resolve, reject) => {
          const child =
            spawn(
              "tar",
              [
                "-czf",
                destination,
                "-C",
                source,
                "."
              ]
            );

          let stderr = "";

          child.stderr.on(
            "data",
            d => {
              stderr += d.toString();
            }
          );

          child.on(
            "error",
            reject
          );

          child.on(
            "close",
            code => {
              if (code === 0) {
                resolve();
              } else {
                reject(
                  new Error(
                    stderr ||
                    `tar exited with ${code}`
                  )
                );
              }
            }
          );
        }
      );

      const stat =
        await fsp.stat(
          destination
        );

      const result =
        await db(
          `INSERT INTO backups
           (server_id,name,file_path,size)
           VALUES($1,$2,$3,$4)
           RETURNING *`,
          [
            serverData.id,
            name,
            destination,
            stat.size
          ]
        );

      await audit(
        req,
        "backup.create",
        {
          serverId:
            serverData.id
        }
      );

      return success(res, {
        backup:
          result.rows[0]
      });

    } catch (err) {
      return error(
        res,
        err.message,
        500
      );
    }
  }
);

app.get(
  "/api/backups/:id/download",
  auth,
  async (req, res) => {
    const result =
      await db(
        "SELECT * FROM backups WHERE id=$1",
        [req.params.id]
      );

    if (!result.rowCount) {
      return error(
        res,
        "Backup not found.",
        404
      );
    }

    const backup =
      result.rows[0];

    if (
      !fs.existsSync(
        backup.file_path
      )
    ) {
      return error(
        res,
        "Backup file missing.",
        404
      );
    }

    res.download(
      backup.file_path,
      path.basename(
        backup.file_path
      )
    );
  }
);

app.delete(
  "/api/backups/:id",
  auth,
  async (req, res) => {
    const result =
      await db(
        "SELECT * FROM backups WHERE id=$1",
        [req.params.id]
      );

    if (!result.rowCount) {
      return error(
        res,
        "Backup not found."
      );
    }

    const backup =
      result.rows[0];

    try {
      await fsp.rm(
        backup.file_path,
        {
          force: true
        }
      );
    } catch {}

    await db(
      "DELETE FROM backups WHERE id=$1",
      [req.params.id]
    );

    return success(res);
  }
);

app.post(
  "/api/backups/:id/restore",
  auth,
  async (req, res) => {
    const result =
      await db(
        "SELECT * FROM backups WHERE id=$1",
        [req.params.id]
      );

    if (!result.rowCount) {
      return error(
        res,
        "Backup not found."
      );
    }

    const backup =
      result.rows[0];

    const serverData =
      await findServer(
        backup.server_id
      );

    if (!serverData) {
      return error(
        res,
        "Server not found."
      );
    }

    try {
      if (serverData.container_id) {
        try {
          await docker([
            "stop",
            serverData.container_id
          ]);
        } catch {}
      }

      const target =
        serverDir(
          serverData.id
        );

      await fsp.mkdir(
        target,
        {
          recursive: true
        }
      );

      await execFileAsync(
        "tar",
        [
          "-xzf",
          backup.file_path,
          "-C",
          target
        ]
      );

      if (serverData.container_id) {
        try {
          await docker([
            "start",
            serverData.container_id
          ]);
        } catch {}
      }

      return success(res);

    } catch (err) {
      return error(
        res,
        err.message,
        500
      );
    }
  }
);

/* ======================================================
   BACKUP SCHEDULES
====================================================== */

app.get(
  "/api/backup-schedules",
  auth,
  async (req, res) => {
    const result =
      await db(`
        SELECT bs.*,s.name AS server_name
        FROM backup_schedules bs
        JOIN servers s
        ON s.id=bs.server_id
        ORDER BY bs.server_id
      `);

    return success(res, {
      schedules:
        result.rows
    });
  }
);

app.post(
  "/api/backup-schedules",
  auth,
  async (req, res) => {
    const {
      server_id,
      interval_minutes = 1440,
      retention = 7,
      enabled = true
    } = req.body;

    const result =
      await db(
        `INSERT INTO backup_schedules
         (server_id,interval_minutes,retention,enabled)
         VALUES($1,$2,$3,$4)
         RETURNING *`,
        [
          server_id,
          interval_minutes,
          retention,
          enabled
        ]
      );

    return success(res, {
      schedule:
        result.rows[0]
    });
  }
);

/* ======================================================
   ALLOCATIONS
====================================================== */

app.get(
  "/api/allocations",
  auth,
  requireRole("admin"),
  async (req, res) => {
    const result =
      await db(`
        SELECT a.*,s.name AS server_name
        FROM allocations a
        LEFT JOIN servers s
        ON s.id=a.assigned_server
        ORDER BY a.port
      `);

    return success(res, {
      allocations:
        result.rows
    });
  }
);

app.post(
  "/api/allocations",
  auth,
  requireRole("admin"),
  async (req, res) => {
    const {
      ip = "0.0.0.0",
      port
    } = req.body;

    if (!port) {
      return error(
        res,
        "Port required."
      );
    }

    try {
      const result =
        await db(
          `INSERT INTO allocations
           (ip,port,available)
           VALUES($1,$2,true)
           RETURNING *`,
          [
            ip,
            Number(port)
          ]
        );

      return success(res, {
        allocation:
          result.rows[0]
      });

    } catch (err) {
      return error(
        res,
        "Port already exists."
      );
    }
  }
);

app.delete(
  "/api/allocations/:id",
  auth,
  requireRole("admin"),
  async (req, res) => {
    await db(
      "DELETE FROM allocations WHERE id=$1",
      [req.params.id]
    );

    return success(res);
  }
);

/* ======================================================
   PLANS
====================================================== */

app.get(
  "/api/plans",
  auth,
  async (req, res) => {
    const result =
      await db(
        "SELECT * FROM plans ORDER BY price"
      );

    return success(res, {
      plans:
        result.rows
    });
  }
);

app.post(
  "/api/plans",
  auth,
  requireRole("admin"),
  async (req, res) => {
    const {
      name,
      price = 0,
      memory = 2048,
      disk = 10240,
      cpu = 100,
      servers = 1
    } = req.body;

    if (!name) {
      return error(
        res,
        "Plan name required."
      );
    }

    const result =
      await db(
        `INSERT INTO plans
         (name,price,memory,disk,cpu,servers)
         VALUES($1,$2,$3,$4,$5,$6)
         RETURNING *`,
        [
          name,
          price,
          memory,
          disk,
          cpu,
          servers
        ]
      );

    return success(res, {
      plan:
        result.rows[0]
    });
  }
);

/* ======================================================
   ORDERS
====================================================== */

app.get(
  "/api/orders",
  auth,
  async (req, res) => {
    let sql = `
      SELECT o.*,
             u.username,
             p.name AS plan_name
      FROM orders o
      LEFT JOIN users u
      ON u.id=o.user_id
      LEFT JOIN plans p
      ON p.id=o.plan_id
    `;

    const params = [];

    if (req.user.role !== "admin") {
      sql += " WHERE o.user_id=$1";
      params.push(req.user.id);
    }

    sql += " ORDER BY o.created_at DESC";

    const result =
      await db(
        sql,
        params
      );

    return success(res, {
      orders:
        result.rows
    });
  }
);

app.post(
  "/api/orders",
  auth,
  async (req, res) => {
    const {
      plan_id,
      payment_method = "manual"
    } = req.body;

    const plan =
      await db(
        "SELECT * FROM plans WHERE id=$1 AND active=true",
        [plan_id]
      );

    if (!plan.rowCount) {
      return error(
        res,
        "Plan not found."
      );
    }

    const result =
      await db(
        `INSERT INTO orders
         (user_id,plan_id,amount,payment_method)
         VALUES($1,$2,$3,$4)
         RETURNING *`,
        [
          req.user.id,
          plan_id,
          plan.rows[0].price,
          payment_method
        ]
      );

    return success(res, {
      order:
        result.rows[0]
    });
  }
);

/* ======================================================
   AUDIT
====================================================== */

app.get(
  "/api/audit",
  auth,
  requireRole("admin"),
  async (req, res) => {
    const result =
      await db(`
        SELECT a.*,u.username
        FROM audit_logs a
        LEFT JOIN users u
        ON u.id=a.user_id
        ORDER BY a.created_at DESC
        LIMIT 500
      `);

    return success(res, {
      logs:
        result.rows
    });
  }
);

/* ======================================================
   WEBHOOKS
====================================================== */

app.get(
  "/api/webhooks",
  auth,
  requireRole("admin"),
  async (req, res) => {
    const result =
      await db(
        "SELECT id,name,url,event,active,created_at FROM webhooks"
      );

    return success(res, {
      webhooks:
        result.rows
    });
  }
);

app.post(
  "/api/webhooks",
  auth,
  requireRole("admin"),
  async (req, res) => {
    const {
      name,
      url,
      event = "*"
    } = req.body;

    if (!name || !url) {
      return error(
        res,
        "Name and URL required."
      );
    }

    const result =
      await db(
        `INSERT INTO webhooks
         (name,url,event)
         VALUES($1,$2,$3)
         RETURNING *`,
        [
          name,
          url,
          event
        ]
      );

    return success(res, {
      webhook:
        result.rows[0]
    });
  }
);

async function fireWebhook(
  event,
  payload
) {
  try {
    const result =
      await db(
        `SELECT * FROM webhooks
         WHERE active=true
         AND (event='*' OR event=$1)`,
        [event]
      );

    for (const webhook of result.rows) {
      fetch(webhook.url, {
        method: "POST",
        headers: {
          "content-type":
            "application/json"
        },
        body: JSON.stringify({
          event,
          timestamp:
            new Date().toISOString(),
          data: payload
        })
      }).catch(() => {});
    }
  } catch {}
}

/* ======================================================
   AI-LIKE HEALTH ANALYSIS
====================================================== */

app.get(
  "/api/health-analysis",
  auth,
  async (req, res) => {
    const servers =
      await db(
        "SELECT * FROM servers"
      );

    const analysis = [];

    for (const serverData of servers.rows) {
      let status =
        serverData.status;

      if (serverData.container_id) {
        status =
          await getContainerState(
            serverData.container_id
          );
      }

      let recommendation =
        "Server looks healthy.";

      if (
        status === "exited" ||
        status === "dead"
      ) {
        recommendation =
          "Server is stopped/crashed. Restart recommended.";
      }

      if (
        Number(serverData.memory_limit) <
        1024
      ) {
        recommendation +=
          " Memory allocation is low.";
      }

      analysis.push({
        id:
          serverData.id,
        name:
          serverData.name,
        status,
        recommendation
      });
    }

    return success(res, {
      analysis
    });
  }
);

/* ======================================================
   AUTOMATIC CRASH RECOVERY
====================================================== */

async function autoRecovery() {
  try {
    const result =
      await db(`
        SELECT * FROM servers
        WHERE auto_restart=true
        AND container_id IS NOT NULL
      `);

    for (const serverData of result.rows) {
      const state =
        await getContainerState(
          serverData.container_id
        );

      if (
        [
          "exited",
          "dead"
        ].includes(state)
      ) {
        try {
          await docker([
            "restart",
            serverData.container_id
          ]);

          await db(
            `UPDATE servers
             SET status='running'
             WHERE id=$1`,
            [serverData.id]
          );

          await fireWebhook(
            "server.recovered",
            {
              serverId:
                serverData.id,
              name:
                serverData.name
            }
          );

        } catch {}
      }
    }
  } catch {}
}

/* ======================================================
   AUTOMATIC BACKUPS
====================================================== */

async function scheduledBackups() {
  try {
    const result =
      await db(`
        SELECT bs.*,s.name AS server_name
        FROM backup_schedules bs
        JOIN servers s
        ON s.id=bs.server_id
        WHERE bs.enabled=true
      `);

    for (const schedule of result.rows) {
      const last =
        schedule.last_run
          ? new Date(
              schedule.last_run
            ).getTime()
          : 0;

      const due =
        Date.now() -
        last >=
        Number(
          schedule.interval_minutes
        ) *
          60 *
          1000;

      if (!due) continue;

      try {
        const serverData =
          await findServer(
            schedule.server_id
          );

        if (!serverData) continue;

        const name =
          `auto-${Date.now()}`;

        const source =
          serverDir(
            serverData.id
          );

        const destination =
          path.join(
            BACKUP_DIR,
            `${serverData.identifier}-${name}.tar.gz`
          );

        await new Promise(
          (resolve, reject) => {
            const child =
              spawn(
                "tar",
                [
                  "-czf",
                  destination,
                  "-C",
                  source,
                  "."
                ]
              );

            child.on(
              "error",
              reject
            );

            child.on(
              "close",
              code => {
                code === 0
                  ? resolve()
                  : reject(
                      new Error(
                        "Backup failed."
                      )
                    );
              }
            );
          }
        );

        const stat =
          await fsp.stat(
            destination
          );

        await db(
          `INSERT INTO backups
           (server_id,name,file_path,size)
           VALUES($1,$2,$3,$4)`,
          [
            serverData.id,
            name,
            destination,
            stat.size
          ]
        );

        await db(
          `UPDATE backup_schedules
           SET last_run=NOW()
           WHERE id=$1`,
          [schedule.id]
        );

        const backups =
          await db(
            `SELECT * FROM backups
             WHERE server_id=$1
             ORDER BY created_at DESC`,
            [serverData.id]
          );

        const retention =
          Number(
            schedule.retention || 7
          );

        for (
          let i = retention;
          i < backups.rows.length;
          i++
        ) {
          const old =
            backups.rows[i];

          try {
            await fsp.rm(
              old.file_path,
              {
                force: true
              }
            );
          } catch {}

          await db(
            "DELETE FROM backups WHERE id=$1",
            [old.id]
          );
        }

      } catch (err) {
        console.error(
          "Automatic backup:",
          err.message
        );
      }
    }
  } catch {}
}

/* ======================================================
   WEBSOCKET
====================================================== */

const wss =
  new WebSocketServer({
    server,
    path: "/ws"
  });

wss.on(
  "connection",
  async (ws, req) => {
    try {
      const url =
        new URL(
          req.url,
          `http://${req.headers.host}`
        );

      const token =
        url.searchParams.get(
          "token"
        );

      if (!token) {
        ws.close();
        return;
      }

      let user;

      try {
        user =
          jwt.verify(
            token,
            JWT_SECRET
          );
      } catch {
        ws.close();
        return;
      }

      ws.send(
        JSON.stringify({
          type: "connected",
          user
        })
      );

      const timer =
        setInterval(
          async () => {
            if (
              ws.readyState !== 1
            ) {
              clearInterval(
                timer
              );
              return;
            }

            try {
              const system = {
                cpu:
                  os.loadavg(),
                memory: {
                  total:
                    os.totalmem(),
                  free:
                    os.freemem(),
                  used:
                    os.totalmem() -
                    os.freemem()
                },
                uptime:
                  os.uptime()
              };

              ws.send(
                JSON.stringify({
                  type: "system",
                  data: system
                })
              );
            } catch {}
          },
          3000
        );

      ws.on(
        "close",
        () => {
          clearInterval(
            timer
          );
        }
      );

    } catch {
      ws.close();
    }
  }
);

/* ======================================================
   FRONTEND
====================================================== */

const HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport"
content="width=device-width,initial-scale=1">
<title>${PANEL_NAME}</title>

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

button,input,select,textarea{
 font:inherit;
}

button{
 cursor:pointer;
}

.login{
 min-height:100vh;
 display:flex;
 align-items:center;
 justify-content:center;
 padding:20px;
}

.login-box{
 width:100%;
 max-width:420px;
 background:#101622;
 border:1px solid #222b3d;
 border-radius:18px;
 padding:30px;
 box-shadow:0 20px 80px #0008;
}

.logo{
 font-size:28px;
 font-weight:900;
 margin-bottom:8px;
}

.muted{
 color:#8c98ab;
}

.input{
 width:100%;
 padding:14px;
 margin:8px 0;
 border:1px solid #2b3548;
 background:#080c14;
 color:#fff;
 border-radius:10px;
 outline:none;
}

.btn{
 border:0;
 border-radius:10px;
 padding:12px 16px;
 background:#5865f2;
 color:white;
 font-weight:700;
 margin:3px;
}

.btn.red{
 background:#ed4245;
}

.btn.green{
 background:#22c55e;
 color:#06100a;
}

.btn.gray{
 background:#273044;
}

.app{
 display:none;
 min-height:100vh;
}

.sidebar{
 position:fixed;
 left:0;
 top:0;
 bottom:0;
 width:240px;
 background:#0d121c;
 border-right:1px solid #20293a;
 padding:18px;
}

.sidebar h2{
 margin:0 0 25px;
}

.nav{
 width:100%;
 padding:12px;
 border:0;
 background:transparent;
 color:#aab4c5;
 text-align:left;
 border-radius:9px;
 margin:3px 0;
}

.nav:hover,
.nav.active{
 background:#182136;
 color:#fff;
}

.main{
 margin-left:240px;
 padding:25px;
}

.top{
 display:flex;
 justify-content:space-between;
 align-items:center;
 margin-bottom:20px;
 gap:10px;
}

.grid{
 display:grid;
 grid-template-columns:
 repeat(auto-fit,minmax(220px,1fr));
 gap:15px;
}

.card{
 background:#101622;
 border:1px solid #222b3d;
 border-radius:14px;
 padding:18px;
}

.stat{
 font-size:30px;
 font-weight:900;
 margin-top:10px;
}

.page{
 display:none;
}

.page.active{
 display:block;
}

.server{
 border:1px solid #263044;
 background:#111824;
 border-radius:14px;
 padding:16px;
 margin-bottom:12px;
}

.server-title{
 font-size:19px;
 font-weight:800;
}

.status{
 display:inline-block;
 padding:4px 9px;
 border-radius:20px;
 background:#243044;
 font-size:12px;
 margin:5px 0;
}

.status.running{
 background:#164e2a;
 color:#70ff9a;
}

.console{
 background:#05070b;
 color:#b8ffbf;
 min-height:350px;
 max-height:500px;
 overflow:auto;
 padding:15px;
 border-radius:10px;
 white-space:pre-wrap;
 font-family:monospace;
}

.table{
 width:100%;
 border-collapse:collapse;
}

.table th,
.table td{
 padding:10px;
 border-bottom:1px solid #253047;
 text-align:left;
}

@media(max-width:800px){
 .sidebar{
  position:relative;
  width:100%;
  height:auto;
 }

 .main{
  margin-left:0;
 }

 .nav{
  display:inline-block;
  width:auto;
 }

 .grid{
  grid-template-columns:1fr;
 }
}
</style>
</head>

<body>

<div id="login" class="login">
 <div class="login-box">
  <div class="logo">⚡ ALOOZ</div>
  <div class="muted">
   VPS Protector Panel
  </div>

  <input
   id="username"
   class="input"
   placeholder="Username">

  <input
   id="password"
   class="input"
   type="password"
   placeholder="Password">

  <button
   class="btn"
   style="width:100%;margin-top:10px"
   onclick="login()">
   Login
  </button>

  <div id="loginError"
   class="muted"
   style="margin-top:12px">
  </div>
 </div>
</div>

<div id="app" class="app">

<aside class="sidebar">

<h2>⚡ ALOOZ</h2>

<button class="nav active"
 onclick="page('dashboard',this)">
 Dashboard
</button>

<button class="nav"
 onclick="page('servers',this)">
 Servers
</button>

<button class="nav"
 onclick="page('console',this)">
 Console
</button>

<button class="nav"
 onclick="page('backups',this)">
 Backups
</button>

<button class="nav"
 onclick="page('files',this)">
 Files
</button>

<button class="nav"
 onclick="page('users',this)">
 Users
</button>

<button class="nav"
 onclick="page('nodes',this)">
 Nodes
</button>

<button class="nav"
 onclick="page('plans',this)">
 Plans
</button>

<button class="nav"
 onclick="page('audit',this)">
 Audit Logs
</button>

<button class="nav"
 onclick="logout()">
 Logout
</button>

</aside>

<main class="main">

<div class="top">
 <div>
  <h1 id="pageTitle">
   Dashboard
  </h1>
  <div class="muted">
   ${PANEL_NAME}
  </div>
 </div>

 <button class="btn gray"
 onclick="refreshAll()">
 Refresh
 </button>
</div>

<section id="dashboard"
 class="page active">

<div class="grid">

<div class="card">
 <div class="muted">CPU Cores</div>
 <div id="cpu"
 class="stat">-</div>
</div>

<div class="card">
 <div class="muted">RAM</div>
 <div id="ram"
 class="stat">-</div>
</div>

<div class="card">
 <div class="muted">Servers</div>
 <div id="serverCount"
 class="stat">-</div>
</div>

<div class="card">
 <div class="muted">Panel Uptime</div>
 <div id="uptime"
 class="stat">-</div>
</div>

</div>

<br>

<div class="card">
 <h3>System</h3>
 <pre id="system"></pre>
</div>

</section>

<section id="servers"
 class="page">

<div class="card">

<h3>Create Minecraft Server</h3>

<input id="serverName"
 class="input"
 placeholder="Server Name">

<input id="serverMemory"
 class="input"
 type="number"
 value="2048"
 placeholder="RAM MB">

<input id="serverPort"
 class="input"
 type="number"
 placeholder="Port">

<select id="serverType"
 class="input">
 <option>PAPER</option>
 <option>PURPUR</option>
 <option>VANILLA</option>
 <option>FABRIC</option>
 <option>FORGE</option>
</select>

<button class="btn green"
 onclick="createServer()">
 Create Server
</button>

</div>

<br>

<div id="serverList"></div>

</section>

<section id="console"
 class="page">

<div class="card">

<h3>Live Console</h3>

<select id="consoleServer"
 class="input"
 onchange="loadLogs()">
</select>

<div id="logs"
 class="console">
No logs.
</div>

<input
 id="command"
 class="input"
 placeholder="say Hello">

<button
 class="btn"
 onclick="sendCommand()">
 Send Command
</button>

</div>

</section>

<section id="backups"
 class="page">

<div class="card">

<h3>Backups</h3>

<select
 id="backupServer"
 class="input">
</select>

<button
 class="btn green"
 onclick="createBackup()">
 Create Backup
</button>

<div id="backupList"
 style="margin-top:15px">
</div>

</div>

</section>

<section id="files"
 class="page">

<div class="card">

<h3>File Manager</h3>

<select
 id="fileServer"
 class="input"
 onchange="loadFiles()">
</select>

<input
 id="filePath"
 class="input"
 value="">

<button
 class="btn"
 onclick="loadFiles()">
 Open
</button>

<div id="fileList"></div>

</div>

</section>

<section id="users"
 class="page">

<div class="card">

<h3>Create User</h3>

<input
 id="newUsername"
 class="input"
 placeholder="Username">

<input
 id="newEmail"
 class="input"
 placeholder="Email">

<input
 id="newPassword"
 class="input"
 placeholder="Password">

<select
 id="newRole"
 class="input">
 <option value="user">User</option>
 <option value="reseller">Reseller</option>
 <option value="admin">Admin</option>
</select>

<button
 class="btn green"
 onclick="createUser()">
 Create User
</button>

</div>

<br>

<div class="card">
 <div id="userList"></div>
</div>

</section>

<section id="nodes"
 class="page">

<div class="card">

<h3>Add Node</h3>

<input
 id="nodeName"
 class="input"
 placeholder="Node Name">

<input
 id="nodeAddress"
 class="input"
 placeholder="IP / Host">

<button
 class="btn green"
 onclick="createNode()">
 Add Node
</button>

</div>

<br>

<div id="nodeList"></div>

</section>

<section id="plans"
 class="page">

<div class="card">

<h3>Create Hosting Plan</h3>

<input
 id="planName"
 class="input"
 placeholder="Plan Name">

<input
 id="planPrice"
 class="input"
 type="number"
 placeholder="Price">

<input
 id="planMemory"
 class="input"
 type="number"
 value="2048"
 placeholder="RAM">

<input
 id="planDisk"
 class="input"
 type="number"
 value="10240"
 placeholder="Disk">

<button
 class="btn green"
 onclick="createPlan()">
 Create Plan
</button>

</div>

<br>

<div id="planList"></div>

</section>

<section id="audit"
 class="page">

<div class="card">

<h3>Audit Logs</h3>

<div id="auditList"></div>

</div>

</section>

</main>
</div>

<script>

let token =
 localStorage.getItem("alooz_token");

let servers = [];

async function api(
 url,
 options={}
){

 options.headers =
 options.headers || {};

 options.headers[
  "Content-Type"
 ] = "application/json";

 if(token){
  options.headers.Authorization =
   "Bearer " + token;
 }

 const res =
  await fetch(
   "/api" + url,
   options
  );

 const data =
  await res.json()
   .catch(() => ({
    success:false,
    error:"Invalid response"
   }));

 if(
  res.status === 401 &&
  token
 ){
  logout();
 }

 if(!res.ok){
  throw new Error(
   data.error ||
   "Request failed"
  );
 }

 return data;
}

async function login(){

 const username =
  document.getElementById(
   "username"
  ).value;

 const password =
  document.getElementById(
   "password"
  ).value;

 try{

  const data =
   await api(
    "/login",
    {
     method:"POST",
     body:JSON.stringify({
      username,
      password
     })
    }
   );

  token =
   data.token;

  localStorage.setItem(
   "alooz_token",
   token
  );

  showApp();

 }catch(err){

  document.getElementById(
   "loginError"
  ).textContent =
   err.message;

 }
}

function logout(){

 token = null;

 localStorage.removeItem(
  "alooz_token"
 );

 document.getElementById(
  "app"
 ).style.display="none";

 document.getElementById(
  "login"
 ).style.display="flex";
}

async function showApp(){

 document.getElementById(
  "login"
 ).style.display="none";

 document.getElementById(
  "app"
 ).style.display="block";

 await refreshAll();
}

function page(name, button){

 document
  .querySelectorAll(".page")
  .forEach(
   x => x.classList.remove(
    "active"
   )
  );

 document
  .getElementById(name)
  .classList.add(
   "active"
  );

 document
  .querySelectorAll(".nav")
  .forEach(
   x => x.classList.remove(
    "active"
   )
  );

 if(button){
  button.classList.add(
   "active"
  );
 }

 document.getElementById(
  "pageTitle"
 ).textContent =
  name.charAt(0).toUpperCase() +
  name.slice(1);

 if(name==="servers"){
  loadServers();
 }

 if(name==="console"){
  loadConsoleServers();
 }

 if(name==="backups"){
  loadBackupServers();
 }

 if(name==="files"){
  loadFileServers();
 }

 if(name==="users"){
  loadUsers();
 }

 if(name==="nodes"){
  loadNodes();
 }

 if(name==="plans"){
  loadPlans();
 }

 if(name==="audit"){
  loadAudit();
 }
}

async function refreshAll(){

 try{

  const system =
   await api("/system");

  document.getElementById(
   "cpu"
  ).textContent =
   system.cpu;

  const used =
   system.memory.used /
   1024 /
   1024 /
   1024;

  const total =
   system.memory.total /
   1024 /
   1024 /
   1024;

  document.getElementById(
   "ram"
  ).textContent =
   used.toFixed(1) +
   " / " +
   total.toFixed(1) +
   " GB";

  document.getElementById(
   "uptime"
  ).textContent =
   formatTime(
    system.panelUptime
  );

  document.getElementById(
   "system"
  ).textContent =
   JSON.stringify(
    system,
    null,
    2
   );

  await loadServers();

 }catch(err){

  console.error(err);

  if(!token){
   logout();
  }

 }
}

function formatTime(seconds){

 seconds =
  Math.floor(seconds);

 const d =
  Math.floor(
   seconds / 86400
  );

 seconds %= 86400;

 const h =
  Math.floor(
   seconds / 3600
  );

 seconds %= 3600;

 const m =
  Math.floor(
   seconds / 60
  );

 return (
  d + "d " +
  h + "h " +
  m + "m"
 );
}

/* SERVERS */

async function loadServers(){

 try{

  const data =
   await api(
    "/servers"
   );

  servers =
   data.servers || [];

  document.getElementById(
   "serverCount"
  ).textContent =
   servers.length;

  const box =
   document.getElementById(
    "serverList"
   );

  box.innerHTML =
   servers.map(
    s => \`
     <div class="server">

      <div class="server-title">
       \${escapeHtml(s.name)}
      </div>

      <span class="status \${s.status}">
       \${s.status}
      </span>

      <div class="muted">
       Port: \${s.port || "-"} |
       RAM: \${s.memory_limit} MB
      </div>

      <br>

      <button
       class="btn green"
       onclick="serverAction('\${s.id}','start')">
       Start
      </button>

      <button
       class="btn"
       onclick="serverAction('\${s.id}','restart')">
       Restart
      </button>

      <button
       class="btn gray"
       onclick="serverAction('\${s.id}','stop')">
       Stop
      </button>

      <button
       class="btn red"
       onclick="deleteServer('\${s.id}')">
       Delete
      </button>

     </div>
    \`
   ).join("");

 }catch(err){

  document.getElementById(
   "serverList"
  ).innerHTML =
   "<p>" +
   escapeHtml(err.message) +
   "</p>";

 }
}

async function createServer(){

 const name =
  document.getElementById(
   "serverName"
  ).value;

 const memory =
  Number(
   document.getElementById(
    "serverMemory"
   ).value
  );

 const port =
  Number(
   document.getElementById(
    "serverPort"
   ).value
  ) || undefined;

 const type =
  document.getElementById(
   "serverType"
  ).value;

 if(!name){
  alert("Server name required.");
  return;
 }

 try{

  await api(
   "/servers",
   {
    method:"POST",
    body:JSON.stringify({
     name,
     memory,
     port,
     type,
     version:"LATEST"
    })
   }
  );

  alert(
   "Server created successfully."
  );

  document.getElementById(
   "serverName"
  ).value="";

  await loadServers();

 }catch(err){

  alert(err.message);

 }
}

async function serverAction(
 id,
 action
){

 try{

  await api(
   "/servers/" +
   id +
   "/action",
   {
    method:"POST",
    body:JSON.stringify({
     action
    })
   }
  );

  await loadServers();

 }catch(err){

  alert(err.message);

 }
}

async function deleteServer(id){

 if(
  !confirm(
   "Delete this server?"
  )
 ){
  return;
 }

 try{

  await api(
   "/servers/" +
   id,
   {
    method:"DELETE"
   }
  );

  await loadServers();

 }catch(err){

  alert(err.message);

 }
}

/* CONSOLE */

async function loadConsoleServers(){

 const select =
  document.getElementById(
   "consoleServer"
  );

 select.innerHTML =
  servers.map(
   s =>
    \`<option value="\${s.id}">
      \${escapeHtml(s.name)}
     </option>\`
  ).join("");

 await loadLogs();
}

async function loadLogs(){

 const id =
  document.getElementById(
   "consoleServer"
  ).value;

 if(!id) return;

 try{

  const data =
   await api(
    "/servers/" +
    id +
    "/logs"
   );

  document.getElementById(
   "logs"
  ).textContent =
   data.logs || "No logs.";

 }catch(err){

  document.getElementById(
   "logs"
  ).textContent =
   err.message;

 }
}

async function sendCommand(){

 const id =
  document.getElementById(
   "consoleServer"
  ).value;

 const command =
  document.getElementById(
   "command"
  ).value;

 if(!command) return;

 try{

  await api(
   "/servers/" +
   id +
   "/command",
   {
    method:"POST",
    body:JSON.stringify({
     command
    })
   }
  );

  document.getElementById(
   "command"
  ).value="";

  setTimeout(
   loadLogs,
   500
  );

 }catch(err){

  alert(err.message);

 }
}

/* BACKUPS */

async function loadBackupServers(){

 const select =
  document.getElementById(
   "backupServer"
  );

 select.innerHTML =
  servers.map(
   s =>
    \`<option value="\${s.id}">
     \${escapeHtml(s.name)}
    </option>\`
  ).join("");

 await loadBackups();
}

async function loadBackups(){

 const id =
  document.getElementById(
   "backupServer"
  ).value;

 if(!id) return;

 try{

  const data =
   await api(
    "/servers/" +
    id +
    "/backups"
   );

  document.getElementById(
   "backupList"
  ).innerHTML =
   data.backups.map(
    b => \`
     <div class="server">
      <b>\${escapeHtml(b.name)}</b>
      <div class="muted">
       \${formatBytes(b.size)}
      </div>

      <button
       class="btn"
       onclick="downloadBackup('\${b.id}')">
       Download
      </button>

      <button
       class="btn green"
       onclick="restoreBackup('\${b.id}')">
       Restore
      </button>

      <button
       class="btn red"
       onclick="deleteBackup('\${b.id}')">
       Delete
      </button>
     </div>
    \`
   ).join("");

 }catch(err){

  console.error(err);

 }
}

async function createBackup(){

 const id =
  document.getElementById(
   "backupServer"
  ).value;

 try{

  await api(
   "/servers/" +
   id +
   "/backups",
   {
    method:"POST",
    body:JSON.stringify({
     name:
      "manual-" +
      Date.now()
    })
   }
  );

  await loadBackups();

 }catch(err){

  alert(err.message);

 }
}

function downloadBackup(id){

 window.open(
  "/api/backups/" +
  id +
  "/download?token=" +
  encodeURIComponent(token)
 );
}

async function restoreBackup(id){

 if(
  !confirm(
   "Restore this backup?"
  )
 ){
  return;
 }

 try{

  await api(
   "/backups/" +
   id +
   "/restore",
   {
    method:"POST"
   }
  );

  alert(
   "Backup restored."
  );

 }catch(err){

  alert(err.message);

 }
}

async function deleteBackup(id){

 if(
  !confirm(
   "Delete backup?"
  )
 ){
  return;
 }

 try{

  await api(
   "/backups/" +
   id,
   {
    method:"DELETE"
   }
  );

  await loadBackups();

 }catch(err){

  alert(err.message);

 }
}

/* FILES */

async function loadFileServers(){

 const select =
  document.getElementById(
   "fileServer"
  );

 select.innerHTML =
  servers.map(
   s =>
    \`<option value="\${s.id}">
     \${escapeHtml(s.name)}
    </option>\`
  ).join("");

 await loadFiles();
}

async function loadFiles(){

 const id =
  document.getElementById(
   "fileServer"
  ).value;

 const p =
  document.getElementById(
   "filePath"
  ).value;

 if(!id) return;

 try{

  const data =
   await api(
    "/servers/" +
    id +
    "/files?path=" +
    encodeURIComponent(p)
   );

  document.getElementById(
   "fileList"
  ).innerHTML =
   data.files.map(
    f => \`
     <div class="server">
      <b>
       \${f.type==="directory" ? "📁" : "📄"}
       \${escapeHtml(f.name)}
      </b>

      <div class="muted">
       \${formatBytes(f.size)}
      </div>

      <button
       class="btn"
       onclick="openFile(
        '\${escapeJs(f.name)}',
        '\${f.type}'
       )">
       Open
      </button>

      <button
       class="btn red"
       onclick="deleteFile(
        '\${escapeJs(f.name)}'
       )">
       Delete
      </button>
     </div>
    \`
   ).join("");

 }catch(err){

  alert(err.message);

 }
}

async function openFile(name,type){

 const current =
  document.getElementById(
   "filePath"
  ).value;

 const newPath =
  current
   ? current + "/" + name
   : name;

 if(type==="directory"){

  document.getElementById(
   "filePath"
  ).value =
   newPath;

  loadFiles();

  return;
 }

 const id =
  document.getElementById(
   "fileServer"
  ).value;

 try{

  const data =
   await api(
    "/servers/" +
    id +
    "/file?path=" +
    encodeURIComponent(
     newPath
    )
   );

  const content =
   prompt(
    "Edit file:",
    data.content
   );

  if(content !== null){

   await api(
    "/servers/" +
    id +
    "/file",
    {
     method:"PUT",
     body:JSON.stringify({
      path:newPath,
      content
     })
    }
   );

  }

 }catch(err){

  alert(err.message);

 }
}

async function deleteFile(name){

 const id =
  document.getElementById(
   "fileServer"
  ).value;

 const current =
  document.getElementById(
   "filePath"
  ).value;

 const p =
  current
   ? current + "/" + name
   : name;

 if(
  !confirm(
   "Delete " + p + "?"
  )
 ){
  return;
 }

 try{

  await api(
   "/servers/" +
   id +
   "/file",
   {
    method:"DELETE",
    body:JSON.stringify({
     path:p
    })
   }
  );

  loadFiles();

 }catch(err){

  alert(err.message);

 }
}

/* USERS */

async function loadUsers(){

 try{

  const data =
   await api(
    "/users"
   );

  document.getElementById(
   "userList"
  ).innerHTML =
   \`
   <table class="table">
   <tr>
    <th>Username</th>
    <th>Role</th>
    <th>Status</th>
   </tr>
   \` +
   data.users.map(
    u => \`
     <tr>
      <td>\${escapeHtml(u.username)}</td>
      <td>\${u.role}</td>
      <td>
       \${u.active ? "Active" : "Disabled"}
      </td>
     </tr>
    \`
   ).join("") +
   "</table>";

 }catch(err){

  alert(err.message);

 }
}

async function createUser(){

 const username =
  document.getElementById(
   "newUsername"
  ).value;

 const email =
  document.getElementById(
   "newEmail"
  ).value;

 const password =
  document.getElementById(
   "newPassword"
  ).value;

 const role =
  document.getElementById(
   "newRole"
  ).value;

 try{

  await api(
   "/users",
   {
    method:"POST",
    body:JSON.stringify({
     username,
     email,
     password,
     role
    })
   }
  );

  await loadUsers();

  alert(
   "User created."
  );

 }catch(err){

  alert(err.message);

 }
}

/* NODES */

async function loadNodes(){

 try{

  const data =
   await api(
    "/nodes"
   );

  document.getElementById(
   "nodeList"
  ).innerHTML =
   data.nodes.map(
    n => \`
     <div class="server">
      <b>\${escapeHtml(n.name)}</b>
      <div class="muted">
       \${escapeHtml(n.address || "-")}
      </div>
      <div>
       Status:
       \${n.status}
       |
       Servers:
       \${n.server_count}
      </div>
     </div>
    \`
   ).join("");

 }catch(err){

  alert(err.message);

 }
}

async function createNode(){

 const name =
  document.getElementById(
   "nodeName"
  ).value;

 const address =
  document.getElementById(
   "nodeAddress"
  ).value;

 try{

  await api(
   "/nodes",
   {
    method:"POST",
    body:JSON.stringify({
     name,
     address
    })
   }
  );

  await loadNodes();

 }catch(err){

  alert(err.message);

 }
}

/* PLANS */

async function loadPlans(){

 try{

  const data =
   await api(
    "/plans"
   );

  document.getElementById(
   "planList"
  ).innerHTML =
   data.plans.map(
    p => \`
     <div class="server">
      <b>\${escapeHtml(p.name)}</b>
      <div>
       Price: \${p.price}
      </div>
      <div class="muted">
       RAM: \${p.memory} MB |
       Disk: \${p.disk} MB |
       CPU: \${p.cpu}%
      </div>
     </div>
    \`
   ).join("");

 }catch(err){

  alert(err.message);

 }
}

async function createPlan(){

 const name =
  document.getElementById(
   "planName"
  ).value;

 const price =
  Number(
   document.getElementById(
    "planPrice"
   ).value
  );

 const memory =
  Number(
   document.getElementById(
    "planMemory"
   ).value
  );

 const disk =
  Number(
   document.getElementById(
    "planDisk"
   ).value
  );

 try{

  await api(
   "/plans",
   {
    method:"POST",
    body:JSON.stringify({
     name,
     price,
     memory,
     disk
    })
   }
  );

  await loadPlans();

 }catch(err){

  alert(err.message);

 }
}

/* AUDIT */

async function loadAudit(){

 try{

  const data =
   await api(
    "/audit"
   );

  document.getElementById(
   "auditList"
  ).innerHTML =
   data.logs.map(
    x => \`
     <div class="server">
      <b>
       \${escapeHtml(x.action)}
      </b>

      <div class="muted">
       \${x.username || "system"}
       |
       \${new Date(
        x.created_at
       ).toLocaleString()}
      </div>

      <pre>
\${escapeHtml(
 JSON.stringify(
  x.details,
  null,
  2
 )
)}
      </pre>
     </div>
    \`
   ).join("");

 }catch(err){

  alert(err.message);

 }
}

/* HELPERS */

function formatBytes(bytes){

 bytes =
  Number(bytes || 0);

 if(bytes < 1024)
  return bytes + " B";

 if(bytes < 1024*1024)
  return (
   (bytes/1024)
    .toFixed(1) +
   " KB"
  );

 if(bytes < 1024*1024*1024)
  return (
   (bytes/1024/1024)
    .toFixed(1) +
   " MB"
  );

 return (
  (bytes/1024/1024/1024)
   .toFixed(1) +
  " GB"
 );
}

function escapeHtml(value){

 return String(value ?? "")
  .replaceAll("&","&amp;")
  .replaceAll("<","&lt;")
  .replaceAll(">","&gt;")
  .replaceAll('"',"&quot;")
  .replaceAll("'","&#039;");
}

function escapeJs(value){

 return String(value ?? "")
  .replaceAll("\\\\","\\\\\\\\")
  .replaceAll("'","\\\\'");
}

/* AUTO REFRESH */

setInterval(
 () => {
  if(token){
   refreshAll();
  }
 },
  15000
);

if(token){
 showApp();
}

</script>

</body>
</html>`;

/* ======================================================
   SPA ROUTING
====================================================== */

app.get(
  "/",
  (req, res) => {
    res.type("html").send(HTML);
  }
);

app.use(
  (req, res, next) => {

    if (
      req.path.startsWith("/api/")
    ) {
      return next();
    }

    if (
      req.path.startsWith("/assets/")
    ) {
      return next();
    }

    res.type("html").send(HTML);
  }
);

/* ======================================================
   ERROR HANDLER
====================================================== */

app.use(
  (err, req, res, next) => {
    console.error(err);

    if (res.headersSent) {
      return next(err);
    }

    return error(
      res,
      err.message ||
      "Internal server error.",
      500
    );
  }
);

/* ======================================================
   START
====================================================== */

async function start(){

  console.log("");
  console.log("====================================");
  console.log("       ALOOZ VPS PROTECTOR");
  console.log("====================================");
  console.log("");

  await waitForDatabase();
  await migrate();

  server.listen(
    PORT,
    HOST,
    () => {
      console.log(
        `ALOOZ Panel running on ${HOST}:${PORT}`
      );

      console.log(
        `Admin username: ${ADMIN_USERNAME}`
      );

      console.log(
        "Panel ready."
      );
    }
  );

  setInterval(
    autoRecovery,
    30000
  );

  setInterval(
    scheduledBackups,
    60000
  );
}

process.on(
  "SIGTERM",
  async () => {
    await pool.end();
    process.exit(0);
  }
);

process.on(
  "SIGINT",
  async () => {
    await pool.end();
    process.exit(0);
  }
);

start().catch(err => {
  console.error(
    "FATAL:",
    err
  );
  process.exit(1);
});
