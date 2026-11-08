// Small line diff (longest common subsequence) for showing changes before and after edits.
export function unifiedDiff(a: string, b: string, name = "file", context = 2): string {
  if (a === b) return "";
  const x = a.split("\n"), y = b.split("\n");
  if (x.length > 1500 || y.length > 1500) return `--- ${name}\n+++ ${name}\n(file is too big to show a line diff: ${x.length} -> ${y.length} lines)`;
  const n = x.length, m = y.length;
  const L: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const ops: Array<[string, string]> = [];
  let i = 0, j = 0;
  while (i < n && j < m) { if (x[i] === y[j]) { ops.push([" ", x[i]]); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) ops.push(["-", x[i++]]); else ops.push(["+", y[j++]]); }
  while (i < n) ops.push(["-", x[i++]]); while (j < m) ops.push(["+", y[j++]]);
  const keep = new Array(ops.length).fill(false);
  ops.forEach((o, k) => { if (o[0] !== " ") for (let d = -context; d <= context; d++) if (k + d >= 0 && k + d < ops.length) keep[k + d] = true; });
  const out = [`--- ${name}`, `+++ ${name}`]; let gap = false;
  ops.forEach((o, k) => { if (keep[k]) { out.push(o[0] + o[1]); gap = false; } else if (!gap) { out.push("@@ ..."); gap = true; } });
  return out.join("\n");
}
export function colorize(diff: string): string {
  return diff.split("\n").map((l) => l.startsWith("+") && !l.startsWith("+++") ? "\x1b[32m" + l + "\x1b[0m" : l.startsWith("-") && !l.startsWith("---") ? "\x1b[31m" + l + "\x1b[0m" : l.startsWith("@@") ? "\x1b[36m" + l + "\x1b[0m" : l).join("\n");
}
