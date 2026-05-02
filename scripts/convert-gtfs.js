const fs = require("fs");
const path = require("path");

const rawDir = path.join(__dirname, "../data/raw");
const processedDir = path.join(__dirname, "../data/processed");

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

function readGTFSFile(filename) {
  const filePath = path.join(rawDir, filename);
  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.trim().split(/\r?\n/);

  const headers = parseCSVLine(lines[0]).map(h => h.replace("\uFEFF", ""));
  const rows = lines.slice(1).map(line => parseCSVLine(line));

  return { headers, rows };
}

function convertStops() {
  const { headers, rows } = readGTFSFile("stops.txt");

  const stopIdIndex = headers.indexOf("stop_id");
  const nameIndex = headers.indexOf("stop_name");
  const latIndex = headers.indexOf("stop_lat");
  const lonIndex = headers.indexOf("stop_lon");

  const stops = [];

  rows.forEach(cols => {
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
  });

  const outputPath = path.join(processedDir, "stops.json");
  fs.writeFileSync(outputPath, JSON.stringify(stops));

  console.log(`Converted ${stops.length} stops`);
}

function convertShapes() {
  const { headers, rows } = readGTFSFile("shapes.txt");

  const shapeIdIndex = headers.indexOf("shape_id");
  const latIndex = headers.indexOf("shape_pt_lat");
  const lonIndex = headers.indexOf("shape_pt_lon");
  const sequenceIndex = headers.indexOf("shape_pt_sequence");

  const shapes = {};

  rows.forEach(cols => {
    const shapeId = cols[shapeIdIndex];
    const lat = parseFloat(cols[latIndex]);
    const lon = parseFloat(cols[lonIndex]);
    const sequence = parseInt(cols[sequenceIndex], 10);

    if (!shapeId || isNaN(lat) || isNaN(lon) || isNaN(sequence)) {
      return;
    }

    if (!shapes[shapeId]) {
      shapes[shapeId] = [];
    }

    shapes[shapeId].push({
      lat,
      lon,
      sequence
    });
  });

  // Sort each shape's points into the correct order
  Object.keys(shapes).forEach(shapeId => {
    shapes[shapeId].sort((a, b) => a.sequence - b.sequence);

    // Leaflet wants coordinates as [lat, lon]
    shapes[shapeId] = shapes[shapeId].map(point => [
      point.lat,
      point.lon
    ]);
  });

  const outputPath = path.join(processedDir, "shapes.json");
  fs.writeFileSync(outputPath, JSON.stringify(shapes));

  console.log(`Converted ${Object.keys(shapes).length} shapes`);
}

function convertRoutes() {
  const { headers, rows } = readGTFSFile("routes.txt");

  const routeIdIndex = headers.indexOf("route_id");
  const shortNameIndex = headers.indexOf("route_short_name");
  const longNameIndex = headers.indexOf("route_long_name");

  const routes = [];

  rows.forEach(cols => {
    routes.push({
      id: cols[routeIdIndex],
      shortName: cols[shortNameIndex],
      longName: cols[longNameIndex]
    });
  });

  const outputPath = path.join(processedDir, "routes.json");
  fs.writeFileSync(outputPath, JSON.stringify(routes));

  console.log(`Converted ${routes.length} routes`);
}

function convertTrips() {
  const { headers, rows } = readGTFSFile("trips.txt");

  const routeIdIndex = headers.indexOf("route_id");
  const serviceIdIndex = headers.indexOf("service_id");
  const tripIdIndex = headers.indexOf("trip_id");
  const headsignIndex = headers.indexOf("trip_headsign");
  const shapeIdIndex = headers.indexOf("shape_id");

  const trips = [];

  rows.forEach(cols => {
    trips.push({
      routeId: cols[routeIdIndex],
      serviceId: cols[serviceIdIndex],
      tripId: cols[tripIdIndex],
      headsign: cols[headsignIndex],
      shapeId: cols[shapeIdIndex]
    });
  });

  const outputPath = path.join(processedDir, "trips.json");
  fs.writeFileSync(outputPath, JSON.stringify(trips));

  console.log(`Converted ${trips.length} trips`);
}

function convertStopRoutes() {
  const routesData = readGTFSFile("routes.txt");
  const tripsData = readGTFSFile("trips.txt");
  const stopTimesData = readGTFSFile("stop_times.txt");

  const routeIdIndex = routesData.headers.indexOf("route_id");
  const shortNameIndex = routesData.headers.indexOf("route_short_name");

  const tripIdIndex = tripsData.headers.indexOf("trip_id");
  const tripRouteIdIndex = tripsData.headers.indexOf("route_id");

  const stopTimesTripIdIndex = stopTimesData.headers.indexOf("trip_id");
  const stopIdIndex = stopTimesData.headers.indexOf("stop_id");

  const routeIdToShortName = {};
  routesData.rows.forEach(cols => {
    routeIdToShortName[cols[routeIdIndex]] = cols[shortNameIndex];
  });

  const tripIdToRouteShortName = {};
  tripsData.rows.forEach(cols => {
    const tripId = cols[tripIdIndex];
    const routeId = cols[tripRouteIdIndex];
    tripIdToRouteShortName[tripId] = routeIdToShortName[routeId];
  });

  const stopRoutes = {};

  stopTimesData.rows.forEach(cols => {
    const tripId = cols[stopTimesTripIdIndex];
    const stopId = cols[stopIdIndex];
    const routeShortName = tripIdToRouteShortName[tripId];

    if (!stopId || !routeShortName) return;

    if (!stopRoutes[stopId]) {
      stopRoutes[stopId] = new Set();
    }

    stopRoutes[stopId].add(routeShortName);
  });

  const cleanStopRoutes = {};

  Object.keys(stopRoutes).forEach(stopId => {
    cleanStopRoutes[stopId] = Array.from(stopRoutes[stopId]).sort((a, b) => {
      return Number(a) - Number(b);
    });
  });

  const outputPath = path.join(processedDir, "stop-routes.json");
  fs.writeFileSync(outputPath, JSON.stringify(cleanStopRoutes));

  console.log(`Converted route lists for ${Object.keys(cleanStopRoutes).length} stops`);
}

convertStops();
convertShapes();
convertRoutes();
convertTrips();
convertStopRoutes();