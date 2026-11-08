#!/usr/bin/env python3
"""Writes the eval tasks into evals/tasks/. Each task has files/ (the starting project),
hidden/ (extra tests copied in AFTER the AI finishes), solution/ (a known fix, used only by --check)
and task.json. To add a task, add a task(...) call below."""
import os, json
T = {}
JSV = "node --test"
PYV = "python3 -m unittest discover -s tests"
def task(id, prompt, files, hidden, solution, verify):
    T[id] = dict(prompt=prompt, files=files, hidden=hidden, solution=solution, verify=verify)

task("js-pagination-off-by-one",
 "Users report that paginate() in lib/paginate.js returns the wrong items: page 1 should be the first page. Fix the bug. Run the tests to check.",
 {"package.json": '{"type":"commonjs"}',
  "lib/paginate.js": "function paginate(items, page, size) {\n  const start = page * size;\n  return items.slice(start, start + size);\n}\nmodule.exports = { paginate };\n",
  "test/paginate.test.js": "const test = require('node:test'); const assert = require('node:assert');\nconst { paginate } = require('../lib/paginate');\ntest('first page', () => assert.deepStrictEqual(paginate([1,2,3,4,5], 1, 2), [1,2]));\n"},
 {"test/hidden.test.js": "const test = require('node:test'); const assert = require('node:assert');\nconst { paginate } = require('../lib/paginate');\ntest('last partial page', () => assert.deepStrictEqual(paginate([1,2,3,4,5], 3, 2), [5]));\ntest('second page', () => assert.deepStrictEqual(paginate([1,2,3,4,5], 2, 2), [3,4]));\ntest('beyond end', () => assert.deepStrictEqual(paginate([1,2,3], 9, 2), []));\ntest('page 0 treated as 1', () => assert.deepStrictEqual(paginate([1,2,3], 0, 2), [1,2]));\n"},
 {"lib/paginate.js": "function paginate(items, page, size) {\n  const p = Math.max(1, page);\n  const start = (p - 1) * size;\n  return items.slice(start, start + size);\n}\nmodule.exports = { paginate };\n"}, JSV)

task("js-slugify",
 "Implement slugify() in lib/slugify.js following README.md. The existing test shows the basic idea. Run the tests when done.",
 {"package.json": '{"type":"commonjs"}',
  "README.md": "# slugify\n\n`slugify(text)` turns a title into a URL slug:\n- lowercase\n- letters and digits kept; every other run of characters becomes a single `-`\n- no `-` at the start or end\n- accents are removed (`Crème` -> `creme`)\n- empty result returns `\"n-a\"`\n",
  "lib/slugify.js": "function slugify(text) {\n  throw new Error('not implemented');\n}\nmodule.exports = { slugify };\n",
  "test/slugify.test.js": "const test = require('node:test'); const assert = require('node:assert');\nconst { slugify } = require('../lib/slugify');\ntest('basic', () => assert.strictEqual(slugify('Hello World'), 'hello-world'));\n"},
 {"test/hidden.test.js": "const test = require('node:test'); const assert = require('node:assert');\nconst { slugify } = require('../lib/slugify');\ntest('punctuation runs', () => assert.strictEqual(slugify('  Rock & Roll!!  2024 '), 'rock-roll-2024'));\ntest('accents', () => assert.strictEqual(slugify('Crème Brûlée'), 'creme-brulee'));\ntest('empty', () => assert.strictEqual(slugify('***'), 'n-a'));\ntest('edges', () => assert.strictEqual(slugify('--a--'), 'a'));\n"},
 {"lib/slugify.js": "function slugify(text) {\n  const s = String(text).normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');\n  return s || 'n-a';\n}\nmodule.exports = { slugify };\n"}, JSV)

