import { once } from 'node:events';
import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import { createApp } from '../../server/app.js';
import { createStore } from '../../server/store.js';
import { createSyncEvents } from '../../server/sync-events.js';

async function add(page, type, value) {
  if (type === 'note' || type === 'todo') {
    await page.getByRole('radio', { name: type === 'todo' ? 'Todo' : 'Note', exact: true }).check();
  } else if (type === 'folder' || type === 'list') {
    const option = page.getByRole('radio', { name: type === 'folder' ? 'Folder' : 'List', exact: true });
    if (await option.count()) await option.check();
  }
  await page.getByRole('textbox', { name: type === 'notebook' ? 'New notebook' : 'New item', exact: true }).fill(value);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#contents')).toContainText(value);
}

async function sync(page) {
  await expect(page.locator('#contents output').filter({ hasText: /Waiting to save…|Saving…/ })).toHaveCount(0);
  await expect.poll(() => pendingCount(page)).toBe(0);
  await expect(page.locator('#sync-status')).toHaveText('Synced');
}

async function pendingCount(page) {
  // Inspect durable browser storage without relying on a source module URL.
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('plain-todos-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('outbox', 'readonly');
      const count = tx.objectStore('outbox').count();
      count.onsuccess = () => resolve(count.result);
      count.onerror = () => reject(count.error);
      tx.oncomplete = () => db.close();
    };
  }));
}

async function localEntity(page, id) {
  return page.evaluate(id => new Promise((resolve, reject) => {
    const request = indexedDB.open('plain-todos-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('entities', 'readonly');
      const entity = tx.objectStore('entities').get(id);
      entity.onsuccess = () => resolve(entity.result);
      entity.onerror = () => reject(entity.error);
      tx.oncomplete = () => db.close();
    };
  }), id);
}

const countGlyphs = [...'⓪①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'];

function countGlyph(count) {
  return countGlyphs[count] ?? [...String(count)].map(digit => countGlyphs[Number(digit)]).join('');
}

async function localIncompleteTodoCount(page, listId) {
  // Read the whole durable snapshot, not the search results or the app's count helper.
  return page.evaluate(listId => new Promise((resolve, reject) => {
    const request = indexedDB.open('plain-todos-v1');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction('entities', 'readonly');
      const all = tx.objectStore('entities').getAll();
      all.onerror = () => reject(all.error);
      all.onsuccess = () => {
        const snapshot = all.result;
        const byId = new Map(snapshot.map(entity => [entity.id, entity]));
        function active(entity) {
          const seen = new Set();
          while (entity) {
            if (entity.deletedAt || seen.has(entity.id)) return false;
            seen.add(entity.id);
            if (entity.parentId === null) return true;
            entity = byId.get(entity.parentId);
          }
          return false;
        }
        const list = byId.get(listId);
        resolve(list?.type === 'list' && active(list)
          ? snapshot.filter(entity => entity.type === 'todo' && entity.parentId === listId && !entity.checked && active(entity)).length
          : 0);
      };
      tx.oncomplete = () => db.close();
    };
  }), listId);
}

async function expectListCount(view, count, timeout = 5000) {
  const badge = view.locator('.list-todo-count');
  const description = `${count} incomplete todo${count === 1 ? '' : 's'}`;
  await expect(badge).toHaveCount(1, { timeout });
  await expect(badge).toHaveText(countGlyph(count), { timeout });
  await expect(view.getByRole('img', { name: description, exact: true })).toHaveCount(1, { timeout });
  await expect(badge).toHaveAttribute('role', 'img');
  await expect(badge).toHaveAttribute('aria-label', description);
  await expect(badge).toHaveAttribute('title', description);
  await expect(badge).toHaveJSProperty('tagName', 'SPAN');
  expect(await badge.evaluate(element => {
    let previous = element.previousSibling;
    while (previous?.nodeType === Node.COMMENT_NODE) previous = previous.previousSibling;
    return previous?.nodeType === Node.TEXT_NODE && previous.textContent.endsWith(' ');
  })).toBe(true);
}

const dateDisplays = [
  { value: 'none', label: 'No date' },
  { value: 'created-date', label: 'Cr. Date', field: 'createdAt' },
  { value: 'created-time', label: 'Cr. Time', field: 'createdAt', time: true },
  { value: 'modified-date', label: 'Mod Date', field: 'modifiedAt' },
  { value: 'modified-time', label: 'Mod Time', field: 'modifiedAt', time: true },
];

async function setDateDisplay(page, mode) {
  const button = page.locator('#date-display');
  const desired = dateDisplays.find(option => option.value === mode);
  await expect(button).toBeVisible();
  for (let clicks = 0; clicks < dateDisplays.length; clicks++) {
    const label = await button.textContent();
    if (label === desired.label) return;
    const index = dateDisplays.findIndex(option => option.label === label);
    expect(index).toBeGreaterThanOrEqual(0);
    await button.click();
    await expect(button).toHaveText(dateDisplays[(index + 1) % dateDisplays.length].label);
  }
  await expect(button).toHaveText(desired.label);
}

