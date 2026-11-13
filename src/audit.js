// The audit itself: one hybrid Gemini model through Firebase AI Logic, shared by the extension and the web demo.
// On a device with Gemini Nano the call runs locally; everywhere else the same call runs in the cloud.
import { getAI, getGenerativeModel, GoogleAIBackend, InferenceMode, Schema } from "firebase/ai";

const CLOUD_MODEL = "gemini-3.5-flash-lite";
const EN_TEXT = { type: "text", languages: ["en"] };

// Structured output for the cloud path.
const auditSchema = Schema.object({
  properties: {
    score: Schema.integer({ description: "0 to 100, how well the first screen helps a customer call or book" }),
    verdict: Schema.string({ description: "One plain sentence about the first screen" }),
    fixes: Schema.array({
      items: Schema.object({
        properties: {
          title: Schema.string({ description: "The fix, under 8 words" }),
          why: Schema.string({ description: "Why it matters to a customer, under 20 words" }),
        },
      }),
    }),
    owner_line: Schema.string({
      description: "One friendly, specific, true sentence a freelancer can send the owner about what they will see on their own phone",
    }),
  },
});

// The same shape as plain JSON Schema, for the on-device Prompt API's responseConstraint.
const AUDIT_JSON_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer", minimum: 0, maximum: 100 },
    verdict: { type: "string" },
    fixes: {
      type: "array", minItems: 3, maxItems: 3,
      items: { type: "object", properties: { title: { type: "string" }, why: { type: "string" } }, required: ["title", "why"] },
    },
    owner_line: { type: "string" },
  },
  required: ["score", "verdict", "fixes", "owner_line"],
};

const inCloudParams = {
  model: CLOUD_MODEL,
  generationConfig: { responseMimeType: "application/json", responseSchema: auditSchema, temperature: 0.2 },
};

export function createAuditModels(app) {
  const ai = getAI(app, { backend: new GoogleAIBackend() });
  // Screenshot + facts. PREFER_ON_DEVICE: Gemini Nano when Chrome has it, Gemini in the cloud when it doesn't.
  const model = getGenerativeModel(ai, {
    mode: InferenceMode.PREFER_ON_DEVICE,
    onDeviceParams: {
      createOptions: { expectedInputs: [EN_TEXT, { type: "image" }], expectedOutputs: [EN_TEXT] },
      promptOptions: { responseConstraint: AUDIT_JSON_SCHEMA },
    },
    inCloudParams,
  });
  // Same audit, text only: for devices whose Gemini Nano can't take images yet, so the check still stays local.
  const textModel = getGenerativeModel(ai, {
    mode: InferenceMode.PREFER_ON_DEVICE,
    onDeviceParams: {
      createOptions: { expectedInputs: [EN_TEXT], expectedOutputs: [EN_TEXT] },
      promptOptions: { responseConstraint: AUDIT_JSON_SCHEMA },
    },
    inCloudParams,
  });
  return { model, textModel };
}

export async function availability(inputs) {
  if (typeof LanguageModel === "undefined") return "unavailable";
  try {
    return await LanguageModel.availability({ expectedInputs: inputs, expectedOutputs: [EN_TEXT] });
  } catch {
    return "unavailable";
  }
}

// Best local option first: Gemini Nano with image input, then Gemini Nano with text only.
export async function localModelState() {
  const withImage = await availability([EN_TEXT, { type: "image" }]);
  if (withImage !== "unavailable") return withImage;
  return availability([EN_TEXT]);
}

export const MODEL_LABELS = {
  available: "On-device: Gemini Nano",
  downloadable: "Gemini Nano can download",
  downloading: "Gemini Nano downloading",
  unavailable: "Cloud: no local model",
};

// Call this on the user's click: it picks the model and, if Gemini Nano still has to download, starts that
// download inside the user gesture (the SDK needs one).
export async function prepareModel(models, onProgress) {
  const imageLocal = await availability([EN_TEXT, { type: "image" }]);
  const textLocal = await availability([EN_TEXT]);
  const useTextOnly = imageLocal !== "available" && textLocal === "available";
  const chosen = useTextOnly ? models.textModel : models.model;
  const state = useTextOnly ? textLocal : imageLocal;
  if (state === "downloadable" || state === "downloading") {
    chosen.initializeDeviceModel((p) => onProgress && onProgress(p)).catch(() => {});
  }
  return { chosen, useTextOnly, local: state === "available" };
}

