const fs = require("fs");
const path = require("path");

const inputPath = path.join(__dirname, "../data/raw/stops.txt");
const outputPath = path.join(__dirname, "../data/processed/stops.json");

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      insideQuotes = !insideQuotes;
    } else if (char === "," && !insideQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current.trim());
  return result;
}

function convertStops() {
  const text = fs.readFileSync(inputPath, "utf8");
  const lines = text.trim().split(/\r?\n/);

  const headers = parseCSVLine(lines[0]).map(h => h.replace("\uFEFF", ""));

  const stopIdIndex = headers.indexOf("stop_id");
  const nameIndex = headers.indexOf("stop_name");
  const latIndex = headers.indexOf("stop_lat");
  const lonIndex = headers.indexOf("stop_lon");

  const stops = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);

    const lat = parseFloat(cols[latIndex]);
    const lon = parseFloat(cols[lonIndex]);

    if (!isNaN(lat) && !isNaN(lon)) {
      stops.push({
        id: cols[stopIdIndex],
        name: cols[nameIndex],
        lat,
        lon
      });
    }
  }

  fs.writeFileSync(outputPath, JSON.stringify(stops));
  console.log(`Converted ${stops.length} stops`);
}

convertStops();