task("js-rename-across-files",
 "Rename the function getUser to fetchUser everywhere in this project (definition, all callers and the existing tests). Keep behaviour the same. Run the tests when done.",
 {"package.json": '{"type":"commonjs"}',
  "src/users.js": "const DB = { 1: 'ann', 2: 'bob' };\nfunction getUser(id) { return DB[id] || null; }\nmodule.exports = { getUser };\n",
  "src/greet.js": "const { getUser } = require('./users');\nfunction greet(id) { const u = getUser(id); return u ? 'Hello ' + u : 'Hello stranger'; }\nmodule.exports = { greet };\n",
  "src/report.js": "const { getUser } = require('./users');\nfunction names(ids) { return ids.map(getUser).filter(Boolean); }\nmodule.exports = { names };\n",
  "test/users.test.js": "const test = require('node:test'); const assert = require('node:assert');\nconst { getUser } = require('../src/users');\ntest('known user', () => assert.strictEqual(getUser(1), 'ann'));\n"},
 {"test/hidden.test.js": "const test = require('node:test'); const assert = require('node:assert'); const fs = require('node:fs');\nconst { fetchUser } = require('../src/users'); const { greet } = require('../src/greet'); const { names } = require('../src/report');\ntest('renamed export', () => { assert.strictEqual(fetchUser(2), 'bob'); assert.strictEqual(require('../src/users').getUser, undefined); });\ntest('callers work', () => { assert.strictEqual(greet(1), 'Hello ann'); assert.deepStrictEqual(names([1,2,3]), ['ann','bob']); });\ntest('no old name left in src', () => { for (const f of ['users','greet','report']) assert.ok(!/getUser/.test(fs.readFileSync(__dirname + '/../src/' + f + '.js', 'utf8')), f); });\n"},
 {"src/users.js": "const DB = { 1: 'ann', 2: 'bob' };\nfunction fetchUser(id) { return DB[id] || null; }\nmodule.exports = { fetchUser };\n",
  "src/greet.js": "const { fetchUser } = require('./users');\nfunction greet(id) { const u = fetchUser(id); return u ? 'Hello ' + u : 'Hello stranger'; }\nmodule.exports = { greet };\n",
  "src/report.js": "const { fetchUser } = require('./users');\nfunction names(ids) { return ids.map(fetchUser).filter(Boolean); }\nmodule.exports = { names };\n",
  "test/users.test.js": "const test = require('node:test'); const assert = require('node:assert');\nconst { fetchUser } = require('../src/users');\ntest('known user', () => assert.strictEqual(fetchUser(1), 'ann'));\n"}, JSV)

task("js-async-await-bug",
 "loadAll() in lib/loader.js sometimes returns before the work has finished and results are in the wrong order. Fix it so results come back in the same order as the input ids. Run the tests when done.",
 {"package.json": '{"type":"commonjs"}',
  "lib/loader.js": "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\nasync function load(id) { await sleep(id === 1 ? 30 : 5); return { id, name: 'item' + id }; }\nasync function loadAll(ids) {\n  const out = [];\n  ids.forEach(async (id) => { out.push(await load(id)); });\n  return out;\n}\nmodule.exports = { load, loadAll };\n",
  "test/loader.test.js": "const test = require('node:test'); const assert = require('node:assert');\nconst { loadAll } = require('../lib/loader');\ntest('loads one', async () => assert.strictEqual((await loadAll([2])).length, 1));\n"},
 {"test/hidden.test.js": "const test = require('node:test'); const assert = require('node:assert');\nconst { loadAll } = require('../lib/loader');\ntest('keeps order', async () => assert.deepStrictEqual((await loadAll([1,2,3])).map((x) => x.id), [1,2,3]));\ntest('empty', async () => assert.deepStrictEqual(await loadAll([]), []));\n"},
 {"lib/loader.js": "const sleep = (ms) => new Promise((r) => setTimeout(r, ms));\nasync function load(id) { await sleep(id === 1 ? 30 : 5); return { id, name: 'item' + id }; }\nasync function loadAll(ids) {\n  return Promise.all(ids.map((id) => load(id)));\n}\nmodule.exports = { load, loadAll };\n"}, JSV)