async function localDateText(page, entity, mode) {
  const option = dateDisplays.find(option => option.value === mode);
  if (!option.field) return '';
  // Use the browser's local getters, independently of the app's formatter.
  return page.evaluate(({ timestamp, withTime }) => {
    const date = new Date(timestamp);
    const pad = number => String(number).padStart(2, '0');
    const day = `${String(date.getFullYear()).padStart(4, '0')}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    return withTime ? `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` : day;
  }, { timestamp: entity[option.field], withTime: Boolean(option.time) });
}

async function expectRowDate(page, id, mode, trash = false) {
  const entity = await localEntity(page, id);
  const view = page.locator(`#contents > div[data-id="${id}"]`);
  const named = ['notebook', 'folder', 'list'].includes(entity.type);
  const display = view.locator(trash ? ':scope > span' : named ? ':scope > a[href^="#entity/"]' : ':scope > .entity-text').first();
  const icon = entity.type === 'folder' ? '📁 ' : entity.type === 'list' ? '📋 ' : entity.type === 'note' ? '📝 '
    : trash ? (entity.type === 'notebook' ? '📓 ' : entity.checked ? '☑ ' : '☐ ') : '';
  const date = await localDateText(page, entity, mode);
  const count = entity.type === 'list' ? await localIncompleteTodoCount(page, id) : null;
  const inAnchor = named && !trash;
  const text = `${inAnchor ? '' : icon}${date ? `${date} ` : ''}${entity.name ?? entity.text}${trash && count !== null ? ` ${countGlyph(count)}` : ''}`;
  if (inAnchor) {
    await expect(view).toContainText(text);
    expect((await view.locator(':scope > a').allTextContents()).join('')).toBe(text);
  } else await expect(display).toHaveText(text);
  if (count !== null) await expectListCount(trash ? display : view, count);
  else await expect((trash ? display : view).locator('.list-todo-count')).toHaveCount(0);
  const time = display.locator(':scope > time.entity-date');
  await expect(view.locator('time')).toHaveCount(date ? 1 : 0);
  if (date) {
    await expect(time).toHaveCount(1);
    await expect(time).toHaveAttribute('datetime', entity[dateDisplays.find(option => option.value === mode).field]);
    await expect(time).toHaveText(date);
    await expect(time.locator('a')).toHaveCount(0);
    expect(await time.getAttribute('tabindex')).toBeNull();
    expect(await time.evaluate(element => {
      const nodes = [...element.parentNode.childNodes].filter(node => node.nodeType !== Node.COMMENT_NODE);
      const index = nodes.indexOf(element);
      return { prefix: nodes.slice(0, index).map(node => node.textContent).join(''), space: nodes[index + 1]?.textContent.startsWith(' ') };
    })).toEqual({ prefix: inAnchor ? '' : icon, space: true });
    if (!trash) {
      // Whitespace-normalizing text assertions alone would miss the explicit separator.
      if (!inAnchor) expect(await display.textContent()).toBe(text);
      expect(await time.evaluate(element => [...element.parentElement.children].find(child => !child.classList.contains('entity-marker')) === element)).toBe(true);
    }
  }
  if (!trash && entity.type === 'todo') {
    await expect(view.locator(':scope > input[type="checkbox"] + .entity-text')).toHaveCount(1);
  }
}

async function expectFavouriteText(page, id) {
  const entity = await localEntity(page, id);
  const favourite = page.locator(`#favourites > div[data-id="${id}"]`);
  const isNamed = ['notebook', 'folder', 'list'].includes(entity.type);
  const icon = entity.type === 'folder' ? '📁 ' : entity.type === 'list' ? '📋 ' : entity.type === 'note' ? '📝 '
    : entity.type === 'todo' ? (entity.checked ? '☑ ' : '☐ ') : '';
  const count = entity.type === 'list' ? await localIncompleteTodoCount(page, id) : null;
  const text = `${isNamed ? '' : icon}${entity.name ?? entity.text}`;
  await expect(favourite).toBeVisible();
  await expect(favourite).toContainText(text);
  if (isNamed && icon) expect(await favourite.textContent()).toContain(icon.trim());
  if (count !== null) await expectListCount(favourite, count);
  else await expect(favourite.locator('.list-todo-count')).toHaveCount(0);
  await expect(favourite.locator('a a')).toHaveCount(0);
  await expect(favourite.locator('a[href^="#entity/"]').first()).toHaveAttribute('href', `#entity/${['note', 'todo'].includes(entity.type) ? entity.parentId : entity.id}`);
}

async function restoreRootDateDisplay(page, favouriteIds = []) {
  await page.goto('/');
  await expect(page.locator('#date-display')).toBeVisible();
  for (const id of favouriteIds) {
    const favourite = page.locator(`#favourites > div[data-id="${id}"]`);
    if (await favourite.count()) await favourite.getByRole('button', { name: 'Favourite', exact: true }).click();
    await expect(favourite).toHaveCount(0);
  }
  await setDateDisplay(page, 'none');
  await sync(page);
}

function row(page, text) {
  return page.locator('#contents > div').filter({ hasText: text });
}

async function revealActions(view) {
  await expect(view).toBeVisible();
  const text = view.locator(':scope > .entity-text');
  if (await text.count()) {
    await text.focus();
    await expect(view.locator(':scope > .entity-panel')).toBeVisible();
  }
}

async function clickAction(view, name) {
  await revealActions(view);
  await view.getByRole('button', { name, exact: true }).click();
}

async function expectReadOnlyActions(page, view, type) {
  const label = type === 'todo' ? 'Todo' : 'Note';
  const text = view.getByRole('group', { name: `${label} text`, exact: true });
  const panel = view.locator(':scope > .entity-panel');
  const toolbar = panel.getByRole('toolbar', { name: `${label} actions`, exact: true });
  await expect(text).toBeFocused();
  await expect(text).toHaveCSS('outline-style', 'none');
  await expect(text).toHaveJSProperty('tagName', 'SPAN');
  await expect(text).toHaveAttribute('tabindex', '0');
  await expect(text).toHaveAttribute('aria-controls', `actions-${await view.getAttribute('data-id')}`);
  await expect(panel).toBeVisible();
  await expect(toolbar).toBeVisible();
  await expect(page.locator('#contents .entity-panel')).toHaveCount(1);
  await expect(page.locator('#contents').getByRole('toolbar')).toHaveCount(1);
  await expect(page.locator('#contents').getByRole('textbox')).toHaveCount(0);
  await expect(page.locator('#contents textarea, #contents [contenteditable]:not([contenteditable="false"])')).toHaveCount(0);
  for (const name of ['Favourite', 'Edit', 'Delete', 'Pin']) {
    await expect(toolbar.getByRole('button', { name, exact: true })).toBeVisible();
  }
  const textBox = await text.boundingBox();
  const toolbarBox = await toolbar.boundingBox();
  expect(textBox).not.toBeNull();
  expect(toolbarBox).not.toBeNull();
  expect(toolbarBox.y).toBeGreaterThanOrEqual(textBox.y + textBox.height);
}

async function expectCollapsedActions(page, view) {
  const text = view.locator(':scope > .entity-text');
  await expect(text).toBeFocused();
  await expect(text).toHaveCSS('outline-style', 'none');
  await expect(text).toHaveCSS('border-top-width', '0px');
  await expect(text).toHaveCSS('box-shadow', 'none');
  await expect(page.locator('#contents .entity-panel')).toHaveCount(0);
  await expect(page.locator('#contents').getByRole('toolbar')).toHaveCount(0);
  await expect(page.locator('#contents').getByRole('textbox')).toHaveCount(0);
}

async function deleteContainer(page, view, accept = true) {
  const pendingDialog = page.waitForEvent('dialog');
  const click = view.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = await pendingDialog;
  expect(dialog.type()).toBe('confirm');
  const message = dialog.message();
  if (accept) await dialog.accept(); else await dialog.dismiss();
  await click;
  return message;
}

test('list badges include zero, track all direct incomplete todos independently of search and names, and keep editors raw', async ({ page }) => {
  test.setTimeout(90000);
  await page.clock.install();
  const favouriteIds = [];
  let clockPaused = false;
  await page.goto('/');
  await sync(page);
  try {
    const ids = [];
    const listName = 'Count live';
    const currentCrumb = page.locator('#breadcrumbs [aria-current="page"]');
    async function verifyLayout(view, name) {
      const link = view.locator(':scope > a');
      const star = view.getByRole('button', { name: 'Favourite', exact: true });
      await expect(view.locator(':scope > .list-todo-count + button[aria-label="Favourite"]')).toHaveCount(1);
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(link).toBeVisible();
        const nameBox = await link.evaluate((element, name) => {
          const node = [...element.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.includes(name));
          if (!node) return null;
          const range = document.createRange();
          const start = node.textContent.indexOf(name);
          range.setStart(node, start);
          range.setEnd(node, start + name.length);
          const box = range.getBoundingClientRect();
          return { x: box.x, y: box.y, width: box.width, height: box.height };
        }, name);
        const badgeBox = await view.locator('.list-todo-count').boundingBox();
        const starBox = await star.boundingBox();
        for (const box of [nameBox, badgeBox, starBox]) expect(box).not.toBeNull();
        expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(badgeBox.x);
        expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(starBox.x);
        expect(starBox.x + starBox.width).toBeLessThanOrEqual(width);
        expect(nameBox.y).toBeLessThan(badgeBox.y + badgeBox.height);
        expect(badgeBox.y).toBeLessThan(nameBox.y + nameBox.height);
        expect(badgeBox.y).toBeLessThan(starBox.y + starBox.height);
        expect(starBox.y).toBeLessThan(badgeBox.y + badgeBox.height);
      }
    }
    for (const [type, name] of [['notebook', 'Count live book'], ['folder', 'Count live folder'], ['list', listName]]) {
      await add(page, type, name);
      const view = row(page, name);
      const id = await view.getAttribute('data-id');
      ids.push(id);
      favouriteIds.push(id);
      await view.getByRole('button', { name: 'Favourite', exact: true }).click();
      const favourite = page.locator(`#favourites > div[data-id="${id}"]`);
      if (type === 'list') {
        await expect(view.locator(':scope > a')).toHaveText(name);
        await expect(view.locator(':scope > a')).toHaveAccessibleName(name);
        await expect(view.locator(':scope > a .list-todo-count')).toHaveCount(0);
        await expect(favourite.locator(':scope > a .list-todo-count')).toHaveCount(0);
        await expect(view.getByRole('checkbox', { name: `Complete ${name}`, exact: true })).toHaveCount(1);
        await expectListCount(view, 0);
        await expectListCount(favourite, 0);
        await expect(view.locator(':scope > button')).toHaveText(['★', '✎', '🗑︎', '📌']);
        await verifyLayout(view, name);
        await verifyLayout(favourite, name);
        await view.locator(':scope > a').click();
      } else {
        await expect(view.locator('.list-todo-count')).toHaveCount(0);
        await expect(favourite.locator('.list-todo-count')).toHaveCount(0);
        await expect(favourite.locator(':scope > button[aria-label="Favourite"] + a')).toHaveCount(1);
        await view.getByRole('link').click();
      }
    }
    const [bookId, folderId, listId] = ids;
    const favourite = page.locator(`#favourites > div[data-id="${listId}"]`);
    const listView = page.locator(`#contents > div[data-id="${listId}"]`);
    const originalList = await localEntity(page, listId);
    await expect(page).toHaveURL(new RegExp(`#entity/${listId}$`));
    await expect(currentCrumb).toHaveText(`${listName} ⓪`);
    await expectListCount(currentCrumb, 0);
    await expect(page.locator('#breadcrumbs > a .list-todo-count')).toHaveCount(0);
    await expect(page.locator('#creation').getByRole('textbox')).toBeFocused();
    async function expectLive(count) {
      await expect(currentCrumb).toHaveText(`${listName} ${countGlyph(count)}`);
      await expectListCount(currentCrumb, count);
      await expectListCount(favourite, count);
    }

    await add(page, 'note', 'Count live note #count-live-note');
    const noteId = await row(page, 'Count live note').getAttribute('data-id');
    favouriteIds.push(noteId);
    await clickAction(row(page, 'Count live note'), 'Favourite');
    await expectLive(0);
    await expect(row(page, 'Count live note').locator('.list-todo-count')).toHaveCount(0);
    await expect(page.locator(`#favourites > div[data-id="${noteId}"] > button[aria-label="Favourite"] + a`)).toHaveCount(1);
    await add(page, 'todo', 'Count live matching task #count-live-item');
    const todoId = await row(page, 'Count live matching task').getAttribute('data-id');
    favouriteIds.push(todoId);
    await clickAction(row(page, 'Count live matching task'), 'Favourite');
    await expectLive(1);
    await expect(row(page, 'Count live matching task').locator('.list-todo-count')).toHaveCount(0);
    await expect(page.locator(`#favourites > div[data-id="${todoId}"] > button[aria-label="Favourite"] + a`)).toHaveCount(1);
    await add(page, 'todo', 'Unmatched direct task #count-direct-item');
    const unmatchedId = await row(page, 'Unmatched direct task').getAttribute('data-id');
    await expectLive(2);
    const checkbox = page.locator(`#contents > div[data-id="${todoId}"]`).getByRole('checkbox');
    await checkbox.check();
    await expect(checkbox).toBeChecked();
    await expectLive(1);
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();
    await expectLive(2);
    const unchangedList = await localEntity(page, listId);
    for (const field of ['name', 'tags', 'createdAt', 'modifiedAt']) expect(unchangedList[field]).toEqual(originalList[field]);
    for (const id of [bookId, folderId, noteId, todoId]) {
      await expect(page.locator(`#favourites > div[data-id="${id}"] .list-todo-count`)).toHaveCount(0);
    }

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(listView.locator(':scope > a')).toHaveText(listName);
    await expectListCount(listView, 2);
    await add(page, 'list', 'Count other');
    const otherId = await row(page, 'Count other').getAttribute('data-id');
    favouriteIds.push(otherId);
    await row(page, 'Count other').getByRole('button', { name: 'Favourite', exact: true }).click();
    await row(page, 'Count other').getByRole('link').click();
    await add(page, 'todo', 'Other unmatched direct task');
    await expectListCount(currentCrumb, 1);
    await expectListCount(favourite, 2);
    await page.locator('#breadcrumbs').getByRole('link', { name: 'Count live book', exact: true }).click();
    await expect(page.locator(`#contents > div[data-id="${folderId}"] .list-todo-count`)).toHaveCount(0);
    await add(page, 'folder', 'Count twin folder');
    await row(page, 'Count twin folder').getByRole('link').click();
    await add(page, 'list', listName);
    const twinId = await row(page, listName).getAttribute('data-id');
    favouriteIds.push(twinId);
    await row(page, listName).getByRole('button', { name: 'Favourite', exact: true }).click();
    await row(page, listName).getByRole('link').click();
    for (let index = 1; index <= 3; index++) await add(page, 'todo', `Twin unmatched task ${index}`);
    await expect(currentCrumb).toHaveText(`${listName} ③`);
    const search = page.getByRole('searchbox', { name: 'Search', exact: true });
    await search.fill(listName);
    // The first list has only one matching todo; the same-named list has none.
    await expect(page.locator(`#contents > div[data-id="${todoId}"]`)).toBeVisible();
    await expect(page.locator(`#contents > div[data-id="${unmatchedId}"]`)).toHaveCount(0);
    await expect(page.locator('#contents').getByRole('checkbox')).toHaveCount(3);
    await expect(page.locator(`#contents > div[data-id="${todoId}"]`).getByRole('checkbox')).toHaveCount(1);
    await expect(page.locator(`#contents > div[data-id="${listId}"]`).getByRole('checkbox')).toHaveCount(1);
    await expect(page.locator(`#contents > div[data-id="${twinId}"]`).getByRole('checkbox')).toHaveCount(1);
    for (const [id, count] of [[listId, 2], [twinId, 3]]) {
      const result = page.locator(`#contents > div[data-id="${id}"]`);
      await expect(result.locator(':scope > a')).toHaveText(listName);
      await expect(result.locator(':scope > a .list-todo-count')).toHaveCount(0);
      await expectListCount(result, count);
      await expectListCount(page.locator(`#favourites > div[data-id="${id}"]`), count);
    }
    await expect(page.locator('#contents .list-todo-count')).toHaveCount(2);
    const ancestor = page.locator(`#breadcrumbs > a[href="#entity/${twinId}"]`);
    await expect(ancestor).toHaveText(`${listName}`);
    await expect(ancestor.locator('.list-todo-count')).toHaveCount(0);
    await search.fill('Count other');
    await expect(page.locator('#contents > div')).toHaveCount(1);
    await expectListCount(page.locator(`#contents > div[data-id="${otherId}"]`), 1);
    await expectListCount(favourite, 2);
    await favourite.locator(':scope > a').click();
    await expect(page).toHaveURL(new RegExp(`#entity/${listId}$`));
    await search.fill('');
    await expectLive(2);

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await listView.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = listView.getByRole('textbox', { name: 'Name', exact: true });
    await expect(editor).toHaveValue(listName);
    await expect(editor).toBeFocused();
    await page.clock.pauseAt(new Date());
    clockPaused = true;
    const draft = 'Count live renamed #count-live-renamed';
    await editor.fill(draft);
    await expect(editor).toHaveValue(draft);
    await expect(listView).toContainText(draft);
    await expectListCount(listView, 2);
    expect(await deleteContainer(page, listView, false)).toBe(`Move list "${draft}" ② and all its contents to trash?`);
    await expect(editor).toHaveValue(draft);
    expect((await localEntity(page, listId)).name).toBe(listName);
    expect((await localEntity(page, listId)).deletedAt).toBeNull();
    await editor.press('Enter');
    await expect(editor).toHaveCount(0);
    await expect(listView.getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
    await expect(listView).toContainText(draft);
    await expect(favourite).toContainText(draft);
    expect(await localEntity(page, listId)).toMatchObject({ name: draft, tags: ['count-live-renamed'] });
    await expect(listView.getByRole('link', { name: draft, exact: true })).toHaveAttribute('href', `#entity/${listId}`);
    await page.clock.resume();
    clockPaused = false;
    await expect(page.locator('#error')).toBeHidden();
    await sync(page);
  } finally {
    if (clockPaused) await page.clock.resume();
    await restoreRootDateDisplay(page, favouriteIds);
  }
});

test('list badges update after todo delete, Undo and Restore, and show zero in trash names and blocked parent paths', async ({ page }) => {
  test.setTimeout(90000);
  const favouriteIds = [];
  await page.goto('/');
  await sync(page);
  try {
    const ids = [];
    for (const [type, name] of [['notebook', 'Count trash book'], ['folder', 'Count trash folder'], ['list', 'Count trash list']]) {
      await add(page, type, name);
      const view = row(page, name);
      ids.push(await view.getAttribute('data-id'));
      if (type === 'list') {
        favouriteIds.push(ids.at(-1));
        await view.getByRole('button', { name: 'Favourite', exact: true }).click();
      }
      await view.getByRole('link').click();
    }
    const listId = ids[2];
    const listView = page.locator(`#contents > div[data-id="${listId}"]`);
    const favourite = page.locator(`#favourites > div[data-id="${listId}"]`);
    const currentCrumb = page.locator('#breadcrumbs [aria-current="page"]');
    const trash = page.getByRole('button', { name: 'Trash', exact: true });
    const back = page.getByRole('button', { name: 'Back', exact: true });
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await add(page, 'todo', 'Count deleted todo');
    const todoId = await row(page, 'Count deleted todo').getAttribute('data-id');
    await add(page, 'todo', 'Count retained todo');
    const retainedId = await row(page, 'Count retained todo').getAttribute('data-id');
    await add(page, 'note', 'Count earlier note');
    const noteId = await row(page, 'Count earlier note').getAttribute('data-id');
    const todo = page.locator(`#contents > div[data-id="${todoId}"]`);
    const note = page.locator(`#contents > div[data-id="${noteId}"]`);
    const originals = await Promise.all([listId, todoId, retainedId, noteId].map(id => localEntity(page, id)));
    async function expectActive(count) {
      await expectListCount(favourite, count);
      await expect(currentCrumb).toHaveText(`Count trash list ${countGlyph(count)}`);
      await expectListCount(currentCrumb, count);
    }
    async function expectPath(view, type, count) {
      const path = view.locator('.trash-location');
      await expect(path).toHaveText(`(${type}; Notebooks › Count trash book › Count trash folder › Count trash list ${countGlyph(count)})`);
      await expectListCount(path, count);
    }
    await expectActive(2);
    await clickAction(todo, 'Delete');
    await expect(todo).toHaveCount(0);
    await expectActive(1);
    await trash.click();
    await expectPath(todo, 'todo', 1);
    await expect(todo.locator(':scope > span .list-todo-count')).toHaveCount(0);
    await expect(todo.getByRole('button', { name: 'Restore', exact: true })).toBeEnabled();
    await expect(todo.locator('.restore-reason')).toHaveCount(0);
    await back.click();
    await undo.click();
    await expect(todo.getByRole('checkbox')).not.toBeChecked();
    await expectActive(2);
    await clickAction(todo, 'Delete');
    await expectActive(1);
    await trash.click();
    await expectPath(todo, 'todo', 1);
    await todo.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(todo).toHaveCount(0);
    await expectListCount(favourite, 2);
    await back.click();
    await expectActive(2);
    await expect(undo).toBeDisabled();

    await back.click();
    await expectListCount(listView, 2);
    expect(await deleteContainer(page, listView)).toBe('Move list "Count trash list" ② and all its contents to trash?');
    await expect(listView).toHaveCount(0);
    await expect(favourite).toHaveCount(0);
    await trash.click();
    await expect(listView.locator(':scope > span')).toHaveText('📋 Count trash list ⓪');
    await expectListCount(listView.locator(':scope > span'), 0);
    await expect(listView.locator('.trash-location')).toHaveText('(list; Notebooks › Count trash book › Count trash folder)');
    await expect(listView.locator('.trash-location .list-todo-count')).toHaveCount(0);
    for (const [id, type] of [[todoId, 'todo'], [retainedId, 'todo'], [noteId, 'note']]) {
      const child = page.locator(`#contents > div[data-id="${id}"]`);
      await expectPath(child, type, 0);
      const reason = child.locator('.restore-reason');
      await expect(reason).toHaveText('Restore parent first: Count trash list ⓪');
      await expectListCount(reason, 0);
      const restore = child.getByRole('button', { name: 'Restore', exact: true });
      await expect(restore).toBeDisabled();
      await expect(restore).toHaveAttribute('title', 'Restore parent first: Count trash list ⓪');
      await expect(child.locator(':scope > span .list-todo-count')).toHaveCount(0);
    }
    await back.click();
    await undo.click();
    await expectListCount(listView, 2);
    await expectListCount(favourite, 2);
    await listView.getByRole('link').click();
    await expectActive(2);

    // A separately trashed note remains separate when the list is restored.
    await clickAction(note, 'Delete');
    await expectActive(2);
    await back.click();
    expect(await deleteContainer(page, listView)).toBe('Move list "Count trash list" ② and all its contents to trash?');
    await expect(favourite).toHaveCount(0);
    await trash.click();
    await expectListCount(listView.locator(':scope > span'), 0);
    await expectPath(note, 'note', 0);
    await expect(note.locator('.restore-reason')).toHaveText('Restore parent first: Count trash list ⓪');
    await expect(note.getByRole('button', { name: 'Restore', exact: true })).toHaveAttribute('title', 'Restore parent first: Count trash list ⓪');
    await listView.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(listView).toHaveCount(0);
    for (const id of [todoId, retainedId]) await expect(page.locator(`#contents > div[data-id="${id}"]`)).toHaveCount(0);
    await expectListCount(favourite, 2);
    await expectPath(note, 'note', 2);
    await expect(note.locator('.restore-reason')).toHaveCount(0);
    await expect(note.getByRole('button', { name: 'Restore', exact: true })).toBeEnabled();
    await note.getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(note).toHaveCount(0);
    await expectListCount(favourite, 2);
    await favourite.locator(':scope > a').click();
    await expectActive(2);
    await expect(todo.getByRole('checkbox')).not.toBeChecked();
    await expect(note.locator(':scope > .entity-text')).toHaveText('📝 Count earlier note');
    for (const original of originals) {
      const restored = await localEntity(page, original.id);
      expect(restored.createdAt).toBe(original.createdAt);
      expect(restored.name ?? restored.text).toBe(original.name ?? original.text);
      expect(restored.tags).toEqual(original.tags);
      expect(restored.deletedAt).toBeNull();
    }
    await sync(page);
    await page.reload();
    await expectActive(2);
    await expect(page.locator('#error')).toBeHidden();
  } finally { await restoreRootDateDisplay(page, favouriteIds); }
});

test('list counts render every glyph through 21 safely beside dates and converge across fresh browsers after offline edits and reload', async ({ page, context, browser }) => {
  test.setTimeout(120000);
  const favouriteIds = [];
  let otherContext;
  await page.goto('/');
  await sync(page);
  try {
    for (const [type, name] of [['notebook', 'Count range book'], ['folder', 'Count range folder']]) {
      await add(page, type, name);
      await row(page, name).getByRole('link').click();
    }
    const name = 'Count range <b>safe</b> https://badge-counts.example.invalid/count-range #count-range';
    await add(page, 'list', name);
    const listId = await row(page, name).getAttribute('data-id');
    const listView = page.locator(`#contents > div[data-id="${listId}"]`);
    favouriteIds.push(listId);
    await listView.getByRole('button', { name: 'Favourite', exact: true }).click();
    const favourite = page.locator(`#favourites > div[data-id="${listId}"]`);
    const listLink = listView.getByRole('link', { name, exact: true });
    await expectListCount(listView, 0);
    await expect(listView.locator(':scope > a .list-todo-count')).toHaveCount(0);
    await expect(listLink).toHaveAttribute('href', `#entity/${listId}`);
    await expect(listView.locator('b, img, script, .text-url')).toHaveCount(0);
    await listLink.click();
    await expect(page).toHaveURL(new RegExp(`#entity/${listId}$`));
    await setDateDisplay(page, 'created-time');
    const originalList = await localEntity(page, listId);
    const currentCrumb = page.locator('#breadcrumbs [aria-current="page"]');
    const todoIds = [];
    for (let count = 0; count <= 21; count++) {
      if (count) {
        const text = `Count range task ${String(count).padStart(2, '0')} #count-range-task`;
        await add(page, 'todo', text);
        todoIds.push(await row(page, text).getAttribute('data-id'));
      }
      await expect(currentCrumb).toHaveText(`${name} ${countGlyph(count)}`);
      await expectListCount(currentCrumb, count);
      await expectListCount(favourite, count);
      await expect(favourite).toContainText(name);
      await expect(favourite.locator(':scope > a .list-todo-count')).toHaveCount(0);
      if (count === 20) await expect(currentCrumb.locator('.list-todo-count')).toHaveText('⑳');
      if (count === 21) await expect(currentCrumb.locator('.list-todo-count')).toHaveText('②①');
    }
    await add(page, 'note', 'Count range note https://example.com/count-range-note #count-range-note');
    await expectListCount(currentCrumb, 21);
    await expect(page.locator('#contents .list-todo-count')).toHaveCount(0);
    await expect(page.locator('#contents .text-url')).toHaveCount(1);
    await expect(page.locator('#contents .text-url')).toHaveAttribute('href', 'https://example.com/count-range-note');
    await expect(page.locator('#breadcrumbs b, #breadcrumbs img, #breadcrumbs .text-url')).toHaveCount(0);
    await expect(favourite.locator('b, img, script, .text-url')).toHaveCount(0);
    await expect(favourite.getByRole('link', { name, exact: true })).toHaveAttribute('href', `#entity/${listId}`);
    await expect(favourite.locator(':scope > .list-todo-count + button[aria-label="Favourite"]')).toHaveCount(1);

    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await setDateDisplay(page, 'modified-time');
    await expectRowDate(page, listId, 'modified-time');
    await expectFavouriteText(page, listId);
    await expect(listView.locator('b, img, script, .text-url')).toHaveCount(0);
    await page.locator('#breadcrumbs').getByRole('link', { name: 'Home', exact: true }).click();
    await setDateDisplay(page, 'created-date');
    await expectFavouriteText(page, listId);
    await favourite.getByRole('link', { name, exact: true }).click();
    await expect(page.locator('#date-display')).toHaveText('Cr. Time');
    await sync(page);
    const unchangedList = await localEntity(page, listId);
    for (const field of ['name', 'tags', 'createdAt', 'modifiedAt']) expect(unchangedList[field]).toEqual(originalList[field]);
    expect(unchangedList.tags).toEqual(['count-range']);

    otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    // Load at root first: a fresh profile must download the existing favourite and hierarchy.
    await other.goto('/');
    await sync(other);
    const otherFavourite = other.locator(`#favourites > div[data-id="${listId}"]`);
    await expectListCount(otherFavourite, 21, 15000);
    await expect(other.locator('#date-display')).toHaveText('Cr. Date', { timeout: 15000 });
    await otherFavourite.getByRole('link', { name, exact: true }).click();
    await expect(other).toHaveURL(new RegExp(`#entity/${listId}$`));
    await expect(other.locator('#date-display')).toHaveText('Cr. Time');
    const otherCrumb = other.locator('#breadcrumbs [aria-current="page"]');
    await expectListCount(otherCrumb, 21);
    const otherCheckbox = other.locator(`#contents > div[data-id="${todoIds[0]}"]`).getByRole('checkbox');
    const checkbox = page.locator(`#contents > div[data-id="${todoIds[0]}"]`).getByRole('checkbox');
    await otherCheckbox.check();
    await expectListCount(otherCrumb, 20);
    await sync(other);
    await expectListCount(currentCrumb, 20, 15000);
    await expect(currentCrumb.locator('.list-todo-count')).toHaveText('⑳');
    await expectListCount(favourite, 20);
    await expect(checkbox).toBeChecked({ timeout: 15000 });

    await context.setOffline(true);
    await checkbox.uncheck();
    await expectListCount(currentCrumb, 21);
    await expect(currentCrumb.locator('.list-todo-count')).toHaveText('②①');
    await expectListCount(favourite, 21);
    expect(await pendingCount(page)).toBeGreaterThan(0);
    for (let index = 0; index < 16; index++) {
      await page.locator(`#contents > div[data-id="${todoIds[index]}"]`).getByRole('checkbox').check();
      await expectListCount(currentCrumb, 20 - index);
      await expectListCount(favourite, 20 - index);
    }
    await expect(currentCrumb).toHaveText(`${name} ⑤`);
    await expectListCount(otherFavourite, 20);
    await expectListCount(otherCrumb, 20);
    await context.setOffline(false);
    await sync(page);
    await expectListCount(otherCrumb, 5, 15000);
    await expectListCount(otherFavourite, 5, 15000);
    await expect(other.locator(`#contents > div[data-id="${todoIds[15]}"]`).getByRole('checkbox')).toBeChecked({ timeout: 15000 });
    for (const client of [page, other]) {
      await client.reload();
      await sync(client);
      await expect(client).toHaveURL(new RegExp(`#entity/${listId}$`));
      await expect(client.locator('#date-display')).toHaveText('Cr. Time');
      await expect(client.locator('#breadcrumbs [aria-current="page"]')).toHaveText(`${name} ⑤`);
      await expectListCount(client.locator('#breadcrumbs [aria-current="page"]'), 5);
      await expectFavouriteText(client, listId);
      for (const [index, checked] of [[0, true], [15, true], [16, false], [20, false]]) {
        await expect(client.locator(`#contents > div[data-id="${todoIds[index]}"]`).getByRole('checkbox')).toBeChecked({ checked });
      }
      const persisted = await localEntity(client, listId);
      for (const field of ['name', 'tags', 'createdAt', 'modifiedAt']) expect(persisted[field]).toEqual(originalList[field]);
      await expect(client.locator('#error')).toBeHidden();
    }
  } finally {
    await context.setOffline(false);
    try { await otherContext?.close(); }
    finally { await restoreRootDateDisplay(page, favouriteIds); }
  }
});

test('page keeps a pure black canvas and a 125% default font regardless of the OS theme', async ({ page }) => {
  for (const colorScheme of ['dark', 'light']) {
    await page.emulateMedia({ colorScheme });
    await page.goto('/');
    await expect(page.locator('html')).toHaveCSS('font-size', '20px');
    await expect(page.locator('body')).toHaveCSS('font-size', '20px');
    await expect(page.locator('html')).toHaveCSS('background-color', 'rgb(0, 0, 0)');
    await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  }
});

test('Trash persists and restores deleted entities offline, preserving separate trash and syncing across browsers', async ({ page, context, browser }) => {
  await page.goto('/');
  const ids = [];
  for (const [type, name] of [['notebook', 'Trash recovery notebook'], ['folder', 'Trash recovery folder'], ['list', 'Trash recovery list']]) {
    await add(page, type, name);
    const view = row(page, name);
    ids.push(await view.getAttribute('data-id'));
    if (type === 'notebook') await view.getByRole('button', { name: 'Favourite', exact: true }).click();
    await view.getByRole('link').click();
  }
  const listUrl = page.url();
  await add(page, 'note', 'Earlier trash note #separate-trash <script>bad()</script>');
  const earlierId = await row(page, 'Earlier trash note').getAttribute('data-id');
  ids.push(earlierId);
  await clickAction(row(page, 'Earlier trash note'), 'Delete');
  await add(page, 'todo', 'Trash recovery todo #restored-trash');
  const todoId = await row(page, 'Trash recovery todo').getAttribute('data-id');
  ids.push(todoId);
  await clickAction(row(page, 'Trash recovery todo'), 'Favourite');
  await row(page, 'Trash recovery todo').getByRole('checkbox').check();
  await clickAction(row(page, 'Trash recovery todo'), 'Edit');
  await page.getByRole('textbox', { name: 'Todo text', exact: true }).fill('Trash recovery todo saved #restored-trash');
  const trash = page.getByRole('button', { name: 'Trash', exact: true });
  await expect(trash).toHaveCount(1);
  await trash.click();
  await expect(page).toHaveURL(/#trash$/);
  await expect(page.locator('#breadcrumbs [aria-current="page"]')).toHaveText('Trash');
  await expect(page.locator('#breadcrumbs > span')).toHaveText(['Trash']);
  await expect(page.locator('#breadcrumbs > a')).toHaveCount(0);
  await expect(page.getByRole('main', { name: 'Trash', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  await expect(page.locator('#creation input, #creation textarea')).toHaveCount(0);
  expect((await localEntity(page, todoId)).text).toBe('Trash recovery todo saved #restored-trash');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(listUrl);
  const originals = await Promise.all(ids.map(id => localEntity(page, id)));
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: 'Back', exact: true }).click();
  await deleteContainer(page, page.locator(`#contents > div[data-id="${ids[0]}"]`));
  await sync(page);
  await page.reload();
  await trash.click();
  const trashRow = id => page.locator(`#contents > div[data-id="${id}"]`);
  for (const id of ids) await expect(trashRow(id)).toBeVisible();
  await expect(trashRow(earlierId).locator('script')).toHaveCount(0);
  await expect(trashRow(earlierId).locator('.trash-location')).toHaveText('(note; Notebooks › Trash recovery notebook › Trash recovery folder › Trash recovery list ⓪)');
  await expect(trashRow(earlierId).getByRole('button', { name: 'Restore', exact: true })).toBeDisabled();
  await expect(trashRow(earlierId).locator('.restore-reason')).toHaveText('Restore parent first: Trash recovery notebook');
  const sort = page.locator('#sort-order');
  for (const label of ['Trashed desc', 'Trashed asc', 'Created desc', 'Created asc', 'Modified desc', 'Modified asc']) {
    await expect(sort).toHaveText(label);
    await sort.click();
  }
  await expect(sort).toHaveText('Trashed desc');

  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto('/#trash');
    await expect(other.locator(`#contents > div[data-id="${ids[0]}"]`)).toBeVisible();
    await context.setOffline(true);
    await trashRow(ids[0]).getByRole('button', { name: 'Restore', exact: true }).click();
    for (const id of [ids[0], ids[1], ids[2], todoId]) await expect(trashRow(id)).toHaveCount(0);
    // A note deleted earlier is not revived by restoring its notebook.
    await expect(trashRow(earlierId)).toBeVisible();
    await expect(trashRow(earlierId).getByRole('button', { name: 'Restore', exact: true })).toBeEnabled();
    await trashRow(earlierId).getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(trashRow(earlierId)).toHaveCount(0);
    expect(await pendingCount(page)).toBeGreaterThan(0);
    for (let i = 0; i < ids.length; i++) {
      const restored = await localEntity(page, ids[i]);
      expect(restored.deletedAt).toBeNull();
      expect(restored.createdAt).toBe(originals[i].createdAt);
    }
    expect((await localEntity(page, todoId)).checked).toBe(true);
    await expect(page.locator(`#favourites > div[data-id="${todoId}"]`)).toBeVisible();
    await context.setOffline(false);
    await sync(page);
    await expect(other.locator(`#contents > div[data-id="${ids[0]}"]`)).toHaveCount(0, { timeout: 15000 });
    await expect(other.locator(`#contents > div[data-id="${earlierId}"]`)).toHaveCount(0);
    await page.reload();
    for (const id of ids) await expect(trashRow(id)).toHaveCount(0);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
    await page.locator(`#favourites > div[data-id="${ids[0]}"]`).getByRole('link').click();
    await row(page, 'Trash recovery folder').getByRole('link').click();
    await row(page, 'Trash recovery list').getByRole('link').click();
    await expect(row(page, 'Trash recovery todo').getByRole('checkbox')).toBeChecked();
    await expect(page.locator(`#contents > div[data-id="${earlierId}"]`)).toBeVisible();
    await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('#restored-trash');
    await expect(page.locator(`#contents > div[data-id="${todoId}"]`)).toBeVisible();
  } finally { await context.setOffline(false); await otherContext.close(); }
  for (const id of [ids[0], todoId]) await page.locator(`#favourites > div[data-id="${id}"]`).getByRole('button', { name: 'Favourite', exact: true }).click();
  await sync(page);
});

test('empty Trash retains global controls and supports bookmarks, browser history and Back from hashtags', async ({ page }) => {
  await page.route('**/api/sync', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ acknowledgements: [], changes: [], cursor: 0, checkpoint: null, hasMore: false }) }));
  await page.goto('/#trash');
  await expect(page.locator('#empty-trash')).toHaveText('Trash is empty.');
  await expect(page.locator('#breadcrumbs > span')).toHaveText(['Trash']);
  await expect(page.locator('#breadcrumbs > a')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Trash', exact: true })).toHaveCount(1);
  await expect(page.locator('#navigation > button')).toHaveText(['←', 'Trashed desc', 'No date']);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.locator('#breadcrumbs [aria-current="page"]')).toHaveText('🏠');
  await page.getByRole('button', { name: 'All hashtags', exact: true }).click();
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(/#hashtags$/);
  await page.goBack();
  await expect(page).toHaveURL(/#trash$/);
  await page.locator('#sort-order').click();
  await expect(page.locator('#sort-order')).toHaveText('Trashed asc');
  await page.reload();
  await expect(page.locator('#sort-order')).toHaveText('Trashed desc');
  await expect(page.locator('#breadcrumbs > span')).toHaveText(['Trash']);
  await expect(page.locator('#breadcrumbs > a')).toHaveCount(0);
  await expect(page.locator('#error')).toBeHidden();
});

test('Back from Trash falls back to Notebooks if its original page was deleted by another browser', async ({ page, browser }) => {
  await page.goto('/');
  const name = 'Trash return context';
  await add(page, 'notebook', name);
  const id = await row(page, name).getAttribute('data-id');
  await row(page, name).getByRole('link').click();
  await sync(page);
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto('/');
    await deleteContainer(other, row(other, name));
    await sync(other);
    await expect(page.locator(`#contents > div[data-id="${id}"]`)).toBeVisible({ timeout: 15000 });
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page).toHaveURL(/\/#?$/);
    await expect(page.getByRole('textbox', { name: 'New notebook', exact: true })).toBeVisible();
    await expect(page.locator('#breadcrumbs [aria-current="page"]')).toHaveText('🏠');
    await expect(page.locator('#error')).toBeHidden();
  } finally { await otherContext.close(); }
});

