const PACKAGE_TYPES = [
  { key: "single", label: "Single Session", sessions: 1 },
  { key: "five", label: "5-Session Package", sessions: 5 },
  { key: "ten", label: "10-Session Package", sessions: 10 },
  { key: "semiSingle", label: "Single Session Semi Private", sessions: 1 },
  { key: "semiTen", label: "10-Session Semi Private", sessions: 10 },
];

const STORAGE_KEY = "moveWellClientTrackerV2";
const ADMIN_TOKEN_KEY = "moveWellAdminToken";
const PACIFIC_TIMEZONE = "America/Los_Angeles";
let cloudSyncEnabled = true;
let cloudSaveTimer = null;
const TAB_LABELS = {
  overview: "Overview",
  visits: "Visits",
  packages: "Packages",
  homework: "Homework",
  files: "Files",
};

const TOP_PAGES = {
  clients: "Clients",
  resources: "Resources",
  settings: "Settings",
};

const appState = {
  clients: [],
  visits: [],
  posturalAnalyses: [],
  files: [],
  resources: [],
  resourceShares: [],
  packages: [],
  homework: [],
  settings: {
    taxRate: 10.55,
    validityDays: 90,
    neverExpiresDefault: false,
    prices: {
      single: 115,
      five: 500,
      ten: 950,
      semiSingle: 75,
      semiTen: 680,
    },
    squareIgnoredPaymentIds: [],
  },
  selectedClientId: null,
  square: {
    connected: false,
    merchantId: null,
    environment: null,
    statusMessage: "",
    recentPayments: [],
  },
  ui: {
    visitFilters: {},
    visitCursor: {},
    posturalFilters: {},
    posturalCursor: {},
    activeTab: "overview",
    topPage: "clients",
    resourceSelection: [],
  },
  runtime: {
    version: "",
    service: "",
    environment: "",
  },
};

function readAdminToken() {
  return sessionStorage.getItem(ADMIN_TOKEN_KEY) || localStorage.getItem(ADMIN_TOKEN_KEY) || "";
}

function persistAdminToken(token) {
  sessionStorage.setItem(ADMIN_TOKEN_KEY, token);
  localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

function clearAdminToken() {
  sessionStorage.removeItem(ADMIN_TOKEN_KEY);
  localStorage.removeItem(ADMIN_TOKEN_KEY);
}

let adminToken = readAdminToken();
let pendingSessionUsePackageId = null;
let pendingSessionDateEdit = null;
let pendingSessionUndoPackageId = null;
let healthPollTimer = null;

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function loadState() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (!saved) return;
  try {
    const parsed = JSON.parse(saved);
    Object.assign(appState, parsed);
    if (!appState.ui) appState.ui = {};
    if (!appState.ui.visitFilters) appState.ui.visitFilters = {};
    if (!appState.ui.visitCursor) appState.ui.visitCursor = {};
    if (!appState.ui.posturalFilters) appState.ui.posturalFilters = {};
    if (!appState.ui.posturalCursor) appState.ui.posturalCursor = {};
    if (!TAB_LABELS[appState.ui.activeTab]) appState.ui.activeTab = "overview";
    if (!TOP_PAGES[appState.ui.topPage]) appState.ui.topPage = "clients";
    if (!Array.isArray(appState.ui.resourceSelection)) appState.ui.resourceSelection = [];
    if (!Array.isArray(appState.posturalAnalyses)) appState.posturalAnalyses = [];
    if (!Array.isArray(appState.files)) appState.files = [];
    if (!Array.isArray(appState.resources)) appState.resources = [];
    if (!Array.isArray(appState.resourceShares)) appState.resourceShares = [];
    normalizeSettingsState();
  } catch (err) {
    console.error("Failed to parse saved state", err);
  }
}

function isIgnoredSquarePayment(paymentId) {
  if (!paymentId) return false;
  const ignored = Array.isArray(appState.settings?.squareIgnoredPaymentIds)
    ? appState.settings.squareIgnoredPaymentIds
    : [];
  return ignored.includes(paymentId);
}

function normalizeSettingsState() {
  if (!appState.settings || typeof appState.settings !== "object") {
    appState.settings = {};
  }
  if (!appState.settings.prices || typeof appState.settings.prices !== "object") {
    appState.settings.prices = {};
  }
  if (!Number.isFinite(appState.settings.prices.single)) appState.settings.prices.single = 115;
  if (!Number.isFinite(appState.settings.prices.five)) appState.settings.prices.five = 500;
  if (!Number.isFinite(appState.settings.prices.ten)) appState.settings.prices.ten = 950;
  if (!Number.isFinite(appState.settings.prices.semiSingle)) appState.settings.prices.semiSingle = 75;
  if (!Number.isFinite(appState.settings.prices.semiTen)) appState.settings.prices.semiTen = 680;
  if (typeof appState.settings.neverExpiresDefault !== "boolean") {
    appState.settings.neverExpiresDefault = false;
  }
  if (!Array.isArray(appState.settings.squareIgnoredPaymentIds)) {
    appState.settings.squareIgnoredPaymentIds = [];
  }
}

function getPersistableState() {
  return {
    clients: appState.clients,
    visits: appState.visits,
    posturalAnalyses: appState.posturalAnalyses,
    files: appState.files,
    resources: appState.resources,
    resourceShares: appState.resourceShares,
    packages: appState.packages,
    homework: appState.homework,
    settings: appState.settings,
    selectedClientId: appState.selectedClientId,
  };
}

function getCloudPersistableState() {
  const state = getPersistableState();
  delete state.selectedClientId;
  return state;
}

function scheduleCloudSave() {
  if (!cloudSyncEnabled) return;
  if (cloudSaveTimer) clearTimeout(cloudSaveTimer);
  cloudSaveTimer = setTimeout(async () => {
    try {
      await fetch("/api/state", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ state: getCloudPersistableState() }),
      });
    } catch {
      // keep local state and retry on future saves
    }
  }, 700);
}

function saveState(options = {}) {
  const { skipCloud = false } = options;
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    ...getPersistableState(),
  }));
  if (!skipCloud) scheduleCloudSave();
}

async function syncStateFromCloud() {
  try {
    const localSelectedClientId = appState.selectedClientId;
    const res = await fetch("/api/state", {
      headers: authHeaders(),
    });
    if (!res.ok) return;
    const payload = await res.json();
    const state = payload?.state;
    if (!state || typeof state !== "object") return;
    Object.assign(appState, state);
    if (localSelectedClientId && appState.clients.some((client) => client.id === localSelectedClientId)) {
      appState.selectedClientId = localSelectedClientId;
    }
    normalizeSettingsState();
    saveState({ skipCloud: true });
  } catch {
    cloudSyncEnabled = false;
  }
}

function getVisitFilter(clientId) {
  if (!appState.ui.visitFilters[clientId]) {
    appState.ui.visitFilters[clientId] = { from: "", to: "", query: "" };
  }
  return appState.ui.visitFilters[clientId];
}

function getVisitCursor(clientId) {
  if (!Number.isInteger(appState.ui.visitCursor[clientId])) {
    appState.ui.visitCursor[clientId] = 0;
  }
  return appState.ui.visitCursor[clientId];
}

function getPosturalFilter(clientId) {
  if (!appState.ui.posturalFilters[clientId]) {
    appState.ui.posturalFilters[clientId] = { from: "", to: "", query: "" };
  }
  return appState.ui.posturalFilters[clientId];
}

function getPosturalCursor(clientId) {
  if (!Number.isInteger(appState.ui.posturalCursor[clientId])) {
    appState.ui.posturalCursor[clientId] = 0;
  }
  return appState.ui.posturalCursor[clientId];
}

function selectedClient() {
  return appState.clients.find((c) => c.id === appState.selectedClientId) || null;
}

function formatMoney(n) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n || 0);
}

function toPacificDateInputValue(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year && month && day) return `${year}-${month}-${day}`;
  const fallback = new Date(date);
  return `${fallback.getFullYear()}-${String(fallback.getMonth() + 1).padStart(2, "0")}-${String(fallback.getDate()).padStart(2, "0")}`;
}

function toDateInputValue(value) {
  const raw = String(value || "").trim();
  if (!raw) return toPacificDateInputValue();
  const exact = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (exact) return exact[0];
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return toPacificDateInputValue(parsed);
  const prefix = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return prefix ? prefix[1] : toPacificDateInputValue();
}

function parseDateInputValue(dateStr) {
  const raw = String(dateStr || "").trim();
  const parts = raw.split("-").map((value) => Number(value));
  if (parts.length !== 3) return null;
  const [year, month, day] = parts;
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const dt = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) return null;
  return dt;
}

function formatDate(value) {
  if (!value) return "";
  const raw = String(value).trim();
  const exact = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (exact) {
    const [, y, m, d] = exact;
    return `${Number(m)}/${Number(d)}/${y}`;
  }
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return raw;
  return new Intl.DateTimeFormat("en-US", { timeZone: PACIFIC_TIMEZONE }).format(dt);
}

function normalizeEmailForMatch(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || !raw.includes("@")) return raw;
  const [local, domain] = raw.split("@");
  if (!local || !domain) return raw;
  if (domain === "gmail.com" || domain === "googlemail.com") {
    const plusTrimmed = local.split("+")[0].replace(/\./g, "");
    return `${plusTrimmed}@gmail.com`;
  }
  return `${local}@${domain}`;
}

function normalizePhoneDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function daysBetweenDates(fromDate, toDate) {
  const from = new Date(fromDate);
  const to = new Date(toDate);
  from.setHours(0, 0, 0, 0);
  to.setHours(0, 0, 0, 0);
  return Math.round((to - from) / 86400000);
}

function getNextBirthdayDate(birthdayValue) {
  if (!birthdayValue || typeof birthdayValue !== "string") return null;
  const parts = birthdayValue.split("-").map((p) => Number(p));
  if (parts.length < 3) return null;
  const month = parts[1];
  const day = parts[2];
  if (!Number.isInteger(month) || !Number.isInteger(day) || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  const today = new Date();
  const currentYear = today.getFullYear();
  const maxDayThisYear = new Date(currentYear, month, 0).getDate();
  const thisYearBirthday = new Date(currentYear, month - 1, Math.min(day, maxDayThisYear));

  if (daysBetweenDates(today, thisYearBirthday) >= 0) {
    return thisYearBirthday;
  }

  const nextYear = currentYear + 1;
  const maxDayNextYear = new Date(nextYear, month, 0).getDate();
  return new Date(nextYear, month - 1, Math.min(day, maxDayNextYear));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Failed to read file."));
    reader.readAsDataURL(file);
  });
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const target = parseDateInputValue(dateStr) || new Date(dateStr);
  const now = new Date();
  if (Number.isNaN(target.getTime())) return null;
  const ms = target.setHours(0, 0, 0, 0) - now.setHours(0, 0, 0, 0);
  return Math.ceil(ms / 86400000);
}

function getPackageExpiresAt(pkg) {
  if (pkg.neverExpires) return null;
  const purchaseDate = pkg.purchaseDate;
  if (!purchaseDate) return pkg.expiresAt || null;
  const days = Number(appState.settings.validityDays || 0);
  if (!Number.isFinite(days) || days <= 0) return null;
  const expiresAt = parseDateInputValue(purchaseDate) || new Date(purchaseDate);
  if (Number.isNaN(expiresAt.getTime())) return null;
  expiresAt.setDate(expiresAt.getDate() + days);
  return toPacificDateInputValue(expiresAt);
}

