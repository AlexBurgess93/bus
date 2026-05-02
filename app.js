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
let busMarkers = [];
let allShapes = {};
let allRoutes = [];
let allTrips = [];

function timeToSeconds(timeString) {
  const [hours, minutes, seconds] = timeString.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

function getCurrentSeconds() {
  const now = new Date();
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
}

function createStopLookup(stops) {
  const lookup = {};
  stops.forEach(stop => {
    lookup[stop.id] = stop;
  });
  return lookup;
}

// Distance between two GPS points, rough enough for this MVP
function distanceBetweenPoints(a, b) {
  const latDiff = a[0] - b[0];
  const lonDiff = a[1] - b[1];
  return Math.sqrt(latDiff * latDiff + lonDiff * lonDiff);
}

// Find closest point index on a shape to a stop location
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

// Get a position along the route shape between two stops
function interpolateAlongShape(shapeCoords, stopA, stopB, progress) {
  if (!shapeCoords || shapeCoords.length === 0) {
    return [stopA.lat, stopA.lon];
  }

  let startIndex = findClosestShapeIndex(shapeCoords, stopA);
  let endIndex = findClosestShapeIndex(shapeCoords, stopB);

  // If shape direction is reversed for this segment, swap handling
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

  const targetIndex = Math.floor(progress * (segment.length - 1));
  return segment[targetIndex];
}

async function loadCoreData() {
  const [routesRes, tripsRes, shapesRes] = await Promise.all([
    fetch("data/processed/routes.json"),
    fetch("data/processed/trips.json"),
    fetch("data/processed/shapes.json")
  ]);

  allRoutes = await routesRes.json();
  allTrips = await tripsRes.json();
  allShapes = await shapesRes.json();

  console.log("Core data loaded");
  console.log("Routes:", allRoutes.length);
  console.log("Trips:", allTrips.length);
  console.log("Shapes:", Object.keys(allShapes).length);
}

async function loadStops() {
  console.log("Loading stops + stop routes...");

  const [stopsRes, stopRoutesRes] = await Promise.all([
    fetch("data/processed/stops.json"),
    fetch("data/processed/stop-routes.json")
  ]);

  const stops = await stopsRes.json();
  const stopRoutes = await stopRoutesRes.json();

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

  return stops;
}

async function drawRouteByShortName(routeShortName) {
  console.log("Drawing route:", routeShortName);

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

async function loadFakeBuses(stops) {
  console.log("Loading fake buses...");

  const tripsRes = await fetch("data/processed/trip-stop-times.json");
  const trips = await tripsRes.json();

  const stopLookup = createStopLookup(stops);
  const currentSeconds = getCurrentSeconds();

  busMarkers.forEach(marker => map.removeLayer(marker));
  busMarkers = [];

  const activeBuses = [];

  trips.forEach(trip => {
    const firstStopTime = timeToSeconds(trip.stops[0].departureTime);
    const lastStopTime = timeToSeconds(trip.stops[trip.stops.length - 1].arrivalTime);

    if (currentSeconds < firstStopTime || currentSeconds > lastStopTime) {
      return;
    }

    for (let i = 0; i < trip.stops.length - 1; i++) {
      const currentStopTime = timeToSeconds(trip.stops[i].departureTime);
      const nextStopTime = timeToSeconds(trip.stops[i + 1].arrivalTime);

      if (currentSeconds >= currentStopTime && currentSeconds <= nextStopTime) {
        const stopA = stopLookup[trip.stops[i].stopId];
        const stopB = stopLookup[trip.stops[i + 1].stopId];

        if (!stopA || !stopB) return;

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

        activeBuses.push({
          trip,
          position,
          stopA,
          stopB
        });

        return;
      }
    }
  });

  console.log("Active fake buses:", activeBuses.length);

  activeBuses.forEach(bus => {
    const marker = L.circleMarker(bus.position, {
      radius: 8,
      weight: 2,
      fillOpacity: 1,
      color: "black",
      fillColor: "orange"
    })
      .addTo(map)
      .bindPopup(`
        <strong>Route ${bus.trip.routeShortName}</strong><br>
        ${bus.trip.routeLongName}<br>
        Destination: ${bus.trip.headsign}<br><br>
        Between:<br>
        ${bus.stopA.name}<br>
        → ${bus.stopB.name}
      `);

    marker.on("click", () => {
      drawSpecificTripShape(bus.trip);
    });

    busMarkers.push(marker);
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

async function init() {
  await loadCoreData();

  const stops = await loadStops();

  await drawRouteByShortName("930");

  await loadFakeBuses(stops);

  setInterval(() => {
    loadFakeBuses(stops);
  }, 30000);
}

init().catch(err => console.error(err));