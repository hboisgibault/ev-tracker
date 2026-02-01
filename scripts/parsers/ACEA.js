const fs = require('fs');
const path = require('path');
const { fetchFile, ensureDir, getMonthsSinceStart, filterMissingMonths } = require('../util');
const pdfjsLib = require('pdfjs-dist');

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
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 
                  'July', 'August', 'September', 'October', 'November', 'December'];
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
      return buffer;
    } catch (e) {
      // Try next URL pattern
    }
  }
  
  throw new Error(`Unable to fetch ACEA PDF for ${year}-${String(month).padStart(2, '0')}`);
}

/**
 * Parse PDF and extract registration data
 * Extracts the table with country-level registration data by fuel type
 * 
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @param {string} countryCode - ISO country code (e.g., 'FR', 'DE', 'ES')
 * @returns {Array} Array of data objects with fuel type and registration count
 */
async function parsePdfData(pdfBuffer, countryCode) {
  try {
    // Parse PDF using pdfjs-dist
    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(pdfBuffer),
      verbosity: 0 // Suppress warnings
    });
    
    const pdf = await loadingTask.promise;
    
    // Extract text from all pages
    let text = '';
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items.map(item => item.str).join(' ');
      text += pageText + ' ';
    }
    
    console.log(`  Extracted ${text.length} characters from PDF`);
    
    // Find country name variations
    const countryNames = {
      'FR': ['France', 'FRANCE'],
      'DE': ['Germany', 'GERMANY', 'Deutschland'],
      'ES': ['Spain', 'SPAIN', 'España', 'Espana'],
      'IT': ['Italy', 'ITALY', 'Italia'],
      'NL': ['Netherlands', 'NETHERLANDS', 'Nederland', 'The Netherlands'],
      'BE': ['Belgium', 'BELGIUM', 'Belgique', 'België'],
      'PT': ['Portugal', 'PORTUGAL'],
      'SE': ['Sweden', 'SWEDEN', 'Sverige'],
      'NO': ['Norway', 'NORWAY', 'Norge'],
      'PL': ['Poland', 'POLAND', 'Polska'],
      'AT': ['Austria', 'AUSTRIA', 'Österreich', 'Osterreich'],
      'DK': ['Denmark', 'DENMARK', 'Danmark'],
      'FI': ['Finland', 'FINLAND', 'Suomi'],
      'IE': ['Ireland', 'IRELAND'],
      'GR': ['Greece', 'GREECE'],
      'CZ': ['Czech Republic', 'CZECH REPUBLIC', 'Czechia'],
      'RO': ['Romania', 'ROMANIA'],
      'HU': ['Hungary', 'HUNGARY'],
      'SK': ['Slovakia', 'SLOVAKIA'],
      'BG': ['Bulgaria', 'BULGARIA'],
      'HR': ['Croatia', 'CROATIA'],
      'LT': ['Lithuania', 'LITHUANIA'],
      'LV': ['Latvia', 'LATVIA'],
      'EE': ['Estonia', 'ESTONIA'],
      'SI': ['Slovenia', 'SLOVENIA'],
    };
    
    const countryVariations = countryNames[countryCode] || [countryCode];
    
    // Find country in text
    let countryIndex = -1;
    for (const name of countryVariations) {
      const idx = text.indexOf(name);
      if (idx !== -1) {
        countryIndex = idx;
        console.log(`  Found ${name} at position ${idx}`);
        break;
      }
    }
    
    if (countryIndex === -1) {
      throw new Error(`Country ${countryCode} not found in PDF`);
    }
    
    // Extract a window of text around the country name (next 500 chars should have the data)
    const contextText = text.substring(countryIndex, countryIndex + 500);
    console.log(`  Context: ${contextText.substring(0, 200)}...`);
    
    // Extract ALL numbers including decimals and signs
    // Percentages always have decimals (.8, .0, etc.) even if they're whole numbers (+100.0)
    const numberPattern = /[+\-]?\s*\d{1,3}(?:,\d{3})*(?:\.\d+)?/g;
    const matches = contextText.match(numberPattern) || [];
    
    // Filter: keep only integers (no decimals) and remove +/- signs
    const numbers = matches
      .filter(m => !m.includes('.'))  // Remove percentages (they have decimals)
      .map(m => parseInt(m.replace(/[+\-,\s]/g, ''), 10))
      .filter(n => !isNaN(n));
    
    console.log(`  Extracted numbers: ${numbers.join(', ')}`);
    
    if (numbers.length < 12) {
      throw new Error(`Insufficient data points for ${countryCode} (found ${numbers.length}, need 12+)`);
    }
    
    // ACEA table format (columns from left to right):
    // BEV | BEV_prev | PHEV | PHEV_prev | HEV | HEV_prev | Others | Others_prev | Petrol | Petrol_prev | Diesel | Diesel_prev | Total | Total_prev
    // Each fuel type has 2 values: current year, previous year (decimal percentages are filtered out)
    // We extract current values at even positions: 0, 2, 4, 6, 8, 10
    
    const result = [];
    
    const bev = numbers[0] || 0;
    const phev = numbers[2] || 0;  
    const hybrid = numbers[4] || 0;
    const other = numbers[6] || 0;
    const gasoline = numbers[8] || 0;
    const diesel = numbers[10] || 0;
    
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
 * Map ACEA fuel type names to normalized codes
 */
