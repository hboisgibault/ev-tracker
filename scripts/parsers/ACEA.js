const fs = require('fs');
const path = require('path');
const { fetchFile, ensureDir, getMonthsSinceStart, filterMissingMonths } = require('../util');
const { validateMonthlyOutput } = require('../schema');
// pdfjs-dist v6+ est ESM pur (main: build/pdf.mjs) : import dynamique obligatoire depuis CJS.

// Plausibility floor for one country's monthly total across all fuels.
// Legit ACEA months are >= ~1000 (EE/LV); the mid-2025 mis-parses (ES/IT)
// produced sums of 9-49. Anything below this is a broken extraction.
const MIN_MONTHLY_TOTAL = 200;

// ACEA releases with no monthly country x fuel table (cumulative Jan-Feb
// YTD only). Proven 2026-09-18: the February 2025 PDF holds YTD blocks per
// fuel plus a by-manufacturer table, so February 2025 cannot be extracted
// month by month. These months are skipped explicitly so one known gap does
// not abort the whole country loop (parse failures still throw elsewhere).
const YTD_ONLY_RELEASES = new Set(['2025-02']);

/**
 * ACEA (European Automobile Manufacturers Association) publishes monthly car registration data
 * in PDF format with different URL patterns.
 *
 * This parser extracts registration data by country and fuel type from these PDFs.
 */

/**
 * Generate possible PDF URLs for a given month
 * ACEA uses inconsistent URL patterns - format changed in 2025
 */
function getAceaPdfUrls(year, month) {
  const months = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
  ];
  const monthName = months[month - 1];

  const baseUrl = 'https://www.acea.auto/files/';

  // 2025+: Press_release_car_registrations_January_2025.pdf (underscore before month)
  // 2024: Press_release_car_registrations-January_2024.pdf (dash before month)
  return [
    `${baseUrl}Press_release_car_registrations_${monthName}_${year}.pdf`, // 2025+ format
    `${baseUrl}Press_release_car_registrations-${monthName}_${year}.pdf`, // 2024 format
    `${baseUrl}Press_release_car_registrations_${monthName}-${year}.pdf`,
    `${baseUrl}Press_release_car_registrations_${monthName}${year}.pdf`,
  ];
}

/**
 * Try to fetch PDF from multiple URL patterns
 */
async function fetchAceaPdf(year, month) {
  const urls = getAceaPdfUrls(year, month);

  for (const url of urls) {
    try {
      console.log(`  Trying: ${url}`);
      const buffer = await fetchFile(url);
      console.log(`  Success!`);
      return { buffer, url };
    } catch {
      // Try next URL pattern
    }
  }

  throw new Error(`Unable to fetch ACEA PDF for ${year}-${String(month).padStart(2, '0')}`);
}

/**
 * Extract positioned numbers from a country row's text items.
 * Pure function (no I/O) so the dash handling can be unit-tested.
 *
 * ACEA uses dashes (–, —, ꟷ, ...) for missing values in ANY fuel column
 * (e.g. Romania PHEV is a dash in 2026-01 while HEV holds 4642). Dropping
 * those items shifts every column behind them and swaps fuels (the RO/LV
 * PHEV<->HYBRID corruption). Dash-only tokens are therefore kept as 0
 * sentinels so fuel-column positions never move.
 *
 * @param {Array<{text: string}>} rowItems - left-to-right row items.
 * @param {Array<string>} countryVariations - country name variants to strip.
 * @returns {Array<number>} positioned numbers (percentages excluded).
 */
function rowNumbersFromItems(rowItems, countryVariations) {
  const numbers = [];

  for (const item of rowItems) {
    let text = item.text;

    // Skip percentage signs and text with +/- (percentages)
    if (text.includes('%') || text.includes('+') || text.includes('-')) continue;

    // Strip the country name: pdfjs sometimes fuses it with the first
    // number in a single item (e.g. "France 2500").
    for (const name of countryVariations) {
      text = text.split(name).join(' ');
    }

    // One item can hold several numbers when fused; parse token by token.
    for (const token of text.split(/\s+/)) {
      if (!token) continue;
      // Dash-only token = ACEA missing value: keep the position with a 0.
      // Also covers hyphen-minus so a fused "-"/"–" never shifts columns.
      if (/^[–—−‐‑‒―⁃ꟷ-]+$/.test(token)) {
        numbers.push(0);
        continue;
      }
      const num = parseInt(token.replace(/,/g, ''), 10);
      if (!isNaN(num) && num >= 0) {
        numbers.push(num);
      }
    }
  }

  return numbers;
}

