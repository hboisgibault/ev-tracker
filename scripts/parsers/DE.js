const fs = require('fs');
const path = require('path');
const { fetchFile, ensureDir, filterMissingMonths, getMonthsSinceStart } = require('../util');
const xlsx = require('xlsx');

/**
 * Try multiple KBA file URL patterns
 * KBA publishes several file types with different naming conventions
 */
function getKbaFileUrls(year, month) {
  const monthStr = String(month).padStart(2, '0');
  
  // KBA uses various file naming patterns for different statistics
  // FZ7: Neuzulassungen nach Kraftstoffarten (new registrations by fuel type)
  // FZ10: Neuzulassungen nach Marken und Modellreihen (includes fuel types)
  // FZ13: Neuzulassungen nach Umwelt-Merkmalen
  // Need to add ?__blob=publicationFile&v=2 to actually download the file
  const blobParams = '?__blob=publicationFile&v=2';
  
  return [
    `https://www.kba.de/SharedDocs/Downloads/DE/Statistik/Fahrzeuge/FZ10/fz10_${year}_${monthStr}.xlsx${blobParams}`,
    `https://www.kba.de/SharedDocs/Downloads/DE/Statistik/Fahrzeuge/FZ7/fz7_${year}_${monthStr}.xlsx${blobParams}`,
    `https://www.kba.de/SharedDocs/Downloads/DE/Statistik/Fahrzeuge/FZ13/fz13_${year}_${monthStr}.xlsx${blobParams}`,
    `https://www.kba.de/SharedDocs/Downloads/DE/Statistik/Fahrzeuge/FZ/fz_${year}_${monthStr}.xlsx${blobParams}`
  ];
}

/**
 * Map German fuel type names to normalized codes
 */
function mapGermanFuelType(fuelName) {
  if (!fuelName || typeof fuelName !== 'string') return 'UNKNOWN';
  
  const normalized = fuelName.toLowerCase().trim();
  
  const mapping = {
    'elektro': 'BEV',
    'elektrisch': 'BEV',
    'benzin': 'GASOLINE',
    'diesel': 'DIESEL',
    'hybrid': 'HYBRID',
    'plug-in-hybrid': 'PHEV',
    'plug-in hybrid': 'PHEV',
    'erdgas': 'LPG_CNG_OTHER',
    'cng': 'LPG_CNG_OTHER',
    'flüssiggas': 'LPG_CNG_OTHER',
    'lpg': 'LPG_CNG_OTHER',
    'wasserstoff': 'LPG_CNG_OTHER',
    'sonstige': 'OTHER'
  };
  
  for (const [key, value] of Object.entries(mapping)) {
    if (normalized.includes(key)) {
      return value;
    }
  }
  
  return 'UNKNOWN';
}

/**
 * Parse KBA Excel file and extract fuel type data
 * The FZ10 file contains registrations by brand and model with fuel type columns
 */
function parseKbaExcel(buffer) {
  try {
    const workbook = xlsx.read(buffer, { type: 'buffer' });

    // The data sits in a sheet like "FZ10.1" or "FZ 10.1"; skip cover pages
    const sheetNames = workbook.SheetNames;
    const preferredSheet = sheetNames.find(name => /fz\s*10/i.test(name));
    const fallbackSheet = sheetNames.find(name => !/deckblatt|impressum|inhalt/i.test(name.toLowerCase()));
    const sheetName = preferredSheet || fallbackSheet || sheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, defval: '' });

    console.log(`  Parsing sheet: ${sheetName} (${rows.length} rows)`);

    // Find the header row (contains "Insgesamt" for totals)
    const headerIndex = rows.findIndex(row => row.some(cell => typeof cell === 'string' && cell.toLowerCase().includes('insgesamt')));
    if (headerIndex === -1 || !rows[headerIndex + 1]) {
      console.log('  Unable to find header rows in KBA Excel file');
      return null;
    }

    const headerRow = rows[headerIndex];

    // Map interesting columns dynamically based on header labels
    const columnIndex = {};
    headerRow.forEach((cell, idx) => {
      if (!cell || typeof cell !== 'string') return;
      const label = cell.toLowerCase();

      if (label.includes('insgesamt')) columnIndex.TOTAL = idx;
      else if (label.includes('mit dieselantrieb') && !label.includes('hybrid')) columnIndex.DIESEL = idx;
      else if (label.includes('mit elektroantrieb')) columnIndex.BEV = idx;
      else if (label.includes('plug-in-hybridantrieb') && !label.includes('benzin') && !label.includes('diesel')) columnIndex.PHEV = idx;
      else if (label.includes('hybridantrieb') && label.includes('ohne plug')) columnIndex.HYBRID = idx; // Non plug-in hybrids
      else if (label.includes('mit hybridantrieb')) columnIndex.ALL_HYBRIDS = idx; // Includes plug-in
    });

    const safeNumber = (value) => {
      const num = Number(String(value).replace(/[^0-9.-]/g, ''));
      return Number.isFinite(num) ? num : 0;
    };

    // Find the total row (contains "NEUZULASSUNGEN INSGESAMT" near the bottom)
    let totalRow = null;
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      const hasTotal = row.some(cell => String(cell || '').toUpperCase().includes('NEUZULASSUNGEN INSGESAMT'));
      if (hasTotal) {
        totalRow = row;
        console.log(`  Found total row at index ${i}`);
        break;
      }
    }

    if (!totalRow) {
      console.log('  Unable to find total row in KBA Excel file');
      return null;
    }

    const fuelData = {};

    if (columnIndex.BEV !== undefined) {
      const bev = safeNumber(totalRow[columnIndex.BEV]);
      if (bev > 0) fuelData.BEV = bev;
      console.log(`  BEV: ${bev}`);
    }

    if (columnIndex.DIESEL !== undefined) {
      const diesel = safeNumber(totalRow[columnIndex.DIESEL]);
      if (diesel > 0) fuelData.DIESEL = diesel;
      console.log(`  DIESEL: ${diesel}`);
    }

    if (columnIndex.PHEV !== undefined) {
      const phev = safeNumber(totalRow[columnIndex.PHEV]);
      if (phev > 0) fuelData.PHEV = phev;
      console.log(`  PHEV: ${phev}`);
    }

    if (columnIndex.HYBRID !== undefined) {
      const hybrid = safeNumber(totalRow[columnIndex.HYBRID]);
      if (hybrid > 0) fuelData.HYBRID = hybrid;
      console.log(`  HYBRID (non plug-in): ${hybrid}`);
    }

    const total = columnIndex.TOTAL !== undefined ? safeNumber(totalRow[columnIndex.TOTAL]) : 0;
    const bev = fuelData.BEV || 0;
    const diesel = fuelData.DIESEL || 0;
    const allHybrids = columnIndex.ALL_HYBRIDS !== undefined ? safeNumber(totalRow[columnIndex.ALL_HYBRIDS]) : (bev + diesel + (fuelData.PHEV || 0) + (fuelData.HYBRID || 0));

    const gasoline = Math.round(total - diesel - allHybrids - bev);
    if (gasoline > 0) {
      fuelData.GASOLINE = gasoline;
      console.log(`  GASOLINE (calculated): ${gasoline}`);
    }

    return fuelData;
  } catch (error) {
    console.error('  Error parsing Excel file:', error.message);
    return null;
  }
}

