// Runs inside the checked page (through the DevTools protocol) while the tab is emulating a phone.
// It measures what a customer can actually see and tap on the first screen. No network calls.
export function probeFirstScreen() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const zoom = Math.min(1, window.visualViewport ? window.visualViewport.scale : 1, screen.width / vw || 1);
  const css = (el) => getComputedStyle(el);
  const shown = (el) => {
    const s = css(el);
    return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0.05;
  };
  const box = (el) => el.getBoundingClientRect();
  const onFirstScreen = (el) => {
    const r = box(el);
    return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  };
  const clean = (t) => (t || "").replace(/\s+/g, " ").trim();
  const bodyText = document.body ? document.body.innerText : "";

  // Tap-to-call links, plus call buttons that show an icon or a label instead of the number
  const tel = [...document.querySelectorAll('a[href^="tel:"]')].filter(shown);
  const telFirst = tel.filter(onFirstScreen);
  const callWord = /\b(call|phone|dial)\b/i;
  const callClass = /(^|[\s_-])(call|phone|tel)([\s_-]|$)/i;
  const callFirst = [...document.querySelectorAll('a, button, [role="button"]')]
    .filter((el) => shown(el) && onFirstScreen(el))
    .filter((el) => {
      if (/^(tel|sms):/i.test(el.getAttribute("href") || "")) return true;
      const alts = [...el.querySelectorAll("img[alt], svg title")].map((n) => n.getAttribute("alt") || n.textContent);
      const label = [el.getAttribute("aria-label"), el.getAttribute("title"), el.innerText, ...alts].join(" ");
      return callWord.test(label) || callClass.test(el.getAttribute("class") || "");
    });

  // Text the customer can read on the first screen, plus any phone numbers in it or in image alt text
  const phoneRe = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const words = [];
  const phones = new Set();
  const sizes = [];
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const t = clean(node.textContent);
    const el = node.parentElement;
    if (!t || !el || !shown(el) || !onFirstScreen(el)) continue;
    words.push(t);
    (t.match(phoneRe) || []).forEach((p) => phones.add(p.trim()));
    sizes.push(parseFloat(css(el).fontSize) || 0);
  }
  for (const img of document.querySelectorAll("img[alt]")) {
    if (shown(img) && onFirstScreen(img)) (img.alt.match(phoneRe) || []).forEach((p) => phones.add(p.trim()));
  }
  sizes.sort((a, b) => a - b);

  // What is pinned on top of the page. A grid of points asks the browser what a tap there would hit,
  // so layers that sit behind the page, let taps through (falling snow, glows) or hold nothing are not counted.
  const outerFixed = (el) => {
    let found = null;
    for (let e = el; e && e !== document.body && e !== document.documentElement; e = e.parentElement) {
      if (css(e).position === "fixed") found = e;
    }
    return found;
  };
  const hits = new Map();
  const COLS = 8, ROWS = 16;
  for (let i = 0; i < COLS; i++) {
    for (let j = 0; j < ROWS; j++) {
      const el = document.elementFromPoint(((i + 0.5) * vw) / COLS, ((j + 0.5) * vh) / ROWS);
      const f = el && outerFixed(el);
      if (f) hits.set(f, (hits.get(f) || 0) + 1);
    }
  }
  const looksEmpty = (el) => {
    const s = css(el);
    const paint = s.backgroundImage !== "none" || !/rgba\(.*,\s*0(\.0\d*)?\)$|transparent/.test(s.backgroundColor);
    const media = [...el.querySelectorAll("img, video, iframe, canvas, svg")].some((m) => {
      const r = box(m);
      return shown(m) && r.width * r.height > vw * vh * 0.02;
    });
    return !paint && !media && !/[a-z0-9]/i.test(el.innerText || "");
  };
  const overlays = [];
  let pinnedHeaderPercent = 0;
  for (const [el, n] of hits) {
    const cover = n / (COLS * ROWS);
    const frames = el.tagName === "IFRAME" ? [el] : [...el.querySelectorAll("iframe")];
    const text = clean(el.innerText) || clean(frames.map((f) => f.title || f.name || "").join(" "));
    if (bodyText.length > 300 && text.length > bodyText.length * 0.6) continue; // the whole page lives in a pinned scroller
    if (looksEmpty(el)) continue;
    const r = box(el);
    if (r.top <= 1 && r.bottom < vh * 0.6 && !/cookie/i.test(text)) {
      pinnedHeaderPercent = Math.max(pinnedHeaderPercent, Math.round((Math.min(r.bottom, vh) / vh) * 100));
      continue;
    }
    if (cover < 0.25) continue;
    const closable = el.matches('[role="dialog"], [aria-modal="true"]') || [...el.querySelectorAll("*")].slice(0, 600).some((b) =>
      /(^|[\s_-])(close|dismiss)([\s_-]|$)|no thanks/i.test([b.getAttribute("aria-label"), b.getAttribute("title"), b.getAttribute("class")].join(" ")) ||
      (!b.children.length && /^(×|✕|✖|x|close|no thanks)$/i.test(clean(b.textContent))));
    const kind = /cookie|privacy|consent/i.test(text) ? "cookie notice"
      : /chat|message us|text us/i.test(text) ? "chat window"
      : /sign me up|sign up|subscribe|newsletter|join|% off|coupon|offer|deal|exclusive|giveaway/i.test(text) ? "sign-up or offer popup"
      : closable ? "popup"
      : "pinned layer";
    overlays.push({ kind, coversPercent: Math.round(cover * 100), text: text.slice(0, 100) });
  }
  overlays.sort((a, b) => b.coversPercent - a.coversPercent);
  // A popup's dimmed backdrop is its own empty layer: keep the popup, drop the backdrop
  const shownOverlays = overlays.some((o) => o.text) ? overlays.filter((o) => o.text) : overlays;

  const reviews = countReviews();
  const year = (bodyText.match(/(?:©|copyright)\s*(?:\d{4}\s*[-–]\s*)?((?:19|20)\d{2})/i) || [])[1] || null;
  const buttons = [...document.querySelectorAll("a, button")]
    .filter((el) => shown(el) && onFirstScreen(el))
    .map((el) => clean(el.innerText))
    .filter((t) => t && t.length <= 40)
    .slice(0, 8);

  return {
    url: location.href,
    title: document.title.slice(0, 120),
    hasViewportMeta: !!document.querySelector('meta[name="viewport"]'),
    pageWiderThanPhone: document.documentElement.scrollWidth > vw + 4,
    tapToCallLinks: tel.length,
    tapToCallOnFirstScreen: telFirst.length,
    callButtonsOnFirstScreen: callFirst.map((el) => clean(el.innerText || el.getAttribute("aria-label") || "icon")).slice(0, 4),
    phoneNumbersOnFirstScreen: [...phones].slice(0, 3),
    buttonsOnFirstScreen: buttons,
    // A page without a mobile viewport is drawn at desktop width and shrunk to fit, so text looks much smaller than its CSS size.
    viewportWidth: Math.round(vw),
    shrunkToFit: zoom < 0.9 || vw > 500,
    smallestTextPx: sizes.length ? Math.round(sizes[0] * zoom * 10) / 10 : null,
    medianTextPx: sizes.length ? Math.round(sizes[Math.floor(sizes.length / 2)] * zoom * 10) / 10 : null,
    pinnedHeaderPercent,
    overlays: shownOverlays.slice(0, 3),
    reviewMentions: reviews.reviewMentions,
    reviewWidget: reviews.reviewWidget,
    copyrightYear: year,
    firstScreenText: words.join(" ").slice(0, 600),
  };

  // Reviews or testimonials anywhere on the page, in words or through a review widget
  function countReviews() {
    const text = document.body ? document.body.innerText : "";
    const re = /\b(reviews?|testimonials?|ratings?|five[- ]stars?|5[- ]stars?)\b|what (?:our |my )?(?:customers|clients|neighbors|homeowners|people) (?:are )?say|happy (?:customers|clients)|kind words|★{3,}|⭐{3,}/gi;
    const named = /(^|[^a-z])(reviews?|testimonials?)/i;
    const widget = [...document.querySelectorAll("[class], [id], iframe[src], script[src]")].find((el) =>
      named.test(el.getAttribute("class") || "") || named.test(el.id || "") ||
      /elfsight|trustindex|birdeye|nicejob|reviewsonmywebsite|podium|grade\.us|reviewbuzz/i.test(el.getAttribute("src") || el.getAttribute("class") || "")
    );
    return { reviewMentions: (text.match(re) || []).length, reviewWidget: !!widget };
  }
}

