# EV Tracker

[**EV Tracker**](https://ev-tracker.com) is an open-source project dedicated to collecting, harmonizing, and visualizing registration statistics for electric vehicles (and other powertrains) across several European countries.

The project consists of two main parts:
1. **Data Collection**: Node.js scripts to extract data from official sources (government or statistical agencies).
2. **Visualization Interface**: A web application built with Astro and React to explore trends.

## 📁 Project Structure

```
ev-tracker/
├── config/              # Configuration for zones and data sources
├── data/                # Raw and processed data (JSON) by country/year/month
├── interface/           # Web application (Astro)
├── scripts/             # Scraping and parsing scripts
│   └── parsers/         # Country-specific logic (FR, DE, NO, NL...)
└── package.json         # Dependencies for the collection scripts
```

## 🌍 Supported Countries and Sources

| Code | Country | Data Source |
|------|---------|-------------|
| **FR** | France | Ministry of Ecological Transition |
| **NO** | Norway | OFV / SSB |
| **NL** | Netherlands | RDW / CBS |
| **DE** | Germany | KBA (Kraftfahrt-Bundesamt) |

*(See `config/zones.yaml` for more details)*

## 🚀 Usage

### Prerequisites

- Node.js (version 20+ recommended)
- pnpm or npm

### 1. Data Collection

The collection scripts retrieve historical and recent data to update files in the `data/` folder.

```bash
# Install dependencies
npm install

# Run collection for all configured countries
npm run collect

# Run collection for a specific country (e.g., France)
npm run collect FR
```

Data is saved in JSON format in `data/{COUNTRY_CODE}/ev/{YEAR}-{MONTH}.json`.

### 2. Visualization Interface

The interface allows you to visualize electric vehicle adoption curves.

```bash
cd interface

# Install interface dependencies
npm install

# Start the development server
npm run dev
```

The application will be accessible at `http://localhost:4321`.

## 🛠️ Tech Stack

- **Collection**: Node.js, `jsdom`, `csv-parse`, `xlsx`.
- **Interface**: [Astro](https://astro.build), React, TailwindCSS, Recharts.

## 📄 License

This project is licensed under the **GPL-3.0**. See the [LICENSE](LICENSE) file for more details.
