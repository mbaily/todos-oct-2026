import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const mutation = (action, id, fields) => ({ opId: randomUUID(), action, id, ...(fields === undefined ? {} : { fields }) });
const values = (name, latitude = 0, longitude = 0, userLocation = false) => ({ name, latitude, longitude, userLocation });
const root = 'root-view-settings';
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
async function chooseFile(page, file) {
  await page.getByLabel('Location JSON file').setInputFiles({ name: 'locations.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
}

test('large location imports round-trip and their long names remain editable', async ({ page, context }) => {
  const retailerTags = Array.from({ length: 220 }, (_, index) => `#example-retailer-${index + 1}`);
  const centre = {
    id: 'example-centre',
    ...values(`Example shopping centre ${retailerTags.join(' ')}`),
  };
  const destinations = Array.from({ length: 603 }, (_, index) => ({
    id: `example-destination-${index}`,
    ...values(`Example destination ${index} #errand`),
  }));
  const file = { version: 1, locations: [centre, ...destinations] };
  await page.goto('/#locations');
  const syncRequests = [];
  context.on('request', req => {
    if (req.method() === 'POST' && new URL(req.url()).pathname === '/api/sync') syncRequests.push(req.postDataJSON());
  });
  await chooseFile(page, file);
  const preview = page.locator('#location-import-preview');
  await expect(preview).toContainText(`${file.locations.length} additions, 0 updates, 0 unchanged`);
  await page.getByRole('button', { name: 'Apply import', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await synced(page);
  const uploads = syncRequests.flatMap(body => body.mutations.filter(op => op.action === 'location-import'));
  expect(uploads).toHaveLength(1);
  expect(syncRequests.some(body => body.mutations.length === 0 && body.awaiting?.includes(uploads[0].opId))).toBe(true);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  for (const location of file.locations) expect(exported.locations.find(saved => saved.id === location.id)).toEqual(location);
  await chooseFile(page, file);
  await expect(preview).toContainText(`0 additions, 0 updates, ${file.locations.length} unchanged`);
  await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Search locations').fill('Example shopping centre');
  const row = page.locator(`[data-location-id="${centre.id}"]`);
  await row.locator('.location-name').click();
  await row.getByRole('button', { name: 'Edit location', exact: true }).click();
  const input = row.getByRole('textbox', { name: 'Location name', exact: true });
  await expect(input).toHaveValue(centre.name);
  await expect(input).toHaveAttribute('maxlength', '5000');
  const editedName = `${centre.name} #custom-retailer`;
  await input.fill(editedName);
  await row.getByRole('button', { name: 'Save location', exact: true }).click();
  await expect(row.locator('.location-name')).toHaveText(editedName);
  await synced(page);
  await page.reload();
  await page.getByLabel('Search locations').fill('Example shopping centre');
  await expect(row.locator('.location-name')).toHaveText(editedName);
});

test('Within changes keep pills enabled and matching rows mounted, and persist the last rapid selection offline', async ({ page, context, request }) => {
  const id = randomUUID();
  const text = `Stable row ${id} #errand`;
  await seed(request, [mutation('create', id, { type: 'notebook', parentId: null, name: text }),
    mutation('nearby-settings', root, { nearbyLocationId: null, nearbyRadius: 5 })]);
  await page.goto('/#nearby');
  await expect(page.locator(`[data-nearby-id="${id}"]`)).toBeVisible();
  await synced(page);
  await context.setOffline(true);
  try {
    await page.evaluate(id => {
      window.nearbyRowBefore = document.querySelector(`[data-nearby-id="${id}"]`);
      window.disabledPillChanges = [];
      window.pillObserver = new MutationObserver(records => {
        window.disabledPillChanges.push(...records.filter(record => record.attributeName === 'disabled'));
      });
      const group = document.querySelector('[aria-label="Distance filter"]');
      window.pillObserver.observe(group, { subtree: true, attributes: true });
      for (const label of ['2 km', '20 km', 'No filter', '10 km']) {
        [...group.querySelectorAll('button')].find(button => button.textContent === label).click();
      }
    }, id);
    await expect(page.getByRole('button', { name: '10 km', exact: true })).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => window.disabledPillChanges.length)).toBe(0);
    expect(await page.evaluate(id => window.nearbyRowBefore === document.querySelector(`[data-nearby-id="${id}"]`), id)).toBe(true);
    await page.evaluate(() => window.pillObserver.disconnect());
  } finally { await context.setOffline(false); }
  await synced(page);
  await page.reload();
  await expect(page.getByRole('button', { name: '10 km', exact: true })).toHaveAttribute('aria-pressed', 'true');
  let cursor = 0;
  let settings;
  let hasMore;
  do {
    const response = await request.post('/api/sync', { data: { cursor, mutations: [] } });
    const data = await response.json();
    for (const change of data.changes) if (change.entity.id === root) settings = change.entity;
    cursor = data.cursor;
    hasMore = data.hasMore;
  } while (hasMore);
  expect(settings.nearbyRadius).toBe(10);
});

test('nearby pills use exact tags, deduplicate branches, bypass #errand distance and sync choices across browsers', async ({ page, request, browser }) => {
  const prefix = randomUUID();
  const ids = Object.fromEntries(['home', 'near', 'far', 'book', 'folder', 'list', 'milk', 'specific', 'prefix', 'errand', 'done'].map(key => [key, `${prefix}-${key}`]));
  const tag = `shop-${prefix}`;
  const originName = `Home ${prefix}`;
  await seed(request, [mutation('location-create', ids.home, values(originName, 0, 0, true)),
    mutation('location-create', ids.near, values(`Near #${tag}`, 0, 0.01)),
    mutation('location-create', ids.far, values(`Far #${tag} #specific-${prefix}`, 0, 0.1)),
    mutation('nearby-settings', root, { nearbyLocationId: null, nearbyRadius: 5 }),
    mutation('create', ids.book, { type: 'notebook', parentId: null, name: `Nearby book ${prefix}` }),
    mutation('create', ids.folder, { type: 'folder', parentId: ids.book, name: 'Folder' }),
    mutation('create', ids.list, { type: 'list', parentId: ids.folder, name: 'List' }),
    ...[['milk', `Milk #${tag.toUpperCase()}`, false], ['specific', `Specific #specific-${prefix}`, false],
      ['prefix', `Prefix #shop`, false], ['errand', `Errand #errand #specific-${prefix}`, false], ['done', 'Done #errand', true]]
      .map(([key, text, checked]) => mutation('create', ids[key], { type: 'todo', parentId: ids.list, text, checked }))]);
  await page.goto('/#nearby');
  const row = id => page.locator(`[data-nearby-id="${ids[id]}"]`);
  await expect(row('errand')).toBeVisible();
  await expect(row('errand').locator('small, details')).toHaveCount(0);
  await expect(page.locator('#breadcrumbs [aria-current="page"]')).toHaveText('Nearby errands');
  await expect(page.locator('#breadcrumbs > a, #breadcrumbs > span[aria-hidden="true"]')).toHaveCount(0);
  await expect(row('milk')).toHaveCount(0);
  await expect(page.getByText('Select a current location to find nearby matches.', { exact: false })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nearby errands', exact: true })).toHaveCount(1);
  const origin = page.getByRole('group', { name: 'Current location', exact: true }).getByRole('button', { name: originName, exact: true });
  await origin.click();
  await expect(row('milk')).toBeVisible();
  await expect(row('milk')).toHaveCount(1);
  await expect(row('milk').locator('small, details')).toHaveCount(0);
  await expect(row('milk')).not.toContainText(`Near #${tag}`);
  await expect(row('milk')).not.toContainText(`Far #${tag}`);
  await expect(row('specific')).toHaveCount(0);
  await expect(row('prefix')).toHaveCount(0);
  await expect(row('done')).toHaveCount(0);
  await page.getByRole('button', { name: '20 km', exact: true }).click();
  await expect(row('specific')).toBeVisible();
  await synced(page);
  await page.reload();
  await expect(origin).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByRole('button', { name: '20 km', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto('http://127.0.0.1:3100/#nearby');
    await expect(other.getByRole('button', { name: originName, exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(other.getByRole('button', { name: '20 km', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await other.getByRole('button', { name: '2 km', exact: true }).click();
    await synced(other);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByRole('button', { name: '2 km', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await row('milk').getByRole('checkbox').check();
    await expect(row('milk')).toHaveCount(0);
  } finally { await otherContext.close(); }
  await page.getByRole('button', { name: 'Clear location', exact: true }).click();
  await page.getByRole('button', { name: 'No filter', exact: true }).click();
  await expect(row('specific')).toBeVisible();
  await expect(row('errand')).toBeVisible();
  await expect(row('prefix')).toHaveCount(0);

  const listErrandId = `${prefix}-list-errand`;
  await seed(request, [mutation('create', listErrandId, { type: 'list', parentId: ids.folder, name: `List errand #${tag}` })]);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.locator(`[data-nearby-id="${listErrandId}"]`)).toBeVisible();
  await page.locator(`[data-nearby-id="${listErrandId}"]`).getByRole('checkbox').check();
  await expect(page.locator(`[data-nearby-id="${listErrandId}"]`)).toHaveCount(0);
});

test('location panels add/edit/delete/restore and clear a selected origin while offline', async ({ page, context }) => {
  const name = `New home ${randomUUID()}`;
  await page.goto('/#nearby');
  await page.getByRole('button', { name: 'Edit locations', exact: true }).click();
  await expect(page).toHaveURL(/#locations$/);
  await expect(page.locator('#breadcrumbs > a')).toHaveText(['Nearby errands']);
  await expect(page.locator('#breadcrumbs [aria-current="page"]')).toHaveText('Edit locations');
  await page.getByRole('button', { name: '＋ Add location', exact: true }).click();
  let form = page.locator('.location-form');
  await form.getByRole('textbox', { name: 'Location name', exact: true }).fill(name);
  await form.getByLabel('Latitude', { exact: true }).fill('-37.8');
  await form.getByLabel('Longitude', { exact: true }).fill('145');
  await form.getByLabel('Available as current location').check();
  await form.getByRole('button', { name: 'Add location', exact: true }).click();
  await page.getByLabel('Search locations').fill(name);
  const locationRow = page.locator('[data-location-id]').filter({ hasText: name });
  await expect(locationRow).toBeVisible();
  await locationRow.getByRole('button', { name, exact: true }).click();
  await locationRow.getByRole('button', { name: 'Edit location', exact: true }).click();
  form = locationRow.locator('.location-form');
  await form.getByRole('textbox', { name: 'Location name', exact: true }).fill(`${name} #home`);
  await form.getByRole('button', { name: 'Save location', exact: true }).click();
  await expect(locationRow.getByRole('button', { name: `${name} #home`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const origin = page.getByRole('button', { name: `${name} #home`, exact: true });
  await origin.click();
  await expect(origin).toHaveAttribute('aria-pressed', 'true');
  await synced(page);
  await context.setOffline(true);
  try {
    await page.getByRole('button', { name: 'Edit locations', exact: true }).click();
    await page.getByLabel('Search locations').fill(name);
    await locationRow.getByRole('button', { name: `${name} #home`, exact: true }).click();
    await locationRow.getByRole('button', { name: 'Delete location', exact: true }).click();
    await expect(locationRow).toHaveCount(0);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(origin).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Clear location', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Edit locations', exact: true }).click();
    await page.getByLabel('Search locations').fill(name);
    await page.getByLabel('Location filter').selectOption('deleted');
    await locationRow.getByRole('button', { name: `${name} #home`, exact: true }).click();
    await locationRow.getByRole('button', { name: '↥ Restore location', exact: true }).click();
    await expect(locationRow).toHaveCount(0);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(origin).toHaveAttribute('aria-pressed', 'false');
  } finally { await context.setOffline(false); }
  await synced(page);
  await page.reload();
  await expect(origin).toHaveAttribute('aria-pressed', 'false');
});

test('JSON import previews/cancels/merges, validates before writing, paginates and exports active locations', async ({ page, request }) => {
  const prefix = randomUUID();
  const old = `${prefix}-existing`;
  const existingName = `Existing ${prefix}`;
  await seed(request, [mutation('location-create', old, values(existingName))]);
  await page.goto('/#locations');
  await page.getByLabel('Search locations').fill(prefix);
  await expect(page.getByRole('button', { name: existingName, exact: true })).toBeVisible();
  const file = { version: 1, locations: [{ id: old, ...values(`Updated ${prefix} #shop`, 1, 1) },
    ...Array.from({ length: 65 }, (_, i) => ({ id: `${prefix}-${i}`, ...values(`Imported ${prefix} ${String(i).padStart(2, '0')} #shop`, 0, i / 10000) }))] };
  await chooseFile(page, file);
  const preview = page.locator('#location-import-preview');
  await expect(preview).toContainText('65 additions, 1 updates, 0 unchanged');
  await expect(page.getByRole('button', { name: existingName, exact: true })).toBeVisible();
  await preview.getByText('Previously saved', { exact: true }).click();
  await expect(preview).toContainText(existingName);
  await page.getByRole('button', { name: 'Cancel import', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await chooseFile(page, { version: 1, locations: [...file.locations, { id: 'bad', ...values('Invalid', 91) }] });
  await expect(page.locator('#error')).toContainText('latitude must be a number');
  await expect(preview).toHaveCount(0);
  await expect(page.getByRole('button', { name: existingName, exact: true })).toBeVisible();
  await chooseFile(page, file);
  await page.getByRole('button', { name: 'Apply import', exact: true }).click();
  await expect(preview).toHaveCount(0);
  await expect(page.getByText('Imported 65 additions and 1 updates. 0 unchanged.', { exact: true })).toBeVisible();
  await expect(page.locator('[data-location-id]')).toHaveCount(50);
  await page.getByRole('button', { name: 'Next locations page', exact: true }).click();
  await expect(page.locator('[data-location-id]')).toHaveCount(16);
  await expect(page.getByRole('button', { name: `Updated ${prefix} #shop`, exact: true })).toBeVisible();
  await synced(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const download = await downloadPromise;
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(exported.version).toBe(1);
  expect(exported.locations.filter(location => location.id.startsWith(prefix))).toHaveLength(66);
  expect(exported.locations.find(location => location.id === old).name).toBe(`Updated ${prefix} #shop`);
  expect(exported).not.toHaveProperty('nearbyLocationId');
  await chooseFile(page, exported);
  await expect(preview).toContainText('0 additions, 0 updates');
  await expect(page.getByRole('button', { name: 'Apply import', exact: true })).toBeDisabled();
});

test('nearby navigation saves drafts and returns through locations and Trash to the original list at phone width', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const ids = Object.fromEntries(['book', 'folder', 'list', 'note'].map(key => [key, randomUUID()]));
  const text = `Navigation ${ids.note} #errand`;
  await seed(request, [mutation('create', ids.book, { type: 'notebook', parentId: null, name: 'Nearby navigation book' }),
    mutation('create', ids.folder, { type: 'folder', parentId: ids.book, name: 'Nearby navigation folder' }),
    mutation('create', ids.list, { type: 'list', parentId: ids.folder, name: 'Nearby navigation list' }),
    mutation('create', ids.note, { type: 'note', parentId: ids.list, text })]);
  await page.goto('/');
  await expect(page.locator(`[data-id="${ids.book}"]`)).toBeVisible();
  await page.goto(`/#entity/${ids.list}`);
  await expect(page.locator(`[data-id="${ids.note}"]`)).toBeVisible();
  await page.getByRole('button', { name: 'Nearby errands', exact: true }).click();
  await page.getByRole('button', { name: 'Edit locations', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const note = page.locator(`[data-nearby-id="${ids.note}"]`);
  await expect(note.getByRole('link', { name: '#errand', exact: true })).toHaveAttribute('href', '#tag/errand');
  await note.locator('.entity-text').focus();
  await note.getByRole('button', { name: 'Edit', exact: true }).click();
  await note.getByRole('textbox', { name: 'Note text', exact: true }).fill(`${text} edited`);
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await expect(page).toHaveURL(/#trash$/);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(note).toContainText(`${text} edited`);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#entity/${ids.list}$`));
  await expect(page.locator(`[data-id="${ids.note}"]`)).toContainText(`${text} edited`);
  await page.goBack();
  await expect(page).toHaveURL(/#nearby$/);
  await expect(note).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(`#entity/${ids.list}$`));
});

test('a changed location invalidates the displayed import preview without applying any additions', async ({ page, request }) => {
  const id = randomUUID();
  const name = `Preview conflict ${id}`;
  await seed(request, [mutation('location-create', id, values(name))]);
  await page.goto('/#locations');
  await page.getByLabel('Search locations').fill(id);
  await expect(page.getByRole('button', { name, exact: true })).toBeVisible();
  await chooseFile(page, { version: 1, locations: [
    { id, ...values(`Imported edit ${id}`) }, { id: `${id}-new`, ...values(`New from file ${id}`) },
  ] });
  await expect(page.locator('#location-import-preview')).toContainText('1 additions, 1 updates');
  await seed(request, [mutation('location-update', id, { name: `Other device ${id}` })]);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('button', { name: `Other device ${id}`, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Apply import', exact: true }).click();
  await expect(page.locator('#error')).toContainText('changed since the preview');
  await expect(page.locator('[data-location-id]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: `Other device ${id}`, exact: true })).toBeVisible();
});

test('Added via UI only combines with search and Show, resets pagination, and preserves origins after offline edits and restores', async ({ page, context, browser }) => {
  const prefix = randomUUID();
  await page.goto('/#locations');
  await page.getByLabel('Search locations').fill(prefix);
  const uiOnly = page.getByRole('checkbox', { name: 'Added via UI only', exact: true });
  await expect(uiOnly).not.toBeChecked();
  async function add(name, userLocation) {
    await page.getByRole('button', { name: '＋ Add location', exact: true }).click();
    const form = page.locator('.location-form');
    await form.getByRole('textbox', { name: 'Location name', exact: true }).fill(name);
    await form.getByLabel('Latitude', { exact: true }).fill('-37.8');
    await form.getByLabel('Longitude', { exact: true }).fill('145');
    await form.getByRole('checkbox', { name: 'Available as current location', exact: true }).setChecked(userLocation);
    await form.getByRole('button', { name: 'Add location', exact: true }).click();
    const row = page.locator('[data-location-id]').filter({ hasText: name });
    await expect(row).toBeVisible();
    return row.getAttribute('data-location-id');
  }
  const manualName = `Z added via UI ${prefix}`;
  const manual = await add(manualName, false);
  const updated = await add(`Z second UI location ${prefix}`, true);
  const updatedName = `Z updated by JSON ${prefix}`;
  await chooseFile(page, { version: 1, locations: [
    { id: updated, ...values(updatedName, -37.8, 145, true) },
    ...Array.from({ length: 65 }, (_, i) => ({ id: `${prefix}-${i}`, ...values(`A imported ${prefix} ${String(i).padStart(2, '0')}`, -37.8, 145, i === 0) })),
  ] });
  await page.getByRole('button', { name: 'Apply import', exact: true }).click();
  await expect(page.locator('[data-location-id]')).toHaveCount(50);
  await page.getByRole('button', { name: 'Next locations page', exact: true }).click();
  await expect(page.locator('[data-location-id]')).toHaveCount(17);
  const manualRow = page.locator(`[data-location-id="${manual}"]`);
  await manualRow.locator('.location-name').click();
  await uiOnly.check();
  await expect(page.locator('[data-location-id]')).toHaveCount(2);
  await expect(manualRow.locator('.location-name')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Next locations page', exact: true })).toHaveCount(0);
  await page.getByLabel('Location filter').selectOption('user');
  await expect(page.locator('[data-location-id]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: updatedName, exact: true })).toBeVisible();
  await uiOnly.uncheck();
  await expect(page.locator('[data-location-id]')).toHaveCount(2);
  await uiOnly.check();
  await page.getByLabel('Location filter').selectOption('all');
  await page.getByLabel('Search locations').fill(manualName);
  await expect(page.locator('[data-location-id]')).toHaveCount(1);
  await page.getByLabel('Search locations').fill(prefix);
  await expect(page.locator('[data-location-id]')).toHaveCount(2);
  await synced(page);
  await context.setOffline(true);
  const importedRow = page.locator(`[data-location-id="${prefix}-0"]`);
  try {
    await uiOnly.uncheck();
    await page.getByLabel('Search locations').fill(`${prefix} 00`);
    await importedRow.locator('.location-name').click();
    await importedRow.getByRole('button', { name: 'Edit location', exact: true }).click();
    await importedRow.getByRole('textbox', { name: 'Location name', exact: true }).fill(`A edited import ${prefix} 00`);
    await importedRow.getByRole('button', { name: 'Save location', exact: true }).click();
    await expect(importedRow.locator('.location-name')).toHaveText(`A edited import ${prefix} 00`);
    await uiOnly.check();
    await expect(page.locator('[data-location-id]')).toHaveCount(0);
    await uiOnly.uncheck();
    await importedRow.locator('.location-name').click();
    await importedRow.getByRole('button', { name: 'Delete location', exact: true }).click();
    await page.getByLabel('Location filter').selectOption('deleted');
    await expect(importedRow).toBeVisible();
    await uiOnly.check();
    await expect(page.locator('[data-location-id]')).toHaveCount(0);
    await page.getByLabel('Search locations').fill(prefix);
    await page.getByLabel('Location filter').selectOption('all');
    await manualRow.locator('.location-name').click();
    await manualRow.getByRole('button', { name: 'Delete location', exact: true }).click();
    await page.getByLabel('Location filter').selectOption('deleted');
    await expect(page.locator('[data-location-id]')).toHaveCount(1);
    await uiOnly.uncheck();
    await expect(page.locator('[data-location-id]')).toHaveCount(2);
    await uiOnly.check();
    await manualRow.locator('.location-name').click();
    await manualRow.getByRole('button', { name: '↥ Restore location', exact: true }).click();
    await expect(page.locator('[data-location-id]')).toHaveCount(0);
    await uiOnly.uncheck();
    await importedRow.locator('.location-name').click();
    await importedRow.getByRole('button', { name: '↥ Restore location', exact: true }).click();
    await uiOnly.check();
    await page.getByLabel('Location filter').selectOption('all');
    await expect(page.locator('[data-location-id]')).toHaveCount(2);
  } finally { await context.setOffline(false); }
  await synced(page);
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export JSON', exact: true }).click();
  const exported = JSON.parse(await readFile(await (await downloadPromise).path(), 'utf8'));
  expect(exported.locations.filter(row => row.id.startsWith(prefix) || [manual, updated].includes(row.id))).toHaveLength(67);
  expect(exported.locations.every(row => !Object.hasOwn(row, 'createdVia'))).toBe(true);
  const other = await browser.newContext();
  try {
    const fresh = await other.newPage();
    await fresh.goto('http://127.0.0.1:3100/#locations');
    await fresh.getByLabel('Search locations').fill(prefix);
    await fresh.getByRole('checkbox', { name: 'Added via UI only', exact: true }).check();
    await expect(fresh.locator('[data-location-id]')).toHaveCount(2);
    await expect(fresh.locator(`[data-location-id="${manual}"]`)).toBeVisible();
    await expect(fresh.locator(`[data-location-id="${updated}"]`)).toBeVisible();
  } finally { await other.close(); }
});
