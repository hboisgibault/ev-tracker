const fs = require('fs');
const path = require('path');
const { ensureDir, filterMissingMonths, getMonthsSinceStart, fetchJson } = require('../util');

/**
 * Map Norwegian fuel type codes to normalized codes
 */
function mapFuelType(code) {
  const mapping = {
    '19': 'BEV',           // Electric/zero-emission
    '20': 'FOSSIL',        // Fossil (gasoline + diesel combined)
    '21': 'HYBRID',        // Hybrid (generic, includes PHEV)
    '6': 'OTHER'           // Other fuel (LPG, CNG, etc.)
  };
  return mapping[code] || 'UNKNOWN';
}

/**
 * Parse JSON-stat2 response and extract values by fuel type and month
 */
function parseJsonStat(response) {
  // Structure: dimensions are [TypeRegistrering, DrivstoffType, ContentsCode, Tid]
  // size: [1, 4, 1, N] where N is number of months
  const { dimension, value, size } = response;
  
  if (!dimension || !value || !size) {
    throw new Error('Invalid JSON-stat response structure');
  }

  // Get the actual order of fuel types and months from the API response
  const fuelTypeIndex = dimension.DrivstoffType.category.index;
  const monthIndex = dimension.Tid.category.index;
  
  // Create arrays maintaining API order
  const fuelTypes = Object.entries(fuelTypeIndex)
    .sort((a, b) => a[1] - b[1])
    .map(([code]) => code);
  
  const months = Object.entries(monthIndex)
    .sort((a, b) => a[1] - b[1])
    .map(([code]) => code);
  
  // Size: [typeReg, fuelType, contents, time]
  const [sizeTypeReg, sizeFuel, sizeContents, sizeTime] = size;
  
  const results = {};
  
  // Iterate through the flat value array
  let valueIndex = 0;
  for (let iTypeReg = 0; iTypeReg < sizeTypeReg; iTypeReg++) {
    for (let iFuel = 0; iFuel < sizeFuel; iFuel++) {
      for (let iContents = 0; iContents < sizeContents; iContents++) {
        for (let iTime = 0; iTime < sizeTime; iTime++) {
          const fuelCode = fuelTypes[iFuel];
          const monthCode = months[iTime];
          const val = value[valueIndex] || 0;
          
          if (!results[monthCode]) {
            results[monthCode] = {};
          }
          results[monthCode][fuelCode] = val;
          
          valueIndex++;
        }
      }
    }
  }
  
  return results;
}

/**
 * Fetch data for a batch of months
 */
async function fetchMonthsBatch(monthCodes) {
  const apiUrl = 'https://data.ssb.no/api/v0/en/table/14020';
  
  const requestBody = {
    query: [
      {
        code: 'TypeRegistrering',
        selection: {
          filter: 'item',
          values: ['N'] // New vehicles only
        }
      },
      {
        code: 'DrivstoffType',
        selection: {
          filter: 'item',
          values: ['19', '20', '21', '6'] // Electric, Fossil, Hybrid, Other
        }
      },
      {
        code: 'ContentsCode',
        selection: {
          filter: 'item',
          values: ['Personbiler'] // Private cars
        }
      },
      {
        code: 'Tid',
        selection: {
          filter: 'item',
          values: monthCodes
        }
      }
    ],
    response: {
      format: 'json-stat2'
    }
  };

  console.log(`Fetching ${monthCodes.length} months from Norwegian API...`);
  // Use fetchJson with POST
  const response = await fetchJson(apiUrl, {
      method: 'POST',
      body: JSON.stringify(requestBody)
  });
  return parseJsonStat(response);
}


/**
 * Save monthly data to individual JSON files
 */
function saveMonthlyData(monthCode, fuelData) {
  // Parse month code: "2024M01" -> year=2024, month=1
  const match = monthCode.match(/^(\d{4})M(\d{2})$/);
  if (!match) {
    console.error(`Invalid month code: ${monthCode}`);
    return false;
  }

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const monthStr = match[2];

  const outDir = path.join(process.cwd(), 'data/NO/ev'); // Absolute path fix
  ensureDir(outDir);

  const outPath = path.join(outDir, `${year}-${monthStr}.json`);

  // Convert fuel data to output format
  const data = [];
  for (const [fuelCode, total] of Object.entries(fuelData)) {
    if (total > 0) {
      data.push({
        marque: 'Toutes marques',
        modele: 'Tous modèles',
        total,
        energie: mapFuelType(fuelCode)
      });
    }
  }

  if (data.length === 0) {
    return false; // No data for this month
  }

  const output = {
    year,
    month,
    data,
    region: 'NO',
    type: 'all'
  };

  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  return true;
}

/**
 * Fetch all EV data from Statistics Norway
 */
async function fetchAllEVData() {
  console.log('Starting Norwegian EV data collection...');
  
  // Use getMonthsSinceStart and map to NO format 2024M01
  const allMonthsRaw = getMonthsSinceStart(2011);
  const allMonths = allMonthsRaw.map(m => ({
      ...m,
      code: `${m.year}M${String(m.month).padStart(2, '0')}`
  }));

  console.log(`Total months in range: ${allMonths.length}`);

  // Filter out months that already have files
  const outDir = path.join(process.cwd(), 'data/NO/ev');
  // Only missing months: filter based on code
  const missingMonths = filterMissingMonths(allMonths, outDir, (m) => `${m.year}-${String(m.month).padStart(2, '0')}.json`);

  if (missingMonths.length === 0) {
    console.log('All months already have data. Nothing to fetch.');
    return;
  }

  console.log(`Missing months to fetch: ${missingMonths.length}`);

  // Process in batches to avoid overwhelming the API
  const batchSize = 36; // 3 years at a time
  let totalSaved = 0;
  
  for (let i = 0; i < missingMonths.length; i += batchSize) {
    const batch = missingMonths.slice(i, i + batchSize);
    const monthCodes = batch.map(m => m.code);
    
    try {
      const results = await fetchMonthsBatch(monthCodes);
      
      // Save each month
      for (const monthCode of monthCodes) {
        if (results[monthCode]) {
          const saved = saveMonthlyData(monthCode, results[monthCode]);
          if (saved) {
            totalSaved++;
          }
        }
      }
      
      console.log(`Processed batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(missingMonths.length / batchSize)} (${totalSaved} saved)`);
      
      // Small delay between batches to be respectful to the API
      if (i + batchSize < missingMonths.length) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    } catch (error) {
      console.error(`Error fetching batch starting at ${monthCodes[0]}:`, error.message);
      console.log('Falling back to individual month fetching...');
      
      for (const monthCode of monthCodes) {
        try {
          // Add small delay
          await new Promise(resolve => setTimeout(resolve, 200));
          const results = await fetchMonthsBatch([monthCode]);
          if (results[monthCode]) {
             saveMonthlyData(monthCode, results[monthCode]);
             totalSaved++;
          }
        } catch (innerError) {
           console.warn(`  Failed to fetch ${monthCode}: ${innerError.message}`);
        }
      }
    }
  }
  
  console.log(`Processing complete. ${totalSaved} new files saved.`);
}

module.exports = {
  fetchAllEVData
};
