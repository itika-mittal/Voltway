
/* ==========================================
   VOLTWAY - FRONTEND JAVASCRIPT
========================================== */

const API_BASE_URL = "https://voltway-backend-sod2.onrender.com";


/* ==========================================
   1. CITY COORDINATES
========================================== */

const cityCoordinates = {
    "delhi": [28.6139, 77.2090],
    "new delhi": [28.6139, 77.2090],
    "gurugram": [28.4595, 77.0266],
    "gurgaon": [28.4595, 77.0266],
    "noida": [28.5355, 77.3910],
    "jaipur": [26.9124, 75.7873],
    "udaipur": [24.5854, 73.7125],
    "agra": [27.1767, 78.0081],
    "chandigarh": [30.7333, 76.7794],
    "dehradun": [30.3165, 78.0322],
    "lucknow": [26.8467, 80.9462],
    "amritsar": [31.6340, 74.8723],
    "mumbai": [19.0760, 72.8777],
    "pune": [18.5204, 73.8567],
    "ahmedabad": [23.0225, 72.5714],
    "bengaluru": [12.9716, 77.5946],
    "bangalore": [12.9716, 77.5946],
    "hyderabad": [17.3850, 78.4867],
    "chennai": [13.0827, 80.2707],
    "kolkata": [22.5726, 88.3639]
};


/* ==========================================
   2. GET HTML ELEMENTS
========================================== */

const chargerForm = document.getElementById("charger-form");
const locationInput = document.getElementById("location");
const searchMessage = document.getElementById("search-message");
const stationList = document.getElementById("station-list");

const sortSelect = document.getElementById("sort-stations");
const connectorFilter = document.getElementById("filter-connectors");

const backendStatus = document.getElementById("backend-status");

const tripForm = document.getElementById("trip-form");
const startInput = document.getElementById("start");
const destinationInput = document.getElementById("destination");
const rangeInput = document.getElementById("range");
const tripResult = document.getElementById("trip-result");
const directionsList = document.getElementById("directions-list");
const nearbyPlacesList = document.getElementById("nearby-places-list");


/* ==========================================
   3. INITIALIZE LEAFLET MAP
========================================== */

let map = null;
let chargerMarkers = [];
let tripRouteLayer = null;
let nearbyPlaceLayer = null;

if (typeof L !== "undefined" && document.getElementById("map")) {

    map = L.map("map").setView([28.6139, 77.2090], 11);

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: "&copy; OpenStreetMap contributors",
        maxZoom: 19
    }).addTo(map);

} else {
    console.error("Leaflet could not load. Check index.html.");
}


/* ==========================================
   4. HELPER FUNCTIONS
========================================== */

function showMessage(message) {
    if (searchMessage) {
        searchMessage.textContent = message;
    }
}


function getCityCoordinates(city) {
    const normalizedCity = city.trim().toLowerCase();
    return cityCoordinates[normalizedCity] || null;
}


async function getLocationCoordinates(query) {

    const url =
        `${API_BASE_URL}/api/geocode?query=${encodeURIComponent(query)}`;

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || data.status !== "success") {
        throw new Error(
            data.message || "Unable to find this location."
        );
    }

    if (!Array.isArray(data.locations) || data.locations.length === 0) {
        throw new Error("No matching location found.");
    }

    // Use the first matching result from OpenStreetMap
    const location = data.locations[0];

    return {
        coordinates: [
            Number(location.latitude),
            Number(location.longitude)
        ],
        name: location.display_name
    };
}


function escapeHTML(value) {
    return String(value).replace(/[&<>"']/g, function (character) {
        const entities = {
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        };

        return entities[character];
    });
}


function clearMarkers() {
    if (!map) return;

    chargerMarkers.forEach(function (marker) {
        map.removeLayer(marker);
    });

    chargerMarkers = [];
}


/* ==========================================
   5. CALCULATE DISTANCE
   Haversine formula - straight-line distance
========================================== */

function calculateDistance(pointA, pointB) {

    const earthRadiusKm = 6371;

    const lat1 = pointA[0] * Math.PI / 180;
    const lat2 = pointB[0] * Math.PI / 180;

    const deltaLat = (pointB[0] - pointA[0]) * Math.PI / 180;
    const deltaLon = (pointB[1] - pointA[1]) * Math.PI / 180;

    const a =
        Math.sin(deltaLat / 2) ** 2 +
        Math.cos(lat1) *
        Math.cos(lat2) *
        Math.sin(deltaLon / 2) ** 2;

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return earthRadiusKm * c;
}

/* ==========================================
   ROAD ROUTE HELPER FUNCTIONS
========================================== */

// Convert route coordinates into an encoded polyline
// required by Open Charge Map.

function encodeRoutePolyline(coordinates) {

    let encoded = "";
    let previousLat = 0;
    let previousLng = 0;

    function encodeValue(value) {

        let number = value < 0
            ? ~(value << 1)
            : (value << 1);

        while (number >= 0x20) {
            encoded += String.fromCharCode(
                (0x20 | (number & 0x1f)) + 63
            );

            number >>= 5;
        }

        encoded += String.fromCharCode(number + 63);
    }

    coordinates.forEach(function (coordinate) {

        const longitude = coordinate[0];
        const latitude = coordinate[1];

        const currentLat = Math.round(latitude * 1e5);
        const currentLng = Math.round(longitude * 1e5);

        encodeValue(currentLat - previousLat);
        encodeValue(currentLng - previousLng);

        previousLat = currentLat;
        previousLng = currentLng;
    });

    return encoded;
}


/* ==========================================
   SIMPLIFY ROUTE FOR CHARGER API SEARCH
   Prevents excessively long API URLs
========================================== */

