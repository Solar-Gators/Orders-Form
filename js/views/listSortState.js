/**
 * Remembers each list's sort while you move around the app. Starts from the
 * list's configured default (Admin → Display → Request lists), and goes back to it if an admin
 * changes that default or the sorted column is removed from the list.
 */
const remembered = new Map(); // listName → { sort, from }

export function rememberedSort(listName, defaultSort, columns) {
  const from = `${defaultSort.key}:${defaultSort.dir}`;
  const entry = remembered.get(listName);
  if (!entry || entry.from !== from || !columns.some((c) => c.key === entry.sort.key)) {
    remembered.set(listName, { sort: { ...defaultSort }, from });
  }
  return remembered.get(listName).sort; // mutated in place by bindSorting
}
