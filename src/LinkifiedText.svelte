<script>
  import { getContext } from 'svelte';
  import { parseViewerText } from './lib/links.js';

  let { text, navigationHref, navigationTitle, onNavigate, completed = false, linkUrls = true, prefix } = $props();
  const followHashtag = getContext('followHashtag');
  const parts = $derived(parseViewerText(text, linkUrls));
  const hasTags = $derived(parts.some(part => part.tag));
  const firstNavigationPart = $derived(parts.find(part => !part.tag && !part.url && part.text.trim()));

  function followItem(event) {
    event.preventDefault();
    onNavigate();
  }
</script>

{#if prefix && (!navigationHref || firstNavigationPart !== parts[0])}{@render prefix()}{/if}{#if navigationHref && !firstNavigationPart}<a
  href={navigationHref} title={navigationTitle} aria-label={`Open ${text}`} onclick={followItem}>↗</a>{' '}{/if}{#each parts as part}
  {#if part.url}
    <a class="text-url" class:completed-todo={completed} href={part.url} target="_blank" rel="noopener noreferrer">{part.text}</a>
  {:else if part.tag}
    <a class="text-hashtag" class:completed-todo={completed} href={`#tag/${encodeURIComponent(part.tag)}`} onclick={event => followHashtag(event, part.tag)}>{part.text}</a>
  {:else if navigationHref && (!hasTags || part.text.trim())}
    <a class:completed-todo={completed} href={navigationHref} title={navigationTitle}
      aria-label={hasTags && part === firstNavigationPart ? text : undefined} onclick={followItem}>{#if firstNavigationPart === parts[0] && part === firstNavigationPart}{@render prefix?.()}{/if}{part.text}</a>
  {:else}
    {part.text}
  {/if}
{/each}
