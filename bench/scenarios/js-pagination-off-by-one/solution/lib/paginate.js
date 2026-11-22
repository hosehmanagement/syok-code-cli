function paginate(items, page, size) {
  const p = Math.max(1, page);
  const start = (p - 1) * size;
  return items.slice(start, start + size);
}
module.exports = { paginate };
