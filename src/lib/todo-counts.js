import { visibleEntities } from './model.js';

const circled = [...'⓪①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'];

export function circledTodoCount(count = 0) {
  if (!Number.isSafeInteger(count) || count < 0) return circled[0];
  return circled[count] ?? [...String(count)].map(digit => circled[Number(digit)]).join('');
}

export function incompleteTodoCounts(snapshot) {
  const entities = visibleEntities(snapshot);
  const counts = new Map(entities.filter(entity => entity.type === 'list').map(entity => [entity.id, 0]));
  for (const entity of entities) {
    if (entity.type === 'todo' && !entity.checked && counts.has(entity.parentId)) {
      counts.set(entity.parentId, counts.get(entity.parentId) + 1);
    }
  }
  return counts;
}