const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function extractDumpJson(dumpPath) {
  const extractor = path.join(__dirname, 'extract-pgdump.py');
  const result = spawnSync(
    'python',
    [extractor, '--file', dumpPath],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 }
  );
  return JSON.parse(result.stdout);
}

async function main() {
  const dumpFile = "C:\\Users\\tech solutionor\\Documents\\cfmono repo.txt";
  const payload = extractDumpJson(dumpFile);
  const sourceLeagues = payload.tables.League || [];
  
  console.log('Total leagues in source:', sourceLeagues.length);
  
  const names = sourceLeagues.map(l => (l.name && String(l.name).trim()) || `League-${String(l.id).slice(0, 8)}`);
  const uniqueNames = new Set(names);
  console.log('Unique names:', uniqueNames.size);

  const seenNames = new Map(); // name -> count
  for (const l of sourceLeagues) {
    const name = (l.name && String(l.name).trim()) || `League-${String(l.id).slice(0, 8)}`;
    seenNames.set(name, (seenNames.get(name) || 0) + 1);
  }

  const duplicates = [];
  for (const [name, count] of seenNames.entries()) {
    if (count > 1) {
      duplicates.push({ name, count });
    }
  }
  console.log('Duplicate names:', duplicates);
}

main().catch(console.error);
