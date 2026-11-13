# FirstScreen

**See what a customer sees on the first phone screen of any small business website, and what to fix first.**

Most people meet a local business on a phone, from a Google search, standing in the kitchen with a leaking pipe or out in the yard next to a fallen tree. The first screen decides whether they call. While auditing over 1,000 local trades websites (tree services, roofers, plumbers, HVAC, lawn care) in eight US cities this month, the same problems kept showing up on that first screen: no phone number, no tap-to-call button, a sign-up popup covering everything, a page that doesn't fit the phone, and hundreds of five-star Google reviews that never appear on the homepage.

I ran the checks at phone size on 266 of those sites, from Wichita, Omaha, Des Moines and Springfield, Missouri, and threw out 21 that blocked the bot or errored out, were a Facebook page, a dead page or a directory listing, or weren't really a trade. Of the other 245, after rechecking every flag against a screenshot or a second run that scrolls the whole page:

- **at least 18%** had no phone number and no call button anywhere on the first screen
- **10%** had no tap-to-call link anywhere on the page
- **15 businesses** with 100+ Google reviews at 4.5 stars or better showed no review or testimonial anywhere on their homepage

The raw script flagged more than that, because phone icons, numbers inside images and testimonials that never use the word review fool simple checks. That is the reason FirstScreen sends the screenshot to Gemini along with the measured facts, instead of trusting either one alone.

FirstScreen is a Chrome extension that checks any site for exactly that and tells you in plain English what to fix and what to say to the owner.

## How it works

1. **Phone view.** FirstScreen opens the current tab as an iPhone sees it (390 x 844, mobile user agent, touch) through the Chrome DevTools protocol, waits for popups to appear, and captures the first screen. The tab reloads during the check, and Chrome shows its debugging bar while it runs.
2. **Measure.** A small probe runs in the page and measures what is really there: tap-to-call links and call buttons on the first screen (icon-only buttons count when they carry a label or a call class), phone numbers a customer can read, text size, whether the page fits the phone and the copyright year. Popups are found by asking the browser what a tap would hit at 128 points across the screen, so a cookie bar or sign-up popup that covers at least a quarter of the screen counts, but invisible layers, background videos and falling-snow effects don't. After the screenshot it scrolls the whole page once, so reviews and testimonials in lazy-loaded sections still count.
3. **Read it with Gemini.** The screenshot and the measured facts go to Gemini through **Firebase AI Logic hybrid inference**. With `InferenceMode.PREFER_ON_DEVICE` the check runs on **Gemini Nano inside Chrome** when the device has it, so the page and the screenshot stay on the computer and the model call costs nothing. When there is no local model (or it is still downloading), the same call falls back to **Gemini in the cloud**.
4. **Answer.** A score, a one-line verdict, the three fixes that matter most, and one sentence built from the measured facts that you can send the owner. The panel shows where the check ran (on this device or in the cloud) and how long it took.

## Firebase AI Logic in the code

- `src/audit.js` creates the hybrid model, shared by the extension (`src/sidepanel.js`) and the web demo (`src/try.js`):
  ```js
  const model = getGenerativeModel(getAI(app, { backend: new GoogleAIBackend() }), {
    mode: InferenceMode.PREFER_ON_DEVICE,
    onDeviceParams: {
      createOptions: { expectedInputs: [{ type: "text", languages: ["en"] }, { type: "image" }], expectedOutputs: [{ type: "text", languages: ["en"] }] },
      promptOptions: { responseConstraint: AUDIT_JSON_SCHEMA },
    },
    inCloudParams: { model: "gemini-3.5-flash-lite", generationConfig: { responseMimeType: "application/json", responseSchema: auditSchema } },
  });
  ```
- `initializeDeviceModel()` is called on the user's click, so Chrome can start downloading Gemini Nano inside the user gesture.
- Where Gemini Nano can't take images yet but can take text, a second text-only model keeps the check on the device.
- Every result reads `response.inferenceSource` to show whether it ran on the device or in the cloud, and how long it took.
- The prompt is multimodal (screenshot + measured facts) and the output is structured JSON on both paths (Prompt API `responseConstraint` on device, `responseSchema` in the cloud).

Other Firebase products:

- **App Check** protects the Gemini API: reCAPTCHA Enterprise on the hosted web demo, and a registered debug token in the extension, because extension pages can't run reCAPTCHA (the contest rules accept debug tokens).
- **Authentication** (anonymous, `firebase/auth/web-extension`) gives each user a private history.
- **Cloud Firestore** stores each check under `users/{uid}/audits` for the Recent checks list.
- **Remote Config** holds the phone size, how long to wait for popups, and extra prompt guidance, so checks can be tuned without shipping a new build.

## Try it

- **No install:** the web demo at https://justin55afdfdsf5ds45f4ds5f45ds4.github.io/firstscreen/try/ runs the same audit code on three made-up sample sites. In Chrome with Gemini Nano it runs on your device; anywhere else it runs in the cloud. App Check protects it with reCAPTCHA Enterprise.
- **The extension (checks any live site):** it needs a Firebase project of your own, because an App Check debug token works only for the project it was made in. Follow **Build it yourself** below (your project's config in `src/firebase-config.js`, a debug token from that project in `src/debug-token.js`), run `node build.mjs`, then open `chrome://extensions`, turn on Developer mode, click **Load unpacked** and pick the `ext` folder. Open any business website, click the FirstScreen icon and **Check the first phone screen**. Without a debug token the check still runs on the device where Gemini Nano is available, but the cloud fallback needs the token.

On-device checks need desktop Chrome with Gemini Nano available (the panel shows "On-device: Gemini Nano" when it is). Where Nano can't take images yet, the check stays on the device with the measured facts only; with no local model at all, the same call runs in the cloud.

## Build it yourself

1. Create a Firebase project and turn on **AI Logic** (Gemini Developer API), **Authentication** (Anonymous), **Cloud Firestore** and **Remote Config**. Register a web app and put its config in `src/firebase-config.js`. The config in this repo is the public web config of the demo project: a Firebase web API key identifies the project and is not a secret, and access is controlled by App Check and the Firestore rules.
2. App Check: in Firebase console > App Check, register the web app with a reCAPTCHA Enterprise key (the hosted demo uses it; put the site key in `RECAPTCHA_ENTERPRISE_SITE_KEY`) and turn on enforcement for Firebase AI Logic. Extension pages can't load reCAPTCHA, so the extension uses a debug token: generate one in App Check > Apps > Manage debug tokens, copy `src/debug-token.example.js` to `src/debug-token.js` and paste it there. That file is git-ignored and never published.
3. Deploy `firebase/firestore.rules` and upload `firebase/remoteconfig.template.json` as the Remote Config template.
4. `npm install`, then `node build.mjs`. It bundles `src/` into `ext/sidepanel.js` (the extension) and `docs/try/app.js` (the web demo, always built without the debug token).

## Privacy

On a device with Gemini Nano, nothing about the checked page leaves the computer except the saved result (page address, score, verdict, fixes, owner line, where it ran, how long it took and the tap-to-call count) in your own Firestore history. In cloud mode, the first-screen screenshot and the measured facts are sent to Gemini through Firebase AI Logic. FirstScreen never reads form fields, cookies or anything outside the tab you check.

## License

Apache 2.0
