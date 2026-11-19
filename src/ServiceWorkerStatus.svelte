<script>
  import { onMount } from 'svelte';
  import { online } from 'svelte/reactivity/window';
  import { version } from '../package.json';

  let { serverReachable } = $props();
  const container = import.meta.env.PROD ? navigator.serviceWorker : undefined;
  const labels = {
    offline: 'Offline',
    active: 'Service worker active',
    pending: 'Service worker starting',
    failed: 'Service worker failed to install',
    unavailable: 'Service worker unavailable',
  };
  let state = $state(container ? 'pending' : 'unavailable');
  const status = $derived(online.current === false || serverReachable === false ? 'offline' : state);

  onMount(() => {
    if (!container) return;
    const listeners = new AbortController();
    const { signal } = listeners;

    function markControlled() {
      if (container.controller) state = 'active';
    }

    markControlled();
    container.addEventListener('controllerchange', markControlled, { signal });
    container.register(`${import.meta.env.BASE_URL}sw.js`).then(registration => {
      if (signal.aborted) return;
      // A hard reload can bypass this page's controller while the worker stays active.
      if (registration.active?.state === 'activated') state = 'active';

      function watchWorker() {
        const worker = registration.installing ?? registration.waiting ?? registration.active;
        if (!worker || worker.state === 'activated') return;
        worker.addEventListener('statechange', () => {
          if (worker.state === 'activated') state = 'active';
          if (worker.state === 'redundant' && !registration.active && !container.controller) {
            state = 'failed';
          }
        }, { signal });
      }

      registration.addEventListener('updatefound', watchWorker, { signal });
      watchWorker();
    }).catch(error => {
      if (signal.aborted) return;
      if (!container.controller) state = 'failed';
      console.warn('Could not enable offline startup:', error);
    });

    return () => listeners.abort();
  });
</script>

<small class="app-version"><a href="#settings" title="Settings">v{version}</a></small>
<output id="service-worker-status" title={labels[status]} data-state={status}>
  <span>{labels[status]}</span>
</output>

<style>
  .app-version {
    font-size: 0.8em;
    vertical-align: middle;
  }

  output {
    display: inline-block;
    width: 8px;
    height: 8px;
    margin-inline: 4px 3px;
    border-radius: 50%;
    vertical-align: middle;
    background-color: #9ca3af;
  }

  output[data-state='offline'] { background-color: #60a5fa; }
  output[data-state='active'] { background-color: #4ade80; }
  output[data-state='pending'] { background-color: #fbbf24; }
  output[data-state='failed'] { background-color: #f87171; }

  output > span {
    position: absolute;
    width: 1px;
    height: 1px;
    clip-path: inset(50%);
    overflow: hidden;
    white-space: nowrap;
  }
</style>
