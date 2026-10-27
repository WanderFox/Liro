// Copies the shared web UI (../web) into the client so it is bundled into the app.
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', '..', 'web');
const dst = path.join(__dirname, '..', 'web');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
console.log(`web UI copied: ${src} -> ${dst}`);
