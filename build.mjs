import { build } from "esbuild";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const common = { bundle: true, format: "esm", target: "chrome139", minify: false, sourcemap: false, legalComments: "none" };

// src/debug-token.js is local only. Without it (a fresh clone), or for anything published, the build
// resolves the import to src/debug-token.example.js, which holds no token.
const noToken = {
  name: "no-debug-token",
  setup(b) {
    b.onResolve({ filter: /\/debug-token\.js$/ }, () => ({ path: resolve("src/debug-token.example.js") }));
  },
};
const hasToken = existsSync("src/debug-token.js");

// The extension's side panel (with the local debug token when there is one: extension pages can't run reCAPTCHA).
await build({ ...common, entryPoints: ["src/sidepanel.js"], outfile: "ext/sidepanel.js", plugins: hasToken ? [] : [noToken] });
// The hosted web demo, always without the token: App Check uses reCAPTCHA Enterprise there.
await build({ ...common, entryPoints: ["src/try.js"], outfile: "docs/try/app.js", plugins: [noToken] });
console.log(`built ext/sidepanel.js (${hasToken ? "with local debug token" : "no debug token"}) and docs/try/app.js (no debug token)`);
