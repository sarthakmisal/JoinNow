const fs = require('node:fs');
const path = require('node:path');

function rmIfExists(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function copyDir(src, dst) {
  ensureDir(dst);
  fs.cpSync(src, dst, { recursive: true });
}

const root = path.resolve(__dirname, '..');
const frontendBuild = path.join(root, 'frontend', 'build');
const rootBuild = path.join(root, 'build');

if (!fs.existsSync(frontendBuild)) {
  console.error(`Missing frontend build at: ${frontendBuild}`);
  process.exit(1);
}

// Clean old root build contents but keep the directory.
rmIfExists(rootBuild);
ensureDir(rootBuild);

copyDir(frontendBuild, rootBuild);

console.log(`Synced frontend build to: ${rootBuild}`);