function simplifyRouteCoordinates(coordinates, tolerance) {

    if (!Array.isArray(coordinates) || coordinates.length <= 2) {
        return coordinates;
    }

    const keep = new Uint8Array(coordinates.length);

    keep[0] = 1;
    keep[coordinates.length - 1] = 1;

    const stack = [[0, coordinates.length - 1]];

    while (stack.length > 0) {

        const [first, last] = stack.pop();

        const start = coordinates[first];
        const end = coordinates[last];

        const dx = end[0] - start[0];
        const dy = end[1] - start[1];

        const lengthSquared = dx * dx + dy * dy;

        let maxDistance = tolerance;
        let maxIndex = -1;

        for (let i = first + 1; i < last; i++) {

            const point = coordinates[i];

            let distance;

            if (lengthSquared === 0) {

                distance = Math.hypot(
                    point[0] - start[0],
                    point[1] - start[1]
                );

            } else {

                let t = (
                    (point[0] - start[0]) * dx +
                    (point[1] - start[1]) * dy
                ) / lengthSquared;

                t = Math.max(0, Math.min(1, t));

                const projectedX = start[0] + t * dx;
                const projectedY = start[1] + t * dy;

                distance = Math.hypot(
                    point[0] - projectedX,
                    point[1] - projectedY
                );
            }

            if (distance > maxDistance) {
                maxDistance = distance;
                maxIndex = i;
            }
        }

        if (maxIndex !== -1) {

            keep[maxIndex] = 1;

            stack.push([first, maxIndex]);
            stack.push([maxIndex, last]);
        }
    }

    return coordinates.filter(function (point, index) {
        return keep[index] === 1;
    });
}


/* ==========================================
   CREATE A SHORTER POLYLINE FOR OCM
========================================== */

function createRouteSearchPolyline(routeCoordinates) {

    const maxEncodedLength = 5000;

    // First try the original route without simplification.
    let encoded = encodeRoutePolyline(routeCoordinates);

    if (encodeURIComponent(encoded).length <= maxEncodedLength) {
        return {
            polyline: encoded,
            originalPoints: routeCoordinates.length,
            searchPoints: routeCoordinates.length
        };
    }

    // Increase simplification gradually until the URL is compact.
    const tolerances = [
        0.001,
        0.002,
        0.005,
        0.01,
        0.02,
        0.04,
        0.08,
        0.12,
        0.20
    ];

    for (const tolerance of tolerances) {

        const simplified = simplifyRouteCoordinates(
            routeCoordinates,
            tolerance
        );

        encoded = encodeRoutePolyline(simplified);

        if (encodeURIComponent(encoded).length <= maxEncodedLength) {

            return {
                polyline: encoded,
                originalPoints: routeCoordinates.length,
                searchPoints: simplified.length
            };
        }
    }

    throw new Error(
        "The route is too detailed for charger search. " +
        "Please try a shorter journey."
    );
}

// Remove only the previous trip route and its markers

function clearTripRoute() {

    if (map && tripRouteLayer) {
        map.removeLayer(tripRouteLayer);
    }

    if (map && nearbyPlaceLayer) {
        map.removeLayer(nearbyPlaceLayer);
    }

    tripRouteLayer = null;
    nearbyPlaceLayer = null;
}


// Format seconds into hours and minutes

function formatDrivingTime(seconds) {

    const totalMinutes = Math.round(seconds / 60);

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;

    if (hours === 0) {
        return `${minutes} minutes`;
    }

    return `${hours} hr ${minutes} min`;
}


// Draw road route and start/end markers

function drawTripRoute(routeCoordinates) {

    if (!map) return;

    clearTripRoute();

    tripRouteLayer = L.layerGroup().addTo(map);

    const routeLatLngs = routeCoordinates.map(function (point) {
        return [point[1], point[0]];
    });

    const routeLine = L.polyline(routeLatLngs, {
        color: "#36E6FF",
        weight: 6,
        opacity: 0.9,
        lineCap: "round",
        lineJoin: "round"
    });

    routeLine.addTo(tripRouteLayer);

    // Starting point marker
    L.circleMarker(routeLatLngs[0], {
        radius: 9,
        color: "#FFFFFF",
        weight: 3,
        fillColor: "#36E6A0",
        fillOpacity: 1
    })
    .bindPopup("Trip starting point")
    .addTo(tripRouteLayer);

    // Destination marker
    L.circleMarker(
        routeLatLngs[routeLatLngs.length - 1],
        {
            radius: 9,
            color: "#FFFFFF",
            weight: 3,
            fillColor: "#FF6B81",
            fillOpacity: 1
        }
    )
    .bindPopup("Trip destination")
    .addTo(tripRouteLayer);

    // Fit the complete route inside the map
    map.fitBounds(routeLine.getBounds(), {
        padding: [45, 45]
    });
}


if (directionsList) {
    directionsList.innerHTML = `
        <div class="trip-empty-state">
            <span>🧭</span>
            <p>Your route directions will appear here after you plan a trip.</p>
        </div>
    `;
}

if (nearbyPlacesList) {
    nearbyPlacesList.innerHTML = `
        <div class="trip-empty-state">
            <span>☕</span>
            <p>Food, cafés, and shopping suggestions will appear here.</p>
        </div>
    `;
}


/* ==========================================
   DISPLAY CHARGING STATIONS ALONG THE ROUTE
========================================== */