function toLocalNoonISOString(dateValue) {
  const raw = String(dateValue || "").trim();
  if (!raw) return new Date().toISOString();
  const parts = raw.split("-").map((value) => Number(value));
  if (parts.length !== 3) return new Date().toISOString();
  const [year, month, day] = parts;
  const dt = new Date(year, month - 1, day, 12, 0, 0, 0);
  if (
    dt.getFullYear() !== year ||
    dt.getMonth() !== month - 1 ||
    dt.getDate() !== day
  ) {
    return new Date().toISOString();
  }
  return dt.toISOString();
}

function packageSummary(clientId) {
  const indexById = new Map(
    appState.packages.map((pkg, idx) => [pkg.id, idx])
  );
  const list = appState.packages
    .filter((p) => p.clientId === clientId)
    .sort((a, b) => {
      const purchaseDiff = new Date(b.purchaseDate || 0) - new Date(a.purchaseDate || 0);
      if (purchaseDiff !== 0) return purchaseDiff;

      const createdDiff = new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      if (createdDiff !== 0) return createdDiff;

      return (indexById.get(b.id) || 0) - (indexById.get(a.id) || 0);
    });

  const active = list.find((p) => {
    const expiresAt = getPackageExpiresAt(p);
    return getPackageSessionsUsed(p) < p.sessionsTotal && (!expiresAt || daysUntil(expiresAt) >= 0);
  });
  return { list, active };
}

function getPackageSessionsUsed(pkg) {
  const total = Number(pkg?.sessionsTotal || 0);
  const hasDates = Array.isArray(pkg?.sessionUseDates);
  const fromDates = hasDates ? pkg.sessionUseDates.length : 0;
  const fromFieldRaw = Number(pkg?.sessionsUsed || 0);
  const fromField = Number.isFinite(fromFieldRaw) ? fromFieldRaw : 0;
  const boundedField = Math.max(0, Math.min(total, fromField));
  const boundedDates = Math.max(0, Math.min(total, fromDates));
  if (hasDates) return boundedDates;
  return boundedField;
}

function syncPackageUsage(pkg) {
  if (!pkg) return;
  if (!Array.isArray(pkg.sessionUseDates)) pkg.sessionUseDates = [];
  pkg.sessionsUsed = getPackageSessionsUsed(pkg);
}

function createEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function setButtonLoading(button, isLoading, loadingText = "Saving...") {
  if (!button) return;
  if (isLoading) {
    if (!button.dataset.originalText) {
      button.dataset.originalText = button.textContent || "";
    }
    if (button.dataset.originalText) button.textContent = loadingText;
    button.disabled = true;
    button.classList.add("is-loading");
    return;
  }
  if (button.dataset.originalText) {
    button.textContent = button.dataset.originalText;
    delete button.dataset.originalText;
  }
  button.classList.remove("is-loading");
  button.disabled = false;
}

function createTrashIcon() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.8");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("text-link-icon-svg");

  const path1 = document.createElementNS(ns, "path");
  path1.setAttribute("d", "M3 6h18");
  const path2 = document.createElementNS(ns, "path");
  path2.setAttribute("d", "M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2");
  const path3 = document.createElementNS(ns, "path");
  path3.setAttribute("d", "M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6");
  const path4 = document.createElementNS(ns, "path");
  path4.setAttribute("d", "M10 11v6");
  const path5 = document.createElementNS(ns, "path");
  path5.setAttribute("d", "M14 11v6");

  svg.append(path1, path2, path3, path4, path5);
  return svg;
}

function openDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.showModal === "function") {
    dialog.showModal();
    return;
  }
  dialog.setAttribute("open", "open");
}

function closeDialog(dialog) {
  if (!dialog) return;
  if (typeof dialog.close === "function") {
    dialog.close();
    return;
  }
  dialog.removeAttribute("open");
}

function authHeaders(extra = {}) {
  return {
    ...(adminToken ? { "x-admin-token": adminToken } : {}),
    ...extra,
  };
}

async function apiFetch(path, options = {}) {
  try {
    const res = await fetch(path, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(options.headers || {}),
      },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || `Request failed: ${res.status}`);
    }
    return data;
  } catch (err) {
    const method = String(options?.method || "GET").toUpperCase();
    const fetchFailed = String(err?.message || "").toLowerCase().includes("fetch failed");
    if (fetchFailed && method !== "GET") {
      throw new Error("Database connection is unavailable right now (Supabase may be paused). Resume Supabase project, then retry.");
    }
    throw err;
  }
}

function cancelPendingCloudSave() {
  if (!cloudSaveTimer) return;
  clearTimeout(cloudSaveTimer);
  cloudSaveTimer = null;
}

async function refreshStateAndRender() {
  cancelPendingCloudSave();
  await syncStateFromCloud();
  render();
}

