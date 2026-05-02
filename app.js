const perth = [-31.9523, 115.8613];

const map = L.map("map").setView(perth, 11);

L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
}).addTo(map);

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

loadStops().catch(err => console.error(err));