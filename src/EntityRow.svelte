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
  let feedback = $state('');
  let editor = $state();
  let rowText = $state();
  let editButton = $state();
  let editQueue = Promise.resolve();
  let editVersion = 0;
  let pendingEdit;
  let undoGroup;
  let saveTimer;
  let pointerFocusing = false;

  const container = $derived(childTypes[entity.type].length > 0);
  const named = $derived(['notebook', 'folder', 'list'].includes(entity.type));
  const field = $derived(named ? 'name' : 'text');
  const icon = $derived(entity.type === 'folder' ? '📁 ' : entity.type === 'list' ? '📋 ' : entity.type === 'note' ? '📝 ' : '');
  const label = $derived(expanded && unsaved ? draft : content(entity));
  const linkOnlyTodo = $derived(entity.type === 'todo' && hasOnlyLinks(label));
  const timestamps = $derived(`Created: ${entity.createdAt}\nModified: ${entity.modifiedAt}`);
  const enter = acceptOnEnter(acceptEdit, edit);

  async function toggleEditor() {
    if (expanded) { await closeEditor(); return; }
    // A draft belongs to this editing session; sync never replaces it mid-typing.
    draft = entity[field];
    unsaved = false;
    feedback = '';
    undoGroup = {};
    expanded = true;
    await tick();
    editor?.focus();
  }

  async function closeEditor() {
    await flushEdit();
    expanded = false;
    editButton?.focus();
  }

  function flushEdit() {
    clearTimeout(saveTimer);
    const pending = pendingEdit;
    pendingEdit = undefined;
    if (!pending) return editQueue;
    const { id, patch, version, group } = pending;
    if (version === editVersion) feedback = 'Saving…';
    editQueue = editQueue.then(() => save('update', id, patch, true, group))
      .then(() => {
        if (version === editVersion) { feedback = 'Saved locally'; unsaved = false; }
      })
      .catch(problem => {
        if (version === editVersion) feedback = problem.message;
        onerror(problem);
      });
    return editQueue;
  }

  function edit(event) {
    const value = event.currentTarget.value;
    draft = value;
    unsaved = true;
    const version = ++editVersion;
    clearTimeout(saveTimer);
    pendingEdit = undefined;
    if (named && !value.trim()) { feedback = 'A name is required.'; return; }
    feedback = 'Waiting to save…';
    pendingEdit = { id: entity.id, patch: { [field]: value }, version, group: undoGroup };
    saveTimer = setTimeout(flushEdit, 2000);
  }

  function acceptEdit() {
    if (named && !draft.trim()) { feedback = 'A name is required.'; return; }
    closeEditor().catch(onerror);
  }

  function toggleChecked(event) {
    save('update', entity.id, { checked: event.currentTarget.checked }).catch(onerror);
  }

  function trash() {
    const name = expanded && unsaved && draft.trim() ? draft : content(entity);
    const count = entity.type === 'list' ? ` ${circledTodoCount(todoCount)}` : '';
    if (container && !window.confirm(`Move ${entity.type} "${name}"${count} and all its contents to trash?`)) return;
    clearTimeout(saveTimer);
    pendingEdit = undefined;
    const id = entity.id;
    editQueue.then(() => save('trash', id)).catch(onerror);
  }

  let pointerStartPos = null;

  function resetEditor() {
    clearTimeout(saveTimer);
    pendingEdit = undefined;
    ++editVersion;
    expanded = false;
    unsaved = false;
    feedback = '';
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
  onMount(() => registerEditor(flushEdit, resetEditor));
  // Searching or browser-history navigation may remove a row before its timer fires.
  onDestroy(() => { ondraft(entity.id, false); flushEdit(); });
</script>

{#snippet actions()}
  <FavouriteButton {entity} {save} {onerror} />
  <button type="button" class="icon-button" aria-label="Edit" title="Edit" bind:this={editButton} aria-expanded={expanded} aria-controls={`editor-${entity.id}`} onclick={toggleEditor}>✎</button>
  <button type="button" class="icon-button" aria-label="Delete" title="Delete" onclick={trash}>🗑︎</button>
  <PinButton {entity} {save} {onerror} />
  {#if searching && !container}
    <button type="button" onclick={() => navigate(entity.parentId)}>Open list</button>
  {/if}
{/snippet}

{#snippet editPanel()}
    <div id={`editor-${entity.id}`}>
      {#if named}
        <input class="entity-editor" size="60" bind:this={editor} value={draft} maxlength="100000" aria-label="Name" enterkeyhint="done"
          onkeydown={enter.onkeydown} onbeforeinput={enter.onbeforeinput} oninput={enter.oninput}
          onkeyup={enter.onkeyup} oncompositionstart={enter.oncompositionstart} oncompositionend={enter.oncompositionend} />
      {:else}
        <textarea class="entity-editor" cols="60" bind:this={editor} value={draft} maxlength="100000" aria-label={entity.type === 'todo' ? 'Todo text' : 'Note text'} enterkeyhint="done"
          onkeydown={enter.onkeydown} onbeforeinput={enter.onbeforeinput} oninput={enter.oninput}
          onkeyup={enter.onkeyup} oncompositionstart={enter.oncompositionstart} oncompositionend={enter.oncompositionend}></textarea>
      {/if}
      {#if editor && (!named || entity.type === 'list')}
        <HashtagSuggestions textbox={editor} anchor={rowText} value={draft} tags={completionTags} />
      {/if}
      <output aria-live="polite">{feedback}</output>
      <button type="button" class="icon-button" aria-label="Close" title="Close" onclick={closeEditor}>×</button>
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
    <span class="entity-text" class:completed-todo={entity.type === 'todo' && entity.checked} bind:this={rowText} title={timestamps}
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
