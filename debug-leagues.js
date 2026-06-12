const fs = require('fs');
const path = require('path');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isUuid(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

const dumpFile = "C:\\Users\\tech solutionor\\Documents\\cfmono repo.txt";
const payload = JSON.parse(fs.readFileSync(path.join(__dirname, 'dist', 'dump.json'), 'utf8')); // Wait, the extractDumpJson extracts it, or we can use the extractor
console.log('Done reading');
