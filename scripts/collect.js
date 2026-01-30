// scripts/collect_all.js
// Runs all parsers for all zones and categories defined in config/zones.yaml

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const zonesPath = path.join(__dirname, '../config/zones.yaml');
const zones = yaml.load(fs.readFileSync(zonesPath, 'utf8')).zones;

// Get optional zone filter from command line args
const targetZone = process.argv[2];

async function runAllParsers() {
  const zonesToProcess = targetZone 
    ? (zones[targetZone] ? { [targetZone]: zones[targetZone] } : {})
    : zones;
  
  if (targetZone && !zones[targetZone]) {
    console.error(`Zone '${targetZone}' not found in config/zones.yaml`);
    console.log('Available zones:', Object.keys(zones).join(', '));
    process.exit(1);
  }
  
  for (const [zoneCode, zone] of Object.entries(zonesToProcess)) {
    if (zone.parsers) {
      for (const [category, parserInfo] of Object.entries(zone.parsers)) {
        const scriptPath = path.join(__dirname, './parsers/', parserInfo.script + '.js');
        if (fs.existsSync(scriptPath)) {
          console.log(`Running parser '${category}' for zone '${zoneCode}' (${parserInfo.script})`);
          // eslint-disable-next-line
          await require(scriptPath)[parserInfo.function]();
        } else {
          console.warn(`Parser script not found: ${scriptPath}`);
        }
      }
    }
  }
}

runAllParsers()
  .then(() => {
    console.log('All parsers finished.');
    process.exit(0);
  })
  .catch(e => { 
    console.error('Error while running parsers:', e); 
    process.exit(1); 
  });