// Scrolls the whole page once so lazy sections load, counts reviews again, then goes back to the top.
// Runs after the screenshot, so it never changes what the first screen looked like.
export async function probeWholePage() {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 40; i++) {
    window.scrollBy(0, Math.round(window.innerHeight * 0.9));
    await wait(150);
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) break;
  }
  await wait(700);
  const text = document.body ? document.body.innerText : "";
  const re = /\b(reviews?|testimonials?|ratings?|five[- ]stars?|5[- ]stars?)\b|what (?:our |my )?(?:customers|clients|neighbors|homeowners|people) (?:are )?say|happy (?:customers|clients)|kind words|★{3,}|⭐{3,}/gi;
  const named = /(^|[^a-z])(reviews?|testimonials?)/i;
  const widget = [...document.querySelectorAll("[class], [id], iframe[src], script[src]")].some((el) =>
    named.test(el.getAttribute("class") || "") || named.test(el.id || "") ||
    /elfsight|trustindex|birdeye|nicejob|reviewsonmywebsite|podium|grade\.us|reviewbuzz/i.test(el.getAttribute("src") || el.getAttribute("class") || "")
  );
  const tel = document.querySelectorAll('a[href^="tel:"]').length;
  window.scrollTo(0, 0);
  return { reviewMentions: (text.match(re) || []).length, reviewWidget: widget, tapToCallLinks: tel };
}