/**
 * Tell a monthly data-table row apart from press-release prose.
 * Pure function (no I/O) so the discrimination can be unit-tested.
 *
 * Proven 2026-09-18 (April 2024 PDF): the sentence "...major markets:
 * Spain (+23.1%)..." matched "Spain" with 4 stray numbers (91, 3, 9, 95),
 * aborting the ES recollect. A real data row never carries prose markers
 * ('(', ')', '%') and holds 12-14 numeric items, so prose rows are rejected
 * and the numeric bar is set well above sentence fragments.
 *
 * @param {Array<{text: string}>} items - left-to-right row items.
 * @param {Array<string>} countryVariations - country name variants.
 * @returns {boolean} true when the row looks like a monthly data row.
 */
function isMonthlyDataRow(items, countryVariations) {
  const rowText = items.map((i) => i.text).join(' ');
  const mentionsCountry = countryVariations.some((name) => rowText.includes(name));
  if (!mentionsCountry) return false;
  // Press prose carries percentages / parenthesized variations; data rows
  // show bare values (change columns render as "-16.3", never "(...)").
  if (items.some((item) => /[()%]/.test(item.text))) return false;
  const numbersWithoutSign = items.filter((item) => {
    const text = item.text;
    if (text.includes('+') || text.includes('-') || text.includes('%')) return false;
    const num = parseInt(text.replace(/,/g, ''), 10);
    return !isNaN(num) && num >= 0;
  });
  return numbersWithoutSign.length >= 8;
}

/**
 * Parse PDF and extract registration data using coordinate-based extraction
 * Extracts the table with country-level registration data by fuel type
 *
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @param {string} countryCode - ISO country code (e.g., 'FR', 'DE', 'ES')
 * @returns {Array} Array of data objects with fuel type and registration count
 */
