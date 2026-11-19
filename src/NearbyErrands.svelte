<script>
  import { savedLocations, nearbyPreferences, nearbyRows, radiusOptions } from './lib/locations.js';
  import { ROOT_VIEW_ID } from './lib/model.js';
  import EntityRow from './EntityRow.svelte';

  let { snapshot, completionTags, save, navigate, openLocations, registerEditor, flushEditors, todoCounts, dateDisplay, ondraft, onerror } = $props();
  let activePanelId = $state(null);
  let preferenceQueue = Promise.resolve();
  let panelVersion = 0;
  const preferences = $derived(nearbyPreferences(snapshot));
  const origins = $derived(savedLocations(snapshot).filter(location => location.userLocation));
  const rows = $derived(nearbyRows(snapshot));

  $effect(() => {
    if (activePanelId && !rows.some(row => row.entity.id === activePanelId)) { activePanelId = null; ++panelVersion; }
  });

  function changePreference(fields) {
    // Keep pills enabled without losing rapid clicks or saving choices out of order.
    preferenceQueue = preferenceQueue.then(async () => {
      await flushEditors();
      await save('nearby-settings', ROOT_VIEW_ID, fields, false);
    }).catch(onerror);
    return preferenceQueue;
  }

  async function activatePanel(id, toggle = false) {
    const version = ++panelVersion;
    const closing = toggle && activePanelId === id;
    if (activePanelId === id && !closing) return;
    await flushEditors();
    if (version !== panelVersion || !rows.some(row => row.entity.id === id)) return;
    activePanelId = closing ? null : id;
  }
</script>

<div id="nearby-errands">
  <div><button type="button" onclick={openLocations}>Edit locations</button></div>
  <div class="pill-row" role="group" aria-label="Current location">
    <span>Current location</span>
    {#each origins as location (location.id)}
      <button type="button" class="pill" aria-pressed={preferences.origin?.id === location.id} onclick={() => changePreference({ nearbyLocationId: location.id })}>{location.name}</button>
    {/each}
    {#if preferences.origin}<button type="button" onclick={() => changePreference({ nearbyLocationId: null })}>Clear location</button>{/if}
    {#if !origins.length}<span>No user locations. Add one in Edit locations.</span>{/if}
  </div>
  <div class="pill-row" role="group" aria-label="Distance filter">
    <span>Within</span>
    {#each radiusOptions as radius}
      <button type="button" class="pill" aria-pressed={preferences.radius === radius} onclick={() => changePreference({ nearbyRadius: radius })}>{radius === null ? 'No filter' : `${radius} km`}</button>
    {/each}
  </div>
  {#if !preferences.origin && preferences.radius !== null}<output>Select a current location to find nearby matches. #errand items are always shown.</output>{/if}
  {#each rows as row (row.entity.id)}
    <div class="nearby-row" data-nearby-id={row.entity.id}>
      <EntityRow entity={row.entity} {completionTags} searching={true} {save} {navigate} {registerEditor} todoCount={todoCounts.get(row.entity.id) ?? 0} {dateDisplay} panelOpen={activePanelId === row.entity.id} {activatePanel} {ondraft} {onerror} />
    </div>
  {:else}
    <output id="empty-nearby">No matching errands.</output>
  {/each}
</div>
