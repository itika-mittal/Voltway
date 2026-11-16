
from flask import Flask, jsonify, request
from flask_cors import CORS
import requests
import os
import time
import threading
from dotenv import load_dotenv


# --------------------------------------------------
# 1. Load environment variables
# --------------------------------------------------

load_dotenv()


# --------------------------------------------------
# 2. Create Flask application
# --------------------------------------------------

app = Flask(__name__)
CORS(app)


# --------------------------------------------------
# 3. Get Open Charge Map API key
# --------------------------------------------------

OPENCHARGEMAP_API_KEY = os.getenv("OPENCHARGEMAP_API_KEY")


# --------------------------------------------------
# 4. Geocoding cache and request control
# --------------------------------------------------

# Store previously searched locations to avoid
# repeatedly requesting the same location.

geocode_cache = {}

# Nominatim allows a maximum of one request per second.
geocode_lock = threading.Lock()
last_geocode_request = 0


# --------------------------------------------------
# 5. Home route
# --------------------------------------------------

@app.route("/")
def home():
    return "Voltway backend is running!"


# --------------------------------------------------
# 6. Health check route
# --------------------------------------------------

@app.route("/api/health")
def health_check():
    return jsonify({
        "status": "success",
        "message": "Voltway backend is working!"
    })


# --------------------------------------------------
# 7. Location search / geocoding route
# --------------------------------------------------

@app.route("/api/geocode")
def geocode_location():

    global last_geocode_request

    # Get the location entered by the user
    query = request.args.get("query", "").strip()

    # Validate search input
    if len(query) < 2:
        return jsonify({
            "status": "error",
            "message": "Please enter a valid city or locality."
        }), 400

    if len(query) > 200:
        return jsonify({
            "status": "error",
            "message": "Location search is too long."
        }), 400

    # Normalize query for caching
    cache_key = query.casefold()

    # Return cached results if available
    if cache_key in geocode_cache:
        return jsonify({
            "status": "success",
            "count": len(geocode_cache[cache_key]),
            "locations": geocode_cache[cache_key],
            "cached": True,
            "attribution": "© OpenStreetMap contributors"
        })

    url = "https://nominatim.openstreetmap.org/search"

    params = {
        "q": query,
        "format": "jsonv2",
        "addressdetails": 1,
        "limit": 5,
        "countrycodes": "in"
    }

    headers = {
        "User-Agent": "Voltway-MCA-Project/1.0",
        "Accept": "application/json"
    }

    try:

        # Keep requests to at most one per second.
        # The lock also prevents simultaneous requests
        # from different Flask request threads.

        with geocode_lock:

            elapsed = time.monotonic() - last_geocode_request
            wait_time = 1.0 - elapsed

            if wait_time > 0:
                time.sleep(wait_time)

            response = requests.get(
                url,
                params=params,
                headers=headers,
                timeout=15
            )

            last_geocode_request = time.monotonic()

        response.raise_for_status()

        results = response.json()

        if not isinstance(results, list):
            return jsonify({
                "status": "error",
                "message": "Unexpected response from location service."
            }), 502

        # Prepare clean location results for frontend
        locations = []

        for place in results:

            try:
                latitude = float(place["lat"])
                longitude = float(place["lon"])
            except (KeyError, TypeError, ValueError):
                continue

            locations.append({
                "display_name": place.get("display_name", query),
                "latitude": latitude,
                "longitude": longitude,
                "type": place.get("type", ""),
                "address": place.get("address", {})
            })

        # Save successful results in cache
        geocode_cache[cache_key] = locations

        if not locations:
            return jsonify({
                "status": "error",
                "message": "No matching location found. Try a more specific name."
            }), 404

        return jsonify({
            "status": "success",
            "count": len(locations),
            "locations": locations,
            "cached": False,
            "attribution": "© OpenStreetMap contributors"
        })

    except requests.exceptions.Timeout:

        return jsonify({
            "status": "error",
            "message": "Location search timed out. Please try again."
        }), 504

    except requests.exceptions.HTTPError as error:

        print("Nominatim HTTP error:", error)

        return jsonify({
            "status": "error",
            "message": "The location service is temporarily unavailable."
        }), 502

    except (requests.exceptions.RequestException, ValueError) as error:

        print("Geocoding error:", error)

        return jsonify({
            "status": "error",
            "message": "Unable to search for this location right now."
        }), 502


# --------------------------------------------------
# 8. Charger API route
# --------------------------------------------------

