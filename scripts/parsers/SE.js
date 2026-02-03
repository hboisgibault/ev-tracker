const fs = require('fs');
const path = require('path');
const { fetchFile } = require('../util');
const { parse } = require('csv-parse/sync');
const AdmZip = require('adm-zip');

// Fuel mapping for Sweden
const SWEDISH_FUEL_MAP = {
  DIESEL: ['diesel'],
  GASOLINE: ['petrol'],
  HYBRID: ['electric hybrid'],
  PHEV: ['plug-in hybrid'],
  BEV: ['electricity'],
  OTHER: ['gas/gas flex', 'ethanol/ethanol flexifuel', 'other fuels'],
};

function normalizeSwedishFuel(label) {
  if (!label) return 'UNKNOWN';
  const clean = label.toString().trim().toLowerCase();

  for (const [code, aliases] of Object.entries(SWEDISH_FUEL_MAP)) {
    for (const alias of aliases) {
      if (clean === alias.toLowerCase()) {
        return code;
      }
    }
  }
  return 'OTHER';
}

async function fetchAndProcessCSV() {
  const zipUrl = 'https://www.statistikdatabasen.scb.se/Resources/PX/bulk/ssd/en/TAB3277_en.zip';
  console.log(`Téléchargement du fichier ZIP : ${zipUrl}`);

  const zipBuffer = await fetchFile(zipUrl);
  const zip = new AdmZip(zipBuffer);
  const zipEntries = zip.getEntries();

  let csvEntry = zipEntries.find(e => e.entryName.endsWith('.csv'));
  if (!csvEntry) {
    console.error('Aucun fichier CSV trouvé dans l\'archive ZIP.');
    return;
  }

  console.log(`Extraction du fichier : ${csvEntry.entryName}`);
  const csvContent = csvEntry.getData().toString('utf8');

  // Parse CSV
  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true
  });

  console.log(`${records.length} lignes trouvées dans le CSV.`);

  // Group data by month
  const monthlyData = {};

  for (const row of records) {
    const region = row.region;
    const fuel = row.fuel;
    const month = row.month; // Format: "2006M01"
    const count = parseInt(row['New registered passenger cars, number'], 10) || 0;

    // Only process national data (00 Sweden)
    if (!region.includes('00 Sweden')) continue;

    // Parse month format YYYYMXX
    const match = month.match(/^(\d{4})M(\d{2})$/);
    if (!match) continue;

    const year = parseInt(match[1], 10);
    const monthNum = parseInt(match[2], 10);
    const key = `${year}-${monthNum.toString().padStart(2, '0')}`;

    if (!monthlyData[key]) {
      monthlyData[key] = { year, month: monthNum, byFuel: {} };
    }

    const fuelCode = normalizeSwedishFuel(fuel);
    if (fuelCode !== 'OTHER' && fuelCode !== 'UNKNOWN') {
      monthlyData[key].byFuel[fuelCode] = (monthlyData[key].byFuel[fuelCode] || 0) + count;
    }
  }

  // Write monthly files
  const outDir = path.join(__dirname, '../../data/SE/ev');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  let count = 0;
  for (const [key, monthData] of Object.entries(monthlyData)) {
    const data = [];
    for (const [fuelCode, total] of Object.entries(monthData.byFuel)) {
      if (total > 0) {
        data.push({
          marque: 'Toutes marques',
          modele: 'Tous modèles',
          total,
          energie: fuelCode
        });
      }
    }

    if (data.length > 0) {
      const [year, month] = key.split('-');
      const outPath = path.join(outDir, `${key}.json`);
      
      if (fs.existsSync(outPath)) {
        // Skip existing files
        continue;
      }

      fs.writeFileSync(outPath, JSON.stringify({
        year: parseInt(year, 10),
        month: parseInt(month, 10),
        data,
        region: 'SE',
        type: 'all'
      }, null, 2));
      count++;
    }
  }

  console.log(`Traitement terminé. ${count} fichiers générés/mis à jour dans ${outDir}`);
}

/**
 * Récupère toutes les données (historique complet via CSV)
 */
async function fetchAllEVData() {
  await fetchAndProcessCSV();
}

module.exports = {
  fetchAllEVData
};
