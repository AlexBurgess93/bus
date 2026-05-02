const perth = [-31.9523, 115.8613];

const map = L.map("map").setView(perth, 11);

L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

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

async function loadStops() {
  console.log("Starting stop load...");

  const response = await fetch("data/raw/stops.txt");
  console.log("Fetch status:", response.status);

  const text = await response.text();
  console.log("File length:", text.length);
  console.log("First 300 chars:", text.slice(0, 300));

  const lines = text.trim().split(/\r?\n/);
  console.log("Line count:", lines.length);

  const headers = parseCSVLine(lines[0]).map(h => h.replace("\uFEFF", ""));
  console.log("Headers:", headers);

  const stopIdIndex = headers.indexOf("stop_id");
  const nameIndex = headers.indexOf("stop_name");
  const latIndex = headers.indexOf("stop_lat");
  const lonIndex = headers.indexOf("stop_lon");

  console.log({
    stopIdIndex,
    nameIndex,
    latIndex,
    lonIndex
  });

  let loadedCount = 0;
  let skippedCount = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = parseCSVLine(lines[i]);

    const stopId = cols[stopIdIndex];
    const stopName = cols[nameIndex];
    const lat = parseFloat(cols[latIndex]);
    const lon = parseFloat(cols[lonIndex]);

    if (!isNaN(lat) && !isNaN(lon)) {
      L.circleMarker([lat, lon], {
        radius: 4,
        weight: 1,
        fillOpacity: 0.8
      })
        .addTo(map)
        .bindPopup(`
          <strong>${stopName}</strong><br>
          Stop ID: ${stopId}
        `);

      loadedCount++;
    } else {
      skippedCount++;
    }
  }

  console.log("Loaded stops:", loadedCount);
  console.log("Skipped rows:", skippedCount);
}

loadStops().catch(error => {
  console.error("Failed to load stops:", error);
});