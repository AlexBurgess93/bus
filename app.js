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
let selectedTripId = null;
let selectedStopId = null;
let highlightedTripIds = new Set();

let allShapes = {};
let allRoutes = [];
let allTrips = [];
let timetableTrips = [];
let stopUpcoming = {};
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

function createBusIcon(isSelected = false) {
  return L.divIcon({
    className: "",
    html: `
      <div class="${isSelected ? "bus-icon selected" : "bus-icon"}">
        🚌
      </div>
    `,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
    popupAnchor: [0, -15]
  });
}

function clearRouteLine() {
  if (currentRouteLine) {
    map.removeLayer(currentRouteLine);
    currentRouteLine = null;
  }
}

function focusSelectedBus(tripId) {
  selectedTripId = tripId;
  selectedStopId = null;
  highlightedTripIds = new Set([tripId]);

  Object.keys(busMarkersByTripId).forEach(id => {
    const marker = busMarkersByTripId[id];

    if (id === selectedTripId) {
      marker.setOpacity(1);
      marker.setIcon(createBusIcon(true));
      marker.setZIndexOffset(1200);
    } else {
      marker.setOpacity(0.15);
      marker.setIcon(createBusIcon(false));
      marker.setZIndexOffset(0);
    }
  });

  if (currentRouteLine) {
    currentRouteLine.bringToBack();
  }
}

function focusTripsForStop(stopId, upcomingItems) {
  selectedTripId = null;
  selectedStopId = stopId;
  highlightedTripIds = new Set(upcomingItems.map(item => item.tripId));

  Object.keys(busMarkersByTripId).forEach(tripId => {
    const marker = busMarkersByTripId[tripId];

    if (highlightedTripIds.has(tripId)) {
      marker.setOpacity(1);
      marker.setIcon(createBusIcon(true));
      marker.setZIndexOffset(1000);
    } else {
      marker.setOpacity(0.15);
      marker.setIcon(createBusIcon(false));
      marker.setZIndexOffset(0);
    }
  });
}

function focusSingleTrip(tripId) {
  selectedTripId = tripId;
  highlightedTripIds = new Set([tripId]);

  Object.keys(busMarkersByTripId).forEach(id => {
    const marker = busMarkersByTripId[id];

    if (id === tripId) {
      marker.setOpacity(1);
      marker.setIcon(createBusIcon(true));
      marker.setZIndexOffset(1200);
      marker.openPopup();
    } else {
      marker.setOpacity(0.15);
      marker.setIcon(createBusIcon(false));
      marker.setZIndexOffset(0);
    }
  });
}

function clearBusFocus() {
  selectedTripId = null;
  selectedStopId = null;
  highlightedTripIds = new Set();

  Object.keys(busMarkersByTripId).forEach(id => {
    const marker = busMarkersByTripId[id];

    marker.setOpacity(1);
    marker.setIcon(createBusIcon(false));
    marker.setZIndexOffset(500);
  });

  clearRouteLine();
}

function formatMinutesAway(arrivalSeconds, currentSeconds) {
  const diffSeconds = arrivalSeconds - currentSeconds;
  const diffMinutes = Math.round(diffSeconds / 60);

  if (diffMinutes <= 0) return "due now";
  if (diffMinutes === 1) return "1 min";
  return `${diffMinutes} mins`;
}

function getUpcomingForStop(stopId, minutesAhead = 30) {
  const currentSeconds = getCurrentSecondsPrecise();
  const maxSeconds = currentSeconds + minutesAhead * 60;

  const upcoming = stopUpcoming[stopId] || [];

  return upcoming
    .filter(item => {
      const arrivalSeconds = timeToSeconds(item.arrivalTime);
      return arrivalSeconds >= currentSeconds && arrivalSeconds <= maxSeconds;
    })
    .slice(0, 8);
}

function drawTripShapeByShapeId(shapeId) {
  const shapeCoords = allShapes[shapeId];

  if (!shapeCoords) return;

  if (currentRouteLine) {
    map.removeLayer(currentRouteLine);
  }

  currentRouteLine = L.polyline(shapeCoords, {
    color: "blue",
    weight: 5,
    opacity: 0.9
  }).addTo(map);

  currentRouteLine.bringToBack();
}