async function parsePdfData(pdfBuffer, countryCode) {
  try {
    // Parse PDF using pdfjs-dist (import dynamique : v6 ESM pur, build legacy requis en Node)
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(pdfBuffer),
      verbosity: 0, // Suppress warnings
    });

    const pdf = await loadingTask.promise;

    // Find country name variations
    const countryNames = {
      FR: ['France', 'FRANCE'],
      DE: ['Germany', 'GERMANY', 'Deutschland'],
      ES: ['Spain', 'SPAIN', 'España', 'Espana'],
      IT: ['Italy', 'ITALY', 'Italia'],
      NL: ['Netherlands', 'NETHERLANDS', 'Nederland', 'The Netherlands'],
      BE: ['Belgium', 'BELGIUM', 'Belgique', 'België'],
      PT: ['Portugal', 'PORTUGAL'],
      SE: ['Sweden', 'SWEDEN', 'Sverige'],
      NO: ['Norway', 'NORWAY', 'Norge'],
      PL: ['Poland', 'POLAND', 'Polska'],
      AT: ['Austria', 'AUSTRIA', 'Österreich', 'Osterreich'],
      DK: ['Denmark', 'DENMARK', 'Danmark'],
      FI: ['Finland', 'FINLAND', 'Suomi'],
      IE: ['Ireland', 'IRELAND'],
      GR: ['Greece', 'GREECE'],
      CZ: ['Czech Republic', 'CZECH REPUBLIC', 'Czechia'],
      RO: ['Romania', 'ROMANIA'],
      HU: ['Hungary', 'HUNGARY'],
      SK: ['Slovakia', 'SLOVAKIA'],
      BG: ['Bulgaria', 'BULGARIA'],
      HR: ['Croatia', 'CROATIA'],
      LT: ['Lithuania', 'LITHUANIA'],
      LV: ['Latvia', 'LATVIA'],
      EE: ['Estonia', 'ESTONIA'],
      SI: ['Slovenia', 'SLOVENIA'],
    };

    const countryVariations = countryNames[countryCode] || [countryCode];

    // Extract text with coordinates from all pages
    let countryRow = null;

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();

      // Group text items by y-coordinate (row) - items on same row have similar y values
      const rowMap = new Map();

      for (const item of textContent.items) {
        const text = item.str.trim();
        if (!text) continue;

        const y = Math.round(item.transform[5]); // y-coordinate

        if (!rowMap.has(y)) {
          rowMap.set(y, []);
        }

        rowMap.get(y).push({
          text: text,
          x: item.transform[4], // x-coordinate
        });
      }

      // Find the row containing the country name (data table, not prose)
      for (const [y, items] of rowMap) {
        // Sort items by x-coordinate (left to right)
        items.sort((a, b) => a.x - b.x);

        if (isMonthlyDataRow(items, countryVariations)) {
          const name = countryVariations.find((n) =>
            items
              .map((i) => i.text)
              .join(' ')
              .includes(n)
          );
          console.log(`  Found ${name} in row at y=${y}`);
          console.log(`  Row items: ${items.map((i) => i.text).join(' | ')}`);
          countryRow = items;
          break;
        }
      }

      if (countryRow) break;
    }

    if (!countryRow) {
      throw new Error(`Country ${countryCode} not found in PDF`);
    }

    // Extract positioned numbers from the row (dashes kept as 0 sentinels).
    const numbers = rowNumbersFromItems(countryRow, countryVariations);

    console.log(`  Extracted numbers from row: ${numbers.join(', ')}`);

    if (numbers.length < 6) {
      throw new Error(
        `Insufficient data points for ${countryCode} (found ${numbers.length}, need at least 6)`
      );
    }

    // ACEA table format (columns from left to right):
    // BEV_current | BEV_prev | PHEV_current | PHEV_prev | HEV_current | HEV_prev |
    // Others_current | Others_prev | Petrol_current | Petrol_prev | Diesel_current | Diesel_prev | Total_current | Total_prev
    // We extract current values at positions: 0, 2, 4, 6, 8, 10.
    // Missing values are dash sentinels (0) at their own position, so the
    // normal indexing below holds whatever the column layout is.

    const result = [];

    // Legacy fallback: rows shorter than 14 numbers predate dash sentinels;
    // assume the missing column is HEV (historical ACEA layout change).
    const hasHybridData = numbers.length >= 14;

    let bev, phev, hybrid, other, gasoline, diesel;

    if (hasHybridData) {
      // Normal case: all 6 fuel types with current + previous values
      bev = numbers[0] || 0;
      phev = numbers[2] || 0;
      hybrid = numbers[4] || 0;
      other = numbers[6] || 0;
      gasoline = numbers[8] || 0;
      diesel = numbers[10] || 0;
    } else {
      // Hybrid data missing (dashes filtered out): only 12 numbers instead of 14
      bev = numbers[0] || 0;
      phev = numbers[2] || 0;
      hybrid = 0; // No hybrid data reported
      other = numbers[4] || 0;
      gasoline = numbers[6] || 0;
      diesel = numbers[8] || 0;
    }

    result.push({ energie: 'BEV', total: bev });
    result.push({ energie: 'PHEV', total: phev });
    result.push({ energie: 'HYBRID', total: hybrid });
    result.push({ energie: 'DIESEL', total: diesel });
    result.push({ energie: 'GASOLINE', total: gasoline });
    result.push({ energie: 'OTHER', total: other });

    return result;
  } catch (error) {
    console.error(`  Error parsing PDF: ${error.message}`);
    throw error;
  }
}

/**
 * Reject implausible extractions (e.g. percentage fragments parsed as volumes).
 * @throws {Error} when the extracted totals are not plausible.
 */
function assertPlausibleAceaData(rawData, countryCode) {
  const sum = rawData.reduce((acc, item) => acc + item.total, 0);
  if (sum < MIN_MONTHLY_TOTAL) {
    throw new Error(
      `Implausible ACEA data for ${countryCode}: monthly total is ${sum} (< ${MIN_MONTHLY_TOTAL}). ` +
        `The PDF layout probably changed; refusing to persist.`
    );
  }
}

/**
 * Process a single month of ACEA data for a specific country.
 * A missing PDF (not yet published) is skipped with a warning.
 * Any parse, plausibility or schema failure is rethrown so the
 * collect workflow fails visibly instead of persisting garbage.
 */