// What to show while a check runs. On device the first check also loads the model, so it takes longer.
export function readingText(picked) {
  return picked.local
    ? "Reading the first screen on this device, about 10 s (longer the first time)"
    : "Reading the first screen in the cloud";
}

// Deterministic findings from the measured facts. The model gets these as ground truth, so even the small
// on-device model can't miss a covered screen or a missing call button, and it never "fixes" what is already fine.
export function findings(f) {
  const problems = [];
  const strengths = [];
  const canCall = f.tapToCallOnFirstScreen > 0 || (f.callButtonsOnFirstScreen || []).length > 0;
  if (canCall) strengths.push("There is a call button or tap-to-call link on the first screen.");
  else problems.push("No call button or tap-to-call link on the first screen.");
  if ((f.phoneNumbersOnFirstScreen || []).length) strengths.push(`The phone number ${f.phoneNumbersOnFirstScreen[0]} is on the first screen.`);
  else problems.push("No phone number a customer can read on the first screen.");
  for (const o of f.overlays || []) problems.push(`A ${o.kind} covers ${o.coversPercent}% of the first screen.`);
  if (f.shrunkToFit || !f.hasViewportMeta) {
    problems.push(`The page is a desktop layout shrunk onto the phone, so text shows at about ${f.smallestTextPx ?? "a few"} px.`);
  } else if (f.smallestTextPx && f.smallestTextPx < 12) {
    problems.push(`Some text is only ${f.smallestTextPx} px on the phone.`);
  }
  if (f.pageWiderThanPhone) problems.push("The page is wider than the phone, so it scrolls sideways.");
  if (f.pinnedHeaderPercent >= 25) problems.push(`A pinned header takes ${f.pinnedHeaderPercent}% of the screen.`);
  if (!f.reviewMentions && !f.reviewWidget) problems.push("No reviews or testimonials anywhere on the page.");
  else strengths.push("The page shows reviews or testimonials.");
  const year = Number(f.copyrightYear);
  if (year && year < new Date().getFullYear() - 2) problems.push(`The footer still says copyright ${year}.`);
  return { problems, strengths };
}

export function buildPrompt(facts, guidance) {
  const { problems, strengths } = findings(facts);
  return [
    "You check small business websites the way a customer sees them on a phone.",
    "The image is the first phone screen of the site. The problems and strengths below were measured on that same screen; treat them as true.",
    "Use the image to confirm them and to judge what measurements can't see, like clutter or a weak headline.",
    "Return JSON with:",
    "score: 0 to 100, how well this first screen helps a customer call or book. No way to call on the first screen, or something covering most of it: under 40. A desktop page shrunk onto the phone: under 45. A call button, the number and reviews all easy to find: 85 or more.",
    "verdict: one plain sentence about the first screen.",
    "fixes: exactly 3 changes the owner should make, most important first, each with a short title and why it matters to a customer. Take them from the problems first. If there are fewer than 3 problems, add smaller improvements you can see in the image. Never list something that already works as a fix.",
    "owner_line: one friendly, specific, true sentence a freelancer can send the owner about what they will see on their own phone. No greeting, no sales pitch.",
    guidance || "",
    "Problems measured:",
    ...(problems.length ? problems.map((p) => "- " + p) : ["- none"]),
    "Strengths measured:",
    ...(strengths.length ? strengths.map((s) => "- " + s) : ["- none"]),
    "All measured facts:",
    JSON.stringify(facts),
  ].join("\n");
}

export function parseJson(text) {
  const m = text.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : text);
}

// One audit: screenshot (base64 JPEG) + measured facts in, structured result out, plus where it ran and how long it took.
export async function runAudit({ chosen, useTextOnly }, facts, jpegBase64, guidance) {
  const prompt = buildPrompt(facts, guidance);
  const parts = useTextOnly
    ? [{ text: prompt + "\n(No screenshot on this device: judge from the measured facts only.)" }]
    : [{ text: prompt }, { inlineData: { mimeType: "image/jpeg", data: jpegBase64 } }];
  const t0 = performance.now();
  const res = await chosen.generateContent({ contents: [{ role: "user", parts }] });
  const ms = Math.round(performance.now() - t0);
  const where = res.response.inferenceSource === "on_device" ? "on this device" : "in the cloud";
  return { audit: parseJson(res.response.text()), where, ms };
}
