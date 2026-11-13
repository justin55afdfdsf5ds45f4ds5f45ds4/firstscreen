#!/bin/sh
# Build and zip the extension for sharing. The zip must never carry the App Check debug token,
# so this stops while src/debug-token.js exists.
set -e
if [ -f src/debug-token.js ]; then
  echo "src/debug-token.js exists, so the zip would contain your App Check debug token. Move it out of src/ and run again." >&2
  exit 1
fi
node build.mjs
rm -f firstscreen-extension.zip
cd ext && zip -qr ../firstscreen-extension.zip . -x "demo.html" "demo.js" && cd ..
echo "firstscreen-extension.zip ready (no debug token)"
