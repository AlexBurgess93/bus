// Perth starting position
const perth = [-31.9523, 115.8613];

// Create the map
const map = L.map("map").setView(perth, 12);

// Add OpenStreetMap tiles
L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap contributors"
}).addTo(map);

// Temporary test marker
L.marker(perth)
  .addTo(map)
  .bindPopup("Perth CBD - map is working");
