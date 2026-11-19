<script>
  import { onMount, onDestroy, tick, untrack } from 'svelte';
  import { childTypes, content } from './lib/model.js';
  import { acceptOnEnter } from './lib/enter.js';
  import { circledTodoCount } from './lib/todo-counts.js';
  import FavouriteButton from './FavouriteButton.svelte';
  import PinButton from './PinButton.svelte';
  import EntityDate from './EntityDate.svelte';
  import HashtagSuggestions from './HashtagSuggestions.svelte';
  import LinkifiedText from './LinkifiedText.svelte';
  import ListTodoCount from './ListTodoCount.svelte';
  import { hasOnlyLinks } from './lib/links.js';

  let { entity, completionTags, searching, save, navigate, registerEditor, todoCount = 0, dateDisplay = 'none', panelOpen, activatePanel, ondraft, onerror } = $props();
  let expanded = $state(false);
  let draft = $state('');
  let unsaved = $state(false);
  let editError = $state('');
  let saving = $state(false);
  let editor = $state();
  let editButton = $state();
  let pendingSave;
  let pointerFocusing = false;

  const container = $derived(childTypes[entity.type].length > 0);
  const named = $derived(['notebook', 'folder', 'list'].includes(entity.type));
  const field = $derived(named ? 'name' : 'text');
  const icon = $derived(entity.type === 'folder' ? '📁 ' : entity.type === 'list' ? '📋 ' : entity.type === 'note' ? '📝 ' : '');
  const label = $derived(expanded && unsaved ? draft : content(entity));
  const linkOnlyTodo = $derived(entity.type === 'todo' && hasOnlyLinks(label));
  const timestamps = $derived(`Created: ${entity.createdAt}\nModified: ${entity.modifiedAt}`);
  const enter = acceptOnEnter(event => {
    if (draft !== event.currentTarget.value) {
      draft = event.currentTarget.value;
      unsaved = true;
    }
    saveEdit();
  }, event => {
    draft = event.currentTarget.value;
    unsaved = true;
    editError = '';
  });

  async function toggleEditor() {
    if (expanded) { closeEditor(); return; }
    // A draft belongs to this editing session; sync never replaces it mid-typing.
    draft = entity[field];
    unsaved = false;
    editError = '';
    expanded = true;
    await tick();
    editor?.focus();
  }

  async function closeEditor() {
    if (saving) return;
    resetEditor();
    await tick();
    editButton?.focus();
  }

  function saveEdit() {
    if (saving) return pendingSave;
    if (named && !draft.trim()) { editError = 'A name is required.'; return; }
    if (!unsaved || draft === entity[field]) { closeEditor(); return; }
    saving = true;
    pendingSave = save('update', entity.id, { [field]: draft })
      .finally(() => {
        saving = false;
        pendingSave = undefined;
      })
      .then(closeEditor)
      .catch(onerror);
    return pendingSave;
  }

  function toggleChecked(event) {
    save('update', entity.id, { checked: event.currentTarget.checked }).catch(onerror);
  }

  function trash() {
    const name = expanded && unsaved && draft.trim() ? draft : content(entity);
    const count = entity.type === 'list' ? ` ${circledTodoCount(todoCount)}` : '';
    if (container && !window.confirm(`Move ${entity.type} "${name}"${count} and all its contents to trash?`)) return;
    const id = entity.id;
    Promise.resolve(pendingSave).then(() => save('trash', id)).catch(onerror);
  }

  let pointerStartPos = null;

  function resetEditor() {
    expanded = false;
    unsaved = false;
    editError = '';
  }

  function focusActions(event) {
    if (!pointerFocusing && event.target === event.currentTarget) activatePanel(entity.id).catch(onerror);
  }

  function handlePointerDown(event) {
    if (event.button !== 0 || event.target.closest('a')) return;
    pointerFocusing = true;
    pointerStartPos = { x: event.clientX, y: event.clientY };
  }

  function handleClick(event) {
    if (event.button !== 0 || event.target.closest('a')) {
      pointerFocusing = false;
      pointerStartPos = null;
      return;
    }
    const start = pointerStartPos;
    pointerStartPos = null;
    const hasSelection = (window.getSelection()?.toString().trim().length ?? 0) > 0;
    const moved = start ? Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4 : false;
    setTimeout(() => { pointerFocusing = false; }, 0);
    if (hasSelection || moved) return;
    try { event.currentTarget.focus(); } catch { /* ignore */ }
    activatePanel(entity.id, true).catch(onerror);
  }

  $effect(() => {
    if (!named && !panelOpen) expanded = false;
  });

  $effect(() => {
    const id = entity.id;
    const pending = expanded && unsaved;
    untrack(() => ondraft(id, pending));
  });
  onMount(() => registerEditor(() => pendingSave, resetEditor));
  onDestroy(() => ondraft(entity.id, false));
