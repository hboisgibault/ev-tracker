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
 * Parse PDF and extract registration data using coordinate-based extraction
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
      
      // Find the row containing the country name
      for (const [y, items] of rowMap) {
        // Sort items by x-coordinate (left to right)
        items.sort((a, b) => a.x - b.x);
        
        const rowText = items.map(i => i.text).join(' ');
        
        // Check if this row contains the country name
        for (const name of countryVariations) {
          if (rowText.includes(name)) {
            // Verify this is a data row by checking if it has at least 4 numbers without +/-
            const numbersWithoutSign = items.filter(item => {
              const text = item.text;
              if (text.includes('+') || text.includes('-') || text.includes('%')) return false;
              const num = parseInt(text.replace(/,/g, ''), 10);
              return !isNaN(num) && num >= 0;
            });
            
            if (numbersWithoutSign.length >= 4) {
              console.log(`  Found ${name} in row at y=${y}`);
              console.log(`  Row items: ${items.map(i => i.text).join(' | ')}`);
              countryRow = items;
              break;
            }
          }
        }
        
        if (countryRow) break;
      }
      
      if (countryRow) break;
    }
    
    if (!countryRow) {
      throw new Error(`Country ${countryCode} not found in PDF`);
    }
    
    // Extract numbers from the row (skip the country name)
    // Filter to get only numbers (no percentages which contain + or - or decimals in display)
    const numbers = [];
    
    for (const item of countryRow) {
      const text = item.text;
      
      // Skip country name and non-numeric text
      if (countryVariations.some(name => text.includes(name))) continue;
      
      // Skip percentage signs and text with +/- (percentages)
      if (text.includes('%') || text.includes('+') || text.includes('-')) continue;
      
      // Skip dash characters used for missing data (en-dash U+2013, em-dash U+2014, etc.)
      // Also skip special Unicode dashes like ꟷ (U+A7F7)
      if (/^[–—−‐‑‒―⁃ꟷ]+$/.test(text)) continue;
      
      // Try to parse as number
      const num = parseInt(text.replace(/,/g, ''), 10);
      if (!isNaN(num) && num >= 0) {
        numbers.push(num);
      }
    }
    
    console.log(`  Extracted numbers from row: ${numbers.join(', ')}`);
    
    if (numbers.length < 6) {
      throw new Error(`Insufficient data points for ${countryCode} (found ${numbers.length}, need at least 6)`);
    }
    
    // ACEA table format (columns from left to right):
    // BEV_current | BEV_prev | PHEV_current | PHEV_prev | HEV_current | HEV_prev | 
    // Others_current | Others_prev | Petrol_current | Petrol_prev | Diesel_current | Diesel_prev | Total_current | Total_prev
    // We extract current values at positions: 0, 2, 4, 6, 8, 10
    // Note: When HYBRID has dashes (–), they're filtered out, so we need to handle missing values
    
    const result = [];
    
    // For May 2025+, ACEA uses dashes for missing hybrid data
    // Check if we have the expected number of values (14 with all data, 12 if hybrid is missing)
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
