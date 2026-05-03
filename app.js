// Trip Tracker main application
// Structure: map setup → state → UI rendering → map layers → data/time helpers → app lifecycle.

const perth = [-31.9523, 115.8613];

const map = L.map("map", {
  closePopupOnClick: false,
  preferCanvas: true
}).setView(perth, 11);

const routeFlowRenderer = L.svg({ padding: 0.5 });

const mapTileLayers = {
  light: L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
  }),
  dark: L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors &copy; CARTO"
  })
};

const MAP_THEME_STORAGE_KEY = "tripTrackerMapTheme";
let currentMapTheme = localStorage.getItem(MAP_THEME_STORAGE_KEY) || "light";

if (!mapTileLayers[currentMapTheme]) {
  currentMapTheme = "light";
}

mapTileLayers[currentMapTheme].addTo(map);
document.documentElement.dataset.mapTheme = currentMapTheme;

const STOP_DOTS_MIN_ZOOM = 15;
const DETAILED_MARKER_MIN_ZOOM = 14;
const SERVICE_DOTS_MIN_ZOOM = 10;
const NETWORK_LAYER_MAX_ZOOM = 14;

let currentRouteLine = null;
let selectedTripId = null;
let selectedStopId = null;
let highlightedTripIds = new Set();
let allShapes = {};
let allRoutes = [];
let allTrips = [];
let timetableTrips = [];
let unfilteredTimetableTrips = [];
let stopUpcoming = {};
let unfilteredStopUpcoming = {};
let serviceCalendarRows = [];
let activeServiceIdsForToday = new Set();
let stopLookup = {};
let busMarkersByTripId = {};
let stopMarkersByStopId = {};
let stopHitMarkersByStopId = {};
let stopRouteLines = [];
let networkRouteLinesByShapeId = {};
let latestTripPositionsByTripId = {};
let selectedPanelType = null;
let serviceDayOffsetSeconds = 0;
let simulatedCurrentSecondsOverride = null;
let busUpdateTimerId = null;
let isMapMoving = false;
let mapRefreshTimeoutId = null;
const VEHICLE_UPDATE_INTERVAL_MS = 3000;
const MAP_SETTLE_REFRESH_DELAY_MS = 120;
let hasWarnedAboutNoActiveTrips = false;
let userLocationMarker = null;

let trackingMode = "scheduled";
let liveBusMarkersByTripId = {};
let latestLiveTripPositionsByTripId = {};
let ghostRouteSegmentLine = null;
let selectedBusVariant = "live";
let transportModeFilter = "all";
const PIN_STORAGE_KEY = "transitPinnedNetworkV1";
let pinnedRouteIds = new Set();
let pinnedStopIds = new Set();
let pinnedViewEnabled = false;
let activeMapPinMarker = null;
let tripLookupByTripId = {};
let etaMarkers = [];

let userLocation = null;
let journeyStart = null;
let journeyEnd = null;
let journeyPickMode = null;
let journeyRouteLines = [];
let journeyStopTimeMarkers = [];
let journeyOverlayCollapseTimer = null;
let selectedJourneyOptionTripId = null;
let latestJourneyOptions = [];
let stopMapActionStopId = null;
let journeySelectedPlaces = { start: null, end: null };
let journeyAutocompleteTimers = { start: null, end: null };
let journeyAutocompleteRequestIds = { start: 0, end: 0 };

const trackingModeButtons = document.querySelectorAll(".tracking-mode-button");

// Set this to false if you only ever want true real-time behaviour.
// When true, the prototype still shows buses if the current clock time has no active trips in the processed dataset.
const KEEP_PROTOTYPE_VISIBLE_WHEN_NO_REAL_TIME_BUSES = true;

const selectionPanel = document.getElementById("selectionPanel");
const selectionPanelContent = document.getElementById("selectionPanelContent");
const closeSelectionPanelButton = document.getElementById("closeSelectionPanelButton");
const liveNoticeModal = document.getElementById("liveNoticeModal");
const liveNoticeOkButton = document.getElementById("liveNoticeOkButton");
const LIVE_NOTICE_SEEN_KEY = "tripTrackerLiveNoticeSeen";
const locateUserButton = document.getElementById("locateUserButton");
const themeToggleButton = document.getElementById("themeToggleButton");
const themeToggleIcon = document.getElementById("themeToggleIcon");
const journeyOverlay = document.getElementById("journeyOverlay");
const journeyStartValue = document.getElementById("journeyStartValue");
const journeyEndValue = document.getElementById("journeyEndValue");
const journeyStartInput = document.getElementById("journeyStartInput");
const journeyEndInput = document.getElementById("journeyEndInput");
const journeyStartSuggestions = document.getElementById("journeyStartSuggestions");
const journeyEndSuggestions = document.getElementById("journeyEndSuggestions");
const journeyStartEditButton = document.getElementById("journeyStartEditButton");
const journeyEndEditButton = document.getElementById("journeyEndEditButton");
const journeySwapButton = document.getElementById("journeySwapButton");
const journeyClearButton = document.getElementById("journeyClearButton");
const journeySearchButton = document.getElementById("journeySearchButton");
const stopMapAction = document.getElementById("stopMapAction");




// ---------- Map theme controls ----------
function applyMapTheme(theme) {
  if (!mapTileLayers[theme] || theme === currentMapTheme) return;

  map.removeLayer(mapTileLayers[currentMapTheme]);
  mapTileLayers[theme].addTo(map);

  currentMapTheme = theme;
  localStorage.setItem(MAP_THEME_STORAGE_KEY, currentMapTheme);
  document.documentElement.dataset.mapTheme = currentMapTheme;
  updateThemeToggleButton();

  if (currentRouteLine) {
    currentRouteLine.setStyle({
      color: getRoutePathColour(),
      weight: getRoutePathWeight(),
      opacity: getRoutePathOpacity(),
      dashArray: trackingMode === "ghost" ? null : "10 18"
    });
  }

  // Force marker icons to rebuild once so dark/light specific styles stay consistent.
  Object.values(busMarkersByTripId).forEach(marker => { marker._tripTrackerIconKey = null; });
  Object.values(liveBusMarkersByTripId).forEach(marker => { marker._tripTrackerIconKey = null; });
  updateBusPositionsLive();
}

function updateThemeToggleButton() {
  if (!themeToggleButton || !themeToggleIcon) return;

  const isDark = currentMapTheme === "dark";
  themeToggleButton.classList.toggle("is-active", isDark);
  themeToggleButton.setAttribute("aria-label", isDark ? "Enable light map" : "Enable dark map");
  themeToggleIcon.setAttribute("src", isDark ? "enable_light_mode.svg" : "enable_dark_mode.svg");
}

function toggleMapTheme() {
  applyMapTheme(currentMapTheme === "dark" ? "light" : "dark");
}


// ---------- Generic helpers ----------
function escapeHTML(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function cleanStopName(name) {
  return String(name ?? "")
    .replace(/^Ferry Route\s*/i, "")
    .replace(/^Bus Route\s*/i, "")
    .trim();
}


// ---------- Bottom context panel ----------
function showSelectionPanel() {
  // The panel is always present in the layout.
  // This prevents Leaflet from resizing/re-centering the map when content changes.
  selectionPanel.classList.add("has-selection");
}

function hideSelectionPanel() {
  selectionPanel.classList.remove("has-selection");
  selectionPanel.classList.remove("journey-options-mode");
  selectedPanelType = null;
  renderDefaultContextPanel();
}


// ---------- Pinning and route filtering ----------
function getTripRouteKey(trip = {}) {
  const routeId = String(trip.routeId ?? "").trim();
  if (routeId) return routeId;

  const mode = getTransportMode(trip);
  const shortName = String(trip.routeShortName ?? "").trim();
  const longName = String(trip.routeLongName ?? "").trim();

  return `${mode}:${shortName}:${longName}`;
}

function getRouteDisplayNameForTrip(trip = {}) {
  const label = getTransportLabel(trip);
  const mode = getTransportMode(trip);

  if (mode === "train" || mode === "ferry") {
    return String(trip.routeLongName || trip.headsign || label || mode).trim();
  }

  return String(label || trip.routeShortName || trip.routeLongName || "Route").trim();
}

function readPinState() {
  try {
    const raw = localStorage.getItem(PIN_STORAGE_KEY);
    if (!raw) return;

    const parsed = JSON.parse(raw);
    pinnedRouteIds = new Set(Array.isArray(parsed.pinnedRouteIds) ? parsed.pinnedRouteIds : []);
    pinnedStopIds = new Set(Array.isArray(parsed.pinnedStopIds) ? parsed.pinnedStopIds : []);
    pinnedViewEnabled = Boolean(parsed.pinnedViewEnabled);
  } catch (error) {
    console.warn("Pinned network state could not be read.", error);
    pinnedRouteIds = new Set();
    pinnedStopIds = new Set();
    pinnedViewEnabled = false;
  }
}

function savePinState() {
  localStorage.setItem(PIN_STORAGE_KEY, JSON.stringify({
    pinnedRouteIds: Array.from(pinnedRouteIds),
    pinnedStopIds: Array.from(pinnedStopIds),
    pinnedViewEnabled
  }));
}

function rebuildTripLookup() {
  tripLookupByTripId = {};

  timetableTrips.forEach(trip => {
    tripLookupByTripId[trip.tripId] = trip;
  });
}

function getPinnedRouteIdsFromStops() {
  const routeIds = new Set();

  pinnedStopIds.forEach(stopId => {
    const upcoming = stopUpcoming[stopId] || [];

    upcoming.forEach(item => {
      const trip = tripLookupByTripId[item.tripId];
      if (trip) {
        routeIds.add(getTripRouteKey(trip));
      }
    });
  });

  return routeIds;
}

function getEffectivePinnedRouteIds() {
  const routeIds = new Set(pinnedRouteIds);
  getPinnedRouteIdsFromStops().forEach(routeId => routeIds.add(routeId));
  return routeIds;
}

function hasAnyPins() {
  return pinnedRouteIds.size > 0 || pinnedStopIds.size > 0;
}

function tripMatchesPinnedView(trip = {}) {
  if (!pinnedViewEnabled) return true;
  if (!hasAnyPins()) return false;

  return getEffectivePinnedRouteIds().has(getTripRouteKey(trip));
}

function tripMatchesMapFilters(trip = {}) {
  return tripMatchesTransportFilter(trip) && tripMatchesPinnedView(trip);
}

function getPinnedRouteLabels() {
  const labelsByKey = {};

  timetableTrips.forEach(trip => {
    const key = getTripRouteKey(trip);
    if (!getEffectivePinnedRouteIds().has(key)) return;
    labelsByKey[key] = getRouteDisplayNameForTrip(trip);
  });

  return Object.values(labelsByKey).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

function setPinnedViewEnabled(enabled) {
  pinnedViewEnabled = Boolean(enabled);
  savePinState();
  clearBusFocus();
  renderDefaultContextPanel();
  updateBusPositionsLive();
  updateNetworkLayer();
}

function togglePinnedRoute(trip) {
  const routeKey = getTripRouteKey(trip);

  if (pinnedRouteIds.has(routeKey)) {
    pinnedRouteIds.delete(routeKey);
  } else {
    pinnedRouteIds.add(routeKey);
  }

  savePinState();
  updateBusPositionsLive();
  updateNetworkLayer();

  return pinnedRouteIds.has(routeKey);
}

function togglePinnedStop(stopId) {
  if (pinnedStopIds.has(stopId)) {
    pinnedStopIds.delete(stopId);
  } else {
    pinnedStopIds.add(stopId);
  }

  savePinState();
  updateBusPositionsLive();
  updateNetworkLayer();

  return pinnedStopIds.has(stopId);
}

function getRoutesForStop(stopId) {
  const routeMap = new Map();
  const upcoming = stopUpcoming[stopId] || [];

  upcoming.forEach(item => {
    const trip = tripLookupByTripId[item.tripId];
    if (!trip) return;

    const key = getTripRouteKey(trip);
    if (!routeMap.has(key)) {
      routeMap.set(key, {
        key,
        label: getRouteDisplayNameForTrip(trip),
        mode: getTransportMode(trip)
      });
    }
  });

  return Array.from(routeMap.values()).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

function clearActiveMapPinMarker() {
  if (activeMapPinMarker) {
    map.removeLayer(activeMapPinMarker);
    activeMapPinMarker = null;
  }
}

function createMapPinIcon(label = "Pin", isPinned = false) {
  const stateClass = isPinned ? "is-pinned" : "is-unpinned";
  const iconSrc = isPinned ? "unpin_icon.svg" : "pin_icon.svg";

  return L.divIcon({
    className: "",
    html: `
      <button class="map-pin-button ${stateClass}" type="button" aria-label="${escapeHTML(label)}">
        <img class="map-pin-icon" src="${iconSrc}" alt="" aria-hidden="true">
      </button>
    `,
    iconSize: [34, 34],
    // Keep the pin control below the selected stop dot so planning buttons can sit above it.
    iconAnchor: [17, -12]
  });
}

function showMapPinForStop(stop) {
  clearActiveMapPinMarker();

  if (!stop) return;

  const isPinned = pinnedStopIds.has(stop.id);
  const label = isPinned
    ? `Remove pinned stop ${stop.name}`
    : `Pin stop ${stop.name}`;

  activeMapPinMarker = L.marker([stop.lat, stop.lon], {
    icon: createMapPinIcon(label, isPinned),
    zIndexOffset: 1800,
    interactive: true,
    keyboard: true
  }).addTo(map);

  activeMapPinMarker.on("click", event => {
    stopLeafletEvent(event);
    togglePinnedStop(stop.id);
    showMapPinForStop(stop);
  });
}

function showMapPinForTrip(trip, variant = selectedBusVariant) {
  clearActiveMapPinMarker();

  if (!trip) return;

  const positionRecord = variant === "scheduled"
    ? latestTripPositionsByTripId[trip.tripId]
    : latestLiveTripPositionsByTripId[trip.tripId] || latestTripPositionsByTripId[trip.tripId];

  if (!positionRecord?.position) return;

  const routeKey = getTripRouteKey(trip);
  const isPinned = pinnedRouteIds.has(routeKey);
  const routeLabel = getRouteDisplayNameForTrip(trip);
  const label = isPinned
    ? `Remove pinned ${routeLabel}`
    : `Pin ${routeLabel}`;

  activeMapPinMarker = L.marker(positionRecord.position, {
    icon: createMapPinIcon(label, isPinned),
    zIndexOffset: 1800,
    interactive: true,
    keyboard: true
  }).addTo(map);

  activeMapPinMarker.on("click", event => {
    stopLeafletEvent(event);
    togglePinnedRoute(trip);
    showMapPinForTrip(trip, variant);
  });
}

function renderDefaultContextPanel() {
  const filters = [
    { value: "all", label: "All" },
    { value: "bus", label: "Bus" },
    { value: "train", label: "Train" },
    { value: "ferry", label: "Ferry" },
    {
      value: "pinned",
      label: "Pinned",
      iconHTML: `<img src="current_location_pin.svg" alt="" class="transport-filter-icon" aria-hidden="true">`
    }
  ];

  const filterHTML = filters.map(filter => {
    const contentHTML = filter.iconHTML
      ? `${filter.iconHTML}<span>${escapeHTML(filter.label)}</span>`
      : `<span>${escapeHTML(filter.label)}</span>`;

    return `
      <button
        class="transport-filter-button ${filter.value === transportModeFilter ? "is-active" : ""}"
        type="button"
        data-transport-filter="${escapeHTML(filter.value)}"
        aria-pressed="${filter.value === transportModeFilter ? "true" : "false"}"
      >
        ${contentHTML}
      </button>
    `;
  }).join("");

  const pinnedRouteLabels = getPinnedRouteLabels();
  const pinsSummary = hasAnyPins()
    ? `${pinnedRouteLabels.length} pinned route${pinnedRouteLabels.length === 1 ? "" : "s"} from ${pinnedStopIds.size} stop pin${pinnedStopIds.size === 1 ? "" : "s"}`
    : "Pin a stop or service from the map to build a personal network.";

  selectionPanelContent.innerHTML = `
    <section class="panel-section context-panel-section">
      <div class="context-panel-header">
        <div class="panel-text-stack">
          <div class="panel-title">Explore services</div>
          <div class="panel-subtitle">${escapeHTML(transportModeFilter === "pinned" ? `Pinned view active · ${pinsSummary}` : pinsSummary)}</div>
        </div>
      </div>

      <div class="transport-filter-strip context-filter-strip" role="group" aria-label="Filter map view">
        ${filterHTML}
      </div>
    </section>
  `;

  bindTransportFilterButtons();
}

function bindPinContextButtons() {
  // Pin controls now live on the map, not inside the bottom context panel.
}

function bindTransportFilterButtons() {
  selectionPanelContent.querySelectorAll(".transport-filter-button").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      setTransportModeFilter(button.dataset.transportFilter || "all");
    });
  });
}


