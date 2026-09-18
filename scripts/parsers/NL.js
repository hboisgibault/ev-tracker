const fs = require('fs');
const path = require('path');
const { ensureDir, filterMissingMonths, getMonthsSinceStart, fetchJson } = require('../util');
const { validateMonthlyOutput } = require('../schema');

/**
 * Map Dutch fuel descriptions to normalized codes.
 *
 * Source limitation (verified 2026-09-18 via a distinct query on the RDW
 * brandstof table): it exposes no hybrid or plug-in-hybrid category —
 * only Benzine, Diesel, Elektriciteit, LPG, CNG, LNG, Waterstof, Alcohol.
 * Dutch (P)HEV registrations therefore hide inside Benzine/Diesel and NL
 * files structurally lack PHEV/HYBRID rows. This is faithful to the source
 * but NOT comparable fuel-by-fuel with ACEA countries; only BEV and totals
 * should be compared cross-country.
 */
function mapFuelType(brandstof) {
  const mapping = {
    Elektriciteit: 'BEV',
    Benzine: 'GASOLINE',
    Diesel: 'DIESEL',
    LPG: 'OTHER',
    CNG: 'OTHER',
    LNG: 'OTHER',
    Waterstof: 'OTHER',
    Alcohol: 'OTHER',
  };

  return mapping[brandstof] || 'OTHER';
}

/**
 * Fetch aggregated data for a single month from RDW API
 * Using the main vehicle registry table with brandstof sub-table
 */
async function fetchMonthData(monthCode) {
  const [year, month] = monthCode.split('-');

  // Get the date range for the month
  const startDate = `${year}-${month}-01T00:00:00`;
  const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
  const endDate = `${year}-${month}-${lastDay}T23:59:59`;

  console.log(`Fetching NL data for ${monthCode}...`);

  // Step 1: Get all passenger cars registered in this month
  let allVehicles = [];
  let offset = 0;
  const limit = 50000;

  while (true) {
    const url =
      `https://opendata.rdw.nl/resource/m9d7-ebf2.json?` +
      `$select=kenteken&` +
      `$where=datum_eerste_toelating_dt between '${startDate}' and '${endDate}' AND voertuigsoort='Personenauto'&` +
      `$limit=${limit}&$offset=${offset}`;

    // Use fetchJson
    try {
      const vehicles = await fetchJson(url);
      if (!vehicles || vehicles.length === 0) break;
      allVehicles = allVehicles.concat(vehicles);

      if (vehicles.length < limit) break;
      offset += limit;

      // Add delay to respect API rate limits
      await new Promise((resolve) => setTimeout(resolve, 100));
    } catch (e) {
      console.error('Error fetching vehicles:', e.message);
      break;
    }
  }

  console.log(`  Found ${allVehicles.length} vehicles for ${monthCode}`);

  // Step 2: For each vehicle, get fuel type from brandstof table
  // Use moderate parallel processing to avoid API rate limits
  const fuelCounts = {};
  let failedBatches = 0;
  const batchSize = 500; // Moderate batch size
  const parallelRequests = 3; // Limit parallel requests to avoid 500 errors

  // Create all batches
  const batches = [];
  for (let i = 0; i < allVehicles.length; i += batchSize) {
    batches.push(allVehicles.slice(i, i + batchSize));
  }

  console.log(
    `  Processing ${batches.length} batches with ${parallelRequests} parallel requests...`
  );

  // Process batches in parallel chunks with delays
  for (let i = 0; i < batches.length; i += parallelRequests) {
    const batchChunk = batches.slice(i, i + parallelRequests);

    const promises = batchChunk.map(async (batch, idx) => {
      const g_kentekenList = batch.map((v) => v.kenteken).join("','");

      const fuelUrl =
        `https://opendata.rdw.nl/resource/8ys7-d773.json?` +
        `$select=kenteken,brandstof_omschrijving&` +
        `$where=kenteken in ('${g_kentekenList}')&` +
        `$limit=${batchSize}`;

      try {
        const fuelData = await fetchJson(fuelUrl);
        return fuelData;
      } catch (error) {
        console.error(`  Error fetching batch ${i + idx}:`, error.message);
        // Retry once after a delay
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          return await fetchJson(fuelUrl);
        } catch {
          console.error(`  Retry failed for batch ${i + idx}`);
          failedBatches++;
          return [];
        }
      }
    });

    const results = await Promise.all(promises);

    // Aggregate results
    for (const fuelData of results) {
      if (!fuelData || !Array.isArray(fuelData)) continue;
      for (const record of fuelData) {
        const fuelType = mapFuelType(record.brandstof_omschrijving);
        fuelCounts[fuelType] = (fuelCounts[fuelType] || 0) + 1;
      }
    }

    // Progress indicator
    const processed = Math.min((i + parallelRequests) * batchSize, allVehicles.length);
    if (processed % 5000 === 0 || processed === allVehicles.length) {
      console.log(`  Processed ${processed}/${allVehicles.length} vehicles`);
    }

    // Small delay between parallel chunks to respect API limits
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  if (failedBatches > 0) {
    // Never persist a partial month: a failed batch means vehicles are
    // missing and the file would read as a market collapse (cf. 2026-02
    // persisted with 659 vehicles instead of ~25 000).
    throw new Error(`Incomplete RDW fetch for ${monthCode}: ${failedBatches} failed batches`);
  }

  return fuelCounts;
}

