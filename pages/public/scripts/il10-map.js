/* Loads GeoJSON map data for Il10 */
(function () {
  const MAP_ID = "il10LeafletMap";

  const DISTRICTS_URL = "assets/geo/il-congressional-districts.geojson";
  const CENTROIDS_URL = "assets/geo/il-districts-centroids.geojson";

  const DISTRICT_FIELD = "CD119FP";
  const DEFAULT_DISTRICT = "10"; // initial selection

  function normalizeDistrict(value) {
    if (value === null || value === undefined) return null;
    const s = String(value).trim();
    return s.replace(/^0+/, "") || "0";
  }

  function fetchJson(url, label) {
    return fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${label} failed (${r.status}) at ${url}`);
      return r.json();
    });
  }

  const el = document.getElementById(MAP_ID);
  if (!el) return;

  const map = L.map(MAP_ID, { scrollWheelZoom: false });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 12,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  // Styles
  const baseStyle = {
    color: "#5d5d5d",
    weight: 1,
    opacity: 0.9,
    fillColor: "#c9c9c9",
    fillOpacity: 0.22
  };

  const hoverStyle = { weight: 2, fillOpacity: 0.35 };

  const highlightStyle = {
    color: "#004d21",
    weight: 2,
    opacity: 1,
    fillColor: "#008037",
    fillOpacity: 0.55
  };

  // State
  let districtLayer = null;
  let selectedLayer = null;
  let selectedDistrictId = null;

  // Label marker lookup: districtId -> Leaflet marker
  const labelMarkersByDistrict = Object.create(null);

  function setLabelSelected(districtId, isSelected) {
    const marker = labelMarkersByDistrict[districtId];
    if (!marker) return;

    const el = marker.getElement && marker.getElement();
    if (!el) return;

    if (isSelected) el.classList.add("is-selected");
    else el.classList.remove("is-selected");
  }

  function selectDistrictByLayer(layer) {
    if (!districtLayer || !layer) return;

    const props = layer.feature && layer.feature.properties ? layer.feature.properties : {};
    const districtId = normalizeDistrict(props[DISTRICT_FIELD]);

    // Reset previous selection (polygon + label)
    if (selectedLayer) {
      districtLayer.resetStyle(selectedLayer);
    }
    if (selectedDistrictId !== null) {
      setLabelSelected(selectedDistrictId, false);
    }

    // Apply new selection (polygon + label)
    selectedLayer = layer;
    selectedDistrictId = districtId;

    selectedLayer.setStyle(highlightStyle);
    selectedLayer.bringToFront();
    setLabelSelected(selectedDistrictId, true);
  }

  // 1) Load polygons
  fetchJson(DISTRICTS_URL, "District polygons")
    .then((data) => {
      districtLayer = L.geoJSON(data, {
        style: baseStyle,
        onEachFeature: (feature, layer) => {
          layer.on("mouseover", () => {
            if (layer !== selectedLayer) layer.setStyle(hoverStyle);
          });

          layer.on("mouseout", () => {
            if (districtLayer && layer !== selectedLayer) districtLayer.resetStyle(layer);
          });

          layer.on("click", () => selectDistrictByLayer(layer));
        }
      }).addTo(map);

      // Fit map to IL-10 if possible, else fit to all
      let defaultBounds = null;
      districtLayer.eachLayer((layer) => {
        const props = layer.feature && layer.feature.properties ? layer.feature.properties : {};
        const d = normalizeDistrict(props[DISTRICT_FIELD]);
        if (d === DEFAULT_DISTRICT) defaultBounds = layer.getBounds();
      });

      if (defaultBounds) {
        map.fitBounds(defaultBounds, { padding: [40, 40] });
      } else {
        map.fitBounds(districtLayer.getBounds(), { padding: [18, 18] });
      }

      // Load labels next
      return fetchJson(CENTROIDS_URL, "District label points");
    })
    .then((centroidGeo) => {
      // Add label markers
      const labelLayer = L.geoJSON(centroidGeo, {
        pointToLayer: (feature, latlng) => {
          const props = feature && feature.properties ? feature.properties : {};
          const d = normalizeDistrict(props[DISTRICT_FIELD]);

          const marker = L.marker(latlng, {
            interactive: false,
            icon: L.divIcon({
              className: "district-label",
              html: "IL-" + d,
              iconSize: null
            })
          });

          // Save reference so we can toggle classes later
          labelMarkersByDistrict[d] = marker;

          return marker;
        }
      }).addTo(map);

      // After labels are on the DOM, select the default district
      // Find the polygon layer for DEFAULT_DISTRICT and select it
      districtLayer.eachLayer((layer) => {
        const props = layer.feature && layer.feature.properties ? layer.feature.properties : {};
        const d = normalizeDistrict(props[DISTRICT_FIELD]);
        if (d === DEFAULT_DISTRICT) {
          selectDistrictByLayer(layer);
        }
      });
    })
    .catch((err) => {
      console.error(err);
      el.innerHTML =
        '<div style="padding:1rem;color:#6E6E6E;text-align:center;">' +
        "Map failed to load.<br>" +
        "<small>" + (err.message || err) + "</small>" +
        "</div>";
    });
})();