task("py-mutable-default",
 "Bug report: add_tag() in tagger.py shares tags between different items. Fix it without changing the function's public behaviour. Run the tests when done.",
 {"tagger.py": "def add_tag(tag, tags=[]):\n    tags.append(tag)\n    return tags\n",
  "tests/test_tagger.py": "import unittest, sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))\nfrom tagger import add_tag\nclass T(unittest.TestCase):\n    def test_one(self):\n        self.assertEqual(add_tag('a', []), ['a'])\nif __name__ == '__main__':\n    unittest.main()\n"},
 {"tests/test_hidden.py": "import unittest, sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))\nfrom tagger import add_tag\nclass T(unittest.TestCase):\n    def test_independent(self):\n        self.assertEqual(add_tag('a'), ['a'])\n        self.assertEqual(add_tag('b'), ['b'])\n    def test_extend_given(self):\n        base = ['x']\n        self.assertEqual(add_tag('y', base), ['x', 'y'])\n"},
 {"tagger.py": "def add_tag(tag, tags=None):\n    if tags is None:\n        tags = []\n    tags.append(tag)\n    return tags\n"}, PYV)

task("py-lru-cache",
 "Implement the LRUCache class in cache.py as described in its docstring. The existing test shows basic use. Run the tests when done.",
 {"cache.py": "class LRUCache:\n    \"\"\"Least-recently-used cache.\n\n    LRUCache(capacity): capacity >= 1.\n    get(key): return the value and mark it most recently used; return None if missing.\n    put(key, value): insert or update (also marks it most recently used).\n        When the cache is over capacity, remove the least recently used key.\n    len(cache) returns the number of stored keys.\n    \"\"\"\n\n    def __init__(self, capacity):\n        raise NotImplementedError\n",
  "tests/test_cache.py": "import unittest, sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))\nfrom cache import LRUCache\nclass T(unittest.TestCase):\n    def test_basic(self):\n        c = LRUCache(2); c.put('a', 1); self.assertEqual(c.get('a'), 1)\n"},
 {"tests/test_hidden.py": "import unittest, sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))\nfrom cache import LRUCache\nclass T(unittest.TestCase):\n    def test_evicts_lru(self):\n        c = LRUCache(2); c.put('a', 1); c.put('b', 2); c.get('a'); c.put('c', 3)\n        self.assertIsNone(c.get('b')); self.assertEqual(c.get('a'), 1); self.assertEqual(c.get('c'), 3); self.assertEqual(len(c), 2)\n    def test_update_refreshes(self):\n        c = LRUCache(2); c.put('a', 1); c.put('b', 2); c.put('a', 9); c.put('c', 3)\n        self.assertEqual(c.get('a'), 9); self.assertIsNone(c.get('b'))\n    def test_missing(self):\n        self.assertIsNone(LRUCache(1).get('x'))\n"},
 {"cache.py": "from collections import OrderedDict\n\nclass LRUCache:\n    \"\"\"Least-recently-used cache.\n\n    LRUCache(capacity): capacity >= 1.\n    get(key): return the value and mark it most recently used; return None if missing.\n    put(key, value): insert or update (also marks it most recently used).\n        When the cache is over capacity, remove the least recently used key.\n    len(cache) returns the number of stored keys.\n    \"\"\"\n\n    def __init__(self, capacity):\n        self.capacity = capacity\n        self.data = OrderedDict()\n\n    def get(self, key):\n        if key not in self.data:\n            return None\n        self.data.move_to_end(key)\n        return self.data[key]\n\n    def put(self, key, value):\n        self.data[key] = value\n        self.data.move_to_end(key)\n        while len(self.data) > self.capacity:\n            self.data.popitem(last=False)\n\n    def __len__(self):\n        return len(self.data)\n"}, PYV)