function displayRouteChargers(chargers) {

    if (!Array.isArray(chargers)) {
        return [];
    }

    const validChargers = [];
    const seenIds = new Set();

    chargers.forEach(function (charger) {

        const info = charger.AddressInfo || {};

        const latitude = Number(info.Latitude);
        const longitude = Number(info.Longitude);

        if (
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude) ||
            Math.abs(latitude) > 90 ||
            Math.abs(longitude) > 180
        ) {
            return;
        }

        // Prevent duplicate charging stations
        const stationId = charger.ID || `${latitude},${longitude}`;

        if (seenIds.has(stationId)) return;
        seenIds.add(stationId);

        const name = info.Title || "EV Charging Station";

        const address = [
            info.AddressLine1,
            info.Town,
            info.StateOrProvince
        ].filter(Boolean).join(", ");

        const connections = Array.isArray(charger.Connections)
            ? charger.Connections
            : [];

        const connectorNames = [
            ...new Set(
                connections.map(function (connection) {
                    return connection.ConnectionType
                        ? connection.ConnectionType.Title
                        : null;
                }).filter(Boolean)
            )
        ];

        const powers = connections
            .map(function (connection) {
                return Number(connection.PowerKW);
            })
            .filter(function (power) {
                return Number.isFinite(power) && power > 0;
            });

        const maxPower = powers.length
            ? Math.max(...powers)
            : null;

        const station = {
            name: name,
            address: address || "Address unavailable",
            latitude: latitude,
            longitude: longitude,
            connectors: connectorNames,
            power: maxPower
        };

        validChargers.push(station);

        // Add blue route charging station markers
        if (map && tripRouteLayer) {

            const marker = L.circleMarker(
                [latitude, longitude],
                {
                    radius: 7,
                    color: "#FFFFFF",
                    weight: 2,
                    fillColor: "#3B82F6",
                    fillOpacity: 1
                }
            );

            const popup = `
                <div class="voltway-popup">
                    <div class="popup-label">ROUTE CHARGING STATION</div>

                    <strong>${escapeHTML(name)}</strong>

                    <p>${escapeHTML(station.address)}</p>

                    <p>
                        ${maxPower !== null
                            ? escapeHTML(maxPower) + " kW"
                            : "Power unavailable"}
                    </p>

                    <p>
                        ${connectorNames.length
                            ? escapeHTML(connectorNames.join(", "))
                            : "Connector details unavailable"}
                    </p>
                </div>
            `;

            marker.bindPopup(popup);
            marker.addTo(tripRouteLayer);
        }
    });

    return validChargers;
}


/* ==========================================
   6. BACKEND CONNECTION CHECK
========================================== */

async function checkBackendStatus() {

    if (!backendStatus) return;

    backendStatus.textContent = "Checking backend connection...";

    try {

        const response = await fetch(`${API_BASE_URL}/api/health`);
        const data = await response.json();

        if (!response.ok || data.status !== "success") {
            throw new Error("Backend health check failed.");
        }

        backendStatus.textContent =
            "Connected — Voltway backend is running.";

        backendStatus.style.color = "#36E6A0";

    } catch (error) {

        console.error("Backend connection error:", error);

        backendStatus.textContent =
            "Disconnected — Start the Flask backend and refresh the page.";

        backendStatus.style.color = "#FF6B81";
    }
}


/* ==========================================
   7. STATION DATA
========================================== */

let allStations = [];

// Coordinates of the city currently being searched
let currentSearchCoordinates = null;


/* ==========================================
   8. DISPLAY CHARGERS
========================================== */

function displayChargers(chargers) {

    if (!stationList) return;

    clearMarkers();
    allStations = [];

    if (!Array.isArray(chargers) || chargers.length === 0) {

        stationList.textContent = "No charging stations found nearby.";

        if (connectorFilter) {
            connectorFilter.replaceChildren(
                new Option("All connectors", "all")
            );
        }

        showMessage("No stations found. Try another supported city.");
        return;
    }


    chargers.forEach(function (charger) {

        const info = charger.AddressInfo || {};

        const latitude = Number(info.Latitude);
        const longitude = Number(info.Longitude);

        // Ignore stations without valid coordinates
        if (
            info.Latitude == null ||
            info.Longitude == null ||
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude) ||
            Math.abs(latitude) > 90 ||
            Math.abs(longitude) > 180
        ) {
            return;
        }


        // Station name
        const name = info.Title || "EV Charging Station";


        // Build address from available fields
        const addressParts = [
            info.AddressLine1,
            info.AddressLine2,
            info.Town,
            info.StateOrProvince,
            info.Postcode,
            info.Country && info.Country.Title
        ].filter(Boolean);

        const address = [...new Set(addressParts)].join(", ");


        // Connector information
        const connections = Array.isArray(charger.Connections)
            ? charger.Connections
            : [];

        const connectorNames = [
            ...new Set(
                connections
                    .map(function (connection) {
                        return connection.ConnectionType
                            ? connection.ConnectionType.Title
                            : null;
                    })
                    .filter(Boolean)
            )
        ];


        // Charging power values
        const powerValues = connections
            .map(function (connection) {
                return Number(connection.PowerKW);
            })
            .filter(function (power) {
                return Number.isFinite(power) && power > 0;
            });

        const maxPower = powerValues.length
            ? Math.max(...powerValues)
            : null;


        // Calculate distance from the searched city.
        // This avoids relying on API distance values.
        let distance = null;

        if (currentSearchCoordinates) {
            distance = calculateDistance(
                currentSearchCoordinates,
                [latitude, longitude]
            );
        }


        // Store station information
        allStations.push({
            name: name,
            address: address || "Address unavailable",
            latitude: latitude,
            longitude: longitude,
            connectors: connectorNames,
            power: maxPower,
            distance: distance
        });

    });


    if (allStations.length === 0) {

        stationList.textContent =
            "No stations with usable map coordinates were returned.";

        showMessage("No mappable stations were returned.");
        return;
    }


    updateConnectorOptions();
    renderStationCards();

    showMessage(
        `Found ${allStations.length} charging station(s). ` +
        "Live charger availability has not been verified."
    );
}