@app.route("/api/chargers")
def get_chargers():

    latitude = request.args.get("latitude")
    longitude = request.args.get("longitude")

    # Check whether coordinates were provided
    if not latitude or not longitude:
        return jsonify({
            "status": "error",
            "message": "Latitude and longitude are required."
        }), 400

    # Validate coordinates
    try:
        latitude = float(latitude)
        longitude = float(longitude)

        if not (-90 <= latitude <= 90):
            raise ValueError("Invalid latitude")

        if not (-180 <= longitude <= 180):
            raise ValueError("Invalid longitude")

    except ValueError:
        return jsonify({
            "status": "error",
            "message": "Please provide valid latitude and longitude."
        }), 400

    # Check API key
    if not OPENCHARGEMAP_API_KEY:
        return jsonify({
            "status": "error",
            "message": "Open Charge Map API key is missing."
        }), 500

    # Open Charge Map API URL
    url = "https://api.openchargemap.io/v3/poi/"

    # API request parameters
    params = {
        "output": "json",
        "latitude": latitude,
        "longitude": longitude,
        "distance": 25,
        "distanceunit": "KM",
        "maxresults": 20,
        "compact": "false",
        "verbose": "false",
        "key": OPENCHARGEMAP_API_KEY
    }

    try:

        response = requests.get(
            url,
            params=params,
            headers={
                "User-Agent": "Voltway-MCA-Project/1.0",
                "Accept": "application/json"
            },
            timeout=20
        )

        print("Open Charge Map status:", response.status_code)

        response.raise_for_status()

        charger_data = response.json()

        if not isinstance(charger_data, list):
            return jsonify({
                "status": "error",
                "message": "Unexpected response from Open Charge Map."
            }), 502

        print("Chargers received:", len(charger_data))

        # Send charger data to frontend
        return jsonify({
            "status": "success",
            "count": len(charger_data),
            "chargers": charger_data
        })

    except requests.exceptions.Timeout:

        print("Open Charge Map request timed out.")

        return jsonify({
            "status": "error",
            "message": "The charger service took too long to respond."
        }), 504

    except (requests.exceptions.RequestException, ValueError) as error:

        print("Open Charge Map error:", error)

        return jsonify({
            "status": "error",
            "message": "Unable to retrieve charger data."
        }), 502


# --------------------------------------------------
# 9. FIND CHARGERS ALONG A ROAD ROUTE
# --------------------------------------------------

@app.route("/api/chargers/along-route", methods=["POST"])
def get_chargers_along_route():

    # Check API key
    if not OPENCHARGEMAP_API_KEY:
        return jsonify({
            "status": "error",
            "message": "Open Charge Map API key is missing."
        }), 500

    # Read encoded route from frontend
    data = request.get_json(silent=True) or {}
    encoded_polyline = data.get("polyline", "").strip()

    if not encoded_polyline:
        return jsonify({
            "status": "error",
            "message": "A route polyline is required."
        }), 400

    if len(encoded_polyline) > 100000:
        return jsonify({
            "status": "error",
            "message": "The route is too large to process."
        }), 400

    url = "https://api.openchargemap.io/v3/poi/"

    params = {
        "output": "json",
        "polyline": encoded_polyline,
        "distance": 5,
        "distanceunit": "KM",
        "maxresults": 100,
        "compact": "false",
        "verbose": "false",
        "key": OPENCHARGEMAP_API_KEY
    }

    try:

        response = requests.get(
            url,
            params=params,
            headers={
                "User-Agent": "Voltway-MCA-Project/1.0",
                "Accept": "application/json"
            },
            timeout=60
        )

        print("\n========== ROUTE CHARGER DEBUG ==========")
        print("HTTP Status:", response.status_code)
        print("Request URL length:", len(response.request.url))
        print("=========================================\n")

        response.raise_for_status()

        charger_data = response.json()

        if not isinstance(charger_data, list):
            return jsonify({
                "status": "error",
                "message": "Unexpected response from Open Charge Map."
            }), 502

        print("Route chargers received:", len(charger_data))

        return jsonify({
            "status": "success",
            "count": len(charger_data),
            "chargers": charger_data
        })

    except requests.exceptions.Timeout:

        return jsonify({
            "status": "error",
            "message": "Route charger search timed out."
        }), 504

    except (requests.exceptions.RequestException, ValueError) as error:

        print("Route charger search error:", error)

        return jsonify({
            "status": "error",
            "message": "Unable to retrieve chargers along this route."
        }), 502



# --------------------------------------------------
# 10. NEARBY CAFES
# --------------------------------------------------

