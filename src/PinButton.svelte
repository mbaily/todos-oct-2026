<script>
  let { entity, save, onerror } = $props();
  let saving = $state(false);

  async function toggle() {
    if (saving) return;
    saving = true;
    try { await save('update', entity.id, { pinned: !entity.pinned }, false); }
    catch (problem) { onerror(problem); }
    finally { saving = false; }
  }
</script>

<button type="button" class="icon-button pin-button" aria-label="Pin" aria-pressed={entity.pinned ?? false} title={entity.pinned ? 'Unpin this item' : 'Pin this item'} disabled={saving} onclick={toggle}>📌</button>
