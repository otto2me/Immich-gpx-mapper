<script lang="ts">
  import { onMount } from "svelte";
  import { ArrowUp, ArrowDown, Trash2, Plus, Images, X, Check, Save, RefreshCw } from "@lucide/svelte";
  import { api, tourResource, type Album, type Asset, type Tour, type TravelReport, type ReportChapter } from "./api.js";

  let { album, tours, canEdit, onOpenTour, dirty = $bindable(false), saving = $bindable(false) }: {
    album: Album; tours: Tour[]; canEdit: boolean; onOpenTour: (id: string) => void | Promise<void>; dirty?: boolean; saving?: boolean
  } = $props();
  let draft = $state<TravelReport>({ title: "", introduction: "", chapters: [], revision: 0 });
  let savedSnapshot = $state("");
  let loaded = $state(false);
  let loading = $state(true);
  let error = $state("");
  let notice = $state("");
  let mode = $state<"edit" | "preview">("preview");
  let pickerChapterId = $state<string | null>(null);
  let pickerTourId = $state("");
  let photos = $state<Asset[]>([]);
  let photoPage = $state(1);
  let photoHasMore = $state(false);
  let photoLoading = $state(false);
  let photoError = $state("");
  let photoRevision = 0;

  $effect(() => {
    dirty = loaded && JSON.stringify(draft) !== savedSnapshot;
  });

  function message(reason: unknown) {
    return reason instanceof Error ? reason.message : "Der Reisebericht konnte nicht geladen werden";
  }

  async function load() {
    if (dirty && !confirm("Ungespeicherte Änderungen verwerfen und den gespeicherten Bericht laden?")) return;
    loading = true;
    error = "";
    notice = "";
    try {
      const saved = await api.report(album.id);
      draft = saved ?? { title: album.albumName, introduction: "", chapters: [], revision: 0 };
      savedSnapshot = JSON.stringify(draft);
      loaded = true;
      pickerChapterId = null;
    } catch (reason) {
      error = message(reason);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
    function beforeUnload(event: BeforeUnloadEvent) {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  });

  async function save() {
    if (!canEdit) return;
    if (!draft.title.trim()) { error = "Bitte einen Berichtstitel eingeben"; return; }
    saving = true;
    error = "";
    notice = "";
    try {
      const saved = await api.saveReport(album.id, $state.snapshot(draft));
      draft = saved;
      savedSnapshot = JSON.stringify(saved);
      notice = "Reisebericht gespeichert.";
    } catch (reason) {
      error = message(reason);
    } finally {
      saving = false;
    }
  }

  function addChapter() {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const id = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
    draft.chapters.push({ id, title: "", date: null, text: "", tourId: null, photos: [] });
    mode = "edit";
  }

  function move<Item>(items: Item[], index: number, offset: number) {
    const next = index + offset;
    if (next < 0 || next >= items.length) return items;
    const reordered = [...items];
    [reordered[index], reordered[next]] = [reordered[next], reordered[index]];
    return reordered;
  }

  function removeChapter(chapter: ReportChapter) {
    if (!confirm(`Kapitel „${chapter.title || "Ohne Titel"}“ entfernen?`)) return;
    draft.chapters = draft.chapters.filter((item) => item.id !== chapter.id);
    if (pickerChapterId === chapter.id) closePicker();
  }

  function closePicker() {
    pickerChapterId = null;
    ++photoRevision;
    photoLoading = false;
  }

  async function openPicker(chapter: ReportChapter) {
    pickerChapterId = chapter.id;
    pickerTourId = chapter.tourId ?? "";
    await loadPhotos(1);
  }

  async function loadPhotos(page: number) {
    const revision = ++photoRevision;
    photoLoading = true;
    photoError = "";
    photos = [];
    try {
      const result = await api.albumAssets(album.id, page, pickerTourId || null);
      if (revision !== photoRevision) return;
      photos = result.items.filter((item) => item.type !== "VIDEO");
      photoPage = result.page;
      photoHasMore = result.hasMore;
    } catch (reason) {
      if (revision === photoRevision) photoError = message(reason);
    } finally {
      if (revision === photoRevision) photoLoading = false;
    }
  }

  function togglePhoto(chapter: ReportChapter, assetId: string) {
    if (chapter.photos.some((photo) => photo.assetId === assetId)) {
      chapter.photos = chapter.photos.filter((photo) => photo.assetId !== assetId);
    } else {
      chapter.photos.push({ assetId, caption: "" });
    }
  }

  function image(assetId: string, preview = false) {
    return `/api/assets/${encodeURIComponent(assetId)}/thumbnail${preview ? "?size=preview" : ""}`;
  }

  function dateLabel(date: string | null) {
    return date ? new Date(`${date}T12:00:00Z`).toLocaleDateString("de-DE", { timeZone: "UTC", dateStyle: "long" }) : "";
  }

  function linkedTour(id: string | null) {
    return tours.find((tour) => tour.id === id);
  }
</script>

<section class="report-workspace" aria-label="Reisebericht">
  <header class="report-toolbar">
    <div><h2>Reisebericht</h2>{#if canEdit}<span class="draft-state">{dirty ? "Ungespeicherte Änderungen" : draft.revision ? "Gespeichert" : "Noch nicht gespeichert"}</span>{/if}</div>
    <div class="report-actions">
      {#if canEdit}<div class="view-modes" role="group" aria-label="Berichtsansicht">
        <button type="button" aria-pressed={mode === "edit"} onclick={() => (mode = "edit")}>Bearbeiten</button>
        <button type="button" aria-pressed={mode === "preview"} onclick={() => (mode = "preview")}>Vorschau</button>
      </div>{/if}
      <button class="icon-button" type="button" title="Gespeicherten Bericht neu laden" aria-label="Gespeicherten Bericht neu laden" disabled={saving || loading} onclick={load}><RefreshCw size={18} /></button>
      {#if canEdit}<button class="save-button" type="button" disabled={saving || loading || !loaded || (!dirty && draft.revision > 0)} onclick={save}><Save size={17} />{saving ? "Speichern ..." : "Speichern"}</button>{/if}
    </div>
  </header>

  {#if error}<p class="report-error" role="alert">{error}</p>{/if}
  {#if notice}<p class="report-notice" role="status">{notice}</p>{/if}
  {#if loading}
    <p role="status">Reisebericht wird geladen ...</p>
  {:else if loaded}
    {#if !canEdit && !draft.revision}
      <p>Noch kein Reisebericht vorhanden.</p>
    {:else if mode === "edit" && canEdit}
      <div class="report-editor" inert={saving}>
        <div class="report-intro">
          <label>Berichtstitel<input maxlength="200" bind:value={draft.title} /></label>
          <label>Einleitung<textarea rows="4" maxlength="20000" bind:value={draft.introduction}></textarea></label>
        </div>
        {#each draft.chapters as chapter, chapterIndex (chapter.id)}
          <section class="chapter-editor" aria-label={`Kapitel ${chapterIndex + 1}`}>
            <header class="chapter-toolbar">
              <h3>Kapitel {chapterIndex + 1}</h3>
              <div class="chapter-actions">
                <button class="icon-button" type="button" title="Kapitel nach oben" aria-label="Kapitel nach oben" disabled={chapterIndex === 0} onclick={() => (draft.chapters = move(draft.chapters, chapterIndex, -1))}><ArrowUp size={18} /></button>
                <button class="icon-button" type="button" title="Kapitel nach unten" aria-label="Kapitel nach unten" disabled={chapterIndex === draft.chapters.length - 1} onclick={() => (draft.chapters = move(draft.chapters, chapterIndex, 1))}><ArrowDown size={18} /></button>
                <button class="icon-button danger" type="button" title="Kapitel entfernen" aria-label="Kapitel entfernen" onclick={() => removeChapter(chapter)}><Trash2 size={18} /></button>
              </div>
            </header>
            <label>Kapiteltitel<input maxlength="200" bind:value={chapter.title} /></label>
            <div class="chapter-fields">
              <label>Datum<input type="date" bind:value={chapter.date} /></label>
              <label>Verknüpfte Tour<select bind:value={chapter.tourId}><option value={null}>Keine Tour</option>{#each tours as tour (tour.id)}<option value={tour.id}>{tour.date ? `${dateLabel(tour.date)} · ` : ""}{tour.title || (tour.activityType === "bike" ? "Fahrradtour" : "Wanderung")}</option>{/each}</select></label>
            </div>
            <label>Kapiteltext<textarea rows="6" maxlength="20000" bind:value={chapter.text}></textarea></label>
            <div class="chapter-toolbar"><h4>Fotos <span>{chapter.photos.length}</span></h4><button type="button" class="secondary-button" disabled={chapter.photos.length >= 100} onclick={() => openPicker(chapter)}><Images size={17} />Fotos auswählen</button></div>
            {#if pickerChapterId === chapter.id}
              <section class="photo-picker" aria-label="Fotos auswählen">
                <header class="chapter-toolbar">
                  <label>Fotoauswahl<select bind:value={pickerTourId} onchange={() => loadPhotos(1)}><option value="">Alle Albumfotos</option>{#each tours as tour (tour.id)}<option value={tour.id}>{tour.title || dateLabel(tour.date) || "Ohne Datum"}</option>{/each}</select></label>
                  <button class="icon-button" type="button" title="Fotoauswahl schließen" aria-label="Fotoauswahl schließen" onclick={closePicker}><X size={18} /></button>
                </header>
                {#if photoError}<p class="report-error" role="alert">{photoError}</p>{/if}
                {#if photoLoading}<p role="status">Fotos werden geladen ...</p>{/if}
                <div class="photo-choices">
                  {#each photos as asset (asset.id)}
                    {@const selected = chapter.photos.some((photo) => photo.assetId === asset.id)}
                    <button class="photo-choice" type="button" aria-label={asset.originalFileName || asset.id} aria-pressed={selected} disabled={!selected && chapter.photos.length >= 100} onclick={() => togglePhoto(chapter, asset.id)}>
                      <img src={image(asset.id)} alt={asset.originalFileName || "Albumfoto"} loading="lazy" />
                      <span class="photo-selection">{#if selected}<Check size={18} />{:else}<Plus size={18} />{/if}</span>
                      <span class="filename">{asset.originalFileName || "Albumfoto"}</span>
                    </button>
                  {/each}
                </div>
                {#if !photoLoading && !photos.length && !photoError}<p>Keine Fotos auf dieser Seite.</p>{/if}
                <nav class="photo-pagination" aria-label="Fotoauswahl-Seiten"><button type="button" disabled={photoLoading || photoPage <= 1} onclick={() => loadPhotos(photoPage - 1)}>Zurück</button><span>Seite {photoPage}</span><button type="button" disabled={photoLoading || !photoHasMore} onclick={() => loadPhotos(photoPage + 1)}>Weiter</button></nav>
              </section>
            {/if}
            <div class="selected-photos">
              {#each chapter.photos as photo, photoIndex (photo.assetId)}
                <div class="selected-photo">
                  <img src={image(photo.assetId)} alt={photo.caption || `Ausgewähltes Foto ${photoIndex + 1}`} loading="lazy" />
                  <label>Bildunterschrift<textarea rows="2" maxlength="2000" bind:value={photo.caption}></textarea></label>
                  <div class="photo-actions">
                    <button class="icon-button" type="button" title="Foto nach vorne" aria-label="Foto nach vorne" disabled={photoIndex === 0} onclick={() => (chapter.photos = move(chapter.photos, photoIndex, -1))}><ArrowUp size={17} /></button>
                    <button class="icon-button" type="button" title="Foto nach hinten" aria-label="Foto nach hinten" disabled={photoIndex === chapter.photos.length - 1} onclick={() => (chapter.photos = move(chapter.photos, photoIndex, 1))}><ArrowDown size={17} /></button>
                    <button class="icon-button danger" type="button" title="Foto entfernen" aria-label="Foto entfernen" onclick={() => togglePhoto(chapter, photo.assetId)}><Trash2 size={17} /></button>
                  </div>
                </div>
              {/each}
            </div>
          </section>
        {/each}
        <button class="secondary-button add-chapter" type="button" disabled={draft.chapters.length >= 100} onclick={addChapter}><Plus size={18} />Kapitel hinzufügen</button>
      </div>
    {:else}
      <article class="report-preview">
        <header class="story-heading"><p class="story-album">{album.albumName}</p><h2>{draft.title || "Reisebericht"}</h2>{#if draft.introduction}<p class="story-text introduction">{draft.introduction}</p>{/if}</header>
        {#each draft.chapters as chapter (chapter.id)}
          <section class="story-chapter">
            {#if chapter.date}<time datetime={chapter.date}>{dateLabel(chapter.date)}</time>{/if}
            {#if chapter.title}<h3>{chapter.title}</h3>{/if}
            {#if chapter.text}<p class="story-text">{chapter.text}</p>{/if}
            {#if chapter.tourId}
              {@const tour = linkedTour(chapter.tourId)}
              {#if tour}
                <div class="story-tour">
                  <a href={`/?album=${encodeURIComponent(album.id)}&tour=${encodeURIComponent(chapter.tourId)}`} onclick={(event) => {
                    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey || event.button !== 0) return;
                    event.preventDefault();
                    if (chapter.tourId) void onOpenTour(chapter.tourId);
                  }}>{tour.title || dateLabel(tour.date) || "Tour ansehen"}</a>
                  <span>{tour.distanceKm !== null ? `${tour.distanceKm} km` : ""}{tour.elevationGainM !== null ? ` · ${tour.elevationGainM} Höhenmeter` : ""}</span>
                  {#if tour.hasKomootMap}<img src={tourResource(album.id, "/images/komoot-map", chapter.tourId)} alt="Karte der verknüpften Tour" loading="lazy" />{/if}
                </div>
              {/if}
            {/if}
            {#each chapter.photos as photo (photo.assetId)}
              <figure><img src={image(photo.assetId, true)} alt={photo.caption || chapter.title || "Reisefoto"} loading="lazy" />{#if photo.caption}<figcaption>{photo.caption}</figcaption>{/if}</figure>
            {/each}
          </section>
        {/each}
        {#if !draft.chapters.length}<p>Noch keine Kapitel vorhanden.</p>{/if}
      </article>
    {/if}
  {/if}
</section>

<style>
  .report-workspace { --report-accent: #378a5d; --report-line: #dce3db; --report-muted: #637168; padding: 20px 0 40px; }
  .report-toolbar, .chapter-toolbar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; }
  .report-toolbar { padding-bottom: 20px; border-bottom: 1px solid var(--report-line); margin-bottom: 24px; }
  h2, h3, h4, p { overflow-wrap: anywhere; letter-spacing: 0; }
  h2 { font-size: 24px; margin: 0 0 5px; }
  h3 { font-size: 18px; margin: 0; }
  h4 { font-size: 16px; margin: 0; }
  h4 span, .draft-state { color: var(--report-muted); font-size: 13px; }
  .report-actions, .chapter-actions, .photo-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 40px; padding: 8px 12px; border: 1px solid var(--report-line); border-radius: 6px; background: #fff; color: #263d2d; }
  button:disabled { opacity: .5; cursor: default; }
  button:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 2px solid var(--report-accent); outline-offset: 3px; }
  .icon-button { flex: 0 0 40px; width: 40px; height: 40px; padding: 8px; }
  .save-button { background: var(--report-accent); border-color: var(--report-accent); color: #fff; }
  .danger { color: #a44437; }
  .view-modes { display: flex; }
  .view-modes button { border-radius: 0; }
  .view-modes button:first-child { border-radius: 6px 0 0 6px; }
  .view-modes button:last-child { border-radius: 0 6px 6px 0; }
  .view-modes button[aria-pressed="true"] { background: #e7f0e9; border-color: #9db8a4; }
  .report-editor { max-width: 920px; margin: 0 auto; }
  label { display: grid; min-width: 0; gap: 7px; font-size: 14px; font-weight: 600; }
  input, textarea, select { width: 100%; min-width: 0; padding: 11px 12px; border: 1px solid var(--report-line); border-radius: 6px; background: #fff; color: #202a23; }
  textarea { resize: vertical; line-height: 1.65; font-weight: 400; }
  .report-intro, .chapter-editor { display: grid; gap: 18px; }
  .report-intro { margin-bottom: 32px; }
  .chapter-editor { padding: 24px 0; border-top: 1px solid var(--report-line); }
  .chapter-fields { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 16px; }
  .photo-picker { padding: 16px 0; border-block: 1px solid var(--report-line); }
  .photo-picker header { margin-bottom: 16px; }
  .photo-picker header label { flex: 1; }
  .photo-choices { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(130px, 100%), 1fr)); gap: 10px; }
  .photo-choice { position: relative; display: grid; grid-template-rows: auto 32px; min-width: 0; padding: 0; gap: 0; overflow: hidden; }
  .photo-choice img { width: 100%; aspect-ratio: 1; object-fit: cover; }
  .photo-choice[aria-pressed="true"] { outline: 2px solid var(--report-accent); outline-offset: 1px; }
  .photo-selection { position: absolute; top: 6px; right: 6px; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 4px; background: #fff; color: #256d43; }
  .filename { padding: 6px; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
  .photo-pagination { display: flex; align-items: center; justify-content: center; gap: 16px; margin-top: 18px; }
  .selected-photos { display: grid; gap: 14px; }
  .selected-photo { display: grid; grid-template-columns: 100px minmax(0, 1fr) auto; align-items: start; gap: 12px; padding: 14px 0; border-bottom: 1px solid var(--report-line); }
  .selected-photo > img { width: 100%; height: 100px; object-fit: contain; background: #edf1ec; border-radius: 4px; }
  .add-chapter { margin-top: 20px; }
  .report-error { color: #962e2e; background: #fff0ed; padding: 12px; border-radius: 6px; }
  .report-notice { color: #256d43; }
  .report-preview { max-width: 860px; margin: 0 auto; }
  .story-heading { border-bottom: 1px solid var(--report-line); padding-bottom: 28px; }
  .story-album { color: var(--report-muted); font-size: 14px; }
  .story-heading h2 { font-family: Georgia, serif; font-size: 32px; line-height: 1.2; }
  .story-text { white-space: pre-wrap; line-height: 1.85; font-size: 17px; }
  .introduction { font-size: 18px; }
  .story-chapter { padding-top: 36px; }
  .story-chapter h3 { font-family: Georgia, serif; font-size: 25px; line-height: 1.3; margin: 10px 0 18px; }
  time { color: var(--report-muted); font-size: 14px; }
  figure { margin: 28px 0; }
  figure img, .story-tour img { display: block; width: 100%; max-height: 750px; object-fit: contain; }
  figcaption { margin-top: 10px; text-align: center; color: var(--report-muted); font-size: 14px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .story-tour { display: grid; gap: 10px; padding: 16px 0; border-block: 1px solid var(--report-line); }
  .story-tour a { color: #256d43; font-weight: 600; overflow-wrap: anywhere; }
  .story-tour span { color: var(--report-muted); font-size: 14px; }
  @media (max-width: 600px) {
    .chapter-fields { grid-template-columns: minmax(0, 1fr); }
    .report-actions { width: 100%; }
    .selected-photo { grid-template-columns: 75px minmax(0, 1fr); }
    .selected-photo > img { height: 75px; }
    .photo-actions { grid-column: 2; }
    .story-heading h2 { font-size: 28px; }
  }
</style>