function mapAceaFuelType(fuelName) {
  if (!fuelName || typeof fuelName !== 'string') return 'UNKNOWN';
  
  const normalized = fuelName.toLowerCase().trim();
  
  const mapping = {
    'electric': 'BEV',
    'bev': 'BEV',
    'battery electric': 'BEV',
    'plug-in hybrid': 'PHEV',
    'phev': 'PHEV',
    'hybrid electric': 'HYBRID',
    'hev': 'HYBRID',
    'hybrid': 'HYBRID',
    'diesel': 'DIESEL',
    'petrol': 'GASOLINE',
    'gasoline': 'GASOLINE',
    'lpg': 'LPG_CNG_OTHER',
    'cng': 'LPG_CNG_OTHER',
    'other': 'OTHER',
  };
  
  for (const [key, value] of Object.entries(mapping)) {
    if (normalized.includes(key)) {
      return value;
    }
  }
  
  return 'UNKNOWN';
}

/**
 * Process a single month of ACEA data for a specific country
 */
async function processAceaMonth(year, month, countryCode, outDir) {
  const monthCode = `${year}-${String(month).padStart(2, '0')}`;
  console.log(`Processing ACEA data for ${countryCode}: ${monthCode}`);
  
  try {
    // Fetch PDF
    const pdfBuffer = await fetchAceaPdf(year, month);
    
    // Parse data for the specified country
    const rawData = await parsePdfData(pdfBuffer, countryCode);
    
    // Format output
    const output = {
      year,
      month,
      data: rawData.map(item => ({
        marque: 'Toutes marques',
        modele: 'Tous modèles',
        total: item.total,
        energie: item.energie,
      })),
    };
    
    // Write to file
    const outputPath = path.join(outDir, `${monthCode}.json`);
    fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
    console.log(`  Saved to: ${outputPath}`);
    
  } catch (error) {
    console.error(`  Error: ${error.message}`);
  }
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
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  
  console.log('\n=== ACEA Parser completed ===\n');
}

// Export functions for use in collect.js
module.exports = {
  collectAceaData,
  collectAceaDataFR: () => collectAceaData('FR'),
  collectAceaDataDE: () => collectAceaData('DE'),
  collectAceaDataES: () => collectAceaData('ES'),
  collectAceaDataIT: () => collectAceaData('IT'),
  collectAceaDataNL: () => collectAceaData('NL'),
  collectAceaDataBE: () => collectAceaData('BE'),
  collectAceaDataPT: () => collectAceaData('PT'),
  collectAceaDataSE: () => collectAceaData('SE'),
  collectAceaDataNO: () => collectAceaData('NO'),
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
