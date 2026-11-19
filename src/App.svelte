<script>
  import { onMount, setContext, tick } from 'svelte';
  import { childTypes, content, dateDisplayOptions, matchesSearch, ROOT_VIEW_ID, sortOptions, visibleEntities } from './lib/model.js';
  import { breadcrumbEntities, hashtagIndex, hashtagSortOptions, parseViewHash } from './lib/navigation.js';
  import { savedLocations } from './lib/locations.js';
  import { trashRows, trashSortOptions } from './lib/trash.js';
  import { incompleteTodoCounts } from './lib/todo-counts.js';
  import { recordUndo as appendUndo } from './lib/undo.js';
  import { mutate, readEntitySnapshot, readRootSortOrder, readRootDateDisplay, readSyncErrors, dismissSyncErrors } from './lib/db.js';
  import { newId } from './lib/id.js';
  import EntityRow from './EntityRow.svelte';
  import CreationForm from './CreationForm.svelte';
  import FavouriteRow from './FavouriteRow.svelte';
  import TrashRow from './TrashRow.svelte';
  import LinkifiedText from './LinkifiedText.svelte';
  import ListTodoCount from './ListTodoCount.svelte';
  import NearbyErrands from './NearbyErrands.svelte';
  import LocationsManager from './LocationsManager.svelte';
  import MoveItemsDialog from './MoveItemsDialog.svelte';
  import ServiceWorkerStatus from './ServiceWorkerStatus.svelte';

  const initialView = parseViewHash(location.hash);
  const initialHashtagSource = history.state?.hashtagSource;
  setContext('followHashtag', followHashtag);
  let snapshot = $state.raw([]);
  let currentId = $state(initialView.id);
  let pageKind = $state(initialView.kind);
  let currentTag = $state(initialView.tag);
  let search = $state(initialHashtagSource?.search ?? (initialView.tag ? `#${initialView.tag}` : ''));
  let hashtagSortOrder = $state('alphabetical');
  let hashtagBackId = $state(initialHashtagSource?.hashtagBackId ?? null);
  let trashSortOrder = $state(initialHashtagSource?.trashSortOrder ?? 'trashed-desc');
  let trashBackHash = $state(initialHashtagSource?.trashBackHash ?? '');
  let nearbyBackHash = $state(initialHashtagSource?.nearbyBackHash ?? '');
  let settingsBackHash = $state(initialHashtagSource?.settingsBackHash ?? '');
  let ready = $state(false);
  let resolvingInitialLink = $state(initialView.id !== null);
  let error = $state('');
  let syncStatus = $state('Connecting…');
  let serverReachable = $state();
  let syncErrors = $state.raw([]);
  let creationForm = $state();
  let rootSortOrder = $state('created-desc');
  let rootDateDisplay = $state('none');
  let settingDates = $state(false);
  let savingHashtagSettings = $state(false);
  let sorting = $state(false);
  let undoHistory = $state.raw([]);
  let undoing = $state(false);
  let pendingDrafts = $state.raw(new Set());
  let activePanelId = $state(null);
  let listActionsOpen = $state(false);
  let listActionsButton = $state();
  let listControlsButton = $state();
  let revealedListId = $state(null);
  let savingListLayout = $state(false);
  let moveSourceId = $state(null);
  let moveNotice = $state(null);
  let worker;
  let channel;
  let refreshVersion = 0;
  let initialSyncCompleted = false;
  let syncErrorsVersion = 0;
  let disposed = false;
  let panelVersion = 0;
  let panelContext = '';
  const editors = new Set();

  const entities = $derived(visibleEntities(snapshot));
  const todoCounts = $derived(incompleteTodoCounts(snapshot));
  const current = $derived(entities.find(entity => entity.id === currentId));
  const waitingForLinkedItem = $derived(resolvingInitialLink && currentId === initialView.id);
  const showingHashtags = $derived(pageKind === 'hashtags');
  const showingTrash = $derived(pageKind === 'trash');
  const showingNearby = $derived(pageKind === 'nearby');
  const showingLocations = $derived(pageKind === 'locations');
  const showingSettings = $derived(pageKind === 'settings');
  const specialView = $derived(showingHashtags || showingTrash || showingNearby || showingLocations || showingSettings);
  const inList = $derived(pageKind === 'entities' && current?.type === 'list');
  // Keep the stored layout flag and its rollover behavior for existing lists.
  const hideListControls = $derived(inList && current.controlsBelow === true);
  const controlsHidden = $derived(hideListControls && revealedListId !== currentId);
  const searching = $derived(!controlsHidden && search.trim().length > 0);
  const canMoveItems = $derived(inList && !searching);
  const moveLists = $derived(moveSourceId
    ? entities.filter(entity => entity.type === 'list' && entity.parentId === current?.parentId)
    : []);
  const contextKey = $derived(`${pageKind}:${currentId ?? 'root'}:${searching}`);
  const favourites = $derived(entities.filter(entity => entity.favourite)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)));
  const pinned = $derived(entities.filter(entity => entity.pinned)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)));
  const activeSort = $derived(showingTrash
    ? trashSortOptions.find(option => option.value === trashSortOrder) ?? trashSortOptions[0]
    : showingHashtags ? hashtagSortOptions.find(option => option.value === hashtagSortOrder) ?? hashtagSortOptions[0]
    : sortOptions.find(option => option.value === (currentId === null ? rootSortOrder : current?.sortOrder ?? 'created-desc')) ?? sortOptions[0]);
  const activeDateDisplay = $derived(dateDisplayOptions.find(option => option.value ===
    (currentId === null ? rootDateDisplay : current?.dateDisplay ?? 'none')) ?? dateDisplayOptions[0]);
  const tags = $derived(hashtagIndex(entities, hashtagSortOrder));
  const excludeLocationOnlyHashtags = $derived(snapshot.find(entity => entity.id === ROOT_VIEW_ID)?.excludeLocationOnlyHashtags === true);
  const completionTags = $derived.by(() => {
    const itemTags = tags.map(tag => tag.name);
    const locationTags = excludeLocationOnlyHashtags ? [] : savedLocations(snapshot).flatMap(location => location.tags ?? []);
    return [...new Set([...itemTags, ...locationTags])].sort((a, b) => a.localeCompare(b));
  });
  const trashed = $derived(trashRows(snapshot, trashSortOrder));
  const breadcrumbs = $derived.by(() => {
    if (showingSettings) return [{ label: 'Settings', kind: 'settings', id: null, href: '#settings' }];
    if (showingTrash) return [{ label: 'Trash', kind: 'trash', id: null, href: '#trash' }];
    if (showingNearby || showingLocations) {
      const path = [{ label: 'Nearby errands', kind: 'nearby', id: null, href: '#nearby' }];
      if (showingLocations) path.push({ label: 'Edit locations', kind: 'locations', id: null, href: '#locations' });
      return path;
    }
    const path = showingHashtags || pageKind === 'tag'
      ? [{ label: 'Hashtags', kind: 'hashtags', id: null, href: '#hashtags' }]
      : [{ label: 'Home', icon: '🏠', kind: 'entities', id: null, href: '#' }];
    if (!showingHashtags && pageKind !== 'tag') {
      for (const entity of breadcrumbEntities(entities, currentId)) {
        path.push({ label: content(entity), entity, kind: 'entities', id: entity.id, href: `#entity/${entity.id}` });
      }
    }
    if (searching) path.push({ label: pageKind === 'tag' ? search : `Search: ${search}`, kind: 'search', id: null, href: null });
    return path;
  });
  const items = $derived(entities
    .filter(entity => searching ? matchesSearch(entity, search) : entity.parentId === currentId)
    .sort((a, b) => activeSort.direction * (a[activeSort.field].localeCompare(b[activeSort.field]) || a.id.localeCompare(b.id))));

  $effect(() => {
    if (panelContext !== contextKey || (activePanelId && (specialView || !items.some(entity => entity.id === activePanelId)))) {
      panelContext = contextKey;
      ++panelVersion;
      activePanelId = null;
      listActionsOpen = false;
    }
  });

  $effect(() => {
    if (moveSourceId && (!canMoveItems || moveSourceId !== currentId)) moveSourceId = null;
    if (revealedListId !== null && (!hideListControls || revealedListId !== currentId)) revealedListId = null;
  });

  function toggleListControls() {
    revealedListId = controlsHidden ? currentId : null;
    listActionsOpen = false;
  }

  async function changeListLayout(event) {
    const checkbox = event.currentTarget;
    const listId = currentId;
    savingListLayout = true;
    try {
      await save('list-layout', listId, { controlsBelow: checkbox.checked }, false);
      if (listId === currentId) {
        revealedListId = null;
        listActionsOpen = false;
        await tick();
        (controlsHidden ? listControlsButton : listActionsButton)?.focus();
      }
    } catch (problem) {
      checkbox.checked = hideListControls;
      showError(problem);
    } finally { savingListLayout = false; }
  }

  async function openMoveItems() {
    const sourceId = currentId;
    listActionsOpen = false;
    try {
      await flushEditors();
      if (canMoveItems && currentId === sourceId) moveSourceId = sourceId;
    } catch (problem) { showError(problem); }
  }

  async function closeMoveItems() {
    moveSourceId = null;
    await tick();
    listActionsButton?.focus();
  }

  async function moveItems(itemIds, destination, name) {
    const sourceId = moveSourceId;
    const destinationId = destination?.id ?? newId();
    const { opId } = await save('move-items', sourceId, {
      destinationId, itemIds, copyLayout: true, ...(destination ? {} : { newListName: name }),
    });
    if (!syncErrors.some(failure => failure.id === opId)) {
      moveNotice = { sourceId, destinationId, name: destination?.name ?? name, count: itemIds.length, opId };
    }
  }

  function openMoveDestination() {
    const { destinationId } = moveNotice;
    moveNotice = null;
    return navigate(destinationId);
  }

  async function activatePanel(id, toggle = false) {
    const version = ++panelVersion;
    const closing = toggle && activePanelId === id;
    if (activePanelId === id && !closing) return;
    await flushEditors();
    if (version !== panelVersion || specialView || !items.some(entity => entity.id === id)) return;
    activePanelId = closing ? null : id;
  }

  function showError(problem) {
    error = problem.message ?? String(problem);
  }

  async function refresh() {
    const version = ++refreshVersion;
    const [all, rootOrder, rootDates] = await Promise.all([readEntitySnapshot(), readRootSortOrder(), readRootDateDisplay()]);
    if (disposed || version !== refreshVersion) return;
    snapshot = all;
    rootSortOrder = rootOrder;
    rootDateDisplay = rootDates;
    ready = true;
    const selectedContainer = current && childTypes[current.type]?.length;
    if (resolvingInitialLink && (initialSyncCompleted || (currentId === initialView.id && selectedContainer))) {
      resolvingInitialLink = false;
    }
    if (currentId && !selectedContainer && !waitingForLinkedItem) navigate(null);
  }

  async function save(action, id, fields, recordUndo = true, undoGroup = null) {
    const result = await mutate(action, id, fields);
    if (recordUndo && !syncErrors.some(failure => failure.id === result.inverse?.opId)) {
      undoHistory = appendUndo(undoHistory, result.inverse, undoGroup);
    }
    error = '';
    channel?.postMessage({ type: 'mutation' });
    await refresh();
    return result;
  }

  async function toggleSort() {
    if (sorting) return;
    if (showingTrash) {
      trashSortOrder = trashSortOptions[(trashSortOptions.indexOf(activeSort) + 1) % trashSortOptions.length].value;
      return;
    }
    if (showingHashtags) {
      hashtagSortOrder = hashtagSortOptions[(hashtagSortOptions.indexOf(activeSort) + 1) % hashtagSortOptions.length].value;
      return;
    }
    const id = currentId ?? ROOT_VIEW_ID;
    const next = sortOptions[(sortOptions.indexOf(activeSort) + 1) % sortOptions.length];
    sorting = true;
    try { await save('sort', id, { sortOrder: next.value }); }
    catch (problem) { showError(problem); }
    finally { sorting = false; }
  }

  function registerEditor(flush, reset) {
    const editor = { flush, reset };
    editors.add(editor);
    return () => editors.delete(editor);
  }

  async function toggleDateDisplay() {
    if (settingDates) return;
    const id = currentId ?? ROOT_VIEW_ID;
    const next = dateDisplayOptions[(dateDisplayOptions.indexOf(activeDateDisplay) + 1) % dateDisplayOptions.length];
    settingDates = true;
    try { await save('date-display', id, { dateDisplay: next.value }, false); }
    catch (problem) { showError(problem); }
    finally { settingDates = false; }
  }

  async function saveHashtagSettings(event) {
    const checkbox = event.currentTarget;
    savingHashtagSettings = true;
    try {
      await save('hashtag-completion-settings', ROOT_VIEW_ID, { excludeLocationOnlyHashtags: checkbox.checked }, false);
    } catch (problem) {
      checkbox.checked = excludeLocationOnlyHashtags;
      showError(problem);
    } finally { savingHashtagSettings = false; }
  }

  function draftChanged(id, pending) {
    const next = new Set(pendingDrafts);
    if (pending) next.add(id); else next.delete(id);
    pendingDrafts = next;
  }

  async function flushEditors() {
    await Promise.all([...editors].map(editor => editor.flush()));
  }

  async function undo() {
    if (undoing) return;
    undoing = true;
    try {
      const hadDraft = pendingDrafts.size > 0;
      const previousUndo = undoHistory.at(-1);
      await flushEditors();
      // Invalid or unchanged drafts can be discarded without undoing an older edit.
      const entry = undoHistory.at(-1);
      if (!(hadDraft && entry === previousUndo) && entry) {
        const { action, id, fields } = entry;
        await save(action, id, fields, false);
        if (action === 'move-items' && moveNotice?.destinationId === id && moveNotice.sourceId === fields.destinationId) {
          moveNotice = null;
        }
        // A concurrent save must not be discarded along with the undone step.
        undoHistory = undoHistory.filter(item => item !== entry);
      }
      for (const editor of editors) editor.reset();
      await tick();
      creationForm?.focusInput();
    } catch (problem) { showError(problem); }
    finally { undoing = false; }
  }

  async function navigate(id) {
    try {
      await flushEditors();
      search = '';
      pageKind = 'entities';
      currentTag = null;
      // Svelte replaces the keyed page and its parent-bound forms together.
      currentId = id;
      location.hash = id ? `entity/${id}` : '';
      await tick();
      creationForm?.focusInput();
    } catch (problem) { showError(problem); }
  }

  async function openHashtags() {
    try {
      await flushEditors();
      if (pageKind === 'entities') hashtagBackId = currentId;
      pageKind = 'hashtags';
      currentId = null;
      currentTag = null;
      search = '';
      hashtagSortOrder = 'alphabetical';
      location.hash = 'hashtags';
    } catch (problem) { showError(problem); }
  }

  function followHashtag(event, tag) {
    if (event.button !== 0 || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    event.preventDefault();
    return openHashtag(tag, true);
  }

  async function openHashtag(tag, rememberBack = false) {
    try {
      await flushEditors();
      const hash = `#tag/${encodeURIComponent(tag)}`;
      if (rememberBack && (pageKind !== 'tag' || currentTag !== tag)) {
        // Keep the previous view with its history entry, including for Back after a reload.
        history.replaceState({ ...history.state, hashtagSource: {
          search, hashtagBackId, trashSortOrder, trashBackHash, nearbyBackHash, settingsBackHash,
          scrollX: window.scrollX, scrollY: window.scrollY,
        } }, '');
        history.pushState({ hashtagBack: true }, '', hash);
      } else if (!rememberBack) location.hash = hash;
      pageKind = 'tag';
      currentId = null;
      currentTag = tag;
      search = `#${tag}`;
      await tick();
      creationForm?.focusInput();
    } catch (problem) { showError(problem); }
  }

  function backFromHashtag() {
    if (history.state?.hashtagBack) history.back();
    else return openHashtags();
  }

  async function openTrash(rememberBack = true) {
    try {
      await flushEditors();
      if (rememberBack !== false && !showingTrash) trashBackHash = location.hash;
      pageKind = 'trash';
      currentId = null;
      currentTag = null;
      search = '';
      trashSortOrder = 'trashed-desc';
      location.hash = 'trash';
    } catch (problem) { showError(problem); }
  }

  async function openNearby(rememberBack = true) {
    try {
      await flushEditors();
      if (rememberBack !== false && !showingNearby && !showingLocations) nearbyBackHash = location.hash;
      pageKind = 'nearby';
      currentId = null;
      currentTag = null;
      search = '';
      location.hash = 'nearby';
    } catch (problem) { showError(problem); }
  }

  async function openLocations() {
    try {
      await flushEditors();
      pageKind = 'locations';
      currentId = null;
      currentTag = null;
      search = '';
      location.hash = 'locations';
    } catch (problem) { showError(problem); }
  }

  async function openSettings() {
    try {
      await flushEditors();
      pageKind = 'settings';
      currentId = null;
      currentTag = null;
      search = '';
      location.hash = 'settings';
    } catch (problem) { showError(problem); }
  }

  function openPreviousHash(hash) {
    const previous = parseViewHash(hash);
    if (previous.kind === 'nearby') return openNearby(false);
    if (previous.kind === 'locations') return openLocations();
    if (previous.kind === 'trash') return openTrash(false);
    if (previous.kind === 'settings') return openSettings();
    if (previous.kind === 'hashtags') return openHashtags();
    if (previous.kind === 'tag') return openHashtag(previous.tag);
    return navigate(entities.some(entity => entity.id === previous.id) ? previous.id : null);
  }

  function backFromTrash() {
    return openPreviousHash(trashBackHash);
  }

  async function restoreEntity(entity) {
    await save('restore', entity.id, { trashOpId: entity.trashedBy }, false);
    // A manual restore must not leave an undo pointing at an already restored item.
    undoHistory = undoHistory.filter(entry => entry.action !== 'restore' || !entities.some(item => item.id === entry.id));
  }

  function clearSearch() {
    search = '';
    if (pageKind === 'tag') {
      pageKind = 'entities';
      currentTag = null;
      location.hash = '';
    }
  }

  async function hashChanged() {
    const hash = location.hash;
    const next = parseViewHash(hash);
    if (next.id !== currentId || next.kind !== pageKind || next.tag !== currentTag) {
      await flushEditors();
      if (location.hash !== hash) return;
      const source = history.state?.hashtagSource;
      const previousHash = pageKind === 'entities' ? currentId ? `#entity/${currentId}` : ''
        : pageKind === 'tag' ? `#tag/${encodeURIComponent(currentTag)}` : `#${pageKind}`;
      if (next.kind === 'settings') settingsBackHash = previousHash;
      if (next.kind === 'nearby' && !showingNearby && !showingLocations && !showingTrash) nearbyBackHash = previousHash;
      if (next.kind === 'trash') {
        trashBackHash = previousHash;
        trashSortOrder = 'trashed-desc';
      }
      if (next.kind === 'hashtags') {
        if (pageKind === 'entities') hashtagBackId = currentId;
        hashtagSortOrder = 'alphabetical';
      }
      if (source) {
        hashtagBackId = source.hashtagBackId;
        trashSortOrder = source.trashSortOrder;
        trashBackHash = source.trashBackHash;
        nearbyBackHash = source.nearbyBackHash;
        settingsBackHash = source.settingsBackHash;
      }
      pageKind = next.kind;
      currentId = next.id;
      currentTag = next.tag;
      search = source?.search ?? (next.tag ? `#${next.tag}` : '');
      await tick();
      if (!specialView) creationForm?.focusInput();
      if (source) window.scrollTo(source.scrollX, source.scrollY);
    }
  }

  function sync() {
    worker?.postMessage({ type: 'sync' });
  }

  async function syncNow() {
    try { await flushEditors(); sync(); }
    catch (problem) { showError(problem); }
  }

  function focusChanged() {
    sync();
    refresh().catch(showError);
  }

  async function loadSyncErrors() {
    const version = ++syncErrorsVersion;
    const failures = await readSyncErrors();
    if (disposed || version !== syncErrorsVersion) return;
    syncErrors = failures;
    if (failures.length) {
      const rejected = new Set(failures.map(failure => failure.id));
      undoHistory = undoHistory.filter(entry => !rejected.has(entry.opId));
      if (moveNotice && rejected.has(moveNotice.opId)) moveNotice = null;
    }
  }

  async function dismissErrors() {
    try {
      await dismissSyncErrors(syncErrors.map(error => error.id));
      channel?.postMessage({ type: 'sync-errors-changed' });
      await loadSyncErrors();
    }
    catch (problem) { showError(problem); }
  }

  onMount(() => {
    channel = new BroadcastChannel('plain-todos');
    worker = new Worker(new URL('./lib/sync-worker.js', import.meta.url), { type: 'module' });
    channel.onmessage = event => {
      if (['mutation', 'changed'].includes(event.data.type)) refresh().catch(showError);
      if (event.data.type === 'sync-errors-changed') loadSyncErrors().catch(showError);
    };
    worker.onmessage = event => {
      if (event.data.type === 'changed') refresh().catch(showError);
      if (event.data.type === 'connectivity') serverReachable = event.data.reachable;
      if (event.data.type === 'status') {
        syncStatus = event.data.message;
        if (!initialSyncCompleted && syncStatus === 'Synced') {
          initialSyncCompleted = true;
          if (resolvingInitialLink) refresh().catch(showError);
        }
      }
      if (event.data.type === 'sync-errors-changed') loadSyncErrors().catch(showError);
    };
    worker.onerror = () => showError(new Error('Background sync could not start. Reload to retry; local changes remain saved.'));
    refresh().catch(showError);
    loadSyncErrors().catch(showError);
    return () => {
      disposed = true;
      ++refreshVersion;
      worker.terminate();
      channel.close();
    };
  });
</script>

<svelte:window onhashchange={hashChanged} ononline={sync} onfocus={focusChanged} />

<nav id="pinned" aria-label="Pinned items" hidden={controlsHidden || !ready || !pinned.length}>
  {#each pinned as entity (entity.id)}
    <FavouriteRow {entity} {save} {navigate} pinned={true} todoCount={todoCounts.get(entity.id) ?? 0} onerror={showError} />
  {/each}
</nav>
<nav id="favourites" aria-label="Favourites" hidden={controlsHidden || !ready || !favourites.length}>
  {#each favourites as entity (entity.id)}
    <FavouriteRow {entity} {save} {navigate} todoCount={todoCounts.get(entity.id) ?? 0} onerror={showError} />
  {/each}
</nav>
<nav id="breadcrumbs" aria-label="Breadcrumbs" hidden={controlsHidden || !ready}>
  <ServiceWorkerStatus {serverReachable} />
  <button type="button" class="icon-button" aria-label="Trash" title="View trash" onclick={openTrash}>🗑︎</button>{' '}
  <button type="button" class="icon-button" aria-label="All hashtags" title="All hashtags" onclick={openHashtags}>#</button>{' '}
  <button type="button" class="icon-button" aria-label="Nearby errands" title="Nearby errands" onclick={openNearby}>🚗</button>{' '}
  {#each breadcrumbs as crumb, index}
    {#snippet crumbLabel()}
      {#if crumb.icon}<span role="img" aria-label={crumb.label}>{crumb.icon}</span>{:else if crumb.entity}<LinkifiedText text={crumb.label} linkUrls={false} />{:else}{crumb.label}{/if}
    {/snippet}
    {#if index > 0}<span aria-hidden="true">{' › '}</span>{/if}
    {#if index === breadcrumbs.length - 1 && !waitingForLinkedItem}
      <span aria-current="page">{@render crumbLabel()}<ListTodoCount entity={crumb.entity} count={todoCounts.get(crumb.id) ?? 0} /></span>
    {:else if crumb.entity}
      <LinkifiedText text={crumb.label} linkUrls={false} navigationHref={crumb.href} onNavigate={() => navigate(crumb.id)} /><ListTodoCount entity={crumb.entity} count={todoCounts.get(crumb.id) ?? 0} />
    {:else}
      <a href={crumb.href} onclick={event => { event.preventDefault(); crumb.kind === 'hashtags' ? openHashtags() : crumb.kind === 'nearby' ? openNearby() : navigate(crumb.id); }}>{@render crumbLabel()}</a><ListTodoCount entity={crumb.entity} count={todoCounts.get(crumb.id) ?? 0} />
    {/if}
  {/each}
</nav>
<div id="controls" hidden={!ready || specialView || waitingForLinkedItem}>
  <div id="creation">
    {#if ready && !specialView && (currentId === null || current)}
      {#key currentId}
        <CreationForm bind:this={creationForm} parent={current} {completionTags} {save} onerror={showError}>
          {#snippet controlsToggle()}
            {#if hideListControls}
              <button type="button" class="icon-button list-controls-toggle" bind:this={listControlsButton}
                aria-label={controlsHidden ? 'Show controls' : 'Hide controls temporarily'}
                title={controlsHidden ? 'Show controls' : 'Hide controls temporarily'}
                aria-expanded={!controlsHidden} aria-controls="navigation" onclick={toggleListControls}>
                {controlsHidden ? '⋯' : '×'}
              </button>
            {/if}
          {/snippet}
        </CreationForm>
      {/key}
    {/if}
  </div>
  <div hidden={controlsHidden}>
    <label>Search <input id="search" type="search" autocomplete="off" placeholder="Text or #hashtag" bind:value={search} oninput={event => { if (pageKind === 'tag' && !event.currentTarget.value.trim()) clearSearch(); }}></label>
    <button id="clear-search" type="button" onclick={clearSearch}>Clear search</button>
  </div>
  <div hidden={controlsHidden}>
    <button id="sync" type="button" hidden onclick={syncNow}>Sync now</button>
    <output id="sync-status" aria-live="polite" hidden>{syncStatus}</output>
  </div>
</div>
<div id="navigation" hidden={controlsHidden || !ready || waitingForLinkedItem}>
  {#if showingSettings}
    <button type="button" class="icon-button" aria-label="Back" title="Back" onclick={() => openPreviousHash(settingsBackHash)}>←</button>
  {:else if showingLocations}
    <button type="button" class="icon-button" aria-label="Back" title="Back" onclick={openNearby}>←</button>
  {:else if showingNearby}
    <button type="button" class="icon-button" aria-label="Back" title="Back" onclick={() => openPreviousHash(nearbyBackHash)}>←</button>
  {:else if showingTrash}
    <button type="button" class="icon-button" aria-label="Back" title="Back" onclick={backFromTrash}>←</button>
  {:else if showingHashtags}
    <button type="button" class="icon-button" aria-label="Back" title="Back" onclick={() => navigate(hashtagBackId)}>←</button>
  {:else if pageKind === 'tag'}
    <button type="button" class="icon-button" aria-label="Back" title="Back" onclick={backFromHashtag}>←</button>
  {:else if searching}
    <button type="button" class="icon-button" aria-label="Back" title="Back" onclick={() => navigate(currentId)}>←</button>
  {:else if current}
    <button type="button" class="icon-button" aria-label="Back" title="Back" onclick={() => navigate(current.parentId)}>←</button>
  {:else}
    <button type="button" class="icon-button" aria-label="Back" title="Back" disabled>←</button>
  {/if}
  {#if !showingNearby && !showingLocations && !showingSettings}
    <button type="button" id="sort-order" title="Change sort order" tabindex="-1" disabled={!ready || sorting} onclick={toggleSort}>{activeSort.label}</button>
  {/if}
  {#if !specialView || showingNearby}
    <button type="button" class="icon-button" aria-label="Undo" title={`Undo last ${undoHistory.at(-1)?.action === 'move-items' ? 'move' : 'edit or delete'} (${undoHistory.length} saved step${undoHistory.length === 1 ? '' : 's'} available)`} disabled={undoing || (!undoHistory.length && !pendingDrafts.size)} onclick={undo}>↶</button>
  {/if}
  {#if inList}
    {#key current.id}
      <details class="list-actions" bind:open={listActionsOpen}>
        <summary aria-label="List actions" title="List actions" bind:this={listActionsButton}>⋯</summary>
        <div class="list-actions-panel">
          <button type="button" onclick={openMoveItems} disabled={!canMoveItems || !items.length}>Move items to next day / list</button>
          <label>
            <input type="checkbox" checked={hideListControls} disabled={savingListLayout} onchange={changeListLayout} />
            Hide controls
          </label>
        </div>
      </details>
    {/key}
  {/if}
  {#if !showingLocations && !showingSettings}<button type="button" id="date-display" title="Change date display" tabindex="-1" disabled={!ready || settingDates} onclick={toggleDateDisplay}>{activeDateDisplay.label}</button>{/if}
</div>
<main id="contents" aria-label={showingTrash ? 'Trash' : showingHashtags ? 'Hashtags' : showingNearby ? 'Nearby errands' : showingLocations ? 'Edit locations' : showingSettings ? 'Settings' : 'Items'} hidden={!ready}>
  {#if !controlsHidden && canMoveItems && moveNotice?.sourceId === currentId && entities.some(entity => entity.id === moveNotice.destinationId)}
    <aside class="pill-row">
      <output>Moved {moveNotice.count} {moveNotice.count === 1 ? 'item' : 'items'} to “{moveNotice.name}”.</output>
      <button type="button" onclick={openMoveDestination}>Open list</button>
      <button type="button" class="icon-button" aria-label="Dismiss move confirmation" onclick={() => moveNotice = null}>×</button>
    </aside>
  {/if}
  {#if waitingForLinkedItem}
    <p role="status">Waiting to sync the linked item…</p>
  {:else if showingSettings}
    <fieldset>
      <legend>Hashtag completion</legend>
      <label>
        <input type="checkbox" checked={excludeLocationOnlyHashtags} disabled={savingHashtagSettings} onchange={saveHashtagSettings}>
        Exclude hashtags used only in Locations
      </label>
    </fieldset>
  {:else if showingNearby}
    <NearbyErrands {snapshot} {completionTags} {save} {navigate} {openLocations} {registerEditor} {flushEditors} {todoCounts} dateDisplay={activeDateDisplay.value} ondraft={draftChanged} onerror={showError} />
  {:else if showingLocations}
    <LocationsManager {snapshot} {save} onerror={showError} onclearerror={() => error = ''} />
  {:else if showingTrash}
    {#each trashed as row (row.entity.id)}
      <TrashRow {row} {todoCounts} dateDisplay={activeDateDisplay.value} restore={restoreEntity} onerror={showError} />
    {:else}
      <output id="empty-trash">Trash is empty.</output>
    {/each}
  {:else if showingHashtags}
    {#each tags as tag (tag.name)}
      <div data-tag={tag.name}>
        <a href={`#tag/${encodeURIComponent(tag.name)}`} title={`Earliest item created: ${tag.createdAt}\nLatest item modified: ${tag.modifiedAt}`} onclick={event => followHashtag(event, tag.name)}>#{tag.name}</a>
      </div>
    {:else}
      <output id="empty-hashtags">No hashtags.</output>
    {/each}
  {:else}
    {#key contextKey}
      {#each items as entity (entity.id)}
        <EntityRow {entity} {completionTags} {searching} {save} {navigate} {registerEditor} todoCount={todoCounts.get(entity.id) ?? 0} dateDisplay={activeDateDisplay.value} panelOpen={activePanelId === entity.id} {activatePanel} ondraft={draftChanged} onerror={showError} />
      {/each}
    {/key}
  {/if}
</main>
{#if canMoveItems && moveSourceId === currentId}
  <MoveItemsDialog source={current} {items} lists={moveLists} onmove={moveItems} onclose={closeMoveItems} />
{/if}
<div id="sync-errors" role="alert" hidden={!syncErrors.length}>
  <span id="sync-error-text">{syncErrors.length ? `Some changes could not be accepted: ${syncErrors.map(error => error.message).join(' ')}` : ''}</span>
  <button id="dismiss-errors" type="button" onclick={dismissErrors}>Dismiss</button>
</div>
<div id="error" role="alert" hidden={!error}>{error}</div>

<style>
  #navigation { position: relative; }
  .list-actions { display: inline-block; position: relative; vertical-align: middle; }
  .list-actions summary {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    line-height: 1;
    cursor: pointer;
    list-style: none;
  }
  .list-actions summary::-webkit-details-marker { display: none; }
  .list-actions-panel {
    position: absolute;
    inset-block-start: 100%;
    inset-inline-start: 0;
    z-index: 2;
    display: grid;
    width: max-content;
    max-width: calc(100vw - 1rem);
    background: var(--page-background);
    border: 1px solid #555;
  }
  .list-actions-panel button, .list-actions-panel label {
    padding: 0.35rem;
    font-size: 0.7rem;
  }
  .list-actions-panel label { display: flex; align-items: center; gap: 0.25rem; cursor: pointer; }
  @media (max-width: 640px) {
    .list-actions { position: static; }
    .list-actions-panel {
      box-sizing: border-box;
      inset-inline-start: 0.25rem;
      max-width: calc(100% - 0.5rem);
    }
  }
  @media (pointer: coarse) {
    .list-actions summary, .list-controls-toggle { width: 48px; height: 48px; font-size: 1.5rem; }
  }
</style>