// ---------- Transport mode filtering ----------
function setTransportModeFilter(mode) {
  const nextMode = ["all", "bus", "train", "ferry", "pinned"].includes(mode) ? mode : "all";

  transportModeFilter = nextMode;
  pinnedViewEnabled = nextMode === "pinned";
  savePinState();

  if (!selectedTripId && !selectedStopId) {
    renderDefaultContextPanel();
  }

  updateBusPositionsLive();
  updateNetworkLayer();
}

function getTransportMode(item = {}) {
  const routeType = String(item.routeType ?? "").trim();

  if (routeType === "2") return "train";
  if (routeType === "4") return "ferry";
  if (routeType === "0") return "tram";
  if (routeType === "1") return "subway";
  if (routeType === "3") return "bus";

  // Fallback for older processed data that does not have routeType yet.
  // If there is a route number, treat it as a bus. Otherwise use a generic transit icon.
  if (String(item.routeShortName ?? "").trim()) return "bus";

  return "transit";
}

function tripMatchesTransportFilter(trip = {}) {
  if (transportModeFilter === "all" || transportModeFilter === "pinned") return true;
  return getTransportMode(trip) === transportModeFilter;
}

function positionIsInsideExpandedViewport(position) {
  if (!position) return false;
  return map.getBounds().pad(0.22).contains(L.latLng(position[0], position[1]));
}

function shouldRenderTripMarkers(trip, scheduledPosition, livePosition) {
  if (selectedJourneyOptionTripId) return trip.tripId === selectedJourneyOptionTripId;
  if (latestJourneyOptions.length) return latestJourneyOptions.some(option => option.tripId === trip.tripId);
  if (selectedTripId === trip.tripId) return true;
  if (!tripMatchesMapFilters(trip)) return false;

  const zoom = map.getZoom();

  // Wide-area views should still feel alive, but with very cheap tiny dots.
  // Below this, the network layer carries the God-view instead of thousands of markers.
  if (zoom < SERVICE_DOTS_MIN_ZOOM) return false;

  return (
    positionIsInsideExpandedViewport(scheduledPosition?.position) ||
    positionIsInsideExpandedViewport(livePosition?.position)
  );
}

function shouldUseCompactServiceMarker(isSelected = false) {
  return !isSelected && map.getZoom() < DETAILED_MARKER_MIN_ZOOM;
}

function getTransportLabel(item = {}) {
  const mode = getTransportMode(item);
  const routeShortName = String(item.routeShortName ?? "").trim();

  if (mode === "bus") return routeShortName || "BUS";
  if (mode === "train") return "🚆";
  if (mode === "ferry") return "⛴️";
  if (mode === "tram") return "🚋";
  if (mode === "subway") return "🚇";

  return "•";
}

function getTransportAriaLabel(item = {}) {
  const mode = getTransportMode(item);
  const label = getTransportLabel(item);
  const routeLongName = String(item.routeLongName ?? "").trim();
  const headsign = String(item.headsign ?? "").trim();

  if (mode === "bus") {
    return `bus route ${label}${headsign ? ` to ${headsign}` : ""}`;
  }

  return `${mode}${routeLongName ? ` ${routeLongName}` : ""}${headsign ? ` to ${headsign}` : ""}`;
}


// ---------- Stop and service detail panels ----------
function renderStopPanel(stop, upcomingItems) {
  selectionPanel.classList.remove("journey-options-mode");
  selectedPanelType = "stop";

  const routesForStop = getRoutesForStop(stop.id);
  const routeStripHTML = routesForStop.length
    ? routesForStop
        .slice(0, 18)
        .map(route => `<span class="stop-route-pill stop-route-${escapeHTML(route.mode)}">${escapeHTML(route.label)}</span>`)
        .join("")
    : `<span class="stop-route-empty">No active routes found for this stop today.</span>`;

  const upcomingHTML = upcomingItems.length
    ? upcomingItems.map(item => {
        const minsAway = formatMinutesAway(
          timeToSeconds(item.arrivalTime),
          getCurrentSecondsPrecise()
        );

        const trip = tripLookupByTripId[item.tripId] || item;
        const delayStatus = getDelayStatus(getStableLiveDelaySeconds(item.tripId));
        const statusLabel = delayStatus.detail === "on time" ? "on time" : delayStatus.detail;

        return `
          <button
            class="arrival-pill ${escapeHTML(delayStatus.className)}"
            type="button"
            data-shape-id="${escapeHTML(item.shapeId)}"
            data-trip-id="${escapeHTML(item.tripId)}"
            aria-label="Select ${escapeHTML(getTransportAriaLabel(item))}, ${escapeHTML(minsAway)} away, ${escapeHTML(statusLabel)}"
          >
            <span class="arrival-route ${escapeHTML(`arrival-route-${getTransportMode(trip)}`)}">${escapeHTML(getTransportLabel(trip))}</span>
            <span class="arrival-time">${escapeHTML(minsAway)}</span>
            <span class="arrival-destination">${escapeHTML(item.headsign)}</span>
          </button>
        `;
      }).join("")
    : `<div class="arrival-empty">No active services in the next 30 mins.</div>`;

  selectionPanelContent.innerHTML = `
    <section class="panel-section stop-panel-section">
      <div class="panel-main-row stop-panel-header">
        <div class="panel-text-stack">
          <div class="panel-title">${escapeHTML(stop.name)}</div>
          <div class="panel-subtitle">Stop ID: ${escapeHTML(stop.id)}</div>
        </div>

        <button class="stop-routes-toggle" type="button" aria-expanded="false" aria-label="Show routes serving this stop">
          ${escapeHTML(routesForStop.length)} routes
        </button>
      </div>

      <div class="stop-route-strip is-collapsed" aria-label="Routes serving this stop">
        ${routeStripHTML}
      </div>

      <div class="arrival-strip" aria-label="Upcoming services">
        ${upcomingHTML}
      </div>
    </section>
  `;

  const routeToggle = selectionPanelContent.querySelector(".stop-routes-toggle");
  const routeStrip = selectionPanelContent.querySelector(".stop-route-strip");

  if (routeToggle && routeStrip) {
    routeToggle.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();

      const isCollapsed = routeStrip.classList.toggle("is-collapsed");
      routeToggle.setAttribute("aria-expanded", String(!isCollapsed));
    });
  }

  showStopMapAction(stop);

  selectionPanelContent.querySelectorAll(".arrival-pill").forEach(button => {
    const selectUpcomingTrip = event => {
      event.preventDefault();
      event.stopPropagation();

      const shapeId = button.getAttribute("data-shape-id");
      const tripId = button.getAttribute("data-trip-id");
      const trip = tripLookupByTripId[tripId];

      drawTripShapeByShapeId(shapeId);
      focusSingleTrip(tripId);

      if (trip) {
        renderBusPanel(trip);
      }
    };

    button.addEventListener("click", selectUpcomingTrip);
  });

  showMapPinForStop(stop);
  showSelectionPanel();
}


// ---------- Schedule/live comparison status ----------
function getStableLiveDelaySeconds(tripId) {
  // Deterministic fake live-data offset for the visualisation demo.
  // Positive = live bus is behind schedule. Negative = live bus is ahead.
  let hash = 0;

  String(tripId).split("").forEach(char => {
    hash = ((hash << 5) - hash) + char.charCodeAt(0);
    hash |= 0;
  });

  const bucket = Math.abs(hash) % 7;
  const offsets = [-150, -90, -35, 0, 45, 105, 165];

  return offsets[bucket];
}

function getDelayStatus(delaySeconds) {
  const roundedMinutes = Math.round(Math.abs(delaySeconds) / 60);

  // Colour is mapped to rider outcome, not just raw schedule maths:
  // on-time is good, late is a warning/problem, early is informational.
  if (delaySeconds <= -60) {
    return {
      label: "Ahead",
      className: "ahead",
      text: `-${roundedMinutes} min`,
      detail: "ahead"
    };
  }

  if (delaySeconds >= 300) {
    return {
      label: "Delayed",
      className: "very-late",
      text: `+${roundedMinutes} min`,
      detail: "delayed"
    };
  }

  if (delaySeconds >= 60) {
    return {
      label: "Behind",
      className: "behind",
      text: `+${roundedMinutes} min`,
      detail: "behind"
    };
  }

  return {
    label: "On time",
    className: "on-time",
    text: "on time",
    detail: "on time"
  };
}

function getDelayColour(delaySeconds) {
  const status = getDelayStatus(delaySeconds);

  if (status.className === "ahead") return "#2563eb";
  if (status.className === "very-late") return "#dc2626";
  if (status.className === "behind") return "#f59e0b";
  return "#16a34a";
}

function getRoutePathColour() {
  if (trackingMode !== "ghost") return "#f59e0b";

  // In Compare mode the whole selected path should become quiet context.
  // The coloured difference segment and vehicle markers carry the attention.
  return currentMapTheme === "dark" ? "#1f2937" : "#cbd5e1";
}

function getRoutePathOpacity() {
  return trackingMode === "ghost" ? 0.34 : 0.92;
}

function getRoutePathWeight() {
  return trackingMode === "ghost" ? 4 : 5;
}

function clearGhostRouteSegmentLine() {
  if (ghostRouteSegmentLine) {
    map.removeLayer(ghostRouteSegmentLine);
    ghostRouteSegmentLine = null;
  }
}

function getShapeSegmentBetweenPositions(shapeCoords, positionA, positionB) {
  if (!shapeCoords || shapeCoords.length < 2 || !positionA || !positionB) {
    return [];
  }

  const pointA = { lat: positionA[0], lon: positionA[1] };
  const pointB = { lat: positionB[0], lon: positionB[1] };

  const indexA = findClosestShapeIndex(shapeCoords, pointA);
  const indexB = findClosestShapeIndex(shapeCoords, pointB);
  const startIndex = Math.min(indexA, indexB);
  const endIndex = Math.max(indexA, indexB);

  const segment = shapeCoords.slice(startIndex, endIndex + 1);

  // Do not fall back to a direct "as the crow flies" connector.
  // If the two positions collapse to the same/single closest shape point,
  // there is not enough route geometry to draw a meaningful route-following segment.
  if (segment.length < 2) {
    return [];
  }

  // Keep the highlight locked to the route shape.
  // The live/scheduled marker positions are already interpolated from the same shape,
  // so this uses the actual route geometry instead of drawing a straight connector.
  return segment;
}

function drawGhostRouteSegmentForTrip(tripId) {
  clearGhostRouteSegmentLine();

  if (trackingMode !== "ghost" || !tripId) return;

  const trip = tripLookupByTripId[tripId];
  if (!trip) return;

  const scheduledPosition = latestTripPositionsByTripId[tripId];
  const livePosition = latestLiveTripPositionsByTripId[tripId];
  const shapeCoords = allShapes[trip.shapeId];

  if (!scheduledPosition?.position || !livePosition?.position || !shapeCoords) return;

  const delaySeconds = getStableLiveDelaySeconds(tripId);

  // Avoid visual noise for tiny differences.
  // Under 30 seconds, the scheduled/live positions are effectively the same for this demo.
  if (Math.abs(delaySeconds) < 30) return;

  const delayStatus = getDelayStatus(delaySeconds);
  const segmentCoords = getShapeSegmentBetweenPositions(
    shapeCoords,
    scheduledPosition.position,
    livePosition.position
  );

  if (segmentCoords.length < 2) return;

  ghostRouteSegmentLine = L.polyline(segmentCoords, {
    color: getDelayColour(delaySeconds),
    weight: 8,
    opacity: 0.96,
    dashArray: delayStatus.className === "on-time" ? null : "8 10",
    lineCap: "round",
    lineJoin: "round",
    className: `ghost-route-segment ${delayStatus.className}`
  }).addTo(map);

  ghostRouteSegmentLine.bringToFront();

  if (busMarkersByTripId[tripId]) busMarkersByTripId[tripId].setZIndexOffset(1200);
  if (liveBusMarkersByTripId[tripId]) liveBusMarkersByTripId[tripId].setZIndexOffset(1300);
}

function renderBusPanel(trip, variant = selectedBusVariant) {
  selectedPanelType = "bus";

  const latestPosition = latestTripPositionsByTripId[trip.tripId];
  const fromStopName = latestPosition?.stopA?.name
    ? cleanStopName(latestPosition.stopA.name)
    : "Current stop unavailable";
  const toStopName = latestPosition?.stopB?.name
    ? cleanStopName(latestPosition.stopB.name)
    : "Next stop unavailable";

  const delaySeconds = getStableLiveDelaySeconds(trip.tripId);
  const delayStatus = getDelayStatus(delaySeconds);
  const variantLabel = variant === "scheduled" ? "Scheduled position" : "Simulated live position";

  selectionPanelContent.innerHTML = `
    <section class="panel-section bus-panel-section">
      <div class="bus-summary-row">
        <div class="route-badge route-badge-${escapeHTML(getTransportMode(trip))}">${escapeHTML(getTransportLabel(trip))}</div>

        <div class="panel-text-stack">
          <div class="panel-subtitle">${escapeHTML(variantLabel)}</div>
          <div class="panel-title">${escapeHTML(trip.headsign)}</div>
        </div>

        <div class="delay-chip ${escapeHTML(delayStatus.className)}" title="${escapeHTML(delayStatus.detail)}">
          <span class="delay-value">${escapeHTML(delayStatus.text)}</span>
          <span class="delay-detail">${escapeHTML(delayStatus.detail)}</span>
        </div>
      </div>

      <div class="between-card">
        <div class="between-label">Between</div>
        <div class="between-carousel" aria-label="Between ${escapeHTML(fromStopName)} and ${escapeHTML(toStopName)}">
          <div class="between-carousel-track">
            <span class="between-stop between-stop-from">${escapeHTML(fromStopName)}</span>
            <img src="between_arrow.svg" alt="to" class="between-arrow-icon">
            <span class="between-stop between-stop-to">${escapeHTML(toStopName)}</span>
          </div>
        </div>
      </div>
    </section>
  `;

  applyBetweenCarouselIfNeeded();
  showMapPinForTrip(trip, variant);
  showSelectionPanel();
}

function applyBetweenCarouselIfNeeded() {
  window.requestAnimationFrame(() => {
    const carousel = selectionPanelContent.querySelector(".between-carousel");
    const track = selectionPanelContent.querySelector(".between-carousel-track");

    if (!carousel || !track) return;

    const overflowDistance = Math.max(0, track.scrollWidth - carousel.clientWidth);

    carousel.classList.toggle("is-overflowing", overflowDistance > 8);
    track.style.setProperty("--between-pan-distance", `${overflowDistance}px`);
  });
}

function getFutureStopIdsForTrips(tripIds) {
  const futureStopIds = new Set();
  const currentSeconds = getCurrentSecondsPrecise();

  timetableTrips.forEach(trip => {
    if (!tripIds.has(trip.tripId)) return;
    if (!trip.stops || trip.stops.length === 0) return;

    const firstDepartureSeconds = timeToSeconds(trip.stops[0].departureTime);
    const lastArrivalSeconds = timeToSeconds(trip.stops[trip.stops.length - 1].arrivalTime);

    if (currentSeconds < firstDepartureSeconds) {
      trip.stops.forEach(stopTime => {
        futureStopIds.add(stopTime.stopId);
      });
      return;
    }

    if (currentSeconds > lastArrivalSeconds) return;

    let firstFutureStopIndex = trip.stops.findIndex(stopTime => {
      const arrivalSeconds = timeToSeconds(stopTime.arrivalTime);
      const departureSeconds = timeToSeconds(stopTime.departureTime);

      return arrivalSeconds >= currentSeconds || departureSeconds >= currentSeconds;
    });

    if (firstFutureStopIndex === -1) return;

    const firstFutureStop = trip.stops[firstFutureStopIndex];
    const firstFutureDepartureSeconds = timeToSeconds(firstFutureStop.departureTime);

    if (currentSeconds > firstFutureDepartureSeconds) {
      firstFutureStopIndex += 1;
    }

    for (let i = firstFutureStopIndex; i < trip.stops.length; i++) {
      futureStopIds.add(trip.stops[i].stopId);
    }
  });

  return futureStopIds;
}