test('one global hashtag button opens a live alphabetical index with date sorting, no Undo and tag navigation', async ({ page, browser }) => {
  await page.goto('/');
  const bookName = 'Index notebook #book_index';
  await add(page, 'notebook', bookName);
  const book = row(page, bookName);
  const bookId = await book.getAttribute('data-id');
  await book.getByRole('button', { name: 'Favourite', exact: true }).click();
  await book.getByRole('link', { name: bookName, exact: true }).click();
  await add(page, 'folder', 'Index folder #folder_index');
  await row(page, 'Index folder #folder_index').getByRole('link', { name: 'Index folder #folder_index', exact: true }).click();
  await add(page, 'list', 'Index list #list_index');
  await row(page, 'Index list #list_index').getByRole('link', { name: 'Index list #list_index', exact: true }).click();
  const listUrl = page.url();
  const original = 'Index task #zulu_index #alpha_index #ALPHA_index';
  await add(page, 'todo', original);
  await add(page, 'note', 'Index note #alpha_index #日本語_index #İstanbul_index');
  await add(page, 'note', 'Only in trash #trash_index');
  await clickAction(row(page, 'Only in trash #trash_index'), 'Delete');
  const taskId = await row(page, original).getAttribute('data-id');
  await clickAction(row(page, original), 'Edit');
  const draft = `${original} #draft_index`;
  await page.getByRole('textbox', { name: 'Todo text', exact: true }).fill(draft);
  const favourite = page.locator(`#favourites > div[data-id="${bookId}"]`);
  const hashtagsButton = page.getByRole('button', { name: 'All hashtags', exact: true });
  await expect(hashtagsButton).toHaveCount(1);
  await expect(favourite.getByRole('button', { name: 'All hashtags', exact: true })).toHaveCount(0);
  await expect(favourite.locator(':scope > button').nth(0)).toHaveAttribute('aria-label', 'Favourite');
  await expect(hashtagsButton).toHaveText('#');
  await hashtagsButton.click();
  await expect(page).toHaveURL(/#hashtags$/);
  await expect(page.getByRole('main', { name: 'Hashtags', exact: true })).toBeVisible();
  await expect(page.locator('#favourites + #breadcrumbs')).toHaveCount(1);
  await expect(page.locator('#breadcrumbs [aria-current="page"]')).toHaveText('Hashtags');
  await expect(page.locator('#breadcrumbs > a')).toHaveCount(0);
  await expect(page.locator('#breadcrumbs > span')).toHaveText(['Hashtags']);
  await expect(page.locator('#navigation > button')).toHaveText(['←', 'Alphabetical', 'No date']);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  await expect(page.locator('#creation input, #creation textarea')).toHaveCount(0);
  expect((await localEntity(page, taskId)).text).toBe(draft);
  const tagNames = () => page.locator('#contents > div[data-tag]').evaluateAll(rows => rows.map(row => row.dataset.tag));
  const names = await tagNames();
  expect(names).toEqual([...new Set(names)].sort((a, b) => a.localeCompare(b)));
  expect(names).toEqual(expect.arrayContaining(['book_index', 'folder_index', 'list_index', 'alpha_index', 'zulu_index', '日本語_index', 'draft_index']));
  expect(names).not.toContain('trash_index');
  await expect(page.locator('#contents > div[data-tag="alpha_index"]')).toHaveCount(1);
  await sync(page);

  const sort = page.locator('#sort-order');
  for (const label of ['Alphabetical', 'Created desc', 'Created asc', 'Modified desc', 'Modified asc']) {
    await expect(sort).toHaveText(label);
    await sort.click();
  }
  await expect(sort).toHaveText('Alphabetical');
  expect(await pendingCount(page)).toBe(0);
  await sort.click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(listUrl);
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await hashtagsButton.click();
  await expect(sort).toHaveText('Alphabetical');
  await sort.click();
  await hashtagsButton.click();
  await expect(sort).toHaveText('Alphabetical');

  await page.getByRole('link', { name: '#alpha_index', exact: true }).click();
  await expect(page).toHaveURL(/#tag\/alpha_index$/);
  await expect(page.getByRole('searchbox', { name: 'Search', exact: true })).toHaveValue('#alpha_index');
  await expect(page.locator('#breadcrumbs [aria-current="page"]')).toHaveText('#alpha_index');
  await expect(page.locator('#contents > div')).toHaveCount(2);
  await page.goBack();
  await expect(sort).toHaveText('Alphabetical');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole('searchbox', { name: 'Search', exact: true })).toHaveValue('#alpha_index');
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('');
  await expect(page.locator('#breadcrumbs [aria-current="page"]')).toHaveText('🏠');
  await hashtagsButton.click();
  await page.getByRole('link', { name: '#alpha_index', exact: true }).click();
  await page.locator('#breadcrumbs').getByRole('link', { name: 'Hashtags', exact: true }).click();
  await expect(sort).toHaveText('Alphabetical');
  await page.getByRole('link', { name: '#日本語_index', exact: true }).click();
  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Search', exact: true })).toHaveValue('#日本語_index');
  await expect(row(page, 'Index note #alpha_index #日本語_index')).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  const normalizedTag = 'İstanbul_index'.toLowerCase();
  await page.getByRole('link', { name: `#${normalizedTag}`, exact: true }).click();
  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Search', exact: true })).toHaveValue(`#${normalizedTag}`);
  await expect(row(page, 'Index note #alpha_index #日本語_index')).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await sort.click();
  await expect(sort).toHaveText('Created desc');
  await page.reload();
  await expect(sort).toHaveText('Alphabetical');
  await sort.click();

  // New tags from another browser appear without changing this page's chosen sort.
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto('/');
    await other.locator('#favourites').getByRole('link', { name: bookName, exact: true }).click();
    await row(other, 'Index folder #folder_index').getByRole('link', { name: 'Index folder #folder_index', exact: true }).click();
    await row(other, 'Index list #list_index').getByRole('link', { name: 'Index list #list_index', exact: true }).click();
    await add(other, 'note', 'Remote tag #remote_index');
    await sync(other);
    await expect(page.locator('#contents > div[data-tag="remote_index"]')).toBeVisible({ timeout: 15000 });
    await expect(sort).toHaveText('Created desc');
  } finally { await otherContext.close(); }
  await favourite.getByRole('button', { name: 'Favourite', exact: true }).click();
  await sync(page);
});

test('breadcrumbs sit below favourites, follow renamed ancestors and save pending edits when jumping', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#breadcrumbs [aria-current="page"]').getByRole('img', { name: 'Home', exact: true })).toHaveText('🏠');
  await add(page, 'notebook', 'Breadcrumb notebook');
  const bookId = await row(page, 'Breadcrumb notebook').getAttribute('data-id');
  await row(page, 'Breadcrumb notebook').getByRole('button', { name: 'Favourite', exact: true }).click();
  await row(page, 'Breadcrumb notebook').getByRole('link').click();
  await add(page, 'folder', 'Breadcrumb folder');
  await row(page, 'Breadcrumb folder').getByRole('link').click();
  await add(page, 'folder', 'Breadcrumb nested');
  await row(page, 'Breadcrumb nested').getByRole('link').click();
  await add(page, 'list', 'Breadcrumb list');
  await row(page, 'Breadcrumb list').getByRole('link').click();
  const crumbs = page.locator('#breadcrumbs');
  await expect(page.locator('#favourites + #breadcrumbs')).toHaveCount(1);
  await expect(crumbs.locator(':scope > a')).toHaveText(['🏠', 'Breadcrumb notebook', 'Breadcrumb folder', 'Breadcrumb nested']);
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText('Breadcrumb list ⓪');
  await expect.poll(() => crumbs.locator('[aria-hidden="true"]').evaluateAll(spans => spans.map(span => span.textContent)))
    .toEqual(Array(4).fill(' › '));
  await add(page, 'todo', 'Breadcrumb task');
  const id = await row(page, 'Breadcrumb task').getAttribute('data-id');
  await clickAction(row(page, 'Breadcrumb task'), 'Edit');
  await page.getByRole('textbox', { name: 'Todo text', exact: true }).fill('Breadcrumb saved #crumb-task');
  await crumbs.getByRole('link', { name: 'Breadcrumb notebook', exact: true }).click();
  expect((await localEntity(page, id)).text).toBe('Breadcrumb saved #crumb-task');
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText('Breadcrumb notebook');
  await row(page, 'Breadcrumb folder').getByRole('button', { name: 'Edit', exact: true }).click();
  await row(page, 'Breadcrumb folder').getByRole('textbox', { name: 'Name', exact: true }).fill('Breadcrumb renamed folder');
  await row(page, 'Breadcrumb renamed folder').getByRole('button', { name: 'Close', exact: true }).click();
  await row(page, 'Breadcrumb renamed folder').getByRole('link').click();
  await row(page, 'Breadcrumb nested').getByRole('link').click();
  await row(page, 'Breadcrumb list').getByRole('link').click();
  await expect(crumbs.getByRole('link', { name: 'Breadcrumb renamed folder', exact: true })).toBeVisible();
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText('Breadcrumb list ①');
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('#crumb-task');
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText('Search: #crumb-task');
  await crumbs.getByRole('link', { name: 'Home', exact: true }).click();
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText('🏠');
  await expect(page.getByRole('searchbox', { name: 'Search', exact: true })).toHaveValue('');
  await page.goBack();
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText('Breadcrumb list ①');
  await page.goForward();
  await expect(crumbs.locator('[aria-current="page"]')).toHaveText('🏠');
  await page.locator(`#favourites > div[data-id="${bookId}"]`).getByRole('button', { name: 'Favourite', exact: true }).click();
  await sync(page);
});

test('one global hashtag button remains available with no favourites and opens the empty index', async ({ page }) => {
  async function verifyButtonPosition() {
    const crumbs = page.locator('#breadcrumbs');
    await expect(crumbs.getByRole('button', { name: 'All hashtags', exact: true })).toHaveCount(1);
    const firstCrumb = crumbs.locator(':scope > a, :scope > span[aria-current="page"]').first();
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      const buttonBox = await crumbs.getByRole('button', { name: 'All hashtags', exact: true }).boundingBox();
      const crumbBox = await firstCrumb.boundingBox();
      expect(buttonBox).not.toBeNull();
      expect(crumbBox).not.toBeNull();
      expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(crumbBox.x);
      expect(buttonBox.y).toBeLessThan(crumbBox.y + crumbBox.height);
      expect(crumbBox.y).toBeLessThan(buttonBox.y + buttonBox.height);
    }
  }
  await page.route('**/api/sync', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ acknowledgements: [], changes: [], cursor: 0, checkpoint: null, hasMore: false }),
  }));
  await page.goto('/');
  await expect(page.locator('#favourites > div')).toHaveCount(0);
  await expect(page.locator('#favourites')).toBeHidden();
  const hashtagsButton = page.getByRole('button', { name: 'All hashtags', exact: true });
  await expect(hashtagsButton).toHaveCount(1);
  await expect(hashtagsButton).toBeVisible();
  await verifyButtonPosition();
  await hashtagsButton.click();
  await page.reload();
  await expect(page.locator('#empty-hashtags')).toHaveText('No hashtags.');
  await verifyButtonPosition();
  await expect(page.locator('#sort-order')).toHaveText('Alphabetical');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
  await expect(page.locator('#breadcrumbs [aria-current="page"]')).toHaveText('Hashtags');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.locator('#breadcrumbs [aria-current="page"]')).toHaveText('🏠');
  await expect(page.getByRole('textbox', { name: 'New notebook', exact: true })).toBeVisible();
});

test('only note and todo text URLs become safe links in contents, search and favourites', async ({ page, context }) => {
  await page.goto('/');
  const favouriteIds = [];
  for (const type of ['notebook', 'folder', 'list']) {
    const name = `URL names ${type} https://names.example.org/${type}`;
    await add(page, type, name);
    const view = row(page, name);
    const id = await view.getAttribute('data-id');
    const navigationLink = view.locator(':scope > a');
    await expect(navigationLink).toHaveAttribute('href', `#entity/${id}`);
    await expect(view.locator('.text-url')).toHaveCount(0);
    await view.getByRole('button', { name: 'Favourite', exact: true }).click();
    favouriteIds.push(id);
    const favourite = page.locator(`#favourites > div[data-id="${id}"]`);
    await expect(favourite.locator('.text-url')).toHaveCount(0);
    await expect(favourite.locator(':scope > a')).toHaveAttribute('href', `#entity/${id}`);
    await navigationLink.click();
  }

  const todoText = 'URL todo https://example.com/todo?x=1&y=2. More at www.example.org/docs! #url-render';
  const noteText = 'URL note (https://example.net/note_(part)). <img src=x onerror=alert(1)> #url-render';
  await add(page, 'todo', todoText);
  await add(page, 'note', noteText);
  const todoId = await row(page, todoText).getAttribute('data-id');
  const noteId = await row(page, noteText).getAttribute('data-id');
  const todo = page.locator(`#contents > div[data-id="${todoId}"]`);
  const note = page.locator(`#contents > div[data-id="${noteId}"]`);
  await expect(todo.locator(':scope > span')).toHaveText(todoText);
  await expect(note.locator(':scope > span')).toHaveText(`📝 ${noteText}`);
  await expect(todo.locator('.text-url')).toHaveCount(2);
  await expect(note.locator('.text-url')).toHaveCount(1);
  const todoLink = todo.getByRole('link', { name: 'https://example.com/todo?x=1&y=2', exact: true });
  await expect(todoLink).toHaveAttribute('href', 'https://example.com/todo?x=1&y=2');
  await expect(todoLink).toHaveAttribute('target', '_blank');
  await expect(todoLink).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(todoLink).toHaveCSS('font-size', '20px');
  await expect(todo.getByRole('link', { name: 'www.example.org/docs', exact: true })).toHaveAttribute('href', 'http://www.example.org/docs');
  await expect(note.getByRole('link', { name: 'https://example.net/note_(part)', exact: true })).toHaveAttribute('href', 'https://example.net/note_(part)');
  await expect(note.locator('img, script')).toHaveCount(0);

  for (const id of [todoId, noteId]) {
    await clickAction(page.locator(`#contents > div[data-id="${id}"]`), 'Favourite');
    favouriteIds.push(id);
  }
  const favouriteTodo = page.locator(`#favourites > div[data-id="${todoId}"]`);
  await expect(favouriteTodo.locator('.text-url')).toHaveCount(2);
  await expect(favouriteTodo.locator('a a')).toHaveCount(0);
  await expect(page.locator(`#favourites > div[data-id="${noteId}"] .text-url`)).toHaveCount(1);
  await todo.getByRole('checkbox').check();
  await expect(todoLink).toHaveCSS('text-decoration-line', 'line-through');
  await expect(favouriteTodo.locator('.text-url').first()).toHaveCSS('text-decoration-line', 'line-through');

  // Intercept the test URL so new-tab verification never contacts another site.
  await context.route('https://example.com/**', route => route.fulfill({ contentType: 'text/plain', body: 'External link test' }));
  const appUrl = page.url();
  const pendingPopup = page.waitForEvent('popup');
  await todoLink.click();
  const popup = await pendingPopup;
  await expect(popup).toHaveURL('https://example.com/todo?x=1&y=2');
  expect(await popup.evaluate(() => window.opener === null)).toBe(true);
  await popup.close();
  await expect(page).toHaveURL(appUrl);

  const search = page.getByRole('searchbox', { name: 'Search', exact: true });
  await search.fill('#url-render');
  await expect(page.locator('#contents .text-url')).toHaveCount(3);
  await search.fill('names.example.org');
  await expect(page.locator('#contents > div')).toHaveCount(3);
  await expect(page.locator('#contents .text-url')).toHaveCount(0);
  for (const link of await page.locator('#contents > div > a').all()) {
    await expect(link).toHaveAttribute('href', /^#entity\//);
  }
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();

  await clickAction(todo, 'Edit');
  const edited = 'URL todo https://example.com/edited #url-render';
  const editor = todo.getByRole('textbox', { name: 'Todo text', exact: true });
  await editor.fill(edited);
  await expect(editor).toHaveValue(edited);
  await expect(todo.getByRole('link', { name: 'https://example.com/edited', exact: true })).toHaveAttribute('href', 'https://example.com/edited');
  await todo.getByRole('button', { name: 'Close', exact: true }).click();
  await sync(page);
  expect((await localEntity(page, todoId)).text).toBe(edited);
  await page.reload();
  await expect(todo.getByRole('link', { name: 'https://example.com/edited', exact: true })).toBeVisible();
  await expect(favouriteTodo.getByRole('link', { name: 'https://example.com/edited', exact: true })).toBeVisible();
  // The plain portion of a favourite still opens its containing list.
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await favouriteTodo.locator('a:not(.text-url)').first().click();
  await expect(todo).toBeVisible();

  for (const id of favouriteIds) {
    await page.locator(`#favourites > div[data-id="${id}"]`).getByRole('button', { name: 'Favourite', exact: true }).click();
  }
  await sync(page);
});

test('viewer hashtags open local results, preserve item links, and leave editors as plain text', async ({ page, context, request }) => {
  const id = () => crypto.randomUUID();
  const [bookId, folderId, listId, todoId, noteId] = Array.from({ length: 5 }, id);
  const tag = `viewer-${listId.slice(0, 8)}`;
  const displayTag = `#${tag.toUpperCase()}`;
  const listName = `${displayTag} #日本語`;
  const url = 'https://example.com/path/#fragment';
  const todoText = `Read (${displayTag}) and ${url}`;
  const create = (id, fields) => ({ opId: crypto.randomUUID(), action: 'create', id, fields });
  const seeded = await request.post('/api/sync', { data: { cursor: 0, mutations: [
    create(bookId, { type: 'notebook', parentId: null, name: `Viewer notebook ${displayTag}` }),
    create(folderId, { type: 'folder', parentId: bookId, name: 'Viewer folder' }),
    create(listId, { type: 'list', parentId: folderId, name: listName }),
    create(todoId, { type: 'todo', parentId: listId, text: todoText }),
    create(noteId, { type: 'note', parentId: listId, text: `Viewer note #${tag}-extra` }),
  ] } });
  expect((await seeded.json()).acknowledgements.every(receipt => receipt.accepted)).toBe(true);
  await page.goto(`/#entity/${folderId}`);
  await sync(page);
  await expect(page.locator('#service-worker-status')).toHaveAttribute('data-state', 'active');
  await context.setOffline(true);

  const tagHref = `#tag/${tag}`;
  const list = page.locator(`#contents > [data-id="${listId}"]`);
  await expect(list.getByRole('link', { name: displayTag, exact: true })).toHaveAttribute('href', tagHref);
  await list.getByRole('link', { name: `Open ${listName}`, exact: true }).click();
  await expect(page.locator('#breadcrumbs [aria-current="page"]').getByRole('link', { name: '#日本語', exact: true }))
    .toHaveAttribute('href', `#tag/${encodeURIComponent('日本語')}`);

  const todo = page.locator(`#contents > [data-id="${todoId}"]`);
  await expect(todo.getByRole('link', { name: url, exact: true })).toHaveAttribute('href', url);
  await expect(todo.getByRole('link', { name: '#fragment', exact: true })).toHaveCount(0);
  await clickAction(todo, 'Favourite');
  await clickAction(todo, 'Pin');
  for (const section of ['favourites', 'pinned']) {
    const item = page.locator(`#${section} > [data-id="${todoId}"]`);
    await expect(item.getByRole('link', { name: displayTag, exact: true })).toHaveAttribute('href', tagHref);
    await expect(item.locator('a a')).toHaveCount(0);
  }

  const creation = page.locator('#creation');
  await creation.getByRole('textbox').fill(`New ${displayTag}`);
  await expect(creation.getByRole('textbox')).toHaveValue(`New ${displayTag}`);
  await expect(creation.getByRole('link')).toHaveCount(0);
  await clickAction(todo, 'Edit');
  const editor = todo.getByRole('textbox', { name: 'Todo text', exact: true });
  const draft = `${todoText}, updated`;
  await editor.fill(draft);
  await expect(editor).toHaveValue(draft);
  await todo.getByRole('link', { name: displayTag, exact: true }).press('Enter');
  await expect(page).toHaveURL(`/${tagHref}`);
  await expect(page.getByRole('searchbox', { name: 'Search', exact: true })).toHaveValue(`#${tag}`);
  await expect(page.locator('#contents > [data-id]')).toHaveCount(4);
  expect((await localEntity(page, todoId)).text).toBe(draft);
  const back = page.getByRole('button', { name: 'Back', exact: true });
  await back.click();
  await expect(page).toHaveURL(`/#entity/${listId}`);
  await expect(todo).toBeVisible();

  const note = page.locator(`#contents > [data-id="${noteId}"]`);
  const search = page.getByRole('searchbox', { name: 'Search', exact: true });
  await search.fill(`Read #${tag}`);
  await expect(note).toHaveCount(0);
  await todo.getByRole('link', { name: displayTag, exact: true }).click();
  await note.getByRole('link', { name: `#${tag}-extra`, exact: true }).click();
  await expect(search).toHaveValue(`#${tag}-extra`);
  await page.reload();
  await expect(search).toHaveValue(`#${tag}-extra`);
  await back.click();
  await expect(page).toHaveURL(`/${tagHref}`);
  await expect(search).toHaveValue(`#${tag}`);
  await back.click();
  await expect(page).toHaveURL(`/#entity/${listId}`);
  await expect(search).toHaveValue(`Read #${tag}`);
  await expect(note).toHaveCount(0);
  await page.goForward();
  await expect(search).toHaveValue(`#${tag}`);
  await back.click();
  await expect(search).toHaveValue(`Read #${tag}`);
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();

  await clickAction(note, 'Delete');
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await note.getByRole('link', { name: `#${tag}-extra`, exact: true }).click();
  await expect(search).toHaveValue(`#${tag}-extra`);
  await back.click();
  await expect(page).toHaveURL('/#trash');
  await expect(note).toBeVisible();
  await back.click();
  await expect(page).toHaveURL(`/#entity/${listId}`);
});

test('Back, sort and Undo sit below Search and immediately above contents on every view', async ({ page }) => {
  const navigation = page.locator('#navigation');
  const search = page.getByRole('searchbox', { name: 'Search', exact: true });
  async function verifyPosition() {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      await page.setViewportSize(viewport);
      await expect(navigation).toBeVisible();
      await expect(page.locator('#controls + #navigation + #contents')).toHaveCount(1);
      await expect(navigation.locator(':scope > button')).toHaveText(['←', 'Created desc', '↶', 'No date']);
      const searchBox = await search.boundingBox();
      const navigationBox = await navigation.boundingBox();
      expect(searchBox).not.toBeNull();
      expect(navigationBox).not.toBeNull();
      expect(navigationBox.y).toBeGreaterThanOrEqual(searchBox.y + searchBox.height);
    }
  }

  await page.goto('/');
  await verifyPosition();
  for (const [type, name] of [['notebook', 'Navigation layout notebook'], ['folder', 'Navigation layout folder'], ['list', 'Navigation layout list']]) {
    await add(page, type, name);
    await row(page, name).getByRole('link').click();
    await verifyPosition();
  }
  await add(page, 'todo', 'Navigation layout todo');
  await search.fill('Navigation layout todo');
  await expect(row(page, 'Navigation layout todo')).toBeVisible();
  await verifyPosition();
  await navigation.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(search).toHaveValue('');
  await verifyPosition();
  await sync(page);
});

