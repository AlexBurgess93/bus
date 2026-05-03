const fs = require("fs");
const path = require("path");

const rawDir = path.join(__dirname, "../data/raw");
const processedDir = path.join(__dirname, "../data/processed");

fs.mkdirSync(processedDir, { recursive: true });

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

function writeJSON(filename, data) {
  fs.writeFileSync(path.join(processedDir, filename), JSON.stringify(data));
}

function getServiceDateNumber() {
  // Optional override for testing, e.g.:
  // set SERVICE_DATE=20260505 && node scripts\convert-gtfs.js
  const override = process.env.SERVICE_DATE;

  if (override && /^\d{8}$/.test(override)) {
    return Number(override);
  }

  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return Number(`${year}${month}${day}`);
}

function getDayFieldForDateNumber(dateNumber) {
  const text = String(dateNumber);
  const year = Number(text.slice(0, 4));
  const month = Number(text.slice(4, 6)) - 1;
  const day = Number(text.slice(6, 8));
  const date = new Date(year, month, day);

  return [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday"
  ][date.getDay()];
}

function getActiveServiceIds() {
  const { headers, rows } = readGTFSFile("calendar.txt");
  const getIndex = name => headers.indexOf(name);

  const serviceDate = getServiceDateNumber();
  const dayField = getDayFieldForDateNumber(serviceDate);

  const serviceIdIndex = getIndex("service_id");
  const dayIndex = getIndex(dayField);
  const startDateIndex = getIndex("start_date");
  const endDateIndex = getIndex("end_date");

  if ([serviceIdIndex, dayIndex, startDateIndex, endDateIndex].some(index => index === -1)) {
    throw new Error("calendar.txt is missing required columns.");
  }

  const activeServiceIds = new Set();

  rows.forEach(cols => {
    const serviceId = cols[serviceIdIndex];
    const runsOnDay = cols[dayIndex] === "1";
    const startDate = Number(cols[startDateIndex]);
    const endDate = Number(cols[endDateIndex]);

    if (runsOnDay && serviceDate >= startDate && serviceDate <= endDate) {
      activeServiceIds.add(serviceId);
    }
  });

  console.log(`Service date: ${serviceDate} (${dayField})`);
  console.log(`Active service IDs: ${activeServiceIds.size}`);

  if (activeServiceIds.size === 0) {
    console.warn("WARNING: No active service IDs found for this date. Your processed trip data will be empty.");
  }

  return activeServiceIds;
}

function convertCalendar() {
  const { headers, rows } = readGTFSFile("calendar.txt");
  const getIndex = name => headers.indexOf(name);

  const calendar = rows.map(cols => ({
    serviceId: cols[getIndex("service_id")],
    monday: cols[getIndex("monday")] === "1",
    tuesday: cols[getIndex("tuesday")] === "1",
    wednesday: cols[getIndex("wednesday")] === "1",
    thursday: cols[getIndex("thursday")] === "1",
    friday: cols[getIndex("friday")] === "1",
    saturday: cols[getIndex("saturday")] === "1",
    sunday: cols[getIndex("sunday")] === "1",
    startDate: Number(cols[getIndex("start_date")]),
    endDate: Number(cols[getIndex("end_date")])
  }));

  writeJSON("calendar.json", calendar);
  console.log(`Converted ${calendar.length} calendar services`);
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

  writeJSON("stops.json", stops);
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

    if (!shapeId || isNaN(lat) || isNaN(lon) || isNaN(sequence)) return;

    if (!shapes[shapeId]) shapes[shapeId] = [];
    shapes[shapeId].push({ lat, lon, sequence });
  });

  Object.keys(shapes).forEach(shapeId => {
    shapes[shapeId].sort((a, b) => a.sequence - b.sequence);
    shapes[shapeId] = shapes[shapeId].map(point => [point.lat, point.lon]);
  });

  writeJSON("shapes.json", shapes);
  console.log(`Converted ${Object.keys(shapes).length} shapes`);
}

function getRouteLookup() {
  const routesData = readGTFSFile("routes.txt");
  const routeIdIndex = routesData.headers.indexOf("route_id");
  const shortNameIndex = routesData.headers.indexOf("route_short_name");
  const longNameIndex = routesData.headers.indexOf("route_long_name");

  const lookup = {};

  routesData.rows.forEach(cols => {
    lookup[cols[routeIdIndex]] = {
      shortName: cols[shortNameIndex],
      longName: cols[longNameIndex]
    };
  });

  return lookup;
}

function convertRoutes() {
  const { headers, rows } = readGTFSFile("routes.txt");

  const routeIdIndex = headers.indexOf("route_id");
  const shortNameIndex = headers.indexOf("route_short_name");
  const longNameIndex = headers.indexOf("route_long_name");

  const routes = rows.map(cols => ({
    id: cols[routeIdIndex],
    shortName: cols[shortNameIndex],
    longName: cols[longNameIndex]
  }));

  writeJSON("routes.json", routes);
  console.log(`Converted ${routes.length} routes`);
}

