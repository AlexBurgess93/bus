const perth = [-31.9523, 115.8613];

const map = L.map("map").setView(perth, 11);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

// Simple CSV parser that handles quoted commas
function parseCSVLine(line) {
  const result = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') {
      insideQuotes = !insideQuotes;
    } else if (char === "," && !insideQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }

  result.push(current);
  return result;
}

async function loadStops() {
  const response = await fetch("data/raw/stops.txt");
  const text = await response.text();

  const lines = text.trim().split("\n");
  const headers = parseCSVLine(lines[0]);

  const stopIdIndex = headers.indexOf("stop_id");
  const nameIndex = headers.indexOf("stop_name");
  const latIndex = headers.indexOf("stop_lat");
  const lonIndex = headers.indexOf("stop_lon");

  let loadedCount = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);

    const stopId = cols[stopIdIndex];
    const stopName = cols[nameIndex];
    const lat = parseFloat(cols[latIndex]);
    const lon = parseFloat(cols[lonIndex]);

    if (!isNaN(lat) && !isNaN(lon)) {
      L.circleMarker([lat, lon], {
        radius: 3,
        weight: 1,
        fillOpacity: 0.7
      })
        .addTo(map)
        .bindPopup(`
          <strong>${stopName}</strong><br>
          Stop ID: ${stopId}
        `);

      loadedCount++;
    }
  }

  console.log(`Loaded ${loadedCount} stops`);
}

loadStops();