test('date display cycles five local formats across rows and search, keeps favourites date-free, and retains read-only time targets', async ({ page, context }) => {
  test.setTimeout(60000);
  const ids = [];
  await page.goto('/');
  await sync(page);
  try {
    await expect(page.locator('#navigation > button')).toHaveText(['←', 'Created desc', '↶', 'No date']);
    const button = page.locator('#date-display');
    await expect(button).toHaveCount(1);
    await expect(button).toHaveAttribute('title', 'Change date display');
    await expect(button).toHaveAttribute('tabindex', '-1');
    await expect(button).not.toHaveClass(/icon-button/);
    await expect(page.locator('#navigation > button[aria-label="Undo"] + #date-display')).toHaveCount(1);
    await expect(page.locator('#navigation > button').nth(1)).toHaveAttribute('id', 'sort-order');
    const styles = await button.evaluate(element => {
      const properties = ['backgroundColor', 'fontSize', 'borderTopStyle', 'borderTopWidth', 'paddingTop', 'paddingLeft'];
      return [element, document.querySelector('#sort-order')].map(node => properties.map(property => getComputedStyle(node)[property]));
    });
    expect(styles[0]).toEqual(styles[1]);
    await expect(page.locator('style, [style]')).toHaveCount(0);

    await context.setOffline(true);
    let time = await page.evaluate(() => new Date(2026, 1, 3, 4, 5, 6).getTime());
    const tag = '#date-render-browser';
    async function create(type, text) {
      await page.clock.setFixedTime(time += 86401000);
      await add(page, type, text);
      const id = await row(page, text).getAttribute('data-id');
      ids.push(id);
      await expectRowDate(page, id, 'none');
      await page.clock.setFixedTime(time += 86401000);
      await clickAction(page.locator(`#contents > div[data-id="${id}"]`), 'Favourite');
      await expect(page.locator(`#favourites > div[data-id="${id}"]`)).toBeVisible();
      return id;
    }
    async function open(id) {
      await page.locator(`#contents > div[data-id="${id}"] > a[href="#entity/${id}"]`).click();
      await expect(button).toHaveText('No date');
    }
    const bookId = await create('notebook', `Date render book ${tag}`);
    await open(bookId);
    await create('folder', `Date render sibling ${tag}`);
    const folderId = await create('folder', `Date render folder ${tag}`);
    await open(folderId);
    const nestedId = await create('folder', `Date render nested ${tag}`);
    await open(nestedId);
    const listId = await create('list', `Date render list ${tag}`);
    await open(listId);
    const todoUrl = 'https://example.com/date-render-todo';
    const noteUrl = 'https://example.com/date-render-note';
    const todoId = await create('todo', `Date render todo ${todoUrl} ${tag}`);
    const noteId = await create('note', `Date render note ${noteUrl} ${tag}`);
    const originals = await Promise.all(ids.map(id => localEntity(page, id)));
    for (const entity of originals) expect(entity.modifiedAt).not.toBe(entity.createdAt);
    const search = page.getByRole('searchbox', { name: 'Search', exact: true });
    const listOrder = await page.locator('#contents > div').evaluateAll(rows => rows.map(row => row.dataset.id));
    let searchOrder;
    for (let index = 0; index < dateDisplays.length; index++) {
      const mode = dateDisplays[index];
      await expect(button).toHaveText(mode.label);
      for (const id of [todoId, noteId]) await expectRowDate(page, id, mode.value);
      expect(await page.locator('#contents > div').evaluateAll(rows => rows.map(row => row.dataset.id))).toEqual(listOrder);
      await search.fill(tag);
      await expect(page.locator('#contents > div')).toHaveCount(ids.length);
      const order = await page.locator('#contents > div').evaluateAll(rows => rows.map(row => row.dataset.id));
      searchOrder ??= order;
      expect(order).toEqual(searchOrder);
      for (const id of ids) {
        await expectRowDate(page, id, mode.value);
        await expectFavouriteText(page, id);
      }
      for (const [id, url] of [[todoId, todoUrl], [noteId, noteUrl]]) {
        for (const section of ['#contents', '#favourites']) {
          const links = page.locator(`${section} > div[data-id="${id}"] .text-url`);
          await expect(links).toHaveCount(1);
          await expect(links).toHaveAttribute('href', url);
        }
      }
      await expect(page.locator('#sort-order')).toHaveText('Created desc');
      await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
      await page.getByRole('button', { name: 'Clear search', exact: true }).click();
      await button.click();
      await expect(button).toHaveText(dateDisplays[(index + 1) % dateDisplays.length].label);
    }
    for (const original of originals) {
      const entity = await localEntity(page, original.id);
      expect(entity.createdAt).toBe(original.createdAt);
      expect(entity.modifiedAt).toBe(original.modifiedAt);
      expect(entity.sortOrder).toBe(original.sortOrder);
    }
    expect((await localEntity(page, listId)).dateDisplay).toBe('none');
    expect(await pendingCount(page)).toBeGreaterThan(0);

    // A #tag page uses root settings; plain search above retained the list settings.
    await page.locator('#breadcrumbs').getByRole('link', { name: 'Home', exact: true }).click();
    await setDateDisplay(page, 'created-time');
    await page.getByRole('button', { name: 'All hashtags', exact: true }).click();
    await page.locator('#contents').getByRole('link', { name: tag, exact: true }).click();
    await expect(page).toHaveURL(/#tag\/date-render-browser$/);
    await expect(button).toHaveText('Cr. Time');
    await expect(page.locator('#contents > div')).toHaveCount(ids.length);
    for (const id of ids) await expectRowDate(page, id, 'created-time');
    await page.locator(`#favourites > div[data-id="${listId}"] > a[href="#entity/${listId}"]`).click();
    await expect(button).toHaveText('No date');
    await setDateDisplay(page, 'modified-time');

    const note = page.locator(`#contents > div[data-id="${noteId}"]`);
    const todo = page.locator(`#contents > div[data-id="${todoId}"]`);
    // Only explicit text URLs open new tabs, including those in favourites.
    await context.setOffline(false);
    await sync(page);
    await context.route('https://example.com/**', route => route.fulfill({ contentType: 'text/plain', body: 'Date link test' }));
    for (const link of [note.locator('.text-url'), page.locator(`#favourites > div[data-id="${noteId}"] .text-url`)]) {
      const appUrl = page.url();
      await link.focus();
      await expect(page.locator('#contents .entity-panel')).toHaveCount(0);
      const pendingPopup = page.waitForEvent('popup');
      await link.click();
      const popup = await pendingPopup;
      await expect(popup).toHaveURL(noteUrl);
      expect(await popup.evaluate(() => window.opener === null)).toBe(true);
      await popup.close();
      await expect(page).toHaveURL(appUrl);
      await expect(page.locator('#contents .entity-panel')).toHaveCount(0);
    }
    await expectRowDate(page, noteId, 'modified-time');
    await note.locator('time').click();
    await expectReadOnlyActions(page, note, 'note');
    await note.locator('time').click();
    await expectCollapsedActions(page, note);
    await todo.locator('time').click();
    await expectReadOnlyActions(page, todo, 'todo');
    await todo.getByRole('checkbox').check();
    await expect.poll(async () => (await localEntity(page, todoId)).checked).toBe(true);
    await sync(page);
    await expectFavouriteText(page, todoId);
    await expectRowDate(page, todoId, 'modified-time');
    await expect(todo.locator('.entity-text')).toHaveCSS('text-decoration-line', 'line-through');
    await expect(page.locator('#error')).toBeHidden();
  } finally {
    await context.setOffline(false);
    await restoreRootDateDisplay(page, ids);
  }
});

test('independent date preferences persist offline with sort and edit Undo, then reload and sync to a fresh browser', async ({ page, context, browser }) => {
  test.setTimeout(60000);
  let otherContext;
  const favouriteIds = [];
  await page.goto('/');
  await sync(page);
  try {
    await expect(page.locator('#date-display')).toHaveText('No date');
    const rootSettings = await localEntity(page, 'root-view-settings');
    const rootSort = await page.locator('#sort-order').textContent();
    const ids = [];
    for (const [type, name] of [['notebook', 'Date preferences book'], ['folder', 'Date preferences folder'], ['folder', 'Date preferences nested'], ['list', 'Date preferences list']]) {
      await add(page, type, name);
      const id = await row(page, name).getAttribute('data-id');
      ids.push(id);
      if (type === 'notebook') {
        favouriteIds.push(id);
        await clickAction(row(page, name), 'Favourite');
      }
      if (ids.length === 2) await add(page, 'folder', 'Date preferences sibling');
      await page.locator(`#contents > div[data-id="${id}"] > a[href="#entity/${id}"]`).click();
      await expect(page.locator('#date-display')).toHaveText('No date');
    }
    const [bookId, folderId, nestedId, listId] = ids;
    await add(page, 'note', 'Date preferences original note');
    const noteId = await row(page, 'Date preferences original note').getAttribute('data-id');
    await add(page, 'todo', 'Date preferences todo');
    const todoId = await row(page, 'Date preferences todo').getAttribute('data-id');
    await sync(page);
    const originals = await Promise.all(ids.map(id => localEntity(page, id)));
    await context.setOffline(true);
    const undo = page.getByRole('button', { name: 'Undo', exact: true });
    await expect(undo).toBeDisabled();
    for (let i = 0; i < 3; i++) await page.locator('#sort-order').click();
    await expect(page.locator('#sort-order')).toHaveText('Modified asc');
    await expect(undo).toBeDisabled();
    const note = page.locator(`#contents > div[data-id="${noteId}"]`);
    await clickAction(note, 'Edit');
    await note.getByRole('textbox', { name: 'Note text', exact: true }).fill('Date preferences saved edit');
    await note.getByRole('button', { name: 'Close', exact: true }).click();
    await expect.poll(async () => (await localEntity(page, noteId)).text).toBe('Date preferences saved edit');
    const edited = await localEntity(page, noteId);
    for (const mode of dateDisplays.slice(1)) {
      await setDateDisplay(page, mode.value);
      await expectRowDate(page, noteId, mode.value);
      expect((await localEntity(page, noteId)).modifiedAt).toBe(edited.modifiedAt);
      await expect(page.locator('#sort-order')).toHaveText('Modified asc');
      await expect(undo).toBeEnabled();
    }
    await undo.click();
    await expect(note.locator('.entity-text')).toContainText('Date preferences original note');
    expect((await localEntity(page, noteId)).text).toBe('Date preferences original note');
    await expect(page.locator('#date-display')).toHaveText('Mod Time');
    await expect(undo).toBeDisabled();
    await expectRowDate(page, noteId, 'modified-time');
    await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('Date preferences');
    await expect(page.locator('#date-display')).toHaveText('Mod Time');
    for (const id of [...ids, noteId, todoId]) await expectRowDate(page, id, 'modified-time');
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.locator('#date-display')).toHaveText('No date');
    await expectRowDate(page, listId, 'none');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await setDateDisplay(page, 'modified-date');
    for (let i = 0; i < 2; i++) await page.locator('#sort-order').click();
    await expectRowDate(page, nestedId, 'modified-date');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await setDateDisplay(page, 'created-time');
    await page.locator('#sort-order').click();
    await expectRowDate(page, folderId, 'created-time');
    const siblingId = await row(page, 'Date preferences sibling').getAttribute('data-id');
    await page.locator(`#contents > div[data-id="${siblingId}"] > a`).click();
    await expect(page.locator('#date-display')).toHaveText('No date');
    expect((await localEntity(page, siblingId)).dateDisplay ?? 'none').toBe('none');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.locator('#date-display')).toHaveText('Cr. Time');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await setDateDisplay(page, 'created-date');
    await expectRowDate(page, bookId, 'created-date');
    await expect(page.locator('#sort-order')).toHaveText(rootSort);
    await expect(undo).toBeDisabled();

    const views = [
      { id: 'root-view-settings', mode: 'created-date', sort: rootSettings?.sortOrder ?? 'created-desc', label: rootSort, child: bookId },
      { id: bookId, mode: 'created-time', sort: 'created-asc', label: 'Created asc', child: folderId },
      { id: folderId, mode: 'modified-date', sort: 'modified-desc', label: 'Modified desc', child: nestedId },
      { id: nestedId, mode: 'none', sort: 'created-desc', label: 'Created desc', child: listId },
      { id: listId, mode: 'modified-time', sort: 'modified-asc', label: 'Modified asc', child: noteId },
    ];
    for (const view of views) {
      const entity = await localEntity(page, view.id);
      expect(entity.dateDisplay ?? 'none').toBe(view.mode);
      expect(entity.sortOrder ?? 'created-desc').toBe(view.sort);
      const original = view.id === 'root-view-settings' ? rootSettings : originals.find(original => original.id === view.id);
      expect(entity.createdAt).toBe(original?.createdAt);
      expect(entity.modifiedAt).toBe(original?.modifiedAt);
    }
    const pending = await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('plain-todos-v1');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('outbox', 'readonly');
        const all = tx.objectStore('outbox').getAll();
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => reject(all.error);
        tx.oncomplete = () => db.close();
      };
    }));
    const dateMutations = pending.filter(mutation => mutation.action === 'date-display');
    expect(dateMutations.length).toBeGreaterThan(0);
    for (const view of views.filter(view => view.mode !== 'none')) {
      expect(dateMutations.filter(mutation => mutation.id === view.id).at(-1)?.fields).toEqual({ dateDisplay: view.mode });
    }
    for (const mutation of dateMutations) expect(Object.keys(mutation.fields)).toEqual(['dateDisplay']);
    expect(await pendingCount(page)).toBe(pending.length);

    await context.setOffline(false);
    await sync(page);
    await page.reload();
    otherContext = await browser.newContext();
    const other = await otherContext.newPage();
    // Download at root before using IDs: a fresh deep bookmark may redirect first.
    await other.goto('/');
    await sync(other);
    await expect(other.locator(`#favourites > div[data-id="${bookId}"]`)).toBeVisible();
    for (const client of [page, other]) {
      for (let index = 0; index < views.length; index++) {
        const view = views[index];
        if (index === 1) await client.locator(`#favourites > div[data-id="${view.id}"] > a`).click();
        else if (index > 1) await client.locator(`#contents > div[data-id="${view.id}"] > a`).click();
        await expect(client.locator('#date-display')).toHaveText(dateDisplays.find(option => option.value === view.mode).label);
        await expect(client.locator('#sort-order')).toHaveText(view.label);
        expect((await localEntity(client, view.id)).dateDisplay ?? 'none').toBe(view.mode);
        await expectRowDate(client, view.child, view.mode);
        await expectFavouriteText(client, bookId);
        if (index === views.length - 1) await expectRowDate(client, todoId, view.mode);
      }
      await client.reload();
      await expect(client).toHaveURL(new RegExp(`#entity/${listId}$`));
      await expect(client.locator('#date-display')).toHaveText('Mod Time');
      await expect(client.locator('#sort-order')).toHaveText('Modified asc');
      await expectRowDate(client, noteId, 'modified-time');
      await expect(client.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
      await expect(client.locator('#error')).toBeHidden();
    }
    for (const original of originals) {
      const entity = await localEntity(other, original.id);
      expect(entity.createdAt).toBe(original.createdAt);
      expect(entity.modifiedAt).toBe(original.modifiedAt);
    }
  } finally {
    await context.setOffline(false);
    try { await restoreRootDateDisplay(page, favouriteIds); }
    finally { await otherContext?.close(); }
  }
});

test('Trash and hashtags share the root date mode after sort without Undo or changing container preferences', async ({ page }) => {
  await page.goto('/');
  await sync(page);
  try {
    const ids = [];
    for (const [type, name] of [['notebook', 'Date special book #date-special'], ['folder', 'Date special folder'], ['list', 'Date special list']]) {
      await add(page, type, name);
      const id = await row(page, name).getAttribute('data-id');
      ids.push(id);
      await page.locator(`#contents > div[data-id="${id}"] > a[href="#entity/${id}"]`).click();
    }
    for (const type of ['note', 'todo']) {
      await add(page, type, `Date special ${type}`);
      ids.push(await row(page, `Date special ${type}`).getAttribute('data-id'));
    }
    const listId = ids[2];
    await setDateDisplay(page, 'modified-time');
    await page.locator('#breadcrumbs').getByRole('link', { name: 'Home', exact: true }).click();
    await setDateDisplay(page, 'created-date');
    await deleteContainer(page, page.locator(`#contents > div[data-id="${ids[0]}"]`));
    await expect(page.locator(`#contents > div[data-id="${ids[0]}"]`)).toHaveCount(0);
    await sync(page);
    await page.getByRole('button', { name: 'Trash', exact: true }).click();
    await expect(page.locator('#navigation > button')).toHaveText(['←', 'Trashed desc', 'Cr. Date']);
    await expect(page.locator('#navigation > #sort-order + #date-display')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
    for (const id of ids) await expectRowDate(page, id, 'created-date', true);
    await page.locator('#date-display').click();
    await expect(page.locator('#date-display')).toHaveText('Cr. Time');
    for (const id of ids) await expectRowDate(page, id, 'created-time', true);
    await page.locator('#sort-order').click();
    await expect(page.locator('#date-display')).toHaveText('Cr. Time');
    await page.getByRole('button', { name: 'All hashtags', exact: true }).click();
    await expect(page.locator('#navigation > button')).toHaveText(['←', 'Alphabetical', 'Cr. Time']);
    await expect(page.locator('#navigation > #sort-order + #date-display')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Undo', exact: true })).toHaveCount(0);
    await page.locator('#date-display').click();
    await expect(page.locator('#date-display')).toHaveText('Mod Date');
    expect((await localEntity(page, 'root-view-settings')).dateDisplay).toBe('modified-date');
    expect((await localEntity(page, listId)).dateDisplay).toBe('modified-time');
    await page.getByRole('button', { name: 'Trash', exact: true }).click();
    await expect(page.locator('#date-display')).toHaveText('Mod Date');
    for (const id of ids) await expectRowDate(page, id, 'modified-date', true);
    await page.locator(`#contents > div[data-id="${ids[0]}"]`).getByRole('button', { name: 'Restore', exact: true }).click();
    await expect(page.locator(`#contents > div[data-id="${ids[0]}"]`)).toHaveCount(0);
    await sync(page);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.locator('#date-display')).toHaveText('Mod Date');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.locator('#breadcrumbs [aria-current="page"]')).toHaveText('🏠');
    await expect(page.locator('#date-display')).toHaveText('Mod Date');
    for (const id of ids.slice(0, 3)) await page.locator(`#contents > div[data-id="${id}"] > a[href="#entity/${id}"]`).click();
    await expect(page.locator('#date-display')).toHaveText('Mod Time');
    for (const id of ids.slice(3)) await expectRowDate(page, id, 'modified-time');
    await sync(page);
  } finally { await restoreRootDateDisplay(page); }
});

test('list creation radios and icons remain vertically centered beside the textarea at desktop and phone widths', async ({ page }) => {
  const form = page.locator('#creation form');
  await page.goto('/');
  for (const [type, name] of [['notebook', 'Centered creation book'], ['folder', 'Centered creation folder'], ['list', 'Centered creation list']]) {
    // The textarea-only layout must not change root, notebook or folder forms.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(form).toBeVisible();
      expect(await form.evaluate(element => getComputedStyle(element).display)).not.toMatch(/flex/);
      await expect(form.locator('textarea')).toHaveCount(0);
    }
    await add(page, type, name);
    await row(page, name).getByRole('link').click();
  }

  const newItem = form.getByRole('textbox', { name: 'New item', exact: true });
  const group = form.getByRole('radiogroup', { name: 'New item type', exact: true });
  const todo = group.getByRole('radio', { name: 'Todo', exact: true });
  const note = group.getByRole('radio', { name: 'Note', exact: true });
  const labels = group.locator('label');
  const addButton = form.getByRole('button', { name: 'Add', exact: true });
  const contents = page.locator('#contents');
  const listUrl = page.url();
  await expect(newItem).toHaveJSProperty('tagName', 'TEXTAREA');
  await expect(newItem).toHaveJSProperty('cols', 20);
  await expect(labels).toHaveCount(2);
  await expect(labels.locator(':scope > span[aria-hidden="true"]')).toHaveText(['☐', '📝']);
  await expect(todo).toBeChecked();
  await expect(note).not.toBeChecked();

  async function verifyAlignment(width) {
    const targets = [
      ['textarea', newItem], ['field label', form.locator(':scope > label')],
      ['radio group', group], ['Add button', addButton],
      ['Todo label', labels.nth(0)], ['Todo radio', todo],
      ['Todo icon', labels.nth(0).locator(':scope > span[aria-hidden="true"]')],
      ['Note label', labels.nth(1)], ['Note radio', note],
      ['Note icon', labels.nth(1).locator(':scope > span[aria-hidden="true"]')],
    ];
    const boxes = {};
    for (const [name, target] of targets) {
      await expect(target).toBeVisible();
      const box = await target.boundingBox();
      expect(box, `${name} at ${width}px`).not.toBeNull();
      boxes[name] = box;
      expect(box.x, `${name} left edge at ${width}px`).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, `${name} right edge at ${width}px`).toBeLessThanOrEqual(width);
    }
    const centers = Object.fromEntries(Object.entries(boxes).map(([name, box]) => [name, box.y + box.height / 2]));
    expect(Math.max(...Object.values(centers)) - Math.min(...Object.values(centers)),
      `All creation centers must agree within 1 CSS px at ${width}px: ${JSON.stringify(centers)}`).toBeLessThanOrEqual(1);
    for (const type of ['Todo', 'Note']) {
      expect(Math.abs(centers[`${type} radio`] - centers[`${type} icon`]), `${type} radio/icon centers`).toBeLessThanOrEqual(1);
      expect(boxes[`${type} radio`].x + boxes[`${type} radio`].width).toBeLessThanOrEqual(boxes[`${type} icon`].x);
    }
    expect(boxes['Todo label'].x + boxes['Todo label'].width).toBeLessThanOrEqual(boxes['Note label'].x);
    expect(boxes['radio group'].x + boxes['radio group'].width).toBeLessThanOrEqual(boxes.textarea.x);
    expect(boxes.textarea.x + boxes.textarea.width).toBeLessThanOrEqual(boxes['Add button'].x);
    const formBox = await form.boundingBox();
    expect(formBox).not.toBeNull();
    expect(formBox.x).toBeGreaterThanOrEqual(0);
    expect(formBox.x + formBox.width).toBeLessThanOrEqual(width);
    if (width === 390) {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    }
  }

  async function expectNoEditor() {
    await expect(page).toHaveURL(listUrl);
    await expect(contents.getByRole('textbox')).toHaveCount(0);
    await expect(contents.locator('.entity-panel')).toHaveCount(0);
  }

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await expect(todo).toBeChecked();
    await expect(newItem).toHaveJSProperty('rows', 2);
    await verifyAlignment(width);
    const draft = `Centered note ${width}\nPreserved second line`;
    await newItem.fill(`Centered note ${width}`);
    await newItem.press('Shift+Enter');
    await newItem.pressSequentially('Preserved second line');
    await expect(newItem).toHaveValue(draft);
    for (const [selected, other] of [[note, todo], [todo, note]]) {
      await selected.check();
      await expect(selected).toBeChecked();
      await expect(other).not.toBeChecked();
      await expect(newItem).toHaveValue(draft);
      await expectNoEditor();
    }

    const originalHeight = (await newItem.boundingBox()).height;
    try {
      // Resize naturally through the DOM property, never by injecting inline CSS.
      await newItem.evaluate(element => { element.rows = 5; });
      await expect(newItem).toHaveJSProperty('rows', 5);
      expect((await newItem.boundingBox()).height).toBeGreaterThan(originalHeight);
      await verifyAlignment(width);
      await expect(newItem).toHaveValue(draft);
    } finally { await newItem.evaluate(element => { element.rows = 2; }); }
    await expect(newItem).toHaveJSProperty('rows', 2);
    await verifyAlignment(width);

    await note.check();
    await expect(newItem).toHaveValue(draft);
    await expectNoEditor();
    await addButton.click();
    const noteRow = row(page, `Centered note ${width}`);
    await expect(noteRow.locator(':scope > .entity-text')).toHaveText(`📝 ${draft}`);
    await expect(noteRow.getByRole('checkbox')).toHaveCount(0);
    expect(await localEntity(page, await noteRow.getAttribute('data-id'))).toMatchObject({ type: 'note', text: draft });
    await expect(newItem).toHaveValue('');
    await expect(newItem).toBeFocused();

    const todoText = `Centered todo ${width}\nTodo second line`;
    await add(page, 'todo', todoText);
    const todoRow = row(page, `Centered todo ${width}`);
    await expect(todoRow.getByRole('checkbox')).not.toBeChecked();
    expect(await localEntity(page, await todoRow.getAttribute('data-id'))).toMatchObject({ type: 'todo', text: todoText });
    await expect(newItem).toHaveValue('');
    await expect(newItem).toBeFocused();
    await expectNoEditor();
    await verifyAlignment(width);
  }
  await sync(page);
});

