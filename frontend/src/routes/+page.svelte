<script lang="ts">
  import { onMount } from "svelte";
  import { pushState } from "$app/navigation";
  import "leaflet/dist/leaflet.css";
  import GpxMap from "../lib/GpxMap.svelte";
  import ReportEditor from "../lib/ReportEditor.svelte";
  import SharedReport from "../lib/SharedReport.svelte";
  import SettingsPage from "../lib/SettingsPage.svelte";
  import { Settings, Trash2 } from "@lucide/svelte";
  import {
    api,
    emptyTour,
    initialAlbumTour,
    komootEmbedUrl,
    tourResource,
    type Album,
    type Asset,
    type Comment,
    type MapMarker,
    type KomootPreview,
    type Tour
  } from "../lib/api.js";

  const appVersion = __APP_VERSION__;
  const albumsPerPage = 12;
  let albums = $state<Album[]>([]);
  let komootLinkedAlbumIds = $state<string[]>([]);
  let albumsPage = $state(1);
  let selectedAlbum = $state<Album | null>(null);
  let albumDataVersion = $state(0);
  let shareToken = $state("");
  let settingsView = $state(false);
  let settingsBusy = $state(false);
  let sharingEnabled = $state(true);
  let defaultKomootMode = $state<"embed" | "local">("embed");
  let albumView = $state<"tours" | "report">("report");
  let reportDirty = $state(false);
  let reportSaving = $state(false);
  let tours = $state<Tour[]>([]);
  let selectedTourId = $state<string | null>(null);
  let selectingTour = $state(false);
  let addingTour = $state(false);
  let newTourDate = $state("");
  let newTourTitle = $state("");
  let newTourTimeZone = $state(Intl.DateTimeFormat().resolvedOptions().timeZone);
  let selectionRevision = 0;
  let albumRevision = 0;
  let tour = $state<Tour>(emptyTour());
  let comments = $state<Comment[]>([]);
  let immichWebUrl = $state<string | null>(null);
  let albumAssets = $state<Asset[]>([]);
  let albumAssetsPage = $state(0);
  let albumAssetsPageSize = $state(48);
  let albumAssetsTotal = $state(0);
  let albumAssetsHasMore = $state(false);
  let albumAssetsLoading = $state(false);
  let albumAssetsError = $state("");
  let photoMarkers = $state<MapMarker[]>([]);
  let photoMapError = $state("");
  let mapFocusAssetId = $state<string | null>(null);
  let mapFocusRequestId = $state(0);
  let authenticated = $state(false);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let search = $state("");
  let onlyKomootLinked = $state(false);
  let password = $state("");
  let author = $state("");
  let commentText = $state("");
  let imageVersion = $state(0);
  let komootDisplayMode = $state<"embed" | "local">("embed");
  let komootPreview = $state<KomootPreview | null>(null);
  let loadingKomoot = $state(false);
  let komootPreviewApplied = $state(false);
  const previewEmbedUrl = $derived(
    komootPreview ? komootEmbedUrl(tour.komootLink) : null
  );
  const tourEmbedUrl = $derived(komootEmbedUrl(tour.komootLink));
  const showKomootEmbed = $derived(komootDisplayMode === "embed" || (!tour.hasKomootMap && !tour.hasElevationProfile));
  const albumAssetsTotalPages = $derived(
    Math.max(1, Math.ceil(albumAssetsTotal / albumAssetsPageSize))
  );

  const filteredAlbums = $derived(
    albums.filter((album) =>
      (!onlyKomootLinked || komootLinkedAlbumIds.includes(album.id)) &&
      album.albumName.toLocaleLowerCase().includes(search.toLocaleLowerCase())
    )
  );
  const albumPagesTotal = $derived(
    Math.max(1, Math.ceil(filteredAlbums.length / albumsPerPage))
  );
  const pagedAlbums = $derived(
    filteredAlbums.slice((albumsPage - 1) * albumsPerPage, albumsPage * albumsPerPage)
  );

  function message(reason: unknown) {
    return reason instanceof Error ? reason.message : "Ein unbekannter Fehler ist aufgetreten";
  }

  async function loadAlbums() {
    error = "";
    loading = true;
    albumsPage = 1;
    try {
      const [loadedAlbums, linkedAlbumIds] = await Promise.all([
        api.albums(),
        api.komootLinkedAlbums().catch(() => [])
      ]);
      albums = loadedAlbums;
      komootLinkedAlbumIds = linkedAlbumIds;
    } catch (reason) {
      error = message(reason);
    } finally {
      loading = false;
    }
  }

  async function loadAlbum(id: string) {
    const revision = ++albumRevision;
    ++selectionRevision;
    error = "";
    notice = "";
    komootPreview = null;
    komootPreviewApplied = false;
    komootDisplayMode = defaultKomootMode;
    albumAssets = [];
    albumAssetsPage = 0;
    albumAssetsPageSize = 48;
    albumAssetsTotal = 0;
    albumAssetsHasMore = false;
    albumAssetsLoading = false;
    albumAssetsError = "";
    photoMarkers = [];
    photoMapError = "";
    loading = true;
    try {
      const [album, savedTours] = await Promise.all([
        api.album(id),
        api.tours(id)
      ]);
      if (revision !== albumRevision) return;
      selectedAlbum = album;
      tours = savedTours;
      addingTour = false;
      const params = new URLSearchParams(location.search);
      albumView = params.has("tour") || ["overview", "tours"].includes(params.get("view") ?? "") ? "tours" : "report";
      const requestedTour = params.get("tour");
      const initialTour = initialAlbumTour(savedTours, requestedTour, params.get("view") === "overview");
      await selectTour(initialTour?.id ?? null, false);
    } catch (reason) {
      error = message(reason);
      selectedAlbum = null;
    } finally {
      loading = false;
    }
  }

  async function selectTour(id: string | null, updateLocation = true) {
    const albumId = selectedAlbum?.id;
    if (!albumId) return;
    const revision = ++selectionRevision;
    selectedTourId = id;
    tour = { ...emptyTour(), ...tours.find((item) => item.id === id) };
    comments = [];
    commentText = "";
    photoMarkers = [];
    photoMapError = "";
    mapFocusAssetId = null;
    albumAssets = [];
    albumAssetsPage = 0;
    albumAssetsTotal = 0;
    albumAssetsHasMore = false;
    albumAssetsLoading = false;
    albumAssetsError = "";
    komootPreview = null;
    komootDisplayMode = defaultKomootMode;
    selectingTour = true;
    error = "";
    if (updateLocation) {
      const params = new URLSearchParams({ album: albumId });
      if (id) params.set("tour", id);
      else params.set("view", "overview");
      pushState(`/?${params}`, {});
    }
    try {
      const [saved, savedComments, markers] = await Promise.all([
        id ? api.tour(albumId, id) : Promise.resolve(null),
        id ? api.comments(albumId, id) : Promise.resolve([]),
        id ? api.albumMapMarkers(albumId, id).catch(() => {
          if (revision === selectionRevision) photoMapError = "Foto-Standorte konnten von Immich nicht geladen werden.";
          return [];
        }) : Promise.resolve([])
      ]);
      if (revision !== selectionRevision) return;
      tour = { ...emptyTour(), ...saved };
      comments = savedComments;
      photoMarkers = markers;
      imageVersion += 1;
      await loadAlbumAssets(1);
    } catch (reason) {
      if (revision === selectionRevision) error = message(reason);
    } finally {
      if (revision === selectionRevision) selectingTour = false;
    }
  }

  function tourDateLabel(value: string | null) {
    return value ? new Date(`${value}T12:00:00Z`).toLocaleDateString("de-DE", { timeZone: "UTC" }) : "Ohne Datum";
  }

  function onTourTabKeydown(event: KeyboardEvent) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from((event.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)'));
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    if (index < 0 || !tabs.length) return;
    event.preventDefault();
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 :
      (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus();
    tabs[next].click();
  }

  async function createTour(event: SubmitEvent) {
    event.preventDefault();
    if (!selectedAlbum || !newTourDate) return;
    busy = true;
    error = "";
    try {
      const created = await api.createTour(selectedAlbum.id, newTourTitle, newTourDate, newTourTimeZone);
      tours = await api.tours(selectedAlbum.id);
      addingTour = false;
      newTourTitle = "";
      newTourDate = "";
      await selectTour(created.id ?? null);
      notice = "Tour angelegt.";
    } catch (reason) {
      error = message(reason);
    } finally {
      busy = false;
    }
  }

  async function loadAlbumAssets(page: number) {
    const albumId = selectedAlbum?.id;
    const revision = selectionRevision;
    const tourId = selectedTourId;
    if (
      !albumId || albumAssetsLoading || page < 1 ||
      (albumAssetsTotal > 0 && page > albumAssetsTotalPages)
    ) return;

    albumAssetsLoading = true;
    albumAssetsError = "";
    try {
      const result = await api.albumAssets(albumId, page, tourId);
      if (selectedAlbum?.id !== albumId || revision !== selectionRevision) return;
      albumAssets = result.items;
      albumAssetsPage = result.page;
      albumAssetsPageSize = result.pageSize;
      albumAssetsTotal = tour.date ? result.total : selectedAlbum.assetCount ?? result.total;
      albumAssetsHasMore = result.hasMore;
    } catch (reason) {
      if (revision === selectionRevision) albumAssetsError = message(reason);
    } finally {
      if (selectedAlbum?.id === albumId && revision === selectionRevision) albumAssetsLoading = false;
    }
  }

  function onAlbumGalleryToggle(event: Event) {
    const details = event.currentTarget as HTMLDetailsElement;
    if (details.open && albumAssetsPage === 0) void loadAlbumAssets(1);
  }

  function immichAssetUrl(albumId: string, assetId: string) {
    if (!immichWebUrl) return null;
    return `${immichWebUrl}/albums/${encodeURIComponent(albumId)}/photos/${encodeURIComponent(assetId)}`;
  }

  function hasPhotoMarker(assetId: string) {
    return photoMarkers.some((marker) => marker.id === assetId);
  }

  function showPhotoOnMap(assetId: string) {
    if (!tour.hasGpx || !hasPhotoMarker(assetId)) return;
    mapFocusAssetId = assetId;
    mapFocusRequestId += 1;
    document.querySelector(".map-panel .map")?.scrollIntoView({ behavior: "auto", block: "center" });
  }

  async function initialize() {
    shareToken = new URLSearchParams(location.hash.slice(1)).get("share") ?? "";
    if (shareToken) { loading = false; return; }
    settingsView = new URLSearchParams(location.search).get("view") === "settings";
    try {
      const config = await api.publicConfig();
      immichWebUrl = config.immichWebUrl;
      sharingEnabled = config.sharingEnabled ?? true;
      defaultKomootMode = config.komootDefault ?? "embed";
    } catch {
      immichWebUrl = null;
    }
    try {
      authenticated = (await api.session()).authenticated;
    } catch (reason) {
      error = message(reason);
    }
    if (settingsView) { loading = false; return; }
    const albumId = new URLSearchParams(location.search).get("album");
    if (albumId) {
      await loadAlbum(albumId);
    } else {
      await loadAlbums();
    }
  }

  function syncFromLocation() {
    settingsView = new URLSearchParams(location.search).get("view") === "settings";
    if (settingsView) return;
    const previousShare = shareToken;
    shareToken = new URLSearchParams(location.hash.slice(1)).get("share") ?? "";
    if (shareToken) { selectedAlbum = null; return; }
    if (previousShare) { void initialize(); return; }
    const albumId = new URLSearchParams(location.search).get("album");
    if (albumId) void loadAlbum(albumId);
    else {
      selectedAlbum = null;
      void loadAlbums();
    }
  }

  onMount(() => {
    void initialize();
    window.addEventListener("popstate", syncFromLocation);
    window.addEventListener("hashchange", syncFromLocation);
    return () => {
      window.removeEventListener("popstate", syncFromLocation);
      window.removeEventListener("hashchange", syncFromLocation);
    };
  });

  async function openAlbum(album: Album) {
    pushState(`/?album=${encodeURIComponent(album.id)}`, {});
    await loadAlbum(album.id);
  }

  function backToAlbums() {
    if (settingsBusy) return;
    settingsView = false;
    if (reportSaving) return;
    if (reportDirty && !confirm("Ungespeicherte Änderungen am Reisebericht verwerfen?")) return;
    reportDirty = false;
    const leavingShare = Boolean(shareToken);
    shareToken = "";
    ++albumRevision;
    ++selectionRevision;
    pushState("/", {});
    selectedAlbum = null;
    if (leavingShare) void initialize();
    else void loadAlbums();
  }

  async function login(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = "";
    try {
      await api.login(password);
      authenticated = true;
      password = "";
      notice = "Du bist angemeldet und kannst Tourdaten bearbeiten.";
    } catch (reason) {
      error = message(reason);
    } finally {
      busy = false;
    }
  }

  async function logout() {
    if (settingsBusy) return;
    if (reportSaving) return;
    if (reportDirty && !confirm("Ungespeicherte Änderungen am Reisebericht verwerfen und abmelden?")) return;
    try {
      await api.logout();
      authenticated = false;
      reportDirty = false;
      notice = "Du wurdest abgemeldet.";
    } catch (reason) {
      error = message(reason);
    }
  }

  async function saveTour(event: SubmitEvent) {
    event.preventDefault();
    if (!selectedAlbum) return;
    busy = true;
    error = "";
    try {
      const saved = await api.saveTour(selectedAlbum.id, tour, selectedTourId);
      tour = { ...emptyTour(), ...saved };
      tours = await api.tours(selectedAlbum.id);
      await selectTour(saved.id ?? null, false);
      notice = "Tourdaten gespeichert.";
    } catch (reason) {
      error = message(reason);
    } finally {
      busy = false;
    }
  }

  async function loadKomootPreview() {
    if (!tour.komootLink.trim()) return;
    loadingKomoot = true;
    error = "";
    notice = "";
    komootPreview = null;
    komootPreviewApplied = false;
    try {
      komootPreview = await api.komootPreview(tour.komootLink);
    } catch (reason) {
      error = message(reason);
    } finally {
      loadingKomoot = false;
    }
  }

  async function saveKomootScreenshots() {
    if (!selectedAlbum || !tour.komootLink.trim()) return;
    busy = true;
    error = "";
    notice = "";
    try {
      const saved = await api.saveTour(selectedAlbum.id, tour, selectedTourId);
      const captured = await api.captureKomootScreenshots(
        selectedAlbum.id,
        saved.komootLink,
        selectedTourId
      );
      tour = { ...emptyTour(), ...captured };
      tours = await api.tours(selectedAlbum.id);
      imageVersion += 1;
      komootDisplayMode = "local";
      komootPreview = null;
      komootPreviewApplied = false;
      notice = "Komoot-Karte und Höhenprofil wurden als PNG im Datenverzeichnis gespeichert.";
    } catch (reason) {
      error = message(reason);
    } finally {
      busy = false;
    }
  }

  function clearKomootPreview() {
    komootPreview = null;
    komootPreviewApplied = false;
    komootDisplayMode = defaultKomootMode;
  }

  function applyKomootPreview() {
    if (!komootPreview) return;
    tour = {
      ...tour,
      ...(komootPreview.activityType ? { activityType: komootPreview.activityType } : {}),
      ...(komootPreview.distanceKm !== null ? { distanceKm: komootPreview.distanceKm } : {}),
      ...(komootPreview.elevationGainM !== null
        ? { elevationGainM: komootPreview.elevationGainM }
        : {})
    };
    notice = "Öffentlich sichtbare Komoot-Daten ins Formular übernommen. Prüfe sie und speichere anschließend.";
    komootPreviewApplied = true;
  }

  async function uploadFile(kind: "gpx" | "komoot-map" | "elevation", file?: File) {
    if (!selectedAlbum || !file) return;
    busy = true;
    error = "";
    try {
      await api.upload(selectedAlbum.id, kind, file, selectedTourId);
      const refreshed = await api.tour(selectedAlbum.id, selectedTourId);
      tour = { ...emptyTour(), ...refreshed };
      tours = await api.tours(selectedAlbum.id);
      imageVersion += 1;
      notice = kind === "gpx" ? "GPX-Track hochgeladen." : "Bild hochgeladen.";
    } catch (reason) {
      error = message(reason);
    } finally {
      busy = false;
    }
  }

  async function addComment(event: SubmitEvent) {
    event.preventDefault();
    if (!selectedAlbum || !commentText.trim()) return;
    busy = true;
    error = "";
    try {
      const comment = await api.addComment(selectedAlbum.id, author, commentText, selectedTourId);
      comments = [...comments, comment];
      commentText = "";
    } catch (reason) {
      error = message(reason);
    } finally {
      busy = false;
    }
  }

  function thumbnail(assetId: string) {
    return `/api/assets/${encodeURIComponent(assetId)}/thumbnail`;
  }

  function assetTitle(asset: Asset) {
    return asset.originalFileName ?? "Immich-Foto";
  }

  function switchAlbumView(view: "tours" | "report") {
    if (reportSaving) return;
    if (view === albumView) return;
    if (reportDirty && !confirm("Ungespeicherte Änderungen am Reisebericht verwerfen?")) return;
    reportDirty = false;
    albumView = view;
    const params = new URLSearchParams({ album: selectedAlbum!.id });
    if (view === "report") params.set("view", "report");
    else if (selectedTourId) params.set("tour", selectedTourId);
    else params.set("view", "overview");
    pushState(`/?${params}`, {});
  }

  async function openReportTour(id: string) {
    if (reportSaving) return;
    if (reportDirty && !confirm("Ungespeicherte Änderungen am Reisebericht verwerfen?")) return;
    reportDirty = false;
    albumView = "tours";
    await selectTour(id);
  }

  function openSettings() {
    if (reportSaving || settingsBusy) return;
    if (reportDirty && !confirm("Ungespeicherte Änderungen am Reisebericht verwerfen?")) return;
    reportDirty = false;
    settingsView = true;
    pushState("/?view=settings", {});
  }

  function settingsSaved(settings: import("../lib/api.js").AppSettings) {
    sharingEnabled = settings.sharingEnabled;
    defaultKomootMode = settings.komootDefault;
    komootDisplayMode = settings.komootDefault;
  }

  function backupRestored(result: import("../lib/api.js").RestoreResult) {
    authenticated = false;
    reportDirty = false;
    settingsBusy = false;
    notice = `Sicherung wiederhergestellt. Bitte den Container neu starten und erneut anmelden. Sicherheitskopie: ${result.safetyBackup}${result.warning ? ` · ${result.warning}` : ""}`;
  }

  async function deleteAlbumData() {
    if (!selectedAlbum || !authenticated || busy || reportSaving || settingsBusy) return;
    const albumId = selectedAlbum.id;
    if (!confirm(`Alle Mapper-Einträge zu „${selectedAlbum.albumName}“ löschen?\n\nTouren, Kommentare, Reisebericht, Freigabelinks und lokale Uploads werden entfernt. Das Immich-Album, seine Fotos und vorhandene ZIP-Sicherungen bleiben erhalten.${reportDirty ? "\n\nUngespeicherte Berichtsänderungen werden verworfen." : ""}`)) return;
    busy = true;
    error = "";
    notice = "";
    try {
      const result = await api.deleteAlbumData(albumId);
      reportDirty = false;
      albumDataVersion += 1;
      pushState(`/?${new URLSearchParams({ album: albumId })}`, {});
      await loadAlbum(albumId);
      notice = result.warning ?? "Mapper-Einträge gelöscht. Das Immich-Album und seine Fotos bleiben erhalten.";
    } catch (reason) {
      error = message(reason);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head>
  <title>Immich GPX Mapper</title>
  {#if shareToken}
    <meta name="robots" content="noindex, nofollow" />
    <meta name="referrer" content="no-referrer" />
  {/if}
  <meta
    name="description"
    content="Tour-Informationen und GPX-Tracks zu Immich-Alben"
  />
</svelte:head>

<header class="topbar">
  <a class="brand" href="/" onclick={(event) => { event.preventDefault(); backToAlbums(); }}>
    <span class="brand-mark">↗</span>
    <span>Immich <strong>GPX Mapper</strong></span>
  </a>
  {#if !shareToken}<div class="auth">
    {#if authenticated}
      <button class="quiet-button settings-button" type="button" title="Einstellungen" aria-label="Einstellungen" disabled={reportSaving || settingsBusy} onclick={openSettings}><Settings size={19} /></button>
      <span class="auth-state"><span class="dot"></span> Bearbeitungsmodus</span>
      <button class="quiet-button" disabled={reportSaving || settingsBusy} onclick={logout}>Abmelden</button>
    {:else}
      <form class="login-form" onsubmit={login}>
        <label class="sr-only" for="app-password">App-Passwort</label>
        <input
          id="app-password"
          type="password"
          placeholder="App-Passwort"
          autocomplete="current-password"
          bind:value={password}
        />
        <button class="small-button" type="submit" disabled={busy || !password}>
          Anmelden
        </button>
      </form>
    {/if}
  </div>{/if}
</header>

<main>
  {#if error}
    <div class="alert error-alert" role="alert">
      <span>{error}</span>
      <button aria-label="Meldung schließen" onclick={() => (error = "")}>×</button>
    </div>
  {/if}
  {#if notice}
    <div class="alert notice-alert" role="status">
      <span>{notice}</span>
      <button aria-label="Meldung schließen" onclick={() => (notice = "")}>×</button>
    </div>
  {/if}

  {#if shareToken}
    {#key shareToken}<SharedReport token={shareToken} />{/key}
  {:else if settingsView}
    {#if authenticated}<SettingsPage onSaved={settingsSaved} onRestored={backupRestored} bind:busy={settingsBusy} />{:else}<h1>Einstellungen</h1><p>Für Einstellungen und Sicherungen bitte anmelden.</p>{/if}
  {:else if selectedAlbum}
    <section class="album-heading">
      <div>
        <p class="eyebrow">Immich-Album</p>
        <div class="album-title-row">
          <h1>{selectedAlbum.albumName}</h1>
          {#if authenticated}
            <button class="delete-album-data" type="button" title="Mapper-Einträge dieses Albums löschen" aria-label="Mapper-Einträge löschen" disabled={busy || reportSaving || settingsBusy || selectingTour} onclick={deleteAlbumData}><Trash2 size={16} /></button>
          {/if}
        </div>
        <p class="muted">
          {selectedAlbum.assetCount ?? selectedAlbum.assets?.length ?? 0} Fotos und Videos
          {#if selectedAlbum.description} · {selectedAlbum.description}{/if}
        </p>
      </div>
      <div class="album-actions">
      {#if albumView === "tours" && tour.komootLink}
        <a class="komoot-button" href={tour.komootLink} target="_blank" rel="noreferrer">
          Tour in Komoot öffnen ↗
        </a>
      {/if}
      </div>
    </section>

    <div class="komoot-view-toggle album-view-toggle" role="group" aria-label="Albumansicht">
      <button type="button" aria-pressed={albumView === "report"} class:active={albumView === "report"} disabled={busy || reportSaving} onclick={() => switchAlbumView("report")}>Reisebericht</button>
      <button type="button" aria-pressed={albumView === "tours"} class:active={albumView === "tours"} disabled={busy || reportSaving} onclick={() => switchAlbumView("tours")}>Touren</button>
    </div>

    {#if albumView === "report"}
      {#key `${selectedAlbum.id}:${authenticated}:${albumDataVersion}`}<ReportEditor album={selectedAlbum} {tours} canEdit={authenticated} {sharingEnabled} onOpenTour={openReportTour} bind:dirty={reportDirty} bind:saving={reportSaving} />{/key}
    {:else}
    <nav class="tour-navigation" aria-label="Touren im Album">
      <div class="tour-tabs" role="tablist" tabindex="-1" aria-label="Tagesauswahl" onkeydown={onTourTabKeydown}>
        {#if tours.length !== 1}<button type="button" role="tab" aria-selected={!selectedTourId} aria-controls="tour-content" tabindex={!selectedTourId ? 0 : -1} disabled={busy} onclick={() => selectTour(null)}>Übersicht</button>{/if}
        {#each tours as item (item.id)}
          <button type="button" role="tab" aria-selected={selectedTourId === item.id} aria-controls="tour-content" tabindex={selectedTourId === item.id ? 0 : -1} title={item.title || tourDateLabel(item.date)} disabled={busy} onclick={() => selectTour(item.id ?? null)}>{tourDateLabel(item.date)}</button>
        {/each}
      </div>
      {#if authenticated}
        <button class="secondary-button" type="button" disabled={busy || selectingTour} onclick={() => (addingTour = !addingTour)}>Tour anlegen</button>
      {/if}
    </nav>

    <datalist id="tour-time-zones">
      <option value="Europe/Berlin"></option>
      <option value="Europe/Vienna"></option>
      <option value="Europe/Zurich"></option>
      <option value="Pacific/Auckland"></option>
      <option value="America/New_York"></option>
      <option value="UTC"></option>
    </datalist>

    {#if authenticated && addingTour}
      <form class="tour-create" onsubmit={createTour}>
        <label>Titel<input maxlength="160" bind:value={newTourTitle} /></label>
        <label>Tourdatum<input type="date" required bind:value={newTourDate} /></label>
        <label>Zeitzone<input list="tour-time-zones" required bind:value={newTourTimeZone} /></label>
        <button class="primary-button" type="submit" disabled={busy || !newTourDate}>Anlegen</button>
        <button class="quiet-button" type="button" disabled={busy} onclick={() => (addingTour = false)}>Abbrechen</button>
      </form>
    {/if}

    <div id="tour-content" role="tabpanel" aria-label={selectedTourId ? tour.title || tourDateLabel(tour.date) : "Albumübersicht"}>
    {#if selectingTour}<p role="status">Tour und Fotos werden geladen ...</p>{/if}
    <details class="album-gallery" ontoggle={onAlbumGalleryToggle}>
      <summary>
        <span>{selectedTourId ? "Tourfotos" : "Albumfotos"}</span>
        <span class="count">{albumAssetsPage > 0 ? albumAssetsTotal : selectedTourId ? "…" : selectedAlbum.assetCount || 0}</span>
      </summary>
      {#if !immichWebUrl}
        <p class="muted">Zum Öffnen in Immich bitte `IMMICH_WEB_URL` auf die im Browser erreichbare Immich-Adresse setzen.</p>
      {/if}
      {#if albumAssetsError}
        <p class="muted">Albumfotos konnten nicht geladen werden: {albumAssetsError}</p>
      {:else if albumAssetsLoading && albumAssets.length === 0}
        <p class="muted">Albumfotos werden geladen ...</p>
      {:else if albumAssets.length}
        <div class="album-photo-grid">
          {#each albumAssets as asset (asset.id)}
            <div class="album-photo-card">
              {#if immichWebUrl}
                <a
                  class="album-photo"
                  href={immichAssetUrl(selectedAlbum.id, asset.id) ?? undefined}
                  target="_blank"
                  rel="noreferrer"
                  title="In Immich öffnen"
                >
                  <img src={thumbnail(asset.id)} alt={assetTitle(asset)} loading="lazy" />
                  <span>{assetTitle(asset)}</span>
                </a>
              {:else}
                <div class="album-photo">
                  <img src={thumbnail(asset.id)} alt={assetTitle(asset)} loading="lazy" />
                  <span>{assetTitle(asset)}</span>
                </div>
              {/if}
              {#if tour.hasGpx && hasPhotoMarker(asset.id)}
                <button class="album-photo-map" type="button" onclick={() => showPhotoOnMap(asset.id)}>
                  ⌖ Auf Karte
                </button>
              {/if}
            </div>
          {/each}
        </div>
        {#if albumAssetsTotalPages > 1}
          <nav class="album-pagination" aria-label="Albumfotos-Seiten">
            <button
              class="secondary-button"
              type="button"
              disabled={albumAssetsLoading || albumAssetsPage <= 1}
              onclick={() => loadAlbumAssets(albumAssetsPage - 1)}
            >Zurück</button>
            <span>Seite {albumAssetsPage} von {albumAssetsTotalPages}</span>
            <button
              class="secondary-button"
              type="button"
              disabled={albumAssetsLoading || !albumAssetsHasMore}
              onclick={() => loadAlbumAssets(albumAssetsPage + 1)}
            >Weiter</button>
          </nav>
        {/if}
      {:else if !albumAssetsLoading}
        <p class="muted">{tour.date ? "Keine Fotos im gewählten Zeitraum." : "Keine Fotos in diesem Album."}</p>
      {/if}
    </details>

    {#if selectedTourId}
    <div class="detail-grid" inert={selectingTour}>
      <section class="panel tour-panel">
        <div class="section-title">
          <div>
            <p class="eyebrow">Tourinformationen</p>
            <h2>{tour.title || "Deine Tour"}</h2>
          </div>
          {#if tour.direction}
            <span class="direction-tag">
              {tour.direction === "forward" ? "Hinweg" : tour.direction === "reverse" ? "Rückweg" : tour.direction}
            </span>
          {/if}
        </div>

        {#if authenticated}
          <form class="tour-form" onsubmit={saveTour}>
            <label>Titel<input maxlength="160" bind:value={tour.title} /></label>
            <div class="schedule-grid">
              <label>Tourdatum<input type="date" bind:value={tour.date} /></label>
              <label>Zeitzone<input required list="tour-time-zones" bind:value={tour.timeZone} /></label>
              <label>Beginn<input type="time" bind:value={tour.startTime} disabled={!tour.date} /></label>
              <label>Ende<input type="time" bind:value={tour.endTime} disabled={!tour.date} /></label>
            </div>
            <label>
              Komoot-Link
              <input
                type="url"
                placeholder="https://www.komoot.com/tour/..."
                bind:value={tour.komootLink}
                oninput={clearKomootPreview}
              />
            </label>
            <div class="komoot-import">
              <button
                class="secondary-button"
                type="button"
                disabled={loadingKomoot || busy || !tour.komootLink.trim()}
                onclick={loadKomootPreview}
              >
                {loadingKomoot ? "Komoot-Seite wird gelesen ..." : "Daten aus Komoot lesen"}
              </button>
              <p class="muted">
                Liest öffentlich sichtbare Angaben. Der offizielle Komoot-Embed zeigt Karte und Höhenprofil direkt von Komoot.
              </p>
              {#if komootPreview}
                <div class="komoot-preview">
                  <div class="preview-copy">
                    <p class="eyebrow">
                      {komootPreviewApplied ? "Werte übernommen · noch nicht gespeichert" : "Vorschau · noch nicht gespeichert"}
                    </p>
                    <strong>{komootPreview.title || "Komoot-Tour"}</strong>
                    {#if komootPreview.description}
                      <p>{komootPreview.description}</p>
                    {/if}
                    <div class="preview-facts">
                      {#if komootPreview.activityType}
                        <span>{komootPreview.activityType === "bike" ? "Fahrradtour" : "Wanderung"}</span>
                      {/if}
                      {#if komootPreview.distanceKm !== null}
                        <span>{komootPreview.distanceKm} km</span>
                      {/if}
                      {#if komootPreview.elevationGainM !== null}
                        <span>{komootPreview.elevationGainM} Höhenmeter</span>
                      {/if}
                    </div>
                    {#if komootPreview.elevationGainM === null}
                      <p class="preview-note">Höhenmeter waren in den öffentlichen Seitendaten nicht verfügbar.</p>
                    {/if}
                    <p class="preview-note">Karte und Höhenprofil werden direkt von Komoot geladen und nicht als Bilddateien gespeichert.</p>
                    <button class="primary-button" type="button" disabled={komootPreviewApplied} onclick={applyKomootPreview}>
                      {komootPreviewApplied ? "Werte übernommen" : "Gefundene Werte übernehmen"}
                    </button>
                    <button
                      class="secondary-button"
                      type="button"
                      disabled={busy || !tour.komootLink.trim()}
                      onclick={saveKomootScreenshots}
                    >
                      {busy ? "Screenshots werden gespeichert ..." : "Karte und Höhenprofil lokal speichern"}
                    </button>
                    <p class="preview-note">Speichert zuerst die Tourdaten und legt danach beide Screenshots im Docker-Datenverzeichnis ab.</p>
                  </div>
                  {#if previewEmbedUrl}
                    <div class="komoot-embed-wrap">
                      <iframe
                        class="komoot-embed"
                        src={previewEmbedUrl}
                        title="Komoot-Karte und Höhenprofil"
                        loading="lazy"
                        referrerpolicy="strict-origin-when-cross-origin"
                        allow="fullscreen"
                      ></iframe>
                      <span>Karte und Höhenprofil · offizieller Komoot-Embed</span>
                    </div>
                  {:else if komootPreview.mapImageUrl}
                    <a
                      class="komoot-map-preview"
                      href={komootPreview.mapImageUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <img src={komootPreview.mapImageUrl} alt="Öffentliche Komoot-Kartenvorschau" />
                      <span>Öffentliche Kartenvorschau · bei Komoot öffnen</span>
                    </a>
                  {/if}
                </div>
              {/if}
            </div>
            <div class="form-row">
              <label>
                Tourart
                <select bind:value={tour.activityType}>
                  <option value="hike">Wanderung</option>
                  <option value="bike">Fahrradtour</option>
                </select>
              </label>
              <label>
                {tour.activityType === "bike" ? "Fahrtrichtung" : "Wanderrichtung"}
                <select bind:value={tour.direction}>
                  <option value="">Nicht angegeben</option>
                  <option value="forward">Hinweg</option>
                  <option value="reverse">Rückweg</option>
                </select>
              </label>
              <label>
                Distanz (km)
                <input type="number" min="0" step="0.1" bind:value={tour.distanceKm} />
              </label>
              <label>
                Höhenmeter
                <input type="number" min="0" step="1" bind:value={tour.elevationGainM} />
              </label>
            </div>
            <label>
              Beschreibung
              <textarea rows="4" placeholder="Notizen zur Tour ..." bind:value={tour.description}></textarea>
            </label>
            <button class="primary-button" type="submit" disabled={busy}>
              {busy ? "Wird gespeichert ..." : "Tourdaten speichern"}
            </button>
          </form>
        {:else}
          <div class="read-only">
            <p>{tourDateLabel(tour.date)}{tour.date ? ` · ${tour.startTime || "00:00"}–${tour.endTime || "24:00"} · ${tour.timeZone}` : ""}</p>
            <span class="direction-tag">
              {tour.activityType === "bike" ? "Fahrradtour" : "Wanderung"}
            </span>
            {#if tour.description}
              <p class="description">{tour.description}</p>
            {:else}
              <p>Noch keine Tourinformationen hinterlegt.</p>
            {/if}
            {#if tour.distanceKm !== null || tour.elevationGainM !== null}
              <div class="stats">
                {#if tour.distanceKm !== null}<span><strong>{tour.distanceKm}</strong> km</span>{/if}
                {#if tour.elevationGainM !== null}<span><strong>{tour.elevationGainM}</strong> Höhenmeter</span>{/if}
              </div>
            {/if}
            <p class="muted">Zum Bearbeiten mit dem App-Passwort anmelden.</p>
          </div>
        {/if}

        <div class="uploads">
          <div class="upload-row">
            <div>
              <strong>GPX-Track</strong>
              <span>{tour.hasGpx ? "Track vorhanden" : "Noch kein Track hochgeladen"}</span>
            </div>
            {#if authenticated}
              <label class="file-button">
                {tour.hasGpx ? "Ersetzen" : "GPX hochladen"}
                <input
                  type="file"
                  accept=".gpx,application/gpx+xml,application/xml,text/xml"
                  disabled={busy}
                  onchange={(event) => uploadFile("gpx", event.currentTarget.files?.[0])}
                />
              </label>
            {/if}
          </div>
          <div class="upload-row">
            <div>
              <strong>Komoot-Karte</strong>
              <span>{tour.hasKomootMap ? "Bild vorhanden" : "Optionales Vorschaubild"}</span>
            </div>
            {#if authenticated}
              <label class="file-button">
                Bild hochladen
                <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onchange={(event) => uploadFile("komoot-map", event.currentTarget.files?.[0])} />
              </label>
            {/if}
          </div>
          <div class="upload-row">
            <div>
              <strong>Höhenprofil</strong>
              <span>{tour.hasElevationProfile ? "Bild vorhanden" : "Optionales Vorschaubild"}</span>
            </div>
            {#if authenticated}
              <label class="file-button">
                Bild hochladen
                <input type="file" accept="image/jpeg,image/png,image/webp" disabled={busy} onchange={(event) => uploadFile("elevation", event.currentTarget.files?.[0])} />
              </label>
            {/if}
          </div>
        </div>
      </section>

      <section class="panel map-panel">
        <div class="section-title">
          <div>
            <p class="eyebrow">Streckenverlauf</p>
            <h2>GPX-Karte</h2>
          </div>
          {#if tour.hasGpx}<span class="direction-tag">GPX</span>{/if}
        </div>
        {#if tour.hasGpx}
          <GpxMap
            src={tourResource(selectedAlbum.id, "/gpx", selectedTourId) + `&v=${imageVersion}`}
            albumId={selectedAlbum.id}
            markers={photoMarkers}
            {immichWebUrl}
            focusAssetId={mapFocusAssetId}
            focusRequestId={mapFocusRequestId}
          />
          {#if photoMapError}
            <p class="muted">{photoMapError}</p>
          {:else if photoMarkers.length}
            <p class="muted">{photoMarkers.length} Fotos mit GPS-Position auf der Karte</p>
          {:else}
            <p class="muted">Keine Fotos mit GPS-Position in diesem Album.</p>
          {/if}
        {:else}
          <div class="empty-map">
            <span class="map-icon">⌖</span>
            <strong>Noch kein GPX-Track</strong>
            <p>Lade einen Track hoch, um den Streckenverlauf hier auf der Karte zu sehen.</p>
          </div>
        {/if}

        {#if tourEmbedUrl || tour.hasKomootMap || tour.hasElevationProfile}
          <div class="komoot-media">
            <div class="section-title">
              <div>
                <p class="eyebrow">Komoot</p>
                <h2>Karte und Höhenprofil</h2>
              </div>
            </div>
            {#if tourEmbedUrl && (tour.hasKomootMap || tour.hasElevationProfile)}
              <div class="komoot-view-toggle" role="group" aria-label="Komoot-Ansicht auswählen">
                <button
                  class:active={komootDisplayMode === "embed"}
                  type="button"
                  aria-pressed={showKomootEmbed}
                  onclick={() => (komootDisplayMode = "embed")}
                >Komoot online</button>
                <button
                  class:active={komootDisplayMode === "local"}
                  type="button"
                  aria-pressed={!showKomootEmbed}
                  onclick={() => (komootDisplayMode = "local")}
                >Lokale Bilder</button>
              </div>
            {/if}

            {#if tourEmbedUrl && showKomootEmbed && !komootPreview}
              <div class="komoot-tour-embed">
                <iframe
                  class="komoot-embed"
                  src={tourEmbedUrl}
                  title="Komoot-Karte und Höhenprofil"
                  loading="lazy"
                  referrerpolicy="strict-origin-when-cross-origin"
                  allow="fullscreen"
                ></iframe>
                <p class="muted">Diese Ansicht wird direkt von Komoot geladen.</p>
              </div>
            {/if}

            {#if (tour.hasKomootMap || tour.hasElevationProfile) &&
              (!tourEmbedUrl || !showKomootEmbed)}
              <div class="preview-images">
                {#if tour.hasKomootMap}
                  <figure>
                    <img src={tourResource(selectedAlbum.id, "/images/komoot-map", selectedTourId) + `&v=${imageVersion}`} alt="Komoot-Kartenvorschau" />
                    <figcaption>Komoot-Karte</figcaption>
                  </figure>
                {/if}
                {#if tour.hasElevationProfile}
                  <figure>
                    <img src={tourResource(selectedAlbum.id, "/images/elevation", selectedTourId) + `&v=${imageVersion}`} alt="Höhenprofil" />
                    <figcaption>Höhenprofil</figcaption>
                  </figure>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      </section>

      <section class="panel comments-panel">
        <div class="section-title">
          <div>
            <p class="eyebrow">Gemeinsame Erinnerungen</p>
            <h2>Kommentare <span class="count">{comments.length}</span></h2>
          </div>
        </div>
        {#if comments.length}
          <div class="comment-list">
            {#each comments as comment (comment.id)}
              <article class="comment">
                <div class="comment-meta">
                  <strong>{comment.author || "Anonym"}</strong>
                  <time datetime={comment.created_at}>
                    {new Date(comment.created_at).toLocaleDateString("de-DE", { dateStyle: "medium" })}
                  </time>
                </div>
                <p>{comment.text}</p>
              </article>
            {/each}
          </div>
        {:else}
          <p class="muted">Noch keine Kommentare zu dieser Tour.</p>
        {/if}
        {#if authenticated}
          <form class="comment-form" onsubmit={addComment}>
            <div class="form-row">
              <label>
                Name <span class="optional">(optional)</span>
                <input maxlength="100" placeholder="Dein Name" bind:value={author} />
              </label>
              <label class="comment-input">
                Kommentar
                <textarea required maxlength="4000" rows="2" placeholder="Erinnerung oder Hinweis hinzufügen ..." bind:value={commentText}></textarea>
              </label>
            </div>
            <button class="primary-button" type="submit" disabled={busy || !commentText.trim()}>
              Kommentar hinzufügen
            </button>
          </form>
        {:else}
          <p class="muted">Zum Kommentieren bitte anmelden.</p>
        {/if}
      </section>
    </div>
    {:else}
      <section class="tour-overview">
        <h2>Touren <span class="count">{tours.length}</span></h2>
        {#if tours.length}
          <ul>
            {#each tours as item (item.id)}
              <li><button type="button" disabled={busy || selectingTour} onclick={() => selectTour(item.id ?? null)}><span>{tourDateLabel(item.date)}</span><strong>{item.title || (item.activityType === "bike" ? "Fahrradtour" : "Wanderung")}</strong><span>{item.distanceKm !== null ? `${item.distanceKm} km` : ""}</span></button></li>
            {/each}
          </ul>
        {:else}
          <p class="muted">Noch keine Touren vorhanden.</p>
        {/if}
      </section>
    {/if}
    </div>
    {/if}
  {:else}
    <section class="hero">
      <div>
        <p class="eyebrow">Deine Immich-Bibliothek</p>
        <h1>Alben und Touren,<br /><span>verbunden unterwegs.</span></h1>
        <p class="hero-copy">
          Wähle ein Album und ergänze es um GPX-Tracks, Komoot-Infos und Erinnerungen.
        </p>
      </div>
      <div class="hero-orbit" aria-hidden="true"><span>⌖</span></div>
    </section>

    <section class="library">
      <div class="library-heading">
        <div>
          <p class="eyebrow">Deine Sammlung</p>
          <h2>Alben <span class="count">{filteredAlbums.length}</span></h2>
        </div>
        <div class="library-controls">
          <button
            class="komoot-filter"
            type="button"
            aria-label="Nur Komoot-verknüpfte Alben anzeigen"
            aria-pressed={onlyKomootLinked}
            title="Nur Komoot-verknüpfte Alben anzeigen"
            onclick={() => {
              onlyKomootLinked = !onlyKomootLinked;
              albumsPage = 1;
            }}
          ><span aria-hidden="true">⛓</span></button>
          <div class="search-wrap">
            <span aria-hidden="true">⌕</span>
            <label class="sr-only" for="album-search">Alben suchen</label>
            <input
              id="album-search"
              placeholder="Album suchen ..."
              bind:value={search}
              oninput={() => (albumsPage = 1)}
            />
          </div>
        </div>
      </div>

      {#if loading}
        <div class="empty-state"><span class="spinner"></span><p>Alben werden geladen ...</p></div>
      {:else if filteredAlbums.length}
        <div class="album-grid">
          {#each pagedAlbums as album (album.id)}
            <button class="album-card" onclick={() => openAlbum(album)}>
              <div class="album-cover">
                {#if album.albumThumbnailAssetId}
                  <img src={thumbnail(album.albumThumbnailAssetId)} alt="" loading="lazy" />
                {:else}
                  <span class="cover-placeholder">⌖</span>
                {/if}
                <span class="asset-count">{album.assetCount ?? 0} Medien</span>
              </div>
              <div class="album-card-info">
                <strong>{album.albumName}</strong>
                <span>{album.description || "Tourdetails und Fotos ansehen"}</span>
              </div>
              {#if komootLinkedAlbumIds.includes(album.id)}
                <span class="komoot-linked" title="Mit Komoot verknüpft" aria-label="Mit Komoot verknüpft">⛓</span>
              {/if}
              <span class="card-arrow" aria-hidden="true">↗</span>
            </button>
          {/each}
        </div>
        {#if albumPagesTotal > 1}
          <nav class="album-pagination" aria-label="Albumseiten">
            <button
              class="secondary-button"
              type="button"
              disabled={albumsPage <= 1}
              onclick={() => (albumsPage -= 1)}
            >Zurück</button>
            <span>Seite {albumsPage} von {albumPagesTotal}</span>
            <button
              class="secondary-button"
              type="button"
              disabled={albumsPage >= albumPagesTotal}
              onclick={() => (albumsPage += 1)}
            >Weiter</button>
          </nav>
        {/if}
      {:else}
        <div class="empty-state">
          <span class="empty-icon">▱</span>
          <strong>{search ? "Keine passenden Alben" : "Keine Alben gefunden"}</strong>
          <p>{search ? "Ändere den Suchbegriff und versuche es erneut." : "Prüfe Immich-URL und API-Key in deiner Konfiguration."}</p>
        </div>
      {/if}
    </section>
  {/if}
</main>

<footer>
  <span>Immich GPX Mapper <span class="version">Version {appVersion}</span></span>
  <span>Deine Fotos bleiben in Immich.</span>
</footer>

<style>
  .album-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .album-title-row { display: flex; align-items: center; gap: 12px; min-width: 0; }
  .album-title-row h1 { min-width: 0; overflow-wrap: anywhere; }
  .delete-album-data { display: inline-grid; place-items: center; flex: 0 0 32px; width: 32px; height: 32px; padding: 7px; border: 0; border-radius: 4px; background: transparent; color: #8d6963; }
  .delete-album-data:hover { color: #962e2e; background: #f9eae7; }
  .delete-album-data:focus-visible { outline: 2px solid #962e2e; outline-offset: 3px; }
  .delete-album-data:disabled { opacity: .5; cursor: default; }
  .settings-button { display: inline-grid; place-items: center; flex: 0 0 38px; width: 38px; height: 38px; padding: 8px; }
  .album-view-toggle { margin: 24px 0 12px; }
  .tour-navigation { display: flex; align-items: center; gap: 12px; min-width: 0; margin: 20px 0; }
  .tour-tabs { display: flex; gap: 4px; overflow-x: auto; min-width: 0; flex: 1; border-bottom: 1px solid #d5ddd7; }
  .tour-tabs button { flex: 0 0 auto; min-height: 44px; padding: 8px 14px; border: 0; border-bottom: 3px solid transparent; border-radius: 0; background: transparent; color: inherit; white-space: nowrap; }
  .tour-tabs button[aria-selected="true"] { border-bottom-color: #378a5d; font-weight: 700; }
  .tour-create { display: flex; flex-wrap: wrap; align-items: end; gap: 12px; padding: 16px 0; border-bottom: 1px solid #d5ddd7; margin-bottom: 20px; }
  .tour-create label { flex: 1 1 170px; min-width: 0; display: grid; gap: 6px; }
  .tour-create input { width: 100%; min-width: 0; }
  .schedule-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .schedule-grid label { min-width: 0; }
  .schedule-grid input { width: 100%; min-width: 0; }
  .tour-overview { padding: 20px 0; }
  .tour-overview ul { list-style: none; padding: 0; }
  .tour-overview li { border-bottom: 1px solid #d5ddd7; }
  .tour-overview li button { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; width: 100%; min-height: 56px; padding: 12px 0; text-align: left; border: 0; border-radius: 0; background: transparent; color: inherit; }
  .tour-overview li strong { flex: 1 1 150px; overflow-wrap: anywhere; }
  @media (max-width: 540px) { .tour-navigation { flex-wrap: wrap; } .tour-tabs { flex-basis: 100%; } .schedule-grid { grid-template-columns: minmax(0, 1fr); } }
  :global(*) { box-sizing: border-box; }
  :global(body) {
    margin: 0;
    min-width: 320px;
    min-height: 100vh;
    background: #f5f7f3;
    color: #202a23;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  :global(button), :global(input), :global(textarea), :global(select) { font: inherit; }
  :global(button) { cursor: pointer; }
  .topbar {
    height: 74px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 clamp(1.25rem, 5vw, 5rem);
    border-bottom: 1px solid #e6ebe4;
    background: #fbfcfa;
  }
  .brand { display: flex; align-items: center; gap: .7rem; color: inherit; text-decoration: none; font-size: .96rem; }
  .brand strong { font-weight: 750; }
  .brand-mark {
    display: grid; width: 2rem; height: 2rem; place-items: center; border-radius: .65rem;
    background: #dcebe0; color: #39714e; font-weight: 800;
  }
  .auth { display: flex; align-items: center; gap: 1rem; }
  .auth-state { color: #48604d; font-size: .82rem; }
  .dot { display: inline-block; width: .45rem; height: .45rem; margin-right: .4rem; border-radius: 50%; background: #4a9b63; }
  .login-form { display: flex; gap: .5rem; }
  .login-form input, input, textarea, select {
    width: 100%; padding: .72rem .8rem; border: 1px solid #dce3db; border-radius: .65rem;
    background: #fff; color: #202a23; outline: none;
  }
  input:focus, textarea:focus, select:focus { border-color: #6a9c77; box-shadow: 0 0 0 3px #4e8d5c1a; }
  .login-form input { width: 10.5rem; padding: .55rem .7rem; font-size: .83rem; }
  main { width: min(100% - 3rem, 1240px); min-height: calc(100vh - 135px); margin: 0 auto; padding: 3.2rem 0 5rem; }
  .hero { display: flex; align-items: center; justify-content: space-between; min-height: 275px; margin-bottom: 3.4rem; padding: 2.3rem clamp(1.5rem, 5vw, 4.5rem); overflow: hidden; border-radius: 1.5rem; background: #e8efe7; }
  .eyebrow { margin: 0 0 .65rem; color: #66836b; font-size: .69rem; font-weight: 800; letter-spacing: .13em; text-transform: uppercase; }
  h1 { margin: 0; font-size: clamp(2.2rem, 5vw, 3.65rem); line-height: 1.08; letter-spacing: -.055em; }
  .hero h1 span { color: #65846a; }
  .hero-copy { max-width: 31rem; margin: 1.2rem 0 0; color: #67736a; line-height: 1.65; }
  .hero-orbit { display: grid; flex: 0 0 170px; width: 170px; height: 170px; place-items: center; margin: 0 4% 0 2rem; border: 1px solid #b9cbb9; border-radius: 50%; color: #64856b; font-size: 4.2rem; }
  .hero-orbit:before, .hero-orbit:after { position: absolute; width: 125px; height: 125px; border: 1px solid #c8d6c6; border-radius: 50%; content: ""; }
  .hero-orbit:after { width: 80px; height: 80px; }
  .library-heading, .section-title { display: flex; align-items: end; justify-content: space-between; gap: 1rem; }
  h2 { margin: 0; font-size: 1.45rem; letter-spacing: -.03em; }
  .count { display: inline-grid; min-width: 1.55rem; height: 1.55rem; place-items: center; margin-left: .35rem; padding: 0 .35rem; border-radius: 2rem; background: #e9eee7; color: #718071; font-size: .72rem; vertical-align: .15rem; }
  .search-wrap { display: flex; align-items: center; gap: .5rem; width: min(100%, 16rem); color: #819082; }
  .library-controls { display: flex; align-items: center; gap: .5rem; }
  .komoot-filter { display: inline-grid; flex: 0 0 auto; width: 2.55rem; height: 2.55rem; place-items: center; padding: 0; border: 1px solid #dfe7dd; border-radius: .65rem; background: #fbfcfa; color: #718071; font-size: 1rem; }
  .komoot-filter[aria-pressed="true"] { border-color: #b7cfb9; background: #e9f2ea; color: #456f4e; }
  .komoot-filter:hover { background: #edf3eb; }
  .search-wrap input { border-color: #e0e6df; background: #fbfcfa; font-size: .86rem; }
  .album-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.15rem; margin-top: 1.4rem; }
  .album-card { position: relative; overflow: hidden; padding: 0; border: 1px solid #e5eae3; border-radius: 1rem; background: #fff; color: inherit; text-align: left; transition: transform .18s ease, box-shadow .18s ease; }
  .album-card:hover { transform: translateY(-3px); box-shadow: 0 12px 30px #23302312; }
  .album-cover { position: relative; display: grid; height: 180px; place-items: center; overflow: hidden; background: #e9eee8; }
  .album-cover img { width: 100%; height: 100%; object-fit: cover; transition: transform .3s ease; }
  .album-card:hover .album-cover img { transform: scale(1.035); }
  .cover-placeholder { color: #93a793; font-size: 3rem; }
  .asset-count { position: absolute; right: .75rem; bottom: .7rem; padding: .33rem .55rem; border: 1px solid #ffffff80; border-radius: 2rem; background: #202a23a8; color: white; font-size: .69rem; backdrop-filter: blur(8px); }
  .album-card-info { display: grid; gap: .35rem; padding: 1rem 2.5rem 1.1rem 1rem; }
  .komoot-linked { position: absolute; right: 2.5rem; bottom: 1.04rem; display: grid; width: 1.55rem; height: 1.55rem; place-items: center; border-radius: 50%; background: #e9f2ea; color: #456f4e; font-size: .78rem; line-height: 1; }
  .album-card-info strong { overflow: hidden; font-size: .98rem; text-overflow: ellipsis; white-space: nowrap; }
  .album-card-info span { overflow: hidden; color: #849084; font-size: .77rem; text-overflow: ellipsis; white-space: nowrap; }
  .card-arrow { position: absolute; right: 1rem; bottom: 1.15rem; color: #809080; }
  .empty-state { display: grid; min-height: 220px; place-content: center; justify-items: center; gap: .4rem; margin-top: 1.4rem; border: 1px dashed #d8e0d6; border-radius: 1rem; color: #738073; text-align: center; }
  .empty-state p { margin: 0; font-size: .85rem; }
  .empty-icon { font-size: 2rem; }
  .spinner { width: 1.6rem; height: 1.6rem; border: 2px solid #dce6dc; border-top-color: #548060; border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  footer { display: flex; justify-content: space-between; padding: 1.3rem clamp(1.5rem, 5vw, 5rem); border-top: 1px solid #e6ebe4; color: #899389; font-size: .73rem; }
  .version { margin-left: .35rem; color: #a0a99f; font-variant-numeric: tabular-nums; }
  .alert { display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin: 0 0 1.2rem; padding: .8rem 1rem; border-radius: .75rem; font-size: .88rem; }
  .alert button { border: 0; background: transparent; color: inherit; font-size: 1.2rem; }
  .error-alert { background: #fbecea; color: #a53d32; }
  .notice-alert { background: #e7f2e7; color: #41694a; }
  .album-heading { display: flex; justify-content: space-between; align-items: end; gap: 1rem; margin-bottom: 1.35rem; }
  .album-heading h1 { font-size: clamp(2rem, 5vw, 3rem); }
  .muted { color: #7c887d; font-size: .85rem; line-height: 1.55; }
  .album-heading .muted { margin: .55rem 0 0; }
  .komoot-button, .primary-button, .small-button { display: inline-flex; align-items: center; justify-content: center; gap: .4rem; border: 0; border-radius: .65rem; background: #477954; color: white; text-decoration: none; font-size: .82rem; font-weight: 700; }
  .komoot-button { padding: .75rem 1rem; white-space: nowrap; }
  .secondary-button { display: inline-flex; min-height: 2.45rem; align-items: center; justify-content: center; padding: .6rem .85rem; border: 1px solid #d5e1d4; border-radius: .65rem; background: #f3f7f1; color: #486f50; font-size: .79rem; font-weight: 700; }
  .secondary-button:disabled { cursor: not-allowed; opacity: .55; }
  .komoot-import { display: grid; justify-items: start; gap: .45rem; }
  .komoot-import > .muted { margin: 0; font-size: .72rem; }
  .komoot-preview { display: grid; width: 100%; grid-template-columns: minmax(0, 1fr); gap: 1rem; margin-top: .35rem; padding: 1rem; border: 1px solid #dce8da; border-radius: .8rem; background: #f7faf6; }
  .preview-copy { display: grid; align-content: start; justify-items: start; gap: .55rem; }
  .preview-copy .eyebrow { margin: 0; font-size: .62rem; }
  .preview-copy > strong { font-size: .9rem; }
  .preview-copy > p:not(.eyebrow) { margin: 0; color: #657266; font-size: .76rem; line-height: 1.5; }
  .preview-facts { display: flex; flex-wrap: wrap; gap: .4rem; }
  .preview-facts span { padding: .3rem .5rem; border-radius: 2rem; background: #e8efe6; color: #526a54; font-size: .68rem; }
  .preview-copy .preview-note { color: #899187; font-size: .68rem; }
  .komoot-embed-wrap { display: grid; gap: .4rem; color: #758174; font-size: .67rem; }
  .komoot-embed { display: block; width: 100%; min-height: 700px; border: 0; border-radius: .6rem; background: #f4f6f2; }
  .komoot-tour-embed { display: grid; gap: .5rem; margin-top: 1.5rem; }
  .komoot-tour-embed > .muted { margin: 0; }
  .komoot-view-toggle { display: flex; width: fit-content; gap: .25rem; margin: 1rem 0 0; padding: .25rem; border-radius: .7rem; background: #edf2eb; }
  .komoot-view-toggle button { min-height: 2.2rem; padding: .45rem .7rem; border: 0; border-radius: .5rem; background: transparent; color: #647064; font-size: .73rem; font-weight: 700; }
  .komoot-view-toggle button.active { background: white; color: #3f6f49; box-shadow: 0 1px 3px #1c2a1c1c; }
  .komoot-map-preview { display: grid; align-content: start; gap: .4rem; color: #758174; font-size: .67rem; text-decoration: none; }
  .komoot-map-preview img { width: 100%; max-height: 210px; border-radius: .6rem; object-fit: cover; background: #e9eee8; }
  .primary-button { min-height: 2.65rem; padding: .7rem 1rem; }
  .small-button { padding: .55rem .8rem; font-size: .76rem; }
  .primary-button:disabled, .small-button:disabled { cursor: not-allowed; opacity: .55; }
  .quiet-button { padding: .5rem .7rem; border: 0; background: none; color: #607560; font-size: .8rem; }
  .album-gallery { margin: 0 0 1.35rem; padding: .8rem 0; border-top: 1px solid #e6ebe4; border-bottom: 1px solid #e6ebe4; }
  .album-gallery summary { display: flex; min-height: 2rem; align-items: center; justify-content: space-between; gap: .75rem; color: #405343; cursor: pointer; font-size: .9rem; font-weight: 750; list-style: none; }
  .album-gallery summary::-webkit-details-marker { display: none; }
  .album-gallery summary:after { content: "+"; color: #65846a; font-size: 1.2rem; }
  .album-gallery[open] summary:after { content: "−"; }
  .album-photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: .7rem; margin-top: .85rem; }
  .album-photo { display: grid; min-width: 0; align-content: start; gap: .3rem; color: #536354; text-decoration: none; }
  .album-photo img { width: 100%; aspect-ratio: 4 / 3; border-radius: .45rem; object-fit: cover; background: #edf2eb; }
  .album-photo span { overflow: hidden; font-size: .7rem; text-overflow: ellipsis; white-space: nowrap; }
  .album-photo-card { display: grid; min-width: 0; align-content: start; justify-items: start; gap: .25rem; }
  .album-photo-map { display: inline-flex; min-height: 1.45rem; align-items: center; gap: .2rem; padding: .18rem .35rem; border: 0; border-radius: .35rem; background: transparent; color: #55745d; font-size: .65rem; font-weight: 650; line-height: 1.1; }
  .album-photo-map:hover { background: #edf3eb; }
  .album-pagination { display: flex; align-items: center; justify-content: center; gap: .75rem; margin-top: .85rem; }
  .album-pagination > span { color: #6f7e70; font-size: .74rem; font-variant-numeric: tabular-nums; }
  .detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1rem; align-items: start; }
  .panel { min-width: 0; padding: clamp(1.1rem, 2.3vw, 1.7rem); border: 1px solid #e5eae3; border-radius: 1rem; background: #fff; }
  .section-title { align-items: center; margin-bottom: 1.25rem; }
  .section-title .eyebrow { margin-bottom: .35rem; }
  .direction-tag { padding: .35rem .65rem; border-radius: 2rem; background: #eaf1e9; color: #57765d; font-size: .72rem; font-weight: 700; }
  .tour-form, .tour-form label, .comment-form { display: grid; gap: .85rem; }
  label { display: grid; gap: .38rem; color: #566257; font-size: .76rem; font-weight: 650; }
  label input, label textarea, label select { font-size: .86rem; font-weight: 400; }
  textarea { resize: vertical; }
  .form-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: .75rem; }
  .form-row:has(select) { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .read-only { min-height: 7rem; }
  .description { white-space: pre-wrap; line-height: 1.6; }
  .stats { display: flex; gap: 1.2rem; color: #667368; font-size: .8rem; }
  .stats strong { color: #344a37; }
  .uploads { display: grid; gap: .2rem; margin-top: 1.35rem; padding-top: .75rem; border-top: 1px solid #edf0eb; }
  .upload-row { display: flex; min-height: 3.6rem; align-items: center; justify-content: space-between; gap: .8rem; border-bottom: 1px solid #f0f2ef; }
  .upload-row > div { display: grid; gap: .2rem; }
  .upload-row strong { font-size: .78rem; }
  .upload-row span { color: #889287; font-size: .7rem; }
  .file-button { position: relative; display: inline-flex; width: auto; padding: .48rem .7rem; border: 1px solid #dfe7dd; border-radius: .55rem; color: #4f7256; cursor: pointer; font-size: .7rem; white-space: nowrap; }
  .file-button input { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); }
  .map-panel { grid-column: 2; grid-row: 1 / span 2; }
  .empty-map { display: grid; min-height: 340px; place-content: center; justify-items: center; padding: 1rem; border-radius: 1rem; background: #edf2eb; color: #687869; text-align: center; }
  .empty-map strong { margin-top: .7rem; color: #465648; font-size: .9rem; }
  .empty-map p { max-width: 18rem; font-size: .77rem; line-height: 1.5; }
  .map-icon { display: grid; width: 3rem; height: 3rem; place-items: center; border-radius: 50%; background: #dce9dc; color: #5b8062; font-size: 1.8rem; }
  .preview-images { display: grid; gap: .8rem; margin-top: 1rem; }
  .preview-images figure { margin: 0; overflow: hidden; border: 1px solid #e7ece5; border-radius: .75rem; }
  .preview-images img { display: block; width: 100%; max-height: 240px; object-fit: contain; background: #f5f7f3; }
  .preview-images figcaption { padding: .6rem .75rem; color: #768276; font-size: .72rem; }
  .comments-panel { grid-column: 1; }
  .comment-list { display: grid; gap: .85rem; margin-bottom: 1rem; }
  .comment { padding-bottom: .85rem; border-bottom: 1px solid #edf0eb; }
  .comment-meta { display: flex; justify-content: space-between; gap: 1rem; font-size: .78rem; }
  .comment-meta time { color: #929b91; font-size: .7rem; }
  .comment p { margin: .45rem 0 0; color: #5c685d; font-size: .83rem; line-height: 1.55; white-space: pre-wrap; }
  .comment-form { padding-top: .9rem; border-top: 1px solid #edf0eb; }
  .comment-input { grid-column: 1 / -1; }
  .optional { color: #9aa399; font-weight: 400; }
  .sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
  @media (max-width: 850px) {
    .album-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .detail-grid { grid-template-columns: 1fr; }
    .map-panel, .comments-panel { grid-column: 1; grid-row: auto; }
  }
  @media (max-width: 560px) {
    .topbar { height: auto; min-height: 68px; flex-wrap: wrap; gap: .75rem; padding: .8rem 1rem; }
    .brand { font-size: .82rem; }
    .brand { flex: 1 1 100%; }
    .brand-mark { width: 1.7rem; height: 1.7rem; }
    .auth-state { display: none; }
    .auth, .login-form { width: 100%; }
    .login-form input { flex: 1; width: auto; min-width: 0; }
    main { width: min(100% - 2rem, 1240px); padding-top: 1.4rem; }
    .hero { min-height: 245px; margin-bottom: 2.4rem; padding: 1.5rem; }
    .hero-orbit { flex-basis: 70px; width: 70px; height: 70px; margin: 0; font-size: 2rem; }
    .hero-orbit:before { width: 55px; height: 55px; }
    .hero-orbit:after { width: 35px; height: 35px; }
    .hero-copy { font-size: .85rem; }
    .album-grid { grid-template-columns: 1fr; }
    .album-cover { height: 190px; }
    .library-heading { align-items: start; flex-direction: column; }
    .library-controls, .search-wrap { width: 100%; }
    .search-wrap { flex: 1; }
    .album-heading { align-items: start; flex-direction: column; }
    .form-row, .form-row:has(select) { grid-template-columns: 1fr; }
    .komoot-embed { min-height: 560px; }
    .komoot-map-preview { grid-row: 1; }
    .map-panel :global(.map) { min-height: 260px; }
    .comment-input { grid-column: auto; }
    footer { gap: .5rem; flex-direction: column; padding: 1.2rem 1rem; }
  }
</style>
