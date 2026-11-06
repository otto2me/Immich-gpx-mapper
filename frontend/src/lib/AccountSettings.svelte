<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Account, type AdminAlbum, type AuthUser } from "./api.js";

  let { user, onImmichKeySaved }: { user: AuthUser; onImmichKeySaved: () => void } = $props();
  let keyConfigured = $state(false);
  let apiKey = $state("");
  let currentPassword = $state("");
  let newPassword = $state("");
  let accounts = $state<Account[]>([]);
  let albums = $state<AdminAlbum[]>([]);
  let albumOwners = $state<Record<string, string>>({});
  let accountPasswords = $state<Record<string, string>>({});
  let accountRoles = $state<Record<string, "admin" | "user">>({});
  let username = $state("");
  let accountPassword = $state("");
  let accountRole = $state<"admin" | "user">("user");
  let loading = $state(true);
  let busy = $state(false);
  let error = $state("");
  let notice = $state("");

  function message(reason: unknown) {
    return reason instanceof Error ? reason.message : "Kontoeinstellungen konnten nicht geladen werden";
  }

  async function load() {
    loading = true;
    error = "";
    try {
      const settings = await api.userSettings();
      keyConfigured = settings.immichApiKeyConfigured;
      if (user.role === "admin") {
        [accounts, albums] = await Promise.all([api.users(), api.adminAlbums()]);
        accountRoles = Object.fromEntries(accounts.map((account) => [account.id, account.role]));
        accountPasswords = {};
        albumOwners = Object.fromEntries(albums.map((album) => [album.id, album.ownerId]));
      }
    } catch (reason) {
      error = message(reason);
    } finally {
      loading = false;
    }
  }

  onMount(() => { void load(); });

  async function saveKey(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = "";
    notice = "";
    try {
      const result = await api.saveUserSettings({ immichApiKey: apiKey });
      keyConfigured = result.immichApiKeyConfigured;
      apiKey = "";
      onImmichKeySaved();
      notice = "Immich-API-Key gespeichert.";
    } catch (reason) {
      error = message(reason);
    } finally {
      busy = false;
    }
  }

  async function clearKey() {
    if (!confirm("Den gespeicherten Immich-API-Key entfernen?")) return;
    busy = true;
    error = "";
    try {
      const result = await api.saveUserSettings({ immichApiKey: "" });
      keyConfigured = result.immichApiKeyConfigured;
      onImmichKeySaved();
      notice = "Immich-API-Key entfernt.";
    } catch (reason) {
      error = message(reason);
    } finally {
      busy = false;
    }
  }

  async function changePassword(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = "";
    notice = "";
    try {
      await api.saveUserSettings({ currentPassword, newPassword });
      currentPassword = "";
      newPassword = "";
      notice = "Passwort geändert.";
    } catch (reason) {
      error = message(reason);
    } finally {
      busy = false;
    }
  }

  async function createAccount(event: SubmitEvent) {
    event.preventDefault();
    busy = true;
    error = "";
    notice = "";
    try {
      await api.createUser(username, accountPassword, accountRole);
      username = "";
      accountPassword = "";
      accountRole = "user";
      accounts = await api.users();
      accountRoles = Object.fromEntries(accounts.map((account) => [account.id, account.role]));
      notice = "Konto erstellt.";
    } catch (reason) {
      error = message(reason);
    } finally {
      busy = false;
    }
  }

  async function saveAccount(account: Account, password: string, role: "admin" | "user") {
    if (!password && account.role === role) return;
    busy = true;
    error = "";
    notice = "";
    try {
      await api.updateUser(account.id, { ...(password ? { password } : {}), ...(account.role !== role ? { role } : {}) });
      accounts = await api.users();
      accountRoles = Object.fromEntries(accounts.map((item) => [item.id, item.role]));
      accountPasswords[account.id] = "";
      notice = `Konto ${account.username} aktualisiert.`;
      if (account.id === user.id && account.role !== role) location.reload();
    } catch (reason) {
      error = message(reason);
    } finally {
      busy = false;
    }
  }

  async function deleteAccount(account: Account) {
    if (!confirm(`Konto „${account.username}“ löschen?`)) return;
    busy = true;
    error = "";
    notice = "";
    try {
      await api.deleteUser(account.id);
      accounts = await api.users();
      notice = `Konto ${account.username} gelöscht.`;
    } catch (reason) {
      error = message(reason);
    } finally {
      busy = false;
    }

    async function transferAlbum(album: AdminAlbum) {
      const newOwnerId = albumOwners[album.id];
      if (!newOwnerId || newOwnerId === album.ownerId) return;
      const newOwner = accounts.find((account) => account.id === newOwnerId);
      if (!confirm(`„${album.metadata.albumName ?? album.id}“ an ${newOwner?.username ?? "das ausgewählte Konto"} übertragen?\n\nDanach kann nur der neue Eigentümer das Album bearbeiten und dessen Immich-Key wird für Albumzugriffe verwendet.`)) return;
      busy = true;
      error = "";
      notice = "";
      try {
        await api.transferAlbum(album.id, newOwnerId);
        albums = await api.adminAlbums();
        albumOwners = Object.fromEntries(albums.map((item) => [item.id, item.ownerId]));
        onImmichKeySaved();
        notice = `Eigentum von „${album.metadata.albumName ?? album.id}“ übertragen.`;
      } catch (reason) {
        error = message(reason);
      } finally {
        busy = false;
      }
    }
  }
