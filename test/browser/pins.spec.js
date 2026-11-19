import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

const mutation = (action, id, fields) => ({ action, id, opId: randomUUID(), ...(fields === undefined ? {} : { fields }) });
async function seed(request, mutations) {
  const response = await request.post('/api/sync', { data: { cursor: 0, mutations } });
  expect(response.ok()).toBe(true);
  expect((await response.json()).acknowledgements.every(ack => ack.accepted)).toBe(true);
}
async function synced(page) {
  await expect.poll(() => page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('plain-todos-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('outbox', 'readonly');
      const count = tx.objectStore('outbox').count();
      count.onsuccess = () => resolve(count.result);
      tx.oncomplete = () => db.close();
    };
  }))).toBe(0);
  await expect(page.locator('#sync-status')).toHaveText('Synced');
}
async function makeTree(request) {
  const ids = Object.fromEntries(['book', 'folder', 'list', 'note', 'todo'].map(type => [type, randomUUID()]));
  const names = { book: `Pin book ${ids.book}`, folder: `Pin folder ${ids.folder}`, list: `Pin list ${ids.list}`, note: `Pin note ${ids.note} https://example.com/pinned`, todo: `Pin todo ${ids.todo} #errand` };
  await seed(request, [
    mutation('create', ids.book, { type: 'notebook', parentId: null, name: names.book }),
    mutation('create', ids.folder, { type: 'folder', parentId: ids.book, name: names.folder }),
    mutation('create', ids.list, { type: 'list', parentId: ids.folder, name: names.list }),
    mutation('create', ids.note, { type: 'note', parentId: ids.list, text: names.note }),
    mutation('create', ids.todo, { type: 'todo', parentId: ids.list, text: names.todo }),
  ]);
  return { ids, names };
}
const contentRow = (page, id) => page.locator(`#contents > div[data-id="${id}"]`);
const pinnedRow = (page, id) => page.locator(`#pinned > div[data-id="${id}"]`);
const favouriteRow = (page, id) => page.locator(`#favourites > div[data-id="${id}"]`);
async function clearPins(page, ids) {
  for (const id of Object.values(ids)) {
    const row = pinnedRow(page, id);
    if (await row.count()) await row.getByRole('button', { name: 'Pin', exact: true }).click();
  }
  await synced(page);
}

test('pin controls cover all five types; global pinned rows sit above favourites, retain navigation/counts/links, and survive trash/restore', async ({ page, request }) => {
  const { ids, names } = await makeTree(request);
  await page.goto('/');
  const book = contentRow(page, ids.book);
  await expect(book).toBeVisible();
  const pinned = page.getByRole('navigation', { name: 'Pinned items', exact: true });
  await expect(pinned).toBeHidden();
  try {
    for (const key of ['book', 'folder', 'list']) {
      const row = contentRow(page, ids[key]);
      await expect(row.locator(':scope > button[aria-label="Pin"]')).toHaveCount(1);
      await expect(row.getByRole('button', { name: 'Pin', exact: true })).toHaveAttribute('aria-pressed', 'false');
      await row.getByRole('button', { name: 'Pin', exact: true }).click();
      await expect(pinnedRow(page, ids[key])).toBeVisible();
      await row.locator(':scope > a').click();
    }
    for (const key of ['note', 'todo']) {
      const row = contentRow(page, ids[key]);
      await expect(row.getByRole('button', { name: 'Pin', exact: true })).toHaveCount(0);
      // Focus the read-only group: its centre may be an independent URL link.
      await row.locator('.entity-text').focus();
      const toolbar = row.getByRole('toolbar');
      await expect(toolbar.getByRole('button', { name: 'Pin', exact: true })).toBeVisible();
      await toolbar.getByRole('button', { name: 'Pin', exact: true }).click();
      await expect(toolbar.getByRole('button', { name: 'Pin', exact: true })).toHaveAttribute('aria-pressed', 'true');
      await expect(row.getByRole('textbox')).toHaveCount(0);
      await expect(pinnedRow(page, ids[key])).toBeVisible();
    }
    const todo = contentRow(page, ids.todo);
    await todo.getByRole('button', { name: 'Favourite', exact: true }).click();
    await expect(favouriteRow(page, ids.todo)).toBeVisible();
    const shortcuts = page.locator('#pinned > div > a, #favourites > div > a');
    const shortcutText = await shortcuts.allTextContents();
    for (const mode of ['Cr. Date', 'Cr. Time', 'Mod Date', 'Mod Time', 'No date']) {
      await page.locator('#date-display').click();
      await expect(page.locator('#date-display')).toHaveText(mode);
      expect(await shortcuts.allTextContents()).toEqual(shortcutText);
    }
    await expect(pinned).toBeVisible();
    await expect(page.locator('#pinned + #favourites + #breadcrumbs')).toHaveCount(1);
    const pinnedBox = await pinned.boundingBox();
    const favouriteBox = await page.locator('#favourites').boundingBox();
    expect(pinnedBox.y + pinnedBox.height).toBeLessThanOrEqual(favouriteBox.y);
    for (const id of Object.values(ids)) {
      const row = pinnedRow(page, id);
      await expect(row.locator(':scope > button').first()).toHaveText('📌');
      await expect(row.getByRole('button', { name: 'Favourite', exact: true })).toHaveCount(0);
      await expect(row.locator('a a')).toHaveCount(0);
    }
    await expect(pinnedRow(page, ids.list).getByRole('img', { name: '1 incomplete todo', exact: true })).toBeVisible();
    const noteLink = pinnedRow(page, ids.note).getByRole('link', { name: 'https://example.com/pinned', exact: true });
    await expect(noteLink).toHaveAttribute('href', 'https://example.com/pinned');
    await expect(noteLink).toHaveAttribute('target', '_blank');
    await expect(noteLink).toHaveAttribute('rel', 'noopener noreferrer');
    await todo.getByRole('checkbox').check();
    await expect(pinnedRow(page, ids.todo).locator(`a[href="#entity/${ids.list}"]`)).toHaveCSS('text-decoration-line', 'line-through');
    await expect(pinnedRow(page, ids.list).getByRole('img', { name: '0 incomplete todos', exact: true })).toBeVisible();
    const order = await pinned.locator(':scope > div').evaluateAll(rows => rows.map(row => row.dataset.id));
    await page.locator('#sort-order').click();
    await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('nothing matches this pin search');
    expect(await pinned.locator(':scope > div').evaluateAll(rows => rows.map(row => row.dataset.id))).toEqual(order);
    await pinnedRow(page, ids.note).locator('a:not(.text-url)').first().click();
    await expect(page).toHaveURL(new RegExp(`#entity/${ids.list}$`));
    await expect(contentRow(page, ids.note)).toBeVisible();
    await page.getByRole('button', { name: 'All hashtags', exact: true }).click();
    await expect(pinnedRow(page, ids.note)).toBeVisible();
    await page.getByRole('button', { name: 'Nearby errands', exact: true }).click();
    await expect(pinnedRow(page, ids.note)).toBeVisible();
    await page.getByRole('button', { name: 'Edit locations', exact: true }).click();
    await expect(pinnedRow(page, ids.note)).toBeVisible();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(pinnedRow(page, ids.list).locator(':scope > button[aria-label="Pin"] + a')).toHaveCount(1);
    await pinnedRow(page, ids.book).locator(':scope > a').click();
    const folder = contentRow(page, ids.folder);
    page.once('dialog', dialog => dialog.accept());
    await folder.getByRole('button', { name: 'Delete', exact: true }).click();
    for (const key of ['folder', 'list', 'note', 'todo']) await expect(pinnedRow(page, ids[key])).toHaveCount(0);
    await expect(pinnedRow(page, ids.book)).toBeVisible();
    await page.getByRole('button', { name: 'Trash', exact: true }).click();
    await expect(pinnedRow(page, ids.book)).toBeVisible();
    await contentRow(page, ids.folder).getByRole('button', { name: 'Restore', exact: true }).click();
    for (const id of Object.values(ids)) await expect(pinnedRow(page, id)).toBeVisible();
    await synced(page);
    await page.reload();
    for (const id of Object.values(ids)) await expect(pinnedRow(page, id)).toBeVisible();
  } finally {
    if (await favouriteRow(page, ids.todo).count()) await favouriteRow(page, ids.todo).getByRole('button', { name: 'Favourite', exact: true }).click();
    await clearPins(page, ids);
  }
});

