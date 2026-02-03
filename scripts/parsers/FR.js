const fs = require('fs');
const path = require('path');
const { fetchFile } = require('../util');
const { JSDOM } = require('jsdom');
const xlsx = require('xlsx');

// Local fuel mapping for France; was previously in config/fuel_mapping.yaml
const FRENCH_FUEL_MAP = {
  DIESEL: [
    'Gazole (thermique)',
    'Diesel',
  ],
  GASOLINE: [
    'Essence (thermique)',
    'Essence',
  ],
  HYBRID: [
    'hybride gazole non rechargeable',
    'hybride essence non rechargeable',
    'gazole (y compris hybrides non rechargeables)',
    'essence (y compris hybrides non rechargeables)'
  ],
  PHEV: [
    'hybride rechargeable'
  ],
  BEV: [
    'Electrique',
    'Electric',
    'BEV',
  ],
  OTHER: [
    'Gaz & ND',
    'LPG',
    'CNG',
  ],
};

function normalizeFrenchFuel(label) {
  if (!label) return 'UNKNOWN';
  const clean = label.toString().trim().toLowerCase().replace(/\s+/g, ' ');
  let best = null;
  let bestLen = 0;

  for (const [code, aliases] of Object.entries(FRENCH_FUEL_MAP)) {
    for (const alias of aliases) {
      const aliasClean = alias.toLowerCase().replace(/\s+/g, ' ');
      if (clean === aliasClean) return code;
      if (clean.includes(aliasClean) && aliasClean.length > bestLen) {
        best = code;
        bestLen = aliasClean.length;
      }
    }
  }
  return best || 'OTHER';
}

function getFrenchMonthName(month) {
  const mois = ['janvier','fevrier','mars','avril','mai','juin','juillet','aout','septembre','octobre','novembre','decembre'];
  return mois[month-1];
}

async function findLatestPageUrl() {
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1;

  // Try going back up to 24 months (sometimes they are late or URL changes slightly)
  for (let i = 0; i < 24; i++) {
    const monthName = getFrenchMonthName(month);
    const url = `https://www.statistiques.developpement-durable.gouv.fr/motorisations-des-vehicules-legers-neufs-emissions-de-co2-et-bonus-ecologique-${monthName}-${year}`;
    
    try {
      console.log(`Vérification de l'URL : ${url}`);
      await fetchFile(url);
      console.log(`Trouvé !`);
      return url;
    } catch (e) {
      // Ignore 404, continue searching
    }

    month--;
    if (month === 0) {
      month = 12;
      year--;
    }
  }
  return null;
}

async function fetchAndProcessExcel() {
  const pageUrl = await findLatestPageUrl();
  if (!pageUrl) {
    console.error('Impossible de trouver une page de statistiques récente.');
    return;
  }

  const pageBuffer = await fetchFile(pageUrl);
  const dom = new JSDOM(pageBuffer.toString());
  const doc = dom.window.document;

  // Recherche du lien vers le fichier de données (Excel)
  const allLinks = Array.from(doc.querySelectorAll('a'))
    .map(a => ({ text: a.textContent.trim(), href: a.href }))
    .filter(l => l.href && (l.href.includes('/media/') || l.href.endsWith('.xlsx')) && (l.href.includes('/download') || l.href.includes('.xlsx')));
    
  // Heuristique : chercher "données" dans le texte, sinon prendre le premier qui ressemble à un téléchargement de données
  let target = allLinks.find(l => l.text.toLowerCase().includes('données')) || allLinks[0];

  if (!target) {
    console.error('Aucun lien de téléchargement Excel trouvé sur la page.');
    return;
  }

  let xlsxUrl = target.href;
  if (!xlsxUrl.startsWith('http')) {
    xlsxUrl = 'https://www.statistiques.developpement-durable.gouv.fr' + (xlsxUrl.startsWith('/') ? '' : '/') + xlsxUrl;
  }
  console.log(`Téléchargement du fichier Excel : ${xlsxUrl}`);

  const fileBuffer = await fetchFile(xlsxUrl);
  const workbook = xlsx.read(fileBuffer, { type: 'buffer' });

  // On suppose que les données sont dans la première feuille ou celle contenant '2025' par exemple
  // L'inspection a montré '2025_12' comme nom de feuille. On prend la première feuille qui contient des données.
  const sheetName = workbook.SheetNames[0];
  const ws = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1 });

  // Recherche de la ligne d'en-tête
  let headerIndex = -1;
  let colDate = -1;
  const colMapping = {}; // index -> normalizedFuelCode

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // On cherche une ligne qui contient "Gazole" ou "Essence" ou "Electrique"
    const hasFuelRef = row.some(c => c && typeof c === 'string' && (c.toLowerCase().includes('gazole') || c.toLowerCase().includes('essence') || c.toLowerCase().includes('electrique')));
    
    if (hasFuelRef) {
      headerIndex = i;
      // Identifier les colonnes
      for (let j = 0; j < row.length; j++) {
        const val = row[j];
        if (typeof val === 'string') {
          // Normalize column header
          const fuelCode = normalizeFrenchFuel(val)
          if (fuelCode !== 'OTHER' && fuelCode !== 'UNKNOWN') {
             colMapping[j] = fuelCode;
          }
        }
      }
      
      // On suppose que la date est en colonne 0 ("2011_01") si la colonne 0 n'est pas mappée comme un carburant
      if (!colMapping[0]) {
        colDate = 0;
      }
      break;
    }
  }

  if (headerIndex === -1) {
    console.error('Impossible de trouver les en-têtes (types de motorisation) dans le fichier Excel.');
    return;
  }

  console.log(`En-têtes trouvés ligne ${headerIndex}. Base date colonne ${colDate}.`);
  console.log('Colonnes identifiées :', JSON.stringify(colMapping));

  const outDir = path.join(__dirname, '../../data/FR/ev');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  let count = 0;
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (colDate === -1 || !row[colDate]) continue;

    const dateStr = row[colDate].toString().trim(); // Format attendu "YYYY_MM"
    if (!/^\d{4}_\d{2}$/.test(dateStr)) continue;

    const [yStr, mStr] = dateStr.split('_');
    const year = parseInt(yStr, 10);
    const month = parseInt(mStr, 10);

    // Agréger les valeurs par type de carburant normalisé
    const aggregated = {};
    for (const [colIdx, fuelCode] of Object.entries(colMapping)) {
      const val = parseInt(row[colIdx], 10) || 0;
      if (val > 0) {
        aggregated[fuelCode] = (aggregated[fuelCode] || 0) + val;
      }
    }

    const data = [];
    for (const [fuelCode, total] of Object.entries(aggregated)) {
      data.push({ 
        marque: 'Toutes marques', 
        modele: 'Tous modèles', 
        total, 
        energie: fuelCode // Code normalisé (ex: BEV, HYBRID, PHEV, DIESEL...)
      });
    }

    if (data.length > 0) {
      const outPath = path.join(outDir, `${year}-${mStr}.json`);
      if (fs.existsSync(outPath)) {
        // console.log(`Fichier existant ignoré : ${outPath}`);
        continue;
      }
      fs.writeFileSync(outPath, JSON.stringify({ year, month, data, region: 'FR', type: 'all' }, null, 2));
      count++;
    }
  }
  console.log(`Traitement terminé. ${count} fichiers générés/mis à jour dans ${outDir}`);
}

/**
 * Récupère toutes les données (historique complet via Excel)
 */
async function fetchAllEVData() {
  await fetchAndProcessExcel();
}

module.exports = {
  fetchAllEVData
};
