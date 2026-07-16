"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let selectedFiles = []; // File objects
let currentListing = null;

const MAX_FILES = 6;
const MAX_SIZE = 8 * 1024 * 1024;

const LIMITS = {
  "appStore.title": 30,
  "appStore.subtitle": 30,
  "appStore.promotionalText": 170,
  "appStore.description": 4000,
  "appStore.keywords": 100,
  "googlePlay.title": 30,
  "googlePlay.shortDescription": 80,
  "googlePlay.fullDescription": 4000,
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------
// Mode banner
// ---------------------------------------------------------------------------
fetch("/api/health")
  .then((r) => r.json())
  .then((h) => {
    if (!h.aiConfigured) {
      const b = $("modeBanner");
      b.textContent =
        "⚠ Running in offline template mode — set OPENAI_API_KEY and restart the server for AI-written listings.";
      b.classList.remove("hidden");
    }
  })
  .catch(() => {});

// ---------------------------------------------------------------------------
// Screenshot upload (click + drag & drop)
// ---------------------------------------------------------------------------
const dropZone = $("dropZone");
const fileInput = $("fileInput");

dropZone.addEventListener("click", () => fileInput.click());
dropZone.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") fileInput.click();
});
fileInput.addEventListener("change", () => {
  addFiles([...fileInput.files]);
  fileInput.value = "";
});

["dragover", "dragenter"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  })
);
["dragleave", "drop"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
  })
);
dropZone.addEventListener("drop", (e) => addFiles([...e.dataTransfer.files]));

function addFiles(files) {
  for (const f of files) {
    if (!/^image\/(png|jpe?g|webp|gif)$/i.test(f.type)) {
      alert(`"${f.name}" skipped — only PNG, JPG, WebP or GIF images are allowed.`);
      continue;
    }
    if (f.size > MAX_SIZE) {
      alert(`"${f.name}" skipped — larger than 8 MB.`);
      continue;
    }
    if (selectedFiles.length >= MAX_FILES) {
      alert(`Maximum ${MAX_FILES} screenshots.`);
      break;
    }
    selectedFiles.push(f);
  }
  renderPreviews();
}

