<script>
  import { circledTodoCount } from './lib/todo-counts.js';

  let { entity, count = 0 } = $props();
  const description = $derived(`${count} incomplete todo${count === 1 ? '' : 's'}`);
</script>

{#if entity?.type === 'list'}{' '}<span class="list-todo-count" role="img" aria-label={description} title={description}>{circledTodoCount(count)}</span>{/if}