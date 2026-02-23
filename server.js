const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
require("dotenv").config();

let createClient = null;
try {
  ({ createClient } = require("@supabase/supabase-js"));
} catch {
  createClient = null;
}

let nodemailer = null;
try {
  nodemailer = require("nodemailer");
} catch {
  nodemailer = null;
}

const app = express();
const PORT = Number(process.env.PORT || 8787);
const APP_STATE_KEY = process.env.APP_STATE_KEY || "move-well-default";

const SQUARE_ENV = (process.env.SQUARE_ENV || "sandbox").toLowerCase();
const SQUARE_BASE =
  process.env.SQUARE_BASE_URL ||
  (SQUARE_ENV === "production" ? "https://connect.squareup.com" : "https://connect.squareupsandbox.com");
const SQUARE_CLIENT_ID = process.env.SQUARE_CLIENT_ID || "";
const SQUARE_CLIENT_SECRET = process.env.SQUARE_CLIENT_SECRET || "";
const REDIRECT_URI = process.env.SQUARE_REDIRECT_URI || `http://localhost:${PORT}/api/square/oauth/callback`;
const TOKEN_FILE = path.join(__dirname, "data", "square-token.json");
const STATE_FILE = path.join(__dirname, "data", "app-state.json");
const SQUARE_VERSION = process.env.SQUARE_VERSION || "2025-10-16";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase =
  createClient && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

const oauthStates = new Set();
const clientPortalSessions = new Map();
const CLIENT_PORTAL_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const adminSessions = new Map();
const ADMIN_SESSION_TTL_MS = 1000 * 60 * 60 * 12;
const ADMIN_USERS = (() => {
  const raw = process.env.ADMIN_USERS_JSON || "";
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        email: String(item?.email || "").trim().toLowerCase(),
        password: String(item?.password || ""),
      }))
      .filter((item) => item.email && item.password);
  } catch {
    return [];
  }
})();

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || SMTP_USER || "";
const INQUIRY_TO_EMAIL = process.env.INQUIRY_TO_EMAIL || "shane@movewellseattle.com";
const INQUIRY_WEBHOOK_URL = process.env.INQUIRY_WEBHOOK_URL || "";

app.use(express.json({ limit: "50mb" }));
app.use(express.static(__dirname));

function hasSupabase() {
  return !!supabase;
}

function readStateFromFile() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeStateToFile(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state || {}, null, 2));
}

function normalizePhoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function getPersistedStateShape(state) {
  return {
    clients: Array.isArray(state?.clients) ? state.clients : [],
    packages: Array.isArray(state?.packages) ? state.packages : [],
    homework: Array.isArray(state?.homework) ? state.homework : [],
    settings: state?.settings && typeof state.settings === "object" ? state.settings : {},
  };
}

function scoreClientForPortal(state, clientId) {
  const packageCount = state.packages.filter((item) => item.clientId === clientId).length;
  const homeworkCount = state.homework.filter((item) => item.clientId === clientId).length;
  const visitCount = Array.isArray(state.visits) ? state.visits.filter((item) => item.clientId === clientId).length : 0;
  return packageCount * 100 + homeworkCount * 10 + visitCount;
}

function computePackageExpiresAt(pkg, settings) {
  if (!pkg || pkg.neverExpires) return null;
  if (!pkg.purchaseDate) return pkg.expiresAt || null;
  const validityDays = Number(settings?.validityDays || 0);
  if (!Number.isFinite(validityDays) || validityDays <= 0) return null;
  const expiresAt = new Date(pkg.purchaseDate);
  expiresAt.setDate(expiresAt.getDate() + validityDays);
  return expiresAt.toISOString().slice(0, 10);
}

function cleanupClientPortalSessions() {
  const now = Date.now();
  for (const [token, value] of clientPortalSessions.entries()) {
    if (!value || value.expiresAt <= now) clientPortalSessions.delete(token);
  }
}

function cleanupAdminSessions() {
  const now = Date.now();
  for (const [token, value] of adminSessions.entries()) {
    if (!value || value.expiresAt <= now) adminSessions.delete(token);
  }
}

