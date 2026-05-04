const fs = require("fs");
const path = require("path");

const projectDir = __dirname;
const rawDir = path.join(projectDir, "data", "raw");
const processedDir = path.join(projectDir, "data", "processed");
const routeChunksDir = path.join(processedDir, "timetable-routes");

fs.mkdirSync(processedDir, { recursive: true });
fs.mkdirSync(routeChunksDir, { recursive: true });

// These are loaded immediately on app start.
// All other routes are generated as route chunks and can be loaded on demand from the stop panel.
const STARTUP_ACTIVE_ROUTES = [
  "24", "32", "33", "39", "72", "73",
  "176", "177", "178", "179", "270",
  "910", "930", "930X", "935", "940"
];

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];

    if (char === '"') insideQuotes = !insideQuotes;
    else if (char === "," && !insideQuotes) {
      result.push(current.trim());
      current = "";
    } else current += char;
  }

  result.push(current.trim());
  return result;
}

function readGTFSFile(filename) {
  const filePath = path.join(rawDir, filename);
  if (!fs.existsSync(filePath)) throw new Error(`Missing raw GTFS file: ${filePath}`);

  const text = fs.readFileSync(filePath, "utf8");
  const lines = text.trim().split(/\r?\n/);
  const headers = parseCSVLine(lines[0]).map(h => h.replace("\uFEFF", ""));
  const rows = lines.slice(1).map(parseCSVLine);
  return { headers, rows };
}

function writeJson(filename, data) {
  fs.writeFileSync(path.join(processedDir, filename), JSON.stringify(data));
}

function writeRouteChunk(filename, data) {
  fs.writeFileSync(path.join(routeChunksDir, filename), JSON.stringify(data));
}

function safeRouteFilename(routeShortName) {
  return `route-${String(routeShortName || "unknown").trim().replace(/[^a-zA-Z0-9_-]+/g, "_")}.json`;
}

function timeToSeconds(timeString) {
  if (!timeString) return 0;
  const [h, m, s] = timeString.split(":").map(Number);
  return h * 3600 + m * 60 + s;
}

function buildRouteLookups() {
  const routes = readGTFSFile("routes.txt");
  const routeIdToShortName = {};
  const routeIdToLongName = {};
  const routeIdToType = {};

  routes.rows.forEach(cols => {
    const routeId = cols[routes.headers.indexOf("route_id")];
    routeIdToShortName[routeId] = cols[routes.headers.indexOf("route_short_name")];
    routeIdToLongName[routeId] = cols[routes.headers.indexOf("route_long_name")];
    routeIdToType[routeId] = cols[routes.headers.indexOf("route_type")];
  });

  return { routeIdToShortName, routeIdToLongName, routeIdToType };
}

function convertCalendar() {
  const { headers, rows } = readGTFSFile("calendar.txt");
  const calendar = rows.map(cols => ({
    serviceId: cols[headers.indexOf("service_id")],
    monday: cols[headers.indexOf("monday")],
    tuesday: cols[headers.indexOf("tuesday")],
    wednesday: cols[headers.indexOf("wednesday")],
    thursday: cols[headers.indexOf("thursday")],
    friday: cols[headers.indexOf("friday")],
    saturday: cols[headers.indexOf("saturday")],
    sunday: cols[headers.indexOf("sunday")],
    startDate: cols[headers.indexOf("start_date")],
    endDate: cols[headers.indexOf("end_date")]
  }));

  writeJson("calendar.json", calendar);
  console.log(`calendar.json OK (${calendar.length})`);
}

function convertCalendarDates() {
  try {
    const { headers, rows } = readGTFSFile("calendar_dates.txt");
    const calendarDates = rows.map(cols => ({
      serviceId: cols[headers.indexOf("service_id")],
      date: cols[headers.indexOf("date")],
      exceptionType: cols[headers.indexOf("exception_type")]
    }));

    writeJson("calendar-dates.json", calendarDates);
    console.log(`calendar-dates.json OK (${calendarDates.length})`);
  } catch {
    writeJson("calendar-dates.json", []);
    console.warn("calendar_dates.txt missing; wrote empty calendar-dates.json");
  }
}