test('existing entity editors have triple column width capped to the screen without widening new-item fields', async ({ page }) => {
  await page.goto('/');
  const newItem = page.locator('#creation').getByRole('textbox');
  const search = page.getByRole('searchbox', { name: 'Search', exact: true });

  async function verifyEditor(view, multiline) {
    await page.setViewportSize({ width: 1280, height: 800 });
    const newItemWidth = (await newItem.boundingBox()).width;
    const searchWidth = (await search.boundingBox()).width;
    expect(newItemWidth).toBeLessThan(300);
    await expect(newItem).toHaveJSProperty(multiline ? 'cols' : 'size', 20);
    await clickAction(view, 'Edit');
    const editor = view.getByRole('textbox');
    await expect(editor).toHaveJSProperty(multiline ? 'cols' : 'size', 60);
    await expect(editor).toHaveCSS('max-width', '100%');
    await expect(editor).toHaveCSS('box-sizing', 'border-box');

    for (const width of [1280, 390, 240]) {
      await page.setViewportSize({ width, height: 800 });
      const box = await editor.boundingBox();
      expect(box).not.toBeNull();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width);
      if (width === 1280) expect(box.width).toBeGreaterThan(newItemWidth * 2.5);
      else expect(box.width).toBeCloseTo(width, 0);
      expect((await newItem.boundingBox()).width).toBeCloseTo(newItemWidth, 1);
      expect((await search.boundingBox()).width).toBeCloseTo(searchWidth, 1);
      await expect(newItem).toHaveCSS('max-width', 'none');
    }
    await view.getByRole('button', { name: 'Close', exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 800 });
  }

  for (const [type, name] of [['notebook', 'Wide editor notebook'], ['folder', 'Wide editor folder'], ['list', 'Wide editor list']]) {
    await add(page, type, name);
    const view = row(page, name);
    await verifyEditor(view, false);
    await view.getByRole('link').click();
  }
  for (const type of ['note', 'todo']) {
    const text = `Wide editor ${type}`;
    await add(page, type, text);
    await verifyEditor(row(page, text), true);
  }
  await sync(page);
});

test('completed todos strike through in lists, search and favourites, including after reload and sync', async ({ page, browser }) => {
  await page.goto('/');
  await add(page, 'notebook', 'Strikethrough notebook');
  await row(page, 'Strikethrough notebook').getByRole('link').click();
  await add(page, 'folder', 'Strikethrough folder');
  await row(page, 'Strikethrough folder').getByRole('link').click();
  await add(page, 'list', 'Strikethrough list');
  await row(page, 'Strikethrough list').getByRole('link').click();
  const text = 'Completed styling #strike';
  await add(page, 'todo', text);
  await add(page, 'note', 'Note styling #strike');
  const todo = row(page, text);
  const label = todo.locator(':scope > span');
  const checkbox = todo.getByRole('checkbox');
  const id = await todo.getAttribute('data-id');
  await clickAction(todo, 'Favourite');
  const favouriteLink = `#favourites > div[data-id="${id}"] > a[href^="#entity/"]`;
  const favourite = page.locator(favouriteLink);
  await expect(label).toHaveCSS('text-decoration-line', 'none');
  await expect(favourite).toHaveCSS('text-decoration-line', 'underline');

  await checkbox.check();
  await expect(label).toHaveCSS('text-decoration-line', 'line-through');
  await expect(favourite).toHaveCSS('text-decoration-line', 'line-through');
  await expect(row(page, 'Note styling #strike').locator(':scope > span')).toHaveCSS('text-decoration-line', 'none');
  await revealActions(todo);
  await expect(todo.getByRole('button', { name: 'Edit', exact: true })).toHaveCSS('text-decoration-line', 'none');
  await clickAction(todo, 'Edit');
  await expect(todo.getByRole('textbox', { name: 'Todo text', exact: true })).toHaveCSS('text-decoration-line', 'none');
  await todo.getByRole('button', { name: 'Close', exact: true }).click();
  await sync(page);
  await page.reload();
  await expect(checkbox).toBeChecked();
  await expect(label).toHaveCSS('text-decoration-line', 'line-through');
  await expect(favourite).toHaveCSS('text-decoration-line', 'line-through');

  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto('/');
    const otherFavourite = other.locator(favouriteLink);
    await expect(otherFavourite).toHaveCSS('text-decoration-line', 'line-through');
    await otherFavourite.click();
    const otherLabel = row(other, text).locator(':scope > span');
    await expect(otherLabel).toHaveCSS('text-decoration-line', 'line-through');
    await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('#strike');
    await expect(label).toHaveCSS('text-decoration-line', 'line-through');
    await checkbox.uncheck();
    await expect(label).toHaveCSS('text-decoration-line', 'none');
    await expect(favourite).toHaveCSS('text-decoration-line', 'underline');
    await sync(page);
    await other.reload();
    await expect(row(other, text).getByRole('checkbox')).not.toBeChecked();
    await expect(otherLabel).toHaveCSS('text-decoration-line', 'none');
    await expect(otherFavourite).toHaveCSS('text-decoration-line', 'underline');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(checkbox).toBeChecked();
    await expect(label).toHaveCSS('text-decoration-line', 'line-through');
    await expect(favourite).toHaveCSS('text-decoration-line', 'line-through');
    await sync(page);
  } finally { await otherContext.close(); }
  // The browser suite shares one server; do not leave extra global favourites.
  await clickAction(todo, 'Favourite');
  await sync(page);
});

test('completed lists strike through in contents, search and favourites, including after reload and sync', async ({ page, browser }) => {
  await page.goto('/');
  await add(page, 'notebook', 'List strikethrough notebook');
  await row(page, 'List strikethrough notebook').getByRole('link').click();
  await add(page, 'folder', 'List strikethrough folder');
  await row(page, 'List strikethrough folder').getByRole('link').click();
  const name = 'Completed list styling #list-strike';
  await add(page, 'list', name);
  const listView = row(page, name);
  const link = listView.getByRole('link', { name, exact: true });
  const checkbox = listView.getByRole('checkbox', { name: `Complete ${name}`, exact: true });
  const id = await listView.getAttribute('data-id');
  await clickAction(listView, 'Favourite');
  const favouriteLink = `#favourites > div[data-id="${id}"] > a[href="#entity/${id}"]`;
  const favourite = page.locator(favouriteLink);
  await expect(link).toHaveCSS('text-decoration-line', 'underline');
  await expect(favourite).toHaveCSS('text-decoration-line', 'underline');
  await expect(checkbox).not.toBeChecked();

  await checkbox.check();
  await expect(checkbox).toBeChecked();
  await expect(link).toHaveCSS('text-decoration-line', 'line-through');
  await expect(favourite).toHaveCSS('text-decoration-line', 'line-through');
  await sync(page);
  await page.reload();
  await expect(row(page, name).getByRole('checkbox')).toBeChecked();
  await expect(link).toHaveCSS('text-decoration-line', 'line-through');
  await expect(favourite).toHaveCSS('text-decoration-line', 'line-through');

  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto('/');
    const otherFavourite = other.locator(favouriteLink);
    await expect(otherFavourite).toHaveCSS('text-decoration-line', 'line-through');
    await row(page, name).getByRole('checkbox').uncheck();
    await expect(link).toHaveCSS('text-decoration-line', 'underline');
    await expect(favourite).toHaveCSS('text-decoration-line', 'underline');
    await sync(page);
    await other.reload();
    await expect(otherFavourite).toHaveCSS('text-decoration-line', 'underline');
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(row(page, name).getByRole('checkbox')).toBeChecked();
    await expect(link).toHaveCSS('text-decoration-line', 'line-through');
    await expect(favourite).toHaveCSS('text-decoration-line', 'line-through');
    await sync(page);
  } finally { await otherContext.close(); }
  await clickAction(row(page, name), 'Favourite');
  await sync(page);
});

