<script>
  import { savedLocations, previewLocationImport, exportLocations, locationCreationSource, MAX_IMPORT_BYTES } from './lib/locations.js';
  import { ROOT_VIEW_ID } from './lib/model.js';
  import LocationForm from './LocationForm.svelte';

  let { snapshot, save, onerror, onclearerror } = $props();
  let query = $state('');
  let filter = $state('all');
  let uiOnly = $state(false);
  let page = $state(0);
  let selectedId = $state(null);
  let editing = $state(false);
  let adding = $state(false);
  let busy = $state(false);
  let preview = $state.raw(null);
  let previewPage = $state(0);
  let importing = $state(false);
  let feedback = $state('');
  let fileInput = $state();
  let fileVersion = 0;
  const pageSize = 50;
  const locations = $derived(savedLocations(snapshot, filter === 'deleted')
    .filter(location => (!uiOnly || locationCreationSource(location) === 'ui')
      && (filter !== 'user' || location.userLocation) && location.name.toLowerCase().includes(query.toLowerCase().trim())));
  const pages = $derived(Math.max(1, Math.ceil(locations.length / pageSize)));
  const currentPage = $derived(Math.min(page, pages - 1));
  const visible = $derived(locations.slice(currentPage * pageSize, (currentPage + 1) * pageSize));
  const previewPages = $derived(Math.max(1, Math.ceil((preview?.rows.length ?? 0) / pageSize)));
  const previewCounts = $derived(preview ? {
    added: preview.rows.filter(row => row.status === 'Add').length,
    updated: preview.rows.filter(row => row.status === 'Update').length,
    unchanged: preview.rows.filter(row => row.status === 'Unchanged').length,
  } : null);

  function closePanel() { selectedId = null; editing = false; }
  function changeFilter() { page = 0; closePanel(); }
  function select(id) {
    selectedId = selectedId === id ? null : id;
    editing = false;
  }

  async function remove(location) {
    if (busy) return;
    busy = true;
    try { await save('location-trash', location.id, undefined, false); closePanel(); }
    catch (problem) { onerror(problem); }
    finally { busy = false; }
  }

  async function restore(location) {
    if (busy) return;
    busy = true;
    try { await save('location-restore', location.id, { trashOpId: location.trashedBy }, false); closePanel(); }
    catch (problem) { onerror(problem); }
    finally { busy = false; }
  }

  async function loadFile(event) {
    const version = ++fileVersion;
    onclearerror();
    preview = null;
    previewPage = 0;
    feedback = '';
    const file = event.currentTarget.files?.[0];
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error('Use a JSON file of at most 5 MiB.');
      const parsed = JSON.parse(await file.text());
      if (version !== fileVersion) return;
      preview = previewLocationImport(parsed, snapshot);
    } catch (problem) { if (version === fileVersion) onerror(problem); }
    finally { if (version === fileVersion && fileInput) fileInput.value = ''; }
  }

  async function applyImport() {
    if (!preview || importing) return;
    importing = true;
    try {
      await save('location-import', ROOT_VIEW_ID, preview.fields, false);
      feedback = `Imported ${previewCounts.added} additions and ${previewCounts.updated} updates. ${previewCounts.unchanged} unchanged.`;
      preview = null;
    } catch (problem) { onerror(problem); }
    finally { importing = false; }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([JSON.stringify(exportLocations(snapshot), null, 2) + '\n'], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'locations.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
</script>

<div id="locations-manager">
  <div>
    <button type="button" aria-expanded={adding} onclick={() => { adding = !adding; closePanel(); }}>＋ Add location</button>{' '}
    <button type="button" disabled={importing} onclick={() => fileInput?.click()}>Import JSON</button>{' '}
    <button type="button" onclick={download}>Export JSON</button>
    <input type="file" accept=".json,application/json" aria-label="Location JSON file" bind:this={fileInput} onchange={loadFile} hidden />
  </div>
  {#if adding}
    <LocationForm {save} {onerror} ondone={() => { adding = false; feedback = 'Location added.'; }} oncancel={() => adding = false} />
  {/if}
  {#if preview}
    <div id="location-import-preview" aria-label="Import preview">
      <p>{previewCounts.added} additions, {previewCounts.updated} updates, {previewCounts.unchanged} unchanged. Existing locations absent from this file will be kept.</p>
      <p>Updates replace the saved name, coordinates and current-location toggle. Applying an update can clear the selected current location if its toggle is turned off.</p>
      {#each preview.rows.slice(previewPage * pageSize, (previewPage + 1) * pageSize) as row (row.location.id)}
        <div class="import-preview-row">
          <span>{row.status}: {row.location.name} ({row.location.latitude}, {row.location.longitude}); current location: {row.location.userLocation ? 'yes' : 'no'}</span>
          {#if row.status === 'Update'}
            <details><summary>Previously saved</summary>{row.previous.name} ({row.previous.latitude}, {row.previous.longitude}); current location: {row.previous.userLocation ? 'yes' : 'no'}</details>
          {/if}
        </div>
      {/each}
      {#if previewPages > 1}
        <div>
          <button type="button" aria-label="Previous preview page" disabled={previewPage === 0} onclick={() => previewPage--}>←</button>
          <span>Page {previewPage + 1} of {previewPages}</span>
          <button type="button" aria-label="Next preview page" disabled={previewPage + 1 >= previewPages} onclick={() => previewPage++}>→</button>
        </div>
      {/if}
      <button type="button" disabled={importing || !(previewCounts.added + previewCounts.updated)} onclick={applyImport}>Apply import</button>{' '}
      <button type="button" disabled={importing} onclick={() => preview = null}>Cancel import</button>
    </div>
  {/if}
  <output aria-live="polite">{feedback}</output>
  <div>
    <label>Search locations <input type="search" bind:value={query} oninput={changeFilter} /></label>{' '}
    <label>Show <select aria-label="Location filter" bind:value={filter} onchange={changeFilter}>
      <option value="all">All locations</option><option value="user">User locations</option><option value="deleted">Deleted locations</option>
    </select></label>{' '}
    <label><input type="checkbox" bind:checked={uiOnly} onchange={changeFilter} /> Added via UI only</label>
  </div>
  <div><output>{locations.length} location{locations.length === 1 ? '' : 's'}</output></div>
  {#each visible as location (location.id)}
    <div data-location-id={location.id}>
      <button type="button" class="location-name" aria-expanded={selectedId === location.id} aria-controls={`location-actions-${location.id}`} onclick={() => select(location.id)}>{location.name}</button>
      {#if location.userLocation}<small> (user location)</small>{/if}
      {#if selectedId === location.id}
        <div id={`location-actions-${location.id}`} class="entity-panel">
          <div><small>{location.latitude}, {location.longitude}</small></div>
          {#if location.deletedAt}
            <button type="button" disabled={busy} onclick={() => restore(location)}>↥ Restore location</button>
          {:else}
            <div role="toolbar" aria-label="Location actions">
              <button type="button" class="icon-button" aria-label="Edit location" title="Edit location" aria-expanded={editing} onclick={() => editing = !editing}>✎</button>
              <button type="button" class="icon-button" aria-label="Delete location" title="Delete location" disabled={busy} onclick={() => remove(location)}>🗑︎</button>
            </div>
            {#if editing}
              <LocationForm {location} {save} {onerror} ondone={() => editing = false} oncancel={() => editing = false} />
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  {:else}
    <output>No {filter === 'deleted' ? 'deleted ' : ''}locations{query.trim() ? ' match your search' : ''}.</output>
  {/each}
  {#if pages > 1}
    <div>
      <button type="button" aria-label="Previous locations page" disabled={currentPage === 0} onclick={() => { page = currentPage - 1; closePanel(); }}>←</button>
      <span>Page {currentPage + 1} of {pages}</span>
      <button type="button" aria-label="Next locations page" disabled={currentPage + 1 >= pages} onclick={() => { page = currentPage + 1; closePanel(); }}>→</button>
    </div>
  {/if}
</div>