/**
 * Fetch and process data for a specific month
 */
async function fetchMonthData(year, month) {
  const monthStr = String(month).padStart(2, '0');
  console.log(`Fetching DE data for ${year}-${monthStr}...`);
  
  const urls = getKbaFileUrls(year, month);
  
  // Try each URL pattern until one works
  for (const url of urls) {
    try {
      console.log(`  Trying: ${url}`);
      const buffer = await fetchFile(url);
      
      const fuelData = parseKbaExcel(buffer);
      
      if (fuelData && Object.keys(fuelData).length > 0) {
        console.log(`  Success! Found ${Object.keys(fuelData).length} fuel types`);
        return fuelData;
      }
    } catch (error) {
      // Try next URL
      continue;
    }
  }
  
  console.log(`  No data found for ${year}-${monthStr}`);
  return null;
}

/**
 * Save monthly data to file
 */
function saveMonthlyData(year, month, fuelData) {
  const monthStr = String(month).padStart(2, '0');
  const outDir = path.join(__dirname, '../../data/DE/ev');
  
  ensureDir(outDir);
  
  const outPath = path.join(outDir, `${year}-${monthStr}.json`);
  
  const data = [];
  for (const [energie, total] of Object.entries(fuelData)) {
    data.push({
      marque: 'Alle Marken',
      modele: 'Alle Modelle',
      total,
      energie
    });
  }
  
  const output = {
    year,
    month,
    data,
    region: 'DE',
    type: 'all'
  };
  
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`  Saved: ${outPath}`);
}

/**
 * Fetch all EV data from KBA
 */
async function fetchAllEVData() {
  console.log('Starting German (KBA) EV data collection...');
  
  // KBA files are available from 2021 onward
  const allMonths = getMonthsSinceStart(2021);
  const outDir = path.join(__dirname, '../../data/DE/ev');
  const missingMonths = filterMissingMonths(allMonths, outDir, (m) => `${m.code}.json`);
  
  console.log(`Total months in range: ${allMonths.length}`);
  console.log(`Missing months to fetch: ${missingMonths.length}`);
  
  if (missingMonths.length === 0) {
    console.log('All months already have data. Nothing to fetch.');
    return;
  }
  
  let successCount = 0;
  let errorCount = 0;
  
  for (const monthInfo of missingMonths) {
    try {
      const fuelData = await fetchMonthData(monthInfo.year, monthInfo.month);
      
      if (fuelData && Object.keys(fuelData).length > 0) {
        saveMonthlyData(monthInfo.year, monthInfo.month, fuelData);
        successCount++;
      } else {
        errorCount++;
      }
      
      // Add delay to be respectful to the server
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      console.error(`Error processing ${monthInfo.code}:`, error.message);
      errorCount++;
    }
  }
  
  console.log(`\nProcessing complete. ${successCount} new files saved, ${errorCount} errors.`);
}

module.exports = {
  fetchAllEVData
}