function smtpConfigured() {
  return !!(nodemailer && SMTP_HOST && SMTP_PORT && SMTP_USER && SMTP_PASS && SMTP_FROM && INQUIRY_TO_EMAIL);
}

function webhookConfigured() {
  return /^https?:\/\//i.test(INQUIRY_WEBHOOK_URL);
}

async function sendNewClientInquiryWebhook(payload) {
  if (!webhookConfigured()) {
    throw new Error("Inquiry webhook is not configured.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(INQUIRY_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        source: "move-well-client-portal",
        submittedAt: new Date().toISOString(),
        inquiry: payload,
      }),
    });
    if (!res.ok) {
      throw new Error(`Webhook request failed (${res.status}).`);
    }
  } catch (err) {
    if (err?.name === "AbortError") {
      throw new Error("Inquiry webhook timed out.");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function sendNewClientInquiryEmail(payload) {
  if (webhookConfigured()) {
    await sendNewClientInquiryWebhook(payload);
    return;
  }
  if (smtpConfigured()) {
    const transporter = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
      auth: {
        user: SMTP_USER,
        pass: SMTP_PASS,
      },
    });

    const lines = [
      "New Client Request",
      "",
      `Name: ${payload.name}`,
      `Email: ${payload.email}`,
      `Phone: ${payload.phone}`,
      `How did you hear about Move Well?: ${payload.referral}`,
      `What would you like help with?: ${payload.helpWith}`,
      "",
      `Submitted at: ${new Date().toLocaleString()}`,
    ];

    const sendPromise = transporter.sendMail({
      from: SMTP_FROM,
      to: INQUIRY_TO_EMAIL,
      subject: "New Client Request",
      text: lines.join("\n"),
      replyTo: payload.email,
    });
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("SMTP request timed out. Please check SMTP settings and try again.")), 20000);
    });
    await Promise.race([sendPromise, timeoutPromise]);
    return;
  }
  throw new Error("No inquiry delivery method configured. Set INQUIRY_WEBHOOK_URL (recommended) or SMTP settings.");
}

async function verifySmtpConnection() {
  if (!smtpConfigured()) {
    throw new Error("SMTP is not configured.");
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
  await transporter.verify();
}

function requireAdminAuth(req, res, next) {
  cleanupAdminSessions();
  const token = String(req.headers["x-admin-token"] || "");
  if (!token) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }
  const session = adminSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    adminSessions.delete(token);
    res.status(401).json({ error: "Session expired. Please log in again." });
    return;
  }
  req.adminEmail = session.email;
  next();
}

async function readAppState() {
  if (!hasSupabase()) return readStateFromFile();
  const { data, error } = await supabase
    .from("app_states")
    .select("state")
    .eq("id", APP_STATE_KEY)
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    throw error;
  }
  return data?.state || null;
}

async function writeAppState(state) {
  if (!hasSupabase()) {
    writeStateToFile(state);
    return;
  }
  const { error } = await supabase
    .from("app_states")
    .upsert({ id: APP_STATE_KEY, state, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw error;
}

function readTokenFromFile() {
  try {
    if (!fs.existsSync(TOKEN_FILE)) return null;
    return JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
  } catch {
    return null;
  }
}

function writeTokenToFile(token) {
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2));
}

function clearTokenFile() {
  if (fs.existsSync(TOKEN_FILE)) fs.unlinkSync(TOKEN_FILE);
}

async function readSquareToken() {
  if (!hasSupabase()) return readTokenFromFile();
  const { data, error } = await supabase
    .from("app_integrations")
    .select("square_token")
    .eq("id", APP_STATE_KEY)
    .maybeSingle();

  if (error && error.code !== "PGRST116") {
    throw error;
  }
  return data?.square_token || null;
}

