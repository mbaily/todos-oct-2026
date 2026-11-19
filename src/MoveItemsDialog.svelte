<script>
  import { onMount, tick } from 'svelte';
  import { formatEntityDate, nextListName } from './lib/dates.js';
  import { listNameKey } from './lib/model.js';

  let { source, items, lists, onmove, onclose } = $props();
  let dialog;
  let nameInput;
  let name = $state('');
  let choice = $state('');
  let scope = $state('incomplete');
  let selected = $state.raw(new Set());
  let offset = $state(1);
  let pickingDate = $state(false);
  let pickedDate = $state('');
  let saving = $state(false);
  let error = $state('');

  const incomplete = $derived(items.filter(item => item.type === 'todo' && !item.checked));
  let moving = $derived(scope === 'all' ? items : scope === 'incomplete' ? incomplete : items.filter(item => selected.has(item.id)));
  const matches = $derived(lists.filter(list => listNameKey(list.name) === listNameKey(name)));
  const destinations = $derived(matches.filter(list => list.id !== source.id));
  const destination = $derived(destinations.length === 1 ? destinations[0] : destinations.find(list => list.id === choice));
  const canCreate = $derived(!!name.trim() && matches.length === 0);

  onMount(() => {
    name = nextListName(source.name);
    dialog.showModal();
    tick().then(() => nameInput?.select());
  });

  function chooseOffset(days) {
    offset = days;
    pickingDate = false;
    pickedDate = '';
    choice = '';
    name = nextListName(source.name, { days });
  }

  function chooseDate(event) {
    pickedDate = event.currentTarget.value;
    if (!pickedDate) return;
    offset = null;
    choice = '';
    name = nextListName(source.name, { pickedDate });
  }

  function changeName() {
    offset = null;
    choice = '';
  }

  function selectScope(next) {
    if (next === 'selected' && scope !== 'selected') selected = new Set(moving.map(item => item.id));
    scope = next;
  }

  function selectItem(id, checked) {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    selected = next;
  }

  async function submit(event) {
    event.preventDefault();
    if (saving || !moving.length || (!destination && !canCreate)) return;
    saving = true;
    error = '';
    try {
      await onmove(moving.map(item => item.id), destination, name.trim());
      dialog.close();
    } catch (problem) {
      error = problem.message ?? String(problem);
    } finally {
      saving = false;
    }
  }
</script>

<dialog bind:this={dialog} aria-labelledby="move-items-title" {onclose}
  oncancel={event => { if (saving) event.preventDefault(); }}>
  <form onsubmit={submit}>
    <h2 id="move-items-title">Move items to next day / list</h2>
    <fieldset disabled={saving}>
      <label for="destination-list">Destination list</label>
      <input id="destination-list" bind:this={nameInput} bind:value={name} oninput={changeName} maxlength="100000" required />
      <div class="pill-row" aria-label="Date shortcuts" role="group">
        {#each [1, 2, 3, 7] as day}
          <button type="button" class="pill" aria-pressed={offset === day} onclick={() => chooseOffset(day)}>+{day} {day === 1 ? 'day' : 'days'}</button>
        {/each}
        <button type="button" class="pill" aria-label="Pick a date" aria-expanded={pickingDate} onclick={() => pickingDate = !pickingDate}>📅</button>
      </div>
      {#if pickingDate}
        <label>Move date <input type="date" value={pickedDate} onchange={chooseDate} /></label>
      {/if}
      {#if destinations.length > 1}
        <label>Choose matching list
          <select bind:value={choice}>
            <option value="">Choose a list</option>
            {#each destinations as list (list.id)}
              <option value={list.id}>{list.name} · {formatEntityDate(list, 'created-time')}</option>
            {/each}
          </select>
        </label>
      {:else if name.trim() && !destination && !canCreate}
        <p>Choose a destination other than the source list.</p>
      {/if}
    </fieldset>
    <fieldset disabled={saving}>
      <legend>Items</legend>
      <div class="pill-row">
        <button type="button" class="pill" aria-pressed={scope === 'incomplete'} onclick={() => selectScope('incomplete')}>Incomplete ({incomplete.length})</button>
        <button type="button" class="pill" aria-pressed={scope === 'selected'} onclick={() => selectScope('selected')}>Selected ({moving.length})</button>
        <button type="button" class="pill" aria-pressed={scope === 'all'} onclick={() => selectScope('all')}>All ({items.length})</button>
      </div>
      {#if scope === 'selected'}
        <button type="button" disabled={!selected.size} onclick={() => selected = new Set()}>Clear selection</button>
        <div class="item-selection">
          {#each items as item (item.id)}
            <label>
              <input type="checkbox" checked={selected.has(item.id)} onchange={event => selectItem(item.id, event.currentTarget.checked)} />
              {#if item.type === 'note'}<span aria-hidden="true">📝</span>{/if}
              <span class:completed-todo={item.checked}>{item.text || (item.type === 'note' ? 'Empty note' : 'Empty todo')}</span>
            </label>
          {/each}
        </div>
      {/if}
    </fieldset>
    {#if error}<p role="alert">{error}</p>{/if}
    <div class="pill-row">
      <button type="submit" disabled={saving || !moving.length || (!destination && !canCreate)}>
        {canCreate ? 'Create list and move' : 'Move'} {moving.length} {moving.length === 1 ? 'item' : 'items'}
      </button>
      <button type="button" disabled={saving} onclick={() => dialog.close()}>Cancel</button>
    </div>
  </form>
</dialog>

<style>
  dialog {
    width: min(22rem, calc(100% - 2rem));
    max-height: calc(100% - 2rem);
    box-sizing: border-box;
    color: inherit;
    background: var(--page-background);
    border: 1px solid #777;
    padding: 0.75rem;
  }
  dialog::backdrop { background: #000a; }
  h2 { font-size: 1rem; margin: 0 0 0.5rem; }
  fieldset {
    display: grid;
    gap: 0.25rem;
    min-width: 0;
    margin: 0 0 0.5rem;
    padding: 0.35rem;
  }
  select { max-width: 100%; }
  fieldset p { margin: 0; }
  .item-selection {
    max-height: 12rem;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .item-selection label {
    display: flex;
    align-items: baseline;
    gap: 0.25rem;
    overflow-wrap: anywhere;
  }
  @media (pointer: coarse) {
    .pill-row button, .item-selection label { min-height: 32px; }
  }
</style>
