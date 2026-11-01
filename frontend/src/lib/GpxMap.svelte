<script lang="ts">
  import type { MapMarker } from "./api.js";

  let {
    src,
    albumId,
    markers = [],
    immichWebUrl,
    focusAssetId,
    focusRequestId
  }: {
    src: string;
    albumId: string;
    markers?: MapMarker[];
    immichWebUrl: string | null;
    focusAssetId: string | null;
    focusRequestId: number;
  } = $props();
  let element: HTMLDivElement;
  let error = $state("");
  let activeMap = $state.raw<import("leaflet").Map | null>(null);
  let photoMarkerLayers = $state.raw<Map<string, import("leaflet").CircleMarker>>(new Map());

  $effect(() => {
    const currentSrc = src;
    const currentMarkers = markers;
    const currentAlbumId = albumId;
    const currentImmichWebUrl = immichWebUrl;
    let disposed = false;
    let map: import("leaflet").Map | undefined;
    error = "";

    async function renderTrack() {
      const [leaflet, response] = await Promise.all([
        import("leaflet"),
        fetch(currentSrc)
      ]);
      if (!response.ok) throw new Error("GPX-Track konnte nicht geladen werden");
      const xmlText = await response.text();
      const xml = new DOMParser().parseFromString(xmlText, "application/xml");
      if (xml.querySelector("parsererror")) throw new Error("GPX-Datei ist fehlerhaft");

      const points = Array.from(xml.querySelectorAll("trkpt, rtept"))
        .map((point) => {
          const lat = Number(point.getAttribute("lat"));
          const lon = Number(point.getAttribute("lon"));
          return Number.isFinite(lat) && Number.isFinite(lon)
            ? leaflet.latLng(lat, lon)
            : null;
        })
        .filter((point): point is import("leaflet").LatLng => point !== null);
      if (!points.length) throw new Error("Der GPX-Track enthält keine Wegpunkte");
      if (disposed) return;

      const photoMarkers = currentMarkers.filter((marker) =>
        Number.isFinite(marker.lat) && Number.isFinite(marker.lon) &&
        marker.lat >= -90 && marker.lat <= 90 && marker.lon >= -180 && marker.lon <= 180
      );

      map = leaflet.map(element, { scrollWheelZoom: false });
      leaflet.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      }).addTo(map);
      const track = leaflet.polyline(points, {
        color: "#378a5d",
        weight: 5,
        opacity: 0.9
      }).addTo(map);

      const markerLayers = new Map<string, import("leaflet").CircleMarker>();
      for (const photo of photoMarkers) {
        const popup = document.createElement("div");
        popup.className = "photo-popup";
        const image = document.createElement("img");
        image.src = `/api/assets/${encodeURIComponent(photo.id)}/thumbnail`;
        image.alt = "Immich-Foto an diesem Standort";
        image.loading = "lazy";
        if (currentImmichWebUrl) {
          const link = document.createElement("a");
          link.href = `${currentImmichWebUrl}/albums/${encodeURIComponent(currentAlbumId)}/photos/${encodeURIComponent(photo.id)}`;
          link.target = "_blank";
          link.rel = "noreferrer";
          link.title = "Foto in Immich öffnen";
          link.append(image);
          popup.append(link);
        } else {
          popup.append(image);
        }

        const location = [photo.city, photo.state, photo.country]
          .filter((part): part is string => Boolean(part))
          .join(", ");
        if (location) {
          const caption = document.createElement("p");
          caption.textContent = location;
          popup.append(caption);
        }

        const markerLayer = leaflet.circleMarker([photo.lat, photo.lon], {
          radius: 7,
          color: "#fff",
          weight: 2,
          fillColor: "#d16d3b",
          fillOpacity: 1
        }).addTo(map).bindPopup(popup, {
          maxWidth: 240,
          maxHeight: 220,
          autoPan: true,
          autoPanPadding: [32, 40],
          keepInView: true
        });
        markerLayers.set(photo.id, markerLayer);
      }

      activeMap = map;
      photoMarkerLayers = markerLayers;

      map.fitBounds(leaflet.latLngBounds([
        ...points,
        ...photoMarkers.map((photo) => leaflet.latLng(photo.lat, photo.lon))
      ]), { padding: [24, 24] });
    }

    void renderTrack().catch((reason: unknown) => {
      if (!disposed) {
        error = reason instanceof Error ? reason.message : "Karte konnte nicht geladen werden";
      }
    });

    return () => {
      disposed = true;
      if (activeMap === map) {
        activeMap = null;
        photoMarkerLayers = new Map();
      }
      map?.remove();
    };
  });

  $effect(() => {
    const requestedAssetId = focusAssetId;
    const requestId = focusRequestId;
    const map = activeMap;
    const marker = requestedAssetId ? photoMarkerLayers.get(requestedAssetId) : undefined;
    if (!requestId || !map || !marker) return;

    map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 15), { duration: 0.45 });
    marker.openPopup();
  });
</script>

<div class="map" bind:this={element} aria-label="Karte des GPX-Tracks"></div>
{#if error}<p class="map-error">{error}</p>{/if}

<style>
  .map {
    min-height: 340px;
    border-radius: 1rem;
    background: #e8eee8;
    z-index: 0;
  }

  .map-error {
    color: #a53d32;
  }

  :global(.photo-popup img) {
    display: block;
    width: 220px;
    height: 160px;
    max-width: 220px;
    object-fit: cover;
  }

  :global(.photo-popup p) {
    margin: .4rem 0 0;
  }
</style>