// ---------- Stop marker styling and interaction ----------
function getDefaultStopStyleForZoom(zoom = map.getZoom()) {
  // Stop dots are high-detail infrastructure. Keep them hidden until the
  // user is close enough to interact with individual stops.
  if (zoom < STOP_DOTS_MIN_ZOOM) {
    return {
      radius: 0,
      color: "#94a3b8",
      weight: 0,
      fillColor: "#2563eb",
      fillOpacity: 0,
      opacity: 0
    };
  }

  if (zoom === STOP_DOTS_MIN_ZOOM) {
    return {
      radius: 3.6,
      color: "#64748b",
      weight: 1,
      fillColor: "#2563eb",
      fillOpacity: 0.68,
      opacity: 0.75
    };
  }

  return {
    radius: 5,
    color: "#475569",
    weight: 1.25,
    fillColor: "#2563eb",
    fillOpacity: 0.85,
    opacity: 1
  };
}

function getStopHitAreaStyleForZoom(zoom = map.getZoom()) {
  // Invisible tap target. Keep it larger than the visual stop dot on mobile,
  // but hidden while stop dots are hidden so zoomed-out maps do not catch
  // accidental stop taps.
  if (zoom < STOP_DOTS_MIN_ZOOM) {
    return {
      radius: 0,
      color: "transparent",
      weight: 0,
      fillColor: "transparent",
      fillOpacity: 0,
      opacity: 0
    };
  }

  if (zoom >= 17) {
    return {
      radius: 12,
      color: "transparent",
      weight: 0,
      fillColor: "transparent",
      fillOpacity: 0,
      opacity: 0
    };
  }

  if (zoom >= 16) {
    return {
      radius: 15,
      color: "transparent",
      weight: 0,
      fillColor: "transparent",
      fillOpacity: 0,
      opacity: 0
    };
  }

  return {
    radius: 18,
    color: "transparent",
    weight: 0,
    fillColor: "transparent",
    fillOpacity: 0,
    opacity: 0
  };
}

function applyStopHitAreaStylesForZoom() {
  const style = getStopHitAreaStyleForZoom();

  Object.keys(stopHitMarkersByStopId).forEach(stopId => {
    stopHitMarkersByStopId[stopId].setStyle(style);
  });
}

function selectStop(stop) {
  if ((journeyStart || journeyEnd) && !journeyPickMode) {
    selectedStopId = stop.id;
    showStopMapAction(stop);
    highlightJourneyMarkers();
    return;
  }

  if (journeyPickMode === "start" || journeyPickMode === "end") {
    selectedStopId = stop.id;
    showStopMapAction(stop);
    highlightJourneyMarkers();
    return;
  }

  clearJourneyRouteLines();
  clearBusFocus();
  clearNetworkLayer();

  const upcoming = getUpcomingForStop(stop.id, 30);

  focusTripsForStop(stop.id, upcoming);
  drawStopUpcomingPaths(upcoming);
  highlightRelevantStopMarkers(stop.id, upcoming);
  renderStopPanel(stop, upcoming);
}

function applyDefaultStopMarkerStylesForZoom() {
  const style = getDefaultStopStyleForZoom();

  Object.keys(stopMarkersByStopId).forEach(stopId => {
    const marker = stopMarkersByStopId[stopId];

    if (pinnedStopIds.has(stopId)) {
      marker.setStyle({
        radius: map.getZoom() < STOP_DOTS_MIN_ZOOM ? 6 : 7,
        color: "#7c2d12",
        weight: 3,
        fillColor: "#f97316",
        fillOpacity: 1,
        opacity: 1
      });
      marker.bringToFront();
      return;
    }

    marker.setStyle(style);
  });
}

function resetStopMarkerStyles() {
  applyDefaultStopMarkerStylesForZoom();
  applyStopHitAreaStylesForZoom();
}

function highlightRelevantStopMarkers(selectedStopId, upcomingItems) {
  const tripIds = new Set(upcomingItems.map(item => item.tripId));
  const relevantStopIds = getFutureStopIdsForTrips(tripIds);

  relevantStopIds.add(selectedStopId);

  Object.keys(stopMarkersByStopId).forEach(stopId => {
    const marker = stopMarkersByStopId[stopId];

    if (stopId === selectedStopId) {
      marker.setStyle({
        radius: 8,
        color: "#1d4ed8",
        weight: 3,
        fillColor: "#2563eb",
        fillOpacity: 1,
        opacity: 1
      });
      marker.bringToFront();
      return;
    }

    if (relevantStopIds.has(stopId)) {
      marker.setStyle({
        radius: 5,
        color: "#111827",
        weight: 2,
        fillColor: "#ffffff",
        fillOpacity: 1,
        opacity: 1
      });
      marker.bringToFront();
      return;
    }

    marker.setStyle({
      radius: 3,
      color: "#cbd5e1",
      weight: 1,
      fillColor: "#e5e7eb",
      fillOpacity: 0.08,
      opacity: 0.12
    });
  });
}

function getFutureStopDetailsForTrip(tripId) {
  const trip = tripLookupByTripId[tripId];

  if (!trip || !trip.stops || trip.stops.length === 0) {
    return {
      trip: null,
      futureStopIds: new Set(),
      nextStopId: null
    };
  }

  const currentSeconds = getCurrentSecondsPrecise();
  const firstDepartureSeconds = timeToSeconds(trip.stops[0].departureTime);
  const lastArrivalSeconds = timeToSeconds(trip.stops[trip.stops.length - 1].arrivalTime);

  if (currentSeconds > lastArrivalSeconds) {
    return {
      trip,
      futureStopIds: new Set(),
      nextStopId: null
    };
  }

  let firstFutureStopIndex = 0;

  if (currentSeconds >= firstDepartureSeconds) {
    firstFutureStopIndex = trip.stops.findIndex(stopTime => {
      const arrivalSeconds = timeToSeconds(stopTime.arrivalTime);
      const departureSeconds = timeToSeconds(stopTime.departureTime);

      return arrivalSeconds >= currentSeconds || departureSeconds >= currentSeconds;
    });

    if (firstFutureStopIndex === -1) {
      return {
        trip,
        futureStopIds: new Set(),
        nextStopId: null
      };
    }

    const firstFutureStop = trip.stops[firstFutureStopIndex];
    const firstFutureDepartureSeconds = timeToSeconds(firstFutureStop.departureTime);

    if (currentSeconds > firstFutureDepartureSeconds) {
      firstFutureStopIndex += 1;
    }
  }

  const futureStopIds = new Set();

  for (let i = firstFutureStopIndex; i < trip.stops.length; i++) {
    futureStopIds.add(trip.stops[i].stopId);
  }

  return {
    trip,
    futureStopIds,
    nextStopId: trip.stops[firstFutureStopIndex]?.stopId || null
  };
}

function highlightFutureStopMarkersForTrip(tripId) {
  const { futureStopIds, nextStopId } = getFutureStopDetailsForTrip(tripId);

  Object.keys(stopMarkersByStopId).forEach(stopId => {
    const marker = stopMarkersByStopId[stopId];

    if (stopId === nextStopId) {
      marker.setStyle({
        radius: 7,
        color: "#92400e",
        weight: 3,
        fillColor: "#f59e0b",
        fillOpacity: 1,
        opacity: 1
      });
      marker.bringToFront();
      return;
    }

    if (futureStopIds.has(stopId)) {
      marker.setStyle({
        radius: 5,
        color: "#111827",
        weight: 2,
        fillColor: "#ffffff",
        fillOpacity: 1,
        opacity: 1
      });
      marker.bringToFront();
      return;
    }

    marker.setStyle({
      radius: 3,
      color: "#cbd5e1",
      weight: 1,
      fillColor: "#e5e7eb",
      fillOpacity: 0.08,
      opacity: 0.12
    });
  });
}


// ---------- Multi-scale network route layer ----------
function clearNetworkLayer() {
  Object.keys(networkRouteLinesByShapeId).forEach(shapeId => {
    map.removeLayer(networkRouteLinesByShapeId[shapeId]);
  });

  networkRouteLinesByShapeId = {};
}

function getNetworkLineStyleForTrip(trip) {
  const mode = getTransportMode(trip);

  if (mode === "train") {
    return { color: "#7c3aed", weight: 3.5, opacity: 0.22 };
  }

  if (mode === "ferry") {
    return { color: "#0284c7", weight: 3, opacity: 0.24, dashArray: "7 9" };
  }

  if (mode === "tram" || mode === "subway") {
    return { color: "#0891b2", weight: 3, opacity: 0.22 };
  }

  return { color: "#334155", weight: 2.4, opacity: 0.16 };
}

function shapeTouchesExpandedViewport(shapeCoords) {
  if (!shapeCoords || shapeCoords.length === 0) return false;

  const bounds = map.getBounds().pad(0.18);
  const step = Math.max(1, Math.floor(shapeCoords.length / 28));

  for (let i = 0; i < shapeCoords.length; i += step) {
    if (bounds.contains(L.latLng(shapeCoords[i][0], shapeCoords[i][1]))) {
      return true;
    }
  }

  const last = shapeCoords[shapeCoords.length - 1];
  return bounds.contains(L.latLng(last[0], last[1]));
}

function updateNetworkLayer() {
  const zoom = map.getZoom();

  // The network layer is for wide/mid zoom. Once the user is close enough,
  // detailed markers, stop dots, and selected route paths take over.
  if (selectedTripId || selectedStopId || journeyStart || journeyEnd || journeyPickMode || latestJourneyOptions.length || zoom > NETWORK_LAYER_MAX_ZOOM) {
    clearNetworkLayer();
    return;
  }

  const currentSeconds = getCurrentSecondsPrecise();
  const desiredShapeIds = new Set();
  const tripByShapeId = {};

  timetableTrips.forEach(trip => {
    if (!tripMatchesMapFilters(trip)) return;
    if (!tripIsActiveAtSeconds(trip, currentSeconds)) return;

    const shapeCoords = allShapes[trip.shapeId];
    if (!shapeCoords || !shapeTouchesExpandedViewport(shapeCoords)) return;

    desiredShapeIds.add(trip.shapeId);
    if (!tripByShapeId[trip.shapeId]) {
      tripByShapeId[trip.shapeId] = trip;
    }
  });

  Object.keys(networkRouteLinesByShapeId).forEach(shapeId => {
    if (!desiredShapeIds.has(shapeId)) {
      map.removeLayer(networkRouteLinesByShapeId[shapeId]);
      delete networkRouteLinesByShapeId[shapeId];
    }
  });

  desiredShapeIds.forEach(shapeId => {
    if (networkRouteLinesByShapeId[shapeId]) return;

    const shapeCoords = allShapes[shapeId];
    const trip = tripByShapeId[shapeId];
    const style = getNetworkLineStyleForTrip(trip);

    const line = L.polyline(shapeCoords, {
      ...style,
      interactive: false,
      lineCap: "round",
      lineJoin: "round",
      className: `network-route-line network-${getTransportMode(trip)}`
    }).addTo(map);

    line.bringToBack();
    networkRouteLinesByShapeId[shapeId] = line;
  });
}

function clearStopRouteLines() {
  stopRouteLines.forEach(line => {
    map.removeLayer(line);
  });

  stopRouteLines = [];
}

function drawStopUpcomingPaths(upcomingItems) {
  clearStopRouteLines();

  const uniqueShapeIds = [...new Set(upcomingItems.map(item => item.shapeId))];

  uniqueShapeIds.forEach(shapeId => {
    const shapeCoords = allShapes[shapeId];

    if (!shapeCoords) return;

    const line = L.polyline(shapeCoords, {
      renderer: routeFlowRenderer,
      color: "#94a3b8",
      weight: 4,
      opacity: 0.58,
      dashArray: "8 20",
      lineCap: "round",
      lineJoin: "round",
      className: "stop-route-flow-line"
    }).addTo(map);

    line.bringToBack();

    stopRouteLines.push(line);
  });
}


// ---------- Journey planning ----------
function clearJourneyRouteLines() {
  journeyRouteLines.forEach(line => {
    map.removeLayer(line);
  });

  journeyStopTimeMarkers.forEach(marker => {
    map.removeLayer(marker);
  });

  journeyRouteLines = [];
  journeyStopTimeMarkers = [];
}

function getJourneyStartStopId() {
  if (!journeyStart) return null;
  return journeyStart.type === "gps" ? journeyStart.nearestStopId : (journeyStart.stopId || journeyStart.nearestStopId);
}

function getJourneyEndStopId() {
  if (!journeyEnd) return null;
  return journeyEnd.stopId || journeyEnd.nearestStopId || null;
}

function getJourneyStartLabel() {
  if (!journeyStart) return "";
  if (journeyStart.type === "gps") return "Your location";
  return journeyStart.label || getStopDisplayName(getJourneyStartStopId(), "Start");
}

function getJourneyEndLabel() {
  if (!journeyEnd) return "";
  return journeyEnd.label || getStopDisplayName(getJourneyEndStopId(), "Destination");
}

const WALKING_METRES_PER_MINUTE = 80;
const JOURNEY_NEARBY_STOP_LIMIT = 6;
const JOURNEY_NEARBY_STOP_RADIUS_METRES = 1200;
const PERTH_SEARCH_VIEWBOX = "115.55,-32.25,116.15,-31.65";
const JOURNEY_AUTOCOMPLETE_DEBOUNCE_MS = 280;
const JOURNEY_AUTOCOMPLETE_MIN_CHARS = 3;

function degreesToRadians(value) {
  return value * Math.PI / 180;
}

function distanceMetresBetweenLatLon(lat1, lon1, lat2, lon2) {
  const earthRadiusMetres = 6371000;
  const dLat = degreesToRadians(lat2 - lat1);
  const dLon = degreesToRadians(lon2 - lon1);
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
    + Math.cos(degreesToRadians(lat1)) * Math.cos(degreesToRadians(lat2))
    * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return earthRadiusMetres * c;
}

function formatDistance(metres) {
  if (!Number.isFinite(metres)) return "--";
  if (metres >= 1000) return `${(metres / 1000).toFixed(1)}km`;
  return `${Math.round(metres)}m`;
}

function estimateWalkingMinutes(metres) {
  if (!Number.isFinite(metres)) return 0;
  return Math.max(1, Math.ceil(metres / WALKING_METRES_PER_MINUTE));
}

function findNearestStops(lat, lon, limit = JOURNEY_NEARBY_STOP_LIMIT, maxMetres = JOURNEY_NEARBY_STOP_RADIUS_METRES) {
  return Object.values(stopLookup)
    .map(stop => ({
      stop,
      distanceMetres: distanceMetresBetweenLatLon(lat, lon, stop.lat, stop.lon)
    }))
    .filter(item => item.distanceMetres <= maxMetres)
    .sort((a, b) => a.distanceMetres - b.distanceMetres)
    .slice(0, limit);
}

function findNearestStopWithDistance(lat, lon) {
  const nearest = findNearestStops(lat, lon, 1, Infinity)[0];
  return nearest || null;
}

function showJourneySearchStatus(title, message) {
  selectionPanel.classList.remove("journey-options-mode");
  selectionPanelContent.innerHTML = `
    <section class="panel-section journey-panel-section">
      <div class="journey-search-status">
        <div class="panel-title">${escapeHTML(title)}</div>
        <div class="panel-subtitle">${escapeHTML(message)}</div>
      </div>
    </section>
  `;
  showSelectionPanel();
}

function buildJourneySearchText(query) {
  const cleaned = String(query || "").trim();
  if (!cleaned) return "";
  return /perth|western australia|\bwa\b/i.test(cleaned)
    ? cleaned
    : `${cleaned}, Perth, Western Australia`;
}