@app.route("/api/nearby-places", methods=["POST"])
def get_nearby_places():

    import os
    from math import radians, sin, cos, sqrt, atan2

    data = request.get_json(silent=True) or {}
    locations = data.get("locations", [])

    if not isinstance(locations, list):
        return jsonify({
            "status": "error",
            "message": "Locations must be provided as a list."
        }), 400

    # Search around the first charging station only
    locations = locations[:1]

    valid_locations = []

    for location in locations:
        try:
            latitude = float(location["latitude"])
            longitude = float(location["longitude"])

            if not (-90 <= latitude <= 90):
                continue

            if not (-180 <= longitude <= 180):
                continue

            valid_locations.append({
                "latitude": latitude,
                "longitude": longitude
            })

        except (KeyError, TypeError, ValueError):
            continue

    if not valid_locations:
        return jsonify({
            "status": "success",
            "count": 0,
            "places": []
        })

    # Get Geoapify API key securely from environment
    geoapify_api_key = os.getenv("GEOAPIFY_API_KEY")

    if not geoapify_api_key:
        return jsonify({
            "status": "error",
            "message": "Places API key is not configured."
        }), 503

    # Use the first charging station as search centre
    charger = valid_locations[0]

    latitude = charger["latitude"]
    longitude = charger["longitude"]

    # Geoapify requires longitude first, then latitude
    params = {
        "categories": "catering.cafe",
        "filter": f"circle:{longitude},{latitude},300",
        "bias": f"proximity:{longitude},{latitude}",
        "limit": 20,
        "lang": "en"
    }

    try:
        print("Searching nearby cafes using Geoapify...")

        response = requests.get(
            "https://api.geoapify.com/v2/places",
            params=params,
            headers={
                "x-api-key": geoapify_api_key
            },
            timeout=(10, 30)
        )

        response.raise_for_status()

        result_data = response.json()

        if not isinstance(result_data, dict):
            raise ValueError("Invalid Geoapify response.")

        features = result_data.get("features", [])

        if not isinstance(features, list):
            raise ValueError("Invalid places data.")

        print("Geoapify response received successfully.")

    except requests.exceptions.Timeout as error:

        print("Geoapify request timed out:", error)

        return jsonify({
            "status": "error",
            "message": "Nearby cafe search timed out."
        }), 504

    except requests.exceptions.RequestException as error:

        print("Geoapify API error:", error)

        return jsonify({
            "status": "error",
            "message": "Unable to retrieve nearby cafes."
        }), 502

    except ValueError as error:

        print("Geoapify response error:", error)

        return jsonify({
            "status": "error",
            "message": "Invalid response from places service."
        }), 502

    # Process Geoapify results
    places = []
    seen_ids = set()

    for feature in features:

        properties = feature.get("properties", {})

        # Get unique place ID
        place_id = properties.get("place_id")

        if place_id and place_id in seen_ids:
            continue

        if place_id:
            seen_ids.add(place_id)

        name = properties.get("name")

        if not name:
            continue

        # Get coordinates
        place_lat = properties.get("lat")
        place_lon = properties.get("lon")

        if place_lat is None or place_lon is None:

            coordinates = (
                feature.get("geometry", {})
                .get("coordinates", [])
            )

            if len(coordinates) >= 2:
                place_lon = coordinates[0]
                place_lat = coordinates[1]

        if place_lat is None or place_lon is None:
            continue

        try:
            place_lat = float(place_lat)
            place_lon = float(place_lon)
        except (TypeError, ValueError):
            continue

        # Calculate distance from charging station
        earth_radius = 6371

        delta_lat = radians(place_lat - latitude)
        delta_lon = radians(place_lon - longitude)

        a = (
            sin(delta_lat / 2) ** 2
            + cos(radians(latitude))
            * cos(radians(place_lat))
            * sin(delta_lon / 2) ** 2
        )

        a = min(1, max(0, a))

        c = 2 * atan2(sqrt(a), sqrt(1 - a))

        distance = earth_radius * c

        # Get formatted address
        address = (
            properties.get("formatted")
            or properties.get("address_line1")
            or properties.get("address_line2")
            or "Address unavailable"
        )

        places.append({
            "name": name,
            "category": "Café",
            "address": address,
            "latitude": place_lat,
            "longitude": place_lon,
            "distance_km": round(distance, 2)
        })

    # Sort by nearest distance
    places.sort(
        key=lambda place: place["distance_km"]
    )

    # Return maximum 20 places
    places = places[:20]

    print("Nearby cafes found:", len(places))

    return jsonify({
        "status": "success",
        "count": len(places),
        "places": places,
        "attribution": "© OpenStreetMap contributors"
    })

# --------------------------------------------------
# 9. Start Flask server
# --------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