</script>

<section class="account-settings" aria-label="Kontoeinstellungen">
  <h1>Konto</h1>
  <p>Angemeldet als <strong>{user.username}</strong> ({user.role === "admin" ? "Administrator" : "Benutzer"})</p>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  {#if loading}<p role="status">Kontoeinstellungen werden geladen ...</p>{/if}

  <form onsubmit={saveKey}>
    <h2>Immich-Verbindung</h2>
    <div class="key-status" class:configured={keyConfigured} role="status" aria-live="polite">
      <strong>Persönlicher Immich-API-Key: {keyConfigured ? "Hinterlegt" : "Nicht hinterlegt"}</strong>
      <span>{keyConfigured
        ? "Der Key ist verschlüsselt im Mapper gespeichert und wird für Immich-Abfragen dieses Kontos verwendet."
        : "Ohne Key kann dieses Konto keine eigenen Immich-Alben laden."}</span>
    </div>
    <label>Persönlicher Immich-API-Key<input type="password" autocomplete="new-password" bind:value={apiKey} disabled={busy} /></label>
    <div class="actions"><button type="submit" disabled={busy || !apiKey}>Key speichern</button>{#if keyConfigured}<button type="button" class="quiet" disabled={busy} onclick={clearKey}>Key entfernen</button>{/if}</div>
  </form>

  <form onsubmit={changePassword}>
    <h2>Passwort ändern</h2>
    <label>Aktuelles Passwort<input type="password" autocomplete="current-password" bind:value={currentPassword} required disabled={busy} /></label>
    <label>Neues Passwort (mindestens 12 Zeichen)<input type="password" autocomplete="new-password" bind:value={newPassword} minlength="12" maxlength="1024" required disabled={busy} /></label>
    <button type="submit" disabled={busy || !currentPassword || newPassword.length < 12}>Passwort ändern</button>
  </form>

  {#if user.role === "admin"}
    <section class="accounts">
      <h2>Lokale Konten</h2>
      <form class="create-account" onsubmit={createAccount}>
        <label>Benutzername<input bind:value={username} pattern="[A-Za-z0-9._-]{1,50}" maxlength="50" required disabled={busy} /></label>
        <label>Startpasswort<input type="password" bind:value={accountPassword} minlength="12" maxlength="1024" required disabled={busy} /></label>
        <label>Rolle<select bind:value={accountRole} disabled={busy}><option value="user">Benutzer</option><option value="admin">Administrator</option></select></label>
        <button type="submit" disabled={busy || !username || accountPassword.length < 12}>Konto erstellen</button>
      </form>
      <ul>
        {#each accounts as account (account.id)}
          <li>
            <div><strong>{account.username}</strong><small>Erstellt {new Date(account.createdAt).toLocaleDateString("de-DE")}</small></div>
            <label>Rolle<select bind:value={accountRoles[account.id]} disabled={busy || account.id === user.id}><option value="user">Benutzer</option><option value="admin">Administrator</option></select></label>
            <label>Neues Passwort<input type="password" aria-label={`Neues Passwort für ${account.username}`} minlength="12" maxlength="1024" bind:value={accountPasswords[account.id]} disabled={busy} /></label>
            <button type="button" disabled={busy || !!accountPasswords[account.id] && accountPasswords[account.id].length < 12} onclick={() => saveAccount(account, accountPasswords[account.id] ?? "", accountRoles[account.id] ?? account.role)}>Änderungen speichern</button>
            {#if account.id !== user.id}<button type="button" class="quiet" disabled={busy} onclick={() => deleteAccount(account)}>Konto löschen</button>{/if}
          </li>
        {/each}
      </ul>
    </section>
    <section class="accounts album-ownership">
      <h2>Album-Eigentum übertragen</h2>
      <p class="muted">Nur Konten mit hinterlegtem Immich-Key können Eigentümer werden. Die Sichtbarkeit und vorhandenen Lesefreigaben bleiben erhalten.</p>
      {#if albums.length}
        <ul>
          {#each albums as album (album.id)}
            <li>
              <div><strong>{album.metadata.albumName ?? album.id}</strong><small>Aktuell: {album.ownerName} · {album.visibility}</small></div>
              <label>Neuer Eigentümer
                <select bind:value={albumOwners[album.id]} disabled={busy}>
                  {#each accounts.filter((account) => account.immichApiKeyConfigured || account.id === album.ownerId) as account (account.id)}
                    <option value={account.id}>{account.username}</option>
                  {/each}
                </select>
              </label>
              <button type="button" disabled={busy || !albumOwners[album.id] || albumOwners[album.id] === album.ownerId} onclick={() => transferAlbum(album)}>Eigentum übertragen</button>
            </li>
          {/each}
        </ul>
      {:else}
        <p>Es sind noch keine Mapper-Alben registriert.</p>
      {/if}
    </section>
  {/if}
</section>

<style>
  .account-settings { max-width: 860px; margin: 0 auto; display: grid; gap: 24px; }
  h1 { margin: 0; font-size: 30px; }
  .key-status { display: grid; gap: 4px; padding: 12px 14px; border: 1px solid #d5a548; border-radius: 6px; color: #704b0b; background: #fff8df; }
  .key-status.configured { border-color: #9ac9a7; color: #205a32; background: #edf8ef; }
  .key-status span { font-size: 14px; }
  h2 { margin: 0; font-size: 20px; }
  form, .accounts { display: grid; gap: 14px; padding: 22px 0; border-top: 1px solid #dce3db; }
  label { display: grid; min-width: 0; gap: 7px; font-size: 14px; }
  input, select { width: 100%; min-width: 0; padding: 10px 12px; border: 1px solid #dce3db; border-radius: 6px; background: #fff; }
  button { min-height: 40px; padding: 8px 12px; border: 1px solid #dce3db; border-radius: 6px; background: #fff; color: #27563a; }
  button:disabled { opacity: .5; }
  .actions { display: flex; gap: 10px; }
  .quiet { color: #637168; }
  small { color: #637168; font-size: 14px; }
  .accounts ul { display: grid; gap: 16px; list-style: none; padding: 0; }
  .accounts li { display: grid; grid-template-columns: minmax(100px, 1fr) repeat(3, minmax(140px, 1fr)); gap: 10px; align-items: end; padding: 14px; border: 1px solid #dce3db; border-radius: 7px; }
  .album-ownership li { grid-template-columns: minmax(150px, 1fr) minmax(180px, 1fr) auto; }
  .accounts li > div { display: grid; gap: 5px; align-self: center; }
  .error { color: #962e2e; background: #fff0ed; padding: 12px; border-radius: 6px; }
  .notice { color: #256d43; }
  @media (max-width: 760px) { .accounts li { grid-template-columns: minmax(0, 1fr); } }
</style>
