<script>
  let { entity, save, onerror } = $props();
  let saving = $state(false);

  async function toggle() {
    if (saving) return;
    saving = true;
    try { await save('update', entity.id, { favourite: !entity.favourite }); }
    catch (problem) { onerror(problem); }
    finally { saving = false; }
  }
</script>

<button type="button" class="icon-button" aria-label="Favourite" aria-pressed={entity.favourite ?? false} title={entity.favourite ? 'Remove from favourites' : 'Add to favourites'} disabled={saving} onclick={toggle}>{entity.favourite ? '★' : '☆'}</button>