/* ==========================================
   9. UPDATE CONNECTOR FILTER OPTIONS
========================================== */

function updateConnectorOptions() {

    if (!connectorFilter) return;

    const previousValue = connectorFilter.value;

    const connectorTypes = [
        ...new Set(
            allStations.flatMap(function (station) {
                return station.connectors;
            })
        )
    ].sort();


    connectorFilter.replaceChildren(
        new Option("All connectors", "all")
    );


    connectorTypes.forEach(function (connector) {

        connectorFilter.add(
            new Option(connector, connector)
        );

    });


    const optionExists = Array.from(connectorFilter.options)
        .some(function (option) {
            return option.value === previousValue;
        });

    connectorFilter.value = optionExists
        ? previousValue
        : "all";
}


/* ==========================================
   10. FILTER AND SORT STATIONS
========================================== */

function getFilteredStations() {

    let stations = [...allStations];


    // Connector filtering
    const selectedConnector = connectorFilter
        ? connectorFilter.value
        : "all";


    if (selectedConnector !== "all") {

        stations = stations.filter(function (station) {
            return station.connectors.includes(selectedConnector);
        });

    }


    // Sorting
    const sortValue = sortSelect
        ? sortSelect.value
        : "nearest";


    if (sortValue === "nearest") {

        stations.sort(function (a, b) {

            // Stations with unknown distance go last
            if (a.distance === null) return 1;
            if (b.distance === null) return -1;

            return a.distance - b.distance;
        });

    }


    if (sortValue === "power") {

        stations.sort(function (a, b) {

            // Stations with unknown power go last
            if (a.power === null) return 1;
            if (b.power === null) return -1;

            return b.power - a.power;
        });

    }


    return stations;
}


/* ==========================================
   11. RENDER PREMIUM STATION CARDS & MARKERS
========================================== */

function renderStationCards() {

    if (!stationList) return;

    stationList.replaceChildren();
    clearMarkers();

    const stations = getFilteredStations();

    if (stations.length === 0) {
        const emptyMessage = document.createElement("p");
        emptyMessage.className = "empty-state";
        emptyMessage.textContent =
            "No stations match this connector type. Try another filter.";

        stationList.appendChild(emptyMessage);
        return;
    }

    const validLocations = [];

    stations.forEach(function (station, index) {

        let marker = null;

        // Create Leaflet marker using the station's actual API coordinates
        if (map) {

            
const markerIcon = L.divIcon({
    className: "voltway-marker-wrapper",

    html: `
        <div class="voltway-map-pin">
            <span>⚡</span>
        </div>
    `,

    iconSize: [30, 40],
    iconAnchor: [19, 43],
    popupAnchor: [0, -40]
});

marker = L.marker(
    [station.latitude, station.longitude],
    {
        icon: markerIcon,
        riseOnHover: true
    }
).addTo(map);

// Highlight the marker when selected
function highlightMarker(selectedMarker) {
    chargerMarkers.forEach(function (item) {
        const element = item.getElement();

        if (element) {
            element.classList.toggle(
                "voltway-marker-active",
                item === selectedMarker
            );
        }
    });
}

marker.on("click", function () {
    highlightMarker(marker);
});


            const popupContent = `
                <div class="voltway-popup">
                    <div class="popup-label">EV CHARGING STATION</div>

                    <strong>${escapeHTML(station.name)}</strong>

                    <p>${escapeHTML(station.address)}</p>

                    <div class="popup-details">
                        <span>
                            ${station.power !== null
                                ? escapeHTML(station.power) + " kW"
                                : "Power unavailable"}
                        </span>

                        <span>
                            ${station.connectors.length
                                ? escapeHTML(station.connectors.join(", "))
                                : "Connector details unavailable"}
                        </span>
                    </div>
                </div>
            `;

            marker.bindPopup(popupContent, {
                maxWidth: 280,
                minWidth: 200
            });

            chargerMarkers.push(marker);
        }


        // Create station card
        const card = document.createElement("article");
        card.className = "station-card station-card-premium";


        // Format distance
        const distanceLabel = station.distance !== null
            ? station.distance.toFixed(1) + " km away"
            : "Distance unavailable";


        // Format power
        const powerLabel = station.power !== null
            ? station.power + " kW"
            : "Power unavailable";


        // Connector chips
        const connectorHTML = station.connectors.length
            ? station.connectors.map(function (connector) {
                return `
                    <span class="connector-chip">
                        ${escapeHTML(connector)}
                    </span>
                `;
            }).join("")
            : `
                <span class="connector-chip connector-chip-muted">
                    Connector details unavailable
                </span>
            `;


        // Card layout
        card.innerHTML = `
            <div class="station-card-header">
                <div>
                    <h3>${escapeHTML(station.name)}</h3>
                </div>
            </div>

            <div class="station-distance-badge">
                <span class="distance-icon">↗</span>
                ${escapeHTML(distanceLabel)}
            </div>

            <div class="station-address-block">
                <span class="station-info-label">LOCATION</span>
                <p class="station-address">
                    ${escapeHTML(station.address)}
                </p>
            </div>

            <div class="station-connectors-block">
                <span class="station-info-label">CONNECTOR TYPES</span>
                <div class="connector-chips">
                    ${connectorHTML}
                </div>
            </div>

            <div class="station-power-block">
                <span class="station-info-label">MAX CHARGING POWER</span>
                <div class="station-power-value">
                    <strong>${escapeHTML(powerLabel)}</strong>
                    <span class="power-symbol"></span>
                </div>
            </div>

            <button
                type="button"
                class="btn station-map-button"
                ${map ? "" : "disabled"}
            >
                <span>View on Map</span>
                <span class="map-button-arrow">↗</span>
            </button>
        `;

        // View on Map action
        const mapButton = card.querySelector(".station-map-button");

        mapButton.addEventListener("click", function () {

            if (!map || !marker) return;

            const tripSection = document.getElementById("plan-trip");

            if (tripSection) {
                tripSection.scrollIntoView({
                    behavior: "smooth",
                    block: "start"
                });
            }

            // Allow the page to scroll before resizing the map.
            setTimeout(function () {

                map.invalidateSize();

                highlightMarker(marker);

                map.flyTo(
                    [station.latitude, station.longitude],
                    16,
                    {
                        animate: true,
                        duration: 0.8
                    }
                );

                marker.openPopup();

            }, 450);
        });


        stationList.appendChild(card);

        validLocations.push([
            station.latitude,
            station.longitude
        ]);

    });


    // Update map dimensions
    if (map) {

        map.invalidateSize();

        if (validLocations.length === 1) {

            map.setView(validLocations[0], 14);

        } else if (validLocations.length > 1) {

            map.fitBounds(validLocations, {
                padding: [40, 40],
                maxZoom: 13
            });
            
        }
        setTimeout(function () {
        map.invalidateSize();
        }, 200);
    }
}