test('pins work offline, sync across browsers, and unpinning leaves favourites and Undo intact', async ({ page, context, request, browser }) => {
  const id = randomUUID();
  const name = `Offline pin ${id}`;
  await seed(request, [mutation('create', id, { type: 'notebook', parentId: null, name })]);
  await page.goto('/');
  const row = contentRow(page, id);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Favourite', exact: true }).click();
  await synced(page);
  let otherContext;
  try {
    await context.setOffline(true);
    await row.getByRole('button', { name: 'Pin', exact: true }).click();
    await expect(pinnedRow(page, id)).toBeVisible();
    await expect(favouriteRow(page, id)).toBeVisible();
    await row.getByRole('button', { name: 'Edit', exact: true }).click();
    await row.getByRole('textbox', { name: 'Name', exact: true }).fill(`${name} edited`);
    await row.getByRole('button', { name: 'Close', exact: true }).click();
    await pinnedRow(page, id).getByRole('button', { name: 'Pin', exact: true }).click();
    await expect(pinnedRow(page, id)).toHaveCount(0);
    await expect(favouriteRow(page, id)).toBeVisible();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(row.locator(':scope > a')).toHaveText(name);
    await expect(row.getByRole('button', { name: 'Pin', exact: true })).toHaveAttribute('aria-pressed', 'false');
    await row.getByRole('button', { name: 'Pin', exact: true }).click();
    await page.getByRole('button', { name: 'All hashtags', exact: true }).click();
    await expect(pinnedRow(page, id)).toBeVisible();
    await context.setOffline(false);
    await synced(page);
    await page.reload();
    await expect(pinnedRow(page, id)).toBeVisible();
    otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    await other.goto('http://127.0.0.1:3100/');
    await expect(pinnedRow(other, id)).toBeVisible();
    await expect(favouriteRow(other, id)).toBeVisible();
    await pinnedRow(other, id).getByRole('button', { name: 'Pin', exact: true }).click();
    await synced(other);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(pinnedRow(page, id)).toHaveCount(0);
    await expect(favouriteRow(page, id)).toBeVisible();
    await favouriteRow(page, id).locator(':scope > a').click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(row.getByRole('button', { name: 'Pin', exact: true })).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await context.setOffline(false);
    if (otherContext) await otherContext.close();
    if (await pinnedRow(page, id).count()) await pinnedRow(page, id).getByRole('button', { name: 'Pin', exact: true }).click();
    if (await favouriteRow(page, id).count()) await favouriteRow(page, id).getByRole('button', { name: 'Favourite', exact: true }).click();
    await synced(page);
  }
});
