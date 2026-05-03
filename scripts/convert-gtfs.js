const fs = require("fs");
const path = require("path");

const rawDir = path.join(__dirname, "../data/raw");
const processedDir = path.join(__dirname, "../data/processed");

const TARGET_ROUTES = [
  "24",
  "32",
  "33",
  "39",
  "72",
  "73",
  "176",
  "177",
  "178",
  "179",
  "270",
  "910",
  "930",
  "930X",
  "935",
  "940"
];

// Optional override when generating test data:
// SERVICE_DATE=20260503 node scripts/convert-gtfs.js
// SERVICE_DATE=2026-05-03 node scripts/convert-gtfs.js
const SERVICE_TIME_ZONE = "Australia/Perth";
const TARGET_SERVICE_DATE = getTargetServiceDateString();

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

function getTargetServiceDateString() {
  const envDate = process.env.SERVICE_DATE;

  if (envDate) {
    const cleaned = envDate.replace(/-/g, "");

    if (!/^\d{8}$/.test(cleaned)) {
      throw new Error("SERVICE_DATE must be YYYYMMDD or YYYY-MM-DD");
    }

    return cleaned;
  }

  const formatter = new Intl.DateTimeFormat("en-AU", {
    timeZone: SERVICE_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });

  const parts = formatter.formatToParts(new Date());
  const year = parts.find(part => part.type === "year").value;
  const month = parts.find(part => part.type === "month").value;
  const day = parts.find(part => part.type === "day").value;

  return `${year}${month}${day}`;
}

function getDayFieldForGTFSDate(gtfsDateString) {
  const year = Number(gtfsDateString.slice(0, 4));
  const monthIndex = Number(gtfsDateString.slice(4, 6)) - 1;
  const day = Number(gtfsDateString.slice(6, 8));
  const date = new Date(Date.UTC(year, monthIndex, day));

  const dayFields = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday"
  ];

  return dayFields[date.getUTCDay()];
}

function getActiveServiceIdsForTargetDate() {
  const calendarPath = path.join(rawDir, "calendar.txt");

  if (!fs.existsSync(calendarPath)) {
    console.warn("calendar.txt not found. Continuing without service-day filtering.");
    return null;
  }

  const { headers, rows } = readGTFSFile("calendar.txt");

  const serviceIdIndex = headers.indexOf("service_id");
  const startDateIndex = headers.indexOf("start_date");
  const endDateIndex = headers.indexOf("end_date");
  const targetDayField = getDayFieldForGTFSDate(TARGET_SERVICE_DATE);
  const targetDayIndex = headers.indexOf(targetDayField);

  if (
    serviceIdIndex === -1 ||
    startDateIndex === -1 ||
    endDateIndex === -1 ||
    targetDayIndex === -1
  ) {
    throw new Error("calendar.txt is missing required GTFS calendar columns.");
  }

  const targetDateNumber = Number(TARGET_SERVICE_DATE);
  const activeServiceIds = new Set();

  rows.forEach(cols => {
    const serviceId = cols[serviceIdIndex];
    const runsOnTargetDay = cols[targetDayIndex] === "1";
    const startDate = Number(cols[startDateIndex]);
    const endDate = Number(cols[endDateIndex]);
    const insideDateRange = targetDateNumber >= startDate && targetDateNumber <= endDate;

    if (serviceId && runsOnTargetDay && insideDateRange) {
      activeServiceIds.add(serviceId);
    }
  });

  console.log(`Target service date: ${TARGET_SERVICE_DATE} (${targetDayField})`);
  console.log(`Active service IDs: ${activeServiceIds.size}`);

  return activeServiceIds;
}

const ACTIVE_SERVICE_IDS = getActiveServiceIdsForTargetDate();

function serviceIsActive(serviceId) {
  if (!ACTIVE_SERVICE_IDS) return true;
  return ACTIVE_SERVICE_IDS.has(serviceId);
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

  fs.writeFileSync(
    path.join(processedDir, "stops.json"),
    JSON.stringify(stops)
  );

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

    if (!shapes[shapeId]) {
      shapes[shapeId] = [];
    }

    shapes[shapeId].push({ lat, lon, sequence });
  });

  Object.keys(shapes).forEach(shapeId => {
    shapes[shapeId].sort((a, b) => a.sequence - b.sequence);
    shapes[shapeId] = shapes[shapeId].map(point => [point.lat, point.lon]);
  });

  fs.writeFileSync(
    path.join(processedDir, "shapes.json"),
    JSON.stringify(shapes)
  );

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

  fs.writeFileSync(
    path.join(processedDir, "routes.json"),
    JSON.stringify(routes)
  );

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
    const serviceId = cols[serviceIdIndex];

    if (!serviceIsActive(serviceId)) return;

    trips.push({
      routeId: cols[routeIdIndex],
      serviceId,
      tripId: cols[tripIdIndex],
      headsign: cols[headsignIndex],
      shapeId: cols[shapeIdIndex]
    });
  });

  fs.writeFileSync(
    path.join(processedDir, "trips.json"),
    JSON.stringify(trips)
  );

  console.log(`Converted ${trips.length} active-day trips`);
}