/* ==========================================
   12. LISTEN FOR FILTER AND SORT CHANGES
========================================== */

if (sortSelect) {
    sortSelect.addEventListener("change", renderStationCards);
}

if (connectorFilter) {
    connectorFilter.addEventListener("change", renderStationCards);
}


/* ==========================================
   13. SEARCH FOR CHARGING STATIONS
========================================== */


async function searchChargers(event) {

    if (event) {
        event.preventDefault();
    }

    if (!locationInput || !stationList) return;

    const city = locationInput.value.trim();

    if (!city) {
        showMessage("Please enter a city or locality.");
        return;
    }

    showMessage("Finding your location...");

    stationList.textContent = "Searching for your location...";

    allStations = [];
    clearMarkers();

    if (connectorFilter) {
        connectorFilter.replaceChildren(
            new Option("All connectors", "all")
        );
    }

    try {

        // STEP 1: Convert the entered location into coordinates
        const locationData = await getLocationCoordinates(city);

        const coordinates = locationData.coordinates;

        // Validate returned coordinates
        if (
            !Number.isFinite(coordinates[0]) ||
            !Number.isFinite(coordinates[1])
        ) {
            throw new Error("Invalid coordinates received.");
        }

        // Save coordinates for station distance calculations
        currentSearchCoordinates = coordinates;

        showMessage(
            `Location found: ${locationData.name}. Finding nearby chargers...`
        );

        stationList.textContent = "Loading charging stations...";

        // STEP 2: Fetch chargers using the new coordinates
        const url =
            `${API_BASE_URL}/api/chargers` +
            `?latitude=${coordinates[0]}` +
            `&longitude=${coordinates[1]}`;

        const response = await fetch(url);

        const data = await response.json();

        if (!response.ok || data.status !== "success") {
            throw new Error(
                data.message || "Unable to retrieve charging stations."
            );
        }

        // STEP 3: Display stations on the page and map
        displayChargers(data.chargers);

    } catch (error) {

        console.error("Voltway location search error:", error);

        stationList.textContent =
            "Unable to find charging stations for this location.";

        showMessage(
            error.message || "Location search failed. Please try again."
        );

    }
}

if (chargerForm) {
    chargerForm.addEventListener("submit", searchChargers);
}


/* ==========================================
   TRIP DIRECTIONS RENDERER + MAP NAVIGATION
========================================== */

function renderTripDirections(route) {

    if (!directionsList) return;

    directionsList.replaceChildren();

    const legs = route.legs || [];
    const allSteps = [];

    legs.forEach(function (leg) {

        (leg.steps || []).forEach(function (step) {

            if (step.maneuver && step.maneuver.location) {
                allSteps.push(step);
            }

        });

    });

    if (allSteps.length === 0) {

        const message = document.createElement("p");

        message.textContent =
            "No turn-by-turn directions were returned.";

        directionsList.appendChild(message);
        return;
    }

    allSteps.forEach(function (step, index) {

        const button = document.createElement("button");

        button.type = "button";
        button.className = "direction-step";

        const number = document.createElement("div");

        number.className = "direction-step-number";
        number.textContent = index + 1;

        const content = document.createElement("div");

        content.className = "direction-step-content";

        const instruction = document.createElement("strong");

        const maneuver = step.maneuver || {};

        const type = maneuver.type || "continue";
        const modifier = maneuver.modifier || "";

        let instructionText = type.replaceAll("_", " ");

        if (modifier) {
            instructionText += " " + modifier.replaceAll("_", " ");
        }

        if (step.name) {
            instructionText += " onto " + step.name;
        }

        if (type === "arrive") {
            instructionText = "Arrive at your destination";
        }

        if (type === "depart") {
            instructionText = "Start your journey";
        }

        instruction.textContent =
            instructionText.charAt(0).toUpperCase() +
            instructionText.slice(1);

        const details = document.createElement("span");

        const stepDistance = step.distance >= 1000
            ? (step.distance / 1000).toFixed(1) + " km"
            : Math.round(step.distance) + " m";

        details.textContent =
            stepDistance + " · " + formatDrivingTime(step.duration);

        content.appendChild(instruction);
        content.appendChild(details);

        button.appendChild(number);
        button.appendChild(content);


    button.addEventListener("click", function () {

        const location = maneuver.location;

        if (!map || !location) return;

        // Highlight the selected direction
        directionsList
            .querySelectorAll(".direction-step")
            .forEach(function (item) {
                item.classList.remove("active");
            });

        button.classList.add("active");

        const latitude = location[1];
        const longitude = location[0];

        // Find the map panel
        const mapPanel = document.querySelector(".trip-map-panel");

        if (mapPanel) {

            // Bring the map into the visible screen area
            mapPanel.scrollIntoView({
                behavior: "smooth",
                block: "center"
            });
        }

        // Wait for the page scroll before moving the map
        setTimeout(function () {

            map.invalidateSize();

            map.flyTo(
                [latitude, longitude],
                16,
                {
                    animate: true,
                    duration: 0.8
                }
            );

            // Display selected direction details
            L.popup()
                .setLatLng([latitude, longitude])
                .setContent(`
                    <div class="voltway-popup">
                        <div class="popup-label">TURN-BY-TURN NAVIGATION</div>
                        <strong>Step ${index + 1}</strong>
                        <p>${escapeHTML(instructionText)}</p>
                        <p>${escapeHTML(details.textContent)}</p>
                    </div>
                `)
                .openOn(map);

        }, 500);

    });

        directionsList.appendChild(button);

    });
}


