#!/bin/sh
# Build and zip the extension for Load unpacked or the Chrome Web Store.
set -e
node build.mjs
rm -f firstscreen-extension.zip
cd ext && zip -qr ../firstscreen-extension.zip . -x "demo.html" "demo.js" && cd ..
echo "firstscreen-extension.zip ready"
