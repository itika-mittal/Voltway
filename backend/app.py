
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
# 10. NEARBY FOOD AND SHOPPING PLACES
# --------------------------------------------------

@app.route("/api/nearby-places", methods=["POST"])
def get_nearby_places():

    data = request.get_json(silent=True) or {}

    locations = data.get("locations", [])

    if not isinstance(locations, list):
        return jsonify({
            "status": "error",
            "message": "Locations must be provided as a list."
        }), 400

    # Limit request size
    locations = locations[:5]

    if not locations:
        return jsonify({
            "status": "success",
            "count": 0,
            "places": []
        })

    # Validate every coordinate
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

    # Build one Overpass query for all selected charging stations.
    # Search within 1.5 km of each selected charger.
    query_parts = []

    for location in valid_locations:

        latitude = location["latitude"]
        longitude = location["longitude"]

        around = f"around:1500,{latitude},{longitude}"

        query_parts.append(
            f'node({around})["amenity"~"restaurant|cafe|fast_food"];'
        )

        query_parts.append(
            f'way({around})["amenity"~"restaurant|cafe|fast_food"];'
        )

        query_parts.append(
            f'node({around})["shop"~"supermarket|mall|convenience"];'
        )

        query_parts.append(
            f'way({around})["shop"~"supermarket|mall|convenience"];'
        )

    overpass_query = (
        "[out:json][timeout:40];"
        "(" + "".join(query_parts) + ");"
        "out center tags;"
    )

    url = "https://overpass-api.de/api/interpreter"

    try:

        response = requests.post(
            url,
            data={"data": overpass_query},
            headers={
                "User-Agent": "Voltway-MCA-Project/1.0",
                "Accept": "application/json"
            },
            timeout=50
        )

        response.raise_for_status()

        result_data = response.json()

        elements = result_data.get("elements", [])

        places = []
        seen_ids = set()

        for element in elements:

            element_id = element.get("id")

            if element_id in seen_ids:
                continue

            seen_ids.add(element_id)

            tags = element.get("tags", {})

            name = tags.get("name")

            # Skip places that do not have a readable name
            if not name:
                continue

            # Nodes contain direct coordinates.
            # Ways generally contain a center coordinate.
            latitude = element.get("lat")
            longitude = element.get("lon")

            if latitude is None or longitude is None:

                center = element.get("center", {})

                latitude = center.get("lat")
                longitude = center.get("lon")

            if latitude is None or longitude is None:
                continue

            latitude = float(latitude)
            longitude = float(longitude)

            amenity = tags.get("amenity", "")
            shop = tags.get("shop", "")

            if amenity == "restaurant":
                category = "Restaurant"

            elif amenity == "cafe":
                category = "Café"

            elif amenity == "fast_food":
                category = "Fast Food"

            elif shop == "supermarket":
                category = "Supermarket"

            elif shop == "mall":
                category = "Shopping Mall"

            elif shop == "convenience":
                category = "Convenience Store"

            else:
                category = "Nearby Place"

            address_parts = [
                tags.get("addr:street"),
                tags.get("addr:city"),
                tags.get("addr:postcode")
            ]

            address = ", ".join(
                part for part in address_parts if part
            )

            # Calculate distance from the nearest selected charger
            nearest_distance = None

            for location in valid_locations:

                charger_lat = location["latitude"]
                charger_lon = location["longitude"]

                from math import radians, sin, cos, sqrt, atan2

                earth_radius = 6371

                delta_lat = radians(latitude - charger_lat)
                delta_lon = radians(longitude - charger_lon)

                a = (
                    sin(delta_lat / 2) ** 2
                    + cos(radians(charger_lat))
                    * cos(radians(latitude))
                    * sin(delta_lon / 2) ** 2
                )

                c = 2 * atan2(sqrt(a), sqrt(1 - a))

                distance = earth_radius * c

                if (
                    nearest_distance is None
                    or distance < nearest_distance
                ):
                    nearest_distance = distance

            places.append({
                "name": name,
                "category": category,
                "address": address or "Address unavailable",
                "latitude": latitude,
                "longitude": longitude,
                "distance_km": round(nearest_distance, 2)
                    if nearest_distance is not None
                    else None
            })

        # Sort nearest places first
        places.sort(
            key=lambda place: (
                place["distance_km"]
                if place["distance_km"] is not None
                else float("inf")
            )
        )

        # Limit response size
        places = places[:40]

        return jsonify({
            "status": "success",
            "count": len(places),
            "places": places,
            "attribution": "© OpenStreetMap contributors"
        })

    except requests.exceptions.Timeout:

        return jsonify({
            "status": "error",
            "message": "Nearby place search timed out."
        }), 504

    except (
        requests.exceptions.RequestException,
        ValueError
    ) as error:

        print("Nearby places API error:", error)

        return jsonify({
            "status": "error",
            "message": "Unable to retrieve nearby places."
        }), 502


# --------------------------------------------------
# 9. Start Flask server
# --------------------------------------------------

if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