async function apiCreatePackagePurchase(payload) {
  await apiFetch("/api/packages", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function apiCreateClient(payload) {
  return apiFetch("/api/clients", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function apiUpdateClient(clientId, payload) {
  return apiFetch(`/api/clients/${encodeURIComponent(clientId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

async function apiDeleteClient(clientId) {
  return apiFetch(`/api/clients/${encodeURIComponent(clientId)}`, {
    method: "DELETE",
  });
}

async function apiUsePackageSession(packageId, dateValue) {
  await apiFetch(`/api/packages/${encodeURIComponent(packageId)}/use-session`, {
    method: "POST",
    body: JSON.stringify({ date: dateValue }),
  });
}

async function apiEditPackageSessionDate(packageId, useIndex, dateValue) {
  await apiFetch(`/api/packages/${encodeURIComponent(packageId)}/edit-session-date`, {
    method: "POST",
    body: JSON.stringify({ useIndex, date: dateValue }),
  });
}

async function apiUndoPackageSession(packageId) {
  await apiFetch(`/api/packages/${encodeURIComponent(packageId)}/undo-session`, {
    method: "POST",
  });
}

async function apiUndoPackageSessionByDate(packageId, dateValue) {
  await apiFetch(`/api/packages/${encodeURIComponent(packageId)}/undo-session`, {
    method: "POST",
    body: JSON.stringify({ date: dateValue }),
  });
}

async function apiDeletePackage(packageId) {
  await apiFetch(`/api/packages/${encodeURIComponent(packageId)}`, {
    method: "DELETE",
  });
}

async function apiSavePosturalAnalysis(clientId, notes) {
  await apiFetch(`/api/clients/${encodeURIComponent(clientId)}/postural-analysis`, {
    method: "POST",
    body: JSON.stringify({ notes }),
  });
}

async function apiCreateSessionNote(clientId, payload) {
  await apiFetch(`/api/clients/${encodeURIComponent(clientId)}/session-notes`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

async function apiUpdateSessionNote(visitId, payload) {
  await apiFetch(`/api/visits/${encodeURIComponent(visitId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  });
}

async function apiDeleteSessionNote(visitId) {
  await apiFetch(`/api/visits/${encodeURIComponent(visitId)}`, {
    method: "DELETE",
  });
}

async function refreshSquareStatus() {
  try {
    const data = await apiFetch("/api/square/status");
    appState.square.connected = !!data.connected;
    appState.square.merchantId = data.merchantId || null;
    appState.square.environment = data.environment || null;
    appState.square.statusMessage = data.connected
      ? `Connected (${data.environment})`
      : "Not connected";
  } catch (err) {
    appState.square.connected = false;
    appState.square.statusMessage = "Square backend unavailable";
  }
}

async function refreshRuntimeVersion() {
  try {
    const data = await apiFetch("/api/version");
    appState.runtime.version = data.version || "";
    appState.runtime.service = data.service || "";
    appState.runtime.environment = data.environment || "";
  } catch {
    appState.runtime.version = "";
    appState.runtime.service = "";
    appState.runtime.environment = "";
  }
}

function renderSystemStatusBanner() {
  const el = document.getElementById("system-status-banner");
  if (!el) return;
  const configured = appState.runtime.supabaseConfigured;
  const reachable = appState.runtime.supabaseReachable;
  if (configured && !reachable) {
    el.hidden = false;
    el.textContent = "Database is currently unavailable. Supabase may be paused. Please resume the Supabase project before making changes.";
    return;
  }
  el.hidden = true;
  el.textContent = "";
}

async function refreshSystemHealth() {
  try {
    const health = await fetch("/api/health").then((res) => res.json());
    appState.runtime.supabaseConfigured = !!health?.supabase;
    appState.runtime.supabaseReachable = !!health?.supabaseReachable;
  } catch {
    appState.runtime.supabaseConfigured = true;
    appState.runtime.supabaseReachable = false;
  }
  renderSystemStatusBanner();
}

function normalizeSquareAmount(payment) {
  const cents = payment.total_money?.amount ?? payment.amount_money?.amount ?? 0;
  return Number(cents) / 100;
}

function detectPackageTypeFromPayment(payment) {
  const amount = normalizeSquareAmount(payment);
  const taxRate = Number(appState.settings.taxRate || 0) / 100;
  const searchText = [
    payment.note,
    payment.reference_id,
    payment.receipt_number,
    payment.order_id,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const keywordRules = [
    { type: "ten", patterns: [/10\s*session/, /10[\s-]*(pack|package|class)/, /\bten\s*session/, /\bten\s*pack/] },
    { type: "five", patterns: [/5\s*session/, /5[\s-]*(pack|package|class)/, /\bfive\s*session/, /\bfive\s*pack/] },
    { type: "single", patterns: [/\bsingle\b/, /\b1\s*session\b/, /\bone\s*session\b/, /\bdrop[\s-]*in\b/] },
    { type: "semiTen", patterns: [/\bsemi[\s-]*private\b.*10/, /\b10\b.*\bsemi[\s-]*private\b/, /\bsemi[\s-]*private\b.*\bten\b/] },
    { type: "semiSingle", patterns: [/\bsemi[\s-]*private\b.*\bsingle\b/, /\bsemi[\s-]*private\b.*\b1\s*session\b/, /\bsemi[\s-]*private\b.*\bone\s*session\b/] },
  ];

  for (const rule of keywordRules) {
    if (rule.patterns.some((pattern) => pattern.test(searchText))) {
      return { type: rule.type, reason: `keyword match in payment text (${rule.type})` };
    }
  }

  for (const pkg of PACKAGE_TYPES) {
    const base = Number(appState.settings.prices[pkg.key] || 0);
    const withTax = Number((base * (1 + taxRate)).toFixed(2));
    const tolerance = 2.0;

    if (Math.abs(amount - withTax) <= tolerance) {
      return { type: pkg.key, reason: `amount matched ${formatMoney(withTax)} (tax included)` };
    }
    if (Math.abs(amount - base) <= tolerance) {
      return { type: pkg.key, reason: `amount matched ${formatMoney(base)} (pre-tax)` };
    }
  }

  let bestType = "ten";
  let bestDiff = Number.POSITIVE_INFINITY;
  let bestExpected = 0;
  PACKAGE_TYPES.forEach((pkg) => {
    const preTax = Number(appState.settings.prices[pkg.key] || 0);
    const expected = preTax * (1 + taxRate);
    const diff = Math.abs(expected - amount);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestType = pkg.key;
      bestExpected = expected;
    }
  });

  return {
    type: bestType,
    reason: `closest amount to ${formatMoney(bestExpected)} (difference ${formatMoney(bestDiff)})`,
  };
}

function createPackageRecord(clientId, type, purchaseDate, squarePaymentId, squareTotalOverride, neverExpires) {
  const cfg = PACKAGE_TYPES.find((p) => p.key === type);
  const price = Number(appState.settings.prices[type] || 0);
  const taxRate = Number(appState.settings.taxRate || 0) / 100;

  const calculatedTotal = Number((price * (1 + taxRate)).toFixed(2));
  const total = Number.isFinite(squareTotalOverride) ? Number(squareTotalOverride.toFixed(2)) : calculatedTotal;

  appState.packages.push({
    id: uid("pkg"),
    clientId,
    createdAt: new Date().toISOString(),
    type,
    sessionsTotal: cfg.sessions,
    sessionsUsed: 0,
    sessionUseDates: [],
    purchaseDate,
    neverExpires: Boolean(neverExpires),
    preTax: price,
    tax: Number((price * taxRate).toFixed(2)),
    total,
    squarePaymentId: squarePaymentId || "",
  });
}

function openSessionHistoryDialog(pkg) {
  const dialog = document.getElementById("session-history-dialog");
  const title = document.getElementById("session-history-title");
  const content = document.getElementById("session-history-content");
  if (!dialog || !title || !content) return;

  const pkgLabel = PACKAGE_TYPES.find((p) => p.key === pkg.type)?.label || pkg.type;
  const useDates = Array.isArray(pkg.sessionUseDates) ? pkg.sessionUseDates : [];
  title.textContent = `Session Usage History: ${pkgLabel}`;
  content.innerHTML = "";

  if (useDates.length === 0) {
    content.appendChild(createEl("p", "meta", "No sessions have been marked used yet."));
  } else {
    const list = createEl("ol");
    useDates
      .map((date, index) => ({ date, index }))
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .forEach((entry, displayIndex) => {
        const item = createEl("li", "session-history-item");
        const dateText = createEl("span", "", `${displayIndex + 1}. ${formatDate(entry.date)}`);
        const editBtn = createEl("button", "text-link", "Edit");
        editBtn.type = "button";
        editBtn.addEventListener("click", () => {
          const dialog = document.getElementById("session-use-date-dialog");
          const input = document.getElementById("session-use-date-input");
          const title = document.getElementById("session-use-date-title");
          const submitBtn = document.getElementById("session-use-date-submit-btn");
          if (!dialog || !input || !title || !submitBtn) return;
          pendingSessionDateEdit = { packageId: pkg.id, useIndex: entry.index };
          pendingSessionUsePackageId = null;
          pendingSessionUndoPackageId = null;
          input.value = toDateInputValue(entry.date);
          title.textContent = "Edit Session Date";
          submitBtn.textContent = "Save Date";
          closeDialog(document.getElementById("session-history-dialog"));
          openDialog(dialog);
        });
        item.append(dateText, editBtn);
        list.appendChild(item);
      });
    content.appendChild(list);
  }

  dialog.showModal();
}

function clientCard(client) {
  const item = createEl("li", `client-item${client.id === appState.selectedClientId ? " active" : ""}`);
  item.tabIndex = 0;
  const name = createEl("strong", "", client.name || "Unnamed Client");
  const detail = createEl("small", "", [client.email, client.phone].filter(Boolean).join(" | "));
  item.append(name, detail);
  item.addEventListener("click", () => {
    appState.selectedClientId = client.id;
    render();
  });
  return item;
}

function renderClientList() {
  const list = document.getElementById("client-list");
  const query = document.getElementById("client-search").value.toLowerCase();
  list.innerHTML = "";

  const filtered = appState.clients.filter((c) =>
    [c.name, c.email, c.phone].join(" ").toLowerCase().includes(query)
  );

  filtered.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  filtered.forEach((client) => list.appendChild(clientCard(client)));
}

function renderAlerts(client) {
  const alerts = document.getElementById("alerts");
  alerts.innerHTML = "";

  const birthdayAlerts = appState.clients
    .filter((c) => c && c.birthday)
    .map((c) => {
      const nextBirthday = getNextBirthdayDate(c.birthday);
      if (!nextBirthday) return null;
      const daysAway = daysBetweenDates(new Date(), nextBirthday);
      if (daysAway === 0) {
        return `Birthday today: ${c.name || "Client"}`;
      }
      if (daysAway === 3) {
        return `Birthday in 3 days: ${c.name || "Client"} (${formatDate(nextBirthday)})`;
      }
      return null;
    })
    .filter(Boolean);

  birthdayAlerts.forEach((message) => {
    alerts.appendChild(createEl("div", "alert", message));
  });

  if (!client) return;

  const { active } = packageSummary(client.id);
  if (!active) {
    alerts.appendChild(createEl("div", "alert", "No active package. Add a package purchase."));
  } else {
    const remaining = active.sessionsTotal - getPackageSessionsUsed(active);
    if (remaining <= 1) {
      alerts.appendChild(createEl("div", "alert", `Only ${remaining} session left in active package.`));
    }

    const expiresAt = getPackageExpiresAt(active);
    if (expiresAt) {
      const days = daysUntil(expiresAt);
      if (days <= 7) {
        alerts.appendChild(createEl("div", "alert", `Package expires in ${Math.max(days, 0)} day(s) on ${formatDate(expiresAt)}.`));
      }
    }
  }
}

function renderClientForm(client) {
  const form = document.getElementById("client-form");
  form.innerHTML = "";
  if (!client) {
    form.innerHTML = "<p>Select a client or create a new one.</p>";
    return;
  }

  const fields = [
    ["name", "Name", "text"],
    ["email", "Email", "email"],
    ["phone", "Phone", "text"],
    ["birthday", "Birthday", "date"],
    ["address", "Address", "text"],
  ];

  fields.forEach(([key, labelText, type]) => {
    const label = createEl("label");
    label.textContent = labelText;
    const input = createEl("input");
    input.type = type;
    input.value = client[key] || "";
    input.addEventListener("change", async () => {
      const nextValue = input.value;
      client[key] = nextValue;
      saveState();
      renderClientList();
      try {
        await apiUpdateClient(client.id, { [key]: nextValue });
        await refreshStateAndRender();
      } catch (err) {
        alert(err.message || "Failed to update client.");
        await refreshStateAndRender();
      }
    });
    label.appendChild(input);
    if (key === "address") label.classList.add("full");
    form.appendChild(label);
  });

  const healthLabel = createEl("label", "full");
  healthLabel.textContent = "Client Health History";
  const healthNotes = createEl("textarea");
  healthNotes.value = client.healthHistory || "";
  healthNotes.addEventListener("change", async () => {
    const nextValue = healthNotes.value;
    client.healthHistory = nextValue;
    saveState();
    try {
      await apiUpdateClient(client.id, { healthHistory: nextValue });
      await refreshStateAndRender();
    } catch (err) {
      alert(err.message || "Failed to update health history.");
      await refreshStateAndRender();
    }
  });
  healthLabel.appendChild(healthNotes);
  form.appendChild(healthLabel);

  const deleteRow = createEl("div", "full client-actions-row");
  const editBtn = createEl("button", "text-link", "Edit Client");
  editBtn.type = "button";
  editBtn.addEventListener("click", () => {
    const nameInput = form.querySelector('label input[type="text"], label input[type="email"], label input[type="date"]');
    if (!nameInput) return;
    nameInput.focus();
    if (typeof nameInput.select === "function" && nameInput.type !== "date") {
      nameInput.select();
    }
  });

  const deleteBtn = createEl("button", "text-link subdued icon-link");
  deleteBtn.type = "button";
  const deleteIcon = createTrashIcon();
  const deleteText = createEl("span", "", "Delete Client");
  deleteBtn.append(deleteIcon, deleteText);
  deleteBtn.addEventListener("click", async () => {
    if (!confirm("Delete this client and all related records?")) return;
    setButtonLoading(deleteBtn, true, "Deleting...");
    editBtn.disabled = true;
    try {
      await apiDeleteClient(client.id);
      if (appState.selectedClientId === client.id) appState.selectedClientId = null;
      await refreshStateAndRender();
    } catch (err) {
      alert(err.message || "Failed to delete client.");
    } finally {
      setButtonLoading(deleteBtn, false);
      editBtn.disabled = false;
    }
  });
  deleteRow.appendChild(editBtn);
  deleteRow.appendChild(deleteBtn);
  form.appendChild(deleteRow);

}

function renderVisitSection(client) {
  const form = document.getElementById("visit-form");
  const history = document.getElementById("visit-history");
  form.innerHTML = "";
  history.innerHTML = "";
  if (!client) return;

  const sectionHeader = (text) => {
    const label = createEl("p", "meta full", text);
    label.style.fontWeight = "500";
    label.style.margin = "0.4rem 0 0";
    return label;
  };

  const posturalHeader = sectionHeader("Postural Analysis");
  const posturalNotesLabel = createEl("label", "full");
  posturalNotesLabel.textContent = "Postural Analysis Notes";
  const posturalNotesInput = createEl("textarea");
  const latestLegacyPostural = appState.posturalAnalyses
    .filter((entry) => entry.clientId === client.id)
    .sort((a, b) => new Date(b.date || b.createdAt || 0) - new Date(a.date || a.createdAt || 0))[0];
  posturalNotesInput.value = client.posturalAnalysisNotes || latestLegacyPostural?.notes || "";
  posturalNotesInput.addEventListener("change", async () => {
    const latestValue = posturalNotesInput.value;
    client.posturalAnalysisNotes = latestValue;
    try {
      await apiSavePosturalAnalysis(client.id, latestValue);
      await syncStateFromCloud();
    } catch (err) {
      alert(err.message || "Failed to save postural analysis.");
    }
  });
  posturalNotesLabel.appendChild(posturalNotesInput);

  const sessionHeader = sectionHeader("Session Notes");

  const visitDateLabel = createEl("label");
  visitDateLabel.textContent = "Date";
  const visitDateInput = createEl("input");
  visitDateInput.type = "date";
  visitDateInput.value = toPacificDateInputValue();
  visitDateLabel.appendChild(visitDateInput);

  const visitNotesLabel = createEl("label", "full");
  visitNotesLabel.textContent = "Session Notes";
  const visitNotesInput = createEl("textarea");
  visitNotesLabel.appendChild(visitNotesInput);

  const addVisitBtn = createEl("button", "button primary", "Add Session Note");
  addVisitBtn.type = "button";
  addVisitBtn.classList.add("full", "fit-content-row-cta");
  addVisitBtn.addEventListener("click", async () => {
    if (!String(visitNotesInput.value || "").trim()) {
      alert("Please enter session notes before saving.");
      return;
    }
    setButtonLoading(addVisitBtn, true, "Saving...");
    try {
      await apiCreateSessionNote(client.id, {
        date: visitDateInput.value || toPacificDateInputValue(),
        notes: visitNotesInput.value || "",
        posturalAnalysisNotes: posturalNotesInput.value || "",
      });
      await refreshStateAndRender();
    } catch (err) {
      alert(err.message || "Failed to add session note.");
      setButtonLoading(addVisitBtn, false);
    }
  });

  const visitFilter = getVisitFilter(client.id);
  const visitFilterRow = createEl("div", "card-actions full filter-row");
  const visitFromInput = createEl("input");
  visitFromInput.type = "date";
  visitFromInput.value = visitFilter.from || "";
  visitFromInput.title = "Session Notes: From date";
  visitFromInput.addEventListener("change", () => {
    visitFilter.from = visitFromInput.value;
    renderVisitSection(client);
  });

  const visitToInput = createEl("input");
  visitToInput.type = "date";
  visitToInput.value = visitFilter.to || "";
  visitToInput.title = "Session Notes: To date";
  visitToInput.addEventListener("change", () => {
    visitFilter.to = visitToInput.value;
    renderVisitSection(client);
  });

  const visitQueryInput = createEl("input");
  visitQueryInput.type = "search";
  visitQueryInput.id = "visit-search-notes";
  visitQueryInput.placeholder = "Search session notes";
  visitQueryInput.value = visitFilter.query || "";
  visitQueryInput.addEventListener("input", (event) => {
    const cursorPos = event.target.selectionStart;
    visitFilter.query = visitQueryInput.value;
    renderVisitSection(client);
    const nextInput = document.getElementById("visit-search-notes");
    if (nextInput) {
      nextInput.focus();
      const safePos = Math.min(cursorPos ?? nextInput.value.length, nextInput.value.length);
      nextInput.setSelectionRange(safePos, safePos);
    }
  });

  const clearVisitBtn = createEl("button", "button", "Clear Filters");
  clearVisitBtn.type = "button";
  clearVisitBtn.addEventListener("click", () => {
    visitFilter.from = "";
    visitFilter.to = "";
    visitFilter.query = "";
    renderVisitSection(client);
  });
  visitFilterRow.append(visitFromInput, visitToInput, visitQueryInput, clearVisitBtn);

  form.append(
    posturalHeader,
    posturalNotesLabel,
    sessionHeader,
    visitDateLabel,
    visitNotesLabel,
    addVisitBtn,
    visitFilterRow
  );

  const sessionHistoryWrap = createEl("section", "card");
  sessionHistoryWrap.appendChild(createEl("strong", "", "Session Notes History"));
  const filteredSessions = appState.visits
    .filter((v) => v.clientId === client.id)
    .filter((v) => {
      if (visitFilter.from && v.date < visitFilter.from) return false;
      if (visitFilter.to && v.date > visitFilter.to) return false;
      if (visitFilter.query && !String(v.notes || "").toLowerCase().includes(visitFilter.query.toLowerCase())) return false;
      return true;
    })
    .sort((a, b) => new Date(b.date) - new Date(a.date));

  if (filteredSessions.length === 0) {
    sessionHistoryWrap.appendChild(createEl("p", "meta", "No session notes match these filters."));
  } else {
    const tableWrap = createEl("div", "resources-table-wrap");
    const table = createEl("table", "resources-table session-notes-table");
    const thead = createEl("thead");
    const headRow = createEl("tr");
    ["Date", "Session Note", "Created", "Edit", "Delete"].forEach((heading) => {
      headRow.appendChild(createEl("th", "", heading));
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = createEl("tbody");
    filteredSessions.forEach((item) => {
      const row = createEl("tr");
      row.appendChild(createEl("td", "", formatDate(item.date)));
      row.appendChild(createEl("td", "", item.notes || "No notes."));
      row.appendChild(createEl("td", "", formatDate(item.createdAt)));
      const editCell = createEl("td");
      const editBtn = createEl("button", "text-link", "Edit");
      editBtn.type = "button";
      editBtn.addEventListener("click", () => openSessionNoteEditDialog(item.id));
      editCell.appendChild(editBtn);
      row.appendChild(editCell);
      const deleteCell = createEl("td");
      const deleteBtn = createEl("button", "text-link subdued", "Delete");
      deleteBtn.type = "button";
      deleteBtn.addEventListener("click", async () => {
        if (!confirm(`Delete this session note from ${formatDate(item.date)}?`)) return;
        deleteBtn.disabled = true;
        try {
          await apiDeleteSessionNote(item.id);
          await refreshStateAndRender();
        } catch (err) {
          alert(err.message || "Failed to delete session note.");
          deleteBtn.disabled = false;
        }
      });
      deleteCell.appendChild(deleteBtn);
      row.appendChild(deleteCell);
      tbody.appendChild(row);
    });
    table.appendChild(tbody);
    tableWrap.appendChild(table);
    sessionHistoryWrap.appendChild(tableWrap);
  }
  history.appendChild(sessionHistoryWrap);
}

function renderSquarePaymentList(client) {
  const container = document.getElementById("square-payment-list");
  container.innerHTML = "";

  const email = normalizeEmailForMatch(client?.email || "");
  const clientPhoneDigits = normalizePhoneDigits(client?.phone || "");
  if (!email && !clientPhoneDigits) {
    container.appendChild(createEl("p", "muted", "Add a client email or phone to match and import Square payments."));
    return;
  }

  const payments = appState.square.recentPayments.filter((payment) => {
    if (isIgnoredSquarePayment(payment.id)) return false;
    const paymentEmails = [
      payment.buyer_email_address,
      payment.receipt_email_address,
      payment.customer_email_address,
    ]
      .map((value) => normalizeEmailForMatch(value))
      .filter(Boolean);
    const emailMatch = email && paymentEmails.includes(email);

    const paymentPhones = [
      payment.buyer_phone_number,
      payment.customer_phone_number,
    ]
      .map((value) => normalizePhoneDigits(value))
      .filter(Boolean);
    const phoneMatch = clientPhoneDigits && paymentPhones.includes(clientPhoneDigits);

    return emailMatch || phoneMatch;
  });

  if (payments.length === 0) {
    container.appendChild(createEl("p", "muted", "No recent Square payments found for this client email."));
    return;
  }

  const heading = createEl("p", "muted", "Recent Square payments ready to import:");
  container.appendChild(heading);

  payments.forEach((payment) => {
    const amount = normalizeSquareAmount(payment);
    const detected = detectPackageTypeFromPayment(payment);

    const card = createEl("article", "card");
    const header = createEl("div", "square-payment-card-header");
    const title = createEl(
      "strong",
      "",
      `${formatMoney(amount)} | ${formatDate(payment.created_at)}${payment.buyer_email_address || payment.customer_email_address ? ` | ${payment.buyer_email_address || payment.customer_email_address}` : ""}`
    );
    const removeBtn = createEl("button", "text-link icon-link icon-only square-payment-remove");
    removeBtn.type = "button";
    removeBtn.title = "Remove payment from import list";
    removeBtn.setAttribute("aria-label", "Remove payment from import list");
    removeBtn.appendChild(createTrashIcon());
    removeBtn.addEventListener("click", () => {
      if (!confirm("Remove this payment from the import list?")) return;
      appState.settings.squareIgnoredPaymentIds = Array.from(
        new Set([...(appState.settings.squareIgnoredPaymentIds || []), payment.id])
      );
      appState.square.recentPayments = appState.square.recentPayments.filter((p) => p.id !== payment.id);
      saveState();
      renderPackageSection(client);
    });
    header.append(title, removeBtn);
    const meta = createEl("p", "meta", `Payment ID: ${payment.id}${payment.note ? ` | ${payment.note}` : ""}`);
    const detectionMeta = createEl(
      "p",
      "meta",
      `Auto-detected package: ${PACKAGE_TYPES.find((p) => p.key === detected.type)?.label || detected.type} (${detected.reason})`
    );

    const typeSelect = createEl("select");
    PACKAGE_TYPES.forEach((pkg) => {
      const opt = createEl("option", "", pkg.label);
      opt.value = pkg.key;
      if (pkg.key === detected.type) opt.selected = true;
      typeSelect.appendChild(opt);
    });

    const importBtn = createEl("button", "button", "Import to Selected Client");
    importBtn.type = "button";
    importBtn.disabled = !client;
    importBtn.addEventListener("click", () => {
      if (!client) return;
      const alreadyImported = appState.packages.some((pkg) => pkg.squarePaymentId === payment.id);
      if (alreadyImported) {
        alert("This Square payment is already imported.");
        return;
      }
      createPackageRecord(
        client.id,
        typeSelect.value,
        toDateInputValue(payment.created_at),
        payment.id,
        amount,
        appState.settings.neverExpiresDefault
      );
      saveState();
      render();
    });

    const actions = createEl("div", "card-actions");
    actions.append(typeSelect, importBtn);
    card.append(header, meta, detectionMeta, actions);
    container.appendChild(card);
  });
}

function renderPackageSection(client) {
  const form = document.getElementById("package-form");
  const history = document.getElementById("package-history");
  form.innerHTML = "";
  history.innerHTML = "";

  if (!client) {
    return;
  }

  const typeLabel = createEl("label");
  typeLabel.textContent = "Package Type";
  const typeSelect = createEl("select");
  PACKAGE_TYPES.forEach((pkg) => {
    const opt = createEl("option", "", pkg.label);
    opt.value = pkg.key;
    typeSelect.appendChild(opt);
  });
  typeLabel.appendChild(typeSelect);

  const dateLabel = createEl("label");
  dateLabel.textContent = "Purchase Date";
  const dateInput = createEl("input");
  dateInput.type = "date";
  dateInput.value = toPacificDateInputValue();
  dateLabel.appendChild(dateInput);

  const neverExpiresLabel = createEl("label", "inline-checkbox-row");
  neverExpiresLabel.textContent = "Never Expires";
  const neverExpiresInput = createEl("input");
  neverExpiresInput.type = "checkbox";
  neverExpiresInput.checked = Boolean(appState.settings.neverExpiresDefault);
  neverExpiresLabel.appendChild(neverExpiresInput);

  const addBtn = createEl("button", "button primary", "Record Package Purchase");
  addBtn.type = "button";
  addBtn.classList.add("full", "fit-content-row-cta");

  const submitPackagePurchase = async () => {
    setButtonLoading(addBtn, true, "Saving...");
    try {
      await apiCreatePackagePurchase({
        clientId: client.id,
        type: typeSelect.value,
        purchaseDate: dateInput.value || toPacificDateInputValue(),
        neverExpires: neverExpiresInput.checked,
      });
      await refreshStateAndRender();
    } catch (err) {
      alert(err.message || "Failed to record package purchase.");
    } finally {
      setButtonLoading(addBtn, false);
    }
  };

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    await submitPackagePurchase();
  });
  addBtn.addEventListener("click", async () => {
    await submitPackagePurchase();
  });

  form.append(typeLabel, dateLabel, neverExpiresLabel, addBtn);

  const { list } = packageSummary(client.id);
  list.forEach((pkg) => {
    syncPackageUsage(pkg);
    const expiresAt = getPackageExpiresAt(pkg);
    const used = getPackageSessionsUsed(pkg);
    const remaining = pkg.sessionsTotal - used;
    const useDates = Array.isArray(pkg.sessionUseDates) ? pkg.sessionUseDates : [];
    const card = createEl("article", "card");
    card.appendChild(createEl("strong", "", `${PACKAGE_TYPES.find((p) => p.key === pkg.type)?.label || pkg.type} | ${remaining}/${pkg.sessionsTotal} remaining`));
    card.appendChild(
      createEl(
        "p",
        "meta",
        `Purchased ${formatDate(pkg.purchaseDate)} | Expires ${expiresAt ? formatDate(expiresAt) : "Never"} | Total ${formatMoney(pkg.total)}${pkg.squarePaymentId ? ` | Square: ${pkg.squarePaymentId}` : ""}`
      )
    );
    card.appendChild(createEl("p", "meta", `Sessions marked used: ${used}`));

    const actions = createEl("div", "card-actions");
    const useBtn = createEl("button", "button", "Use 1 Session");
    useBtn.type = "button";
    useBtn.disabled = remaining <= 0;
    useBtn.addEventListener("click", () => {
      const dialog = document.getElementById("session-use-date-dialog");
      const input = document.getElementById("session-use-date-input");
      const title = document.getElementById("session-use-date-title");
      const submitBtn = document.getElementById("session-use-date-submit-btn");
      if (!dialog || !input || !title || !submitBtn) return;
      pendingSessionUsePackageId = pkg.id;
      pendingSessionDateEdit = null;
      pendingSessionUndoPackageId = null;
      input.value = toPacificDateInputValue();
      title.textContent = "Use 1 Session";
      submitBtn.textContent = "Use Session";
      openDialog(dialog);
    });

    const unuseBtn = createEl("button", "button", "Undo Session");
    unuseBtn.type = "button";
    unuseBtn.disabled = used <= 0;
    unuseBtn.addEventListener("click", () => {
      const dialog = document.getElementById("session-use-date-dialog");
      const input = document.getElementById("session-use-date-input");
      const title = document.getElementById("session-use-date-title");
      const submitBtn = document.getElementById("session-use-date-submit-btn");
      if (!dialog || !input || !title || !submitBtn) return;
      pendingSessionUsePackageId = null;
      pendingSessionDateEdit = null;
      pendingSessionUndoPackageId = pkg.id;
      const lastUsedDate = useDates.length > 0 ? useDates[useDates.length - 1] : null;
      input.value = toDateInputValue(lastUsedDate);
      title.textContent = "Undo Session";
      submitBtn.textContent = "Undo Session";
      openDialog(dialog);
    });

    const historyBtn = createEl("button", "button", "Session Usage History");
    historyBtn.type = "button";
    historyBtn.addEventListener("click", () => openSessionHistoryDialog(pkg));

    const deletePkgBtn = createEl("button", "text-link subdued icon-link icon-only package-delete-btn");
    deletePkgBtn.type = "button";
    deletePkgBtn.setAttribute("aria-label", "Delete package");
    deletePkgBtn.appendChild(createTrashIcon());
    deletePkgBtn.addEventListener("click", async () => {
      const label = PACKAGE_TYPES.find((p) => p.key === pkg.type)?.label || "package";
      const ok = confirm(`Delete this ${label} purchase from ${formatDate(pkg.purchaseDate)}?`);
      if (!ok) return;
      setButtonLoading(deletePkgBtn, true);
      try {
        await apiDeletePackage(pkg.id);
        await refreshStateAndRender();
      } catch (err) {
        alert(err.message || "Failed to delete package.");
        setButtonLoading(deletePkgBtn, false);
      }
    });

    actions.append(useBtn, unuseBtn, historyBtn, deletePkgBtn);
    card.appendChild(actions);
    history.appendChild(card);
  });

}

function renderHomeworkSection(client) {
  const form = document.getElementById("homework-form");
  const list = document.getElementById("homework-list");
  form.innerHTML = "";
  list.innerHTML = "";
  if (!client) return;

  const titleLabel = createEl("label");
  titleLabel.classList.add("full");
  titleLabel.textContent = "Homework Title";
  const titleInput = createEl("input");
  titleLabel.appendChild(titleInput);

  const instructorLabel = createEl("label", "full");
  instructorLabel.textContent = "Homework Notes";
  const instructorInput = createEl("textarea");
  instructorLabel.appendChild(instructorInput);

  const videoLabel = createEl("label", "full");
  videoLabel.textContent = "Attach Video(s)";
  const videoInput = createEl("input");
  videoInput.type = "file";
  videoInput.accept = "video/*";
  videoInput.multiple = true;
  videoLabel.appendChild(videoInput);

  const addBtn = createEl("button", "button primary", "Add Homework Item");
  addBtn.type = "button";
  addBtn.classList.add("full", "fit-content-row-cta");
  addBtn.addEventListener("click", async () => {
    const uploadFiles = Array.from(videoInput.files || []);
    const videos = [];
    for (const file of uploadFiles) {
      const dataUrl = await fileToDataUrl(file);
      videos.push({
        id: uid("hwvid"),
        name: file.name,
        type: file.type || "video/mp4",
        size: file.size || 0,
        dataUrl,
      });
    }

    appState.homework.push({
      id: uid("hw"),
      clientId: client.id,
      title: titleInput.value || "Homework",
      notes: instructorInput.value,
      videos,
      updatedAt: new Date().toISOString(),
      done: false,
    });
    saveState();
    renderHomeworkSection(client);
  });

  form.append(titleLabel, instructorLabel, videoLabel, addBtn);

  appState.homework
    .filter((h) => h.clientId === client.id)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .forEach((item) => {
      const card = createEl("article", "card");
      card.appendChild(createEl("strong", "", item.title));

      const notesArea = createEl("textarea", "full");
      notesArea.value = item.notes || item.instructorNotes || "";
      notesArea.addEventListener("change", () => {
        item.notes = notesArea.value;
        item.updatedAt = new Date().toISOString();
        saveState();
      });

      const meta = createEl("p", "meta", `Updated ${formatDate(item.updatedAt)}`);
      const actions = createEl("div", "card-actions");
      const shareText = `${item.title}\n\nHomework:\n${item.notes || item.instructorNotes || ""}`;
      if (!Array.isArray(item.videos)) item.videos = [];

      const existingVideos = createEl("div", "full");
      item.videos.forEach((videoFile) => {
        const video = createEl("video", "homework-video");
        video.controls = true;
        video.src = videoFile.dataUrl;
        video.preload = "metadata";

        const videoRow = createEl("div", "card-actions homework-video-row");
        const label = createEl("span", "meta", `${videoFile.name} (${formatBytes(videoFile.size)})`);
        const removeVideoBtn = createEl("button", "button", "Remove Video");
        removeVideoBtn.type = "button";
        removeVideoBtn.addEventListener("click", () => {
          item.videos = item.videos.filter((v) => v.id !== videoFile.id);
          item.updatedAt = new Date().toISOString();
          saveState();
          renderHomeworkSection(client);
        });
        videoRow.append(label, removeVideoBtn);
        existingVideos.append(video, videoRow);
      });

      const attachWrap = createEl("div", "card-actions full");
      const attachInput = createEl("input");
      attachInput.type = "file";
      attachInput.accept = "video/*";
      attachInput.multiple = true;
      const attachBtn = createEl("button", "button", "Attach Video(s)");
      attachBtn.type = "button";
      attachBtn.addEventListener("click", async () => {
        const files = Array.from(attachInput.files || []);
        if (files.length === 0) return;
        if (!Array.isArray(item.videos)) item.videos = [];
        for (const file of files) {
          const dataUrl = await fileToDataUrl(file);
          item.videos.push({
            id: uid("hwvid"),
            name: file.name,
            type: file.type || "video/mp4",
            size: file.size || 0,
            dataUrl,
          });
        }
        item.updatedAt = new Date().toISOString();
        saveState();
        renderHomeworkSection(client);
      });
      attachWrap.append(attachInput, attachBtn);

      const emailLink = createEl("a", "button", "Share by Email");
      const subject = encodeURIComponent(`Homework for ${client.name}`);
      const body = encodeURIComponent(shareText);
      emailLink.href = `mailto:${client.email || ""}?subject=${subject}&body=${body}`;

      const textLink = createEl("a", "button", "Share by Text");
      const smsBody = encodeURIComponent(`${item.title}: ${item.notes || item.instructorNotes || ""}`);
      textLink.href = `sms:${client.phone || ""}?body=${smsBody}`;

      const copyBtn = createEl("button", "button", "Copy Share Text");
      copyBtn.type = "button";
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(shareText);
          copyBtn.textContent = "Copied";
          setTimeout(() => {
            copyBtn.textContent = "Copy Share Text";
          }, 1200);
        } catch {
          alert("Clipboard copy is not available in this browser.");
        }
      });

      const doneBtn = createEl("button", "button", item.done ? "Mark In Progress" : "Mark Done");
      doneBtn.type = "button";
      doneBtn.addEventListener("click", () => {
        item.done = !item.done;
        item.updatedAt = new Date().toISOString();
        saveState();
        renderHomeworkSection(client);
      });

      const deleteBtn = createEl("button", "button", "Delete");
      deleteBtn.type = "button";
      deleteBtn.addEventListener("click", () => {
        appState.homework = appState.homework.filter((h) => h.id !== item.id);
        saveState();
        renderHomeworkSection(client);
      });

      actions.append(emailLink, textLink, copyBtn, doneBtn, deleteBtn);

      if (item.done) {
        card.appendChild(createEl("p", "meta", "Status: Done"));
      }

      card.append(notesArea, existingVideos, attachWrap, meta, actions);
      list.appendChild(card);
    });
}

function renderFilesSection(client) {
  const form = document.getElementById("files-form");
  const list = document.getElementById("files-list");
  form.innerHTML = "";
  list.innerHTML = "";
  if (!client) return;

  const pickerLabel = createEl("label", "full");
  pickerLabel.textContent = "Choose file(s)";
  const picker = createEl("input");
  picker.type = "file";
  picker.multiple = true;
  pickerLabel.appendChild(picker);

  const note = createEl("p", "meta full", "Files are stored locally in this browser for this app.");
  const uploadBtn = createEl("button", "button primary", "Upload Files");
  uploadBtn.type = "button";
  uploadBtn.classList.add("full", "fit-content-row-cta");
  uploadBtn.addEventListener("click", async () => {
    const files = Array.from(picker.files || []);
    if (files.length === 0) return;

    for (const file of files) {
      const dataUrl = await new Promise((resolve, reject) => {
        fileToDataUrl(file).then(resolve).catch(reject);
      });

      appState.files.push({
        id: uid("file"),
        clientId: client.id,
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size || 0,
        uploadedAt: new Date().toISOString(),
        dataUrl,
      });
    }
    saveState();
    renderFilesSection(client);
  });

  form.append(pickerLabel, note, uploadBtn);

  appState.files
    .filter((f) => f.clientId === client.id)
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
    .forEach((file) => {
      const card = createEl("article", "card");
      const metaRow = createEl("p", "meta file-meta-row");
      const fileName = createEl("span", "file-name-inline", file.name);
      const fileDetails = createEl("span", "file-detail-inline", `| ${formatBytes(file.size)} | Uploaded ${formatDate(file.uploadedAt)}`);
      metaRow.append(fileName, fileDetails);
      card.appendChild(metaRow);

      const actions = createEl("div", "card-actions");
      const viewBtn = createEl("button", "button", "View in App");
      viewBtn.type = "button";
      viewBtn.addEventListener("click", () => {
        openFileViewer(file);
      });

      const openLink = createEl("a", "button", "Download");
      openLink.href = file.dataUrl;
      openLink.target = "_blank";
      openLink.rel = "noopener";
      openLink.download = file.name;

      const deleteBtn = createEl("button", "button", "Delete File");
      deleteBtn.type = "button";
      deleteBtn.addEventListener("click", () => {
        if (!confirm(`Delete file "${file.name}"?`)) return;
        appState.files = appState.files.filter((f) => f.id !== file.id);
        saveState();
        renderFilesSection(client);
      });

      actions.append(viewBtn, openLink, deleteBtn);
      card.appendChild(actions);
      list.appendChild(card);
    });

  if (list.children.length === 0) {
    list.appendChild(createEl("p", "meta", "No files uploaded for this client."));
  }
}

function renderResourcesSection() {
  const form = document.getElementById("resources-form");
  const list = document.getElementById("resources-list");
  form.innerHTML = "";
  list.innerHTML = "";

  const pickerLabel = createEl("label", "full");
  pickerLabel.textContent = "Upload resource file(s)";
  const picker = createEl("input");
  picker.type = "file";
  picker.multiple = true;
  pickerLabel.appendChild(picker);

  const uploadBtn = createEl("button", "button primary", "Upload Resource Files");
  uploadBtn.type = "button";
  uploadBtn.classList.add("full", "fit-content-row-cta");
  uploadBtn.addEventListener("click", async () => {
    const files = Array.from(picker.files || []);
    if (files.length === 0) return;
    for (const file of files) {
      const dataUrl = await fileToDataUrl(file);
      appState.resources.push({
        id: uid("resource"),
        kind: "file",
        name: file.name,
        type: file.type || "application/octet-stream",
        size: file.size || 0,
        uploadedAt: new Date().toISOString(),
        dataUrl,
      });
    }
    saveState();
    renderResourcesSection();
  });

  const linkTitleLabel = createEl("label");
  linkTitleLabel.textContent = "Resource Link Title";
  const linkTitleInput = createEl("input");
  linkTitleLabel.appendChild(linkTitleInput);

  const linkUrlLabel = createEl("label");
  linkUrlLabel.textContent = "Resource Link URL";
  const linkUrlInput = createEl("input");
  linkUrlInput.type = "url";
  linkUrlInput.placeholder = "https://";
  linkUrlLabel.appendChild(linkUrlInput);

  const addLinkBtn = createEl("button", "button", "Add Resource Link");
  addLinkBtn.type = "button";
  addLinkBtn.classList.add("full", "fit-content-row-cta");
  addLinkBtn.addEventListener("click", () => {
    const rawUrl = (linkUrlInput.value || "").trim();
    if (!rawUrl) return;
    let normalizedUrl = rawUrl;
    if (!/^https?:\/\//i.test(normalizedUrl)) normalizedUrl = `https://${normalizedUrl}`;
    try {
      new URL(normalizedUrl);
    } catch {
      alert("Please enter a valid URL.");
      return;
    }
    appState.resources.push({
      id: uid("resource"),
      kind: "link",
      name: (linkTitleInput.value || "").trim() || normalizedUrl,
      url: normalizedUrl,
      uploadedAt: new Date().toISOString(),
    });
    saveState();
    renderResourcesSection();
  });

  form.append(pickerLabel, uploadBtn, linkTitleLabel, linkUrlLabel, addLinkBtn);

  const resources = appState.resources
    .slice()
    .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

  const selection = new Set(appState.ui.resourceSelection || []);
  const sendSelectedBtn = createEl("button", "button", "Send Selected to Client");
  sendSelectedBtn.type = "button";
  sendSelectedBtn.classList.add("full", "fit-content-row-cta");
  sendSelectedBtn.disabled = selection.size === 0;
  sendSelectedBtn.addEventListener("click", () => openResourceShareDialog(Array.from(selection)));
  form.appendChild(sendSelectedBtn);

  if (resources.length === 0) {
    list.appendChild(createEl("p", "meta", "No shared resources added yet."));
    return;
  }

  const tableWrap = createEl("div", "resources-table-wrap");
  const table = createEl("table", "resources-table");
  const thead = createEl("thead");
  const headRow = createEl("tr");
  ["Resource", "Date Added", "Open", "Edit", "Delete", "Send to Client"].forEach((heading) => {
    headRow.appendChild(createEl("th", "", heading));
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = createEl("tbody");
  resources.forEach((resource) => {
    const row = createEl("tr");

    const titleCell = createEl("td");
    const titleWrap = createEl("div", "resource-title-cell");
    const checkbox = createEl("input");
    checkbox.type = "checkbox";
    checkbox.checked = selection.has(resource.id);
    checkbox.addEventListener("change", () => {
      const next = new Set(appState.ui.resourceSelection || []);
      if (checkbox.checked) next.add(resource.id);
      else next.delete(resource.id);
      appState.ui.resourceSelection = Array.from(next);
      renderResourcesSection();
    });
    const title = createEl("span", "", resource.name || "Resource");
    titleWrap.append(checkbox, title);
    titleCell.appendChild(titleWrap);
    row.appendChild(titleCell);

    row.appendChild(createEl("td", "", formatDate(resource.uploadedAt)));

    const openCell = createEl("td");
    if (resource.kind === "link") {
      const openLink = createEl("a", "table-link", "Open");
      openLink.href = resource.url;
      openLink.target = "_blank";
      openLink.rel = "noopener";
      openCell.appendChild(openLink);
    } else {
      const openLink = createEl("a", "table-link", "Open");
      openLink.href = resource.dataUrl;
      openLink.target = "_blank";
      openLink.rel = "noopener";
      openLink.download = resource.name;
      openCell.appendChild(openLink);
    }
    row.appendChild(openCell);

    const editCell = createEl("td");
    const editBtn = createEl("button", "text-link", "Edit");
    editBtn.type = "button";
    editBtn.addEventListener("click", () => openResourceEditDialog(resource.id));
    editCell.appendChild(editBtn);
    row.appendChild(editCell);

    const deleteCell = createEl("td");
    const deleteBtn = createEl("button", "text-link subdued", "Delete");
    deleteBtn.type = "button";
      deleteBtn.addEventListener("click", () => {
        if (!confirm(`Delete resource "${resource.name}"?`)) return;
        appState.resources = appState.resources.filter((r) => r.id !== resource.id);
        appState.resourceShares = (appState.resourceShares || []).filter((item) => item.resourceId !== resource.id);
        appState.ui.resourceSelection = (appState.ui.resourceSelection || []).filter((id) => id !== resource.id);
        saveState();
        renderResourcesSection();
      });
    deleteCell.appendChild(deleteBtn);
    row.appendChild(deleteCell);

    const sendCell = createEl("td");
    const sendBtn = createEl("button", "text-link", "Send");
    sendBtn.type = "button";
    sendBtn.addEventListener("click", () => openResourceShareDialog([resource.id]));
    sendCell.appendChild(sendBtn);
    row.appendChild(sendCell);

    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  list.appendChild(tableWrap);
}

function getFileExtension(name = "") {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

function buildResourceShareText(resources) {
  const lines = ["Move Well Pilates Resources", ""];
  resources.forEach((resource, index) => {
    lines.push(`${index + 1}. ${resource.name || "Resource"}`);
    if (resource.kind === "link" && resource.url) {
      lines.push(`   ${resource.url}`);
    } else {
      lines.push("   Shared file resource (available in app)");
    }
  });
  return lines.join("\n");
}

function assignResourcesToClient(clientId, resources, method) {
  if (!Array.isArray(appState.resourceShares)) appState.resourceShares = [];
  const now = new Date().toISOString();
  resources
    .filter((resource) => resource && resource.kind === "file")
    .forEach((resource) => {
      const existing = appState.resourceShares.find(
        (item) => item.clientId === clientId && item.resourceId === resource.id
      );
      if (existing) {
        existing.sharedAt = now;
        existing.method = method;
        return;
      }
      appState.resourceShares.push({
        id: uid("rshare"),
        clientId,
        resourceId: resource.id,
        method,
        sharedAt: now,
      });
    });
}

function openSessionNoteEditDialog(sessionId) {
  const dialog = document.getElementById("session-note-edit-dialog");
  const form = document.getElementById("session-note-edit-form");
  const dateInput = document.getElementById("session-note-edit-date");
  const notesInput = document.getElementById("session-note-edit-notes");
  if (!dialog || !form || !dateInput || !notesInput) return;

  const session = appState.visits.find((item) => item.id === sessionId);
  if (!session) return;
  form.dataset.sessionId = session.id;
  dateInput.value = session.date || "";
  notesInput.value = session.notes || "";
  openDialog(dialog);
}

function openResourceEditDialog(resourceId) {
  const dialog = document.getElementById("resource-edit-dialog");
  const form = document.getElementById("resource-edit-form");
  const titleInput = document.getElementById("resource-edit-title");
  const urlWrap = document.getElementById("resource-edit-url-wrap");
  const urlInput = document.getElementById("resource-edit-url");
  if (!dialog || !form || !titleInput || !urlWrap || !urlInput) return;

  const resource = appState.resources.find((item) => item.id === resourceId);
  if (!resource) return;

  form.dataset.resourceId = resource.id;
  titleInput.value = resource.name || "";
  const isLink = resource.kind === "link";
  urlWrap.style.display = isLink ? "grid" : "none";
  urlInput.required = isLink;
  urlInput.value = isLink ? (resource.url || "") : "";
  openDialog(dialog);
}

function openResourceShareDialog(resourceIds) {
  const dialog = document.getElementById("resource-share-dialog");
  const form = document.getElementById("resource-share-form");
  const count = document.getElementById("resource-share-count");
  const clientSelect = document.getElementById("resource-share-client");
  const methodSelect = document.getElementById("resource-share-method");
  if (!dialog || !form || !count || !clientSelect || !methodSelect) return;

  const cleanIds = Array.from(new Set((resourceIds || []).filter(Boolean)));
  if (cleanIds.length === 0) {
    alert("Select at least one resource to send.");
    return;
  }
  if (appState.clients.length === 0) {
    alert("Add a client first so you can send resources.");
    return;
  }

  form.dataset.resourceIds = cleanIds.join(",");
  count.textContent = `${cleanIds.length} resource(s) selected`;

  clientSelect.innerHTML = "";
  appState.clients
    .slice()
    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
    .forEach((client) => {
      const opt = createEl("option", "", client.name || "Unnamed Client");
      opt.value = client.id;
      clientSelect.appendChild(opt);
    });
  if (appState.selectedClientId && appState.clients.some((c) => c.id === appState.selectedClientId)) {
    clientSelect.value = appState.selectedClientId;
  }
  methodSelect.value = "email";
  openDialog(dialog);
}

function getFileViewerType(file) {
  const type = (file.type || "").toLowerCase();
  const ext = getFileExtension(file.name);
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf" || ext === "pdf") return "pdf";
  if (type.startsWith("text/") || ["txt", "csv", "json", "md", "xml", "html", "css", "js"].includes(ext)) return "text";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("video/")) return "video";
  if (["doc", "docx", "xls", "xlsx", "ppt", "pptx"].includes(ext)) return "office";
  return "unknown";
}

async function openFileViewer(file) {
  const dialog = document.getElementById("file-viewer-dialog");
  const title = document.getElementById("file-viewer-title");
  const content = document.getElementById("file-viewer-content");
  const download = document.getElementById("file-viewer-download");
  if (!dialog || !title || !content || !download) return;

  title.textContent = file.name || "File Viewer";
  download.href = file.dataUrl;
  download.download = file.name || "file";
  content.innerHTML = "";

  const viewerType = getFileViewerType(file);

  if (viewerType === "image") {
    const img = createEl("img");
    img.src = file.dataUrl;
    img.alt = file.name || "Image";
    content.appendChild(img);
  } else if (viewerType === "pdf") {
    const frame = createEl("iframe");
    frame.src = file.dataUrl;
    frame.title = file.name || "PDF";
    content.appendChild(frame);
  } else if (viewerType === "text") {
    try {
      const text = await fetch(file.dataUrl).then((r) => r.text());
      const pre = createEl("pre");
      pre.textContent = text;
      content.appendChild(pre);
    } catch {
      content.appendChild(createEl("p", "meta", "Preview failed. Use Download to open this file."));
    }
  } else if (viewerType === "audio") {
    const audio = createEl("audio");
    audio.controls = true;
    audio.src = file.dataUrl;
    content.appendChild(audio);
  } else if (viewerType === "video") {
    const video = createEl("video");
    video.controls = true;
    video.src = file.dataUrl;
    content.appendChild(video);
  } else if (viewerType === "office") {
    content.appendChild(
      createEl(
        "p",
        "meta",
        "Office files (Word/Excel/PowerPoint) usually cannot render natively in-browser. Use Download to open in the appropriate app."
      )
    );
  } else {
    const frame = createEl("iframe");
    frame.src = file.dataUrl;
    frame.title = file.name || "File";
    frame.addEventListener("error", () => {
      content.innerHTML = "";
      content.appendChild(createEl("p", "meta", "Preview unavailable for this file type. Use Download to open it."));
    });
    content.appendChild(frame);
  }

  dialog.showModal();
}

function renderSettingsForm() {
  const form = document.getElementById("settings-form");
  const squareCard = document.getElementById("square-connection");
  if (!form || !squareCard) return;
  form.innerHTML = "";
  squareCard.innerHTML = "";

  const title = createEl("strong", "", "Square Connection");
  const status = createEl("p", "meta", appState.square.statusMessage || "Checking status...");
  const actions = createEl("div", "card-actions");

  const connectBtn = createEl("button", "button", "Connect Square");
  connectBtn.type = "button";
  connectBtn.addEventListener("click", async () => {
    try {
      const data = await apiFetch("/api/square/oauth/start");
      window.location.assign(data.authorizeUrl);
    } catch (err) {
      alert(err.message);
    }
  });

  const refreshBtn = createEl("button", "button", "Refresh Status");
  refreshBtn.type = "button";
  refreshBtn.addEventListener("click", async () => {
    await refreshSquareStatus();
    await refreshRuntimeVersion();
    renderSettingsForm();
  });

  const disconnectBtn = createEl("button", "button", "Disconnect Square");
  disconnectBtn.type = "button";
  disconnectBtn.disabled = !appState.square.connected;
  disconnectBtn.addEventListener("click", async () => {
    try {
      await apiFetch("/api/square/disconnect", { method: "POST" });
      await refreshSquareStatus();
      render();
    } catch (err) {
      alert(err.message);
    }
  });

  actions.append(connectBtn, refreshBtn, disconnectBtn);
  squareCard.append(title, status, actions);

  const versionRow = createEl("p", "meta");
  const versionText = appState.runtime.version || "unavailable";
  const envText = appState.runtime.environment ? ` (${appState.runtime.environment})` : "";
  versionRow.textContent = `App Version: ${versionText}${envText}`;
  squareCard.appendChild(versionRow);

  const makeNumberField = (labelText, value, onChange) => {
    const label = createEl("label");
    label.textContent = labelText;
    const input = createEl("input");
    input.type = "number";
    input.step = "0.01";
    input.value = value;
    input.addEventListener("change", () => {
      onChange(Number(input.value));
      saveState();
      render();
    });
    label.appendChild(input);
    return label;
  };

  form.appendChild(
    makeNumberField("Sales Tax Rate (%)", appState.settings.taxRate, (v) => {
      appState.settings.taxRate = Number.isFinite(v) ? v : 0;
    })
  );

  form.appendChild(
    makeNumberField("Package Validity (days)", appState.settings.validityDays, (v) => {
      appState.settings.validityDays = Number.isFinite(v) ? v : 90;
    })
  );

  const neverExpiresLabel = createEl("label", "inline-checkbox-row");
  neverExpiresLabel.textContent = "Default for new packages: Never Expires";
  const neverExpiresInput = createEl("input");
  neverExpiresInput.type = "checkbox";
  neverExpiresInput.checked = Boolean(appState.settings.neverExpiresDefault);
  neverExpiresInput.addEventListener("change", () => {
    appState.settings.neverExpiresDefault = neverExpiresInput.checked;
    saveState();
    render();
  });
  neverExpiresLabel.appendChild(neverExpiresInput);
  form.appendChild(neverExpiresLabel);

  PACKAGE_TYPES.forEach((pkg) => {
    form.appendChild(
      makeNumberField(`${pkg.label} Price`, appState.settings.prices[pkg.key], (v) => {
        appState.settings.prices[pkg.key] = Number.isFinite(v) ? v : 0;
      })
    );
  });

  const summary = createEl("div", "card full");
  const summaryText = PACKAGE_TYPES.map((pkg) => `${pkg.label}: ${formatMoney(appState.settings.prices[pkg.key])}`).join(" | ");
  summary.innerHTML = `
    <strong>Current Pricing Summary</strong>
    <p class="meta">Tax: ${appState.settings.taxRate}%</p>
    <p class="meta">${summaryText}</p>
  `;
  form.appendChild(summary);
}

function render() {
  renderClientList();
  const client = selectedClient();
  const activeTab = appState.ui.activeTab || "overview";
  const topPage = appState.ui.topPage || "clients";
  document.getElementById("active-client-name").textContent = client ? client.name || "Unnamed Client" : "Select a client";
  renderAlerts(client);
  renderClientForm(client);
  renderVisitSection(client);
  renderPackageSection(client);
  renderHomeworkSection(client);
  renderFilesSection(client);
  renderResourcesSection();
  renderSettingsForm();
  renderSystemStatusBanner();
  setTopPage(topPage);
  setActiveTab(activeTab);
}

function setActiveTab(tabKey) {
  const activeKey = TAB_LABELS[tabKey] ? tabKey : "overview";
  appState.ui.activeTab = activeKey;
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === activeKey);
  });
  document.querySelectorAll("#clients-page .tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `${activeKey}-panel`);
  });
  const label = document.getElementById("mobile-active-tab");
  if (label) label.textContent = TAB_LABELS[activeKey] || "Overview";
  const tabRow = document.querySelector(".tab-row");
  const menuBtn = document.getElementById("tab-menu-btn");
  if (window.matchMedia("(max-width: 980px)").matches && tabRow) {
    tabRow.classList.remove("mobile-open");
    if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
  }
}

function setTopPage(pageKey) {
  const activePage = TOP_PAGES[pageKey] ? pageKey : "clients";
  appState.ui.topPage = activePage;
  document.querySelectorAll(".app-page").forEach((page) => {
    page.classList.toggle("active", page.id === `${activePage}-page`);
  });

  const clientsBtn = document.getElementById("nav-clients-btn");
  const resourcesBtn = document.getElementById("nav-resources-btn");
  const settingsBtn = document.getElementById("nav-settings-btn");
  if (clientsBtn) clientsBtn.classList.toggle("active", activePage === "clients");
  if (resourcesBtn) resourcesBtn.classList.toggle("active", activePage === "resources");
  if (settingsBtn) settingsBtn.classList.toggle("active", activePage === "settings");
  closeTopNavMenu();
}

function closeTopNavMenu() {
  const menuBtn = document.getElementById("top-nav-menu-btn");
  const actions = document.querySelector(".header-actions");
  if (!actions) return;
  actions.classList.remove("mobile-open");
  if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
}

function setupTabs() {
  const tabRow = document.querySelector(".tab-row");
  const menuBtn = document.getElementById("tab-menu-btn");
  document.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
  });
  if (menuBtn && tabRow) {
    menuBtn.addEventListener("click", () => {
      const open = tabRow.classList.toggle("mobile-open");
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.addEventListener("click", (event) => {
      if (!window.matchMedia("(max-width: 980px)").matches) return;
      const clickInsideTabs = tabRow.contains(event.target) || menuBtn.contains(event.target);
      if (clickInsideTabs) return;
      tabRow.classList.remove("mobile-open");
      menuBtn.setAttribute("aria-expanded", "false");
    });
  }
}

function setupTopNav() {
  const clientsBtn = document.getElementById("nav-clients-btn");
  const resourcesBtn = document.getElementById("nav-resources-btn");
  const settingsBtn = document.getElementById("nav-settings-btn");
  const menuBtn = document.getElementById("top-nav-menu-btn");
  const actions = document.querySelector(".header-actions");
  if (clientsBtn) clientsBtn.addEventListener("click", () => setTopPage("clients"));
  if (resourcesBtn) resourcesBtn.addEventListener("click", () => setTopPage("resources"));
  if (settingsBtn) settingsBtn.addEventListener("click", () => setTopPage("settings"));

  if (menuBtn && actions) {
    menuBtn.addEventListener("click", () => {
      const open = actions.classList.toggle("mobile-open");
      menuBtn.setAttribute("aria-expanded", open ? "true" : "false");
    });

    document.addEventListener("click", (event) => {
      if (!window.matchMedia("(max-width: 980px)").matches) return;
      if (actions.contains(event.target) || menuBtn.contains(event.target)) return;
      closeTopNavMenu();
    });

    window.addEventListener("resize", () => {
      if (!window.matchMedia("(max-width: 980px)").matches) closeTopNavMenu();
    });
  }
}

function setupNewClientDialog() {
  const dialog = document.getElementById("client-dialog");
  const form = document.getElementById("client-dialog-form");
  const cancelBtn = document.getElementById("client-dialog-cancel-btn");
  document.getElementById("new-client-btn").addEventListener("click", () => {
    closeTopNavMenu();
    openDialog(dialog);
  });
  if (cancelBtn) cancelBtn.addEventListener("click", () => closeDialog(dialog));

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);
    const submitBtn = form.querySelector('button[type="submit"]');
    const payload = {
      name: (data.get("name") || "").toString().trim(),
      email: (data.get("email") || "").toString().trim(),
      phone: (data.get("phone") || "").toString().trim(),
    };
    if (!payload.name) {
      alert("Client name is required.");
      return;
    }
    setButtonLoading(submitBtn, true, "Saving...");
    try {
      const result = await apiCreateClient(payload);
      if (result?.client?.id) appState.selectedClientId = result.client.id;
      form.reset();
      closeDialog(dialog);
      await refreshStateAndRender();
    } catch (err) {
      alert(err.message || "Failed to add client.");
    } finally {
      setButtonLoading(submitBtn, false);
    }
  });
}