function normaliseJourneyPlaceResult(result, fallbackLabel = "Place") {
  if (!result) return null;

  const lat = Number(result.lat);
  const lon = Number(result.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const parts = String(result.display_name || fallbackLabel)
    .split(",")
    .map(part => part.trim())
    .filter(Boolean);

  const main = result.name || parts[0] || fallbackLabel;
  const secondary = parts.slice(result.name ? 0 : 1, result.name ? 4 : 4).join(", ");

  return {
    label: main,
    fullLabel: parts.join(", ") || main,
    secondaryLabel: secondary,
    lat,
    lon,
    raw: result
  };
}

async function searchJourneyPlaces(query, limit = 6) {
  const cleaned = String(query || "").trim();
  if (cleaned.length < JOURNEY_AUTOCOMPLETE_MIN_CHARS) return [];

  const params = new URLSearchParams({
    format: "jsonv2",
    q: buildJourneySearchText(cleaned),
    limit: String(limit),
    countrycodes: "au",
    viewbox: PERTH_SEARCH_VIEWBOX,
    bounded: "0",
    addressdetails: "1"
  });

  const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
    headers: { "Accept": "application/json" }
  });

  if (!response.ok) throw new Error("Location search failed");
  const results = await response.json();
  return (Array.isArray(results) ? results : [])
    .map(result => normaliseJourneyPlaceResult(result, cleaned))
    .filter(Boolean);
}

async function geocodeJourneyPlace(query) {
  const results = await searchJourneyPlaces(query, 1);
  return results[0] || null;
}

function setJourneyInputValues() {
  if (journeyStartInput) journeyStartInput.value = getJourneyStartLabel();
  if (journeyEndInput) journeyEndInput.value = getJourneyEndLabel();
}

function getStopDisplayName(stopId, fallback = "Not set") {
  const stop = stopLookup[stopId];
  return stop?.name || fallback;
}

function cancelJourneyOverlayPeekTimer() {
  if (journeyOverlayCollapseTimer) {
    clearTimeout(journeyOverlayCollapseTimer);
    journeyOverlayCollapseTimer = null;
  }
}

function expandJourneyOverlay() {
  if (!journeyOverlay) return;
  journeyOverlay.classList.remove("is-peeking");
}

function scheduleJourneyOverlayPeek() {
  if (!journeyOverlay) return;

  cancelJourneyOverlayPeekTimer();

  const startStopId = getJourneyStartStopId();
  const endStopId = getJourneyEndStopId() || null;
  const canPeek = Boolean(startStopId || endStopId) && !journeyPickMode && !journeyOverlay.classList.contains("is-hidden");

  if (!canPeek) {
    journeyOverlay.classList.remove("is-peeking");
    return;
  }

  journeyOverlayCollapseTimer = setTimeout(() => {
    if (!journeyPickMode && !journeyOverlay.classList.contains("is-hidden")) {
      journeyOverlay.classList.add("is-peeking");
    }
  }, 5000);
}

function markJourneyOverlayTouched() {
  expandJourneyOverlay();
  scheduleJourneyOverlayPeek();
}

function renderJourneyOverlay() {
  if (!journeyOverlay) return;

  const startStopId = getJourneyStartStopId();
  const endStopId = getJourneyEndStopId();

  // The destination planner is now a permanent control. It can still peek/collapse,
  // but it should not disappear just because no journey has been entered yet.
  journeyOverlay.classList.remove("is-hidden");

  if (journeyStartValue) {
    const pickingStart = journeyPickMode === "start";
    journeyStartValue.textContent = pickingStart
      ? "Select on map"
      : startStopId
        ? getJourneyStartLabel()
        : "Use my location or enter start";
    journeyStartValue.classList.toggle("is-placeholder", pickingStart || !startStopId);
  }

  if (journeyEndValue) {
    const pickingEnd = journeyPickMode === "end";
    journeyEndValue.textContent = pickingEnd
      ? "Select on map"
      : endStopId
        ? getJourneyEndLabel()
        : "Where to?";
    journeyEndValue.classList.toggle("is-placeholder", pickingEnd || !endStopId);
  }

  if (journeyStartInput && document.activeElement !== journeyStartInput) {
    journeyStartInput.value = getJourneyStartLabel();
  }

  if (journeyEndInput && document.activeElement !== journeyEndInput) {
    journeyEndInput.value = getJourneyEndLabel();
  }

  journeyStartEditButton?.classList.toggle("is-editing", journeyPickMode === "start");
  journeyEndEditButton?.classList.toggle("is-editing", journeyPickMode === "end");

  scheduleJourneyOverlayPeek();
}

function hideStopMapAction() {
  stopMapActionStopId = null;
  if (stopMapAction) stopMapAction.classList.add("is-hidden");
}

function getStopMapActionHTML(stop) {
  if (journeyPickMode === "start") {
    return `<button class="stop-map-action-button" type="button" data-stop-map-action="start">Add to From</button>`;
  }

  if (journeyPickMode === "end") {
    return `<button class="stop-map-action-button" type="button" data-stop-map-action="destination">Add to To</button>`;
  }

  if (getJourneyStartStopId()) {
    return `<button class="stop-map-action-button" type="button" data-stop-map-action="destination">Set destination</button>`;
  }

  return `
    <div class="stop-map-action-stack">
      <button class="stop-map-action-button stop-map-action-secondary" type="button" data-stop-map-action="start">Start here</button>
      <button class="stop-map-action-button" type="button" data-stop-map-action="destination">Set destination</button>
    </div>
  `;
}

function positionStopMapAction(stop) {
  if (!stopMapAction || !stop) return;

  const point = map.latLngToContainerPoint([stop.lat, stop.lon]);
  stopMapAction.style.left = `${point.x}px`;
  stopMapAction.style.top = `${point.y}px`;
}

function showStopMapAction(stop) {
  if (!stopMapAction || !stop) return;

  stopMapActionStopId = stop.id;
  stopMapAction.innerHTML = getStopMapActionHTML(stop);
  stopMapAction.classList.remove("is-hidden");
  positionStopMapAction(stop);
}

function handleStopMapAction(action) {
  const stop = stopLookup[stopMapActionStopId];
  if (!stop) return;

  if (action === "start" || journeyPickMode === "start") {
    setJourneyStartFromStop(stop);
    return;
  }

  setJourneyEndFromStop(stop);
}

function fitJourneyBounds(options = []) {
  const bounds = [];
  const startStop = stopLookup[getJourneyStartStopId()];
  const endStop = stopLookup[getJourneyEndStopId()];

  if (startStop) bounds.push([startStop.lat, startStop.lon]);
  if (endStop) bounds.push([endStop.lat, endStop.lon]);

  options.slice(0, 5).forEach(option => {
    const shapeCoords = allShapes[option.shapeId];
    const optionStartStop = stopLookup[option.originStopId || getJourneyStartStopId()];
    const optionEndStop = stopLookup[option.destinationStopId || getJourneyEndStopId()];
    if (!shapeCoords?.length || !optionStartStop || !optionEndStop) return;

    getShapeSegmentBetweenStops(shapeCoords, optionStartStop, optionEndStop).forEach(coord => bounds.push(coord));

    const busLatLng = getJourneyOptionLiveLatLng(option);
    if (busLatLng) {
      getShapeSegmentToStop(shapeCoords, busLatLng, optionStartStop).forEach(coord => bounds.push(coord));
    }
  });

  if (bounds.length < 2) return;

  map.fitBounds(L.latLngBounds(bounds), {
    paddingTopLeft: [28, 120],
    paddingBottomRight: [28, 260],
    maxZoom: 15,
    animate: true
  });
}

function setJourneyStartFromStop(stop) {
  journeySelectedPlaces.start = null;
  journeyStart = {
    type: "stop",
    stopId: stop.id
  };
  journeyPickMode = null;
  hideStopMapAction();
  clearAllJourneySuggestions();
  renderJourneyOverlay();
  highlightJourneyMarkers();

  if (journeyEnd) {
    showJourneyOptions();
    return;
  }

  renderJourneyPrompt("Start set", "Now tap a destination stop.", "end");
  renderJourneyOverlay();
}

function setJourneyEndFromStop(stop) {
  journeySelectedPlaces.end = null;
  journeyEnd = {
    type: "stop",
    stopId: stop.id
  };
  hideStopMapAction();
  clearAllJourneySuggestions();
  renderJourneyOverlay();

  if (userLocation?.nearestStopId) {
    journeyStart = {
      type: "gps",
      lat: userLocation.lat,
      lon: userLocation.lon,
      nearestStopId: userLocation.nearestStopId
    };
    journeyPickMode = null;
    renderJourneyOverlay();
    showJourneyOptions();
    return;
  }

  journeyPickMode = "start";
  renderJourneyOverlay();
  renderJourneyPrompt("Destination set", `Tap your starting stop, or use your location.`, "start");
  highlightJourneyMarkers();
}

function renderJourneyPrompt(title, message, mode) {
  selectionPanel.classList.remove("journey-options-mode");
  selectionPanelContent.innerHTML = `
    <section class="panel-section journey-panel-section">
      <div class="journey-prompt-card">
        <div class="panel-title">${escapeHTML(title)}</div>
        <div class="panel-subtitle">${escapeHTML(message)}</div>
      </div>

      <div class="journey-action-row">
        <button class="journey-action-button journey-primary-button" type="button" data-journey-use-location>Use my location</button>
        <button class="journey-action-button" type="button" data-journey-clear>Clear plan</button>
      </div>
    </section>
  `;

  const useLocationButton = selectionPanelContent.querySelector("[data-journey-use-location]");
  const clearButton = selectionPanelContent.querySelector("[data-journey-clear]");

  if (useLocationButton) {
    useLocationButton.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      requestUserLocation({ useAsJourneyStart: true });
    });
  }

  if (clearButton) {
    clearButton.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      clearJourneyPlan();
      resetAppView();
    });
  }

  showSelectionPanel();
}

function setJourneyPickMode(mode) {
  journeyPickMode = mode;
  hideStopMapAction();
  renderJourneyOverlay();
  highlightJourneyMarkers();
}

function swapJourneyDirection() {
  journeySelectedPlaces = { start: null, end: null };
  clearAllJourneySuggestions();
  const startStopId = getJourneyStartStopId();
  const endStopId = getJourneyEndStopId() || null;

  if (!startStopId || !endStopId) return;

  journeyStart = {
    type: "stop",
    stopId: endStopId
  };

  journeyEnd = {
    type: "stop",
    stopId: startStopId
  };

  journeyPickMode = null;
  hideStopMapAction();
  renderJourneyOverlay();
  showJourneyOptions();
}

function clearJourneyPlan() {
  journeyStart = null;
  journeyEnd = null;
  journeyPickMode = null;
  selectedJourneyOptionTripId = null;
  latestJourneyOptions = [];
  journeySelectedPlaces = { start: null, end: null };
  highlightedTripIds = new Set();
  clearJourneyRouteLines();
  hideStopMapAction();
  clearAllJourneySuggestions();
  renderJourneyOverlay();
  updateBusPositionsLive();
}

function getJourneyEndpointCoords(endpoint, stopId) {
  if (endpoint?.lat && endpoint?.lon) return { lat: endpoint.lat, lon: endpoint.lon };
  const stop = stopLookup[stopId];
  if (stop) return { lat: stop.lat, lon: stop.lon };
  return null;
}

function getNearbyStopCandidatesForEndpoint(endpoint, stopId) {
  const coords = getJourneyEndpointCoords(endpoint, stopId);

  if (!coords) {
    const stop = stopLookup[stopId];
    return stop ? [{ stop, distanceMetres: 0, walkingMinutes: 0 }] : [];
  }

  const candidates = findNearestStops(coords.lat, coords.lon);

  if (candidates.length) {
    return candidates.map(item => ({
      ...item,
      walkingMinutes: estimateWalkingMinutes(item.distanceMetres)
    }));
  }

  const fallback = findNearestStopWithDistance(coords.lat, coords.lon);
  return fallback ? [{
    ...fallback,
    walkingMinutes: estimateWalkingMinutes(fallback.distanceMetres)
  }] : [];
}

function getJourneyStopCandidateLabel(candidate) {
  if (!candidate?.stop) return "stop";
  return `${cleanStopName(candidate.stop.name)} (${formatDistance(candidate.distanceMetres)} walk)`;
}

function findFastestJourneyOptions() {
  const startStopId = getJourneyStartStopId();
  const endStopId = getJourneyEndStopId();
  if (!startStopId || !endStopId) return [];

  const currentSeconds = getCurrentSecondsPrecise();
  const originCandidates = getNearbyStopCandidatesForEndpoint(journeyStart, startStopId);
  const destinationCandidates = getNearbyStopCandidatesForEndpoint(journeyEnd, endStopId);
  const allOptions = [];

  originCandidates.forEach(originCandidate => {
    destinationCandidates.forEach(destinationCandidate => {
      if (!originCandidate.stop?.id || !destinationCandidate.stop?.id) return;
      if (originCandidate.stop.id === destinationCandidate.stop.id) return;

      findDirectJourneyOptions(originCandidate.stop.id, destinationCandidate.stop.id, {
        earliestDepartureSeconds: currentSeconds + (originCandidate.walkingMinutes * 60)
      }).forEach(option => {
        const busMinutes = Math.max(0, Math.round((timeToSeconds(option.arrivalTime) - timeToSeconds(option.departureTime)) / 60));
        const finalArrivalSeconds = timeToSeconds(option.arrivalTime) + (destinationCandidate.walkingMinutes * 60);
        const totalMinutes = Math.max(1, Math.round((finalArrivalSeconds - currentSeconds) / 60));

        allOptions.push({
          ...option,
          originStopId: originCandidate.stop.id,
          destinationStopId: destinationCandidate.stop.id,
          startWalkMetres: originCandidate.distanceMetres,
          endWalkMetres: destinationCandidate.distanceMetres,
          startWalkMinutes: originCandidate.walkingMinutes,
          endWalkMinutes: destinationCandidate.walkingMinutes,
          busMinutes,
          finalArrivalSeconds,
          totalMinutes,
          originCandidateLabel: getJourneyStopCandidateLabel(originCandidate),
          destinationCandidateLabel: getJourneyStopCandidateLabel(destinationCandidate)
        });
      });
    });
  });

  const deduped = [];
  const seen = new Set();

  allOptions
    .sort((a, b) => a.finalArrivalSeconds - b.finalArrivalSeconds || a.departureSeconds - b.departureSeconds)
    .forEach(option => {
      const key = `${option.tripId}|${option.originStopId}|${option.destinationStopId}`;
      if (seen.has(key)) return;
      seen.add(key);
      deduped.push(option);
    });

  return deduped.slice(0, 8);
}

function findDirectJourneyOptions(originStopId, destinationStopId, options = {}) {
  if (!originStopId || !destinationStopId || originStopId === destinationStopId) return [];

  const currentSeconds = options.earliestDepartureSeconds ?? getCurrentSecondsPrecise();
  const upcomingByTripId = new Map((stopUpcoming[originStopId] || []).map(item => [item.tripId, item]));
  const candidates = [];

  timetableTrips.forEach(trip => {
    if (!trip?.stops?.length) return;

    const originIndex = trip.stops.findIndex(stopTime => stopTime.stopId === originStopId);
    const destinationIndex = trip.stops.findIndex(stopTime => stopTime.stopId === destinationStopId);

    if (originIndex === -1 || destinationIndex === -1 || originIndex >= destinationIndex) return;

    const originStopTime = trip.stops[originIndex];
    const destinationStopTime = trip.stops[destinationIndex];
    const departureSeconds = timeToSeconds(originStopTime.departureTime || originStopTime.arrivalTime);

    if (!Number.isNaN(departureSeconds) && departureSeconds < currentSeconds - 120) return;

    const routeItem = upcomingByTripId.get(trip.tripId) || trip;
    const candidateShapeId = trip.shapeId;

    // Ignore reverse-direction matches. The stop times must be ordered AND the
    // shape must move from the origin stop toward the destination stop.
    if (!journeyOptionHasForwardShape({ shapeId: candidateShapeId }, originStopId, destinationStopId)) return;

    candidates.push({
      trip,
      tripId: trip.tripId,
      routeLabel: getTransportLabel(routeItem),
      transportMode: getTransportMode(routeItem),
      headsign: trip.headsign || routeItem.headsign || "",
      shapeId: trip.shapeId,
      originIndex,
      destinationIndex,
      departureTime: originStopTime.departureTime || originStopTime.arrivalTime,
      arrivalTime: destinationStopTime.arrivalTime || destinationStopTime.departureTime,
      departureSeconds: Number.isNaN(departureSeconds) ? Infinity : departureSeconds,
      delaySeconds: getStableLiveDelaySeconds(trip.tripId),
      delayStatus: getDelayStatus(getStableLiveDelaySeconds(trip.tripId))
    });
  });

  const deduped = [];
  const seenKeys = new Set();

  candidates
    .sort((a, b) => a.departureSeconds - b.departureSeconds)
    .forEach(candidate => {
      const key = `${candidate.routeLabel}|${candidate.headsign}|${candidate.shapeId}`;
      if (seenKeys.has(key)) return;
      seenKeys.add(key);
      deduped.push(candidate);
    });

  return deduped.slice(0, 8);
}