</script>

{#snippet actions()}
  <FavouriteButton {entity} {save} {onerror} />
  <button type="button" class="icon-button" aria-label="Edit" title="Edit" bind:this={editButton} aria-expanded={expanded} aria-controls={`editor-${entity.id}`} disabled={saving} onclick={toggleEditor}>✎</button>
  <button type="button" class="icon-button" aria-label="Delete" title="Delete" onclick={trash}>🗑︎</button>
  <PinButton {entity} {save} {onerror} />
  {#if searching && !container}
    <button type="button" onclick={() => navigate(entity.parentId)}>Open list</button>
  {/if}
{/snippet}

{#snippet editPanel()}
    <div id={`editor-${entity.id}`}>
      <div class="edit-field">
        {#if named}
          <input class="entity-editor" size="60" bind:this={editor} value={draft} maxlength="100000" aria-label="Name" enterkeyhint="done" readonly={saving}
            onkeydown={enter.onkeydown} onbeforeinput={enter.onbeforeinput} oninput={enter.oninput}
            onkeyup={enter.onkeyup} oncompositionstart={enter.oncompositionstart} oncompositionend={enter.oncompositionend} />
        {:else}
          <textarea class="entity-editor" cols="60" bind:this={editor} value={draft} maxlength="100000" aria-label={entity.type === 'todo' ? 'Todo text' : 'Note text'} enterkeyhint="done" readonly={saving}
            onkeydown={enter.onkeydown} onbeforeinput={enter.onbeforeinput} oninput={enter.oninput}
            onkeyup={enter.onkeyup} oncompositionstart={enter.oncompositionstart} oncompositionend={enter.oncompositionend}></textarea>
        {/if}
        {#if editor && (!named || entity.type === 'list')}
          <HashtagSuggestions textbox={editor} value={draft} tags={completionTags} />
        {/if}
      </div>
      {#if editError}<span role="alert">{editError}</span>{/if}
      <button type="button" disabled={saving} onclick={saveEdit}>Save</button>
      <button type="button" class="icon-button" aria-label="Close" title="Discard edit" disabled={saving} onclick={closeEditor}>×</button>
    </div>
{/snippet}

<div data-id={entity.id} class:leaf-row={!container}>
  {#if entity.type === 'todo' || entity.type === 'list'}
    <input type="checkbox" checked={entity.checked} aria-label={`Complete ${content(entity)}`} onchange={toggleChecked} />
  {/if}
  {#if container}
    {#if icon}{icon}{/if}<LinkifiedText text={label} linkUrls={false} navigationHref={`#entity/${entity.id}`} navigationTitle={timestamps}
      onNavigate={() => navigate(entity.id)} completed={entity.type === 'list' && entity.checked}>
      {#snippet prefix()}<EntityDate {entity} mode={dateDisplay} />{/snippet}
    </LinkifiedText><ListTodoCount {entity} count={todoCount} />
    {@render actions()}
    {#if expanded}{@render editPanel()}{/if}
  {:else}
    <!-- The read-only group and embedded links have independent focus targets. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <span class="entity-text" class:completed-todo={entity.type === 'todo' && entity.checked} title={timestamps}
      tabindex="0" role="group" aria-label={entity.type === 'todo' ? 'Todo text' : 'Note text'} aria-controls={`actions-${entity.id}`}
      onfocus={focusActions} onpointerdown={handlePointerDown} onclick={handleClick}>{#if icon}<span class="entity-marker">{icon}</span>{/if}<EntityDate {entity} mode={dateDisplay} />{#if linkOnlyTodo}<span class="link-marker">🔗 </span>{/if}<LinkifiedText text={label} completed={entity.type === 'todo' && entity.checked} /></span>
    {#if panelOpen}
      <div id={`actions-${entity.id}`} class="entity-panel">
        <div role="toolbar" aria-label={entity.type === 'todo' ? 'Todo actions' : 'Note actions'}>{@render actions()}</div>
        {#if expanded}{@render editPanel()}{/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .edit-field {
    display: inline-block;
    max-inline-size: 100%;
    vertical-align: top;
  }
  .edit-field > .entity-editor { display: block; }
</style>