function setupResourceDialogs() {
  const editDialog = document.getElementById("resource-edit-dialog");
  const editForm = document.getElementById("resource-edit-form");
  const editCancel = document.getElementById("resource-edit-cancel-btn");
  const editTitle = document.getElementById("resource-edit-title");
  const editUrl = document.getElementById("resource-edit-url");
  if (editDialog && editForm && editCancel && editTitle && editUrl) {
    editCancel.addEventListener("click", () => closeDialog(editDialog));
    editForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const resourceId = editForm.dataset.resourceId;
      const resource = appState.resources.find((item) => item.id === resourceId);
      if (!resource) return;

      const nextTitle = (editTitle.value || "").trim();
      if (!nextTitle) {
        alert("Title is required.");
        return;
      }
      resource.name = nextTitle;

      if (resource.kind === "link") {
        const rawUrl = (editUrl.value || "").trim();
        if (!rawUrl) {
          alert("URL is required for a link resource.");
          return;
        }
        let normalizedUrl = rawUrl;
        if (!/^https?:\/\//i.test(normalizedUrl)) normalizedUrl = `https://${normalizedUrl}`;
        try {
          new URL(normalizedUrl);
        } catch {
          alert("Please enter a valid URL.");
          return;
        }
        resource.url = normalizedUrl;
      }

      resource.updatedAt = new Date().toISOString();
      saveState();
      closeDialog(editDialog);
      renderResourcesSection();
    });
  }

  const shareDialog = document.getElementById("resource-share-dialog");
  const shareForm = document.getElementById("resource-share-form");
  const shareCancel = document.getElementById("resource-share-cancel-btn");
  const shareClient = document.getElementById("resource-share-client");
  const shareMethod = document.getElementById("resource-share-method");
  if (shareDialog && shareForm && shareCancel && shareClient && shareMethod) {
    shareCancel.addEventListener("click", () => closeDialog(shareDialog));
    shareForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const ids = (shareForm.dataset.resourceIds || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      if (ids.length === 0) return;

      const resources = ids
        .map((id) => appState.resources.find((item) => item.id === id))
        .filter(Boolean);
      if (resources.length === 0) {
        alert("No resources found to send.");
        return;
      }

      const client = appState.clients.find((item) => item.id === shareClient.value);
      if (!client) {
        alert("Please select a client.");
        return;
      }

      const method = shareMethod.value;
      const shareText = buildResourceShareText(resources);
      if (method === "email") {
        if (!client.email) {
          alert("This client does not have an email address.");
          return;
        }
        assignResourcesToClient(client.id, resources, method);
        saveState();
        const subject = encodeURIComponent(`Resources from Move Well Pilates`);
        const body = encodeURIComponent(shareText);
        window.location.assign(`mailto:${client.email}?subject=${subject}&body=${body}`);
      } else {
        if (!client.phone) {
          alert("This client does not have a phone number.");
          return;
        }
        assignResourcesToClient(client.id, resources, method);
        saveState();
        const body = encodeURIComponent(shareText);
        window.location.assign(`sms:${client.phone}?body=${body}`);
      }
      closeDialog(shareDialog);
      renderResourcesSection();
    });
  }
}