function getShapeSegmentBetweenStops(shapeCoords, startStop, endStop) {
  if (!shapeCoords?.length || !startStop || !endStop) return [];

  const startIndex = findClosestShapeIndex(shapeCoords, startStop);
  const endIndex = findClosestShapeIndex(shapeCoords, endStop);

  if (startIndex === endIndex) {
    return [[startStop.lat, startStop.lon], [endStop.lat, endStop.lon]];
  }

  // Direction matters for journey planning. Do not auto-reverse the shape here,
  // otherwise a reverse-direction service can be drawn as if it matched the trip.
  // If the selected trip's shape is ordered the other way, this candidate is not
  // useful for this direct A -> B preview and should be ignored.
  if (endIndex < startIndex) return [];

  const segment = shapeCoords.slice(startIndex, endIndex + 1);
  segment[0] = [startStop.lat, startStop.lon];
  segment[segment.length - 1] = [endStop.lat, endStop.lon];
  return segment;
}

function getShapeSegmentToStop(shapeCoords, fromPoint, endStop) {
  if (!shapeCoords?.length || !fromPoint || !endStop) return [];

  const fromIndex = findClosestShapeIndex(shapeCoords, { lat: fromPoint[0], lon: fromPoint[1] });
  const endIndex = findClosestShapeIndex(shapeCoords, endStop);

  if (fromIndex === endIndex) return [fromPoint, [endStop.lat, endStop.lon]];
  if (fromIndex < endIndex) return [fromPoint, ...shapeCoords.slice(fromIndex + 1, endIndex + 1), [endStop.lat, endStop.lon]];
  return [fromPoint, ...shapeCoords.slice(endIndex, fromIndex).reverse(), [endStop.lat, endStop.lon]];
}

function journeyOptionHasForwardShape(option, originStopId, destinationStopId) {
  const shapeCoords = allShapes[option?.shapeId];
  const startStop = stopLookup[originStopId];
  const endStop = stopLookup[destinationStopId];

  if (!shapeCoords?.length || !startStop || !endStop) return false;

  const startIndex = findClosestShapeIndex(shapeCoords, startStop);
  const endIndex = findClosestShapeIndex(shapeCoords, endStop);

  return endIndex > startIndex;
}

function getJourneyDelayColour(option) {
  const className = option?.delayStatus?.className || getDelayStatus(option?.delaySeconds || 0).className;
  if (className === "ahead") return "#2563eb";
  if (className === "behind" || className === "very-late") return "#f59e0b";
  return "#16a34a";
}

function getJourneyOptionLiveLatLng(option) {
  const scheduledPosition = latestTripPositionsByTripId[option.tripId];
  const livePosition = latestLiveTripPositionsByTripId[option.tripId];

  // Match the journey preview to the active viewing mode. In Scheduled mode the
  // bus icon moves by timetable, so the approach/ant path must shrink from that
  // same timetable position. In Live/Compare we prefer the live-adjusted point.
  const positionRecord = trackingMode === "scheduled"
    ? scheduledPosition
    : livePosition || scheduledPosition;

  if (!positionRecord) return null;

  const busPoint = positionRecord.position || positionRecord.latLng || positionRecord.coords || null;

  if (Array.isArray(busPoint)) return busPoint;

  if (positionRecord.lat && positionRecord.lon) return [positionRecord.lat, positionRecord.lon];
  if (positionRecord.latitude && positionRecord.longitude) return [positionRecord.latitude, positionRecord.longitude];

  return null;
}

function getMinutesUntilStopTime(stopTime) {
  const seconds = timeToSeconds(stopTime?.arrivalTime || stopTime?.departureTime);
  if (Number.isNaN(seconds)) return null;

  return Math.max(0, Math.round((seconds - getCurrentSecondsPrecise()) / 60));
}

function formatJourneyMinuteBadgeFromSeconds(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  const minutes = Math.max(0, Math.round((seconds - getCurrentSecondsPrecise()) / 60));
  return `${minutes}m`;
}

function drawJourneyStopTimeLabels(option) {
  const stops = option?.trip?.stops || [];
  if (!stops.length) return;

  stops.slice(option.originIndex, option.destinationIndex + 1).forEach((stopTime, index) => {
    const stop = stopLookup[stopTime.stopId];
    if (!stop) return;

    const minutes = getMinutesUntilStopTime(stopTime);
    if (minutes === null) return;

    const marker = L.marker([stop.lat, stop.lon], {
      interactive: false,
      icon: L.divIcon({
        className: "journey-stop-time-marker",
        html: `<span>${index === 0 ? "Board" : `${minutes}m`}</span>`,
        iconSize: [44, 22],
        iconAnchor: [22, 28]
      })
    }).addTo(map);

    journeyStopTimeMarkers.push(marker);
  });
}


function drawJourneyVehicleLabel(option, latLng) {
  if (!option || !latLng) return;

  const colour = getJourneyDelayColour(option);
  const marker = L.marker(latLng, {
    interactive: false,
    zIndexOffset: 1700,
    icon: L.divIcon({
      className: "",
      html: `<div class="journey-vehicle-label" style="--journey-label-colour:${escapeHTML(colour)}">${escapeHTML(option.routeLabel)}</div>`,
      iconSize: [54, 34],
      iconAnchor: [27, 42]
    })
  }).addTo(map);

  journeyStopTimeMarkers.push(marker);
}

function drawJourneyOptionPreview(option) {
  const shapeCoords = allShapes[option.shapeId];
  const startStop = stopLookup[option.originStopId || getJourneyStartStopId()];
  const endStop = stopLookup[option.destinationStopId || getJourneyEndStopId()];
  const colour = getJourneyDelayColour(option);

  if (!shapeCoords || !startStop || !endStop) return;

  const journeySegment = getShapeSegmentBetweenStops(shapeCoords, startStop, endStop);

  if (journeySegment.length >= 2) {
    const journeyLine = L.polyline(journeySegment, {
      renderer: routeFlowRenderer,
      color: colour,
      weight: 5,
      opacity: 0.28,
      lineCap: "round",
      lineJoin: "round",
      className: "journey-preview-route-line"
    }).addTo(map);

    journeyLine.bringToBack();
    journeyRouteLines.push(journeyLine);
  }

  const busLatLng = getJourneyOptionLiveLatLng(option);

  if (busLatLng) {
    const approachSegment = getShapeSegmentToStop(shapeCoords, busLatLng, startStop);

    if (approachSegment.length >= 2) {
      const approachLine = L.polyline(approachSegment, {
        renderer: routeFlowRenderer,
        color: colour,
        weight: 4,
        opacity: 0.72,
        dashArray: "6 14",
        lineCap: "round",
        lineJoin: "round",
        className: "journey-approach-flow-line"
      }).addTo(map);

      approachLine.bringToBack();
      journeyRouteLines.push(approachLine);
    }
  }
}

function drawAllJourneyOptionPreviews(options) {
  clearJourneyRouteLines();
  clearStopRouteLines();
  clearRouteLine();
  clearNetworkLayer();

  options.forEach(drawJourneyOptionPreview);
}

function fitSelectedJourneyOptionBounds(option) {
  const bounds = [];
  const shapeCoords = allShapes[option.shapeId];
  const startStop = stopLookup[option.originStopId || getJourneyStartStopId()];
  const endStop = stopLookup[option.destinationStopId || getJourneyEndStopId()];
  const busLatLng = getJourneyOptionLiveLatLng(option);

  if (busLatLng) bounds.push(busLatLng);
  if (startStop) bounds.push([startStop.lat, startStop.lon]);
  if (endStop) bounds.push([endStop.lat, endStop.lon]);

  if (shapeCoords && startStop && endStop) {
    getShapeSegmentBetweenStops(shapeCoords, startStop, endStop).forEach(coord => bounds.push(coord));
    if (busLatLng) getShapeSegmentToStop(shapeCoords, busLatLng, startStop).forEach(coord => bounds.push(coord));
  }

  if (bounds.length < 2) return;

  map.fitBounds(L.latLngBounds(bounds), {
    paddingTopLeft: [28, 120],
    paddingBottomRight: [28, 260],
    maxZoom: 15,
    animate: true
  });
}

function drawSelectedJourneyOption(option) {
  clearJourneyRouteLines();
  clearStopRouteLines();
  clearRouteLine();
  clearNetworkLayer();

  if (!option) return;

  const shapeCoords = allShapes[option.shapeId];
  const startStop = stopLookup[option.originStopId || getJourneyStartStopId()];
  const endStop = stopLookup[option.destinationStopId || getJourneyEndStopId()];
  const colour = getJourneyDelayColour(option);

  if (!shapeCoords || !startStop || !endStop) return;

  const journeySegment = getShapeSegmentBetweenStops(shapeCoords, startStop, endStop);

  if (journeySegment.length >= 2) {
    const journeyLine = L.polyline(journeySegment, {
      renderer: routeFlowRenderer,
      color: colour,
      weight: 7,
      opacity: 0.92,
      lineCap: "round",
      lineJoin: "round",
      className: "journey-selected-solid-line"
    }).addTo(map);

    journeyLine.bringToBack();
    journeyRouteLines.push(journeyLine);
  }

  const busLatLng = getJourneyOptionLiveLatLng(option);

  if (busLatLng) {
    const approachSegment = getShapeSegmentToStop(shapeCoords, busLatLng, startStop);

    if (approachSegment.length >= 2) {
      const approachLine = L.polyline(approachSegment, {
        renderer: routeFlowRenderer,
        color: colour,
        weight: 5,
        opacity: 0.68,
        dashArray: "6 14",
        lineCap: "round",
        lineJoin: "round",
        className: "journey-approach-flow-line"
      }).addTo(map);

      approachLine.bringToBack();
      journeyRouteLines.push(approachLine);
    }
  }

  drawJourneyStopTimeLabels(option);
}

function drawJourneyOptionPaths(options) {
  selectedJourneyOptionTripId = null;
  latestJourneyOptions = options;
  drawAllJourneyOptionPreviews(options);
}

function getSelectedJourneyOption() {
  if (!selectedJourneyOptionTripId) return null;
  return latestJourneyOptions.find(item => item.tripId === selectedJourneyOptionTripId) || null;
}

function redrawSelectedJourneyOption() {
  const option = getSelectedJourneyOption();
  if (!option) return;

  drawSelectedJourneyOption(option);
  highlightJourneyMarkers();
}

function unselectJourneyOption() {
  selectedJourneyOptionTripId = null;
  highlightedTripIds = new Set(latestJourneyOptions.map(option => option.tripId));
  selectedTripId = null;
  selectedStopId = null;

  drawAllJourneyOptionPreviews(latestJourneyOptions);
  updateBusPositionsLive();
  highlightJourneyMarkers();
  updateJourneyOptionSelectionUI();
  fitJourneyBounds(latestJourneyOptions);
}

function selectJourneyOption(tripId) {
  if (selectedJourneyOptionTripId === tripId) {
    unselectJourneyOption();
    return;
  }

  const option = latestJourneyOptions.find(item => item.tripId === tripId);
  if (!option) return;

  selectedJourneyOptionTripId = tripId;
  highlightedTripIds = new Set([tripId]);
  selectedTripId = null;
  selectedStopId = null;

  updateBusPositionsLive();
  redrawSelectedJourneyOption();
  updateJourneyOptionSelectionUI();
  fitSelectedJourneyOptionBounds(option);
}

function highlightJourneyMarkers() {
  const startStopId = getJourneyStartStopId();
  const endStopId = getJourneyEndStopId() || null;
  const isCompleteJourney = Boolean(startStopId && endStopId && !journeyPickMode);
  const visibleJourneyStopIds = new Set([startStopId, endStopId].filter(Boolean));

  latestJourneyOptions.forEach(option => {
    if (option.originStopId) visibleJourneyStopIds.add(option.originStopId);
    if (option.destinationStopId) visibleJourneyStopIds.add(option.destinationStopId);
  });

  applyDefaultStopMarkerStylesForZoom();

  Object.keys(stopMarkersByStopId).forEach(stopId => {
    const marker = stopMarkersByStopId[stopId];

    if (isCompleteJourney && !visibleJourneyStopIds.has(stopId)) {
      marker.setStyle({
        radius: 0,
        color: "transparent",
        weight: 0,
        fillColor: "transparent",
        fillOpacity: 0,
        opacity: 0
      });
      return;
    }

    const selectedOption = getSelectedJourneyOption();
    const isSelectedBoardingStop = selectedOption?.originStopId === stopId;
    const isSelectedAlightingStop = selectedOption?.destinationStopId === stopId;

    if (stopId === startStopId || isSelectedBoardingStop) {
      marker.setStyle({
        radius: 9,
        color: "#047857",
        weight: 3,
        fillColor: "#10b981",
        fillOpacity: 1,
        opacity: 1
      });
      marker.bringToFront();
    }

    if (stopId === endStopId || isSelectedAlightingStop) {
      marker.setStyle({
        radius: 9,
        color: "#6d28d9",
        weight: 3,
        fillColor: "#8b5cf6",
        fillOpacity: 1,
        opacity: 1
      });
      marker.bringToFront();
    }
  });
}

function scrollSelectedJourneyOptionIntoView() {
  const strip = selectionPanelContent.querySelector(".journey-options-strip");
  const selectedButton = selectionPanelContent.querySelector(".journey-option-pill.is-selected");
  if (!strip || !selectedButton) return;

  const stripRect = strip.getBoundingClientRect();
  const buttonRect = selectedButton.getBoundingClientRect();
  const targetLeft = Math.max(0, strip.scrollLeft + (buttonRect.left - stripRect.left) - 2);

  strip.scrollTo({
    left: targetLeft,
    behavior: "smooth"
  });
}

function updateJourneyOptionSelectionUI() {
  const strip = selectionPanelContent.querySelector(".journey-options-strip");
  if (!strip) return;

  strip.querySelectorAll(".journey-option-pill").forEach(button => {
    button.classList.toggle("is-selected", button.getAttribute("data-trip-id") === selectedJourneyOptionTripId);
  });

  if (selectedJourneyOptionTripId) {
    window.requestAnimationFrame(scrollSelectedJourneyOptionIntoView);
  }
}

function renderJourneyResultsPanel(options) {
  selectionPanel.classList.add("journey-options-mode");
  const optionHTML = options.length
    ? options.map((option, index) => {
        const isSelected = selectedJourneyOptionTripId === option.tripId;
        const status = option.delayStatus || getDelayStatus(option.delaySeconds || 0);
        const departureBadge = formatJourneyMinuteBadgeFromSeconds(option.departureSeconds);
        return `
          <button class="journey-option-pill ${isSelected ? "is-selected" : ""} ${escapeHTML(status.className)}" type="button" data-trip-id="${escapeHTML(option.tripId)}">
            <span class="journey-option-route ${escapeHTML(`arrival-route-${option.transportMode}`)}">${escapeHTML(option.routeLabel)}</span>
            <span class="journey-option-main">${escapeHTML(option.headsign || "Direct service")}</span>
            <span class="journey-option-time">${escapeHTML(formatScheduledClockTime(option.departureTime))} → ${escapeHTML(formatScheduledClockTime(option.arrivalTime))}</span>
            <span class="journey-option-badge">${escapeHTML(option.totalMinutes ? `${option.totalMinutes}m` : departureBadge)}</span>
            <span class="journey-option-meta">${escapeHTML(option.totalMinutes ? `${option.startWalkMinutes}m walk • ${option.busMinutes}m bus • ${option.endWalkMinutes}m walk` : "Direct stop-to-stop")}</span>
          </button>
        `;
      }).join("")
    : `<div class="arrival-empty">No direct route found near those places. Transfers are the next planning layer.</div>`;

  selectionPanelContent.innerHTML = `
    <section class="panel-section journey-panel-section journey-options-only-section">
      <div class="journey-options-strip" aria-label="Journey options">
        ${optionHTML}
      </div>
    </section>
  `;

  selectionPanelContent.querySelectorAll(".journey-option-pill").forEach(button => {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      selectJourneyOption(button.getAttribute("data-trip-id"));
    });
  });

  if (selectedJourneyOptionTripId) {
    window.setTimeout(scrollSelectedJourneyOptionIntoView, 40);
  }

  showSelectionPanel();
}

