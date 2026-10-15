const { execSync } = require('child_process');
const { existsSync } = require('fs');
const { join } = require('path');

module.exports = async function () {
  try {
    execSync('npx prisma generate', { stdio: 'inherit', cwd: __dirname });
  } catch (err) {
    // Offline / blocked engine download: reuse an already generated client if present.
    const generated = [
      join(__dirname, '../../node_modules/.prisma/client/index.d.ts'),
      join(__dirname, 'node_modules/.prisma/client/index.d.ts'),
    ].some(existsSync);
    if (!generated) throw err;
    console.warn('prisma generate failed; using the existing generated client.');
  }
};