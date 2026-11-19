<script>
  import { content } from './lib/model.js';
  import LinkifiedText from './LinkifiedText.svelte';
  import EntityDate from './EntityDate.svelte';
  import ListTodoCount from './ListTodoCount.svelte';
  import { circledTodoCount } from './lib/todo-counts.js';

  let { row, restore, todoCounts = new Map(), dateDisplay = 'none', onerror } = $props();
  let restoring = $state(false);
  const entity = $derived(row.entity);
  const icon = $derived(entity.type === 'notebook' ? '📓 ' : entity.type === 'folder' ? '📁 ' : entity.type === 'list' ? '📋 ' : entity.type === 'note' ? '📝 ' : entity.checked ? '☑ ' : '☐ ');
  const label = $derived(content(entity));
  const reason = $derived(row.restoreParent?.type === 'list'
    ? `${row.reason} ${circledTodoCount(todoCounts.get(row.restoreParent.id) ?? 0)}` : row.reason);

  async function restoreItem() {
    if (restoring || row.reason) return;
    restoring = true;
    try { await restore(entity); }
    catch (problem) { onerror(problem); }
    finally { restoring = false; }
  }
</script>

<div data-id={entity.id} data-type={entity.type}>
  <button type="button" class="icon-button" aria-label="Restore" title={reason || 'Restore this item and children deleted with it'} disabled={restoring || Boolean(row.reason)} onclick={restoreItem}>↥</button>
  <span class:completed-todo={entity.type === 'todo' && entity.checked} title={`Created: ${entity.createdAt}\nModified: ${entity.modifiedAt}\nTrashed: ${entity.deletedAt}`}>
    {icon}<EntityDate {entity} mode={dateDisplay} />
    <LinkifiedText text={label} linkUrls={entity.type === 'todo' || entity.type === 'note'} completed={entity.type === 'todo' && entity.checked} /><ListTodoCount {entity} count={todoCounts.get(entity.id) ?? 0} />
  </span>
  <small class="trash-location">({entity.type}; Notebooks{#each row.locationEntities as parent}{' › '}<LinkifiedText text={content(parent)} linkUrls={false} /><ListTodoCount entity={parent} count={todoCounts.get(parent.id) ?? 0} />{/each})</small>
  {#if row.reason}<output class="restore-reason">{#if row.restoreParent}Restore parent first: <LinkifiedText text={content(row.restoreParent)} linkUrls={false} /><ListTodoCount entity={row.restoreParent} count={todoCounts.get(row.restoreParent.id) ?? 0} />{:else}{row.reason}{/if}</output>{/if}
</div>
