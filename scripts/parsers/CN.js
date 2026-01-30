const fs = require('fs');
const path = require('path');
const { fetchFile } = require('../util');
const { JSDOM } = require('jsdom');
const xlsx = require('xlsx');

// Mapping chinois pour les types de motorisation
const CHINESE_FUEL_MAP = {
  BEV: ['纯电动', '纯电动汽车', 'BEV'],
  PHEV: ['插电式混合动力', '插电式混合动力汽车', 'PHEV'],
  FCEV: ['燃料电池', '燃料电池汽车', 'FCEV'],
  HYBRID: ['混合动力', 'HEV'],
  GASOLINE: ['汽油', '汽油车'],
  DIESEL: ['柴油', '柴油车'],
};

function normalizeChineseFuel(label) {
  if (!label) return 'UNKNOWN';
  const clean = label.toString().trim();
  for (const [code, aliases] of Object.entries(CHINESE_FUEL_MAP)) {
    for (const alias of aliases) {
      if (clean.includes(alias)) return code;
    }
  }
  return 'OTHER';
}

/**
 * Trouve les données CAAM via CnEVPost (source relayée plus accessible)
 * Scrape les articles mensuels qui contiennent les chiffres officiels CAAM
 * @param {Set<string>} existingFiles - Ensemble des fichiers déjà existants (format: "2025-01")
 */