/**
 * Save monthly data to file.
 * Refuses implausible months instead of persisting them: legit NL months
 * are >= ~20 000 registrations, so anything below the floor is a partial
 * or broken extraction (cf. 2026-02/03 persisted with 659/1 vehicles).
 */
function saveMonthlyData(monthCode, fuelData) {
  const [year, month] = monthCode.split('-');
  const outputDir = path.join(process.cwd(), 'data/NL/ev');
  ensureDir(outputDir);

  const outputPath = path.join(outputDir, `${monthCode}.json`);

  // Transform fuel counts into the expected format
  const formattedData = [];

  for (const [energie, total] of Object.entries(fuelData)) {
    formattedData.push({
      marque: 'ALL',
      modele: 'ALL',
      total: total,
      energie: energie,
    });
  }

  const monthTotal = formattedData.reduce((sum, row) => sum + row.total, 0);
  if (monthTotal < 1000) {
    throw new Error(
      `Implausible NL data for ${monthCode}: monthly total is ${monthTotal} (< 1000). Refusing to persist.`
    );
  }

  const output = {
    year: parseInt(year),
    month: parseInt(month),
    sourceUrl: 'https://opendata.rdw.nl/resource/m9d7-ebf2.json',
    data: formattedData,
    region: 'NL',
    type: 'all',
  };

  validateMonthlyOutput(output);

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`  Saved: ${outputPath}`);
}

/**
 * Main function to fetch all EV data
 */
async function fetchAllEVData() {
  const allMonths = getMonthsSinceStart(2019);
  const outputDir = path.join(process.cwd(), 'data/NL/ev');
  const missingMonths = filterMissingMonths(allMonths, outputDir, (m) => `${m.code}.json`);

  console.log(`Total months in range: ${allMonths.length}`);
  console.log(`Missing months to fetch: ${missingMonths.length}`);

  if (missingMonths.length === 0) {
    console.log('All months already fetched!');
    return;
  }

  let successCount = 0;
  let errorCount = 0;

  for (const monthInfo of missingMonths) {
    try {
      const fuelData = await fetchMonthData(monthInfo.code);

      // Only save if we got meaningful data
      if (Object.keys(fuelData).length > 0) {
        saveMonthlyData(monthInfo.code, fuelData);
        successCount++;
      } else {
        console.log(`  No data found for ${monthInfo.code}, skipping save`);
        errorCount++;
      }

      // Add delay between months to respect API rate limits
      await new Promise((resolve) => setTimeout(resolve, 500));
    } catch (error) {
      console.error(`Error processing ${monthInfo.code}:`, error.message);
      errorCount++;
    }
  }

  console.log(`\nProcessing complete. ${successCount} new files saved, ${errorCount} errors.`);
}

// Export for use in other scripts
module.exports = {
  fetchAllEVData,
  fetchMonthData,
  saveMonthlyData,
  mapFuelType,
};