function getCurrentBrowserLocation() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This browser does not support GPS location."));
      return;
    }

    navigator.geolocation.getCurrentPosition(resolve, reject, {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 30000
    });
  });
}


function getJourneySuggestionsElement(kind) {
  return kind === "start" ? journeyStartSuggestions : journeyEndSuggestions;
}

function getJourneyInputElement(kind) {
  return kind === "start" ? journeyStartInput : journeyEndInput;
}

function clearJourneySuggestions(kind) {
  const list = getJourneySuggestionsElement(kind);
  if (!list) return;
  list.innerHTML = "";
  list.classList.add("is-hidden");
}

function clearAllJourneySuggestions() {
  clearJourneySuggestions("start");
  clearJourneySuggestions("end");
}

function renderJourneySuggestions(kind, places, statusText = "") {
  const list = getJourneySuggestionsElement(kind);
  if (!list) return;

  if (statusText) {
    list.innerHTML = `<div class="journey-place-suggestion is-status">${escapeHTML(statusText)}</div>`;
    list.classList.remove("is-hidden");
    return;
  }

  if (!places.length) {
    clearJourneySuggestions(kind);
    return;
  }

  list.innerHTML = places.map((place, index) => `
    <button class="journey-place-suggestion" type="button" data-place-index="${index}" role="option">
      <span class="journey-place-suggestion-title">${escapeHTML(place.label || place.fullLabel)}</span>
      <span class="journey-place-suggestion-subtitle">${escapeHTML(place.secondaryLabel || place.fullLabel || "")}</span>
    </button>
  `).join("");

  list._journeyPlaces = places;
  list.classList.remove("is-hidden");
}

function selectJourneyPlace(kind, place) {
  if (!place) return;

  journeySelectedPlaces[kind] = place;
  const input = getJourneyInputElement(kind);
  if (input) input.value = place.fullLabel || place.label || "";

  if (kind === "start") {
    applyJourneyPlaceAsStart(place);
  } else {
    applyJourneyPlaceAsEnd(place);
  }

  journeyPickMode = null;
  clearJourneySuggestions(kind);
  hideStopMapAction();
  renderJourneyOverlay();
  highlightJourneyMarkers();

  // Confirmed place selection should orient the user, but it should not zoom/crop the map.
  map.panTo([place.lat, place.lon], { animate: true });
}

function scheduleJourneyAutocomplete(kind, query) {
  const cleaned = String(query || "").trim();
  journeySelectedPlaces[kind] = null;

  if (kind === "start" && journeyStart?.type === "place") journeyStart = null;
  if (kind === "end" && journeyEnd?.type === "place") journeyEnd = null;

  clearTimeout(journeyAutocompleteTimers[kind]);

  if (cleaned.length < JOURNEY_AUTOCOMPLETE_MIN_CHARS) {
    clearJourneySuggestions(kind);
    return;
  }

  const requestId = ++journeyAutocompleteRequestIds[kind];
  renderJourneySuggestions(kind, [], "Searching…");

  journeyAutocompleteTimers[kind] = setTimeout(async () => {
    try {
      const places = await searchJourneyPlaces(cleaned, 6);
      if (requestId !== journeyAutocompleteRequestIds[kind]) return;

      if (!places.length) {
        renderJourneySuggestions(kind, [], "No matching places found");
        return;
      }

      renderJourneySuggestions(kind, places);
    } catch (error) {
      console.warn("Place suggestions failed", error);
      if (requestId === journeyAutocompleteRequestIds[kind]) {
        renderJourneySuggestions(kind, [], "Search unavailable");
      }
    }
  }, JOURNEY_AUTOCOMPLETE_DEBOUNCE_MS);
}

function applyJourneyPlaceAsStart(place) {
  const nearest = findNearestStopWithDistance(place.lat, place.lon);
  if (!nearest) throw new Error("No nearby stop found for the start location.");

  journeyStart = {
    type: "place",
    label: place.label || place.fullLabel,
    fullLabel: place.fullLabel,
    lat: place.lat,
    lon: place.lon,
    stopId: nearest.stop.id,
    nearestStopId: nearest.stop.id,
    nearestStopDistanceMetres: nearest.distanceMetres
  };
}

function applyJourneyPlaceAsEnd(place) {
  const nearest = findNearestStopWithDistance(place.lat, place.lon);
  if (!nearest) throw new Error("No nearby stop found for the destination.");

  journeyEnd = {
    type: "place",
    label: place.label || place.fullLabel,
    fullLabel: place.fullLabel,
    lat: place.lat,
    lon: place.lon,
    stopId: nearest.stop.id,
    nearestStopId: nearest.stop.id,
    nearestStopDistanceMetres: nearest.distanceMetres
  };
}

async function resolveJourneyStartFromInput() {
  const query = String(journeyStartInput?.value || "").trim();

  if (query) {
    if (journeyStart?.type === "place" && journeyStart.fullLabel && query === journeyStart.fullLabel) return;
    if (journeySelectedPlaces.start) {
      applyJourneyPlaceAsStart(journeySelectedPlaces.start);
      return;
    }

    const place = await geocodeJourneyPlace(query);
    if (!place) throw new Error("Start location was not found. Pick one of the suggestions or use a more specific address/suburb.");
    applyJourneyPlaceAsStart(place);
    return;
  }

  if (userLocation?.nearestStopId) {
    journeyStart = {
      type: "gps",
      label: "Your location",
      lat: userLocation.lat,
      lon: userLocation.lon,
      stopId: userLocation.nearestStopId,
      nearestStopId: userLocation.nearestStopId
    };
    return;
  }

  showJourneySearchStatus("Finding your location…", "Allow location access when your browser asks.");
  const position = await getCurrentBrowserLocation();
  const lat = position.coords.latitude;
  const lon = position.coords.longitude;
  const nearest = findNearestStopWithDistance(lat, lon);
  if (!nearest) throw new Error("No nearby stop found for your location.");

  userLocation = { lat, lon, nearestStopId: nearest.stop.id };
  updateUserLocationMarker(lat, lon);
  journeyStart = {
    type: "gps",
    label: "Your location",
    lat,
    lon,
    stopId: nearest.stop.id,
    nearestStopId: nearest.stop.id
  };
}

async function resolveJourneyEndFromInput() {
  const query = String(journeyEndInput?.value || "").trim();
  if (!query && journeyEnd) return;
  if (!query) throw new Error("Enter a destination first.");

  if (journeyEnd?.type === "place" && journeyEnd.fullLabel && query === journeyEnd.fullLabel) return;
  if (journeySelectedPlaces.end) {
    applyJourneyPlaceAsEnd(journeySelectedPlaces.end);
    return;
  }

  const place = await geocodeJourneyPlace(query);
  if (!place) throw new Error("Destination was not found. Pick one of the suggestions or use a more specific address/suburb.");
  applyJourneyPlaceAsEnd(place);
}

async function handleJourneySearchSubmit() {
  try {
    expandJourneyOverlay();
    journeyPickMode = null;
    showJourneySearchStatus("Finding route…", "Searching places, matching nearby stops, then checking the timetable.");

    await resolveJourneyStartFromInput();
    await resolveJourneyEndFromInput();

    renderJourneyOverlay();
    showJourneyOptions();
  } catch (error) {
    console.warn("Journey search failed", error);
    renderJourneyOverlay();
    showJourneySearchStatus("Could not plan that yet", error?.message || "Try a more specific Perth location.");
  }
}

function showJourneyOptions() {
  const originStopId = getJourneyStartStopId();
  const destinationStopId = getJourneyEndStopId() || null;

  if (!originStopId || !destinationStopId) {
    renderJourneyPrompt("Complete your plan", "Set both a start and destination to see options.", originStopId ? "end" : "start");
    return;
  }

  if (originStopId === destinationStopId) {
    renderJourneyPrompt("Start and end match", "Choose a different start stop so the app can find a journey.", "start");
    return;
  }

  const options = findFastestJourneyOptions();
  latestJourneyOptions = options;
  selectedJourneyOptionTripId = null;
  highlightedTripIds = new Set(options.map(option => option.tripId));
  selectedTripId = null;
  selectedStopId = null;

  drawJourneyOptionPaths(options);
  updateBusPositionsLive();
  highlightJourneyMarkers();
  fitJourneyBounds(options);
  renderJourneyResultsPanel(options);
  renderJourneyOverlay();
}


// ---------- Time, service-day and timetable helpers ----------
function timeToSeconds(timeString) {
  if (!timeString || typeof timeString !== "string") return NaN;

  const [hours, minutes, seconds] = timeString.split(":").map(Number);

  if ([hours, minutes, seconds].some(value => Number.isNaN(value))) {
    return NaN;
  }

  // GTFS can legally use times past midnight, e.g. 24:12:00 or 25:03:00.
  return hours * 3600 + minutes * 60 + seconds;
}

function getClockSecondsPrecise() {
  const now = new Date();

  return (
    now.getHours() * 3600 +
    now.getMinutes() * 60 +
    now.getSeconds() +
    now.getMilliseconds() / 1000
  );
}

function getCurrentSecondsPrecise() {
  if (simulatedCurrentSecondsOverride !== null) {
    return simulatedCurrentSecondsOverride;
  }

  return getClockSecondsPrecise() + serviceDayOffsetSeconds;
}

function tripIsActiveAtSeconds(trip, currentSeconds) {
  if (!trip?.stops?.length) return false;

  const firstStopTime = timeToSeconds(trip.stops[0].departureTime);
  const lastStopTime = timeToSeconds(trip.stops[trip.stops.length - 1].arrivalTime);

  if (Number.isNaN(firstStopTime) || Number.isNaN(lastStopTime)) return false;

  return currentSeconds >= firstStopTime && currentSeconds <= lastStopTime;
}

function countActiveTripsAtSeconds(currentSeconds) {
  let count = 0;

  timetableTrips.forEach(trip => {
    if (tripIsActiveAtSeconds(trip, currentSeconds)) {
      count += 1;
    }
  });

  return count;
}

function findNearestInServiceSecond(clockSeconds) {
  let best = null;

  timetableTrips.forEach(trip => {
    if (!trip?.stops?.length) return;

    const firstStopTime = timeToSeconds(trip.stops[0].departureTime);
    const lastStopTime = timeToSeconds(trip.stops[trip.stops.length - 1].arrivalTime);

    if (Number.isNaN(firstStopTime) || Number.isNaN(lastStopTime)) return;

    const candidates = [];

    if (clockSeconds < firstStopTime) {
      candidates.push(firstStopTime + 60);
    } else if (clockSeconds > lastStopTime) {
      candidates.push(Math.max(firstStopTime, lastStopTime - 60));
    } else {
      candidates.push(clockSeconds);
    }

    candidates.forEach(candidateSeconds => {
      const distance = Math.min(
        Math.abs(candidateSeconds - clockSeconds),
        Math.abs(candidateSeconds - (clockSeconds + 86400)),
        Math.abs(candidateSeconds - (clockSeconds - 86400))
      );

      if (!best || distance < best.distance) {
        best = {
          seconds: candidateSeconds,
          distance
        };
      }
    });
  });

  return best ? best.seconds : null;
}

