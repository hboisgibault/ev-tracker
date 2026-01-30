import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { slugify } from './slugify.js';

// Load zones configuration
export function loadZones() {
  const zonesPath = path.join(process.cwd(), '../config/zones.yaml');
  try {
    const zonesConfig = yaml.load(fs.readFileSync(zonesPath, 'utf-8'));
    return Object.entries(zonesConfig.zones).map(([code, zone]) => ({
      ...zone,
      code,
      slug: slugify(zone.name)
    }));
  } catch (e) {
    console.error('Error loading zones:', e);
    return [];
  }
}

export function normalizeEnergy(energy, hasFossilData) {
  if (hasFossilData && (energy === 'DIESEL' || energy === 'GASOLINE')) {
    return 'FOSSIL';
  }
  return energy;
}

export function getShare(stats, keys) {
  if (!stats || !stats.total) return 0;
  let vol = 0;
  keys.forEach((k) => (vol += stats.byEnergy[k] || 0));
  return (vol / stats.total) * 100;
}

export function loadCountryData(countryCode) {
    const dataDir = path.join(process.cwd(), '../data', countryCode, 'ev');
    let files = [];
    try {
        files = fs.readdirSync(dataDir).filter((f) => f.endsWith('.json')).sort();
    } catch (e) {
        return { files: [], hasFossilData: false };
    }

    // Detect if data uses FOSSIL
    let hasFossilData = false;
    try {
        for (const filename of files) {
            const filePath = path.join(dataDir, filename);
            const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            if (content.data.some((item) => item.energie === 'FOSSIL')) {
                hasFossilData = true;
               break;
            }
        }
    } catch (e) {
        // ignore
    }

    return { files, hasFossilData, dataDir };
}

export function getMonthlyStats({ files, dataDir, hasFossilData }) {
  return files.map((filename) => {
    const filePath = path.join(dataDir, filename);
    const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const totalsByEnergy = {};
    let totalVolume = 0;
    content.data.forEach((item) => {
      const energy = normalizeEnergy(item.energie, hasFossilData);
      totalsByEnergy[energy] = (totalsByEnergy[energy] || 0) + item.total;
      totalVolume += item.total;
    });
    return {
      date: `${content.year}-${String(content.month).padStart(2, '0')}`,
      total: totalVolume,
      byEnergy: totalsByEnergy,
    };
  });
}

export function getTopModels({ files, dataDir, hasFossilData }) {
  if (files.length === 0) return [];
  const lastFilePath = path.join(dataDir, files[files.length - 1]);
  const content = JSON.parse(fs.readFileSync(lastFilePath, 'utf-8'));

  // Filter for BEV, exclude aggregates
  return content.data
    .filter(item => {
      const e = normalizeEnergy(item.energie, hasFossilData);
      return e === 'BEV' && item.modele !== 'Tous modèles' && item.modele !== 'Autres' && item.marque !== 'Toutes marques';
    })
    .sort((a, b) => b.total - a.total)
    .slice(0, 10);
}