async function writeSquareToken(token) {
  if (!hasSupabase()) {
    writeTokenToFile(token);
    return;
  }
  const { error } = await supabase
    .from("app_integrations")
    .upsert({ id: APP_STATE_KEY, square_token: token, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw error;
}

async function clearSquareToken() {
  if (!hasSupabase()) {
    clearTokenFile();
    return;
  }
  const { error } = await supabase
    .from("app_integrations")
    .upsert({ id: APP_STATE_KEY, square_token: null, updated_at: new Date().toISOString() }, { onConflict: "id" });
  if (error) throw error;
}

function ensureSquareConfigured(res) {
  if (!SQUARE_CLIENT_ID || !SQUARE_CLIENT_SECRET) {
    res
      .status(500)
      .json({ error: "Square is not configured. Add SQUARE_CLIENT_ID and SQUARE_CLIENT_SECRET in environment." });
    return false;
  }
  return true;
}

app.get("/api/health", async (req, res) => {
  res.json({
    ok: true,
    supabase: hasSupabase(),
    squareConfigured: !!(SQUARE_CLIENT_ID && SQUARE_CLIENT_SECRET),
    adminAuthConfigured: ADMIN_USERS.length > 0,
    smtpConfigured: smtpConfigured(),
    inquiryWebhookConfigured: webhookConfigured(),
    inquiryDelivery: webhookConfigured() ? "webhook" : smtpConfigured() ? "smtp" : "none",
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/diagnostics/smtp", (req, res) => {
  res.json({
    inquiryDelivery: webhookConfigured() ? "webhook" : smtpConfigured() ? "smtp" : "none",
    webhookConfigured: webhookConfigured(),
    smtpConfigured: smtpConfigured(),
    checks: {
      INQUIRY_WEBHOOK_URL: webhookConfigured(),
      nodemailerLoaded: !!nodemailer,
      SMTP_HOST: !!SMTP_HOST,
      SMTP_PORT: !!SMTP_PORT,
      SMTP_USER: !!SMTP_USER,
      SMTP_PASS: !!SMTP_PASS,
      SMTP_FROM: !!SMTP_FROM,
      INQUIRY_TO_EMAIL: !!INQUIRY_TO_EMAIL,
    },
  });
});

app.get("/api/diagnostics/smtp-test", async (req, res) => {
  try {
    await verifySmtpConnection();
    res.json({ ok: true, message: "SMTP connection and authentication succeeded." });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message || "SMTP test failed." });
  }
});

app.post("/api/admin/login", (req, res) => {
  const { email, password } = req.body || {};
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const rawPassword = String(password || "");

  if (!normalizedEmail || !rawPassword) {
    res.status(400).json({ error: "Email and password are required." });
    return;
  }

  if (ADMIN_USERS.length === 0) {
    res.status(500).json({ error: "Admin login is not configured on this server." });
    return;
  }

  const user = ADMIN_USERS.find((item) => item.email === normalizedEmail && item.password === rawPassword);
  if (!user) {
    res.status(401).json({ error: "Invalid email or password." });
    return;
  }

  cleanupAdminSessions();
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAt = Date.now() + ADMIN_SESSION_TTL_MS;
  adminSessions.set(token, { email: user.email, expiresAt });
  res.json({ token, expiresAt: new Date(expiresAt).toISOString(), email: user.email });
});

app.get("/api/admin/session", requireAdminAuth, (req, res) => {
  res.json({ ok: true, email: req.adminEmail });
});

app.post("/api/admin/logout", requireAdminAuth, (req, res) => {
  const token = String(req.headers["x-admin-token"] || "");
  adminSessions.delete(token);
  res.json({ ok: true });
});

app.get("/api/state", requireAdminAuth, async (req, res) => {
  try {
    const state = await readAppState();
    res.json({ state });
  } catch (err) {
    res.status(500).json({ error: `Failed to read cloud state: ${err.message}` });
  }
});

app.put("/api/state", requireAdminAuth, async (req, res) => {
  try {
    const { state } = req.body || {};
    if (!state || typeof state !== "object") {
      res.status(400).json({ error: "Body must include an object field named 'state'." });
      return;
    }
    await writeAppState(state);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Failed to write cloud state: ${err.message}` });
  }
});

app.post("/api/client-portal/login", async (req, res) => {
  try {
    const { email, phoneLast4 } = req.body || {};
    const normalizedEmail = String(email || "").trim().toLowerCase();
    const normalizedLast4 = normalizePhoneDigits(phoneLast4).slice(-4);

    if (!normalizedEmail || normalizedLast4.length !== 4) {
      res.status(400).json({ error: "Email and 4-digit phone check are required." });
      return;
    }

    const state = getPersistedStateShape(await readAppState());
    const emailMatches = state.clients.filter((c) => String(c.email || "").trim().toLowerCase() === normalizedEmail);
    if (emailMatches.length === 0) {
      res.status(401).json({ error: "Login not found. Please check your details." });
      return;
    }

    const phoneMatches = emailMatches.filter((client) => {
      const clientPhone = normalizePhoneDigits(client.phone || "");
      return clientPhone && clientPhone.slice(-4) === normalizedLast4;
    });

    if (phoneMatches.length === 0) {
      res.status(401).json({ error: "Login not found. Please check your details." });
      return;
    }

    const client = phoneMatches
      .slice()
      .sort((a, b) => scoreClientForPortal(state, b.id) - scoreClientForPortal(state, a.id))[0];

    cleanupClientPortalSessions();
    const token = crypto.randomBytes(24).toString("hex");
    clientPortalSessions.set(token, {
      clientId: client.id,
      expiresAt: Date.now() + CLIENT_PORTAL_SESSION_TTL_MS,
    });

    res.json({ token, expiresAt: new Date(Date.now() + CLIENT_PORTAL_SESSION_TTL_MS).toISOString() });
  } catch (err) {
    res.status(500).json({ error: `Failed to login: ${err.message}` });
  }
});

app.get("/api/client-portal/me", async (req, res) => {
  try {
    cleanupClientPortalSessions();
    const token = String(req.query.token || "");
    if (!token) {
      res.status(401).json({ error: "Missing session token." });
      return;
    }

    const session = clientPortalSessions.get(token);
    if (!session || session.expiresAt <= Date.now()) {
      res.status(401).json({ error: "Session expired. Please sign in again." });
      return;
    }

    const state = getPersistedStateShape(await readAppState());
    const client = state.clients.find((c) => c.id === session.clientId);
    if (!client) {
      clientPortalSessions.delete(token);
      res.status(401).json({ error: "Client account unavailable." });
      return;
    }

    const packages = state.packages
      .filter((pkg) => pkg.clientId === client.id)
      .map((pkg) => {
        const sessionsTotal = Number(pkg.sessionsTotal || 0);
        const sessionsUsed = Number(pkg.sessionsUsed || 0);
        return {
          id: pkg.id,
          type: pkg.type,
          purchaseDate: pkg.purchaseDate,
          expiresAt: computePackageExpiresAt(pkg, state.settings),
          sessionsTotal,
          sessionsUsed,
          sessionsRemaining: Math.max(0, sessionsTotal - sessionsUsed),
          neverExpires: !!pkg.neverExpires,
        };
      })
      .sort((a, b) => new Date(b.purchaseDate || 0) - new Date(a.purchaseDate || 0));

    const homework = state.homework
      .filter((item) => item.clientId === client.id)
      .map((item) => ({
        id: item.id,
        title: item.title || "Homework",
        notes: item.notes || item.instructorNotes || "",
        updatedAt: item.updatedAt || item.createdAt || null,
        done: !!item.done,
        videos: Array.isArray(item.videos) ? item.videos : [],
      }))
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

    res.json({
      client: {
        id: client.id,
        name: client.name || "Client",
        email: client.email || "",
        phone: client.phone || "",
      },
      packages,
      homework,
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to load portal data: ${err.message}` });
  }
});