async function findLatestDataFromCnEVPost(existingFiles = new Set()) {
  const baseUrl = 'https://cnevpost.com';
  
  console.log(`Recherche des données CAAM via CnEVPost`);
  
  try {
    const allArticles = [];
    
    // Scraper plusieurs pages pour obtenir plus d'historique
    // Page 1 = 2025, Page 2 = fin 2024, Page 3 = mi-2024, etc.
    for (let page = 1; page <= 5; page++) {
      const listUrl = page === 1 ? 'https://cnevpost.com/tag/caam/' : `https://cnevpost.com/tag/caam/page/${page}/`;
      console.log(`Scraping page ${page}: ${listUrl}`);
      
      try {
        const pageBuffer = await fetchFile(listUrl);
        const dom = new JSDOM(pageBuffer.toString());
        const doc = dom.window.document;
        
        // Recherche les articles contenant les statistiques mensuelles
        // Format typique: "China NEV sales ... in [Month], CAAM data show"
        //             ou: "China NEV sales total 1.71 million units in Dec"
        const pageArticles = Array.from(doc.querySelectorAll('a'))
          .filter(a => {
            const text = a.textContent.trim().toLowerCase();
            const hasNEV = text.includes('nev sales') || text.includes('china nev');
            const hasData = text.includes('caam') || text.includes('data') || text.includes('million');
            const hasMonth = /(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)/i.test(text);
            return hasNEV && hasData && hasMonth;
          });
        
        allArticles.push(...pageArticles);
        
        // Si on trouve moins de 3 articles sur une page, on arrête (probablement plus de contenu pertinent)
        if (pageArticles.length < 3) break;
      } catch (e) {
        console.log(`Erreur page ${page}: ${e.message}`);
        break;
      }
    }
    
    console.log(`${allArticles.length} articles trouvés`);
    const articles = allArticles.slice(0, 50); // On prend jusqu'à 50 articles pour couvrir ~4 ans
    
    // Mapping des mois pour extraction rapide
    const monthNames = {
      'jan': 1, 'january': 1,
      'feb': 2, 'february': 2,
      'mar': 3, 'march': 3,
      'apr': 4, 'april': 4,
      'may': 5,
      'jun': 6, 'june': 6,
      'jul': 7, 'july': 7,
      'aug': 8, 'august': 8,
      'sep': 9, 'sept': 9, 'september': 9,
      'oct': 10, 'october': 10,
      'nov': 11, 'november': 11,
      'dec': 12, 'december': 12
    };
    
    const monthlyData = [];
    
    for (const article of articles) {
      let articleUrl = article.href;
      if (!articleUrl.startsWith('http')) {
        articleUrl = baseUrl + (articleUrl.startsWith('/') ? '' : '/') + articleUrl;
      }
      
      // Extraction rapide du mois/année depuis l'URL AVANT de lire l'article
      // Format URL: /2025/12/11/china-nev-sales-nov-2025-caam/
      //         ou: /2026/01/14/china-nev-sales-1-71-million-dec-2025-caam/
      const urlMonthMatch = articleUrl.match(/-(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)-(\d{4})-/i) ||
                           articleUrl.match(/-(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)-(\d{4})\//i);
      const urlYearMatch = articleUrl.match(/\/(\d{4})\/\d{2}\/\d{2}\//);
      
      if (urlMonthMatch && urlYearMatch) {
        const monthStr = urlMonthMatch[1].toLowerCase();
        const month = monthNames[monthStr] || monthNames[monthStr.substring(0, 3)];
        let year = parseInt(urlMonthMatch[2], 10);
        
        // Correction pour décembre publié en janvier
        if (month === 12 && urlYearMatch) {
          const pubYear = parseInt(urlYearMatch[1], 10);
          if (pubYear > year || (pubYear === year + 1 && new Date().getMonth() === 0)) {
            year = pubYear - 1;
          }
        }
        
        const fileName = `${year}-${String(month).padStart(2, '0')}`;
        
        // Vérifier si ce fichier existe déjà AVANT de lire l'article
        if (existingFiles.has(fileName)) {
          console.log(`  Article ${fileName} ignoré (fichier existe)`);
          continue; // SKIP cet article
        }
      }
      
      console.log(`Lecture de l'article : ${articleUrl}`);
      
      try {
        const articleBuffer = await fetchFile(articleUrl);
        const articleDom = new JSDOM(articleBuffer.toString());
        const articleDoc = articleDom.window.document;
        const articleText = articleDoc.body.textContent;
        
        // Extraction du mois et de l'année depuis l'URL ou le titre
        // Format URL: /2025/12/11/china-nev-sales-nov-2025-caam/
        const urlMatch = articleUrl.match(/\/(\d{4})\/\d{2}\/\d{2}\//);
        const titleMatch = article.textContent.match(/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)[a-z]*\s*(?:,\s*)?(?:with\s+)?(?:BEVs\s+)?[,\s]*(?:CAAM)?/i);
        
        let year = null;
        let month = null;
        
        // D'abord essayer d'extraire depuis l'URL du type ".../china-nev-sales-nov-2025-caam/" ou "...-dec-2025-caam/"
        const urlMonthMatch2 = articleUrl.match(/-(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)-(\d{4})-/i);
        if (urlMonthMatch2) {
          const monthStr = urlMonthMatch2[1].toLowerCase();
          month = monthNames[monthStr] || monthNames[monthStr.substring(0, 3)];
          year = parseInt(urlMonthMatch2[2], 10);
        }
        
        // Sinon extraction du mois depuis le titre
        if (!month && titleMatch) {
          const monthStr = titleMatch[1].toLowerCase();
          month = monthNames[monthStr] || monthNames[monthStr.substring(0, 3)];
        }
        
        // Année depuis l'URL si pas encore trouvée
        if (!year) {
          year = urlMatch ? parseInt(urlMatch[1], 10) : new Date().getFullYear();
          // Si l'article est publié en janvier mais parle de décembre, c'est l'année précédente
          if (month === 12 && year === new Date().getFullYear() && new Date().getMonth() === 0) {
            year--;
          }
        }
        
        if (!month) continue;
        
        // Extraction des chiffres NEV, BEV, PHEV
        // Formats variés:
        // - "NEV sales reached 1,307,000 units"
        // - "NEV sales came in at 1.71 million units"
        // - "BEV sales rose ... to 850,000"
        const nevMatch = articleText.match(/NEV sales[^\d]*?([\d,]+(?:\.\d+)?)[,\s]*(?:000)?\s*(?:million\s+)?units/i);
        const bevMatch = articleText.match(/BEV sales[^\d]*?([\d,]+)[,\s]*(?:000)?\s*units/i);
        const phevMatch = articleText.match(/PHEV sales[^\d]*?([\d,]+)[,\s]*(?:000)?\s*units/i);
        
        // Extraction des ventes totales de véhicules (passenger vehicles)
        // Formats variés trouvés dans les articles:
        // - "Total vehicle sales in November were 3.429 million units"
        // - "Total vehicle sales for the month were 2.593 million units"
        // - "China's passenger vehicle sales in February totaled 1.395 million units"
        // - "Overall auto sales reached 3.2 million"
        // - "China's all vehicle sales in August were 2,453,000 units"
        const totalMatch = 
          articleText.match(/(?:all|total|overall)\s+(?:vehicle|auto|passenger vehicle)\s+sales[^\d]*?([\d,]+(?:\.\d+)?)\s*(?:million\s+)?units/i) ||
          articleText.match(/(?:vehicle|auto|passenger vehicle)\s+sales[^\d]*?(?:totaled|reached|were|hit|stood at)[^\d]*?([\d,]+(?:\.\d+)?)\s*(?:million\s+)?units/i) ||
          articleText.match(/(?:China's|Chinese)\s+(?:all |total |overall |)(?:vehicle|auto|passenger vehicle)\s+sales[^\d]*?([\d,]+(?:\.\d+)?)\s*(?:million\s+)?units/i);
        
        const parseNumber = (str) => {
          if (!str) return null;
          const cleaned = str.replace(/,/g, '');
          const num = parseFloat(cleaned);
          // Si le nombre est < 10000, c'est probablement en milliers (format "1,307" = 1307000)
          // ou en millions (format "1.71" avec "million" dans le match)
          return num < 10000 ? Math.round(num * 1000) : num;
        };
        
        // Parser spécial pour les formats en millions (e.g., "1.71 million")
        const parseMillions = (match) => {
          if (!match) return null;
          const str = match[0];
          if (str.includes('million')) {
            const num = parseFloat(match[1].replace(/,/g, ''));
            return Math.round(num * 1000000);
          }
          return parseNumber(match[1]);
        };
        
        const nevTotal = nevMatch ? parseMillions(nevMatch) : null;
        const bevTotal = bevMatch ? parseNumber(bevMatch[1]) : null;
        const phevTotal = phevMatch ? parseNumber(phevMatch[1]) : null;
        let totalVehicles = totalMatch ? parseMillions(totalMatch) : null;
        
        // Si on n'a pas trouvé le total mais qu'on a NEV, on peut estimer le total
        // En Chine, les NEV représentent environ 35-45% des ventes selon les mois
        // On peut utiliser un ratio conservateur pour estimer
        if (!totalVehicles && nevTotal && nevTotal > 500000) {
          // Ratio moyen NEV/Total observé en 2024-2025: ~40%
          totalVehicles = Math.round(nevTotal / 0.40);
          console.log(`  Estimation du total à partir de NEV (${nevTotal}) : ${totalVehicles}`);
        }
        
        if (nevTotal || bevTotal || phevTotal) {
          monthlyData.push({
            year,
            month,
            NEV: nevTotal,
            BEV: bevTotal,
            PHEV: phevTotal,
            TOTAL: totalVehicles
          });
          console.log(`Données extraites : ${year}-${String(month).padStart(2, '0')} - Total: ${totalVehicles}, NEV: ${nevTotal}, BEV: ${bevTotal}, PHEV: ${phevTotal}`);
        }
      } catch (e) {
        console.log(`Erreur lors de la lecture de l'article : ${e.message}`);
        continue;
      }
    }
    
    return monthlyData;
  } catch (e) {
    console.error(`Erreur lors de l'accès à CnEVPost : ${e.message}`);
    return [];
  }
}

/**
 * Trouve l'URL du dernier fichier Excel disponible sur le site de la CAAM
 * Note: Le site CAAM a une protection stricte. Si l'accès automatique échoue,
 * vous pouvez fournir manuellement l'URL du fichier Excel en appelant fetchAllEVData(url).
 * 
 * Sources alternatives pour trouver les données CAAM :
 * - https://www.marklines.com/en/statistics/flash_sales/salesfig_china_2023
 * - https://cnevpost.com/tag/caam/ (souvent relaie les chiffres CAAM)
 * - Archives sur archive.org du site CAAM
 */
async function findLatestExcelUrl() {
  const baseUrl = 'https://www.caam.org.cn';
  const listUrl = 'https://www.caam.org.cn/chn/4/cate_31/list_1.html';
  
  console.log(`Recherche du dernier fichier Excel sur ${listUrl}`);
  
  try {
    const pageBuffer = await fetchFile(listUrl);
    const dom = new JSDOM(pageBuffer.toString());
    const doc = dom.window.document;
    
    // Recherche tous les liens sur la page
    const allLinks = Array.from(doc.querySelectorAll('a'))
      .map(a => ({
        text: a.textContent.trim(),
        href: a.href
      }))
      .filter(l => l.href);
    
    // On cherche les liens vers les articles de statistiques mensuelles
    // Format typique : /chn/4/cate_31/con_5_XXXXX.html
    const articleLinks = allLinks
      .filter(l => l.href.includes('/chn/4/cate_31/con_5_'))
      .slice(0, 10); // On prend les 10 premiers articles (les plus récents)
    
    // Pour chaque article, on va chercher le lien Excel
    for (const article of articleLinks) {
      let articleUrl = article.href;
      if (!articleUrl.startsWith('http')) {
        articleUrl = baseUrl + (articleUrl.startsWith('/') ? '' : '/') + articleUrl;
      }
      
      console.log(`Vérification de l'article : ${articleUrl}`);
      
      try {
        const articleBuffer = await fetchFile(articleUrl);
        const articleDom = new JSDOM(articleBuffer.toString());
        const articleDoc = articleDom.window.document;
        
        // Recherche des liens vers des fichiers Excel
        const excelLinks = Array.from(articleDoc.querySelectorAll('a'))
          .map(a => ({
            text: a.textContent.trim(),
            href: a.href
          }))
          .filter(l => l.href && (
            l.href.endsWith('.xlsx') || 
            l.href.endsWith('.xls') ||
            l.href.includes('.xlsx') ||
            l.href.includes('.xls')
          ));
        
        if (excelLinks.length > 0) {
          let excelUrl = excelLinks[0].href;
          if (!excelUrl.startsWith('http')) {
            excelUrl = baseUrl + (excelUrl.startsWith('/') ? '' : '/') + excelUrl;
          }
          console.log(`Fichier Excel trouvé : ${excelUrl}`);
          return excelUrl;
        }
      } catch (e) {
        console.log(`Erreur lors de la lecture de l'article : ${e.message}`);
        continue;
      }
    }
    
    console.error('Aucun fichier Excel trouvé dans les derniers articles.');
    return null;
  } catch (e) {
    console.error(`Erreur lors de l'accès à la page de la CAAM : ${e.message}`);
    return null;
  }
}

/**
 * Récupère l'URL du dernier rapport Excel sur le site de la CAAM
 * Nécessite une inspection manuelle ou automatisée du HTML (en chinois)
 * Ici, on suppose que l'utilisateur fournit l'URL du fichier Excel à traiter
 */
async function fetchAndProcessExcel(xlsxUrl) {
  if (!xlsxUrl) {
    console.log('URL non fournie, recherche automatique du dernier fichier...');
    xlsxUrl = await findLatestExcelUrl();
    if (!xlsxUrl) {
      console.error('Impossible de trouver automatiquement un fichier Excel.');
      return;
    }
  }
  console.log(`Téléchargement du fichier Excel : ${xlsxUrl}`);
  const fileBuffer = await fetchFile(xlsxUrl);
  const workbook = xlsx.read(fileBuffer, { type: 'buffer' });

  // On suppose que la première feuille contient les données principales
  const sheetName = workbook.SheetNames[0];
  const ws = workbook.Sheets[sheetName];
  const rows = xlsx.utils.sheet_to_json(ws, { header: 1 });

  // Recherche de la ligne d'en-tête
  let headerIndex = -1;
  let colDate = -1;
  const colMapping = {}; // index -> normalizedFuelCode

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    // On cherche une ligne qui contient un type de motorisation connu
    const hasFuelRef = row.some(c => c && typeof c === 'string' && normalizeChineseFuel(c) !== 'OTHER' && normalizeChineseFuel(c) !== 'UNKNOWN');
    if (hasFuelRef) {
      headerIndex = i;
      for (let j = 0; j < row.length; j++) {
        const val = row[j];
        if (typeof val === 'string') {
          const fuelCode = normalizeChineseFuel(val);
          if (fuelCode !== 'OTHER' && fuelCode !== 'UNKNOWN') {
            colMapping[j] = fuelCode;
          }
        }
      }
      // On suppose que la date/mois est en colonne 0
      if (!colMapping[0]) colDate = 0;
      break;
    }
  }

  if (headerIndex === -1) {
    console.error('Impossible de trouver les en-têtes (types de motorisation) dans le fichier Excel.');
    return;
  }

  console.log(`En-têtes trouvés ligne ${headerIndex}. Base date colonne ${colDate}.`);
  console.log('Colonnes identifiées :', JSON.stringify(colMapping));

  const outDir = path.join(__dirname, '../../data/CN/ev');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  let count = 0;
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (colDate === -1 || !row[colDate]) continue;
    const dateStr = row[colDate].toString().trim(); // Format attendu "YYYY-MM" ou "YYYY/MM"
    if (!/^\d{4}[-\/]\d{2}$/.test(dateStr)) continue;
    const [yStr, mStr] = dateStr.split(/[-\/]/);
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
        marque: '所有品牌',
        modele: '所有车型',
        total,
        energie: fuelCode
      });
    }
    if (data.length > 0) {
      const outPath = path.join(outDir, `${year}-${mStr}.json`);
      if (fs.existsSync(outPath)) continue;
      fs.writeFileSync(outPath, JSON.stringify({ year, month, data, region: 'CN', type: 'all' }, null, 2));
      count++;
    }
  }
  console.log(`Traitement terminé. ${count} fichiers générés/mis à jour dans ${outDir}`);
}