/* ==========================================
   NEARBY PLACES RENDERER + MAP MARKERS
========================================== */

function renderNearbyPlaces(places, errorMessage = "") {

    if (!nearbyPlacesList) return;

    nearbyPlacesList.replaceChildren();

    // Remove old nearby-place markers
    if (map && nearbyPlaceLayer) {
        map.removeLayer(nearbyPlaceLayer);
    }

    nearbyPlaceLayer = null;

    if (errorMessage) {
        const message = document.createElement("p");
        message.textContent = errorMessage;
        nearbyPlacesList.appendChild(message);
        return;
    }

    if (!Array.isArray(places) || places.length === 0) {

        const emptyState = document.createElement("div");

        emptyState.className = "trip-empty-state";

        emptyState.innerHTML = `
            <span>☕</span>
            <p>No nearby food or shopping suggestions were found around the selected route chargers.</p>
        `;

        nearbyPlacesList.appendChild(emptyState);
        return;
    }

    // Create a separate layer for yellow nearby-place markers
    if (map) {
        nearbyPlaceLayer = L.layerGroup().addTo(map);
    }

    places.forEach(function (place) {

        const latitude = Number(place.latitude);
        const longitude = Number(place.longitude);

        if (
            !Number.isFinite(latitude) ||
            !Number.isFinite(longitude) ||
            Math.abs(latitude) > 90 ||
            Math.abs(longitude) > 180
        ) {
            return;
        }

        const placeName = place.name || "Unnamed place";
        const placeCategory = place.category || "Nearby place";
        const placeAddress = place.address || "Address unavailable";

        const card = document.createElement("article");

        card.className = "nearby-place-card";

        const category = document.createElement("span");
        category.className = "nearby-place-tag";
        category.textContent = placeCategory;

        const heading = document.createElement("h4");
        heading.textContent = placeName;

        const address = document.createElement("p");
        address.textContent = placeAddress;

        const distance = document.createElement("p");

        const hasDistance =
            place.distance_km !== null &&
            place.distance_km !== undefined &&
            Number.isFinite(Number(place.distance_km));

        distance.textContent = hasDistance
            ? Number(place.distance_km).toFixed(1) +
              " km from a selected charging station"
            : "Distance unavailable";

        card.appendChild(category);
        card.appendChild(heading);
        card.appendChild(address);
        card.appendChild(distance);

        let placeMarker = null;

        // Create yellow nearby-place marker
        if (map && nearbyPlaceLayer) {

            placeMarker = L.circleMarker(
                [latitude, longitude],
                {
                    radius: 8,
                    color: "#FFFFFF",
                    weight: 2,
                    fillColor: "#FFCA66",
                    fillOpacity: 1
                }
            );

            const popupContent = `
                <div class="voltway-popup">
                    <div class="popup-label">NEARBY PLACE</div>

                    <strong>${escapeHTML(placeName)}</strong>

                    <p>${escapeHTML(placeCategory)}</p>

                    <p>${escapeHTML(placeAddress)}</p>

                    <p>
                        ${hasDistance
                            ? escapeHTML(Number(place.distance_km).toFixed(1)) +
                              " km from a selected charging station"
                            : "Distance unavailable"}
                    </p>
                </div>
            `;

            placeMarker.bindPopup(popupContent);
            placeMarker.addTo(nearbyPlaceLayer);
        }

        // Make the nearby-place card focus its map marker
        if (map && placeMarker) {

            card.tabIndex = 0;
            card.setAttribute("role", "button");

            card.setAttribute(
                "aria-label",
                `Show ${placeName} on map`
            );

            function focusPlaceMarker() {

                // Find the Leaflet map panel
                const mapPanel = document.querySelector(".trip-map-panel");

                // Scroll back to the map automatically
                if (mapPanel) {

                    mapPanel.scrollIntoView({
                        behavior: "smooth",
                        block: "center"
                    });
                }

                // Wait for scrolling before moving the map
                setTimeout(function () {

                    map.invalidateSize();

                    map.flyTo(
                        [latitude, longitude],
                        16,
                        {
                            animate: true,
                            duration: 0.8
                        }
                    );

                    // Open the selected nearby-place popup
                    placeMarker.openPopup();

                }, 500);
            }

            card.addEventListener("click", focusPlaceMarker);

            card.addEventListener("keydown", function (event) {

                if (event.key === "Enter" || event.key === " ") {

                    event.preventDefault();

                    focusPlaceMarker();
                }
            });
        }

        nearbyPlacesList.appendChild(card);
    });
}