async function processAceaMonth(year, month, countryCode, outDir) {
  const monthCode = `${year}-${String(month).padStart(2, '0')}`;
  if (YTD_ONLY_RELEASES.has(monthCode)) {
    console.warn(`  Skipping ${monthCode}: known YTD-only ACEA release (no monthly table)`);
    return 'skipped';
  }
  console.log(`Processing ACEA data for ${countryCode}: ${monthCode}`);

  let pdfBuffer;
  let sourceUrl;
  try {
    ({ buffer: pdfBuffer, url: sourceUrl } = await fetchAceaPdf(year, month));
  } catch (error) {
    console.warn(`  Skipping ${monthCode}: ${error.message}`);
    return 'skipped';
  }

  // Parse data for the specified country (throws on layout change)
  const rawData = await parsePdfData(pdfBuffer, countryCode);

  // Plausibility guard (throws on percentage-fragment mis-parses)
  assertPlausibleAceaData(rawData, countryCode);

  // Format output
  const output = {
    year,
    month,
    sourceUrl,
    data: rawData.map((item) => ({
      marque: 'Toutes marques',
      modele: 'Tous modèles',
      total: item.total,
      energie: item.energie,
    })),
  };

  // Schema validation (throws on invalid output)
  validateMonthlyOutput(output);

  // Write to file
  const outputPath = path.join(outDir, `${monthCode}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`  Saved to: ${outputPath}`);
  return 'ok';
}

/**
 * Main function to collect ACEA data for a country
 *
 * @param {string} countryCode - ISO country code (e.g., 'FR', 'DE', 'ES')
 * @param {number} startYear - Year to start collecting data from (default: 2024)
 */
async function collectAceaData(countryCode = 'FR', startYear = 2024) {
  console.log(`\n=== ACEA Parser for ${countryCode} ===\n`);

  const outDir = path.join(__dirname, '../../data', countryCode, 'ev');
  ensureDir(outDir);

  // Get all months since start year
  const allMonths = getMonthsSinceStart(startYear);

  // Filter out months that already have data
  const missingMonths = filterMissingMonths(allMonths, outDir);

  if (missingMonths.length === 0) {
    console.log('All months already processed!');
    return;
  }

  console.log(`Found ${missingMonths.length} months to process\n`);

  // Process each missing month
  for (const m of missingMonths) {
    await processAceaMonth(m.year, m.month, countryCode, outDir);
    // Add a small delay to avoid overwhelming the server
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log('\n=== ACEA Parser completed ===\n');
}

// Export functions for use in collect.js (and unit tests)
module.exports = {
  collectAceaData,
  rowNumbersFromItems,
  isMonthlyDataRow,
  parsePdfData,
  getAceaPdfUrls,
  assertPlausibleAceaData,
  MIN_MONTHLY_TOTAL,
  YTD_ONLY_RELEASES,
  collectAceaDataES: () => collectAceaData('ES'),
  collectAceaDataIT: () => collectAceaData('IT'),
  collectAceaDataBE: () => collectAceaData('BE'),
  collectAceaDataPT: () => collectAceaData('PT'),
  collectAceaDataPL: () => collectAceaData('PL'),
  collectAceaDataAT: () => collectAceaData('AT'),
  collectAceaDataDK: () => collectAceaData('DK'),
  collectAceaDataFI: () => collectAceaData('FI'),
  collectAceaDataIE: () => collectAceaData('IE'),
  collectAceaDataGR: () => collectAceaData('GR'),
  collectAceaDataCZ: () => collectAceaData('CZ'),
  collectAceaDataRO: () => collectAceaData('RO'),
  collectAceaDataHU: () => collectAceaData('HU'),
  collectAceaDataSK: () => collectAceaData('SK'),
  collectAceaDataBG: () => collectAceaData('BG'),
  collectAceaDataHR: () => collectAceaData('HR'),
  collectAceaDataLT: () => collectAceaData('LT'),
  collectAceaDataLV: () => collectAceaData('LV'),
  collectAceaDataEE: () => collectAceaData('EE'),
  collectAceaDataSI: () => collectAceaData('SI'),
};
