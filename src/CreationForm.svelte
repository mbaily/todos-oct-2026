<script>
  import { onMount, tick, untrack } from 'svelte';
  import { childTypes } from './lib/model.js';
  import { newId } from './lib/id.js';
  import { formatListDate } from './lib/dates.js';
  import { acceptOnEnter } from './lib/enter.js';
  import HashtagSuggestions from './HashtagSuggestions.svelte';

  let { parent, completionTags, save, onerror } = $props();
  const allowed = $derived(childTypes[parent?.type ?? 'root']);
  let type = $state(untrack(() => parent?.type === 'list' ? 'todo' : childTypes[parent?.type ?? 'root'][0]));
  let value = $state('');
  let saving = $state(false);
  let input = $state();
  const named = $derived(['notebook', 'folder', 'list'].includes(type));
  const fieldLabel = $derived(parent ? 'New item' : 'New notebook');

  export function focusInput() {
    // Touch users open the keyboard by choosing an input, not by navigating.
    if (window.matchMedia('(pointer: coarse)').matches) return;
    input?.focus();
  }

  onMount(() => {
    // Initial IndexedDB loading can finish after the user starts searching.
    if (document.activeElement?.id !== 'search') focusInput();
  });

  const enter = acceptOnEnter(event => {
    // The native binding can run before the fallback's delegated input handler.
    value = event.currentTarget.value;
    event.currentTarget.form.requestSubmit();
  });

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    if (!value.trim()) { input?.focus(); return; }
    saving = true;
    try {
      await save('create', newId(), {
        type, parentId: parent?.id ?? null, [named ? 'name' : 'text']: value,
      });
      value = '';
      await tick();
      input?.focus();
    } catch (problem) { onerror(problem); }
    finally { saving = false; }
  }

  async function addDatedList() {
    if (saving || parent?.type !== 'folder') return;
    const name = formatListDate(new Date());
    saving = true;
    try {
      await save('create', newId(), {
        type: 'list', parentId: parent.id, name,
      });
      await tick();
      focusInput();
    } catch (problem) { onerror(problem); }
    finally { saving = false; }
  }
</script>

<form onsubmit={submit}>
  {#if parent?.type === 'list'}
    <span role="radiogroup" aria-label="New item type">
      <label title="Todo">
        <input type="radio" name="new-item-type" value="todo" bind:group={type} aria-label="Todo" />
        <span aria-hidden="true">☐</span>
      </label>
      <label title="Note">
        <input type="radio" name="new-item-type" value="note" bind:group={type} aria-label="Note" />
        <span aria-hidden="true">📝</span>
      </label>
    </span>
  {:else if parent && allowed.length > 1}
    <span role="radiogroup" aria-label="New item type">
      {#each allowed as name}
        <label title={name === 'folder' ? 'Folder' : 'List'}>
          <input type="radio" name="new-item-type" value={name} bind:group={type} aria-label={name === 'folder' ? 'Folder' : 'List'} />
          <span aria-hidden="true">{name === 'folder' ? '📁' : '📋'}</span>
        </label>
      {/each}
    </span>
  {/if}
  <label>
    {#if !parent}{fieldLabel}{/if}
    {#if named}
      <input bind:this={input} bind:value maxlength="100000" required aria-label={fieldLabel} enterkeyhint="done"
        onkeydown={enter.onkeydown} onbeforeinput={enter.onbeforeinput} oninput={enter.oninput}
        onkeyup={enter.onkeyup} oncompositionstart={enter.oncompositionstart} oncompositionend={enter.oncompositionend} />
    {:else}
      <textarea bind:this={input} bind:value maxlength="100000" required aria-label={fieldLabel} enterkeyhint="done"
        onkeydown={enter.onkeydown} onbeforeinput={enter.onbeforeinput} oninput={enter.oninput}
        onkeyup={enter.onkeyup} oncompositionstart={enter.oncompositionstart} oncompositionend={enter.oncompositionend}></textarea>
    {/if}
  </label>
  {#if input && (!named || type === 'list')}
    <HashtagSuggestions textbox={input} {value} tags={completionTags} />
  {/if}
  <button type="submit" class="icon-button" aria-label="Add" title="Add" tabindex="-1" disabled={saving}>＋</button>
  {#if parent?.type === 'folder'}
    <button type="button" class="icon-button" aria-label="Add today's list" title="Add today's list" disabled={saving} onclick={addDatedList}>📅</button>
  {/if}
</form>