app.post("/api/client-portal/new-client-request", async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim();
    const phone = String(req.body?.phone || "").trim();
    const referral = String(req.body?.referral || "").trim();
    const helpWith = String(req.body?.helpWith || "").trim();

    if (!name || !email || !phone || !referral || !helpWith) {
      res.status(400).json({ error: "All fields are required." });
      return;
    }

    const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailPattern.test(email)) {
      res.status(400).json({ error: "Please provide a valid email." });
      return;
    }

    await sendNewClientInquiryEmail({ name, email, phone, referral, helpWith });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: `Failed to send inquiry: ${err.message}` });
  }
});

app.get("/api/square/status", requireAdminAuth, async (req, res) => {
  try {
    const token = await readSquareToken();
    res.json({
      connected: !!token?.accessToken,
      merchantId: token?.merchantId || null,
      environment: SQUARE_ENV,
    });
  } catch (err) {
    res.status(500).json({ error: `Failed to read Square status: ${err.message}` });
  }
});

app.get("/api/square/oauth/start", requireAdminAuth, (req, res) => {
  if (!ensureSquareConfigured(res)) return;
  const state = crypto.randomBytes(16).toString("hex");
  oauthStates.add(state);

  const params = new URLSearchParams({
    client_id: SQUARE_CLIENT_ID,
    response_type: "code",
    scope: "PAYMENTS_READ",
    state,
    session: "false",
    redirect_uri: REDIRECT_URI,
  });

  res.json({ authorizeUrl: `${SQUARE_BASE}/oauth2/authorize?${params.toString()}` });
});