/**
 * Récupère toutes les données (historique complet via Excel)
 * Nécessite l'URL du fichier Excel CAAM à traiter
 */
async function fetchAllEVData(xlsxUrl) {
  // Si aucune URL n'est fournie, on utilise CnEVPost comme source alternative
  if (!xlsxUrl) {
    console.log('Récupération des données via CnEVPost (source alternative)...');
    
    // Vérifier quels fichiers existent déjà pour éviter le traitement inutile
    const outDir = path.join(__dirname, '../../data/CN/ev');
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    
    const existingFiles = fs.readdirSync(outDir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.replace('.json', ''));
    
    console.log(`Fichiers existants : ${existingFiles.length} mois déjà collectés`);
    
    // Convertir en Set pour recherche O(1)
    const existingFilesSet = new Set(existingFiles);
    
    // Vérifier si on a besoin de scraper
    // On scrape seulement si les 2 derniers mois n'existent pas tous les deux
    const now = new Date();
    const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const lastMonth = now.getMonth() === 0 
      ? `${now.getFullYear() - 1}-12`
      : `${now.getFullYear()}-${String(now.getMonth()).padStart(2, '0')}`;
    
    const twoMonthsAgo = now.getMonth() <= 1
      ? `${now.getFullYear() - 1}-${String(12 + now.getMonth() - 1).padStart(2, '0')}`
      : `${now.getFullYear()}-${String(now.getMonth() - 1).padStart(2, '0')}`;
    
    if (existingFilesSet.has(currentMonth) && existingFilesSet.has(lastMonth) && existingFilesSet.has(twoMonthsAgo)) {
      console.log('Les données récentes sont à jour (3 derniers mois présents). Aucun scraping nécessaire.');
      return;
    }
    
    const monthlyData = await findLatestDataFromCnEVPost(existingFilesSet);
    
    if (monthlyData.length === 0) {
      console.error('Aucune donnée trouvée via CnEVPost.');
      return;
    }
    
    // Filtrer les mois déjà existants AVANT tout traitement
    const newMonthlyData = monthlyData.filter(item => {
      const mStr = String(item.month).padStart(2, '0');
      const fileName = `${item.year}-${mStr}`;
      const exists = existingFiles.includes(fileName);
      if (exists) {
        console.log(`Mois ${fileName} déjà collecté, ignoré`);
      }
      return !exists;
    });
    
    if (newMonthlyData.length === 0) {
      console.log('Tous les mois disponibles sont déjà collectés.');
      return;
    }
    
    console.log(`${newMonthlyData.length} nouveaux mois à traiter`);
    
    let count = 0;
    for (const item of newMonthlyData) {
      const { year, month, NEV, BEV, PHEV, TOTAL } = item;
      const mStr = String(month).padStart(2, '0');
      const outPath = path.join(outDir, `${year}-${mStr}.json`);
      
      const data = [];
      if (BEV) {
        data.push({
          marque: '所有品牌',
          modele: '所有车型',
          total: BEV,
          energie: 'BEV'
        });
      }
      if (PHEV) {
        data.push({
          marque: '所有品牌',
          modele: '所有车型',
          total: PHEV,
          energie: 'PHEV'
        });
      }
      
      // Calcul des ventes ICE (véhicules thermiques) = Total - NEV
      if (TOTAL && NEV && TOTAL > NEV) {
        const iceTotal = TOTAL - NEV;
        // On utilise FOSSIL car les données CAAM ne distinguent pas essence et diesel
        
        data.push({
          marque: '所有品牌',
          modele: '所有车型',
          total: iceTotal,
          energie: 'FOSSIL'
        });
      }
      
      // Si on a NEV mais pas BEV/PHEV séparés, on met tout en BEV par défaut
      if (NEV && !BEV && !PHEV) {
        data.push({
          marque: '所有品牌',
          modele: '所有车型',
          total: NEV,
          energie: 'BEV'
        });
      }
      
      if (data.length > 0) {
        fs.writeFileSync(outPath, JSON.stringify({ year, month, data, region: 'CN', type: 'all' }, null, 2));
        console.log(`Fichier créé : ${outPath}`);
        count++;
      }
    }
    
    console.log(`Traitement terminé. ${count} fichiers générés/mis à jour dans ${outDir}`);
    return;
  }
  
  // Sinon, on utilise le fichier Excel fourni
  await fetchAndProcessExcel(xlsxUrl);
}

module.exports = {
  fetchAllEVData
};
