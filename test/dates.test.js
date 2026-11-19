import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { formatEntityDate, nextListName } from '../src/lib/dates.js';
import { dateDisplayOptions } from '../src/lib/model.js';

test('move date shortcuts preserve a list title and use today for undated lists', () => {
  const today = new Date(2026, 11, 31, 23, 45);
  assert.equal(nextListName('Work 20/11/2026 #office'), 'Work 21/11/2026 #office');
  assert.equal(nextListName('Year end 2026-12-31', { days: 2 }), 'Year end 2027-01-02');
  assert.equal(nextListName('Sun, 28/02/28 #work', { pickedDate: '2028-02-29' }), 'Tue, 29/02/28 #work');
  assert.equal(nextListName('Work', { today }), '01/01/2027');
  assert.equal(nextListName('Work 31/02/2026', { today, days: 7 }), '07/01/2027');
});

test('date display options have the exact order, labels and timestamp selectors', () => {
  assert.deepEqual(dateDisplayOptions, [
    { value: 'none', label: 'No date' },
    { value: 'created-date', field: 'createdAt', label: 'Cr. Date' },
    { value: 'created-time', field: 'createdAt', time: true, label: 'Cr. Time' },
    { value: 'modified-date', field: 'modifiedAt', label: 'Mod Date' },
    { value: 'modified-time', field: 'modifiedAt', time: true, label: 'Mod Time' },
  ]);
});

test('created and modified modes use their own timestamps in the runtime local timezone', () => {
  const entity = {
    createdAt: new Date(2026, 0, 2, 3, 4, 5, 678).toISOString(),
    modifiedAt: new Date(2026, 9, 7, 16, 17, 18, 999).toISOString(),
  };
  assert.equal(formatEntityDate(entity), '');
  assert.equal(formatEntityDate(entity, 'none'), '');
  assert.equal(formatEntityDate(entity, 'created-date'), '2026-01-02');
  assert.equal(formatEntityDate(entity, 'created-time'), '2026-01-02 03:04:05');
  assert.equal(formatEntityDate(entity, 'modified-date'), '2026-10-07');
  assert.equal(formatEntityDate(entity, 'modified-time'), '2026-10-07 16:17:18');
});

test('local dates pad years and every time component, including midnight', () => {
  const ancient = new Date(2000, 0, 2, 3, 4, 5);
  ancient.setFullYear(42);
  const entity = {
    createdAt: ancient.toISOString(),
    modifiedAt: new Date(2026, 1, 9, 0, 0, 0).toISOString(),
  };
  assert.equal(formatEntityDate(entity, 'created-date'), '0042-01-02');
  assert.equal(formatEntityDate(entity, 'created-time'), '0042-01-02 03:04:05');
  assert.equal(formatEntityDate(entity, 'modified-date'), '2026-02-09');
  assert.equal(formatEntityDate(entity, 'modified-time'), '2026-02-09 00:00:00');
});

test('local year and leap-day boundaries do not use the UTC date substring', () => {
  for (const [parts, expected] of [
    [[2026, 11, 31, 23, 59, 59], '2026-12-31 23:59:59'],
    [[2027, 0, 1, 0, 0, 0], '2027-01-01 00:00:00'],
    [[2028, 1, 29, 23, 59, 59], '2028-02-29 23:59:59'],
    [[2028, 2, 1, 0, 0, 0], '2028-03-01 00:00:00'],
  ]) {
    const timestamp = new Date(...parts).toISOString();
    const entity = { createdAt: timestamp, modifiedAt: timestamp };
    for (const mode of ['created-time', 'modified-time']) assert.equal(formatEntityDate(entity, mode), expected);
    for (const mode of ['created-date', 'modified-date']) assert.equal(formatEntityDate(entity, mode), expected.slice(0, 10));
  }
});

test('missing or invalid timestamps are empty and never fall back to the other timestamp', () => {
  const valid = new Date(2026, 0, 2, 3, 4, 5).toISOString();
  for (const timestamp of [undefined, null, '', 'not a timestamp', '2026-13-01T00:00:00Z', NaN, Infinity]) {
    const entity = { createdAt: timestamp, modifiedAt: valid };
    assert.equal(formatEntityDate(entity, 'created-date'), '');
    assert.equal(formatEntityDate(entity, 'created-time'), '');
    assert.equal(formatEntityDate(entity, 'modified-time'), '2026-01-02 03:04:05');
    const reversed = { createdAt: valid, modifiedAt: timestamp };
    assert.equal(formatEntityDate(reversed, 'modified-date'), '');
    assert.equal(formatEntityDate(reversed, 'modified-time'), '');
    assert.equal(formatEntityDate(reversed, 'created-time'), '2026-01-02 03:04:05');
  }
  for (const option of dateDisplayOptions) assert.equal(formatEntityDate({}, option.value), '');
});

test('unknown modes and non-string modes render no date', () => {
  const entity = { createdAt: new Date(2026, 0, 2, 3, 4, 5).toISOString() };
  for (const mode of [undefined, null, '', 'created', 'CREATED-DATE', 'modified', 0, true, {}, []]) {
    assert.equal(formatEntityDate(entity, mode), '');
  }
});

test('positive and negative local offsets cross UTC day and year boundaries without changing the parent TZ', () => {
  const formatterUrl = new URL('../src/lib/dates.js', import.meta.url).href;
  const beforeTZ = process.env.TZ;
  for (const [zone, offset, cases] of [
    ['Etc/GMT+5', 300, [
      ['2027-01-01T02:03:04.000Z', '2026-12-31 21:03:04'],
      ['2026-07-01T02:03:04.000Z', '2026-06-30 21:03:04'],
    ]],
    ['Etc/GMT-14', -840, [
      ['2026-12-31T12:03:04.000Z', '2027-01-01 02:03:04'],
      ['2026-02-28T12:03:04.000Z', '2026-03-01 02:03:04'],
    ]],
  ]) {
    const script = `
      import assert from 'node:assert/strict';
      import { formatEntityDate } from ${JSON.stringify(formatterUrl)};
      assert.equal(new Date(2027, 0, 1).getTimezoneOffset(), ${offset});
      const local = new Date(2027, 0, 1, 0, 5, 9).toISOString();
      assert.equal(formatEntityDate({ createdAt: local }, 'created-time'), '2027-01-01 00:05:09');
      for (const [timestamp, expected] of ${JSON.stringify(cases)}) {
        const entity = { createdAt: timestamp, modifiedAt: timestamp };
        for (const mode of ['created-time', 'modified-time']) assert.equal(formatEntityDate(entity, mode), expected);
        for (const mode of ['created-date', 'modified-date']) assert.equal(formatEntityDate(entity, mode), expected.slice(0, 10));
      }
    `;
    const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, TZ: zone }, encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${zone}: ${result.stderr || result.stdout}`);
    assert.equal(process.env.TZ, beforeTZ);
  }
});
