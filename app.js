const perth = [-31.9523, 115.8613];

const map = L.map("map").setView(perth, 11);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
}).addTo(map);

const USEFUL_ROUTES = [
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

let currentRouteLine = null;
let busMarkers = [];

// Converts "13:45:00" into seconds after midnight
function timeToSeconds(timeString) {
  const [hours, minutes, seconds] = timeString.split(":").map(Number);
  return hours * 3600 + minutes * 60 + seconds;
}

// Gets current time in seconds after midnight
function getCurrentSeconds() {
  const now = new Date();
  return now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
}

// Finds a stop object by stop ID
function createStopLookup(stops) {
  const lookup = {};

  stops.forEach(stop => {
    lookup[stop.id] = stop;
  });

  return lookup;
}

// Linear interpolation between two GPS points
function interpolatePosition(stopA, stopB, progress) {
  const lat = stopA.lat + (stopB.lat - stopA.lat) * progress;
  const lon = stopA.lon + (stopB.lon - stopA.lon) * progress;

  return [lat, lon];
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

  const [routesRes, tripsRes, shapesRes] = await Promise.all([
    fetch("data/processed/routes.json"),
    fetch("data/processed/trips.json"),
    fetch("data/processed/shapes.json")
  ]);

  const routes = await routesRes.json();
  const trips = await tripsRes.json();
  const shapes = await shapesRes.json();

  const route = routes.find(r => r.shortName === routeShortName);

  if (!route) {
    console.log("Route not found:", routeShortName);
    return;
  }

  const routeTrips = trips.filter(t => t.routeId === route.id);

  if (routeTrips.length === 0) {
    console.log("No trips found for route:", routeShortName);
    return;
  }

  const trip = routeTrips[0];
  const shapeCoords = shapes[trip.shapeId];

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

  console.log("Filtered trips loaded:", trips.length);
  console.log("Current seconds:", currentSeconds);

  // Remove old bus markers
  busMarkers.forEach(marker => map.removeLayer(marker));
  busMarkers = [];

  const activeBuses = [];

  trips.forEach(trip => {
    const firstStopTime = timeToSeconds(trip.stops[0].departureTime);
    const lastStopTime = timeToSeconds(trip.stops[trip.stops.length - 1].arrivalTime);

    // Trip is not active right now
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

        const position = interpolatePosition(stopA, stopB, progress);

        activeBuses.push({
          trip,
          position,
          stopA,
          stopB,
          progress
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
      drawRouteByShortName(bus.trip.routeShortName);
    });

    busMarkers.push(marker);
  });
}

async function init() {
  const stops = await loadStops();

  // Draw test route for visual reference
  await drawRouteByShortName("930");

  // Load fake bus positions based on current time
  await loadFakeBuses(stops);

  // Refresh fake bus positions every 30 seconds
  setInterval(() => {
    loadFakeBuses(stops);
  }, 30000);
}

init().catch(err => console.error(err));