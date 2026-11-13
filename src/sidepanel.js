import { initializeApp } from "firebase/app";
import { initializeAppCheck, CustomProvider } from "firebase/app-check";
import { getAuth, signInAnonymously, onAuthStateChanged } from "firebase/auth/web-extension";
import { getFirestore, collection, addDoc, query, orderBy, limit, getDocs, serverTimestamp } from "firebase/firestore";
import { getRemoteConfig, fetchAndActivate, getValue } from "firebase/remote-config";
import { firebaseConfig } from "./firebase-config.js";
import { APP_CHECK_DEBUG_TOKEN } from "./debug-token.js";
import { probeFirstScreen, probeWholePage } from "./probe.js";
import { createAuditModels, localModelState, prepareModel, runAudit, MODEL_LABELS } from "./audit.js";

// ---------- Firebase ----------
self.FIREBASE_APPCHECK_DEBUG_TOKEN = APP_CHECK_DEBUG_TOKEN;
const app = initializeApp(firebaseConfig);
// Extension pages can't load reCAPTCHA, so App Check uses the registered debug token set above.
// The custom provider is only a placeholder: in debug mode the SDK exchanges the debug token instead.
initializeAppCheck(app, {
  provider: new CustomProvider({
    getToken: () => Promise.reject(new Error("App Check runs with a debug token in this build")),
  }),
  isTokenAutoRefreshEnabled: true,
});
const auth = getAuth(app);
const db = getFirestore(app);
const rc = getRemoteConfig(app);
rc.settings.minimumFetchIntervalMillis = 60 * 60 * 1000;
rc.defaultConfig = {
  phone_width: 390,
  phone_height: 844,
  settle_ms: 2500,
  prompt_version: "v1",
  extra_guidance: "",
};

const models = createAuditModels(app);

// ---------- UI helpers ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const setStatus = (text, kind = "") => {
  const el = $("status");
  el.textContent = text;
  el.className = "status " + kind;
};

// Normally the panel checks the active tab. Opened as a page with ?target=<hostname> (handy for demos and tests),
// it checks the first open tab on that site instead.
const TARGET_HOST = new URLSearchParams(location.search).get("target");

