// FirstScreen web demo: the same hybrid audit as the extension, run on three sample first screens.
// In Chrome with Gemini Nano it runs on the device; anywhere else it runs in the cloud.
import { initializeApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaEnterpriseProvider } from "firebase/app-check";
import { firebaseConfig, RECAPTCHA_ENTERPRISE_SITE_KEY } from "./firebase-config.js";
import { APP_CHECK_DEBUG_TOKEN } from "./debug-token.js";
import { createAuditModels, localModelState, prepareModel, runAudit, MODEL_LABELS, readingText } from "./audit.js";

// The hosted page proves itself to App Check with reCAPTCHA Enterprise. A local build can use a debug token instead.
if (APP_CHECK_DEBUG_TOKEN) self.FIREBASE_APPCHECK_DEBUG_TOKEN = APP_CHECK_DEBUG_TOKEN;
const app = initializeApp(firebaseConfig);
initializeAppCheck(app, {
  provider: new ReCaptchaEnterpriseProvider(RECAPTCHA_ENTERPRISE_SITE_KEY),
  isTokenAutoRefreshEnabled: true,
});
const models = createAuditModels(app);

const SAMPLES = [
  { id: "maple", name: "Maple & Pine Tree Service", note: "A sign-up popup over the homepage" },
  { id: "ridgeline", name: "Ridgeline Roofing Co.", note: "A desktop page squeezed onto a phone" },
  { id: "clearwater", name: "Clearwater Plumbing", note: "Call button and reviews up top" },
];

// A copy of this page can also run with the samples passed in inline (self.FS_INLINE = { facts, images }).
const INLINE = self.FS_INLINE || null;
const imageUrl = (id) => (INLINE ? INLINE.images[id] : `samples/${id}.jpg`);

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
let facts = {};
let current = SAMPLES[0].id;

function setStatus(text, kind = "") {
  $("status").textContent = text;
  $("status").className = "status " + kind;
}

// Gemini Nano download progress goes in the model chip, so it never hides the status of the running check.
function showDownload(p) {
  if (p >= 1) return showModelState();
  $("model").textContent = `Gemini Nano downloading ${Math.round(p * 100)}%`;
  $("model").className = "chip wait";
}

async function showModelState() {
  const s = await localModelState();
  $("model").textContent = MODEL_LABELS[s] || s;
  $("model").className = "chip " + (s === "available" ? "on" : s === "unavailable" ? "off" : "wait");
}

function pick(id) {
  current = id;
  document.querySelectorAll(".sample").forEach((el) => el.classList.toggle("sel", el.dataset.id === id));
  $("shot").src = imageUrl(id);
  $("result").hidden = true;
  $("hint").hidden = false;
  setStatus("");
}

async function jpegBase64(url) {
  if (url.startsWith("data:")) return url.slice(url.indexOf(",") + 1);
  const blob = await (await fetch(url)).blob();
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function check() {
  $("check").disabled = true;
  $("result").hidden = true;
  const picked = await prepareModel(models, showDownload);
  try {
    setStatus(readingText(picked), "busy");
    const img = await jpegBase64(imageUrl(current));
    const { audit, where, ms } = await runAudit(picked, facts[current], img, "");
    render(audit, where, ms);
    setStatus(`Checked ${where} in ${(ms / 1000).toFixed(1)} s`, "done");
  } catch (e) {
    setStatus(`Something went wrong: ${e.message}`, "error");
  } finally {
    $("check").disabled = false;
    showModelState();
  }
}

function render(a, where, ms) {
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
  $("result").hidden = false;
  $("hint").hidden = true;
}

async function main() {
  $("samples").innerHTML = SAMPLES.map(
    (s) => `<button class="sample" data-id="${s.id}"><img src="${imageUrl(s.id)}" alt=""><b>${esc(s.name)}</b><span>${esc(s.note)}</span></button>`
  ).join("");
  document.querySelectorAll(".sample").forEach((el) => el.addEventListener("click", () => pick(el.dataset.id)));
  $("check").addEventListener("click", check);
  facts = INLINE ? INLINE.facts : await (await fetch("samples/facts.json")).json();
  pick(current);
  showModelState();
}
main();
