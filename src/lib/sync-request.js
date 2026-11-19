export function requestSyncPage(url, { cursor, checkpoint, mutations, awaiting, operationThrough }, signal, reportReachability) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  const payload = JSON.stringify({ cursor, checkpoint, mutations, awaiting, operationThrough });
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let timeout;

    const abort = () => request.abort();

    function watchProgress() {
      clearTimeout(timeout);
      timeout = setTimeout(abort, 15000);
    }

    function stopWatching() {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
    }

    request.upload.addEventListener('progress', watchProgress);
    request.upload.addEventListener('load', watchProgress);
    request.addEventListener('readystatechange', () => {
      if (request.readyState === XMLHttpRequest.HEADERS_RECEIVED) watchProgress();
    });
    request.addEventListener('progress', watchProgress);
    request.addEventListener('load', () => {
      reportReachability?.(true);
      const data = request.response;
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(data?.error ?? `Sync failed (${request.status}).`));
      } else if (data === null) {
        reject(new Error('Sync server returned an invalid response.'));
      } else {
        resolve(data);
      }
    });
    request.addEventListener('error', () => {
      reportReachability?.(false);
      reject(new Error('Sync network request failed.'));
    });
    request.addEventListener('abort', () => {
      if (signal?.aborted) {
        reject(signal.reason);
      } else {
        reportReachability?.(false);
        reject(new Error('Sync request timed out.'));
      }
    });
    request.addEventListener('loadend', stopWatching);

    request.open('POST', url);
    request.responseType = 'json';
    request.setRequestHeader('Content-Type', 'application/json');
    watchProgress();
    signal?.addEventListener('abort', abort, { once: true });
    try { request.send(payload); }
    catch (error) {
      stopWatching();
      reject(error);
    }
  });
}
