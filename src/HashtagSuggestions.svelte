<script>
  import { on } from 'svelte/events';
  import { hashtagAtCaret } from './lib/model.js';

  let { textbox, anchor, value, tags } = $props();
  let group = $state();
  let selection = $state(null);
  let composing = false;
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

  $effect(() => {
    const field = textbox;
    if (!field) return;
    const cleanup = ['input', 'click', 'keyup', 'select', 'selectionchange'].map(type => on(field, type, updateSelection));
    cleanup.push(
      on(field, 'blur', event => { if (!group?.contains(event.relatedTarget)) selection = null; }),
      on(field, 'compositionstart', () => { composing = true; selection = null; }),
      on(field, 'compositionend', event => { composing = false; updateSelection(event); }),
    );
    return () => cleanup.forEach(dispose => dispose());
  });

  $effect(() => {
    const popup = group;
    const field = textbox;
    if (!popup || !field) return;
    const anchorElement = anchor;
    const controls = popup.parentElement;
    const viewport = window.visualViewport;
    const gap = 4;

    function position() {
      const bounds = field.getBoundingClientRect();
      const panel = controls.getBoundingClientRect();
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const viewportRight = viewportLeft + (viewport?.width ?? document.documentElement.clientWidth);
      // Inline suggestions align with row text so checkboxes stay clickable.
      const anchorLeft = anchorElement?.getBoundingClientRect().left ?? bounds.left;
      const left = Math.max(bounds.left, anchorLeft, viewportLeft + gap);
      const width = viewportRight - left - gap;
      const below = viewportBottom - panel.bottom - 2 * gap;
      const above = panel.top - viewportTop - 2 * gap;
      const placeAbove = below < 44 && above > below;
      const space = placeAbove ? above : below;
      if (bounds.bottom <= viewportTop || bounds.top >= viewportBottom || width <= 0 || space <= 0) {
        popup.style.visibility = 'hidden';
        return;
      }
      popup.style.left = `${left}px`;
      popup.style.maxWidth = `${width}px`;
      popup.style.top = `${placeAbove ? panel.top - gap : panel.bottom + gap}px`;
      popup.style.transform = placeAbove ? 'translateY(-100%)' : '';
      popup.style.setProperty('--suggestion-space', `${space}px`);
      popup.style.visibility = 'visible';
    }

    position();
    const resize = new ResizeObserver(position);
    resize.observe(controls);
    resize.observe(document.body);
    const cleanup = [on(window, 'scroll', position, { passive: true }), on(window, 'resize', position)];
    if (viewport) cleanup.push(on(viewport, 'resize', position), on(viewport, 'scroll', position));
    return () => {
      resize.disconnect();
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
    onfocusout={event => { if (event.relatedTarget !== textbox && !group?.contains(event.relatedTarget)) selection = null; }}>
    <!-- Keep the caret focused and allow WebKit to dispatch a click after a tap. -->
    {#each matches as match (match.name)}
      <button type="button" class="pill" onmousedown={event => event.preventDefault()} onclick={() => complete(match.text)}>#{match.name}</button>
    {/each}
  </div>
{/if}