app.get("/api/square/oauth/callback", async (req, res) => {
  try {
    if (!ensureSquareConfigured(res)) return;
    const { code, state } = req.query;
    if (!code || !state || !oauthStates.has(state)) {
      res.status(400).send("Invalid OAuth response.");
      return;
    }
    oauthStates.delete(state);

    const tokenRes = await fetch(`${SQUARE_BASE}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SQUARE_CLIENT_ID,
        client_secret: SQUARE_CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok) {
      res.status(500).send(`Square token exchange failed: ${tokenData.message || "unknown error"}`);
      return;
    }

    await writeSquareToken({
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      merchantId: tokenData.merchant_id,
      expiresAt: tokenData.expires_at,
      obtainedAt: new Date().toISOString(),
    });

    res.redirect("/?square=connected");
  } catch (err) {
    res.status(500).send(`OAuth callback failed: ${err.message}`);
  }
});

app.post("/api/square/disconnect", requireAdminAuth, async (req, res) => {
  if (!ensureSquareConfigured(res)) return;
  let token;
  try {
    token = await readSquareToken();
  } catch (err) {
    res.status(500).json({ error: `Failed to read Square token: ${err.message}` });
    return;
  }

  if (!token?.accessToken) {
    res.json({ ok: true });
    return;
  }

  try {
    await fetch(`${SQUARE_BASE}/oauth2/revoke`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: SQUARE_CLIENT_ID,
        access_token: token.accessToken,
      }),
    });
  } catch {
    // no-op
  }

  try {
    await clearSquareToken();
  } catch (err) {
    res.status(500).json({ error: `Failed to clear Square token: ${err.message}` });
    return;
  }

  res.json({ ok: true });
});

app.get("/api/square/payments", requireAdminAuth, async (req, res) => {
  let token;
  try {
    token = await readSquareToken();
  } catch (err) {
    res.status(500).json({ error: `Failed to read Square token: ${err.message}` });
    return;
  }

  if (!token?.accessToken) {
    res.status(401).json({ error: "Square is not connected." });
    return;
  }

  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 25)));
  const daysBack = Math.max(1, Math.min(90, Number(req.query.daysBack || 30)));
  const begin = new Date(Date.now() - daysBack * 86400000).toISOString();

  const params = new URLSearchParams({
    sort_order: "DESC",
    limit: String(limit),
    begin_time: begin,
  });
  if (req.query.cursor) params.set("cursor", String(req.query.cursor));

  try {
    const paymentRes = await fetch(`${SQUARE_BASE}/v2/payments?${params.toString()}`, {
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        "Square-Version": SQUARE_VERSION,
      },
    });

    const payload = await paymentRes.json();
    if (!paymentRes.ok) {
      res.status(500).json({ error: payload?.errors?.[0]?.detail || "Failed to fetch payments from Square." });
      return;
    }

    const payments = (payload.payments || []).filter((p) => p.status === "COMPLETED");
    res.json({ payments, cursor: payload.cursor || null });
  } catch (err) {
    res.status(500).json({ error: `Square request failed: ${err.message}` });
  }
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, () => {
  console.log(`Move Well tracker running on http://localhost:${PORT}`);
  if (!hasSupabase()) {
    console.log("Supabase not configured. Cloud sync disabled; using local token fallback.");
  }
});
