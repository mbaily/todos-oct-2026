<script>
  import { childTypes, content } from './lib/model.js';
  import FavouriteButton from './FavouriteButton.svelte';
  import PinButton from './PinButton.svelte';
  import LinkifiedText from './LinkifiedText.svelte';
  import ListTodoCount from './ListTodoCount.svelte';

  let { entity, save, navigate, todoCount = 0, pinned = false, onerror } = $props();
  const leaf = $derived(!childTypes[entity.type].length);
  const targetId = $derived(leaf ? entity.parentId : entity.id);
  const icon = $derived(entity.type === 'folder' ? '📁 ' : entity.type === 'list' ? '📋 ' : '');
  const label = $derived((entity.type === 'note' ? '📝 ' : entity.type === 'todo' ? (entity.checked ? '☑ ' : '☐ ') : '') + content(entity));
</script>

<div data-id={entity.id}>
  {#if pinned}<PinButton {entity} {save} {onerror} />{:else if entity.type !== 'list'}<FavouriteButton {entity} {save} {onerror} />{/if}
  {#if icon}{icon}{/if}<LinkifiedText text={label} linkUrls={leaf} navigationHref={`#entity/${targetId}`} onNavigate={() => navigate(targetId)} completed={entity.checked} /><ListTodoCount {entity} count={todoCount} />
  {#if !pinned && entity.type === 'list'}<FavouriteButton {entity} {save} {onerror} />{/if}
</div>
