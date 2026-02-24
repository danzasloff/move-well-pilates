const STORAGE_KEY = "moveWellPortalSession";

const el = {
  loginCard: document.getElementById("login-card"),
  loginForm: document.getElementById("login-form"),
  loginEmail: document.getElementById("login-email"),
  loginLast4: document.getElementById("login-last4"),
  loginError: document.getElementById("login-error"),
  inquiryCard: document.getElementById("inquiry-card"),
  portalCard: document.getElementById("portal-card"),
  clientName: document.getElementById("client-name"),
  clientContact: document.getElementById("client-contact"),
  packageList: document.getElementById("package-list"),
  homeworkList: document.getElementById("homework-list"),
  resourceList: document.getElementById("resource-list"),
  logoutBtn: document.getElementById("logout-btn"),
  manageApptBtn: document.getElementById("manage-appt-btn"),
  manageApptHelp: document.getElementById("manage-appt-help"),
  newInquiryBtn: document.getElementById("new-client-inquiry-btn"),
  inquiryDialog: document.getElementById("new-client-request-dialog"),
  inquiryForm: document.getElementById("new-client-request-form"),
  inquiryCancel: document.getElementById("new-client-request-cancel"),
  inquiryName: document.getElementById("inq-name"),
  inquiryEmail: document.getElementById("inq-email"),
  inquiryPhone: document.getElementById("inq-phone"),
  inquiryReferral: document.getElementById("inq-referral"),
  inquiryHelp: document.getElementById("inq-help"),
  inquiryStatus: document.getElementById("inq-status"),
};

function formatDate(value) {
  if (!value) return "";
  return new Date(value).toLocaleDateString();
}

function packageLabel(type) {
  const map = {
    single: "Single Session",
    five: "5-Session Package",
    ten: "10-Session Package",
    semiSingle: "Single Session Semi Private",
    semiTen: "10-Session Semi Private",
  };
  return map[type] || type || "Package";
}

function saveToken(token) {
  localStorage.setItem(STORAGE_KEY, token);
}

function readToken() {
  return localStorage.getItem(STORAGE_KEY) || "";
}

function clearToken() {
  localStorage.removeItem(STORAGE_KEY);
}

function setLoginError(message) {
  if (!message) {
    el.loginError.hidden = true;
    el.loginError.textContent = "";
    return;
  }
  el.loginError.hidden = false;
  el.loginError.textContent = message;
}

function setSignedInState(signedIn) {
  el.loginCard.hidden = signedIn;
  if (el.loginCard) el.loginCard.style.display = signedIn ? "none" : "";
  if (el.inquiryCard) {
    el.inquiryCard.hidden = signedIn;
    el.inquiryCard.style.display = signedIn ? "none" : "";
  }
  el.portalCard.hidden = !signedIn;
  if (el.portalCard) el.portalCard.style.display = signedIn ? "" : "none";
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

function renderPackages(packages) {
  el.packageList.innerHTML = "";
  if (!Array.isArray(packages) || packages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No packages on file.";
    el.packageList.appendChild(empty);
    return;
  }

  packages.forEach((pkg) => {
    const card = document.createElement("article");
    card.className = "item";

    const title = document.createElement("strong");
    title.textContent = `${packageLabel(pkg.type)} | ${pkg.sessionsRemaining}/${pkg.sessionsTotal} remaining`;

    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `Purchased ${formatDate(pkg.purchaseDate)} | Expires ${pkg.neverExpires ? "Never" : formatDate(pkg.expiresAt) || "-"}`;

    card.append(title, meta);
    el.packageList.appendChild(card);
  });
}

function renderHomework(homework) {
  el.homeworkList.innerHTML = "";
  if (!Array.isArray(homework) || homework.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No homework assigned right now.";
    el.homeworkList.appendChild(empty);
    return;
  }

  homework.forEach((item) => {
    const card = document.createElement("article");
    card.className = "item";

    const title = document.createElement("strong");
    title.textContent = item.title || "Homework";

    const notes = document.createElement("p");
    notes.textContent = item.notes || "No notes provided.";

    const meta = document.createElement("p");
    meta.className = "meta";
    meta.textContent = `Updated ${formatDate(item.updatedAt)}${item.done ? " | Marked Done" : ""}`;

    card.append(title, notes, meta);

    const videos = Array.isArray(item.videos) ? item.videos : [];
    videos.forEach((videoFile) => {
      const video = document.createElement("video");
      video.className = "video";
      video.controls = true;
      video.src = videoFile.dataUrl;
      video.preload = "metadata";
      card.appendChild(video);
    });

    el.homeworkList.appendChild(card);
  });
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let size = bytes;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(size >= 10 || unit === 0 ? 0 : 1)} ${units[unit]}`;
}

function renderResources(resources) {
  el.resourceList.innerHTML = "";
  if (!Array.isArray(resources) || resources.length === 0) {
    const empty = document.createElement("p");
    empty.className = "hint";
    empty.textContent = "No resources shared yet.";
    el.resourceList.appendChild(empty);
    return;
  }

  resources.forEach((resource) => {
    const card = document.createElement("article");
    card.className = "item";

    const title = document.createElement("strong");
    title.textContent = resource.name || "Resource";

    const meta = document.createElement("p");
    meta.className = "meta";
    const details = [formatBytes(resource.size), `Added ${formatDate(resource.dateAdded)}`].filter(Boolean);
    meta.textContent = details.join(" | ");

    const download = document.createElement("a");
    download.className = "button";
    download.href = resource.dataUrl;
    download.download = resource.name || "resource";
    download.textContent = "Download";

    card.append(title, meta, download);
    el.resourceList.appendChild(card);
  });
}

async function loadPortalData(token) {
  const res = await fetch(`/api/client-portal/me?token=${encodeURIComponent(token)}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Failed to load portal data.");
  return data;
}