function renderPreviews() {
  const wrap = $("previews");
  wrap.innerHTML = "";
  selectedFiles.forEach((f, i) => {
    const div = document.createElement("div");
    div.className = "preview";
    const img = document.createElement("img");
    img.alt = f.name;
    const url = URL.createObjectURL(f);
    img.src = url;
    img.onload = () => URL.revokeObjectURL(url);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "✕";
    btn.title = "Remove";
    btn.addEventListener("click", () => {
      selectedFiles.splice(i, 1);
      renderPreviews();
    });
    div.append(img, btn);
    wrap.appendChild(div);
  });
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------
$("listingForm").addEventListener("submit", async (e) => {
  e.preventDefault();

  const fd = new FormData(e.target);
  selectedFiles.forEach((f) => fd.append("screenshots", f));

  $("generateBtn").disabled = true;
  $("loading").classList.remove("hidden");
  $("results").innerHTML = "";
  $("warning").classList.add("hidden");
  $("exportBar").classList.add("hidden");

  try {
    const res = await fetch("/api/generate", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

    currentListing = data.listing;
    if (data.warning) {
      const w = $("warning");
      w.textContent = "⚠ " + data.warning;
      w.classList.remove("hidden");
    }
    renderResults(data);
    $("exportBar").classList.remove("hidden");
  } catch (err) {
    $("results").innerHTML = "";
    const p = document.createElement("p");
    p.className = "placeholder";
    p.textContent = "❌ " + err.message;
    $("results").appendChild(p);
  } finally {
    $("generateBtn").disabled = false;
    $("loading").classList.add("hidden");
  }
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fieldBlock(label, value, limitKey) {
  const field = el("div", "field");
  const head = el("div", "field-head");
  head.appendChild(el("span", "name", label));

  const limit = limitKey ? LIMITS[limitKey] : null;
  if (limit) {
    const len = (value || "").length;
    const count = el("span", "count" + (len > limit ? " over" : ""), `${len}/${limit}`);
    head.appendChild(count);
  }

  const copy = el("button", "copy-btn", "📋 Copy");
  copy.type = "button";
  copy.addEventListener("click", async () => {
    await copyText(value || "");
    copy.textContent = "✓ Copied";
    setTimeout(() => (copy.textContent = "📋 Copy"), 1200);
  });
  head.appendChild(copy);

  field.appendChild(head);
  field.appendChild(el("div", "value", value || "—"));
  return field;
}

function section(title) {
  const s = el("div", "section");
  s.appendChild(el("h3", null, title));
  const body = el("div", "body");
  s.appendChild(body);
  return { root: s, body };
}

function renderResults(data) {
  const L = data.listing;
  const results = $("results");
  results.innerHTML = "";

  results.appendChild(
    el(
      "p",
      "source-note",
      data.source === "ai"
        ? `Generated by ${data.provider || "AI"} (${data.model})`
        : "Generated by the offline template engine"
    )
  );

  const overview = section("📌 Overview");
  overview.body.appendChild(fieldBlock("App name", L.appName));
  if (L.companyName) overview.body.appendChild(fieldBlock("Company", L.companyName));
  overview.body.appendChild(fieldBlock("Tagline", L.tagline));
  overview.body.appendChild(fieldBlock("Suggested category", L.categorySuggestion));
  results.appendChild(overview.root);

  const ios = section(" Apple App Store");
  const a = L.appStore || {};
  ios.body.appendChild(fieldBlock("Name / Title", a.title, "appStore.title"));
  ios.body.appendChild(fieldBlock("Subtitle", a.subtitle, "appStore.subtitle"));
  ios.body.appendChild(fieldBlock("Promotional text", a.promotionalText, "appStore.promotionalText"));
  ios.body.appendChild(fieldBlock("Description", a.description, "appStore.description"));
  ios.body.appendChild(fieldBlock("Keyword field", a.keywords, "appStore.keywords"));
  ios.body.appendChild(fieldBlock("Primary category", a.primaryCategory));
  ios.body.appendChild(fieldBlock("Subcategory", a.subcategory));
  ios.body.appendChild(fieldBlock("Age rating", a.ageRating));
  ios.body.appendChild(fieldBlock("Copyright", a.copyright));
  ios.body.appendChild(fieldBlock("What's new", a.whatsNew));
  results.appendChild(ios.root);

  const play = section("🤖 Google Play");
  const g = L.googlePlay || {};
  play.body.appendChild(fieldBlock("Title", g.title, "googlePlay.title"));
  play.body.appendChild(fieldBlock("Short description", g.shortDescription, "googlePlay.shortDescription"));
  play.body.appendChild(fieldBlock("Full description", g.fullDescription, "googlePlay.fullDescription"));
  play.body.appendChild(fieldBlock("Keywords", g.keywords));
  play.body.appendChild(fieldBlock("Primary category", g.primaryCategory));
  play.body.appendChild(fieldBlock("Subcategory", g.subcategory));
  play.body.appendChild(fieldBlock("Content rating", g.contentRating));
  play.body.appendChild(fieldBlock("Copyright", g.copyright));
  play.body.appendChild(fieldBlock("What's new", g.whatsNew));
  results.appendChild(play.root);

  const kw = section("🔑 ASO keywords");
  const chips = el("div", "chips");
  (L.keywords || []).forEach((k) => chips.appendChild(el("span", "chip", k)));
  kw.body.appendChild(chips);
  results.appendChild(kw.root);

  const rel = section("📝 Release notes");
  rel.body.appendChild(fieldBlock("Release notes", L.releaseNotes));
  results.appendChild(rel.root);

  const faq = section("❓ FAQs");
  (L.faqs || []).forEach((f) => {
    faq.body.appendChild(el("div", "faq-q", "Q: " + f.question));
    faq.body.appendChild(el("div", "faq-a", "A: " + f.answer));
  });
  results.appendChild(faq.root);

  const pv = L.privacy || {};
  const priv = section("🔒 Privacy");
  priv.body.appendChild(fieldBlock("Privacy summary", pv.privacyPolicySummary));
  const dcTitle = el("div", "field-head");
  dcTitle.appendChild(el("span", "name", "Data likely collected"));
  priv.body.appendChild(dcTitle);
  const dcList = el("ul", "plain");
  (pv.dataCollected || []).forEach((d) => dcList.appendChild(el("li", null, d)));
  priv.body.appendChild(dcList);
  const nlTitle = el("div", "field-head");
  nlTitle.appendChild(el("span", "name", "Apple privacy nutrition label"));
  priv.body.appendChild(nlTitle);
  const nlChips = el("div", "chips");
  (pv.privacyNutritionLabel || []).forEach((n) => nlChips.appendChild(el("span", "chip", n)));
  priv.body.appendChild(nlChips);
  results.appendChild(priv.root);

  const pp = section("📄 Privacy Policy");
  pp.body.appendChild(fieldBlock("Privacy Policy", L.privacyPolicy));
  results.appendChild(pp.root);

  const tos = section("📃 Terms of Service");
  tos.body.appendChild(fieldBlock("Terms of Service", L.termsOfService));
  results.appendChild(tos.root);

  if ((L.screenshotCaptions || []).length) {
    const caps = section("🖼 Screenshot captions");
    const list = el("ul", "plain");
    L.screenshotCaptions.forEach((c, i) => list.appendChild(el("li", null, `Screenshot ${i + 1}: ${c}`)));
    caps.body.appendChild(list);
    results.appendChild(caps.root);
  }

  const tips = section("💡 ASO tips");
  const tipList = el("ul", "plain");
  (L.asoTips || []).forEach((t) => tipList.appendChild(el("li", null, t)));
  tips.body.appendChild(tipList);
  results.appendChild(tips.root);

  const sub = L.submission || {};
  const subRows = [
    ["Company", sub.companyName],
    ["Contact name", sub.contactName],
    ["Contact email", sub.contactEmail],
    ["Phone", sub.phone],
    ["Website", sub.website],
    ["Support URL", sub.supportUrl],
    ["Marketing URL", sub.marketingUrl],
    ["Privacy Policy URL", sub.privacyPolicyUrl],
  ].filter(([, v]) => v);
  if (subRows.length) {
    const s = section("🏢 Submission details");
    subRows.forEach(([k, v]) => s.body.appendChild(fieldBlock(k, v)));
    results.appendChild(s.root);
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
function buildMarkdown(L) {
  const a = L.appStore || {};
  const g = L.googlePlay || {};
  const pv = L.privacy || {};
  const lines = [
    `# ${L.appName} — Store Listing`,
    "",
    L.companyName ? `**Company:** ${L.companyName}` : null,
    `**Tagline:** ${L.tagline}`,
    `**Suggested category:** ${L.categorySuggestion}`,
    "",
    "## Apple App Store",
    `- **Name / Title (30):** ${a.title || ""}`,
    `- **Subtitle (30):** ${a.subtitle || ""}`,
    `- **Promotional text (170):** ${a.promotionalText || ""}`,
    `- **Keyword field (100):** ${a.keywords || ""}`,
    `- **Primary category:** ${a.primaryCategory || ""}`,
    `- **Subcategory:** ${a.subcategory || ""}`,
    `- **Age rating:** ${a.ageRating || ""}`,
    `- **Copyright:** ${a.copyright || ""}`,
    "",
    "### Description",
    a.description || "",
    "",
    "### What's new",
    a.whatsNew || "",
    "",
    "## Google Play",
    `- **Title (30):** ${g.title || ""}`,
    `- **Short description (80):** ${g.shortDescription || ""}`,
    `- **Keywords:** ${g.keywords || ""}`,
    `- **Primary category:** ${g.primaryCategory || ""}`,
    `- **Subcategory:** ${g.subcategory || ""}`,
    `- **Content rating:** ${g.contentRating || ""}`,
    `- **Copyright:** ${g.copyright || ""}`,
    "",
    "### Full description",
    g.fullDescription || "",
    "",
    "### What's new",
    g.whatsNew || "",
    "",
    "## ASO keywords",
    (L.keywords || []).map((k) => `- ${k}`).join("\n"),
    "",
    "## Release notes",
    L.releaseNotes || "",
    "",
    "## FAQs",
    (L.faqs || []).map((f) => `**Q: ${f.question}**\n\nA: ${f.answer}`).join("\n\n"),
    "",
    "## Privacy",
    pv.privacyPolicySummary || "",
    "",
    "**Data likely collected:**",
    (pv.dataCollected || []).map((d) => `- ${d}`).join("\n"),
    "",
    "**Apple privacy nutrition label:**",
    (pv.privacyNutritionLabel || []).map((d) => `- ${d}`).join("\n"),
    "",
    "## Privacy Policy",
    L.privacyPolicy || "",
    "",
    "## Terms of Service",
    L.termsOfService || "",
  ];

  if ((L.screenshotCaptions || []).length) {
    lines.push("", "## Screenshot captions");
    lines.push(L.screenshotCaptions.map((c, i) => `${i + 1}. ${c}`).join("\n"));
  }

  lines.push("", "## ASO tips");
  lines.push((L.asoTips || []).map((t) => `- ${t}`).join("\n"));

  const sub = L.submission || {};
  const subRows = [
    ["Company", sub.companyName],
    ["Contact name", sub.contactName],
    ["Contact email", sub.contactEmail],
    ["Phone", sub.phone],
    ["Website", sub.website],
    ["Support URL", sub.supportUrl],
    ["Marketing URL", sub.marketingUrl],
    ["Privacy Policy URL", sub.privacyPolicyUrl],
  ].filter(([, v]) => v);
  if (subRows.length) {
    lines.push("", "## Submission details");
    subRows.forEach(([k, v]) => lines.push(`- **${k}:** ${v}`));
  }
  return lines.join("\n");
}

function buildText(L) {
  return buildMarkdown(L)
    .replace(/^#+\s*/gm, "")
    .replace(/\*\*/g, "");
}

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function slug(name) {
  return (name || "app").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
}

document.querySelectorAll("[data-export]").forEach((btn) =>
  btn.addEventListener("click", async () => {
    if (!currentListing) return;
    const base = slug(currentListing.appName) + "-listing";
    const kind = btn.dataset.export;
    if (kind === "md") download(base + ".md", buildMarkdown(currentListing), "text/markdown");
    if (kind === "json") download(base + ".json", JSON.stringify(currentListing, null, 2), "application/json");
    if (kind === "txt") download(base + ".txt", buildText(currentListing), "text/plain");
    if (kind === "docx") await exportDocx(btn, base);
  })
);

// .docx is a binary Word format — generated server-side and streamed back.
async function exportDocx(btn, base) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "… building";
  try {
    const res = await fetch("/api/export/docx", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ listing: currentListing }),
    });
    if (!res.ok) {
      let msg = `Word export failed (${res.status})`;
      try {
        msg = (await res.json()).error || msg;
      } catch {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = base + ".docx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (err) {
    alert("❌ " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}

$("copyAllBtn").addEventListener("click", async () => {
  if (!currentListing) return;
  await copyText(buildText(currentListing));
  const btn = $("copyAllBtn");
  btn.textContent = "✓ Copied";
  setTimeout(() => (btn.textContent = "📋 Copy all"), 1200);
});

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API needs a secure context; localhost qualifies, but fall back anyway
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
  }
}

// ===========================================================================
// Top tab navigation
// ===========================================================================
document.querySelectorAll(".tab-btn").forEach((btn) =>
  btn.addEventListener("click", () => {
    const target = btn.dataset.tab;
    document.querySelectorAll(".tab-btn").forEach((b) => {
      const active = b === btn;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      panel.classList.toggle("hidden", panel.id !== "tab-" + target);
    });
  })
);

// ===========================================================================
// Mobile Application Portfolio (stored in MySQL via /api/portfolio)
// ===========================================================================
let portfolio = [];        // in-memory cache, newest first
let editingId = null;
let pendingIcon = null;    // data-URL of a newly picked icon, or null
let portfolioError = null; // set when the API/DB is unreachable

// ---------------------------------------------------------------------------
// REST API helpers — all data lives in MySQL on the server.
// ---------------------------------------------------------------------------
async function apiRequest(url, options) {
  const res = await fetch(url, options);
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* empty body */
  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

const apiList = () => apiRequest("/api/portfolio").then((d) => d.apps || []);
const apiCreate = (app) =>
  apiRequest("/api/portfolio", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(app),
  }).then((d) => d.app);
const apiUpdate = (id, app) =>
  apiRequest("/api/portfolio/" + id, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(app),
  }).then((d) => d.app);
const apiDelete = (id) => apiRequest("/api/portfolio/" + id, { method: "DELETE" });

function setDbStatus(text) {
  const elmt = $("storageUsage");
  if (elmt) elmt.textContent = text;
}

function splitList(text) {
  return (text || "")
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function statusClass(status) {
  if (status === "Live") return "status-live";
  if (status === "In Development") return "status-dev";
  return "status-poc";
}

function splitList(text) {
  return (text || "")
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function statusClass(status) {
  if (status === "Live") return "status-live";
  if (status === "In Development") return "status-dev";
  return "status-poc";
}

// ---------- Icon picker (read to data URL for storage) ----------
$("p_icon").addEventListener("change", (e) => {
  const file = e.target.files[0];
  const preview = $("p_iconPreview");
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    alert("Icon is larger than 5 MB — please pick a smaller image.");
    e.target.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingIcon = reader.result;
    preview.innerHTML = `<img src="${pendingIcon}" alt="icon preview" />`;
    preview.classList.remove("hidden");
  };
  reader.readAsDataURL(file);
});

// ---------- Add / edit submit ----------
$("portfolioForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target;
  const existing = editingId ? portfolio.find((a) => a.id === editingId) : null;
  const data = {
    appName: f.appName.value.trim(),
    status: f.status.value,
    domain: f.domain.value.trim(),
    shortDescription: f.shortDescription.value.trim(),
    features: splitList(f.features.value),
    techStack: splitList(f.techStack.value),
    appStoreUrl: f.appStoreUrl.value.trim(),
    playStoreUrl: f.playStoreUrl.value.trim(),
    figmaUrl: f.figmaUrl.value.trim(),
    // keep the existing icon when editing without picking a new one
    icon: pendingIcon || (existing ? existing.icon : null),
  };

  const btn = $("portfolioSubmitBtn");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Saving…";
  try {
    if (editingId) {
      const saved = await apiUpdate(editingId, data);
      const idx = portfolio.findIndex((a) => a.id === editingId);
      if (idx !== -1) portfolio[idx] = saved;
    } else {
      const saved = await apiCreate(data);
      portfolio.unshift(saved);
    }
  } catch (err) {
    alert("❌ Could not save: " + err.message);
    btn.disabled = false;
    btn.textContent = label;
    return;
  }
  btn.disabled = false;

  resetPortfolioForm();
  refreshDomainFilter();
  renderPortfolio();
});

// ---------- Cancel edit ----------
$("portfolioCancelBtn").addEventListener("click", resetPortfolioForm);

function resetPortfolioForm() {
  editingId = null;
  pendingIcon = null;
  $("portfolioForm").reset();
  $("p_iconPreview").classList.add("hidden");
  $("p_iconPreview").innerHTML = "";
  $("portfolioFormTitle").textContent = "Add a mobile app";
  $("portfolioSubmitBtn").textContent = "➕ Add app";
  $("portfolioCancelBtn").classList.add("hidden");
}

function editApp(id) {
  const app = portfolio.find((a) => a.id === id);
  if (!app) return;
  editingId = id;
  pendingIcon = null;
  const f = $("portfolioForm");
  f.appName.value = app.appName || "";
  f.status.value = app.status || "Live";
  f.domain.value = app.domain || "";
  f.shortDescription.value = app.shortDescription || "";
  f.features.value = (app.features || []).join("\n");
  f.techStack.value = (app.techStack || []).join(", ");
  f.appStoreUrl.value = app.appStoreUrl || "";
  f.playStoreUrl.value = app.playStoreUrl || "";
  f.figmaUrl.value = app.figmaUrl || "";

  const preview = $("p_iconPreview");
  if (app.icon) {
    preview.innerHTML = `<img src="${app.icon}" alt="icon preview" />`;
    preview.classList.remove("hidden");
  } else {
    preview.classList.add("hidden");
    preview.innerHTML = "";
  }

  $("portfolioFormTitle").textContent = "Edit app";
  $("portfolioSubmitBtn").textContent = "💾 Save changes";
  $("portfolioCancelBtn").classList.remove("hidden");
  document.getElementById("tabBtn-portfolio").scrollIntoView({ behavior: "smooth", block: "start" });
}

async function deleteApp(id) {
  const app = portfolio.find((a) => a.id === id);
  if (!confirm(`Delete "${app ? app.appName : "this app"}" from the portfolio?`)) return;
  try {
    await apiDelete(id);
  } catch (err) {
    alert("❌ Could not delete: " + err.message);
    return;
  }
  portfolio = portfolio.filter((a) => a.id !== id);
  if (editingId === id) resetPortfolioForm();
  refreshDomainFilter();
  renderPortfolio();
}

// ---------- Filters ----------
["filterSearch", "filterStatus", "filterDomain"].forEach((id) =>
  $(id).addEventListener("input", renderPortfolio)
);
$("clearFiltersBtn").addEventListener("click", () => {
  $("filterSearch").value = "";
  $("filterStatus").value = "";
  $("filterDomain").value = "";
  renderPortfolio();
});

function refreshDomainFilter() {
  const select = $("filterDomain");
  const current = select.value;
  const domains = [...new Set(portfolio.map((a) => a.domain).filter(Boolean))].sort();
  select.innerHTML = '<option value="">All domains</option>';
  domains.forEach((d) => {
    const opt = el("option", null, d);
    opt.value = d;
    select.appendChild(opt);
  });
  select.value = domains.includes(current) ? current : "";
}

function getFilteredPortfolio() {
  const q = $("filterSearch").value.trim().toLowerCase();
  const status = $("filterStatus").value;
  const domain = $("filterDomain").value;
  return portfolio.filter((a) => {
    if (status && a.status !== status) return false;
    if (domain && a.domain !== domain) return false;
    if (q) {
      const hay = [a.appName, a.shortDescription, a.domain, (a.techStack || []).join(" "), (a.features || []).join(" ")]
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

// ---------- Render ----------
function linkBtn(label, url) {
  const a = el("a", "app-link", label);
  a.href = url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  return a;
}

// Build the app icon element (image if present, else first letter).
function appIconEl(app, extraClass) {
  const icon = el("div", "app-icon" + (extraClass ? " " + extraClass : ""));
  if (app.icon) {
    const img = el("img");
    img.src = app.icon;
    img.alt = app.appName;
    icon.appendChild(img);
  } else {
    icon.textContent = (app.appName || "?").charAt(0).toUpperCase();
  }
  return icon;
}

// Compact card — shows only image, name, status and domain, plus a
// "View more details" button that opens the full profile in a modal.
function appCard(app, index) {
  const card = el("div", "app-card");
  card.style.animationDelay = index * 60 + "ms";

  const head = el("div", "app-card-head");
  head.appendChild(appIconEl(app));

  const titleWrap = el("div", "app-card-title");
  titleWrap.appendChild(el("h3", null, app.appName));
  const badges = el("div", "badges");
  badges.appendChild(el("span", "badge " + statusClass(app.status), app.status));
  if (app.domain) badges.appendChild(el("span", "badge domain", app.domain));
  titleWrap.appendChild(badges);
  head.appendChild(titleWrap);

  // The whole summary area is clickable too.
  head.addEventListener("click", () => openDetail(app.id));
  card.appendChild(head);

  const viewBtn = el("button", "view-more-btn", "View more details →");
  viewBtn.type = "button";
  viewBtn.addEventListener("click", () => openDetail(app.id));
  card.appendChild(viewBtn);

  return card;
}

// Full profile popup for one app.
function openDetail(id) {
  const app = portfolio.find((a) => a.id === id);
  if (!app) return;
  const body = $("modalBody");
  body.innerHTML = "";

  const head = el("div", "modal-head");
  head.appendChild(appIconEl(app, "modal-icon"));
  const titleWrap = el("div", "modal-title-wrap");
  titleWrap.appendChild(el("h2", "modal-title", app.appName));
  const badges = el("div", "badges");
  badges.appendChild(el("span", "badge " + statusClass(app.status), app.status));
  if (app.domain) badges.appendChild(el("span", "badge domain", app.domain));
  titleWrap.appendChild(badges);
  head.appendChild(titleWrap);
  body.appendChild(head);

  if (app.shortDescription) body.appendChild(el("p", "modal-desc", app.shortDescription));

  if ((app.features || []).length) {
    body.appendChild(el("div", "app-section-label", "Key features"));
    const ul = el("ul", "plain");
    app.features.forEach((ft) => ul.appendChild(el("li", null, ft)));
    body.appendChild(ul);
  }

  if ((app.techStack || []).length) {
    body.appendChild(el("div", "app-section-label", "Tech stack"));
    const chips = el("div", "tech-chips");
    app.techStack.forEach((t) => chips.appendChild(el("span", "tech-chip", t)));
    body.appendChild(chips);
  }

  const links = el("div", "app-links");
  if (app.appStoreUrl) links.appendChild(linkBtn("🍎 App Store", app.appStoreUrl));
  if (app.playStoreUrl) links.appendChild(linkBtn("🤖 Play Store", app.playStoreUrl));
  if (app.figmaUrl) links.appendChild(linkBtn("🎨 Figma", app.figmaUrl));
  if (links.childElementCount) {
    body.appendChild(el("div", "app-section-label", "Links"));
    body.appendChild(links);
  }

  const actions = el("div", "app-card-actions modal-actions");
  const edit = el("button", "edit-btn", "✏️ Edit");
  edit.type = "button";
  edit.addEventListener("click", () => {
    closeModal();
    editApp(app.id);
  });
  const del = el("button", "delete-btn", "🗑 Delete");
  del.type = "button";
  del.addEventListener("click", () => {
    closeModal();
    deleteApp(app.id);
  });
  actions.append(edit, del);
  body.appendChild(actions);

  $("appModal").classList.remove("hidden");
  document.body.style.overflow = "hidden";
}

function closeModal() {
  $("appModal").classList.add("hidden");
  document.body.style.overflow = "";
}

function renderPortfolio() {
  const list = $("portfolioList");
  const empty = $("portfolioEmpty");
  const filtered = getFilteredPortfolio();

  list.innerHTML = "";
  $("portfolioCount").textContent = filtered.length;

  if (!portfolio.length) {
    empty.textContent = portfolioError || "No apps yet — add your first mobile app using the form.";
    empty.classList.remove("hidden");
    return;
  }
  if (!filtered.length) {
    empty.textContent = "No apps match your filters.";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  filtered.forEach((app, i) => list.appendChild(appCard(app, i)));
}

// ---------- Detail modal: close interactions ----------
$("modalClose").addEventListener("click", closeModal);
$("appModal").addEventListener("click", (e) => {
  if (e.target === $("appModal")) closeModal(); // click on backdrop
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !$("appModal").classList.contains("hidden")) closeModal();
});

async function initPortfolio() {
  setDbStatus("🗄 Loading from MySQL…");
  try {
    portfolio = await apiList(); // server returns newest first
    portfolioError = null;
    setDbStatus("🗄 Stored in MySQL");
  } catch (err) {
    console.error("Portfolio API unavailable:", err);
    portfolio = [];
    portfolioError = err.message;
    setDbStatus("⚠ Database offline");
  }
  refreshDomainFilter();
  renderPortfolio();
}

initPortfolio();
