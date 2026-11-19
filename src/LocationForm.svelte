<script>
  import { untrack } from 'svelte';
  import { newId } from './lib/id.js';
  import { validateLocation, MAX_LOCATION_NAME_LENGTH } from './lib/locations.js';

  let { location = null, save, ondone, oncancel, onerror } = $props();
  let name = $state(untrack(() => location?.name ?? ''));
  let latitude = $state(untrack(() => location?.latitude ?? ''));
  let longitude = $state(untrack(() => location?.longitude ?? ''));
  let userLocation = $state(untrack(() => location?.userLocation ?? false));
  let saving = $state(false);

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    saving = true;
    try {
      const fields = { name, latitude, longitude, userLocation };
      validateLocation(fields);
      await save(location ? 'location-update' : 'location-create', location?.id ?? newId(), fields, false);
      ondone();
    } catch (problem) { onerror(problem); }
    finally { saving = false; }
  }
</script>

<form class="location-form" onsubmit={submit}>
  <div><label>Name <input class="entity-editor" size="60" bind:value={name} maxlength={MAX_LOCATION_NAME_LENGTH} required aria-label="Location name" placeholder="Woolworths Richmond #woolworths #supermarket" /></label></div>
  <div><label>Latitude <input type="number" step="any" min="-90" max="90" bind:value={latitude} required /></label>{' '}
    <label>Longitude <input type="number" step="any" min="-180" max="180" bind:value={longitude} required /></label></div>
  <div><label><input type="checkbox" bind:checked={userLocation} /> Available as current location</label></div>
  <button type="submit" disabled={saving}>{location ? 'Save location' : 'Add location'}</button>{' '}
  <button type="button" disabled={saving} onclick={oncancel}>Cancel</button>
</form>