function setupSessionNoteDialog() {
  const dialog = document.getElementById("session-note-edit-dialog");
  const form = document.getElementById("session-note-edit-form");
  const cancelBtn = document.getElementById("session-note-edit-cancel-btn");
  const dateInput = document.getElementById("session-note-edit-date");
  const notesInput = document.getElementById("session-note-edit-notes");
  if (!dialog || !form || !cancelBtn || !dateInput || !notesInput) return;

  cancelBtn.addEventListener("click", () => closeDialog(dialog));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const sessionId = form.dataset.sessionId;
    const session = appState.visits.find((item) => item.id === sessionId);
    if (!session) return;
    const submitBtn = form.querySelector('button[type="submit"]');
    setButtonLoading(submitBtn, true, "Saving...");
    try {
      await apiUpdateSessionNote(sessionId, {
        date: dateInput.value || session.date,
        notes: notesInput.value || "",
      });
      closeDialog(dialog);
      await refreshStateAndRender();
    } catch (err) {
      alert(err.message || "Failed to update session note.");
      setButtonLoading(submitBtn, false);
    }
  });
}

function setupSessionUseDateDialog() {
  const dialog = document.getElementById("session-use-date-dialog");
  const form = document.getElementById("session-use-date-form");
  const input = document.getElementById("session-use-date-input");
  const cancelBtn = document.getElementById("session-use-date-cancel-btn");
  const title = document.getElementById("session-use-date-title");
  const submitBtn = document.getElementById("session-use-date-submit-btn");
  if (!dialog || !form || !input || !cancelBtn || !title || !submitBtn) return;

  cancelBtn.addEventListener("click", () => {
    pendingSessionUsePackageId = null;
    pendingSessionDateEdit = null;
    pendingSessionUndoPackageId = null;
    title.textContent = "Use 1 Session";
    submitBtn.textContent = "Use Session";
    closeDialog(dialog);
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!input.value) input.value = toPacificDateInputValue();
    if (!pendingSessionUsePackageId && !pendingSessionDateEdit && !pendingSessionUndoPackageId) {
      closeDialog(dialog);
      return;
    }
    setButtonLoading(submitBtn, true, "Saving...");

    if (pendingSessionDateEdit) {
      const editRef = pendingSessionDateEdit;
      pendingSessionDateEdit = null;
      pendingSessionUsePackageId = null;
      pendingSessionUndoPackageId = null;
      try {
        await apiEditPackageSessionDate(editRef.packageId, editRef.useIndex, input.value);
        await refreshStateAndRender();
      } catch (err) {
        alert(err.message || "Failed to update session date.");
      }
      title.textContent = "Use 1 Session";
      delete submitBtn.dataset.originalText;
      submitBtn.textContent = "Use Session";
      closeDialog(dialog);
      const refreshedPkg = appState.packages.find((item) => item.id === editRef.packageId);
      if (refreshedPkg) openSessionHistoryDialog(refreshedPkg);
      setButtonLoading(submitBtn, false);
      return;
    }

    if (pendingSessionUndoPackageId) {
      const undoPackageId = pendingSessionUndoPackageId;
      pendingSessionUndoPackageId = null;
      pendingSessionUsePackageId = null;
      pendingSessionDateEdit = null;
      try {
        await apiUndoPackageSessionByDate(undoPackageId, input.value);
        await refreshStateAndRender();
      } catch (err) {
        alert(err.message || "Failed to undo session.");
      }
      title.textContent = "Use 1 Session";
      delete submitBtn.dataset.originalText;
      submitBtn.textContent = "Use Session";
      closeDialog(dialog);
      setButtonLoading(submitBtn, false);
      return;
    }

    const packageId = pendingSessionUsePackageId;
    pendingSessionUsePackageId = null;
    pendingSessionUndoPackageId = null;
    if (!packageId) {
      closeDialog(dialog);
      return;
    }
    try {
      await apiUsePackageSession(packageId, input.value);
      await refreshStateAndRender();
    } catch (err) {
      alert(err.message || "Failed to record used session.");
    }
    title.textContent = "Use 1 Session";
    delete submitBtn.dataset.originalText;
    submitBtn.textContent = "Use Session";
    closeDialog(dialog);
    setButtonLoading(submitBtn, false);
  });
}