task("py-wrap-text",
 "Implement wrap(text, width) in wrap.py: break text into lines of at most `width` characters, breaking only at spaces, and return the list of lines. A single word longer than width stays on its own line. Run the tests when done.",
 {"wrap.py": "def wrap(text, width):\n    raise NotImplementedError\n",
  "tests/test_wrap.py": "import unittest, sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))\nfrom wrap import wrap\nclass T(unittest.TestCase):\n    def test_simple(self):\n        self.assertEqual(wrap('aa bb cc', 5), ['aa bb', 'cc'])\n"},
 {"tests/test_hidden.py": "import unittest, sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))\nfrom wrap import wrap\nclass T(unittest.TestCase):\n    def test_long_word(self):\n        self.assertEqual(wrap('a abcdefgh b', 4), ['a', 'abcdefgh', 'b'])\n    def test_exact(self):\n        self.assertEqual(wrap('ab cd ef', 5), ['ab cd', 'ef'])\n    def test_extra_spaces(self):\n        self.assertEqual(wrap('  a   b  ', 10), ['a b'])\n    def test_empty(self):\n        self.assertEqual(wrap('', 5), [])\n"},
 {"wrap.py": "def wrap(text, width):\n    lines, cur = [], ''\n    for word in text.split():\n        if not cur:\n            cur = word\n        elif len(cur) + 1 + len(word) <= width:\n            cur += ' ' + word\n        else:\n            lines.append(cur)\n            cur = word\n    if cur:\n        lines.append(cur)\n    return lines\n"}, PYV)

task("py-parse-duration",
 "parse_duration() in duration.py should turn strings like '1h30m', '45s', '2d' or '1d2h3m4s' into a number of seconds, but it gives wrong answers. Fix it. Raise ValueError for text it cannot understand. Run the tests when done.",
 {"duration.py": "import re\n\nUNITS = {'d': 86400, 'h': 3600, 'm': 60, 's': 1}\n\ndef parse_duration(text):\n    total = 0\n    for num, unit in re.findall(r'(\\d+)([a-z])', text):\n        total += int(num) * UNITS['s']\n    return total\n",
  "tests/test_duration.py": "import unittest, sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))\nfrom duration import parse_duration\nclass T(unittest.TestCase):\n    def test_seconds(self):\n        self.assertEqual(parse_duration('45s'), 45)\n"},
 {"tests/test_hidden.py": "import unittest, sys, os\nsys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))\nfrom duration import parse_duration\nclass T(unittest.TestCase):\n    def test_mixed(self):\n        self.assertEqual(parse_duration('1h30m'), 5400)\n        self.assertEqual(parse_duration('1d2h3m4s'), 93784)\n    def test_days(self):\n        self.assertEqual(parse_duration('2d'), 172800)\n    def test_bad(self):\n        for bad in ['', 'abc', '5x', '10']:\n            with self.assertRaises(ValueError):\n                parse_duration(bad)\n"},
 {"duration.py": "import re\n\nUNITS = {'d': 86400, 'h': 3600, 'm': 60, 's': 1}\n\ndef parse_duration(text):\n    if not re.fullmatch(r'(\\d+[dhms])+', text or ''):\n        raise ValueError('bad duration: %r' % (text,))\n    total = 0\n    for num, unit in re.findall(r'(\\d+)([dhms])', text):\n        total += int(num) * UNITS[unit]\n    return total\n"}, PYV)

here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tasks")
for id, t in T.items():
    for sub, files in (("files", t["files"]), ("hidden", t["hidden"]), ("solution", t["solution"])):
        for p, c in files.items():
            fp = os.path.join(here, id, sub, p); os.makedirs(os.path.dirname(fp), exist_ok=True)
            with open(fp, "w", encoding="utf-8") as fh: fh.write(c)
    with open(os.path.join(here, id, "task.json"), "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"id": id, "prompt": t["prompt"], "verify": t["verify"]}, indent=2) + "\n")
print(len(T), "tasks written")