function getActiveTripLookup(activeServiceIds) {
  const tripsData = readGTFSFile("trips.txt");
  const routeIdToRoute = getRouteLookup();

  const routeIdIndex = tripsData.headers.indexOf("route_id");
  const serviceIdIndex = tripsData.headers.indexOf("service_id");
  const tripIdIndex = tripsData.headers.indexOf("trip_id");
  const headsignIndex = tripsData.headers.indexOf("trip_headsign");
  const shapeIdIndex = tripsData.headers.indexOf("shape_id");

  const activeTrips = {};

  tripsData.rows.forEach(cols => {
    const serviceId = cols[serviceIdIndex];

    if (!activeServiceIds.has(serviceId)) return;

    const routeId = cols[routeIdIndex];
    const route = routeIdToRoute[routeId];
    if (!route) return;

    const tripId = cols[tripIdIndex];

    activeTrips[tripId] = {
      routeId,
      serviceId,
      tripId,
      routeShortName: route.shortName,
      routeLongName: route.longName,
      headsign: cols[headsignIndex],
      shapeId: cols[shapeIdIndex],
      stops: []
    };
  });

  console.log(`Active trips after service-date filter: ${Object.keys(activeTrips).length}`);
  return activeTrips;
}

function convertTrips(activeTripLookup) {
  const trips = Object.values(activeTripLookup).map(trip => ({
    routeId: trip.routeId,
    serviceId: trip.serviceId,
    tripId: trip.tripId,
    headsign: trip.headsign,
    shapeId: trip.shapeId
  }));

  writeJSON("trips.json", trips);
  console.log(`Converted ${trips.length} active trips`);
}

function convertStopRoutes(activeTripLookup) {
  const stopTimesData = readGTFSFile("stop_times.txt");

  const stopTimesTripIdIndex = stopTimesData.headers.indexOf("trip_id");
  const stopIdIndex = stopTimesData.headers.indexOf("stop_id");

  const stopRoutes = {};

  stopTimesData.rows.forEach(cols => {
    const tripId = cols[stopTimesTripIdIndex];
    const stopId = cols[stopIdIndex];
    const trip = activeTripLookup[tripId];

    if (!stopId || !trip?.routeShortName) return;

    if (!stopRoutes[stopId]) stopRoutes[stopId] = new Set();
    stopRoutes[stopId].add(trip.routeShortName);
  });

  const cleanStopRoutes = {};

  Object.keys(stopRoutes).forEach(stopId => {
    cleanStopRoutes[stopId] = Array.from(stopRoutes[stopId]).sort((a, b) => {
      const numA = Number(a);
      const numB = Number(b);
      if (isNaN(numA) || isNaN(numB)) return a.localeCompare(b);
      return numA - numB;
    });
  });

  writeJSON("stop-routes.json", cleanStopRoutes);
  console.log(`Converted route lists for ${Object.keys(cleanStopRoutes).length} active stops`);
}

function convertTripStopTimes(activeTripLookup) {
  const stopTimesData = readGTFSFile("stop_times.txt");

  const stopTimesTripIdIndex = stopTimesData.headers.indexOf("trip_id");
  const arrivalTimeIndex = stopTimesData.headers.indexOf("arrival_time");
  const departureTimeIndex = stopTimesData.headers.indexOf("departure_time");
  const stopIdIndex = stopTimesData.headers.indexOf("stop_id");
  const stopSequenceIndex = stopTimesData.headers.indexOf("stop_sequence");

  stopTimesData.rows.forEach(cols => {
    const tripId = cols[stopTimesTripIdIndex];
    const trip = activeTripLookup[tripId];

    if (!trip) return;

    trip.stops.push({
      stopId: cols[stopIdIndex],
      arrivalTime: cols[arrivalTimeIndex],
      departureTime: cols[departureTimeIndex],
      sequence: Number(cols[stopSequenceIndex])
    });
  });

  const trips = Object.values(activeTripLookup)
    .filter(trip => trip.stops.length > 1)
    .map(trip => {
      trip.stops.sort((a, b) => a.sequence - b.sequence);
      return trip;
    });

  writeJSON("trip-stop-times.json", trips);
  console.log(`Converted stop times for ${trips.length} active trips`);
}

function timeStringToSeconds(timeString) {
  const [hours, minutes, seconds] = timeString.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

function convertUpcomingStopTrips() {
  const tripStopTimesPath = path.join(processedDir, "trip-stop-times.json");
  const trips = JSON.parse(fs.readFileSync(tripStopTimesPath, "utf8"));

  const stopUpcoming = {};

  trips.forEach(trip => {
    trip.stops.forEach(stopTime => {
      const stopId = stopTime.stopId;
      if (!stopUpcoming[stopId]) stopUpcoming[stopId] = [];

      stopUpcoming[stopId].push({
        tripId: trip.tripId,
        routeShortName: trip.routeShortName,
        routeLongName: trip.routeLongName,
        serviceId: trip.serviceId,
        headsign: trip.headsign,
        shapeId: trip.shapeId,
        arrivalTime: stopTime.arrivalTime,
        departureTime: stopTime.departureTime,
        stopSequence: stopTime.sequence
      });
    });
  });

  Object.keys(stopUpcoming).forEach(stopId => {
    stopUpcoming[stopId].sort((a, b) => timeStringToSeconds(a.arrivalTime) - timeStringToSeconds(b.arrivalTime));
  });

  writeJSON("stop-upcoming.json", stopUpcoming);
  console.log(`Converted upcoming trip lookup for ${Object.keys(stopUpcoming).length} active stops`);
}

const activeServiceIds = getActiveServiceIds();
const activeTripLookup = getActiveTripLookup(activeServiceIds);

convertCalendar();
convertStops();
convertShapes();
convertRoutes();
convertTrips(activeTripLookup);
convertStopRoutes(activeTripLookup);
convertTripStopTimes(activeTripLookup);
convertUpcomingStopTrips();
