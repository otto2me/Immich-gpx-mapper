<script lang="ts">
  import { onMount } from "svelte";
  import { Save, Download, Archive, Upload, RefreshCw } from "@lucide/svelte";
  import { api, type AppSettings, type BackupInfo, type BackupStatus, type RestoreResult } from "./api.js";

  let { onSaved, onRestored, busy = $bindable(false) }: {
    onSaved: (settings: AppSettings) => void; onRestored: (result: RestoreResult) => void; busy?: boolean
  } = $props();
  let settings = $state<AppSettings>({ sharingEnabled: true, komootDefault: "embed", backupMode: "off", backupIntervalDays: 3, backupKeep: 10 });
  let status = $state<BackupStatus | null>(null);
  let items = $state<BackupInfo[]>([]);
  let loaded = $state(false);
  let loading = $state(true);
  let error = $state("");
  let backupError = $state("");
  let notice = $state("");
  let restoreFile = $state<File | null>(null);
  let restoreConfirmation = $state("");
  let restorePassphrase = $state("");

  function message(reason: unknown) { return reason instanceof Error ? reason.message : "Einstellungen konnten nicht geladen werden"; }
  function date(value: string) { return new Date(value).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" }); }
  function size(bytes: number) { return `${(bytes / 1024 / 1024).toLocaleString("de-DE", { maximumFractionDigits: 2 })} MB`; }

  async function refreshBackups() {
    try { const result = await api.backups(); items = result.items; status = result.status; backupError = ""; }
    catch (reason) { backupError = message(reason); }
  }

  async function load() {
    loading = true;
    error = "";
    try {
      const result = await api.settings();
      settings = result.settings;
      status = result.backup;
      loaded = true;
      await refreshBackups();
    } catch (reason) { error = message(reason); }
    finally { loading = false; }
  }

  onMount(() => {
    void load();
    const timer = setInterval(() => { if (!busy) void refreshBackups(); }, 15000);
    return () => clearInterval(timer);
  });

  async function save(event: SubmitEvent) {
    event.preventDefault();
    busy = true; error = ""; notice = "";
    try {
      const result = await api.saveSettings($state.snapshot(settings));
      settings = result.settings; status = result.backup;
      onSaved(result.settings);
      notice = "Einstellungen gespeichert.";
    } catch (reason) { error = message(reason); }
    finally { busy = false; }
  }

  async function createBackup() {
    busy = true; backupError = ""; notice = "";
    try { await api.createBackup(); await refreshBackups(); notice = "ZIP-Sicherung erstellt."; }
    catch (reason) { backupError = message(reason); }
    finally { busy = false; }
  }

  async function restore() {
    if (!restoreFile || restoreConfirmation !== "WIEDERHERSTELLEN") return;
    if (!confirm("Alle Mapper-Daten durch diese Sicherung ersetzen? Der aktuelle Stand wird vorher zusätzlich gesichert.")) return;
    busy = true; backupError = ""; notice = "";
    try { const result = await api.restoreBackup(restoreFile, restorePassphrase); onRestored(result); }
    catch (reason) { backupError = message(reason); }
    finally { busy = false; }
  }
</script>

<section class="settings-page" aria-label="Einstellungen">
  <h1>Einstellungen</h1>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  {#if loading}<p role="status">Einstellungen werden geladen ...</p>{/if}
  {#if loaded}
    <form onsubmit={save}>
      <fieldset disabled={busy || !!status?.operation}>
        <legend>Allgemein</legend>
        <label class="toggle"><input type="checkbox" bind:checked={settings.sharingEnabled} /><span>Teilen verfügbar</span></label>
        <label>Komoot-Karte und Höhenprofil standardmäßig anzeigen
          <select bind:value={settings.komootDefault}><option value="embed">Remote von Komoot</option><option value="local">Lokale Bilder</option></select>
        </label>
      </fieldset>
      <fieldset disabled={busy || !!status?.operation}>
        <legend>Automatische Sicherungen</legend>
        <label>Rhythmus<select bind:value={settings.backupMode}><option value="off">Aus</option><option value="interval">Alle paar Tage</option><option value="changes">Bei Änderungen</option><option value="both">Zeitplan und Änderungen</option></select></label>
        <div class="settings-row">
          <label>Intervall in Tagen<input type="number" min="1" max="365" required bind:value={settings.backupIntervalDays} disabled={settings.backupMode === "off" || settings.backupMode === "changes"} /></label>
          <label>Sicherungen behalten<input type="number" min="1" max="365" required bind:value={settings.backupKeep} /></label>
        </div>
        <p class="muted">Bei Änderungen wird nach 30 Sekunden ohne weitere Schreibvorgänge gesichert. Automatische Sicherungen laufen nur, solange der Container läuft.</p>
      </fieldset>
      <button class="primary" type="submit" disabled={busy || !!status?.operation || !settings.backupKeep || !settings.backupIntervalDays}><Save size={17} />Einstellungen speichern</button>
    </form>

    <section class="backup-section" aria-label="Datensicherungen">
      <header><h2>Datensicherungen</h2><div class="actions"><button class="icon-button" type="button" title="Sicherungen aktualisieren" aria-label="Sicherungen aktualisieren" disabled={busy} onclick={refreshBackups}><RefreshCw size={18} /></button><button type="button" disabled={busy || !!status?.operation} onclick={createBackup}><Archive size={17} />{busy ? "Bitte warten ..." : "Jetzt sichern"}</button></div></header>
      {#if status}
        <dl><dt>Sicherungsordner im Container</dt><dd>{status.directory}</dd><dt>Letzte Sicherung</dt><dd>{status.lastBackupAt ? date(status.lastBackupAt) : "Noch keine Sicherung"}</dd><dt>Status</dt><dd>{status.operation === "restore" ? "Wiederherstellung läuft" : status.operation === "backup" ? "Sicherung läuft" : status.dirty ? "Änderungen seit letzter Sicherung" : "Aktuell"}</dd></dl>
        {#if status.lastError}<p class="error" role="alert">Letzter Sicherungsfehler: {status.lastError}</p>{/if}
      {/if}
      <p class="muted">Der Ordner muss als beschreibbares NAS-Verzeichnis gemountet sein. Die Sicherungen enthalten Datenbank, Uploads, den Datenschlüssel und eine vorhandene Dateikonfiguration, aber keine Immich-Originalfotos oder Container-Umgebungsvariablen. Jede ZIP-Sicherung ist vollständig mit BACKUP_PASSPHRASE verschlüsselt.</p>
      {#if backupError}<p class="error" role="alert">{backupError}</p>{/if}
      {#if items.length}
        <ul class="backup-list">{#each items as item (item.name)}<li><div><strong>{item.kind === "safety" ? "Sicherheitskopie vor Import" : "Mapper-Sicherung"}</strong><span>{date(item.createdAt)} · {size(item.size)}</span><small>{item.name}</small></div><a href={`/api/backups/${encodeURIComponent(item.name)}`} title="ZIP herunterladen" aria-label={`Sicherung ${date(item.createdAt)} herunterladen`}><Download size={18} /></a></li>{/each}</ul>
      {:else}<p class="muted">Noch keine ZIP-Sicherungen vorhanden.</p>{/if}
    </section>

    <section class="restore-section" aria-label="Sicherung importieren">
      <h2>Sicherung importieren</h2>
      <p>Der Import ersetzt alle Mapper-Daten einschließlich Einstellungen, Uploads und Datenschlüssel. Vorher wird der aktuelle Stand zusätzlich gesichert. Alle Sitzungen werden danach abgemeldet. Die ZIP-Datei darf höchstens 1 GiB groß sein; entpackt sind bis zu 4 GiB zulässig.</p>
      <label>Mapper-ZIP auswählen<input type="file" accept=".zip,application/zip" disabled={busy || !!status?.operation} onchange={(event) => { restoreFile = event.currentTarget.files?.[0] ?? null; restoreConfirmation = ""; }} /></label>
      <label>Backup-Passphrase<input type="password" autocomplete="current-password" bind:value={restorePassphrase} disabled={busy || !!status?.operation} /></label>
      <label>Zur Bestätigung WIEDERHERSTELLEN eingeben<input autocomplete="off" bind:value={restoreConfirmation} disabled={busy || !!status?.operation} /></label>
      <button class="restore-button" type="button" disabled={busy || !!status?.operation || !restoreFile || restoreFile.size > 1024 * 1024 * 1024 || restoreConfirmation !== "WIEDERHERSTELLEN" || !restorePassphrase} onclick={restore}><Upload size={17} />Sicherung wiederherstellen</button>
    </section>
  {/if}
</section>

<style>
  .settings-page { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 30px; letter-spacing: 0; margin: 0 0 28px; }
  h2 { font-size: 21px; letter-spacing: 0; margin: 0; }
  form, fieldset { display: grid; gap: 18px; }
  fieldset { min-width: 0; border: 0; border-top: 1px solid #dce3db; margin: 0; padding: 22px 0; }
  legend { padding: 0 12px 0 0; font-size: 19px; font-weight: 650; }
  label { display: grid; gap: 8px; min-width: 0; font-size: 14px; }
  .toggle { display: flex; align-items: center; gap: 10px; min-height: 40px; }
  .toggle input { width: 18px; height: 18px; }
  input, select { width: 100%; min-width: 0; padding: 11px 12px; border: 1px solid #dce3db; border-radius: 6px; background: #fff; color: #202a23; }
  button, .backup-list a { display: inline-flex; gap: 7px; align-items: center; justify-content: center; min-height: 42px; padding: 9px 13px; border: 1px solid #dce3db; border-radius: 6px; background: #fff; color: #27563a; text-decoration: none; }
  button:disabled { opacity: .5; cursor: default; }
  button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid #378a5d; outline-offset: 3px; }
  .primary { justify-self: start; background: #378a5d; border-color: #378a5d; color: #fff; }
  .settings-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
  .backup-section, .restore-section { border-top: 1px solid #dce3db; padding-top: 26px; margin-top: 32px; }
  header, .actions { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  header { justify-content: space-between; }
  .icon-button { width: 42px; padding: 8px; }
  .muted, dl { color: #637168; font-size: 14px; line-height: 1.65; }
  dl { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 2fr); gap: 8px 18px; margin: 20px 0; }
  dd { margin: 0; overflow-wrap: anywhere; color: #202a23; }
  p { line-height: 1.7; overflow-wrap: anywhere; }
  .backup-list { list-style: none; padding: 0; margin: 20px 0 0; }
  .backup-list li { display: flex; align-items: center; gap: 12px; padding: 14px 0; border-top: 1px solid #dce3db; }
  .backup-list li > div { display: grid; gap: 5px; flex: 1; min-width: 0; }
  .backup-list span, .backup-list small { color: #637168; font-size: 13px; overflow-wrap: anywhere; }
  .backup-list a { flex: 0 0 42px; }
  .restore-section { display: grid; gap: 18px; }
  .restore-section p { margin: 0; }
  .restore-button { justify-self: start; color: #962e2e; border-color: #d7a7a0; }
  .error { color: #962e2e; background: #fff0ed; padding: 12px; border-radius: 6px; }
  .notice { color: #256d43; }
  @media (max-width: 600px) { .settings-row { grid-template-columns: minmax(0, 1fr); } dl { grid-template-columns: minmax(0, 1fr); gap: 4px; } dd { margin-bottom: 10px; } }
</style>