function chooseServiceDayOffset() {
  const clockSeconds = getClockSecondsPrecise();

  const candidates = [
    { label: "device clock", offset: 0, seconds: clockSeconds },
    { label: "GTFS after-midnight service day", offset: 86400, seconds: clockSeconds + 86400 },
    { label: "previous service day", offset: -86400, seconds: clockSeconds - 86400 }
  ];

  const scoredCandidates = candidates.map(candidate => ({
    ...candidate,
    activeTrips: countActiveTripsAtSeconds(candidate.seconds)
  }));

  scoredCandidates.sort((a, b) => b.activeTrips - a.activeTrips);

  const bestCandidate = scoredCandidates[0];

  simulatedCurrentSecondsOverride = null;

  if (bestCandidate && bestCandidate.activeTrips > 0) {
    serviceDayOffsetSeconds = bestCandidate.offset;

    console.log("Using timetable time source:", bestCandidate.label);
    console.log("Active trips:", bestCandidate.activeTrips);
    console.log("Clock seconds:", Math.round(clockSeconds));
    console.log("Service day offset seconds:", serviceDayOffsetSeconds);
    return;
  }

  serviceDayOffsetSeconds = 0;

  if (KEEP_PROTOTYPE_VISIBLE_WHEN_NO_REAL_TIME_BUSES) {
    const nearestInServiceSecond = findNearestInServiceSecond(clockSeconds);

    if (nearestInServiceSecond !== null) {
      simulatedCurrentSecondsOverride = nearestInServiceSecond;

      console.warn(
        "No trips were active at the device clock time, so the prototype is showing the nearest in-service timetable moment instead.",
        {
          deviceClockSeconds: Math.round(clockSeconds),
          simulatedTimetableSeconds: Math.round(simulatedCurrentSecondsOverride),
          activeTripsAtSimulatedTime: countActiveTripsAtSeconds(simulatedCurrentSecondsOverride)
        }
      );
      return;
    }
  }

  console.warn(
    "No active trips found for the device time, after-midnight time, previous service day, or nearest-service fallback."
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


// ---------- Service marker rendering ----------
function createBusIcon(trip, isSelected = false, variant = "scheduled", delayClass = "on-time") {
  const mode = getTransportMode(trip);
  const markerLabel = escapeHTML(getTransportLabel(trip));
  const ariaLabel = escapeHTML(getTransportAriaLabel(trip));
  const compact = shouldUseCompactServiceMarker(isSelected);

  if (compact) {
    const dotClasses = [
      "service-dot-marker",
      `transport-${mode}`,
      variant === "live" ? "live" : "scheduled"
    ];

    if (variant === "live") dotClasses.push(delayClass);

    return L.divIcon({
      className: "vehicle-marker-icon",
      html: `<span class="${dotClasses.join(" ")}" aria-label="${variant} ${ariaLabel}"></span>`,
      iconSize: variant === "live" ? [12, 12] : [9, 9],
      iconAnchor: variant === "live" ? [6, 6] : [4.5, 4.5]
    });
  }

  const classes = [
    "route-bus-marker",
    `transport-${mode}`,
    variant === "live" ? "live" : "scheduled"
  ];

  if (isSelected) classes.push("selected");
  if (variant === "live") classes.push(delayClass);

  const iconSize = [34, 34];
  const iconAnchor = [17, 17];

  return L.divIcon({
    className: "vehicle-marker-icon",
    html: `
      <div class="${classes.join(" ")}" aria-label="${variant} ${ariaLabel}">
        ${variant === "live" ? `<span class="route-bus-pulse"></span>` : ""}
        <span class="route-bus-badge">${markerLabel}</span>
        ${variant === "scheduled" ? `<span class="route-bus-scheduled-dot" aria-hidden="true"></span>` : ""}
      </div>
    `,
    iconSize,
    iconAnchor
  });
}

function getServiceMarkerIconKey(trip, isSelected = false, variant = "scheduled", delayClass = "on-time") {
  const compact = shouldUseCompactServiceMarker(isSelected);
  const routeId = trip?.routeId || "unknown";
  const tripRouteLabel = getTransportLabel(trip);

  return [
    routeId,
    tripRouteLabel,
    variant,
    delayClass,
    isSelected ? "selected" : "normal",
    compact ? "compact" : "detailed",
    currentMapTheme
  ].join("|");
}

function setVehicleMarkerIcon(marker, trip, isSelected = false, variant = "scheduled", delayClass = "on-time") {
  if (!marker) return;

  const iconKey = getServiceMarkerIconKey(trip, isSelected, variant, delayClass);

  if (marker._tripTrackerIconKey !== iconKey) {
    marker.setIcon(createBusIcon(trip, isSelected, variant, delayClass));
    marker._tripTrackerIconKey = iconKey;
  }
}

function getScheduledMarkerOpacity(tripId) {
  if (trackingMode === "live") return 0;
  if (selectedTripId && tripId !== selectedTripId) return 0;
  if (selectedStopId && !highlightedTripIds.has(tripId)) return 0.08;
  return trackingMode === "ghost" ? 0.72 : 1;
}

function getLiveMarkerOpacity(tripId) {
  if (trackingMode === "scheduled") return 0;
  if (selectedTripId && tripId !== selectedTripId) return 0;
  if (selectedStopId && !highlightedTripIds.has(tripId)) return 0.08;
  return 1;
}

function applyBetaMarkerVisibility() {
  Object.keys(busMarkersByTripId).forEach(tripId => {
    const marker = busMarkersByTripId[tripId];
    marker.setOpacity(getScheduledMarkerOpacity(tripId));

    const element = marker.getElement?.();
    if (element) {
      element.style.pointerEvents = trackingMode === "live" ? "none" : "auto";
    }
  });

  Object.keys(liveBusMarkersByTripId).forEach(tripId => {
    const marker = liveBusMarkersByTripId[tripId];
    marker.setOpacity(getLiveMarkerOpacity(tripId));

    const element = marker.getElement?.();
    if (element) {
      element.style.pointerEvents = trackingMode === "scheduled" ? "none" : "auto";
    }
  });
}


// ---------- Selection highlighting and ETA chips ----------
function clearRouteLine() {
  if (currentRouteLine) {
    map.removeLayer(currentRouteLine);
    currentRouteLine = null;
  }

  clearGhostRouteSegmentLine();
}

function drawTripShapeByShapeId(shapeId) {
  clearNetworkLayer();
  const shapeCoords = allShapes[shapeId];

  if (!shapeCoords) return;

  clearRouteLine();

  currentRouteLine = L.polyline(shapeCoords, {
    renderer: routeFlowRenderer,
    color: getRoutePathColour(),
    weight: getRoutePathWeight(),
    opacity: getRoutePathOpacity(),
    lineCap: "round",
    lineJoin: "round",
    dashArray: trackingMode === "ghost" ? null : "10 18",
    className: trackingMode === "ghost" ? "selected-route-line" : "selected-route-line selected-route-flow-line"
  }).addTo(map);

  currentRouteLine.bringToBack();
}

function drawSpecificTripShape(trip) {
  drawTripShapeByShapeId(trip.shapeId);
}

function clearEtaMarkers() {
  etaMarkers.forEach(marker => {
    map.removeLayer(marker);
  });

  etaMarkers = [];
}

function formatScheduledClockTime(timeString) {
  const seconds = timeToSeconds(timeString);

  if (Number.isNaN(seconds)) return "";

  const daySeconds = ((seconds % 86400) + 86400) % 86400;
  const hours = Math.floor(daySeconds / 3600);
  const minutes = Math.floor((daySeconds % 3600) / 60);

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function getEtaText(arrivalSeconds, currentSeconds) {
  const diffSeconds = arrivalSeconds - currentSeconds;
  const diffMinutes = Math.round(diffSeconds / 60);

  if (diffMinutes <= 0) return "now";
  if (diffMinutes < 60) return `${diffMinutes}m`;

  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;

  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

function drawEtaMarkersForTrip(tripId) {
  clearEtaMarkers();

  const trip = tripLookupByTripId[tripId] || timetableTrips.find(item => item.tripId === tripId);

  if (!trip || !trip.stops || trip.stops.length === 0) return;

  const currentSeconds = getCurrentSecondsPrecise();
  const futureStops = trip.stops
    .filter(stopTime => {
      const arrivalSeconds = timeToSeconds(stopTime.arrivalTime);
      return !Number.isNaN(arrivalSeconds) && arrivalSeconds >= currentSeconds;
    })
    .slice(0, 12);

  futureStops.forEach((stopTime, index) => {
    const stop = stopLookup[stopTime.stopId];
    if (!stop) return;

    const arrivalSeconds = timeToSeconds(stopTime.arrivalTime);
    const etaText = getEtaText(arrivalSeconds, currentSeconds);
    const scheduledClock = formatScheduledClockTime(stopTime.arrivalTime);

    const marker = L.marker([stop.lat, stop.lon], {
      icon: L.divIcon({
        className: "",
        html: `
          <div class="eta-chip ${index === 0 ? "is-next" : ""}" title="Scheduled ${escapeHTML(scheduledClock)}">
            <span class="eta-chip-time">${escapeHTML(etaText)}</span>
          </div>
        `,
        iconSize: [46, 24],
        iconAnchor: [23, 38]
      }),
      interactive: false,
      zIndexOffset: 1450
    }).addTo(map);

    etaMarkers.push(marker);
  });
}

function focusSelectedBus(tripId, variant = selectedBusVariant) {
  selectedTripId = tripId;
  selectedStopId = null;
  selectedBusVariant = variant;
  highlightedTripIds = new Set([tripId]);

  clearStopRouteLines();
  highlightFutureStopMarkersForTrip(tripId);

  Object.keys(busMarkersByTripId).forEach(id => {
    const marker = busMarkersByTripId[id];
    const isSelected = id === selectedTripId && variant === "scheduled";

    setVehicleMarkerIcon(marker, tripLookupByTripId[id], isSelected, "scheduled");
    marker.setZIndexOffset(isSelected ? 1200 : 500);
  });

  Object.keys(liveBusMarkersByTripId).forEach(id => {
    const marker = liveBusMarkersByTripId[id];
    const delayClass = getDelayStatus(getStableLiveDelaySeconds(id)).className;
    const isSelected = id === selectedTripId && variant === "live";

    setVehicleMarkerIcon(marker, tripLookupByTripId[id], isSelected, "live", delayClass);
    marker.setZIndexOffset(isSelected ? 1300 : 700);
  });

  applyBetaMarkerVisibility();
  drawGhostRouteSegmentForTrip(tripId);
  drawEtaMarkersForTrip(tripId);

  if (currentRouteLine) {
    currentRouteLine.setStyle({
      color: getRoutePathColour(),
      weight: getRoutePathWeight(),
      opacity: getRoutePathOpacity()
    });
    currentRouteLine.bringToBack();
  }
}

function focusTripsForStop(stopId, upcomingItems) {
  selectedTripId = null;
  selectedStopId = stopId;
  highlightedTripIds = new Set(upcomingItems.map(item => item.tripId));

  Object.keys(busMarkersByTripId).forEach(tripId => {
    const marker = busMarkersByTripId[tripId];
    setVehicleMarkerIcon(marker, tripLookupByTripId[tripId], highlightedTripIds.has(tripId), "scheduled");
    marker.setZIndexOffset(highlightedTripIds.has(tripId) ? 1000 : 500);
  });

  Object.keys(liveBusMarkersByTripId).forEach(tripId => {
    const marker = liveBusMarkersByTripId[tripId];
    const delayClass = getDelayStatus(getStableLiveDelaySeconds(tripId)).className;
    setVehicleMarkerIcon(marker, tripLookupByTripId[tripId], highlightedTripIds.has(tripId), "live", delayClass);
    marker.setZIndexOffset(highlightedTripIds.has(tripId) ? 1100 : 700);
  });

  applyBetaMarkerVisibility();
}

function focusSingleTrip(tripId) {
  selectedBusVariant = trackingMode === "scheduled" ? "scheduled" : "live";
  focusSelectedBus(tripId, selectedBusVariant);
}

function clearBusFocus() {
  clearActiveMapPinMarker();
  selectedTripId = null;
  selectedStopId = null;
  selectedBusVariant = trackingMode === "scheduled" ? "scheduled" : "live";
  highlightedTripIds = new Set();

  Object.keys(busMarkersByTripId).forEach(id => {
    const marker = busMarkersByTripId[id];
    setVehicleMarkerIcon(marker, tripLookupByTripId[id], false, "scheduled");
    marker.setZIndexOffset(500);
  });

  Object.keys(liveBusMarkersByTripId).forEach(id => {
    const marker = liveBusMarkersByTripId[id];
    const delayClass = getDelayStatus(getStableLiveDelaySeconds(id)).className;
    setVehicleMarkerIcon(marker, tripLookupByTripId[id], false, "live", delayClass);
    marker.setZIndexOffset(700);
  });

  applyBetaMarkerVisibility();
  clearRouteLine();
  clearEtaMarkers();
  clearStopRouteLines();
  resetStopMarkerStyles();
}

function resetAppView() {
  hideStopMapAction();
  clearBusFocus();
  hideSelectionPanel();

  if (journeyStart || journeyEnd) {
    renderJourneyOverlay();
    highlightJourneyMarkers();
    return;
  }

  clearJourneyRouteLines();
  updateNetworkLayer();
}

function stopLeafletEvent(event) {
  if (!event) return;

  L.DomEvent.stopPropagation(event);

  if (event.originalEvent) {
    L.DomEvent.stop(event.originalEvent);
  }
}

function formatMinutesAway(arrivalSeconds, currentSeconds) {
  const diffSeconds = arrivalSeconds - currentSeconds;
  const diffMinutes = Math.round(diffSeconds / 60);

  if (diffMinutes <= 0) return "due now";
  if (diffMinutes === 1) return "1 min";
  return `${diffMinutes} mins`;
}


// ---------- Stop arrivals and user location ----------
function getUpcomingForStop(stopId, minutesAhead = 30) {
  const currentSeconds = getCurrentSecondsPrecise();
  const maxSeconds = currentSeconds + minutesAhead * 60;
  const duplicateWindowSeconds = 120;

  const upcoming = stopUpcoming[stopId] || [];

  const timeValidItems = upcoming
    .filter(item => {
      const arrivalSeconds = timeToSeconds(item.arrivalTime);
      return arrivalSeconds >= currentSeconds && arrivalSeconds <= maxSeconds;
    })
    .sort((a, b) => timeToSeconds(a.arrivalTime) - timeToSeconds(b.arrivalTime));

  const uniqueByTrip = [];
  const seenTripIds = new Set();

  timeValidItems.forEach(item => {
    if (seenTripIds.has(item.tripId)) return;
    seenTripIds.add(item.tripId);
    uniqueByTrip.push(item);
  });

  const deduped = [];

  uniqueByTrip.forEach(item => {
    const arrivalSeconds = timeToSeconds(item.arrivalTime);

    const duplicateIndex = deduped.findIndex(existing => {
      const existingArrivalSeconds = timeToSeconds(existing.arrivalTime);
      const sameRoute = getTransportLabel(existing) === getTransportLabel(item) && getTransportMode(existing) === getTransportMode(item);
      const sameDestination = existing.headsign === item.headsign;
      const sameShape = existing.shapeId === item.shapeId;
      const closeArrival = Math.abs(existingArrivalSeconds - arrivalSeconds) <= duplicateWindowSeconds;

      return sameRoute && sameDestination && sameShape && closeArrival;
    });

    if (duplicateIndex === -1) {
      deduped.push(item);
      return;
    }

    const existingArrivalSeconds = timeToSeconds(deduped[duplicateIndex].arrivalTime);

    if (arrivalSeconds < existingArrivalSeconds) {
      deduped[duplicateIndex] = item;
    }
  });

  return deduped
    .sort((a, b) => timeToSeconds(a.arrivalTime) - timeToSeconds(b.arrivalTime))
    .slice(0, 8);
}


function findNearestStop(lat, lon) {
  let closestStop = null;
  let closestDistance = Infinity;

  Object.values(stopLookup).forEach(stop => {
    const distance = distanceBetweenPoints(
      [lat, lon],
      [stop.lat, stop.lon]
    );

    if (distance < closestDistance) {
      closestDistance = distance;
      closestStop = stop;
    }
  });

  return closestStop;
}

function showLocationMessage(title, message) {
  selectionPanelContent.innerHTML = `
    <section class="panel-section location-panel-section">
      <div class="panel-main-row">
        <div class="panel-text-stack">
          <div class="panel-title">${escapeHTML(title)}</div>
          <div class="panel-subtitle">${escapeHTML(message)}</div>
        </div>
      </div>
    </section>
  `;

  showSelectionPanel();
}

function focusUserLocation(lat, lon) {
  clearBusFocus();

  showLocationMessage("Start set from your location", "Nearest stop selected in the background. Tap a stop, then set it as your destination.");

  map.setView([lat, lon], Math.max(map.getZoom(), 16), {
    animate: true
  });
}

function isUserLocationMaxZoom() {
  const maxZoom = map.getMaxZoom ? map.getMaxZoom() : 19;
  return map.getZoom() >= maxZoom - 1;
}

function createUserLocationIcon() {
  const isLarge = isUserLocationMaxZoom();
  const size = isLarge ? 56 : 34;
  const coreSize = isLarge ? 34 : 12;
  const pulseSize = isLarge ? 42 : 24;
  const imageHTML = isLarge ? `<img src="current_location_pin.svg" alt="Your location">` : "";

  return L.divIcon({
    className: "",
    html: `
      <div class="user-location-marker ${isLarge ? "is-large" : "is-compact"}" style="--user-location-size:${size}px; --user-location-core:${coreSize}px; --user-location-pulse:${pulseSize}px;">
        <div class="user-location-pulse"></div>
        <div class="user-location-core">
          ${imageHTML}
        </div>
      </div>
    `,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2]
  });
}

function refreshUserLocationIcon() {
  if (!userLocationMarker) return;
  userLocationMarker.setIcon(createUserLocationIcon());
}

function updateUserLocationMarker(lat, lon) {
  if (userLocationMarker) {
    userLocationMarker.setLatLng([lat, lon]);
    refreshUserLocationIcon();
    return;
  }

  userLocationMarker = L.marker([lat, lon], {
    icon: createUserLocationIcon(),
    zIndexOffset: 2200,
    interactive: false
  }).addTo(map);
}

function requestUserLocation(options = {}) {
  if (!navigator.geolocation) {
    showLocationMessage("Location unavailable", "This browser does not support GPS location.");
    return;
  }

  showLocationMessage("Finding nearest stop…", "Allow location access when your browser asks.");

  navigator.geolocation.getCurrentPosition(
    position => {
      const lat = position.coords.latitude;
      const lon = position.coords.longitude;

      const nearestStop = findNearestStop(lat, lon);
      userLocation = {
        lat,
        lon,
        nearestStopId: nearestStop?.id || null
      };

      updateUserLocationMarker(lat, lon);

      if (nearestStop && (options.useAsJourneyStart || journeyEnd || journeyPickMode === "start")) {
        journeyStart = {
          type: "gps",
          lat,
          lon,
          nearestStopId: nearestStop.id
        };
        journeyPickMode = null;
        renderJourneyOverlay();
        highlightJourneyMarkers();

        if (journeyEnd) {
          showJourneyOptions();
          return;
        }
      }

      focusUserLocation(lat, lon);
    },
    error => {
      const message = error.code === error.PERMISSION_DENIED
        ? "Location access was denied."
        : "The app could not get your current location.";

      showLocationMessage("Location not available", message);
    },
    {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 30000
    }
  );
}


function getLocalDateNumber(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return Number(`${year}${month}${day}`);
}

function getCalendarDayField(date = new Date()) {
  const dayFields = [
    "sunday",
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday"
  ];

  return dayFields[date.getDay()];
}

function getActiveServiceIdsForDate(date = new Date()) {
  const todayNumber = getLocalDateNumber(date);
  const dayField = getCalendarDayField(date);
  const activeServiceIds = new Set();

  serviceCalendarRows.forEach(service => {
    const startDate = Number(service.startDate);
    const endDate = Number(service.endDate);
    const runsToday = service[dayField] === true || service[dayField] === "1" || service[dayField] === 1;

    if (runsToday && todayNumber >= startDate && todayNumber <= endDate) {
      activeServiceIds.add(String(service.serviceId));
    }
  });

  return activeServiceIds;
}

function filterStopUpcomingByServiceIds(stopUpcomingLookup, activeServiceIds) {
  const filtered = {};

  Object.keys(stopUpcomingLookup).forEach(stopId => {
    const activeItems = stopUpcomingLookup[stopId].filter(item => {
      return activeServiceIds.has(String(item.serviceId));
    });

    if (activeItems.length > 0) {
      filtered[stopId] = activeItems;
    }
  });

  return filtered;
}

function applyTodayServiceFilter() {
  activeServiceIdsForToday = getActiveServiceIdsForDate(new Date());

  if (activeServiceIdsForToday.size === 0) {
    console.warn("No active service_ids found for today's local date. Falling back to all timetable trips.");
    timetableTrips = unfilteredTimetableTrips;
    stopUpcoming = unfilteredStopUpcoming;
    rebuildTripLookup();
    return;
  }

  timetableTrips = unfilteredTimetableTrips.filter(trip => {
    return activeServiceIdsForToday.has(String(trip.serviceId));
  });

  stopUpcoming = filterStopUpcomingByServiceIds(unfilteredStopUpcoming, activeServiceIdsForToday);
  rebuildTripLookup();

  console.log("Date filter applied", {
    localDate: getLocalDateNumber(new Date()),
    activeServiceIds: activeServiceIdsForToday.size,
    unfilteredTrips: unfilteredTimetableTrips.length,
    activeTrips: timetableTrips.length
  });
}


// ---------- Data loading ----------
async function loadCoreData() {
  const [routesRes, tripsRes, shapesRes, timetableRes, stopUpcomingRes, calendarRes] = await Promise.all([
    fetch("data/processed/routes.json"),
    fetch("data/processed/trips.json"),
    fetch("data/processed/shapes.json"),
    fetch("data/processed/trip-stop-times.json"),
    fetch("data/processed/stop-upcoming.json"),
    fetch("data/processed/calendar.json")
  ]);

  allRoutes = await routesRes.json();
  allTrips = await tripsRes.json();
  allShapes = await shapesRes.json();
  unfilteredTimetableTrips = await timetableRes.json();
  unfilteredStopUpcoming = await stopUpcomingRes.json();
  serviceCalendarRows = await calendarRes.json();

  applyTodayServiceFilter();
  chooseServiceDayOffset();

  console.log("Core data loaded");
  console.log("Routes:", allRoutes.length);
  console.log("Trips:", allTrips.length);
  console.log("Shapes:", Object.keys(allShapes).length);
  console.log("Unfiltered timetable trips:", unfilteredTimetableTrips.length);
  console.log("Today timetable trips:", timetableTrips.length);
  console.log("Stop upcoming records:", Object.keys(stopUpcoming).length);
}

async function loadStops() {
  console.log("Loading stops + stop routes...");

  const [stopsRes, stopRoutesRes] = await Promise.all([
    fetch("data/processed/stops.json"),
    fetch("data/processed/stop-routes.json")
  ]);

  const stops = await stopsRes.json();
  await stopRoutesRes.json();

  stopLookup = createStopLookup(stops);

  console.log("Stops loaded:", stops.length);

  stops.forEach(stop => {
    // Visible stop dot stays small and clean.
    const marker = L.circleMarker(
      [stop.lat, stop.lon],
      {
        ...getDefaultStopStyleForZoom(),
        interactive: false
      }
    ).addTo(map);

    // Invisible hit area gives mobile users a much larger tap target without
    // visually enlarging every stop dot.
    const hitMarker = L.circleMarker(
      [stop.lat, stop.lon],
      {
        ...getStopHitAreaStyleForZoom(),
        interactive: true
      }
    ).addTo(map);

    stopMarkersByStopId[stop.id] = marker;
    stopHitMarkersByStopId[stop.id] = hitMarker;

    hitMarker.on("click", event => {
      stopLeafletEvent(event);
      selectStop(stop);
    });
  });
}



// ---------- Vehicle update loop ----------
function getTripPositionNow(trip, currentSeconds) {
  if (!tripIsActiveAtSeconds(trip, currentSeconds)) {
    return null;
  }

  for (let i = 0; i < trip.stops.length - 1; i++) {
    const currentStopTime = timeToSeconds(trip.stops[i].departureTime);
    const nextStopTime = timeToSeconds(trip.stops[i + 1].arrivalTime);

    if (Number.isNaN(currentStopTime) || Number.isNaN(nextStopTime)) continue;

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
        progress,
        segmentIndex: i,
        nextStopIndex: i + 1
      };
    }
  }

  return null;
}

function updateBusPositionsLive() {
  const currentSeconds = getCurrentSecondsPrecise();
  const activeTripIds = new Set();
  const visibleTripIds = new Set();

  timetableTrips.forEach(trip => {
    const scheduledPosition = getTripPositionNow(trip, currentSeconds);

    if (!scheduledPosition) return;

    activeTripIds.add(trip.tripId);
    latestTripPositionsByTripId[trip.tripId] = scheduledPosition;

    const delaySeconds = getStableLiveDelaySeconds(trip.tripId);
    const livePosition = getTripPositionNow(trip, currentSeconds - delaySeconds) || scheduledPosition;
    latestLiveTripPositionsByTripId[trip.tripId] = livePosition;

    if (!shouldRenderTripMarkers(trip, scheduledPosition, livePosition)) {
      return;
    }

    visibleTripIds.add(trip.tripId);

    const scheduledIsSelected = selectedTripId === trip.tripId && selectedBusVariant === "scheduled";

    if (busMarkersByTripId[trip.tripId]) {
      const marker = busMarkersByTripId[trip.tripId];
      marker.setLatLng(scheduledPosition.position);
      setVehicleMarkerIcon(marker, trip, scheduledIsSelected, "scheduled");
    } else {
      const marker = L.marker(scheduledPosition.position, {
        icon: createBusIcon(trip, false, "scheduled"),
        zIndexOffset: 500
      }).addTo(map);
      marker._tripTrackerIconKey = getServiceMarkerIconKey(trip, false, "scheduled");

      marker.on("click", event => {
        stopLeafletEvent(event);

        drawSpecificTripShape(trip);
        focusSelectedBus(trip.tripId, "scheduled");
        renderBusPanel(trip, "scheduled");
      });

      busMarkersByTripId[trip.tripId] = marker;
    }

    const delayClass = getDelayStatus(delaySeconds).className;

    const liveIsSelected = selectedTripId === trip.tripId && selectedBusVariant === "live";

    if (liveBusMarkersByTripId[trip.tripId]) {
      const marker = liveBusMarkersByTripId[trip.tripId];
      marker.setLatLng(livePosition.position);
      setVehicleMarkerIcon(marker, trip, liveIsSelected, "live", delayClass);
    } else {
      const marker = L.marker(livePosition.position, {
        icon: createBusIcon(trip, false, "live", delayClass),
        zIndexOffset: 700
      }).addTo(map);
      marker._tripTrackerIconKey = getServiceMarkerIconKey(trip, false, "live", delayClass);

      marker.on("click", event => {
        stopLeafletEvent(event);

        drawSpecificTripShape(trip);
        focusSelectedBus(trip.tripId, "live");
        renderBusPanel(trip, "live");
      });

      liveBusMarkersByTripId[trip.tripId] = marker;
    }

    if (selectedTripId === trip.tripId && selectedPanelType === "bus") {
      renderBusPanel(trip, selectedBusVariant);
    }
  });

  Object.keys(busMarkersByTripId).forEach(tripId => {
    if (!visibleTripIds.has(tripId)) {
      map.removeLayer(busMarkersByTripId[tripId]);
      delete busMarkersByTripId[tripId];
    }
  });

  Object.keys(liveBusMarkersByTripId).forEach(tripId => {
    if (!visibleTripIds.has(tripId)) {
      map.removeLayer(liveBusMarkersByTripId[tripId]);
      delete liveBusMarkersByTripId[tripId];
    }
  });

  Object.keys(latestTripPositionsByTripId).forEach(tripId => {
    if (!activeTripIds.has(tripId)) delete latestTripPositionsByTripId[tripId];
  });

  Object.keys(latestLiveTripPositionsByTripId).forEach(tripId => {
    if (!activeTripIds.has(tripId)) delete latestLiveTripPositionsByTripId[tripId];
  });

  if (selectedTripId) {
    drawGhostRouteSegmentForTrip(selectedTripId);
    drawEtaMarkersForTrip(selectedTripId);
  }

  updateNetworkLayer();
  applyBetaMarkerVisibility();

  // Keep the selected journey preview physically tied to the moving bus marker.
  // As the scheduled/live marker advances, the ant-style approach segment is
  // redrawn from the new bus location, so it naturally shrinks toward the start.
  if (selectedJourneyOptionTripId) {
    redrawSelectedJourneyOption();
  }

  if (activeTripIds.size > 0) {
    hasWarnedAboutNoActiveTrips = false;
  } else if (!hasWarnedAboutNoActiveTrips) {
    console.warn(
      "No active timetable trips found for the selected timetable second. Check the logs from chooseServiceDayOffset().",
      { currentSeconds: Math.round(currentSeconds), serviceDayOffsetSeconds, simulatedCurrentSecondsOverride }
    );
    hasWarnedAboutNoActiveTrips = true;
  }
}


function refreshMapAfterInteraction() {
  if (mapRefreshTimeoutId) {
    window.clearTimeout(mapRefreshTimeoutId);
  }

  mapRefreshTimeoutId = window.setTimeout(() => {
    if (selectedTripId || selectedStopId || journeyStart || journeyEnd) {
      // Keep selected views responsive even after a zoom/pan.
      updateBusPositionsLive();
      return;
    }

    applyDefaultStopMarkerStylesForZoom();
    applyStopHitAreaStylesForZoom();
    updateBusPositionsLive();
  }, MAP_SETTLE_REFRESH_DELAY_MS);
}


// ---------- Tracking mode controls and app events ----------
function showLiveNoticeOnce() {
  if (!liveNoticeModal) return;
  if (localStorage.getItem(LIVE_NOTICE_SEEN_KEY) === "true") return;

  liveNoticeModal.classList.remove("is-hidden");
}

function closeLiveNoticeModal() {
  if (!liveNoticeModal) return;

  localStorage.setItem(LIVE_NOTICE_SEEN_KEY, "true");
  liveNoticeModal.classList.add("is-hidden");
}

function setTrackingMode(mode) {
  trackingMode = mode;

  trackingModeButtons.forEach(button => {
    button.classList.toggle("is-active", button.dataset.trackingMode === mode);
  });

  if (mode === "scheduled") {
    selectedBusVariant = "scheduled";
  } else if (selectedBusVariant === "scheduled") {
    selectedBusVariant = "live";
  }

  if (currentRouteLine) {
    currentRouteLine.setStyle({
      color: getRoutePathColour(),
      weight: getRoutePathWeight(),
      opacity: getRoutePathOpacity(),
      dashArray: trackingMode === "ghost" ? null : "10 18"
    });
  }

  if (selectedTripId) {
    focusSelectedBus(selectedTripId, selectedBusVariant);
  } else {
    clearGhostRouteSegmentLine();
    applyBetaMarkerVisibility();
    updateNetworkLayer();
  }
}

trackingModeButtons.forEach(button => {
  button.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();

    const selectedMode = button.dataset.trackingMode;
    setTrackingMode(selectedMode);

    if (selectedMode === "live") {
      showLiveNoticeOnce();
    }
  });
});

