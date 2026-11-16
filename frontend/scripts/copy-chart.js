const fs = require('node:fs');
const path = require('node:path');

const outputDir = path.resolve(__dirname, '..', 'dist');
fs.mkdirSync(outputDir, { recursive: true });
fs.copyFileSync(
  path.resolve(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js'),
  path.join(outputDir, 'chart.umd.js'),
);