/* ==========================================
   14. TRIP PLANNER
========================================== */

function showTripMessage(message) {

    if (!tripResult) return;

    const messageElement = document.createElement("p");

    messageElement.className = "trip-error";
    messageElement.textContent = message;

    tripResult.replaceChildren(messageElement);
    tripResult.hidden = false;
}

async function planTrip(event) {

    event.preventDefault();

    if (!startInput || !destinationInput || !rangeInput || !tripResult) {
        return;
    }

    const startCity = startInput.value.trim();
    const destinationCity = destinationInput.value.trim();
    const vehicleRange = Number(rangeInput.value);

    if (!startCity || !destinationCity) {
        showTripMessage(
            "Please enter both the starting point and destination."
        );
        return;
    }

    if (
        !Number.isFinite(vehicleRange) ||
        vehicleRange <= 0 ||
        vehicleRange > 1500
    ) {
        showTripMessage(
            "Enter a valid vehicle range between 1 and 1500 km."
        );
        return;
    }

    // Show loading state
    tripResult.replaceChildren();
    if (directionsList) {
    directionsList.innerHTML = `
        <div class="trip-empty-state">
            <span>🧭</span>
            <p>Calculating turn-by-turn directions...</p>
        </div>
    `;
    }

    if (nearbyPlacesList) {
        nearbyPlacesList.innerHTML = `
            <div class="trip-empty-state">
                <span>☕</span>
                <p>Looking for places near route charging stations...</p>
            </div>
        `;
    }

    const loadingMessage = document.createElement("p");
    loadingMessage.textContent = "Finding your locations...";

    tripResult.appendChild(loadingMessage);
    tripResult.hidden = false;

    clearTripRoute();

    try {


    // STEP 1: Find both locations simultaneously

    loadingMessage.textContent =
        "Finding your starting point and destination...";

    const [startLocation, destinationLocation] =
        await Promise.all([
            getLocationCoordinates(startCity),
            getLocationCoordinates(destinationCity)
        ]);

    loadingMessage.textContent =
        "Both locations found. Calculating your road route...";


        const startCoordinates = startLocation.coordinates;
        const destinationCoordinates = destinationLocation.coordinates;

        loadingMessage.textContent =
            "Calculating your road route...";

        // STEP 3: Request actual driving route from OSRM
        const routeURL =
            "https://router.project-osrm.org/route/v1/driving/" +
            `${startCoordinates[1]},${startCoordinates[0]};` +
            `${destinationCoordinates[1]},${destinationCoordinates[0]}` +
            "?overview=full&geometries=geojson&steps=true";

        const routeResponse = await fetch(routeURL);
        const routeData = await routeResponse.json();

        if (
            !routeResponse.ok ||
            routeData.code !== "Ok" ||
            !routeData.routes ||
            !routeData.routes.length
        ) {
            throw new Error(
                "A driving route could not be found between these locations."
            );
        }

        const route = routeData.routes[0];
        renderTripDirections(route);

        const routeCoordinates = route.geometry.coordinates;

        // Convert route distance from metres to kilometres
        const roadDistance = route.distance / 1000;

        // Convert estimated duration into readable format
        const drivingTime = formatDrivingTime(route.duration);

        // STEP 4: Draw road route on Leaflet map
        drawTripRoute(routeCoordinates);

        loadingMessage.textContent =
            "Road route found. Looking for charging stations...";


        // STEP 5: Create a compact route for Open Charge Map

        const routeSearch = createRouteSearchPolyline(routeCoordinates);

        const encodedPolyline = routeSearch.polyline;

        console.log("Route charger search preparation:", {
            originalPoints: routeSearch.originalPoints,
            searchPoints: routeSearch.searchPoints,
            encodedURLLength: encodeURIComponent(encodedPolyline).length
        });

        let routeChargers = [];
        let chargerSearchMessage = "";

        try {

            const chargerResponse = await fetch(
                `${API_BASE_URL}/api/chargers/along-route`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        polyline: encodedPolyline
                    })
                }
            );

            const chargerData = await chargerResponse.json();

            if (
                !chargerResponse.ok ||
                chargerData.status !== "success"
            ) {
                throw new Error(
                    chargerData.message ||
                    "Unable to find chargers along the route."
                );
            }

            // Add charging station markers to the map
            routeChargers = displayRouteChargers(
                chargerData.chargers
            );



/* STEP 5B: Load nearby places independently */

if (nearbyPlacesList) {
    nearbyPlacesList.innerHTML = `
        <div class="trip-empty-state">
            <span>☕</span>
            <p>Searching for nearby food and shopping places...</p>
        </div>
    `;
}

const selectedChargers = routeChargers.slice(0, 5);

