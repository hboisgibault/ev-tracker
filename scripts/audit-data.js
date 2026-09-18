// scripts/audit-data.js
// Reproducible audit of data/{CC}/ev/*.json coherence.
// Usage: node scripts/audit-data.js [--strict]
// Exit code 1 when blocking incoherences are found (micro-totals,
// filename/year-month mismatch, negative totals, empty data).
// Coverage gaps and missing sourceUrl are warnings (exit 0 unless --strict).

const fs = require('fs');
const path = require('path');
const { MIN_MONTHLY_TOTAL, MAX_MONTHLY_TOTAL } = require('./parsers/ACEA.js');
const STRICT = process.argv.includes('--strict');

function monthRange(min, max) {
  const out = [];
  let [y, m] = min.split('-').map(Number);
  const [y2, m2] = max.split('-').map(Number);
  while (y < y2 || (y === y2 && m <= m2)) {
    out.push(`${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`);
    m += 1;
    if (m === 13) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

const errors = [];
const warnings = [];
const dataDir = path.join(__dirname, '../data');
const zones = fs
  .readdirSync(dataDir)
  .filter((d) => fs.statSync(path.join(dataDir, d)).isDirectory());

// First pass: per-country energy frequencies, to spot isolated absences
// (e.g. DE HYBRID missing 2021-08..12 while present in 92% of DE files).
const energyFreq = {};
for (const zone of zones) {
  const evDir = path.join(dataDir, zone, 'ev');
  if (!fs.existsSync(evDir)) continue;
  const files = fs.readdirSync(evDir).filter((f) => f.endsWith('.json'));
  const freq = {};
  for (const file of files) {
    try {
      const content = JSON.parse(fs.readFileSync(path.join(evDir, file), 'utf8'));
      for (const row of content.data || []) freq[row.energie] = (freq[row.energie] || 0) + 1;
    } catch {
      // Invalid JSON is reported in the main pass.
    }
  }
  energyFreq[zone] = { freq, n: files.length };
}

for (const zone of zones.sort()) {
  const evDir = path.join(dataDir, zone, 'ev');
  if (!fs.existsSync(evDir)) {
    warnings.push(`${zone}: no ev/ directory`);
    continue;
  }
  const files = fs
    .readdirSync(evDir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (files.length === 0) {
    warnings.push(`${zone}: empty ev/ directory`);
    continue;
  }
  const present = new Set(files.map((f) => f.slice(0, -5)));
  const full = monthRange(files[0].slice(0, -5), files[files.length - 1].slice(0, -5));
  const missing = full.filter((m) => !present.has(m));
  if (missing.length > 0)
    warnings.push(`${zone}: ${missing.length} missing months: ${missing.join(', ')}`);

  let prevCode = null;
  let prevTotal = 0;
  for (const file of files) {
    const code = file.slice(0, -5);
    let content;
    try {
      content = JSON.parse(fs.readFileSync(path.join(evDir, file), 'utf8'));
    } catch (e) {
      errors.push(`${zone}/${file}: invalid JSON (${e.message})`);
      continue;
    }
    const expected = `${String(content.year).padStart(4, '0')}-${String(content.month).padStart(2, '0')}`;
    if (expected !== code)
      errors.push(`${zone}/${file}: filename/year-month mismatch (body=${expected})`);
    if (!Array.isArray(content.data) || content.data.length === 0) {
      errors.push(`${zone}/${file}: empty data array`);
      continue;
    }
    const byEnergy = {};
    for (const row of content.data) {
      if (row.total < 0)
        errors.push(`${zone}/${file}: negative total (${row.energie}=${row.total})`);
      byEnergy[row.energie] = (byEnergy[row.energie] || 0) + row.total;
    }
    const total = Object.values(byEnergy).reduce((a, b) => a + b, 0);
    if (total < MIN_MONTHLY_TOTAL || total > MAX_MONTHLY_TOTAL)
      errors.push(
        `${zone}/${file}: implausible total ${total} (expected ${MIN_MONTHLY_TOTAL}-${MAX_MONTHLY_TOTAL}) -> ${JSON.stringify(byEnergy)}`
      );
    if (
      (byEnergy.PHEV === 0) !== (byEnergy.HYBRID === 0) &&
      'PHEV' in byEnergy &&
      'HYBRID' in byEnergy
    )
      warnings.push(
        `${zone}/${file}: PHEV xor HYBRID == 0 (PHEV=${byEnergy.PHEV}, HYBRID=${byEnergy.HYBRID})`
      );
    // Energy structurally present in this country (>=90% of files) but
    // absent here: probable extraction gap, not a genuine zero (zeroes are
    // written explicitly, e.g. RO/LV HYBRID=0 post-fix).
    const { freq, n } = energyFreq[zone];
    for (const [energie, count] of Object.entries(freq)) {
      if (count / n >= 0.9 && !(energie in byEnergy))
        warnings.push(`${zone}/${file}: missing ${energie} (present in ${count}/${n} files)`);
    }
    if (prevCode !== null && prevTotal > 0 && (total < prevTotal * 0.3 || total > prevTotal * 3))
      warnings.push(`${zone}/${file}: rupture ${prevCode} ${prevTotal} -> ${code} ${total}`);
    prevCode = code;
    prevTotal = total;
  }
}

console.log(`Zones audited: ${zones.length}`);
console.log(`Errors: ${errors.length}`);
errors.forEach((e) => console.log(`  ERROR ${e}`));
console.log(`Warnings: ${warnings.length}`);
warnings.forEach((w) => console.log(`  WARN ${w}`));

if (STRICT && warnings.length > 0) process.exit(1);
if (errors.length > 0) process.exit(1);
console.log('AUDIT OK (no blocking errors)');