function convertStops() {
  const { headers, rows } = readGTFSFile("stops.txt");
  const stops = rows
    .map(cols => ({
      id: cols[headers.indexOf("stop_id")],
      name: cols[headers.indexOf("stop_name")],
      lat: parseFloat(cols[headers.indexOf("stop_lat")]),
      lon: parseFloat(cols[headers.indexOf("stop_lon")])
    }))
    .filter(stop => stop.id && !isNaN(stop.lat) && !isNaN(stop.lon));

  writeJson("stops.json", stops);
  console.log(`stops.json OK FULL (${stops.length})`);
}

function convertRoutes() {
  const { headers, rows } = readGTFSFile("routes.txt");
  const routes = rows.map(cols => ({
    id: cols[headers.indexOf("route_id")],
    shortName: cols[headers.indexOf("route_short_name")],
    longName: cols[headers.indexOf("route_long_name")],
    routeType: cols[headers.indexOf("route_type")]
  }));

  writeJson("routes.json", routes);
  console.log(`routes.json OK FULL (${routes.length})`);
}

function convertTrips() {
  const trips = readGTFSFile("trips.txt");
  const { routeIdToShortName, routeIdToLongName, routeIdToType } = buildRouteLookups();

  const data = trips.rows.map(cols => {
    const routeId = cols[trips.headers.indexOf("route_id")];
    return {
      tripId: cols[trips.headers.indexOf("trip_id")],
      routeId,
      routeShortName: routeIdToShortName[routeId],
      routeLongName: routeIdToLongName[routeId],
      routeType: routeIdToType[routeId],
      serviceId: cols[trips.headers.indexOf("service_id")],
      headsign: cols[trips.headers.indexOf("trip_headsign")],
      shapeId: cols[trips.headers.indexOf("shape_id")]
    };
  });

  writeJson("trips.json", data);
  console.log(`trips.json OK FULL (${data.length})`);
}

function convertShapes() {
  const shapes = readGTFSFile("shapes.txt");
  const byShape = {};

  shapes.rows.forEach(cols => {
    const shapeId = cols[shapes.headers.indexOf("shape_id")];
    const lat = parseFloat(cols[shapes.headers.indexOf("shape_pt_lat")]);
    const lon = parseFloat(cols[shapes.headers.indexOf("shape_pt_lon")]);
    const sequence = parseInt(cols[shapes.headers.indexOf("shape_pt_sequence")], 10);

    if (!shapeId || isNaN(lat) || isNaN(lon) || isNaN(sequence)) return;
    if (!byShape[shapeId]) byShape[shapeId] = [];
    byShape[shapeId].push({ lat, lon, sequence });
  });

  Object.keys(byShape).forEach(shapeId => {
    byShape[shapeId].sort((a, b) => a.sequence - b.sequence);
    byShape[shapeId] = byShape[shapeId].map(point => [point.lat, point.lon]);
  });

  writeJson("shapes.json", byShape);
  console.log(`shapes.json OK FULL (${Object.keys(byShape).length})`);
}

function buildAllTripStopTimes() {
  const stopTimes = readGTFSFile("stop_times.txt");
  const trips = readGTFSFile("trips.txt");
  const { routeIdToShortName, routeIdToLongName, routeIdToType } = buildRouteLookups();

  const tripMap = {};

  trips.rows.forEach(cols => {
    const tripId = cols[trips.headers.indexOf("trip_id")];
    const routeId = cols[trips.headers.indexOf("route_id")];

    tripMap[tripId] = {
      tripId,
      routeId,
      routeShortName: routeIdToShortName[routeId],
      routeLongName: routeIdToLongName[routeId],
      routeType: routeIdToType[routeId],
      serviceId: cols[trips.headers.indexOf("service_id")],
      headsign: cols[trips.headers.indexOf("trip_headsign")],
      shapeId: cols[trips.headers.indexOf("shape_id")],
      stops: []
    };
  });

  stopTimes.rows.forEach(cols => {
    const tripId = cols[stopTimes.headers.indexOf("trip_id")];
    const trip = tripMap[tripId];
    if (!trip) return;

    trip.stops.push({
      stopId: cols[stopTimes.headers.indexOf("stop_id")],
      arrivalTime: cols[stopTimes.headers.indexOf("arrival_time")],
      departureTime: cols[stopTimes.headers.indexOf("departure_time")],
      sequence: parseInt(cols[stopTimes.headers.indexOf("stop_sequence")], 10)
    });
  });

  return Object.values(tripMap)
    .filter(trip => trip.routeShortName && trip.stops.length > 1)
    .map(trip => {
      trip.stops.sort((a, b) => a.sequence - b.sequence);
      return trip;
    });
}