if (themeToggleButton) {
  themeToggleButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    toggleMapTheme();
  });

  themeToggleButton.addEventListener("touchstart", event => {
    event.stopPropagation();
  }, { passive: true });
}

if (journeyOverlay) {
  journeyOverlay.addEventListener("pointerdown", event => {
    if (journeyOverlay.classList.contains("is-peeking")) {
      event.preventDefault();
      event.stopPropagation();
      markJourneyOverlayTouched();
      return;
    }

    markJourneyOverlayTouched();
  }, true);
}

if (journeyClearButton) {
  journeyClearButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    clearJourneyPlan();
    resetAppView();
  });
}

if (journeyStartEditButton) {
  journeyStartEditButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    setJourneyPickMode("start");
  });
}

if (journeyEndEditButton) {
  journeyEndEditButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    setJourneyPickMode("end");
  });
}

if (journeySwapButton) {
  journeySwapButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    swapJourneyDirection();
  });
}

if (journeySearchButton) {
  journeySearchButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    handleJourneySearchSubmit();
  });
}

[
  { input: journeyStartInput, kind: "start" },
  { input: journeyEndInput, kind: "end" }
].forEach(({ input, kind }) => {
  if (!input) return;

  input.addEventListener("focus", () => {
    expandJourneyOverlay();
    cancelJourneyOverlayPeekTimer();
    const query = String(input.value || "").trim();
    if (query.length >= JOURNEY_AUTOCOMPLETE_MIN_CHARS && !journeySelectedPlaces[kind]) {
      scheduleJourneyAutocomplete(kind, query);
    }
  });

  input.addEventListener("input", event => {
    expandJourneyOverlay();
    scheduleJourneyAutocomplete(kind, event.target.value);
  });

  input.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      clearJourneySuggestions(kind);
      input.blur();
      return;
    }

    if (event.key !== "Enter") return;
    event.preventDefault();
    clearAllJourneySuggestions();
    handleJourneySearchSubmit();
  });
});

[journeyStartSuggestions, journeyEndSuggestions].forEach((list, index) => {
  if (!list) return;
  const kind = index === 0 ? "start" : "end";

  list.addEventListener("pointerdown", event => {
    // Prevent the input blur from hiding the list before the tap/click resolves on mobile.
    event.preventDefault();
  });

  list.addEventListener("click", event => {
    const button = event.target.closest("[data-place-index]");
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();
    const place = list._journeyPlaces?.[Number(button.dataset.placeIndex)];
    selectJourneyPlace(kind, place);
  });
});

document.addEventListener("click", event => {
  if (journeyOverlay?.contains(event.target)) return;
  clearAllJourneySuggestions();
});

if (stopMapAction) {
  stopMapAction.addEventListener("click", event => {
    const button = event.target.closest("[data-stop-map-action]");
    if (!button) return;

    event.preventDefault();
    event.stopPropagation();
    handleStopMapAction(button.dataset.stopMapAction);
  });

  stopMapAction.addEventListener("touchstart", event => {
    event.stopPropagation();
  }, { passive: true });
}

if (locateUserButton) {
  locateUserButton.addEventListener("click", event => {
    event.preventDefault();
    event.stopPropagation();
    requestUserLocation();
  });

  locateUserButton.addEventListener("touchstart", event => {
    event.stopPropagation();
  }, { passive: true });
}

map.on("movestart zoomstart", () => {
  isMapMoving = true;
  document.body.classList.add("is-map-moving");
});

map.on("moveend zoomend", () => {
  isMapMoving = false;
  document.body.classList.remove("is-map-moving");
  refreshMapAfterInteraction();
  refreshUserLocationIcon();
  if (stopMapActionStopId) positionStopMapAction(stopLookup[stopMapActionStopId]);
});

map.on("click", () => {
  resetAppView();
});

closeSelectionPanelButton.addEventListener("click", event => {
  event.preventDefault();
  event.stopPropagation();
  resetAppView();
});

closeSelectionPanelButton.addEventListener("touchstart", event => {
  event.stopPropagation();
}, { passive: true });

selectionPanel.addEventListener("click", event => {
  event.stopPropagation();
});

selectionPanel.addEventListener("touchstart", event => {
  event.stopPropagation();
}, { passive: true });

if (liveNoticeOkButton) {
  liveNoticeOkButton.addEventListener("click", event => {
    event.preventDefault();
    closeLiveNoticeModal();
  });
}

if (liveNoticeModal) {
  liveNoticeModal.addEventListener("click", event => {
    if (event.target === liveNoticeModal) {
      closeLiveNoticeModal();
    }
  });
}


// ---------- App startup ----------
async function init() {
  updateThemeToggleButton();
  hideSelectionPanel();

  await loadCoreData();
  renderDefaultContextPanel();
  await loadStops();
  applyStopHitAreaStylesForZoom();
  renderJourneyOverlay();

  map.invalidateSize();
  updateBusPositionsLive();
  setTrackingMode("scheduled");
  updateNetworkLayer();

  busUpdateTimerId = window.setInterval(() => {
    if (!isMapMoving) {
      updateBusPositionsLive();
    }
  }, VEHICLE_UPDATE_INTERVAL_MS);
}

init().catch(err => console.error(err));