function setupSquareImportButton() {
  const btn = document.getElementById("square-import-btn");
  const statusEl = document.getElementById("square-import-status");
  if (!btn || !statusEl) return;

  btn.addEventListener("click", async () => {
    if (!appState.square.connected) {
      statusEl.textContent = "Connect Square first in Settings.";
      return;
    }

    try {
      statusEl.textContent = "Fetching latest payments...";
      const data = await apiFetch("/api/square/payments?limit=25");
      appState.square.recentPayments = (data.payments || []).filter((payment) => !isIgnoredSquarePayment(payment.id));
      statusEl.textContent = `Loaded ${appState.square.recentPayments.length} payment(s).`;
      renderPackageSection(selectedClient());
    } catch (err) {
      statusEl.textContent = err.message;
    }
  });
}

function seedIfEmpty() {
  if (appState.clients.length > 0) {
    return;
  }
  const demoClient = {
    id: uid("client"),
    name: "Sample Client",
    email: "client@example.com",
    phone: "",
    address: "",
    birthday: "",
    notes: "Use + New Client to add your real clients.",
    createdAt: new Date().toISOString(),
  };
  appState.clients.push(demoClient);
  appState.selectedClientId = demoClient.id;
  saveState();
}

function applyStarterClientView() {
  appState.selectedClientId = null;
  appState.ui.topPage = "clients";
  appState.ui.activeTab = "overview";
}

