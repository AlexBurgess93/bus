const perth = [-31.9523, 115.8613];

const map = L.map("map").setView(perth, 11);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
}).addTo(map);

let currentRouteLine = null;

async function loadStops() {
  console.log("Loading stops JSON...");

  const response = await fetch("data/processed/stops.json");
  const stops = await response.json();

  console.log("Stops loaded:", stops.length);

  stops.forEach(stop => {
    L.circleMarker([stop.lat, stop.lon], {
      radius: 4,
      weight: 1,
      fillOpacity: 0.8
    })
      .addTo(map)
      .bindPopup(`
        <strong>${stop.name}</strong><br>
        Stop ID: ${stop.id}
      `);
  });
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

  console.log("Route ID:", route.id);

  const routeTrips = trips.filter(t => t.routeId === route.id);

  if (routeTrips.length === 0) {
    console.log("No trips found for route:", routeShortName);
    return;
  }

  const trip = routeTrips[0];

  console.log("Using trip:", trip.tripId);
  console.log("Headsign:", trip.headsign);
  console.log("Shape ID:", trip.shapeId);

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

async function init() {
  await loadStops();

  // Test route. Change this number to try other Transperth routes.
  await drawRouteByShortName("950");
}

init().catch(err => console.error(err));