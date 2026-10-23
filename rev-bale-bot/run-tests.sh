#!/bin/sh
# تست سینتکس و منطق ورکر بازو: کپی موقت mjs ساخته و بعد پاک می‌شود.
set -e
cp worker.js worker.mjs
node --check worker.mjs
node test-logic.mjs
rm -f worker.mjs