function setAdminView(isAuthed) {
  const loginView = document.getElementById("admin-login-view");
  const appView = document.getElementById("admin-app-view");
  if (loginView) loginView.hidden = isAuthed;
  if (appView) appView.hidden = !isAuthed;
}

function setAdminLoginError(message) {
  const errorEl = document.getElementById("admin-login-error");
  if (!errorEl) return;
  if (!message) {
    errorEl.hidden = true;
    errorEl.textContent = "";
    return;
  }
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function setAdminLoginStatus(message) {
  const statusEl = document.getElementById("admin-login-status");
  if (!statusEl) return;
  if (!message) {
    statusEl.hidden = true;
    statusEl.textContent = "";
    return;
  }
  statusEl.hidden = false;
  statusEl.textContent = message;
}

function setupAdminLoginForm() {
  const form = document.getElementById("admin-login-form");
  const emailInput = document.getElementById("admin-login-email");
  const passwordInput = document.getElementById("admin-login-password");
  const submitBtn = document.getElementById("admin-login-submit");
  const logoutBtn = document.getElementById("admin-logout-btn");

  if (form && emailInput && passwordInput) {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      setAdminLoginError("");
      setAdminLoginStatus("Signing in...");
      if (submitBtn) submitBtn.disabled = true;
      try {
        const data = await apiFetch("/api/admin/login", {
          method: "POST",
          body: JSON.stringify({
            email: (emailInput.value || "").trim(),
            password: passwordInput.value || "",
          }),
        });
        adminToken = data.token || "";
        if (!adminToken) throw new Error("Login failed.");
        persistAdminToken(adminToken);
        setAdminView(true);
        setAdminLoginStatus("");
        await startApp();
        applyStarterClientView();
        render();
      } catch (err) {
        adminToken = "";
        clearAdminToken();
        setAdminView(false);
        setAdminLoginStatus("");
        setAdminLoginError(err.message || "Login failed.");
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener("click", async () => {
      try {
        await apiFetch("/api/admin/logout", { method: "POST" });
      } catch {
        // ignore logout API errors
      }
      adminToken = "";
      clearAdminToken();
      setAdminView(false);
      setAdminLoginError("");
    });
  }
}

let appStarted = false;
async function startApp() {
  if (appStarted) {
    render();
    return;
  }
  appStarted = true;
  loadState();
  await syncStateFromCloud();
  seedIfEmpty();
  setupTopNav();
  setupTabs();
  setupNewClientDialog();
  setupResourceDialogs();
  setupSessionNoteDialog();
  setupSessionUseDateDialog();
  setupSquareImportButton();
  document.getElementById("client-search").addEventListener("input", renderClientList);

  const query = new URLSearchParams(window.location.search);
  if (query.get("square") === "connected") {
    appState.square.statusMessage = "Square connected successfully.";
    window.history.replaceState({}, "", window.location.pathname);
  }

  await refreshSquareStatus();
  await refreshRuntimeVersion();
  await refreshSystemHealth();
  if (!healthPollTimer) {
    healthPollTimer = setInterval(() => {
      refreshSystemHealth().catch(() => {});
    }, 45000);
  }
  render();
}

async function init() {
  setupAdminLoginForm();
  const isAuthed = Boolean(adminToken);
  setAdminView(isAuthed);
  if (!isAuthed) return;
  try {
    await startApp();
    applyStarterClientView();
    render();
  } catch (err) {
    adminToken = "";
    clearAdminToken();
    setAdminView(false);
    setAdminLoginError(err?.message || "Could not load app after login. Please try again.");
  }
}

init();
