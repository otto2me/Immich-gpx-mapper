<script lang="ts">
  import { onMount } from "svelte";

  let { src }: { src: string } = $props();
  let element: HTMLDivElement;
  let error = $state("");

  onMount(() => {
    let disposed = false;
    let map: import("leaflet").Map | undefined;

    async function renderTrack() {
      const [leaflet, response] = await Promise.all([
        import("leaflet"),
        fetch(src)
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
      map.fitBounds(track.getBounds(), { padding: [24, 24] });
    }

    void renderTrack().catch((reason: unknown) => {
      if (!disposed) {
        error = reason instanceof Error ? reason.message : "Karte konnte nicht geladen werden";
      }
    });

    return () => {
      disposed = true;
      map?.remove();
    };
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
</style>