async function attemptRestoreSession() {
  const token = readToken();
  if (!token) return;
  try {
    const data = await loadPortalData(token);
    hydratePortal(data);
  } catch {
    clearToken();
    setSignedInState(false);
  }
}

function hydratePortal(data) {
  const client = data.client || {};
  el.clientName.textContent = client.name || "Client";
  el.clientContact.textContent = [client.email, client.phone].filter(Boolean).join(" | ");
  renderPackages(data.packages || []);
  renderHomework(data.homework || []);
  renderResources(data.resources || []);
  setSignedInState(true);
}

el.loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoginError("");

  const email = String(el.loginEmail.value || "").trim();
  const phoneLast4 = String(el.loginLast4.value || "").replace(/\D/g, "").slice(-4);

  if (!email || phoneLast4.length !== 4) {
    setLoginError("Please enter a valid email and 4-digit phone check.");
    return;
  }

  try {
    const res = await fetch("/api/client-portal/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, phoneLast4 }),
    });
    const loginData = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(loginData.error || "Sign-in failed.");

    const token = loginData.token;
    saveToken(token);
    const portalData = await loadPortalData(token);
    hydratePortal(portalData);
  } catch (err) {
    setLoginError(err.message || "Sign-in failed.");
  }
});

el.logoutBtn.addEventListener("click", () => {
  clearToken();
  setSignedInState(false);
  el.loginForm.reset();
});

if (el.manageApptBtn && el.manageApptHelp) {
  el.manageApptBtn.addEventListener("click", () => {
    el.manageApptHelp.hidden = false;
  });
}

if (el.newInquiryBtn && el.inquiryDialog) {
  el.newInquiryBtn.addEventListener("click", () => {
    openDialog(el.inquiryDialog);
  });
}

if (el.inquiryCancel && el.inquiryDialog) {
  el.inquiryCancel.addEventListener("click", () => {
    closeDialog(el.inquiryDialog);
    if (el.inquiryStatus) {
      el.inquiryStatus.hidden = true;
      el.inquiryStatus.classList.remove("error");
      el.inquiryStatus.textContent = "";
    }
  });
}

if (
  el.inquiryForm &&
  el.inquiryName &&
  el.inquiryEmail &&
  el.inquiryPhone &&
  el.inquiryReferral &&
  el.inquiryHelp &&
  el.inquiryDialog
) {
  el.inquiryForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = String(el.inquiryName.value || "").trim();
    const email = String(el.inquiryEmail.value || "").trim();
    const phone = String(el.inquiryPhone.value || "").trim();
    const referral = String(el.inquiryReferral.value || "").trim();
    const helpWith = String(el.inquiryHelp.value || "").trim();

    const submitBtn = el.inquiryForm.querySelector('button[type="submit"]');
    const cancelBtn = el.inquiryCancel;
    if (submitBtn) submitBtn.disabled = true;
    if (cancelBtn) cancelBtn.disabled = true;
    if (el.inquiryStatus) {
      el.inquiryStatus.hidden = false;
      el.inquiryStatus.classList.remove("error");
      el.inquiryStatus.textContent = "Sending request...";
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 22000);

    fetch("/api/client-portal/new-client-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({ name, email, phone, referral, helpWith }),
    })
      .then(async (res) => {
        clearTimeout(timeoutId);
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Could not send request.");
        if (el.inquiryStatus) {
          el.inquiryStatus.classList.remove("error");
          el.inquiryStatus.textContent = "Request sent. Shane will follow up soon.";
        }
        setTimeout(() => {
          closeDialog(el.inquiryDialog);
          el.inquiryForm.reset();
          if (el.inquiryStatus) {
            el.inquiryStatus.hidden = true;
            el.inquiryStatus.textContent = "";
          }
        }, 800);
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        if (el.inquiryStatus) {
          el.inquiryStatus.hidden = false;
          el.inquiryStatus.classList.add("error");
          el.inquiryStatus.textContent =
            err.name === "AbortError"
              ? "Request timed out. Please try again."
              : err.message || "Could not send request.";
        }
      })
      .finally(() => {
        if (submitBtn) submitBtn.disabled = false;
        if (cancelBtn) cancelBtn.disabled = false;
      });
  });
}

attemptRestoreSession();
