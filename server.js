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
const SQUARE_VERSION = process.env.SQUARE_VERSION || "2025-10-16";

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const supabase =
  createClient && SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
    ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
    : null;

const oauthStates = new Set();

app.use(express.json({ limit: "50mb" }));
app.use(express.static(__dirname));

function hasSupabase() {
  return !!supabase;
}

async function readAppState() {
  if (!hasSupabase()) return null;
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
  if (!hasSupabase()) return;
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
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/state", async (req, res) => {
  try {
    const state = await readAppState();
    res.json({ state });
  } catch (err) {
    res.status(500).json({ error: `Failed to read cloud state: ${err.message}` });
  }
});

app.put("/api/state", async (req, res) => {
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

app.get("/api/square/status", async (req, res) => {
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

app.get("/api/square/oauth/start", (req, res) => {
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

app.post("/api/square/disconnect", async (req, res) => {
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

app.get("/api/square/payments", async (req, res) => {
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