function convertStopRoutes() {
  const routesData = readGTFSFile("routes.txt");
  const tripsData = readGTFSFile("trips.txt");
  const stopTimesData = readGTFSFile("stop_times.txt");

  const routeIdIndex = routesData.headers.indexOf("route_id");
  const shortNameIndex = routesData.headers.indexOf("route_short_name");

  const tripIdIndex = tripsData.headers.indexOf("trip_id");
  const tripRouteIdIndex = tripsData.headers.indexOf("route_id");
  const tripServiceIdIndex = tripsData.headers.indexOf("service_id");

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
    const serviceId = cols[tripServiceIdIndex];
    const routeShortName = routeIdToShortName[routeId];

    if (!serviceIsActive(serviceId)) return;
    if (!TARGET_ROUTES.includes(routeShortName)) return;

    tripIdToRouteShortName[tripId] = routeShortName;
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
      const numA = Number(a);
      const numB = Number(b);

      if (isNaN(numA) || isNaN(numB)) {
        return a.localeCompare(b);
      }

      return numA - numB;
    });
  });

  fs.writeFileSync(
    path.join(processedDir, "stop-routes.json"),
    JSON.stringify(cleanStopRoutes)
  );

  console.log(
    `Converted active-day route lists for ${Object.keys(cleanStopRoutes).length} stops`
  );
}

function convertTripStopTimes() {
  const stopTimesData = readGTFSFile("stop_times.txt");
  const tripsData = readGTFSFile("trips.txt");
  const routesData = readGTFSFile("routes.txt");

  const stopTimesTripIdIndex = stopTimesData.headers.indexOf("trip_id");
  const arrivalTimeIndex = stopTimesData.headers.indexOf("arrival_time");
  const departureTimeIndex = stopTimesData.headers.indexOf("departure_time");
  const stopIdIndex = stopTimesData.headers.indexOf("stop_id");
  const stopSequenceIndex = stopTimesData.headers.indexOf("stop_sequence");

  const tripsTripIdIndex = tripsData.headers.indexOf("trip_id");
  const tripsRouteIdIndex = tripsData.headers.indexOf("route_id");
  const tripsServiceIdIndex = tripsData.headers.indexOf("service_id");
  const tripsHeadsignIndex = tripsData.headers.indexOf("trip_headsign");
  const tripsShapeIdIndex = tripsData.headers.indexOf("shape_id");

  const routesRouteIdIndex = routesData.headers.indexOf("route_id");
  const routesShortNameIndex = routesData.headers.indexOf("route_short_name");
  const routesLongNameIndex = routesData.headers.indexOf("route_long_name");

  const routeIdToRoute = {};

  routesData.rows.forEach(cols => {
    routeIdToRoute[cols[routesRouteIdIndex]] = {
      shortName: cols[routesShortNameIndex],
      longName: cols[routesLongNameIndex]
    };
  });

  const tripInfo = {};

  tripsData.rows.forEach(cols => {
    const tripId = cols[tripsTripIdIndex];
    const routeId = cols[tripsRouteIdIndex];
    const serviceId = cols[tripsServiceIdIndex];
    const route = routeIdToRoute[routeId];

    if (!route) return;
    if (!serviceIsActive(serviceId)) return;

    const routeShortName = route.shortName;

    // Only trips for MVP routes get included in trip-stop-times.json.
    if (!TARGET_ROUTES.includes(routeShortName)) return;

    tripInfo[tripId] = {
      tripId,
      routeId,
      routeShortName,
      routeLongName: route.longName,
      serviceId,
      headsign: cols[tripsHeadsignIndex],
      shapeId: cols[tripsShapeIdIndex],
      stops: []
    };
  });

  stopTimesData.rows.forEach(cols => {
    const tripId = cols[stopTimesTripIdIndex];

    if (!tripInfo[tripId]) return;

    tripInfo[tripId].stops.push({
      stopId: cols[stopIdIndex],
      arrivalTime: cols[arrivalTimeIndex],
      departureTime: cols[departureTimeIndex],
      sequence: Number(cols[stopSequenceIndex])
    });
  });

  const trips = Object.values(tripInfo)
    .filter(trip => trip.stops.length > 1)
    .map(trip => {
      trip.stops.sort((a, b) => a.sequence - b.sequence);
      return trip;
    });

  fs.writeFileSync(
    path.join(processedDir, "trip-stop-times.json"),
    JSON.stringify(trips)
  );

  console.log(`Converted active-day stop times for ${trips.length} trips`);
}

function convertUpcomingStopTrips() {
  const tripStopTimesPath = path.join(processedDir, "trip-stop-times.json");
  const trips = JSON.parse(fs.readFileSync(tripStopTimesPath, "utf8"));

  const stopUpcoming = {};

  trips.forEach(trip => {
    trip.stops.forEach(stopTime => {
      const stopId = stopTime.stopId;

      if (!stopUpcoming[stopId]) {
        stopUpcoming[stopId] = [];
      }

      stopUpcoming[stopId].push({
        tripId: trip.tripId,
        routeShortName: trip.routeShortName,
        routeLongName: trip.routeLongName,
        headsign: trip.headsign,
        shapeId: trip.shapeId,
        arrivalTime: stopTime.arrivalTime,
        departureTime: stopTime.departureTime,
        stopSequence: stopTime.sequence
      });
    });
  });

  Object.keys(stopUpcoming).forEach(stopId => {
    stopUpcoming[stopId].sort((a, b) => {
      return timeStringToSeconds(a.arrivalTime) - timeStringToSeconds(b.arrivalTime);
    });
  });

  fs.writeFileSync(
    path.join(processedDir, "stop-upcoming.json"),
    JSON.stringify(stopUpcoming)
  );

  console.log(`Converted active-day upcoming trip lookup for ${Object.keys(stopUpcoming).length} stops`);
}

function timeStringToSeconds(timeString) {
  const [hours, minutes, seconds] = timeString.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

convertStops();
convertShapes();
convertRoutes();
convertTrips();
convertStopRoutes();
convertTripStopTimes();
convertUpcomingStopTrips();