// Run this request independently.
// Do not make the trip summary wait for it.
(async function loadNearbyPlaces() {

    try {

        if (selectedChargers.length === 0) {
            renderNearbyPlaces([]);
            return;
        }

        const placesResponse = await fetch(
            `${API_BASE_URL}/api/nearby-places`,
            {
                method: "POST",
                headers: {
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    locations: selectedChargers.map(function (station) {
                        return {
                            latitude: station.latitude,
                            longitude: station.longitude,
                            charger_name: station.name
                        };
                    })
                })
            }
        );

        const placesData = await placesResponse.json();

        if (
            !placesResponse.ok ||
            placesData.status !== "success"
        ) {
            throw new Error(
                placesData.message ||
                "Nearby place search failed."
            );
        }

        // Display nearby places when the API responds.
        renderNearbyPlaces(placesData.places);

    } catch (placesError) {

        console.error("Nearby places error:", placesError);

        renderNearbyPlaces(
            [],
            placesError.message ||
            "Unable to retrieve nearby places. Please try again."
        );
    }

})();


       } catch (chargerError) {

            console.error(
                "Route charger search error:",
                chargerError
            );

            chargerSearchMessage =
                "Charging station information could not be loaded.";

            renderNearbyPlaces(
                [],
                "Nearby recommendations are unavailable because route charging stations could not be retrieved."
            );
        }

        // STEP 6: Estimate charging stops using road distance
        const planningRange = vehicleRange * 0.8;

        const estimatedStops = roadDistance <= planningRange
            ? 0
            : Math.max(
                0,
                Math.ceil(roadDistance / planningRange) - 1
            );

        // STEP 7: Build trip summary
        const resultHeading = document.createElement("h3");
        resultHeading.textContent = "Your Trip Summary";

        const routeText = document.createElement("p");
        routeText.textContent =
            `${startLocation.name} → ${destinationLocation.name}`;

        const distanceText = document.createElement("p");
        distanceText.textContent =
            `Road distance: ${roadDistance.toFixed(1)} km`;

        const durationText = document.createElement("p");
        durationText.textContent =
            `Estimated driving time: ${drivingTime}`;

        const rangeText = document.createElement("p");
        rangeText.textContent =
            `Vehicle range entered: ${vehicleRange} km`;

        const reserveText = document.createElement("p");
        reserveText.textContent =
            `Planning range (80% allowance): ${planningRange.toFixed(0)} km`;

        const stopsText = document.createElement("p");
        stopsText.textContent =
            `Estimated charging stops: ${estimatedStops}`;

        const chargersHeading = document.createElement("h3");
        chargersHeading.textContent =
            `Charging stations along your route (${routeChargers.length})`;

        tripResult.replaceChildren(
            resultHeading,
            routeText,
            distanceText,
            durationText,
            rangeText,
            reserveText,
            stopsText,
            chargersHeading
        );

        // STEP 8: Display charger names
        if (routeChargers.length > 0) {

            const chargerList = document.createElement("ul");

            routeChargers.slice(0, 10).forEach(function (station) {

                const item = document.createElement("li");

                const stationName = document.createElement("strong");
                stationName.textContent = station.name;

                const stationDetails = document.createElement("p");

                stationDetails.textContent =
                    `${station.address} | ` +
                    `${station.power !== null
                        ? station.power + " kW"
                        : "Power unavailable"}`;

                item.appendChild(stationName);
                item.appendChild(stationDetails);

                chargerList.appendChild(item);
            });

            tripResult.appendChild(chargerList);

            if (routeChargers.length > 10) {
                const moreText = document.createElement("p");

                moreText.textContent =
                    `Showing 10 of ${routeChargers.length} stations. ` +
                    "All returned stations are marked on the map.";

                tripResult.appendChild(moreText);
            }

        } else {

            const noChargers = document.createElement("p");

            noChargers.textContent =
                "No charging stations were found in the searched route corridor.";

            tripResult.appendChild(noChargers);
        }

        if (chargerSearchMessage) {
            const warning = document.createElement("p");
            warning.textContent = chargerSearchMessage;
            tripResult.appendChild(warning);
        }

        // STEP 9: Add important disclaimer
        const disclaimer = document.createElement("p");

        disclaimer.className = "trip-disclaimer";

        disclaimer.textContent =
            "Route and driving time are estimates from OpenStreetMap " +
            "routing data, not live traffic predictions. Charging-stop " +
            "estimates use an 80% vehicle-range allowance and do not " +
            "guarantee charger availability or suitability. Check the " +
            "route and charging stations before travelling.";

        tripResult.appendChild(disclaimer);

        tripResult.hidden = false;

    } catch (error) {

        console.error("Voltway trip planner error:", error);
        
        if (directionsList) {
            directionsList.innerHTML = `
                <div class="trip-empty-state">
                    <span>🧭</span>
                    <p>Directions could not be generated. Please check your locations and try again.</p>
                </div>
            `;
        }

        if (nearbyPlacesList) {
            renderNearbyPlaces(
                [],
                "Nearby recommendations will appear after a successful trip calculation."
            );
        }

        showTripMessage(
            error.message ||
            "Unable to plan this trip. Please try again."
        );
    }
}

if (tripForm) {
    tripForm.addEventListener("submit", planTrip);
}


/* ==========================================
   15. INITIAL PAGE LOAD
========================================== */

document.addEventListener("DOMContentLoaded", function () {

    checkBackendStatus();


    // Start with Delhi in the charger search
    if (locationInput && !locationInput.value.trim()) {
        locationInput.value = "Delhi";
    }


    // Automatically search for stations when the page opens
    if (chargerForm) {
        searchChargers();
    }

});

/* ==========================================
   VOLTWAY — LIGHT / DARK MODE TOGGLE
========================================== */

const themeToggle = document.getElementById("theme-toggle");

// Load the previously selected theme
const savedTheme = localStorage.getItem("voltway-theme");

if (savedTheme === "light") {
    document.body.classList.add("light-theme");
}

// Update button text
function updateThemeButton() {
    const isLight = document.body.classList.contains("light-theme");

    themeToggle.textContent = isLight ? "🌙 Dark Mode" : "☀️ Light Mode";

    themeToggle.setAttribute(
        "aria-label",
        isLight ? "Switch to dark mode" : "Switch to light mode"
    );
}

updateThemeButton();

// Switch themes when clicked
themeToggle.addEventListener("click", function () {

    document.body.classList.toggle("light-theme");

    const isLight = document.body.classList.contains("light-theme");

    localStorage.setItem(
        "voltway-theme",
        isLight ? "light" : "dark"
    );

    updateThemeButton();

});