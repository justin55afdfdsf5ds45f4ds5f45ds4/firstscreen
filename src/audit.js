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
  return { chosen, useTextOnly };
}

export function buildPrompt(facts, guidance) {
  return [
    "You check small business websites the way a customer sees them on a phone.",
    "The image is the first phone screen of the site. The facts below were measured on that same screen.",
    "Judge only what is really there. If a phone number, tap-to-call link or call button is on the first screen, do not say it is missing.",
    "overlays lists only things that really sit on top of the page and block it. pinnedHeaderPercent is how much of the screen a header that stays pinned takes up.",
    "shrunkToFit means the page is drawn at desktop width and shrunk onto the phone; smallestTextPx and medianTextPx are the text sizes as they appear on the phone.",
    "reviewMentions and reviewWidget cover the whole page after scrolling, not just the first screen.",
    "Return JSON with: score (0 to 100, how well this first screen helps a customer call or book),",
    "verdict (one plain sentence), fixes (exactly 3, most important first, each with a short title and why it matters to a customer),",
    "owner_line (one friendly, specific, true sentence a freelancer can send the owner about what they will see on their own phone, no sales pitch).",
    guidance || "",
    "Facts:",
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