async function loadCoreData() {
  const [routesRes, tripsRes, shapesRes, timetableRes, stopUpcomingRes] = await Promise.all([
    fetch("data/processed/routes.json"),
    fetch("data/processed/trips.json"),
    fetch("data/processed/shapes.json"),
    fetch("data/processed/trip-stop-times.json"),
    fetch("data/processed/stop-upcoming.json")
  ]);

  allRoutes = await routesRes.json();
  allTrips = await tripsRes.json();
  allShapes = await shapesRes.json();
  timetableTrips = await timetableRes.json();
  stopUpcoming = await stopUpcomingRes.json();

  console.log("Core data loaded");
  console.log("Routes:", allRoutes.length);
  console.log("Trips:", allTrips.length);
  console.log("Shapes:", Object.keys(allShapes).length);
  console.log("Filtered timetable trips:", timetableTrips.length);
  console.log("Stop upcoming records:", Object.keys(stopUpcoming).length);
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

    const marker = L.circleMarker([stop.lat, stop.lon], {
      radius: 4,
      weight: 1,
      fillOpacity: 0.8
    }).addTo(map);

    marker.on("click", event => {
      L.DomEvent.stopPropagation(event);

      clearBusFocus();

      const upcoming = getUpcomingForStop(stop.id, 30);

      focusTripsForStop(stop.id, upcoming);

      const upcomingHTML = upcoming.length
        ? upcoming.map(item => {
            const minsAway = formatMinutesAway(
              timeToSeconds(item.arrivalTime),
              getCurrentSecondsPrecise()
            );

            return `
              <div class="upcoming-row" data-shape-id="${item.shapeId}" data-trip-id="${item.tripId}">
                <strong>${item.routeShortName}</strong>
                <span>${minsAway}</span><br>
                <small>${item.headsign}</small>
              </div>
            `;
          }).join("")
        : `<div class="empty-state">No MVP-route buses in the next 30 mins.</div>`;

      marker.bindPopup(`
        <strong>${stop.name}</strong><br>
        Stop ID: ${stop.id}<br><br>

        <strong>Routes:</strong> ${routes.join(", ") || "None"}<br>
        <strong style="color:green;">Useful:</strong> ${useful.join(", ") || "-"}<br>
        <strong style="color:gray;">Other:</strong> ${other.join(", ") || "-"}<br><br>

        <strong>Coming soon:</strong>
        <div class="upcoming-list">
          ${upcomingHTML}
        </div>
      `).openPopup();

      setTimeout(() => {
        document.querySelectorAll(".upcoming-row").forEach(row => {
          row.addEventListener("click", popupEvent => {
            popupEvent.stopPropagation();

            const shapeId = row.getAttribute("data-shape-id");
            const tripId = row.getAttribute("data-trip-id");

            drawTripShapeByShapeId(shapeId);
            focusSingleTrip(tripId);
          });
        });
      }, 0);
    });
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

  currentRouteLine.bringToBack();

  currentRouteLine.bindPopup(`
    <strong>Route ${trip.routeShortName}</strong><br>
    ${trip.routeLongName}<br>
    Destination: ${trip.headsign}
  `);
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
      const marker = busMarkersByTripId[trip.tripId];

      marker
        .setLatLng(tripPosition.position)
        .setPopupContent(popupHTML);

      if (selectedTripId === trip.tripId) {
        marker.setOpacity(1);
        marker.setIcon(createBusIcon(true));
        marker.setZIndexOffset(1200);
      } else if (highlightedTripIds.has(trip.tripId)) {
        marker.setOpacity(1);
        marker.setIcon(createBusIcon(true));
        marker.setZIndexOffset(1000);
      } else if (selectedTripId || selectedStopId) {
        marker.setOpacity(0.15);
        marker.setIcon(createBusIcon(false));
        marker.setZIndexOffset(0);
      } else {
        marker.setOpacity(1);
        marker.setIcon(createBusIcon(false));
        marker.setZIndexOffset(500);
      }
    } else {
      const marker = L.marker(tripPosition.position, {
        icon: createBusIcon(false),
        zIndexOffset: 500
      })
        .addTo(map)
        .bindPopup(popupHTML);

      marker.on("click", event => {
        L.DomEvent.stopPropagation(event);

        drawSpecificTripShape(trip);
        focusSelectedBus(trip.tripId);
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

map.on("click", () => {
  clearBusFocus();
});

const resetViewButton = document.getElementById("resetViewButton");

resetViewButton.addEventListener("click", event => {
  event.stopPropagation();
  clearBusFocus();
  map.closePopup();
});

async function init() {
  await loadCoreData();
  await loadStops();

  requestAnimationFrame(updateBusPositionsLive);
}

init().catch(err => console.error(err));