const perth = [-31.9523, 115.8613];

const map = L.map("map").setView(perth, 11);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
}).addTo(map);

const USEFUL_ROUTES = [
  "24", "32", "33", "39",
  "72", "73",
  "176", "177", "178", "179",
  "270",
  "910", "930", "930X", "935", "940"
];

let currentRouteLine = null;

let allShapes = {};
let allRoutes = [];
let allTrips = [];
let timetableTrips = [];
let stopLookup = {};

let busMarkersByTripId = {};

function timeToSeconds(timeString) {
  const [hours, minutes, seconds] = timeString.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

function getCurrentSecondsPrecise() {
  const now = new Date();
  return (
    now.getHours() * 3600 +
    now.getMinutes() * 60 +
    now.getSeconds() +
    now.getMilliseconds() / 1000
  );
}

function createStopLookup(stops) {
  const lookup = {};

  stops.forEach(stop => {
    lookup[stop.id] = stop;
  });

  return lookup;
}

function distanceBetweenPoints(a, b) {
  const latDiff = a[0] - b[0];
  const lonDiff = a[1] - b[1];
  return Math.sqrt(latDiff * latDiff + lonDiff * lonDiff);
}

function findClosestShapeIndex(shapeCoords, stop) {
  let closestIndex = 0;
  let closestDistance = Infinity;

  const stopPoint = [stop.lat, stop.lon];

  for (let i = 0; i < shapeCoords.length; i++) {
    const distance = distanceBetweenPoints(shapeCoords[i], stopPoint);

    if (distance < closestDistance) {
      closestDistance = distance;
      closestIndex = i;
    }
  }

  return closestIndex;
}

function interpolateAlongShape(shapeCoords, stopA, stopB, progress) {
  if (!shapeCoords || shapeCoords.length === 0) {
    return [stopA.lat, stopA.lon];
  }

  let startIndex = findClosestShapeIndex(shapeCoords, stopA);
  let endIndex = findClosestShapeIndex(shapeCoords, stopB);

  if (endIndex < startIndex) {
    const temp = startIndex;
    startIndex = endIndex;
    endIndex = temp;
    progress = 1 - progress;
  }

  const segment = shapeCoords.slice(startIndex, endIndex + 1);

  if (segment.length < 2) {
    return [
      stopA.lat + (stopB.lat - stopA.lat) * progress,
      stopA.lon + (stopB.lon - stopA.lon) * progress
    ];
  }

  const exactIndex = progress * (segment.length - 1);
  const lowerIndex = Math.floor(exactIndex);
  const upperIndex = Math.min(lowerIndex + 1, segment.length - 1);
  const localProgress = exactIndex - lowerIndex;

  const lowerPoint = segment[lowerIndex];
  const upperPoint = segment[upperIndex];

  return [
    lowerPoint[0] + (upperPoint[0] - lowerPoint[0]) * localProgress,
    lowerPoint[1] + (upperPoint[1] - lowerPoint[1]) * localProgress
  ];
}

async function loadCoreData() {
  const [routesRes, tripsRes, shapesRes, timetableRes] = await Promise.all([
    fetch("data/processed/routes.json"),
    fetch("data/processed/trips.json"),
    fetch("data/processed/shapes.json"),
    fetch("data/processed/trip-stop-times.json")
  ]);

  allRoutes = await routesRes.json();
  allTrips = await tripsRes.json();
  allShapes = await shapesRes.json();
  timetableTrips = await timetableRes.json();

  console.log("Core data loaded");
  console.log("Routes:", allRoutes.length);
  console.log("Trips:", allTrips.length);
  console.log("Shapes:", Object.keys(allShapes).length);
  console.log("Filtered timetable trips:", timetableTrips.length);
}

async function loadStops() {
  console.log("Loading stops + stop routes...");

  const [stopsRes, stopRoutesRes] = await Promise.all([
    fetch("data/processed/stops.json"),
    fetch("data/processed/stop-routes.json")
  ]);

  const stops = await stopsRes.json();
  const stopRoutes = await stopRoutesRes.json();

  stopLookup = createStopLookup(stops);

  console.log("Stops loaded:", stops.length);

  stops.forEach(stop => {
    const routes = stopRoutes[stop.id] || [];

    const useful = routes.filter(r => USEFUL_ROUTES.includes(r));
    const other = routes.filter(r => !USEFUL_ROUTES.includes(r));

    const popupHTML = `
      <strong>${stop.name}</strong><br>
      Stop ID: ${stop.id}<br><br>
      <strong>Routes:</strong> ${routes.join(", ") || "None"}<br><br>
      <strong style="color:green;">Useful:</strong> ${useful.join(", ") || "-"}<br>
      <strong style="color:gray;">Other:</strong> ${other.join(", ") || "-"}
    `;

    L.circleMarker([stop.lat, stop.lon], {
      radius: 4,
      weight: 1,
      fillOpacity: 0.8
    })
      .addTo(map)
      .bindPopup(popupHTML);
  });
}

function drawSpecificTripShape(trip) {
  const shapeCoords = allShapes[trip.shapeId];

  if (!shapeCoords) return;

  if (currentRouteLine) {
    map.removeLayer(currentRouteLine);
  }

  currentRouteLine = L.polyline(shapeCoords, {
    color: "blue",
    weight: 5,
    opacity: 0.9
  }).addTo(map);

  currentRouteLine.bindPopup(`
    <strong>Route ${trip.routeShortName}</strong><br>
    ${trip.routeLongName}<br>
    Destination: ${trip.headsign}
  `);
}

async function drawRouteByShortName(routeShortName) {
  const route = allRoutes.find(r => r.shortName === routeShortName);

  if (!route) {
    console.log("Route not found:", routeShortName);
    return;
  }

  const routeTrips = allTrips.filter(t => t.routeId === route.id);

  if (routeTrips.length === 0) {
    console.log("No trips found for route:", routeShortName);
    return;
  }

  const trip = routeTrips[0];
  const shapeCoords = allShapes[trip.shapeId];

  if (!shapeCoords) {
    console.log("No shape found for shape ID:", trip.shapeId);
    return;
  }

  if (currentRouteLine) {
    map.removeLayer(currentRouteLine);
  }

  currentRouteLine = L.polyline(shapeCoords, {
    color: "blue",
    weight: 5,
    opacity: 0.9
  }).addTo(map);

  currentRouteLine.bindPopup(`
    <strong>Route ${route.shortName}</strong><br>
    ${route.longName}<br>
    Destination: ${trip.headsign}
  `);

  map.fitBounds(currentRouteLine.getBounds());
}

function getTripPositionNow(trip, currentSeconds) {
  const firstStopTime = timeToSeconds(trip.stops[0].departureTime);
  const lastStopTime = timeToSeconds(trip.stops[trip.stops.length - 1].arrivalTime);

  if (currentSeconds < firstStopTime || currentSeconds > lastStopTime) {
    return null;
  }

  for (let i = 0; i < trip.stops.length - 1; i++) {
    const currentStopTime = timeToSeconds(trip.stops[i].departureTime);
    const nextStopTime = timeToSeconds(trip.stops[i + 1].arrivalTime);

    if (currentSeconds >= currentStopTime && currentSeconds <= nextStopTime) {
      const stopA = stopLookup[trip.stops[i].stopId];
      const stopB = stopLookup[trip.stops[i + 1].stopId];

      if (!stopA || !stopB) return null;

      const segmentDuration = nextStopTime - currentStopTime;
      const elapsed = currentSeconds - currentStopTime;
      const progress = segmentDuration > 0 ? elapsed / segmentDuration : 0;

      const shapeCoords = allShapes[trip.shapeId];

      const position = interpolateAlongShape(
        shapeCoords,
        stopA,
        stopB,
        progress
      );

      return {
        position,
        stopA,
        stopB,
        progress
      };
    }
  }

  return null;
}

function updateBusPositionsLive() {
  const currentSeconds = getCurrentSecondsPrecise();
  const activeTripIds = new Set();

  timetableTrips.forEach(trip => {
    const tripPosition = getTripPositionNow(trip, currentSeconds);

    if (!tripPosition) return;

    activeTripIds.add(trip.tripId);

    const popupHTML = `
      <strong>Route ${trip.routeShortName}</strong><br>
      ${trip.routeLongName}<br>
      Destination: ${trip.headsign}<br><br>
      Between:<br>
      ${tripPosition.stopA.name}<br>
      → ${tripPosition.stopB.name}<br><br>
      Scheduled progress: ${Math.round(tripPosition.progress * 100)}%
    `;

    if (busMarkersByTripId[trip.tripId]) {
      busMarkersByTripId[trip.tripId]
        .setLatLng(tripPosition.position)
        .setPopupContent(popupHTML);
    } else {
      const marker = L.circleMarker(tripPosition.position, {
        radius: 8,
        weight: 2,
        fillOpacity: 1,
        color: "black",
        fillColor: "orange"
      })
        .addTo(map)
        .bindPopup(popupHTML);

      marker.on("click", () => {
        drawSpecificTripShape(trip);
      });

      busMarkersByTripId[trip.tripId] = marker;
    }
  });

  Object.keys(busMarkersByTripId).forEach(tripId => {
    if (!activeTripIds.has(tripId)) {
      map.removeLayer(busMarkersByTripId[tripId]);
      delete busMarkersByTripId[tripId];
    }
  });

  requestAnimationFrame(updateBusPositionsLive);
}

async function init() {
  await loadCoreData();
  await loadStops();

  await drawRouteByShortName("930");

  requestAnimationFrame(updateBusPositionsLive);
}

init().catch(err => console.error(err));