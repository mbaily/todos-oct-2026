<script>
  import { on } from 'svelte/events';
  import { hashtagAtCaret } from './lib/model.js';

  let { textbox, value, tags } = $props();
  let group = $state();
  let selection = $state(null);
  let composing = false;
  let pointerDown = false;
  let completed;

  const token = $derived(selection?.value === value ? hashtagAtCaret(value, selection.caret) : null);
  const matches = $derived.by(() => {
    if (!token) return [];
    const available = textbox.maxLength - value.length + token.end - token.start;
    return tags.filter(name => name.startsWith(token.prefix))
      // The index lowercases İ to i plus a combining dot. Use a spelling the tag parser accepts.
      .map(name => ({ name, text: '#' + name.replaceAll('i\u0307', 'İ') }))
      .filter(match => match.text.length <= available);
  });

  function updateSelection(event) {
    const field = event.currentTarget;
    if (document.activeElement !== field) return;
    const { value, selectionStart: caret, selectionEnd } = field;
    if (completed && (completed.value !== value || completed.caret !== caret || caret !== selectionEnd)) completed = undefined;
    selection = !composing && caret === selectionEnd && !completed ? { value, caret } : null;
  }

  function dismissOnBlur(event) {
    if (!pointerDown && event.relatedTarget !== textbox && !group?.contains(event.relatedTarget)) selection = null;
  }

  $effect(() => {
    const field = textbox;
    if (!field) return;
    const cleanup = ['input', 'click', 'keyup', 'select', 'selectionchange'].map(type => on(field, type, updateSelection));
    cleanup.push(
      on(field, 'blur', dismissOnBlur),
      on(field, 'compositionstart', () => { composing = true; selection = null; }),
      on(field, 'compositionend', event => { composing = false; updateSelection(event); }),
    );
    return () => cleanup.forEach(dispose => dispose());
  });

  $effect(() => {
    if (!group) return;
    let timer;
    function finishPointer() {
      clearTimeout(timer);
      pointerDown = false;
      const focused = document.activeElement;
      if (focused !== textbox && !group?.contains(focused)) selection = null;
    }

    // Keep the rows in place until an outside press activates its target.
    const cleanup = [
      on(window, 'pointerdown', event => {
        clearTimeout(timer);
        pointerDown = event.isPrimary && event.button === 0;
      }, { capture: true }),
      on(window, 'pointerup', () => {
        // A drag may end without a click, while a touch click can be delayed.
        if (pointerDown) timer = setTimeout(finishPointer, 400);
      }),
      on(window, 'pointercancel', finishPointer),
      on(window, 'click', finishPointer),
    ];
    return () => {
      clearTimeout(timer);
      pointerDown = false;
      cleanup.forEach(dispose => dispose());
    };
  });

  function complete(text) {
    if (!token || textbox.value !== value) return;
    const length = value.length - (token.end - token.start) + text.length;
    const replacement = token.end === value.length && length < textbox.maxLength ? text + ' ' : text;
    textbox.setRangeText(replacement, token.start, token.end, 'end');
    completed = { value: textbox.value, caret: textbox.selectionStart };
    selection = null;
    textbox.focus({ preventScroll: true });
    textbox.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: replacement }));
  }
</script>

{#if matches.length}
  <div class="pill-row hashtag-suggestions" role="group" aria-label="Hashtag suggestions" bind:this={group}
    onfocusout={dismissOnBlur}>
    <!-- Keep the caret focused and allow WebKit to dispatch a click after a tap. -->
    {#each matches as match (match.name)}
      <button type="button" class="pill" onmousedown={event => event.preventDefault()} onclick={() => complete(match.text)}>#{match.name}</button>
    {/each}
  </div>
{/if}
