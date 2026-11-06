<script lang="ts">
  import { api, type Album, type AuthUser } from "./api.js";

  let { album, onSaved }: { album: Album; onSaved: (visibility: Album["visibility"]) => void } = $props();
  let visibility = $state<"private" | "shared" | "public">("private");
  let users = $state<Array<Pick<AuthUser, "id" | "username">>>([]);
  let selectedUsers = $state<string[]>([]);
  let publicConfirmed = $state(false);
  let loading = $state(false);
  let saving = $state(false);
  let error = $state("");
  let notice = $state("");

  async function load() {
    loading = true;
    error = "";
    try {
      const [access, accounts] = await Promise.all([api.albumAccess(album.id), api.selectableUsers()]);
      visibility = access.visibility;
      selectedUsers = access.userIds;
      users = accounts.filter((user) => user.id !== album.ownerId);
      publicConfirmed = false;
    } catch (reason) {
      error = reason instanceof Error ? reason.message : "Albumfreigaben konnten nicht geladen werden";
    } finally {
      loading = false;
    }
  }

  async function save() {
    if (visibility === "public" && !publicConfirmed) {
      error = "Bitte bestätige zuerst, dass Albumfotos dadurch öffentlich werden können.";
      return;
    }
    if (visibility === "shared" && !selectedUsers.length) {
      error = "Wähle mindestens ein Konto für die Freigabe aus.";
      return;
    }
    saving = true;
    error = "";
    notice = "";
    try {
      await api.saveAlbumAccess(album.id, visibility, selectedUsers, publicConfirmed);
      onSaved(visibility);
      notice = "Albumfreigabe gespeichert.";
    } catch (reason) {
      error = reason instanceof Error ? reason.message : "Albumfreigabe konnte nicht gespeichert werden";
    } finally {
      saving = false;
    }
  }

  function toggleUser(id: string) {
    selectedUsers = selectedUsers.includes(id)
      ? selectedUsers.filter((selected) => selected !== id)
      : [...selectedUsers, id];
  }

</script>

<details class="album-access" ontoggle={(event) => { if (event.currentTarget.open) void load(); }}>
  <summary>Albumfreigabe</summary>
  <section aria-label="Albumzugriff">
    <h3>Zugriff auf {album.albumName}</h3>
    {#if loading}<p role="status">Freigaben werden geladen ...</p>{/if}
    <label>Sichtbarkeit
      <select bind:value={visibility} disabled={loading || saving}>
        <option value="private">Privat - nur ich</option>
        <option value="shared">Für ausgewählte Mapper-Konten</option>
        <option value="public">Öffentlich ohne Anmeldung</option>
      </select>
    </label>
    {#if visibility === "shared"}
      <fieldset disabled={loading || saving}>
        <legend>Lesefreigaben</legend>
        {#each users as user (user.id)}
          <label class="user"><input type="checkbox" checked={selectedUsers.includes(user.id)} onchange={() => toggleUser(user.id)} />{user.username}</label>
        {/each}
        {#if !users.length}<p>Es gibt keine weiteren lokalen Konten.</p>{/if}
      </fieldset>
    {/if}
    {#if visibility === "public"}
      <label class="warning"><input type="checkbox" bind:checked={publicConfirmed} disabled={saving} />Ich bestätige, dass Albumfotos aus Immich dadurch öffentlich über den Mapper zugänglich werden können. Immich-Berechtigungen werden nicht geändert.</label>
    {/if}
    {#if error}<p class="error" role="alert">{error}</p>{/if}
    {#if notice}<p class="notice" role="status">{notice}</p>{/if}
    <button type="button" disabled={loading || saving || visibility === "public" && !publicConfirmed || visibility === "shared" && !selectedUsers.length} onclick={save}>Freigabe speichern</button>
  </section>
</details>

<style>
  .album-access { position: relative; }
  summary { cursor: pointer; min-height: 36px; padding: 8px 12px; border: 1px solid #dce3db; border-radius: 6px; background: #fff; }
  section { position: absolute; z-index: 20; right: 0; top: calc(100% + 6px); width: min(390px, calc(100vw - 32px)); padding: 16px; border: 1px solid #dce3db; border-radius: 8px; background: #fff; box-shadow: 0 8px 28px #14261d24; }
  h3 { margin: 0 0 14px; font-size: 17px; }
  section > label { display: grid; gap: 7px; margin: 12px 0; }
  select { min-height: 38px; padding: 6px 9px; border: 1px solid #dce3db; border-radius: 5px; background: #fff; }
  fieldset { display: grid; gap: 8px; margin: 12px 0; padding: 10px; border: 1px solid #dce3db; }
  .user, .warning { display: flex; align-items: flex-start; gap: 8px; }
  .warning { margin: 12px 0; padding: 10px; background: #fff8df; font-size: 13px; }
  button { min-height: 38px; padding: 7px 12px; border: 0; border-radius: 5px; color: #fff; background: #27563a; }
  button:disabled { opacity: .5; }
  .error { color: #962e2e; }
  .notice { color: #256d43; }
</style>
