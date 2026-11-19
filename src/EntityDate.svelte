<script>
  import { dateDisplayOptions } from './lib/model.js';
  import { formatEntityDate } from './lib/dates.js';

  let { entity, mode = 'none' } = $props();
  const label = $derived(formatEntityDate(entity, mode));
  const field = $derived(dateDisplayOptions.find(option => option.value === mode)?.field);
</script>

{#if label}<time class="entity-date" datetime={entity[field]}>{label}</time>{' '}{/if}