async function activeTab() {
  if (TARGET_HOST) {
    const tabs = await chrome.tabs.query({});
    return tabs.find((t) => /^https?:/.test(t.url || "") && new URL(t.url).hostname.endsWith(TARGET_HOST));
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function showSite() {
  const tab = await activeTab();
  const ok = tab && /^https?:/.test(tab.url || "");
  $("site").textContent = ok ? new URL(tab.url).hostname.replace(/^www\./, "") : "Open a business website to check it";
  $("check").disabled = !ok;
}

async function showModelState() {
  const s = await localModelState();
  const label = MODEL_LABELS[s] || s;
  $("model").textContent = label;
  $("model").className = "chip " + (s === "available" ? "on" : s === "unavailable" ? "off" : "wait");
}

// ---------- Phone view through the DevTools protocol ----------
const send = (target, method, params = {}) =>
  new Promise((resolve, reject) =>
    chrome.debugger.sendCommand(target, method, params, (res) =>
      chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(res)
    )
  );

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

async function capturePhoneView(tabId, cfg) {
  const target = { tabId };
  await new Promise((resolve, reject) =>
    chrome.debugger.attach(target, "1.3", () => (chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve()))
  );
  try {
    await send(target, "Page.enable");
    await send(target, "Emulation.setDeviceMetricsOverride", {
      width: cfg.width, height: cfg.height, deviceScaleFactor: 2, mobile: true,
    });
    await send(target, "Emulation.setUserAgentOverride", { userAgent: IPHONE_UA, platform: "iPhone" });
    await send(target, "Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    await send(target, "Page.reload", { ignoreCache: false });
    await new Promise((r) => setTimeout(r, 1200));
    await send(target, "Runtime.evaluate", {
      expression: "new Promise(r => document.readyState === 'complete' ? r() : addEventListener('load', () => r(), { once: true }))",
      awaitPromise: true,
      timeout: 15000,
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, cfg.settle));
    const evalRes = await send(target, "Runtime.evaluate", {
      expression: `(${probeFirstScreen.toString()})()`,
      returnByValue: true,
    });
    const facts = evalRes.result.value;
    const shot = await send(target, "Page.captureScreenshot", { format: "jpeg", quality: 80 });
    // Then scroll the whole page once, so reviews and call links in lazy-loaded sections still count.
    const more = await send(target, "Runtime.evaluate", {
      expression: `(${probeWholePage.toString()})()`,
      awaitPromise: true,
      returnByValue: true,
      timeout: 15000,
    }).catch(() => null);
    const m = more && more.result && more.result.value;
    if (m) {
      facts.reviewMentions = Math.max(facts.reviewMentions, m.reviewMentions);
      facts.reviewWidget = facts.reviewWidget || m.reviewWidget;
      facts.tapToCallLinks = Math.max(facts.tapToCallLinks, m.tapToCallLinks);
    }
    return { facts, jpegBase64: shot.data };
  } finally {
    await send(target, "Emulation.clearDeviceMetricsOverride").catch(() => {});
    await send(target, "Emulation.setUserAgentOverride", { userAgent: "" }).catch(() => {});
    await send(target, "Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
    await send(target, "Page.reload", {}).catch(() => {});
    chrome.debugger.detach(target, () => void chrome.runtime.lastError);
  }
}

async function shrinkJpeg(b64, width = 390) {
  const blob = await (await fetch(`data:image/jpeg;base64,${b64}`)).blob();
  const bmp = await createImageBitmap(blob);
  const h = Math.round((bmp.height * width) / bmp.width);
  const canvas = new OffscreenCanvas(width, h);
  canvas.getContext("2d").drawImage(bmp, 0, 0, width, h);
  const out = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.72 });
  const buf = new Uint8Array(await out.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

// ---------- Main check ----------
async function runCheck() {
  const tab = await activeTab();
  if (!tab || !/^https?:/.test(tab.url || "")) return;
  $("check").disabled = true;
  $("result").hidden = true;

  // Pick the model, and start the local model download on the click itself (the SDK needs a user gesture).
  const picked = await prepareModel(models, (p) => setStatus(`Downloading Gemini Nano ${Math.round(p * 100)}%`));

  try {
    await fetchAndActivate(rc).catch(() => {});
    const cfg = {
      width: getValue(rc, "phone_width").asNumber(),
      height: getValue(rc, "phone_height").asNumber(),
      settle: getValue(rc, "settle_ms").asNumber(),
    };
    setStatus("Opening the site as a phone sees it", "busy");
    const { facts, jpegBase64 } = await capturePhoneView(tab.id, cfg);
    const small = await shrinkJpeg(jpegBase64);
    $("shot").src = `data:image/jpeg;base64,${small}`;

    setStatus("Reading the first screen", "busy");
    const { audit, where, ms } = await runAudit(picked, facts, small, getValue(rc, "extra_guidance").asString());
    render(audit, facts, where, ms);
    setStatus(`Checked ${where} in ${(ms / 1000).toFixed(1)} s`, "done");
    await save(tab.url, audit, where, ms, facts).catch(() => {});
    loadHistory().catch(() => {});
  } catch (e) {
    setStatus(`Something went wrong: ${e.message}`, "error");
  } finally {
    $("check").disabled = false;
    showModelState();
  }
}

function render(a, facts, where, ms) {
  const score = Math.max(0, Math.min(100, Number(a.score) || 0));
  $("score").textContent = score;
  $("score").className = "score " + (score >= 75 ? "good" : score >= 45 ? "ok" : "bad");
  $("verdict").textContent = a.verdict || "";
  $("fixes").innerHTML = (a.fixes || [])
    .slice(0, 3)
    .map((f) => `<li><b>${esc(f.title)}</b><span>${esc(f.why)}</span></li>`)
    .join("");
  $("owner").textContent = a.owner_line || "";
  $("where").textContent = `Ran ${where}, ${(ms / 1000).toFixed(1)} s`;
  const callable = facts.tapToCallOnFirstScreen || facts.callButtonsOnFirstScreen.length;
  $("facts").innerHTML = [
    ["Call button on first screen", callable ? "yes" : "no"],
    ["Phone number on first screen", facts.phoneNumbersOnFirstScreen.length ? facts.phoneNumbersOnFirstScreen[0] : "no"],
    ["Covering the page", facts.overlays.length ? `${facts.overlays[0].kind}, ${facts.overlays[0].coversPercent}%` : "nothing"],
    ["Reviews on the page", facts.reviewMentions || facts.reviewWidget ? "yes" : "no"],
    ["Fits the phone", facts.pageWiderThanPhone || facts.shrunkToFit || !facts.hasViewportMeta ? "no" : "yes"],
    ["Copyright year", facts.copyrightYear || "not shown"],
  ]
    .map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`)
    .join("");
  $("result").hidden = false;
}

// ---------- History in Firestore ----------
async function save(url, a, where, ms, facts) {
  const user = auth.currentUser;
  if (!user) return;
  await addDoc(collection(db, "users", user.uid, "audits"), {
    url, host: new URL(url).hostname, score: a.score ?? null, verdict: a.verdict ?? "",
    fixes: a.fixes ?? [], owner_line: a.owner_line ?? "", where, ms,
    tapToCallOnFirstScreen: facts.tapToCallOnFirstScreen, createdAt: serverTimestamp(),
  });
}

async function loadHistory() {
  const user = auth.currentUser;
  if (!user) return;
  const q = query(collection(db, "users", user.uid, "audits"), orderBy("createdAt", "desc"), limit(8));
  const snap = await getDocs(q);
  $("history").innerHTML = snap.docs
    .map((d) => d.data())
    .map((d) => `<li><span>${esc(d.host)}</span><b class="${d.score >= 75 ? "good" : d.score >= 45 ? "ok" : "bad"}">${esc(d.score)}</b></li>`)
    .join("") || "<li class=\"empty\">Your checks show up here</li>";
}

// ---------- Wire up ----------
// Lets a demo or test page start a check (the panel then checks the active tab as usual).
chrome.runtime.onMessage.addListener((msg) => {
  if (msg && msg.type === "firstscreen-run") runCheck();
});
$("check").addEventListener("click", runCheck);
$("copy").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("owner").textContent);
  $("copy").textContent = "Copied";
  setTimeout(() => ($("copy").textContent = "Copy"), 1200);
});
chrome.tabs.onActivated.addListener(showSite);
chrome.tabs.onUpdated.addListener((_, info) => info.status === "complete" && showSite());
onAuthStateChanged(auth, (u) => u && loadHistory().catch(() => {}));
signInAnonymously(auth).catch(() => {});
showSite();
showModelState();
