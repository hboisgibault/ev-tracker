const https = require('https');
const fs = require('fs');
const path = require('path');

// NOTE: normalizeFuelType removed; country-specific parsers now own their mappings.
function fetchFile(url, maxRedirects = 5) {
	return new Promise((resolve, reject) => {
		function request(currentUrl, redirectsLeft) {
			const req = https.get(currentUrl, (res) => {
				if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
                    res.resume(); // Consume response body to free socket
					const nextUrl = res.headers.location.startsWith('http') ? res.headers.location : new URL(res.headers.location, currentUrl).toString();
					request(nextUrl, redirectsLeft - 1);
				} else if (res.statusCode === 200) {
					const data = [];
					res.on('data', chunk => data.push(chunk));
					res.on('end', () => resolve(Buffer.concat(data)));
				} else {
                    res.resume(); // Consume response body to free socket
					reject(new Error('HTTP error: ' + res.statusCode));
				}
			});
            req.on('error', reject);
            req.end();
		}
		request(url, maxRedirects);
	});
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function filterMissingMonths(months, outDir, fileNamer = (m) => `${m.code}.json`) {
  ensureDir(outDir);
  return months.filter((m) => {
    const filePath = path.join(outDir, fileNamer(m));
    return !fs.existsSync(filePath);
  });
}

function getMonthsSinceStart(startYear = 2019) {
  const months = [];
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;

  for (let year = startYear; year <= currentYear; year++) {
    const endMonth = year === currentYear ? currentMonth : 12;
    for (let month = 1; month <= endMonth; month++) {
      months.push({ 
        year, 
        month,
        code: `${year}-${String(month).padStart(2, '0')}`
      });
    }
  }
  return months;
}

function fetchJson(url, options = {}) {
  const { method = 'GET', body = null, headers = {} } = options;
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const reqOptions = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'User-Agent': 'EV-Tracker/1.0',
        ...headers
      }
    };

    if (body) {
      reqOptions.headers['Content-Type'] = 'application/json';
      reqOptions.headers['Content-Length'] = Buffer.byteLength(body);
    }

    const req = https.request(reqOptions, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error(`HTTP error: ${res.statusCode}`));
      }
      
      const data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(Buffer.concat(data).toString());
          resolve(json);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

module.exports = { fetchFile, getMonthsSinceStart, ensureDir, filterMissingMonths, fetchJson };