function convertStopRoutesFull(allTripStopTimes) {
  const stopRoutes = {};

  allTripStopTimes.forEach(trip => {
    trip.stops.forEach(stop => {
      if (!stopRoutes[stop.stopId]) stopRoutes[stop.stopId] = new Set();
      stopRoutes[stop.stopId].add(trip.routeShortName);
    });
  });

  const clean = {};
  Object.keys(stopRoutes).forEach(stopId => {
    clean[stopId] = Array.from(stopRoutes[stopId]).sort((a, b) => {
      const numA = Number(a);
      const numB = Number(b);
      if (isNaN(numA) || isNaN(numB)) return a.localeCompare(b);
      return numA - numB;
    });
  });

  writeJson("stop-routes.json", clean);
  console.log(`stop-routes.json OK FULL (${Object.keys(clean).length})`);
}

function buildStopUpcomingFromTrips(trips) {
  const stopUpcoming = {};

  trips.forEach(trip => {
    trip.stops.forEach(stop => {
      if (!stopUpcoming[stop.stopId]) stopUpcoming[stop.stopId] = [];
      stopUpcoming[stop.stopId].push({
        tripId: trip.tripId,
        serviceId: trip.serviceId,
        routeId: trip.routeId,
        routeShortName: trip.routeShortName,
        routeLongName: trip.routeLongName,
        routeType: trip.routeType,
        headsign: trip.headsign,
        shapeId: trip.shapeId,
        arrivalTime: stop.arrivalTime,
        departureTime: stop.departureTime,
        stopSequence: stop.sequence
      });
    });
  });

  Object.keys(stopUpcoming).forEach(stopId => {
    stopUpcoming[stopId].sort((a, b) => timeToSeconds(a.arrivalTime) - timeToSeconds(b.arrivalTime));
  });

  return stopUpcoming;
}

function convertStartupTimetableAndRouteChunks(allTripStopTimes) {
  const startupTrips = allTripStopTimes.filter(trip => STARTUP_ACTIVE_ROUTES.includes(trip.routeShortName));
  writeJson("trip-stop-times.json", startupTrips);
  writeJson("stop-upcoming.json", buildStopUpcomingFromTrips(startupTrips));

  const byRoute = {};
  allTripStopTimes.forEach(trip => {
    if (!trip.routeShortName) return;
    if (STARTUP_ACTIVE_ROUTES.includes(trip.routeShortName)) return;
    if (!byRoute[trip.routeShortName]) byRoute[trip.routeShortName] = [];
    byRoute[trip.routeShortName].push(trip);
  });

  const manifest = {};
  fs.rmSync(routeChunksDir, { recursive: true, force: true });
  fs.mkdirSync(routeChunksDir, { recursive: true });

  Object.keys(byRoute).sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).forEach(routeShortName => {
    const filename = safeRouteFilename(routeShortName);
    writeRouteChunk(filename, byRoute[routeShortName]);
    manifest[routeShortName] = `timetable-routes/${filename}`;
  });

  writeJson("route-timetable-manifest.json", manifest);

  console.log(`trip-stop-times.json OK STARTUP (${startupTrips.length})`);
  console.log(`stop-upcoming.json OK STARTUP (${Object.keys(buildStopUpcomingFromTrips(startupTrips)).length})`);
  console.log(`route-timetable-manifest.json OK (${Object.keys(manifest).length} lazy-loadable routes)`);
}

console.log("Starting layered + lazy route GTFS conversion...");
console.log(`Raw folder: ${rawDir}`);
console.log(`Processed folder: ${processedDir}`);
console.log(`Startup active routes: ${STARTUP_ACTIVE_ROUTES.join(", ")}`);

convertCalendar();
convertCalendarDates();
convertStops();
convertRoutes();
convertTrips();
convertShapes();

const allTripStopTimes = buildAllTripStopTimes();
console.log(`Built full trip-stop-times in memory (${allTripStopTimes.length})`);

convertStopRoutesFull(allTripStopTimes);
convertStartupTimetableAndRouteChunks(allTripStopTimes);

console.log("ALL DONE");