test('plain drill-down, expanding reactive editors, notes, checkboxes, local search and invisible trash', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading')).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.body).margin)).toBe('0px');
  await expect(page.locator('style, [style]')).toHaveCount(0);
  await expect(page.locator('link[rel="stylesheet"][href="/reset.css"]')).toHaveCount(1);
  await add(page, 'notebook', 'Daily #work');
  await page.getByRole('link', { name: 'Daily #work', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Daily #work', exact: true })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'New item type' })).toHaveCount(0);
  await add(page, 'folder', 'Projects');
  await page.getByRole('link', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Folder', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'List', exact: true })).not.toBeChecked();
  await add(page, 'folder', 'Nested');
  await page.getByRole('link', { name: 'Nested', exact: true }).click();
  await add(page, 'list', 'Today');
  await row(page, 'Today').getByRole('link').click();
  await expect(page.getByRole('combobox', { name: 'New item type' })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: 'Todo', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Note', exact: true })).not.toBeChecked();
  await add(page, 'todo', 'Buy milk #errand');
  await add(page, 'note', 'A note #memo <script>alert(1)</script>');
  await page.getByRole('checkbox', { name: 'Complete Buy milk #errand', exact: true }).check();
  const todo = row(page, 'Buy milk #errand');
  await clickAction(todo, 'Edit');
  const editor = page.getByRole('textbox', { name: 'Todo text', exact: true });
  await editor.fill('Buy oats #errand');
  await expect(row(page, 'Buy oats #errand')).toBeVisible();
  await editor.press('End');
  await editor.pressSequentially(' tomorrow');
  await expect(editor).toBeFocused();
  await expect(row(page, 'Buy oats #errand tomorrow')).toBeVisible();
  await row(page, 'Buy oats #errand tomorrow').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Complete Buy oats #errand tomorrow', exact: true })).toBeChecked();
  await sync(page);
  await page.reload();
  await expect(row(page, 'Buy oats #errand tomorrow')).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Complete Buy oats #errand tomorrow', exact: true })).toBeChecked();
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('#me');
  await expect(page.getByRole('searchbox', { name: 'Search', exact: true })).toBeFocused();
  await expect(page.locator('#contents > div')).toHaveCount(1);
  await expect(page.locator('#contents')).toContainText('<script>alert(1)</script>');
  await page.getByRole('searchbox', { name: 'Search', exact: true }).pressSequentially('mo');
  await expect(page.locator('#contents > div')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('#MEM note');
  await expect(page.locator('#contents > div')).toHaveCount(1);
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('#memx');
  await expect(page.locator('#contents > div')).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('#memo');
  await clickAction(row(page, 'A note #memo'), 'Open list');
  await expect(page.locator('#contents > div')).toHaveCount(2);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(row(page, 'Today').getByRole('link')).toBeVisible();
  await expect(row(page, 'Today').getByRole('link')).toHaveText('Today');
  await expectListCount(row(page, 'Today'), 0);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Nested', exact: true })).toBeVisible();
  await deleteContainer(page, row(page, 'Nested'));
  await expect(page.locator('#contents > div')).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('#errand');
  await expect(page.locator('#contents > div')).toHaveCount(0);
  await sync(page);
  expect(errors).toEqual([]);
});

test.describe('hashtag completion', () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test('completes the hashtag at the caret when creating and editing lists, todos and notes', async ({ page, request }) => {
    const seeded = await request.post('/api/sync', { data: { cursor: 0, mutations: [{
      opId: crypto.randomUUID(), action: 'location-create', id: crypto.randomUUID(),
      fields: { name: 'Completion pharmacy #pills-pharmacy', latitude: 0, longitude: 0, userLocation: false },
    }] } });
    expect(seeded.ok()).toBe(true);
    await page.goto('/');
    const notebook = `Completion book ${crypto.randomUUID()} #PILLS-supermarket #pills-supper`;
    await add(page, 'notebook', notebook);
    await row(page, notebook).getByRole('link', { name: notebook, exact: true }).click();
    await add(page, 'folder', 'Completion folder #pills-supermarket');
    await row(page, 'Completion folder').getByRole('link', { name: 'Completion folder #pills-supermarket', exact: true }).click();
    await page.getByRole('radio', { name: 'List', exact: true }).check();

    const creation = page.locator('#creation').getByRole('textbox');
    const suggestions = page.getByRole('group', { name: 'Hashtag suggestions' });
    const pill = name => suggestions.getByRole('button', { name, exact: true });
    await creation.fill('Weekend #');
    await expect(suggestions).toHaveCount(0);
    await creation.pressSequentially('P');
    await expect(pill('#pills-pharmacy')).toBeVisible();
    await expect(pill('#pills-supermarket')).toBeVisible();
    await creation.pressSequentially('ills-s');
    await expect(suggestions.getByRole('button')).toHaveText(['#pills-supermarket', '#pills-supper']);
    const fieldBox = await creation.boundingBox();
    const pillBox = await pill('#pills-supper').boundingBox();
    expect(pillBox.y).toBeGreaterThanOrEqual(fieldBox.y + fieldBox.height);
    await pill('#pills-supper').tap();
    await expect(creation).toHaveValue('Weekend #pills-supper ');
    await expect(creation).toBeFocused();
    await expect(suggestions).toHaveCount(0);
    await expect(row(page, 'Weekend')).toHaveCount(0);
    await creation.press('Enter');

    const list = row(page, 'Weekend');
    await clickAction(list, 'Edit');
    const listEditor = list.getByRole('textbox', { name: 'Name' });
    await listEditor.fill('Weekend #pills-superx, bring bags');
    await expect(suggestions).toHaveCount(0);
    await listEditor.evaluate(field => {
      const end = field.value.indexOf(',');
      field.setSelectionRange(end, end);
    });
    await listEditor.press('ArrowLeft');
    await expect(suggestions.getByRole('button')).toHaveText(['#pills-supermarket']);
    await listEditor.press('Tab');
    await expect(pill('#pills-supermarket')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(listEditor).toBeFocused();
    await expect(listEditor).toHaveValue('Weekend #pills-supermarket, bring bags');
    await expect(suggestions).toHaveCount(0);
    await listEditor.press('Enter');
    await list.getByRole('link', { name: 'Weekend #pills-supermarket, bring bags', exact: true }).click();

    await creation.fill('Buy soy milk#pills-s');
    await expect(suggestions).toHaveCount(0);
    await creation.fill('Buy soy milk #pills-s');
    await pill('#pills-supermarket').tap();
    await creation.pressSequentially('tomorrow');
    await creation.press('Enter');
    const todo = row(page, 'Buy soy milk');
    await expect(todo).toContainText('Buy soy milk #pills-supermarket tomorrow');
    await clickAction(todo, 'Edit');
    const todoEditor = todo.getByRole('textbox', { name: 'Todo text' });
    await todoEditor.fill('Buy soy milk #pills-p');
    await pill('#pills-pharmacy').tap();
    await expect(todoEditor).toHaveValue('Buy soy milk #pills-pharmacy ');
    await todo.getByRole('button', { name: 'Close', exact: true }).click();
    expect(await localEntity(page, await todo.getAttribute('data-id'))).toMatchObject({
      text: 'Buy soy milk #pills-pharmacy ', tags: ['pills-pharmacy'],
    });
    await clickAction(todo, 'Edit');
    await todoEditor.press('End');
    await todoEditor.press('ArrowLeft');
    await expect(pill('#pills-pharmacy')).toBeVisible();
    await todo.getByRole('button', { name: 'Close', exact: true }).tap();
    await expect(todoEditor).toHaveCount(0);

    await page.getByRole('radio', { name: 'Note', exact: true }).check();
    await creation.fill('Soy milk brands\nTry #pills-s');
    await pill('#pills-supper').tap();
    await expect(creation).toHaveValue('Soy milk brands\nTry #pills-supper ');
    await creation.press('Enter');
    const note = row(page, 'Soy milk brands');
    await clickAction(note, 'Edit');
    const noteEditor = note.getByRole('textbox', { name: 'Note text' });
    await noteEditor.fill('Soy milk brands\nTry #pills-p');
    await pill('#pills-pharmacy').tap();
    await expect(noteEditor).toHaveValue('Soy milk brands\nTry #pills-pharmacy ');
    await noteEditor.press('Enter');
    await expect(noteEditor).toHaveCount(0);
    expect(await localEntity(page, await note.getAttribute('data-id'))).toMatchObject({
      type: 'note', text: 'Soy milk brands\nTry #pills-pharmacy ', tags: ['pills-pharmacy'],
    });
  });

  test('changing suggestions keeps the page and the focused textbox in place', async ({ page, request }) => {
    const bookId = crypto.randomUUID();
    const folderId = crypto.randomUUID();
    const listId = crypto.randomUUID();
    const prefix = `layout-${listId.slice(0, 8)}`;
    const mutation = (id, fields) => ({ opId: crypto.randomUUID(), action: 'create', id, fields });
    const seeded = await request.post('/api/sync', { data: { cursor: 0, mutations: [
      mutation(bookId, { type: 'notebook', parentId: null, name: 'Suggestion layout notebook' }),
      mutation(folderId, { type: 'folder', parentId: bookId, name: 'Suggestion layout folder' }),
      mutation(listId, { type: 'list', parentId: folderId, name: 'Suggestion layout list' }),
      ...Array.from({ length: 40 }, (_, index) => mutation(crypto.randomUUID(), {
        type: 'todo', parentId: listId, text: `Todo ${index} #${prefix}-${index}`,
      })),
    ] } });
    expect((await seeded.json()).acknowledgements.every(receipt => receipt.accepted)).toBe(true);
    await page.setViewportSize({ width: 390, height: 480 });
    await page.goto(`/#entity/${listId}`);

    const suggestions = page.getByRole('group', { name: 'Hashtag suggestions' });
    const matchingPills = suggestions.getByRole('button', { name: new RegExp(`^#${prefix}-`) });
    const layout = field => field.evaluate(input => {
      const { top, left, width, height } = input.getBoundingClientRect();
      return { top, left, width, height, scrollY: window.scrollY, pageHeight: document.scrollingElement.scrollHeight };
    });

    async function verifyLayout(field) {
      await field.fill('Keep #');
      await expect(suggestions).toHaveCount(0);
      const before = await layout(field);
      await field.pressSequentially(`${prefix}-`);
      await expect(matchingPills).toHaveCount(40);
      await expect.poll(() => layout(field)).toEqual(before);
      await field.pressSequentially('39');
      await expect(matchingPills).toHaveCount(1);
      await expect(matchingPills).toBeInViewport();
      await expect.poll(() => layout(field)).toEqual(before);
      await field.press('Space');
      await expect(suggestions).toHaveCount(0);
      await expect(field).toBeFocused();
      await expect.poll(() => layout(field)).toEqual(before);
      await field.press('Backspace');
      await expect(matchingPills).toHaveCount(1);
      await matchingPills.tap();
      await expect(field).toHaveValue(`Keep #${prefix}-39 `);
      await expect(suggestions).toHaveCount(0);
      await expect(field).toBeFocused();
      await expect.poll(() => layout(field)).toEqual(before);
    }

    await verifyLayout(page.locator('#creation').getByRole('textbox'));
    const target = page.locator('#contents > [data-id]').nth(20);
    await clickAction(target, 'Edit');
    const editor = target.getByRole('textbox', { name: 'Todo text' });
    await editor.evaluate(field => window.scrollBy(0, field.getBoundingClientRect().bottom - (innerHeight - 45)));
    expect((await layout(editor)).scrollY).toBeGreaterThan(0);
    await verifyLayout(editor);
  });

  test('the version link opens settings and the location-only exclusion saves offline and syncs', async ({ page, context, browser, request }) => {
    const notebookId = crypto.randomUUID();
    const folderId = crypto.randomUUID();
    const listId = crypto.randomUUID();
    const prefix = `completion-${listId.slice(0, 8)}`;
    const seeded = await request.post('/api/sync', { data: { cursor: 0, mutations: [
      { opId: crypto.randomUUID(), action: 'create', id: notebookId,
        fields: { type: 'notebook', parentId: null, name: `Settings notebook #${prefix}-shared` } },
      { opId: crypto.randomUUID(), action: 'create', id: folderId,
        fields: { type: 'folder', parentId: notebookId, name: 'Settings folder' } },
      { opId: crypto.randomUUID(), action: 'create', id: listId,
        fields: { type: 'list', parentId: folderId, name: 'Settings list' } },
      { opId: crypto.randomUUID(), action: 'location-create', id: crypto.randomUUID(),
        fields: { name: `Settings location #${prefix}-only #${prefix.toUpperCase()}-SHARED`, latitude: 0, longitude: 0, userLocation: false } },
    ] } });
    expect((await seeded.json()).acknowledgements.every(receipt => receipt.accepted)).toBe(true);

    const listUrl = `/#entity/${listId}`;
    await page.goto(listUrl);
    const field = page.locator('#creation').getByRole('textbox');
    const suggestions = page.getByRole('group', { name: 'Hashtag suggestions' }).getByRole('button');
    await field.fill(`#${prefix}`);
    await expect(suggestions).toHaveText([`#${prefix}-only`, `#${prefix}-shared`]);
    await sync(page);
    await expect(page.locator('#service-worker-status')).toHaveAttribute('data-state', 'active');

    await context.setOffline(true);
    const version = page.getByRole('link', { name: /^v\d+\.\d+\.\d+$/ });
    const exclusion = page.getByRole('checkbox', { name: 'Exclude hashtags used only in Locations' });
    await version.click();
    await expect(page).toHaveURL('/#settings');
    await expect(exclusion).not.toBeChecked();
    await exclusion.check();
    await expect(exclusion).toBeEnabled();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page).toHaveURL(listUrl);
    await field.fill(`#${prefix}`);
    await expect(suggestions).toHaveText([`#${prefix}-shared`]);

    await version.click();
    await expect(exclusion).toBeChecked();
    await page.reload();
    await expect(exclusion).toBeChecked();
    await context.setOffline(false);
    await sync(page);

    const other = await browser.newPage();
    try {
      await other.goto(page.url());
      const syncedExclusion = other.getByRole('checkbox', { name: 'Exclude hashtags used only in Locations' });
      await expect(syncedExclusion).toBeChecked();
      await exclusion.uncheck();
      await sync(page);
      await expect(syncedExclusion).not.toBeChecked();
    } finally {
      await other.close();
    }
  });
});

test('the list layout checkbox reorders controls offline and is copied on rollover', async ({ page, context, browser }) => {
  const server = createServer();
  const events = createSyncEvents(server);
  const store = createStore(':memory:', { onChange: events.notify });
  server.on('request', createApp(store));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;

  try {
    await page.setViewportSize({ width: 390, height: 360 });
    const [book, folder, source, otherList] = Array.from({ length: 4 }, () => crypto.randomUUID());
    const todoIds = Array.from({ length: 30 }, () => crypto.randomUUID());
    const create = (id, type, parentId, fields) => ({
      opId: crypto.randomUUID(), action: 'create', id, fields: { type, parentId, ...fields },
    });
    const seeded = store.sync({ cursor: 0, mutations: [
      create(book, 'notebook', null, { name: 'Layout notebook' }),
      create(folder, 'folder', book, { name: 'Layout folder' }),
      create(source, 'list', folder, { name: 'Layout 20/11/2026' }),
      create(otherList, 'list', folder, { name: 'Unrelated list' }),
      ...todoIds.map((id, index) => create(id, 'todo', source, { text: `Layout todo ${index}` })),
      { opId: crypto.randomUUID(), action: 'update', id: todoIds[0], fields: { pinned: true, favourite: true } },
    ] });
    expect(seeded.acknowledgements.every(receipt => receipt.accepted)).toBe(true);

    const sourceUrl = `${url}/#entity/${source}`;
    await page.goto(sourceUrl);
    await expect(page.locator('#contents')).toContainText('Layout todo 0');
    await sync(page);
    const actions = page.getByLabel('List actions', { exact: true });
    const layout = page.getByRole('checkbox', { name: 'Move controls below the list', exact: true });
    const draft = page.getByRole('textbox', { name: 'New item', exact: true });
    await draft.fill('Draft stays above the list');
    await context.setOffline(true);
    await actions.click();
    await expect(layout).not.toBeChecked();
    await layout.check();
    await expect(page.locator('#controls + #contents')).toHaveCount(1);
    await expect(page.locator('#contents ~ #pinned')).toBeVisible();
    await expect(page.locator('#contents ~ #favourites')).toBeVisible();
    await expect(page.locator('#contents ~ #breadcrumbs')).toBeVisible();
    await expect(page.locator('#contents ~ div #search')).toBeVisible();
    await expect(page.locator('#contents ~ #navigation')).toBeVisible();
    await expect(draft).toHaveValue('Draft stays above the list');
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(actions).toBeInViewport();
    await expect(page.getByRole('button', { name: 'Back', exact: true })).toBeInViewport();
    expect(await localEntity(page, source)).toHaveProperty('controlsBelow', true);
    expect(await localEntity(page, otherList)).not.toHaveProperty('controlsBelow');

    await context.setOffline(false);
    await sync(page);
    await page.reload();
    await expect(page.locator('#contents ~ #navigation')).toBeVisible();
    await actions.click();
    await expect(layout).toBeChecked();
    await page.getByRole('button', { name: 'Move items to next day / list', exact: true }).click();
    await page.getByRole('button', { name: 'Create list and move 30 items', exact: true }).click();
    await page.getByRole('button', { name: 'Open list', exact: true }).click();
    const destination = (await localEntity(page, todoIds[0])).parentId;
    await expect(page).toHaveURL(`${url}/#entity/${destination}`);
    await expect(page.locator('#contents ~ #navigation')).toBeVisible();
    await sync(page);

    const saved = await browser.newPage();
    try {
      await saved.goto(page.url());
      await expect(saved.locator('#contents ~ #navigation')).toBeVisible();
      await saved.getByLabel('List actions', { exact: true }).click();
      await saved.getByRole('checkbox', { name: 'Move controls below the list', exact: true }).uncheck();
      await expect(saved.locator('#navigation + #contents')).toHaveCount(1);
      await sync(saved);
      await saved.goto(sourceUrl);
      await expect(saved.locator('#contents ~ #navigation')).toBeVisible();
      await saved.getByRole('button', { name: 'Back', exact: true }).click();
      await expect(saved).toHaveURL(`${url}/#entity/${folder}`);
      await expect(saved.locator('#navigation + #contents')).toHaveCount(1);
    } finally {
      await saved.close();
    }
  } finally {
    events.close();
    await new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    });
    store.close();
  }
});

test('the list menu moves items offline and Undo returns them as a group', async ({ page, context, request }) => {
  const [book, folder, source, target, todo, done, note] = Array.from({ length: 7 }, () => crypto.randomUUID());
  const create = (id, type, parentId, fields) => ({
    opId: crypto.randomUUID(), action: 'create', id, fields: { type, parentId, ...fields },
  });
  const seeded = await request.post('/api/sync', { data: { cursor: 0, mutations: [
    create(book, 'notebook', null, { name: 'Rollover notebook' }),
    create(folder, 'folder', book, { name: 'Rollover folder' }),
    create(source, 'list', folder, { name: 'Work 20/11/2026 #office' }),
    create(target, 'list', folder, { name: 'Work 23/11/2026 #office' }),
    create(todo, 'todo', source, { text: 'Open todo' }),
    create(done, 'todo', source, { text: 'Completed todo', checked: true }),
    create(note, 'note', source, { text: 'Keep this note' }),
  ] } });
  expect((await seeded.json()).acknowledgements.every(receipt => receipt.accepted)).toBe(true);

  const sourceUrl = `/#entity/${source}`;
  await page.goto(sourceUrl);
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  const openDialog = async () => {
    await page.getByLabel('List actions', { exact: true }).click();
    await page.getByRole('button', { name: 'Move items to next day / list', exact: true }).click();
    return page.getByRole('dialog', { name: 'Move items to next day / list' });
  };
  const contents = page.locator('#contents');
  await expect(contents).toContainText('Open todo');
  await sync(page);
  await context.setOffline(true);
  const dialog = await openDialog();
  const destination = dialog.getByRole('textbox', { name: 'Destination list' });
  await expect(destination).toHaveValue('Work 21/11/2026 #office');
  await dialog.getByRole('button', { name: '+2 days', exact: true }).click();
  await expect(destination).toHaveValue('Work 22/11/2026 #office');
  await dialog.getByRole('button', { name: 'Pick a date', exact: true }).click();
  await dialog.getByLabel('Move date', { exact: true }).fill('2026-12-31');
  await expect(destination).toHaveValue('Work 31/12/2026 #office');
  await dialog.getByRole('button', { name: '+1 day', exact: true }).click();
  await dialog.getByRole('button', { name: 'Create list and move 1 item', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page).toHaveURL(sourceUrl);
  await expect(contents).not.toContainText('Open todo');
  await expect(contents).toContainText('Completed todo');
  await expect(contents).toContainText('Keep this note');
  const tomorrow = (await localEntity(page, todo)).parentId;
  expect(await localEntity(page, tomorrow)).toMatchObject({ name: 'Work 21/11/2026 #office', parentId: folder });

  await openDialog();
  await expect(dialog.getByRole('button', { name: 'Incomplete (0)', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog.getByRole('button', { name: 'Move 0 items', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await undo.click();
  await expect(contents).toContainText('Open todo');
  expect(await localEntity(page, tomorrow)).toHaveProperty('deletedAt', expect.any(String));

  await openDialog();
  await dialog.getByRole('button', { name: '+3 days', exact: true }).click();
  await dialog.getByRole('button', { name: 'All (3)', exact: true }).click();
  await dialog.getByRole('button', { name: 'Selected (3)', exact: true }).click();
  await dialog.getByRole('checkbox', { name: 'Open todo', exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Move 2 items', exact: true }).click();
  await expect(page).toHaveURL(sourceUrl);
  await expect(contents).toContainText('Open todo');
  await expect(contents).not.toContainText('Completed todo');
  await page.getByRole('button', { name: 'Open list', exact: true }).click();
  await expect(page).toHaveURL(`/#entity/${target}`);
  await expect(contents.getByRole('checkbox', { name: 'Complete Completed todo', exact: true })).toBeChecked();
  await expect(contents).toContainText('Keep this note');
  await context.setOffline(false);
  await sync(page);
  await undo.click();
  await expect(contents).not.toContainText('Completed todo');
  expect(await localEntity(page, target)).toHaveProperty('deletedAt', null);
  expect(await localEntity(page, note)).toHaveProperty('parentId', source);

  await sync(page);
  await page.goto(sourceUrl);
  await expect(contents).toContainText('Open todo');
  await sync(page);
  await context.setOffline(true);
  await openDialog();
  await dialog.getByRole('button', { name: '+2 days', exact: true }).click();
  await dialog.getByRole('button', { name: 'Create list and move 1 item', exact: true }).click();
  await expect(contents).not.toContainText('Open todo');
  const conflict = await request.post('/api/sync', { data: { cursor: 0, mutations: [
    create(crypto.randomUUID(), 'list', folder, { name: 'Work 22/11/2026 #office' }),
  ] } });
  expect((await conflict.json()).acknowledgements[0].accepted).toBe(true);
  await context.setOffline(false);
  await sync(page);
  await expect(contents).toContainText('Open todo');
  await expect(page.locator('#sync-errors')).toContainText('The destination already exists.');
  await expect(undo).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Open list', exact: true })).toHaveCount(0);
});

test('folder calendar button creates a list with the current local date and preserves the input', async ({ page }) => {
  await page.goto('/');
  const calendar = page.getByRole('button', { name: "Add today's list", exact: true });
  await expect(calendar).toHaveCount(0);
  await add(page, 'notebook', 'Calendar notebook');
  await page.getByRole('link', { name: 'Calendar notebook', exact: true }).click();
  await expect(calendar).toHaveCount(0);
  await add(page, 'folder', 'Calendar folder');
  const folderId = await row(page, 'Calendar folder').getAttribute('data-id');
  await page.getByRole('link', { name: 'Calendar folder', exact: true }).click();
  await page.clock.setFixedTime(await page.evaluate(() => new Date(2026, 0, 5, 12).getTime()));
  await calendar.click();
  await expect(row(page, '05/01/2026').getByRole('link')).toBeVisible();
  await expect(row(page, '05/01/2026').getByRole('link')).toHaveText('05/01/2026');
  await expectListCount(row(page, '05/01/2026'), 0);
  const listId = await row(page, '05/01/2026').getAttribute('data-id');
  expect(await localEntity(page, listId)).toMatchObject({ type: 'list', parentId: folderId, name: '05/01/2026', checked: false });
  const input = page.getByRole('textbox', { name: 'New item', exact: true });
  await expect(input).toBeFocused();
  await input.fill('Unfinished folder name');
  await page.clock.setFixedTime(await page.evaluate(() => new Date(2026, 0, 6, 12).getTime()));
  await calendar.click();
  await expect(row(page, '06/01/2026').getByRole('link')).toBeVisible();
  await expect(row(page, '06/01/2026').getByRole('link')).toHaveText('06/01/2026');
  await expectListCount(row(page, '06/01/2026'), 0);
  await expect(input).toHaveValue('Unfinished folder name');
  await row(page, '06/01/2026').getByRole('link').click();
  await expect(calendar).toHaveCount(0);
});

test('sort cycles all four date orders per view, persists after reload and syncs to another browser', async ({ page, context, browser }) => {
  await page.clock.install();
  await page.goto('/');
  await expect(page.locator('#creation').getByRole('textbox')).toBeFocused();
  await sync(page);
  await context.setOffline(true);
  const sort = page.locator('#sort-order');
  const views = [];
  let time = new Date('2026-01-01T12:00:00Z').getTime();
  for (const [level, type] of [['root', 'notebook'], ['notebook', 'folder'], ['folder', 'list'], ['list', 'todo']]) {
    const prefix = `Sort ${level}`;
    await expect(sort).toHaveText('Created desc');
    expect(await page.locator('#navigation > button').nth(1).getAttribute('id')).toBe('sort-order');
    const ids = [];
    for (const suffix of ['A', 'B', 'C']) {
      await page.clock.setFixedTime(time += 1000);
      await add(page, type, `${prefix} ${suffix}`);
      ids.push(await row(page, `${prefix} ${suffix}`).getAttribute('data-id'));
    }
    await page.clock.setFixedTime(time += 1000);
    await clickAction(row(page, `${prefix} A`), 'Edit');
    await row(page, `${prefix} A`).getByRole('textbox').fill(`${prefix} A edited`);
    await row(page, `${prefix} A`).getByRole('button', { name: 'Close', exact: true }).click();
    const orderedIds = () => row(page, prefix).evaluateAll(rows => rows.map(row => row.dataset.id));
    for (const [label, order] of [
      ['Created desc', [ids[2], ids[1], ids[0]]],
      ['Created asc', ids],
      ['Modified desc', [ids[0], ids[2], ids[1]]],
      ['Modified asc', [ids[1], ids[2], ids[0]]],
    ]) {
      await expect(sort).toHaveText(label);
      await expect.poll(orderedIds).toEqual(order);
      await sort.click();
    }
    await expect(sort).toHaveText('Created desc');
    // Keep distinct choices for each page, including a return to the default.
    const clicks = views.length;
    for (let i = 0; i < clicks; i++) await sort.click();
    const label = ['Created desc', 'Created asc', 'Modified desc', 'Modified asc'][clicks];
    await expect(sort).toHaveText(label);
    views.push({ hash: new URL(page.url()).hash, label });
    if (level !== 'list') await row(page, `${prefix} A edited`).getByRole('link').click();
  }
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('Sort list');
  await expect(sort).toHaveText('Modified asc');
  await expect(row(page, 'Sort list')).toHaveCount(3);
  await context.setOffline(false);
  await sync(page);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    for (const view of views) {
      await page.goto(`/${view.hash}`);
      await expect(sort).toHaveText(view.label);
      await other.goto(`/${view.hash}`);
      await expect(other.locator('#sort-order')).toHaveText(view.label);
    }
  } finally { await otherContext.close(); }
});

test('navigation, edits and search use IndexedDB during network loss; reconnect pushes changes to another browser', async ({ page, context, browser }) => {
  await page.goto('/');
  await add(page, 'notebook', 'Disconnected notebook');
  await page.getByRole('link', { name: 'Disconnected notebook', exact: true }).click();
  await add(page, 'folder', 'Disconnected folder');
  await page.getByRole('link', { name: 'Disconnected folder', exact: true }).click();
  await add(page, 'list', 'Disconnected list');
  await row(page, 'Disconnected list').getByRole('link').click();
  await sync(page);
  await context.setOffline(true);
  await add(page, 'todo', 'Offline task #offline');
  await page.getByRole('checkbox', { name: 'Complete Offline task #offline', exact: true }).check();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(row(page, 'Disconnected list').getByRole('link')).toBeVisible();
  await expect(row(page, 'Disconnected list').getByRole('link')).toHaveText('Disconnected list');
  await expectListCount(row(page, 'Disconnected list'), 0);
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('#offline');
  await expect(page.getByRole('checkbox', { name: 'Complete Offline task #offline', exact: true })).toBeChecked();
  expect(await pendingCount(page)).toBeGreaterThan(0);
  await context.setOffline(false);
  await sync(page);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto('/');
    await other.getByRole('searchbox', { name: 'Search', exact: true }).fill('#offline');
    await expect(other.getByRole('checkbox', { name: 'Complete Offline task #offline', exact: true })).toBeChecked();
  } finally { await otherContext.close(); }
});

test('two browsers converge on the last edit accepted by the server', async ({ page, browser }) => {
  await page.goto('/');
  await add(page, 'notebook', 'Shared #conflict');
  await sync(page);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto('/');
    await expect(other.getByRole('link', { name: 'Shared #conflict', exact: true })).toBeVisible();
    await row(page, 'Shared #conflict').getByRole('button', { name: 'Edit', exact: true }).click();
    await row(other, 'Shared #conflict').getByRole('button', { name: 'Edit', exact: true }).click();
    await row(page, 'Shared #conflict').getByRole('textbox', { name: 'Name', exact: true }).fill('First edit #conflict');
    await sync(page);
    await other.getByRole('textbox', { name: 'Name', exact: true }).fill('Last edit #conflict');
    await sync(other);
    await page.bringToFront();
    await expect(page.getByRole('link', { name: 'Last edit #conflict', exact: true })).toBeVisible({ timeout: 15000 });
    await expect(other.getByRole('link', { name: 'Last edit #conflict', exact: true })).toBeVisible();
  } finally { await otherContext.close(); }
});

test('text autosave waits two seconds after the last input and flushes on close and navigation', async ({ page, request }) => {
  await page.clock.install();
  await page.goto('/');
  await add(page, 'notebook', 'Debounce original');
  await sync(page);
  const id = await row(page, 'Debounce original').getAttribute('data-id');
  const view = page.locator(`#contents > div[data-id="${id}"]`);
  await page.clock.pauseAt(new Date());
  await view.getByRole('button', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Name', exact: true });
  await editor.fill('First unsaved draft');
  await page.clock.runFor(1500);
  expect((await localEntity(page, id)).name).toBe('Debounce original');
  await editor.fill('Final debounce draft');
  await page.clock.runFor(1999);
  expect((await localEntity(page, id)).name).toBe('Debounce original');
  await page.clock.runFor(1);
  await expect.poll(async () => (await localEntity(page, id)).name).toBe('Final debounce draft');
  await expect.poll(async () => {
    const response = await request.post('/api/sync', { data: { cursor: 0, mutations: [] } });
    const data = await response.json();
    return data.changes.filter(change => change.entity.id === id).map(change => change.entity.name);
  }).toEqual(['Debounce original', 'Final debounce draft']);

  // Invalid names cancel the timer for a preceding valid draft.
  await editor.fill('Do not save this intermediate name');
  await page.clock.runFor(1000);
  await editor.fill('');
  await page.clock.runFor(2000);
  expect((await localEntity(page, id)).name).toBe('Final debounce draft');
  await expect(view).toContainText('A name is required.');

  await editor.fill('Close flush draft');
  await view.getByRole('button', { name: 'Close', exact: true }).click();
  await expect.poll(async () => (await localEntity(page, id)).name).toBe('Close flush draft');
  await view.getByRole('button', { name: 'Edit', exact: true }).click();
  await editor.fill('Navigation flush draft');
  await view.getByRole('link').click();
  await expect(page.locator('#contents > div')).toHaveCount(0);
  expect((await localEntity(page, id)).name).toBe('Navigation flush draft');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await view.getByRole('button', { name: 'Edit', exact: true }).click();
  await editor.fill('Automatic sync draft');
  await page.clock.runFor(2000);
  await sync(page);
  expect((await localEntity(page, id)).name).toBe('Automatic sync draft');

  // Deleting cancels a draft instead of letting its timer edit an item in trash.
  await editor.fill('Discarded pending draft');
  await deleteContainer(page, view);
  await expect(view).toHaveCount(0);
  await page.clock.runFor(2000);
  await expect.poll(async () => Boolean((await localEntity(page, id)).deletedAt)).toBe(true);
  await expect(page.locator('#error')).toBeHidden();
});

test('mobile SIP Enter accepts new items and editors without keydown or unwanted newlines', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.goto('/');
    const form = page.locator('#creation form');
    const newItem = form.getByRole('textbox');
    const addButton = form.locator('button[type="submit"]');
    await expect(newItem).not.toBeFocused();

    async function sipEnter(field, inputType = 'insertLineBreak', cancelable = true) {
      return field.evaluate((element, { inputType, cancelable }) => {
        // Some Android keyboards report only an unidentified key before input.
        element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Unidentified', keyCode: 229, bubbles: true }));
        const before = new InputEvent('beforeinput', { inputType, data: '\n', bubbles: true, cancelable });
        element.dispatchEvent(before);
        if (!before.defaultPrevented && element.tagName === 'TEXTAREA') {
          element.setRangeText('\n', element.selectionStart, element.selectionEnd, 'end');
          element.dispatchEvent(new InputEvent('input', { inputType, data: '\n', bubbles: true }));
        }
        return before.defaultPrevented;
      }, { inputType, cancelable });
    }

    for (const type of ['notebook', 'folder', 'list']) {
      await expect(addButton).toBeVisible();
      if (type === 'list') await page.getByRole('radio', { name: 'List', exact: true }).check();
      const name = `SIP ${type}`;
      await newItem.tap();
      await newItem.fill(name);
      await expect(newItem).toHaveAttribute('enterkeyhint', 'done');
      expect(await sipEnter(newItem, 'insertParagraph')).toBe(true);
      await expect(row(page, name)).toBeVisible();
      const id = await row(page, name).getAttribute('data-id');
      const view = page.locator(`#contents > div[data-id="${id}"]`);
      await expect(newItem).toHaveValue('');
      await view.getByRole('button', { name: 'Edit', exact: true }).tap();
      const editor = view.getByRole('textbox', { name: 'Name', exact: true });
      await expect(editor).toHaveAttribute('enterkeyhint', 'done');
      await editor.fill('');
      expect(await sipEnter(editor)).toBe(true);
      await expect(editor).toBeVisible();
      await expect(view).toContainText('A name is required.');
      const renamed = `${name} renamed`;
      await editor.fill(renamed);
      expect(await sipEnter(editor)).toBe(true);
      await expect(editor).toHaveCount(0);
      expect((await localEntity(page, id)).name).toBe(renamed);
      await view.getByRole('link').tap();
    }

    await expect(addButton).toHaveCSS('display', 'none');
    expect((await form.boundingBox()).height).toBe((await newItem.boundingBox()).height);
    for (const type of ['note', 'todo']) {
      await page.getByRole('radio', { name: type === 'todo' ? 'Todo' : 'Note', exact: true }).check();
      for (const cancelable of [true, false]) {
        const inputType = cancelable ? 'insertLineBreak' : 'insertParagraph';
        const prefix = `SIP ${type} ${cancelable ? 'cancelable' : 'fallback'}`;
        const text = `${prefix}\nPasted second line`;
        await newItem.tap();
        await newItem.fill(text);
        await expect(newItem).toHaveAttribute('enterkeyhint', 'done');
        // IME confirmation must leave the draft in its field rather than add it.
        expect(await newItem.evaluate(element => {
          element.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
          const event = new InputEvent('beforeinput', { inputType: 'insertLineBreak', bubbles: true, cancelable: true });
          element.dispatchEvent(event);
          element.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
          return event.defaultPrevented;
        })).toBe(false);
        await expect(row(page, prefix)).toHaveCount(0);
        await expect(newItem).toHaveValue(text);
        expect(await sipEnter(newItem, inputType, cancelable)).toBe(cancelable);
        const view = row(page, prefix);
        await expect(view).toBeVisible();
        const id = await view.getAttribute('data-id');
        expect((await localEntity(page, id)).text).toBe(text);
        await expect(newItem).toHaveValue('');
        await expect(view).toHaveCount(1);

        await revealActions(view);
        await view.getByRole('button', { name: 'Edit', exact: true }).tap();
        const editor = view.getByRole('textbox');
        const updated = `${prefix} saved\nExisting second line`;
        await editor.fill(updated);
        await expect(editor).toHaveAttribute('enterkeyhint', 'done');
        expect(await sipEnter(editor, inputType, cancelable)).toBe(cancelable);
        await expect(editor).toHaveCount(0);
        expect((await localEntity(page, id)).text).toBe(updated);
      }
    }
    await sync(page);
  } finally { await context.close(); }
});

test('Enter creates items and saves editors immediately; Shift+Enter preserves line breaks', async ({ page }) => {
  await page.clock.install();
  await page.goto('/');
  const newItem = page.locator('#creation').getByRole('textbox');
  await expect(newItem).toBeFocused();
  await newItem.fill('Keyboard notebook');
  await newItem.press('Enter');
  await expect(page.getByRole('link', { name: 'Keyboard notebook', exact: true })).toBeVisible();
  const notebookId = await row(page, 'Keyboard notebook').getAttribute('data-id');
  const notebook = page.locator(`#contents > div[data-id="${notebookId}"]`);
  await notebook.getByRole('button', { name: 'Edit', exact: true }).click();
  const nameEditor = page.getByRole('textbox', { name: 'Name', exact: true });
  await nameEditor.fill('');
  await nameEditor.press('Enter');
  await expect(nameEditor).toBeFocused();
  await expect(notebook).toContainText('A name is required.');
  expect((await localEntity(page, notebookId)).name).toBe('Keyboard notebook');
  await nameEditor.fill('Keyboard renamed');
  await nameEditor.press('Enter');
  await expect(nameEditor).toHaveCount(0);
  expect((await localEntity(page, notebookId)).name).toBe('Keyboard renamed');
  await notebook.getByRole('link').click();
  await expect(newItem).toBeFocused();

  await newItem.fill('Keyboard folder');
  await newItem.press('Enter');
  await page.getByRole('link', { name: 'Keyboard folder', exact: true }).click();
  await expect(newItem).toBeFocused();
  await page.getByRole('radio', { name: 'List', exact: true }).check();
  await newItem.fill('Keyboard list');
  await newItem.press('Enter');
  await row(page, 'Keyboard list').getByRole('link').click();
  await expect(newItem).toBeFocused();
  await sync(page);
  await page.clock.pauseAt(new Date());

  for (const type of ['note', 'todo']) {
    await page.getByRole('radio', { name: type === 'todo' ? 'Todo' : 'Note', exact: true }).check();
    await newItem.fill(`${type} first line`);
    await newItem.press('Shift+Enter');
    await newItem.pressSequentially('second line');
    await expect(newItem).toHaveValue(`${type} first line\nsecond line`);
    await newItem.press('Enter');
    const item = row(page, `${type} first line`);
    await expect(item).toBeVisible();
    const id = await item.getAttribute('data-id');
    expect((await localEntity(page, id)).text).toBe(`${type} first line\nsecond line`);
    await expect(newItem).toHaveValue('');
    await expect(newItem).toBeFocused();

    await clickAction(item, 'Edit');
    const editor = page.getByRole('textbox', { name: type === 'note' ? 'Note text' : 'Todo text', exact: true });
    await editor.fill(`${type} updated line`);
    await editor.press('Shift+Enter');
    await editor.pressSequentially('updated second line');
    await expect(editor).toHaveValue(`${type} updated line\nupdated second line`);
    await editor.press('Enter');
    await expect(editor).toHaveCount(0);
    expect((await localEntity(page, id)).text).toBe(`${type} updated line\nupdated second line`);
  }
  await expect(page.locator('#contents > div')).toHaveCount(2);
  await page.reload();
  await expect(row(page, 'note updated line')).toBeVisible();
  await expect(row(page, 'todo updated line')).toBeVisible();
  await expect(newItem).toBeFocused();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(newItem).toBeFocused();
  await page.goBack();
  await expect(page.getByRole('radio', { name: 'Todo', exact: true })).toBeVisible();
  await expect(newItem).toBeFocused();
});

test('notebook, folder and list trash require confirmation; Cancel retains items and OK trashes contents', async ({ page }) => {
  await page.goto('/');
  const containers = [];
  for (const [type, name] of [['notebook', 'Confirm notebook'], ['folder', 'Confirm folder'], ['list', 'Confirm list']]) {
    await add(page, type, name);
    const view = row(page, name);
    const id = await view.getAttribute('data-id');
    const message = await deleteContainer(page, view, false);
    expect(message).toBe(`Move ${type} "${name}"${type === 'list' ? ' ⓪' : ''} and all its contents to trash?`);
    await expect(view).toBeVisible();
    expect((await localEntity(page, id)).deletedAt).toBeNull();
    containers.push({ id, name });
    await view.getByRole('link').click();
  }
  await add(page, 'note', 'Confirmation child note');
  await add(page, 'todo', 'Confirmation child todo');
  const children = await page.locator('#contents > div').evaluateAll(rows => rows.map(row => row.dataset.id));
  for (const { id, name } of containers.reverse()) {
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    const view = row(page, name);
    await deleteContainer(page, view);
    await expect(view).toHaveCount(0);
    expect((await localEntity(page, id)).deletedAt).toBeTruthy();
  }
  for (const id of children) expect((await localEntity(page, id)).deletedAt).toBeTruthy();
});

test('global favourites toggle for all entity types, navigate, survive reload and sync across browsers', async ({ page, context, browser }) => {
  await page.goto('/');
  await sync(page);
  await context.setOffline(true);
  const favourites = page.locator('#favourites');
  const ids = [];
  for (const [type, name] of [['notebook', 'Favourite notebook'], ['folder', 'Favourite folder'], ['list', 'Favourite list'], ['note', 'Favourite note'], ['todo', 'Favourite todo']]) {
    await add(page, type, name);
    const view = row(page, name);
    await revealActions(view);
    const star = view.getByRole('button', { name: 'Favourite', exact: true });
    await expect(star).toHaveText('☆');
    await expect(star).toHaveAttribute('aria-pressed', 'false');
    await star.click();
    await expect(star).toHaveText('★');
    await expect(star).toHaveAttribute('aria-pressed', 'true');
    ids.push(await view.getAttribute('data-id'));
    await expect(favourites.locator(':scope > div')).toHaveCount(ids.length);
    await expect(page.getByRole('button', { name: 'All hashtags', exact: true })).toHaveCount(1);
    await expect(favourites.locator(':scope > div').getByRole('button', { name: 'All hashtags', exact: true })).toHaveCount(0);
    expect((await favourites.locator(':scope > div').evaluateAll(rows => rows.map(row => row.dataset.id))).sort()).toEqual([...ids].sort());
    if (type !== 'note' && type !== 'todo') await view.getByRole('link').click();
  }
  // The favourites list stays global while search and the current page's sort change.
  const favouriteOrder = await favourites.locator(':scope > div').evaluateAll(rows => rows.map(row => row.dataset.id));
  await page.locator('#sort-order').click();
  await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('no matches for favourites');
  await expect(page.locator('#contents > div')).toHaveCount(0);
  expect(await favourites.locator(':scope > div').evaluateAll(rows => rows.map(row => row.dataset.id))).toEqual(favouriteOrder);
  await favourites.getByRole('link', { name: '📝 Favourite note', exact: true }).click();
  await expect(row(page, 'Favourite todo')).toBeVisible();
  await clickAction(row(page, 'Favourite todo'), 'Edit');
  await row(page, 'Favourite todo').getByRole('textbox').fill('Favourite todo edited');
  await row(page, 'Favourite todo').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(favourites.getByRole('link', { name: '☐ Favourite todo edited', exact: true })).toBeVisible();
  await favourites.locator(`div[data-id="${ids[3]}"]`).getByRole('button', { name: 'Favourite', exact: true }).click();
  await expect(favourites.locator(':scope > div')).toHaveCount(4);
  await revealActions(row(page, 'Favourite note'));
  await expect(row(page, 'Favourite note').getByRole('button', { name: 'Favourite', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await clickAction(row(page, 'Favourite note'), 'Favourite');
  await context.setOffline(false);
  await sync(page);
  await page.reload();
  await expect(favourites.locator(':scope > div')).toHaveCount(5);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto('/');
    await expect(other.locator('#favourites > div')).toHaveCount(5);
    await favourites.getByRole('link', { name: 'Favourite notebook', exact: true }).click();
    await expect(row(page, 'Favourite folder')).toBeVisible();
    await expect(favourites.locator(':scope > div')).toHaveCount(5);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await deleteContainer(page, row(page, 'Favourite notebook'));
    await expect(favourites.locator(':scope > div')).toHaveCount(0);
    await expect(favourites).toBeHidden();
    await expect(page.locator('#breadcrumbs').getByRole('button', { name: 'All hashtags', exact: true })).toBeVisible();
    await sync(page);
    await other.reload();
    await sync(other);
    await expect(other.locator('#favourites > div')).toHaveCount(0);
    await expect(other.getByRole('button', { name: 'All hashtags', exact: true })).toHaveCount(1);
  } finally { await otherContext.close(); }
});

test('Undo reverses saved and pending edits, checkboxes and deletions including container contents', async ({ page, context, browser }) => {
  await page.clock.install();
  await page.goto('/');
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await expect(undo).toBeDisabled();
  await add(page, 'notebook', 'Undo notebook #undo');
  await row(page, 'Undo notebook').getByRole('button', { name: 'Edit', exact: true }).click();
  await row(page, 'Undo notebook').getByRole('textbox').fill('Undo renamed notebook #undo');
  await row(page, 'Undo renamed notebook').getByRole('button', { name: 'Close', exact: true }).click();
  await undo.click();
  await expect(row(page, 'Undo notebook')).toBeVisible();
  await expect(undo).toBeDisabled();
  await row(page, 'Undo notebook').getByRole('button', { name: 'Edit', exact: true }).click();
  await row(page, 'Undo notebook').getByRole('textbox').fill('');
  await undo.click();
  await expect(row(page, 'Undo notebook').getByRole('textbox')).toHaveCount(0);
  await expect(row(page, 'Undo notebook')).toBeVisible();
  await row(page, 'Undo notebook').getByRole('link', { name: 'Undo notebook #undo', exact: true }).click();
  await add(page, 'folder', 'Undo folder #undo');
  await row(page, 'Undo folder').getByRole('link', { name: 'Undo folder #undo', exact: true }).click();
  await add(page, 'list', 'Undo list #undo');
  await row(page, 'Undo list').getByRole('link', { name: 'Undo list #undo', exact: true }).click();
  await add(page, 'note', 'Undo note #undo');
  await add(page, 'note', 'Earlier trash #undo');
  await add(page, 'todo', 'Undo todo #undo');
  const noteId = await row(page, 'Undo note').getAttribute('data-id');
  const oldTrashId = await row(page, 'Earlier trash').getAttribute('data-id');
  await sync(page);
  await context.setOffline(true);
  await page.clock.pauseAt(new Date());
  await clickAction(row(page, 'Undo note'), 'Edit');
  await row(page, 'Undo note').getByRole('textbox').fill('Pending note edit #undo');
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect(row(page, 'Undo note')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Note text', exact: true })).toHaveCount(0);
  await page.clock.runFor(3000);
  expect((await localEntity(page, noteId)).text).toBe('Undo note #undo');
  await page.getByRole('checkbox', { name: 'Complete Undo todo #undo', exact: true }).check();
  await undo.click();
  await expect(page.getByRole('checkbox', { name: 'Complete Undo todo #undo', exact: true })).not.toBeChecked();
  await clickAction(row(page, 'Undo note'), 'Delete');
  await expect(row(page, 'Undo note')).toHaveCount(0);
  await undo.click();
  await expect(row(page, 'Undo note')).toHaveAttribute('data-id', noteId);
  await clickAction(row(page, 'Earlier trash'), 'Delete');
  for (const name of ['Undo list', 'Undo folder', 'Undo notebook']) {
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    const id = await row(page, name).getAttribute('data-id');
    await deleteContainer(page, row(page, name));
    await expect(row(page, name)).toHaveCount(0);
    await undo.click();
    await expect(row(page, name)).toHaveAttribute('data-id', id);
    expect((await localEntity(page, noteId)).deletedAt).toBeNull();
    expect((await localEntity(page, oldTrashId)).deletedAt).not.toBeNull();
  }
  await context.setOffline(false);
  await sync(page);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto('/');
    await other.getByRole('searchbox', { name: 'Search', exact: true }).fill('#undo');
    await expect(other.locator('#contents > div')).toHaveCount(5);
    await expect(row(other, 'Undo note #undo')).toHaveAttribute('data-id', noteId);
    await expect(row(other, 'Earlier trash')).toHaveCount(0);
    await expect(other.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  } finally { await otherContext.close(); }
  await page.reload();
  await expect(undo).toBeDisabled();
});

test('multiple Undo steps group autosaves and survive navigation, searching and new edits between clicks', async ({ page, context, browser }) => {
  await page.clock.install();
  await page.goto('/');
  for (const [type, name] of [['notebook', 'History book'], ['folder', 'History folder'], ['list', 'History list']]) {
    await add(page, type, name);
    await row(page, name).getByRole('link').click();
  }
  await add(page, 'note', 'History original note #history');
  await add(page, 'todo', 'History todo #history');
  const noteId = await row(page, 'History original note').getAttribute('data-id');
  const todoId = await row(page, 'History todo').getAttribute('data-id');
  const note = page.locator(`#contents > div[data-id="${noteId}"]`);
  const todo = page.locator(`#contents > div[data-id="${todoId}"]`);
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await sync(page);
  await context.setOffline(true);
  await page.clock.pauseAt(new Date());
  try {
    await clickAction(note, 'Edit');
    await note.getByRole('textbox').fill('History intermediate #history');
    await page.clock.runFor(2100);
    await expect.poll(async () => (await localEntity(page, noteId)).text).toBe('History intermediate #history');
    await note.getByRole('textbox').fill('History first edit #history');
    await page.clock.runFor(2100);
    await expect.poll(async () => (await localEntity(page, noteId)).text).toBe('History first edit #history');
    await note.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(undo).toHaveAttribute('title', 'Undo last edit or delete (1 saved step available)');
    await clickAction(note, 'Edit');
    await note.getByRole('textbox').fill('History second edit #history');
    await note.getByRole('button', { name: 'Close', exact: true }).click();
    await todo.getByRole('checkbox').check();
    await expect(undo).toHaveAttribute('title', 'Undo last edit or delete (3 saved steps available)');
    await undo.click();
    await expect(todo.getByRole('checkbox')).not.toBeChecked();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await row(page, 'History list').getByRole('link').click();
    await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('#history');
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await page.locator('#sort-order').click();
    await page.locator('#date-display').click();
    await clickAction(note, 'Favourite');
    await clickAction(note, 'Pin');
    await expect(undo).toHaveAttribute('title', 'Undo last edit or delete (2 saved steps available)');
    await undo.click();
    expect((await localEntity(page, noteId)).text).toBe('History first edit #history');
    await expect(undo).toBeEnabled();
    // A new change goes on top without losing the older, grouped text edit.
    await todo.getByRole('checkbox').check();
    await undo.click();
    await expect(todo.getByRole('checkbox')).not.toBeChecked();
    await undo.click();
    expect((await localEntity(page, noteId)).text).toBe('History original note #history');
    await expect(undo).toBeDisabled();
    expect((await localEntity(page, noteId)).favourite).toBe(true);
    expect((await localEntity(page, noteId)).pinned).toBe(true);
    // Flushing a pending autosave also belongs to the same session's step.
    await clickAction(note, 'Edit');
    await note.getByRole('textbox').fill('History saved draft #history');
    await page.clock.runFor(2100);
    await expect.poll(async () => (await localEntity(page, noteId)).text).toBe('History saved draft #history');
    await note.getByRole('textbox').fill('History pending draft #history');
    await undo.click();
    await expect(note.getByRole('textbox')).toHaveCount(0);
    expect((await localEntity(page, noteId)).text).toBe('History original note #history');
    await page.clock.runFor(3000);
    expect((await localEntity(page, noteId)).text).toBe('History original note #history');
    await expect(undo).toBeDisabled();
    // A checkbox change between autosaves must stay between the two text steps.
    await clickAction(note, 'Edit');
    await note.getByRole('textbox').fill('History interrupted session #history');
    await page.clock.runFor(2100);
    await expect.poll(async () => (await localEntity(page, noteId)).text).toBe('History interrupted session #history');
    await todo.getByRole('checkbox').check();
    await note.getByRole('textbox').fill('History after checkbox #history');
    await note.getByRole('button', { name: 'Close', exact: true }).click();
    await undo.click();
    expect((await localEntity(page, noteId)).text).toBe('History interrupted session #history');
    await expect(todo.getByRole('checkbox')).toBeChecked();
    await undo.click();
    await expect(todo.getByRole('checkbox')).not.toBeChecked();
    await undo.click();
    expect((await localEntity(page, noteId)).text).toBe('History original note #history');
    await expect(undo).toBeDisabled();
    // Discarding an unchanged draft must not consume an older checkbox step.
    await todo.getByRole('checkbox').check();
    await clickAction(note, 'Edit');
    await note.getByRole('textbox').fill('History original note #history');
    await undo.click();
    await expect(note.getByRole('textbox')).toHaveCount(0);
    await expect(todo.getByRole('checkbox')).toBeChecked();
    await expect(undo).toBeEnabled();
    await undo.click();
    await expect(todo.getByRole('checkbox')).not.toBeChecked();
    await expect(undo).toBeDisabled();
  } finally { await context.setOffline(false); }
  await page.clock.resume();
  await sync(page);
  const otherContext = await browser.newContext();
  try {
    const other = await otherContext.newPage();
    await other.goto('/');
    await other.getByRole('searchbox', { name: 'Search', exact: true }).fill('#history');
    await expect(other.locator(`#contents > div[data-id="${noteId}"] .entity-text`)).toContainText('History original note #history');
    await expect(other.locator(`#contents > div[data-id="${todoId}"] input[type="checkbox"]`)).not.toBeChecked();
    await expect(other.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled();
  } finally { await otherContext.close(); }
  await page.locator(`#pinned > div[data-id="${noteId}"]`).getByRole('button', { name: 'Pin', exact: true }).click();
  await page.locator(`#favourites > div[data-id="${noteId}"]`).getByRole('button', { name: 'Favourite', exact: true }).click();
  await expect(page.locator(`#favourites > div[data-id="${noteId}"]`)).toHaveCount(0);
  await sync(page);
});

test('Undo keeps the latest 50 changes on mobile and reload clears the remaining tab history', async ({ page, context }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  for (const [type, name] of [['notebook', 'Bounded history book'], ['folder', 'Bounded history folder'], ['list', 'Bounded history list']]) {
    await add(page, type, name);
    await row(page, name).getByRole('link').click();
  }
  await add(page, 'todo', 'Bounded history todo');
  const checkbox = page.getByRole('checkbox', { name: 'Complete Bounded history todo', exact: true });
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await sync(page);
  await context.setOffline(true);
  try {
    for (let index = 0; index < 51; index++) await checkbox.setChecked(index % 2 === 0);
    await expect(undo).toHaveAttribute('title', 'Undo last edit or delete (50 saved steps available)');
    for (let index = 0; index < 50; index++) {
      await undo.click();
      await expect(checkbox).toBeChecked({ checked: index % 2 !== 0 });
    }
    await expect(undo).toBeDisabled();
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await expect(undo).toBeEnabled();
    await context.setOffline(false);
    await page.reload();
    await expect(checkbox).not.toBeChecked();
    await expect(undo).toBeDisabled();
  } finally { await context.setOffline(false); }
  await sync(page);
});

test('manual Restore removes its deletion step without discarding other Undo steps', async ({ page }) => {
  await page.goto('/');
  for (const [type, name] of [['notebook', 'Restore history book'], ['folder', 'Restore history folder'], ['list', 'Restore history list']]) {
    await add(page, type, name);
    await row(page, name).getByRole('link').click();
  }
  await add(page, 'note', 'Restore history original');
  await add(page, 'note', 'Restore history second');
  const firstId = await row(page, 'Restore history original').getAttribute('data-id');
  const secondId = await row(page, 'Restore history second').getAttribute('data-id');
  const first = page.locator(`#contents > div[data-id="${firstId}"]`);
  const second = page.locator(`#contents > div[data-id="${secondId}"]`);
  const undo = page.getByRole('button', { name: 'Undo', exact: true });
  await clickAction(first, 'Edit');
  await first.getByRole('textbox').fill('Restore history edited');
  await first.getByRole('button', { name: 'Close', exact: true }).click();
  await clickAction(first, 'Delete');
  await clickAction(second, 'Delete');
  await page.getByRole('button', { name: 'Trash', exact: true }).click();
  await first.getByRole('button', { name: 'Restore', exact: true }).click();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(undo).toHaveAttribute('title', 'Undo last edit or delete (2 saved steps available)');
  await undo.click();
  await expect(second.locator('.entity-text')).toContainText('Restore history second');
  await undo.click();
  await expect(first.locator('.entity-text')).toContainText('Restore history original');
  await expect(undo).toBeDisabled();
});

test('all mutation paths work without crypto.randomUUID, as on an HTTP LAN origin', async ({ page, context }) => {
  await context.addInitScript(() => {
    Object.defineProperty(crypto, 'randomUUID', { value: undefined });
  });
  await page.goto('/');
  expect(await page.evaluate(() => typeof crypto.randomUUID)).toBe('undefined');
  await add(page, 'notebook', 'Fallback UUID notebook');
  await row(page, 'Fallback UUID notebook').getByRole('link').click();
  await add(page, 'folder', 'Fallback UUID folder');
  await row(page, 'Fallback UUID folder').getByRole('link').click();
  await page.getByRole('button', { name: "Add today's list", exact: true }).click();
  const list = page.locator('#contents > div').first();
  const listId = await list.getAttribute('data-id');
  expect(listId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  await list.getByRole('link').click();
  await add(page, 'todo', 'Fallback UUID todo');
  const todo = row(page, 'Fallback UUID todo');
  const todoId = await todo.getAttribute('data-id');
  await clickAction(todo, 'Edit');
  await todo.getByRole('textbox').fill('Fallback UUID edited');
  await row(page, 'Fallback UUID edited').getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Complete Fallback UUID edited', exact: true }).check();
  await clickAction(row(page, 'Fallback UUID edited'), 'Favourite');
  await page.locator('#sort-order').click();
  await clickAction(row(page, 'Fallback UUID edited'), 'Delete');
  await expect(row(page, 'Fallback UUID edited')).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(row(page, 'Fallback UUID edited')).toHaveAttribute('data-id', todoId);
  await expect(page.getByRole('checkbox', { name: 'Complete Fallback UUID edited', exact: true })).toBeChecked();
  await page.locator(`#favourites > div[data-id="${todoId}"]`).getByRole('button', { name: 'Favourite', exact: true }).click();
  await sync(page);
  await expect(page.locator('#sync-errors')).toBeHidden();
  await expect(page.locator('#error')).toBeHidden();
});

for (const width of [1280, 390]) {
  test(`keyboard text focus reveals one read-only toolbar at ${width}px and row switches save drafts`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.clock.install();
    await page.goto('/');
    for (const type of ['notebook', 'folder', 'list']) {
      const name = `Focus panel ${width} ${type}`;
      await add(page, type, name);
      await row(page, name).getByRole('link').click();
    }
    const tag = `#focus-panel-${width}`;
    const todoText = `Focus todo ${tag}`;
    const noteText = `Focus note A ${tag}`;
    await add(page, 'todo', todoText);
    await add(page, 'note', noteText);
    await add(page, 'note', `Focus note B ${tag}`);
    const todoId = await row(page, todoText).getAttribute('data-id');
    const noteId = await row(page, noteText).getAttribute('data-id');
    const noteBId = await row(page, `Focus note B ${tag}`).getAttribute('data-id');
    const todo = page.locator(`#contents > div[data-id="${todoId}"]`);
    const note = page.locator(`#contents > div[data-id="${noteId}"]`);
    const noteB = page.locator(`#contents > div[data-id="${noteBId}"]`);
    const todoSpan = todo.locator(':scope > .entity-text');
    const noteSpan = note.locator(':scope > .entity-text');
    const noteBSpan = noteB.locator(':scope > .entity-text');
    const plainText = { position: { x: 5, y: 5 } };
    const contents = page.locator('#contents');
    const newItem = page.locator('#creation').getByRole('textbox');
    const favourite = page.locator(`#favourites > div[data-id="${todoId}"]`);
    await sync(page);
    await expect(newItem).toBeFocused();
    await expect(contents.locator('.entity-panel')).toHaveCount(0);
    await expect(contents.getByRole('textbox')).toHaveCount(0);

    try {
      // The checkbox stays inline and precedes the read-only text in the Tab order.
      await expect(todo.locator(':scope > input[type="checkbox"] + .entity-text')).toHaveCount(1);
      const checkbox = todo.getByRole('checkbox');
      await checkbox.focus();
      await expect(contents.locator('.entity-panel')).toHaveCount(0);
      await checkbox.press('Tab');
      await expectReadOnlyActions(page, todo, 'todo');
      await todoSpan.click(plainText);
      await expectCollapsedActions(page, todo);
      await todoSpan.click(plainText);
      await expectReadOnlyActions(page, todo, 'todo');

      // Moving into controls keeps the same panel open without starting editing.
      await todoSpan.press('Tab');
      const hashtag = todoSpan.getByRole('link', { name: tag, exact: true });
      await expect(hashtag).toBeFocused();
      await hashtag.press('Tab');
      const star = todo.getByRole('toolbar').getByRole('button', { name: 'Favourite', exact: true });
      await expect(star).toBeFocused();
      await star.press('Space');
      await expect(star).toHaveAttribute('aria-pressed', 'true');
      await expect(favourite).toBeVisible();
      await expect(contents.locator('.entity-panel')).toHaveCount(1);
      await expect(contents.getByRole('textbox')).toHaveCount(0);
      await star.press('Tab');
      const edit = todo.getByRole('toolbar').getByRole('button', { name: 'Edit', exact: true });
      await expect(edit).toBeFocused();
      await edit.press('Enter');
      await expect(todo.getByRole('textbox', { name: 'Todo text', exact: true })).toBeFocused();
      await expect(contents.locator('.entity-panel')).toHaveCount(1);
      await expect(contents.getByRole('toolbar')).toHaveCount(1);
      await todo.getByRole('button', { name: 'Close', exact: true }).click();
      await checkbox.check();
      await expect(checkbox).toBeChecked();
      await expect(todoSpan).toHaveCSS('text-decoration-line', 'line-through');
      await sync(page);

      // Reach a note by Tab too, without assuming a particular date-sort row order.
      await page.getByRole('button', { name: 'Back', exact: true }).focus();
      for (let tabs = 0; tabs < 20; tabs++) {
        await page.keyboard.press('Tab');
        if (await noteSpan.evaluate(element => element === document.activeElement)) break;
      }
      await expectReadOnlyActions(page, note, 'note');
      await expect(todo.locator(':scope > .entity-panel')).toHaveCount(0);
      await page.clock.pauseAt(new Date());
      await note.getByRole('toolbar').getByRole('button', { name: 'Edit', exact: true }).click();
      const editor = note.getByRole('textbox', { name: 'Note text', exact: true });
      await expect(editor).toBeFocused();
      await expect(contents.locator('.entity-panel')).toHaveCount(1);
      const draft = `Focus note A saved ${tag}`;
      await editor.fill(draft);
      await expect(note.locator('output')).toHaveText('Waiting to save…');
      expect((await localEntity(page, noteId)).text).toBe(noteText);
      await noteBSpan.focus();
      await expectReadOnlyActions(page, noteB, 'note');
      await expect(note.locator(':scope > .entity-panel')).toHaveCount(0);
      await expect(editor).toHaveCount(0);
      await expect.poll(async () => (await localEntity(page, noteId)).text).toBe(draft);
      await noteSpan.focus();
      await expectReadOnlyActions(page, note, 'note');
      await expect(noteSpan).toHaveText(`📝 ${draft}`);

      const search = page.getByRole('searchbox', { name: 'Search', exact: true });
      await search.fill(tag);
      await expect(contents.locator(':scope > div')).toHaveCount(3);
      await expect(contents.locator('.entity-panel')).toHaveCount(0);
      await expect(contents.getByRole('toolbar')).toHaveCount(0);
      await noteSpan.focus();
      await expectReadOnlyActions(page, note, 'note');
      await note.getByRole('toolbar').getByRole('button', { name: 'Open list', exact: true }).click();
      await expect(search).toHaveValue('');
      await expect(contents.locator('.entity-panel')).toHaveCount(0);
      await expect(newItem).toBeFocused();
      await noteSpan.focus();
      await expectReadOnlyActions(page, note, 'note');
      await sync(page);
      await page.reload();
      await expect(noteSpan).toHaveText(`📝 ${draft}`);
      await expect(checkbox).toBeChecked();
      await expect(contents.locator('.entity-panel')).toHaveCount(0);
      await expect(contents.getByRole('toolbar')).toHaveCount(0);
      await expect(contents.getByRole('textbox')).toHaveCount(0);
      await expect(newItem).toBeFocused();

      await noteBSpan.focus();
      await expectReadOnlyActions(page, noteB, 'note');
      await noteB.getByRole('toolbar').getByRole('button', { name: 'Delete', exact: true }).click();
      await expect(noteB).toHaveCount(0);
      await expect(contents.locator('.entity-panel')).toHaveCount(0);
      await expect(contents.getByRole('toolbar')).toHaveCount(0);

      // Focus requests in the same task must not let an older activation win.
      await page.evaluate(ids => {
        for (const id of ids) document.querySelector(`#contents > div[data-id="${id}"] > .entity-text`).focus();
      }, [noteId, todoId]);
      await expectReadOnlyActions(page, todo, 'todo');
      await expect(note.locator(':scope > .entity-panel')).toHaveCount(0);
      // Returning immediately to the active item cancels a pending switch away.
      await page.evaluate(ids => {
        for (const id of ids) document.querySelector(`#contents > div[data-id="${id}"] > .entity-text`).focus();
      }, [noteId, todoId]);
      await expectReadOnlyActions(page, todo, 'todo');
      await expect(note.locator(':scope > .entity-panel')).toHaveCount(0);
      await noteSpan.click(plainText);
      await expectReadOnlyActions(page, note, 'note');
      await noteSpan.click(plainText);
      await expectCollapsedActions(page, note);
      await noteSpan.click(plainText);
      await expectReadOnlyActions(page, note, 'note');
      await todoSpan.click(plainText);
      await expectReadOnlyActions(page, todo, 'todo');
      await todo.getByRole('toolbar').getByRole('button', { name: 'Edit', exact: true }).click();
      const collapseDraft = `Focus todo collapsed ${tag}`;
      await todo.getByRole('textbox').fill(collapseDraft);
      await todoSpan.click(plainText);
      await expectCollapsedActions(page, todo);
      await expect.poll(async () => (await localEntity(page, todoId)).text).toBe(collapseDraft);
      await todoSpan.click(plainText);
      await expectReadOnlyActions(page, todo, 'todo');
      await sync(page);
      await expect(page.locator('#error')).toBeHidden();
    } finally {
      // Even a failed regression must not leave a global favourite for other tests.
      if (await favourite.count()) {
        await favourite.getByRole('button', { name: 'Favourite', exact: true }).click();
        await expect(favourite).toHaveCount(0);
        await expect.poll(() => pendingCount(page)).toBe(0);
      }
    }
  });
}

test('touch text taps stay read-only until Edit, save drafts on row switches and leave URL taps independent', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, isMobile: true, hasTouch: true, viewport: { width: 390, height: 844 } });
  try {
    const page = await context.newPage();
    await page.clock.install();
    await page.goto('/');
    const newItem = page.locator('#creation').getByRole('textbox');
    await expect(newItem).not.toBeFocused();
    for (const type of ['notebook', 'folder', 'list']) {
      const name = `Touch panel ${type}`;
      await add(page, type, name);
      await row(page, name).getByRole('link').tap();
      await expect(newItem).not.toBeFocused();
    }
    const todoText = 'Touch panel todo';
    const noteText = 'Touch panel note A';
    const url = 'https://example.com/touch-panel';
    const contents = page.locator('#contents');
    for (const [type, text] of [['Todo', todoText], ['Note', noteText], ['Note', `Touch panel note B ${url}`]]) {
      await page.getByRole('radio', { name: type, exact: true }).check();
      await newItem.fill(text);
      await newItem.press('Enter');
      await expect(contents).toContainText(text);
    }
    const todoId = await row(page, todoText).getAttribute('data-id');
    const noteId = await row(page, noteText).getAttribute('data-id');
    const noteBId = await row(page, 'Touch panel note B').getAttribute('data-id');
    const todo = page.locator(`#contents > div[data-id="${todoId}"]`);
    const note = page.locator(`#contents > div[data-id="${noteId}"]`);
    const noteB = page.locator(`#contents > div[data-id="${noteBId}"]`);
    const todoSpan = todo.locator(':scope > .entity-text');
    const noteSpan = note.locator(':scope > .entity-text');
    const noteBSpan = noteB.locator(':scope > .entity-text');
    await sync(page);
    await expect(contents.locator('.entity-panel')).toHaveCount(0);

    // Focusing/tapping an embedded anchor must not activate its text wrapper.
    await context.route('https://example.com/**', route => route.fulfill({ contentType: 'text/plain', body: 'External touch link test' }));
    const appUrl = page.url();
    const link = noteB.getByRole('link', { name: url, exact: true });
    await link.focus();
    await expect(link).toBeFocused();
    await expect(contents.locator('.entity-panel')).toHaveCount(0);
    const pendingPopup = page.waitForEvent('popup');
    await link.tap();
    const popup = await pendingPopup;
    await expect(popup).toHaveURL(url);
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    await popup.close();
    await expect(page).toHaveURL(appUrl);
    await expect(contents.locator('.entity-panel')).toHaveCount(0);
    await expect(contents.getByRole('textbox')).toHaveCount(0);

    await todoSpan.tap();
    await expectReadOnlyActions(page, todo, 'todo');
    await todoSpan.tap();
    await expectCollapsedActions(page, todo);
    await todoSpan.tap();
    await expectReadOnlyActions(page, todo, 'todo');
    await todo.getByRole('toolbar').getByRole('button', { name: 'Edit', exact: true }).tap();
    const todoEditor = todo.getByRole('textbox', { name: 'Todo text', exact: true });
    await expect(todoEditor).toBeFocused();
    await expect(todoEditor).toHaveJSProperty('tagName', 'TEXTAREA');
    await expect(contents.locator('.entity-panel')).toHaveCount(1);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await todoEditor.fill('Touch panel todo saved');
    expect((await localEntity(page, todoId)).text).toBe(todoText);
    await noteSpan.tap();
    await expectReadOnlyActions(page, note, 'note');
    await expect(todoEditor).toHaveCount(0);
    await expect.poll(async () => (await localEntity(page, todoId)).text).toBe('Touch panel todo saved');

    await note.getByRole('toolbar').getByRole('button', { name: 'Edit', exact: true }).tap();
    const noteEditor = note.getByRole('textbox', { name: 'Note text', exact: true });
    await expect(noteEditor).toBeFocused();
    await expect(noteEditor).toHaveJSProperty('tagName', 'TEXTAREA');
    await expect(contents.locator('.entity-panel')).toHaveCount(1);
    await noteEditor.fill('Touch panel note A saved');
    expect((await localEntity(page, noteId)).text).toBe(noteText);
    // Tap the plain leading text, not the embedded URL or a wrapped-line midpoint.
    await noteBSpan.tap({ position: { x: 5, y: 5 } });
    await expectReadOnlyActions(page, noteB, 'note');
    await expect(noteEditor).toHaveCount(0);
    await expect.poll(async () => (await localEntity(page, noteId)).text).toBe('Touch panel note A saved');
    await noteSpan.tap();
    await expectReadOnlyActions(page, note, 'note');
    await expect(noteSpan).toHaveText('📝 Touch panel note A saved');
    await note.getByRole('toolbar').getByRole('button', { name: 'Edit', exact: true }).tap();
    await note.getByRole('textbox').fill('Touch panel note A collapsed');
    await noteSpan.tap();
    await expectCollapsedActions(page, note);
    await expect.poll(async () => (await localEntity(page, noteId)).text).toBe('Touch panel note A collapsed');
    await noteSpan.tap();
    await expectReadOnlyActions(page, note, 'note');
    await expect(noteSpan).toHaveText('📝 Touch panel note A collapsed');
    await sync(page);
    await expect(page.locator('#error')).toBeHidden();
  } finally { await context.close(); }
});

test('mouse drag selects note and todo text for copy-paste without expanding or contracting the toolbar', async ({ page }) => {
  await page.goto('/');
  for (const [type, name] of [['notebook', 'Copy book'], ['folder', 'Copy folder'], ['list', 'Copy list']]) {
    await add(page, type, name);
    await row(page, name).getByRole('link').click();
  }
  const todoText = 'Selectable copyable todo item text';
  const noteText = 'Selectable copyable note item text';
  await add(page, 'todo', todoText);
  await add(page, 'note', noteText);
  const todo = row(page, todoText);
  const todoSpan = todo.locator(':scope > .entity-text');
  const note = row(page, noteText);
  const noteSpan = note.locator(':scope > .entity-text');
  const contents = page.locator('#contents');

  // Initially toolbars are collapsed
  await expect(contents.locator('.entity-panel')).toHaveCount(0);

  // Drag-select across todo text using mouse down and move
  const todoBox = await todoSpan.boundingBox();
  expect(todoBox).not.toBeNull();
  await page.mouse.move(todoBox.x + 30, todoBox.y + todoBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(todoBox.x + todoBox.width - 10, todoBox.y + todoBox.height / 2);
  await page.mouse.up();

  // Selection must be non-empty and toolbar must remain collapsed
  const selectedTodo = await page.evaluate(() => window.getSelection()?.toString());
  expect(selectedTodo.trim().length).toBeGreaterThan(0);
  expect(todoText).toContain(selectedTodo.trim());
  await expect(contents.locator('.entity-panel')).toHaveCount(0);

  // Copy with keyboard and paste into search box
  await page.keyboard.press('ControlOrMeta+c');
  const search = page.getByRole('searchbox', { name: 'Search', exact: true });
  await search.focus();
  await page.keyboard.press('ControlOrMeta+v');
  expect(await search.inputValue()).toBe(selectedTodo);
  await search.fill('');

  // Single click toggles toolbar open
  await todoSpan.click();
  await expectReadOnlyActions(page, todo, 'todo');

  // Drag-select while toolbar is open must keep toolbar open
  await page.mouse.move(todoBox.x + 30, todoBox.y + todoBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(todoBox.x + 100, todoBox.y + todoBox.height / 2);
  await page.mouse.up();
  const selectedAgain = await page.evaluate(() => window.getSelection()?.toString());
  expect(selectedAgain.trim().length).toBeGreaterThan(0);
  await expectReadOnlyActions(page, todo, 'todo');

  // Single click toggles toolbar closed
  await todoSpan.click();
  await expectCollapsedActions(page, todo);

  // Same for note: drag-select text without toggling toolbar
  const noteBox = await noteSpan.boundingBox();
  expect(noteBox).not.toBeNull();
  await page.mouse.move(noteBox.x + 30, noteBox.y + noteBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(noteBox.x + noteBox.width - 10, noteBox.y + noteBox.height / 2);
  await page.mouse.up();
  const selectedNote = await page.evaluate(() => window.getSelection()?.toString());
  expect(selectedNote.trim().length).toBeGreaterThan(0);
  expect(noteText).toContain(selectedNote.trim());
  await expect(contents.locator('.entity-panel')).toHaveCount(0);
});

test('link-only todos show a link icon to the left of the anchor that toggles the toolbar, and folder/list anchors exclude icons', async ({ page, context }) => {
  await page.goto('/');
  await add(page, 'notebook', 'Link icon notebook');
  await page.getByRole('link', { name: 'Link icon notebook', exact: true }).click();
  await add(page, 'folder', 'Link icon folder');
  const folder = row(page, 'Link icon folder');
  // Folder icon is on the left, outside the anchor
  await expect(folder).toContainText('📁 ');
  const folderLink = folder.locator(':scope > a');
  await expect(folderLink).toHaveText('Link icon folder');
  await folderLink.click();

  await add(page, 'list', 'Link icon list');
  const list = row(page, 'Link icon list');
  // List icon is on the left, outside the anchor
  await expect(list).toContainText('📋 ');
  const listLink = list.locator(':scope > a');
  await expect(listLink).toHaveText('Link icon list');
  await listLink.click();

  const url = 'https://example.com/link-only-todo';
  await add(page, 'todo', url);
  await add(page, 'todo', `Text with link ${url}`);
  await add(page, 'note', url);

  const linkOnlyTodo = row(page, url).filter({ has: page.locator('input[type="checkbox"]') }).filter({ hasNotText: 'Text with link' });
  const textTodo = row(page, 'Text with link');
  const linkNote = row(page, url).filter({ hasNot: page.locator('input[type="checkbox"]') });

  // Link-only todo has the link marker outside the anchor
  const marker = linkOnlyTodo.locator('.link-marker');
  await expect(marker).toHaveCount(1);
  await expect(marker).toHaveText('🔗 ');
  const todoAnchor = linkOnlyTodo.getByRole('link', { name: url, exact: true });
  await expect(todoAnchor).toBeVisible();
  // The marker is NOT inside the anchor
  await expect(todoAnchor.locator('.link-marker')).toHaveCount(0);

  // Normal todo with text does not have the link marker
  await expect(textTodo.locator('.link-marker')).toHaveCount(0);

  // Note already has the note icon and does not have the link marker
  await expect(linkNote.locator('.entity-marker')).toHaveText('📝 ');
  await expect(linkNote.locator('.link-marker')).toHaveCount(0);

  // Clicking the link icon on the link-only todo expands the toolbar
  await expect(page.locator('#contents .entity-panel')).toHaveCount(0);
  await marker.click();
  await expectReadOnlyActions(page, linkOnlyTodo, 'todo');

  // Clicking the link icon again contracts the toolbar
  await marker.click();
  await expectCollapsedActions(page, linkOnlyTodo);

  // Clicking the external URL link does NOT toggle the toolbar, it opens the link
  await context.route('https://example.com/**', route => route.fulfill({ contentType: 'text/plain', body: 'OK' }));
  const popupPromise = page.waitForEvent('popup');
  await todoAnchor.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(url);
  await popup.close();
  await expect(linkOnlyTodo.locator(':scope > .entity-panel')).toHaveCount(0);
  await expect(page.locator('#contents .entity-panel')).toHaveCount(0);
});
