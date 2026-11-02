<script lang="ts">
  import { Share2, Copy, Link, X } from "@lucide/svelte";
  import { api, type ReportShare } from "./api.js";

  let { albumId }: { albumId: string } = $props();
  let shares = $state<ReportShare[]>([]);
  let label = $state("");
  let expires = $state("");
  let loading = $state(false);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");
  let newLink = $state("");
  let newShareId = $state("");
  let linkInput = $state<HTMLInputElement>();
  let loadRevision = 0;

  function message(reason: unknown) {
    return reason instanceof Error ? reason.message : "Freigabelinks konnten nicht geladen werden";
  }

  async function load() {
    const revision = ++loadRevision;
    loading = true;
    error = "";
    try {
      const result = await api.reportShares(albumId);
      if (revision === loadRevision) shares = result;
    } catch (reason) {
      if (revision === loadRevision) error = message(reason);
    } finally {
      if (revision === loadRevision) loading = false;
    }
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = "";
    notice = "";
    try {
      const result = await api.createReportShare(albumId, label, expires ? new Date(expires).toISOString() : null);
      const url = new URL("/", location.href);
      url.hash = new URLSearchParams({ share: result.token }).toString();
      newLink = url.toString();
      newShareId = result.share.id;
      label = "";
      expires = "";
      await load();
      notice = "Freigabelink erstellt.";
    } catch (reason) {
      error = message(reason);
    } finally {
      busy = false;
    }
  }

  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(newLink);
      notice = "Link kopiert.";
    } catch {
      linkInput?.focus();
      linkInput?.select();
      notice = "Link markiert.";
    }
  }

  async function revoke(share: ReportShare) {
    if (!confirm(`Freigabelink „${share.label}“ widerrufen?`)) return;
    busy = true;
    error = "";
    notice = "";
    try {
      await api.revokeReportShare(albumId, share.id);
      if (newShareId === share.id) { newLink = ""; newShareId = ""; }
      await load();
      notice = "Freigabelink widerrufen.";
    } catch (reason) {
      error = message(reason);
    } finally {
      busy = false;
    }
  }

  function timestamp(value: string) {
    return new Date(value).toLocaleString("de-DE", { dateStyle: "medium", timeStyle: "short" });
  }

  function status(share: ReportShare) {
    return share.revokedAt ? "Widerrufen" : share.expiresAt && Date.parse(share.expiresAt) <= Date.now() ? "Abgelaufen" : "Aktiv";
  }
</script>

<details class="sharing" ontoggle={(event) => { if (event.currentTarget.open) void load(); }}>
  <summary><Share2 size={17} />Teilen</summary>
  <section class="share-panel" aria-label="Freigabelinks">
    <h3>Freigabelinks</h3>
    <form onsubmit={create}>
      <label>Bezeichnung<input maxlength="100" bind:value={label} disabled={busy} /></label>
      <label>Ablaufzeit (optional)<input type="datetime-local" bind:value={expires} disabled={busy} /></label>
      <button type="submit" disabled={busy || loading}><Link size={17} />Link erstellen</button>
    </form>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if notice}<p class="notice" role="status">{notice}</p>{/if}
    {#if newLink}
      <div class="new-link">
        <label>Neuer Freigabelink<input bind:this={linkInput} readonly value={newLink} onclick={(event) => event.currentTarget.select()} /></label>
        <button type="button" title="Link kopieren" aria-label="Link kopieren" onclick={copy}><Copy size={18} /></button>
      </div>
    {/if}
    {#if loading}<p role="status">Freigabelinks werden geladen ...</p>{/if}
    {#if shares.length}
      <ul>
        {#each shares as share (share.id)}
          <li>
            <div class="share-info"><strong>{share.label}</strong><span>{status(share)} · Erstellt {timestamp(share.createdAt)}</span>{#if share.expiresAt}<span>Ablauf {timestamp(share.expiresAt)}</span>{/if}</div>
            <button type="button" title="Freigabelink widerrufen" aria-label={`Freigabelink ${share.label} widerrufen`} disabled={busy || !!share.revokedAt} onclick={() => revoke(share)}><X size={17} />Widerrufen</button>
          </li>
        {/each}
      </ul>
    {:else if !loading && !error}
      <p>Noch keine Freigabelinks vorhanden.</p>
    {/if}
  </section>
</details>

<style>
  .sharing { margin: 0 0 24px; border-bottom: 1px solid #dce3db; padding-bottom: 16px; }
  summary { display: flex; width: fit-content; align-items: center; gap: 7px; cursor: pointer; min-height: 40px; padding: 8px 12px; border: 1px solid #dce3db; border-radius: 6px; background: #fff; }
  h3 { margin: 20px 0 16px; font-size: 18px; letter-spacing: 0; }
  form { display: flex; align-items: end; flex-wrap: wrap; gap: 12px; }
  label { display: grid; flex: 1 1 190px; min-width: 0; gap: 7px; font-size: 14px; }
  input { width: 100%; min-width: 0; padding: 10px 12px; border: 1px solid #dce3db; border-radius: 6px; color: #202a23; background: #fff; }
  button { display: inline-flex; align-items: center; justify-content: center; gap: 7px; min-height: 40px; padding: 8px 12px; border: 1px solid #dce3db; border-radius: 6px; background: #fff; color: #27563a; }
  button:disabled { opacity: .5; cursor: default; }
  button:focus-visible, summary:focus-visible, input:focus-visible { outline: 2px solid #378a5d; outline-offset: 3px; }
  .new-link { display: flex; align-items: end; gap: 10px; margin: 20px 0; }
  .new-link button { flex: 0 0 42px; height: 42px; }
  ul { padding: 0; margin: 16px 0 0; list-style: none; }
  li { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 14px 0; border-top: 1px solid #dce3db; }
  .share-info { display: grid; flex: 1 1 190px; min-width: 0; gap: 5px; }
  .share-info strong { overflow-wrap: anywhere; }
  .share-info span { font-size: 13px; color: #637168; }
  .error { color: #962e2e; }
  .notice { color: #256d43; }
</style>