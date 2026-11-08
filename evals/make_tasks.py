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
 "Users report that paginate() in lib/paginate.js returns the wrong items: page 1 should be the first page, and a page number below 1 counts as page 1. Fix the bug. Run the tests to check.",
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

GOV = "go test ./..."
RSV = "cargo test --offline -q"
JAV = "rm -rf out && mkdir out && javac -d out $(find . -name '*.java') && for c in $(cd out && find . -name '*Test.class' | sed 's|^\\./||; s|\\.class$||'); do java -ea -cp out $c || exit 1; done"
TSV = "bun test"

task("go-dedupe-order",
 "Dedupe() in dedupe/dedupe.go should remove duplicate strings but keep the first occurrence of each in its original order. Right now the order changes. Fix it. Run the tests when done.",
 {"go.mod": "module example.com/dedupe\n\ngo 1.20\n",
  "dedupe/dedupe.go": """package dedupe

// Dedupe removes duplicates, keeping the first occurrence of each item in order.
func Dedupe(items []string) []string {
	seen := map[string]bool{}
	for _, it := range items {
		seen[it] = true
	}
	out := []string{}
	for k := range seen {
		out = append(out, k)
	}
	return out
}
""",
  "dedupe/dedupe_test.go": """package dedupe

import "testing"

func TestSingle(t *testing.T) {
	if got := Dedupe([]string{"a", "a"}); len(got) != 1 || got[0] != "a" {
		t.Fatalf("got %v", got)
	}
}
"""},
 {"dedupe/hidden_test.go": """package dedupe

import (
	"reflect"
	"testing"
)

func TestOrderKept(t *testing.T) {
	in := []string{"m", "c", "x", "a", "c", "q", "b", "m", "z", "a", "k", "t", "b", "y"}
	got := Dedupe(in)
	if !reflect.DeepEqual(got, []string{"m", "c", "x", "a", "q", "b", "z", "k", "t", "y"}) {
		t.Fatalf("got %v", got)
	}
}

func TestEmptyIsNotNil(t *testing.T) {
	got := Dedupe(nil)
	if got == nil || len(got) != 0 {
		t.Fatalf("got %#v", got)
	}
}
"""},
 {"dedupe/dedupe.go": """package dedupe

// Dedupe removes duplicates, keeping the first occurrence of each item in order.
func Dedupe(items []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, it := range items {
		if !seen[it] {
			seen[it] = true
			out = append(out, it)
		}
	}
	return out
}
"""}, GOV)

task("go-chunk",
 "Implement Chunk() in chunk/chunk.go as described in its comment. The existing test shows basic use. Run the tests when done.",
 {"go.mod": "module example.com/chunk\n\ngo 1.20\n",
  "chunk/chunk.go": """package chunk

import "errors"

var ErrSize = errors.New("chunk size must be positive")

// Chunk splits xs into consecutive slices of length n (the last one may be shorter).
// n <= 0 returns ErrSize. An empty input returns an empty (non-nil) result.
// The returned chunks must not share memory with xs.
func Chunk(xs []int, n int) ([][]int, error) {
	return nil, errors.New("not implemented")
}
""",
  "chunk/chunk_test.go": """package chunk

import "testing"

func TestBasic(t *testing.T) {
	got, err := Chunk([]int{1, 2, 3}, 2)
	if err != nil || len(got) != 2 {
		t.Fatalf("got %v %v", got, err)
	}
}
"""},
 {"chunk/hidden_test.go": """package chunk

import (
	"reflect"
	"testing"
)

func TestLastShort(t *testing.T) {
	got, _ := Chunk([]int{1, 2, 3, 4, 5}, 2)
	if !reflect.DeepEqual(got, [][]int{{1, 2}, {3, 4}, {5}}) {
		t.Fatalf("got %v", got)
	}
}

func TestBadSize(t *testing.T) {
	if _, err := Chunk([]int{1}, 0); err != ErrSize {
		t.Fatalf("err %v", err)
	}
}

func TestEmpty(t *testing.T) {
	got, err := Chunk(nil, 3)
	if err != nil || got == nil || len(got) != 0 {
		t.Fatalf("got %#v %v", got, err)
	}
}

func TestNoSharedMemory(t *testing.T) {
	xs := []int{1, 2, 3, 4}
	got, _ := Chunk(xs, 2)
	got[0][0] = 99
	if xs[0] != 1 {
		t.Fatalf("chunks share memory with the input")
	}
}
"""},
 {"chunk/chunk.go": """package chunk

import "errors"

var ErrSize = errors.New("chunk size must be positive")

// Chunk splits xs into consecutive slices of length n (the last one may be shorter).
// n <= 0 returns ErrSize. An empty input returns an empty (non-nil) result.
// The returned chunks must not share memory with xs.
func Chunk(xs []int, n int) ([][]int, error) {
	if n <= 0 {
		return nil, ErrSize
	}
	out := [][]int{}
	for i := 0; i < len(xs); i += n {
		end := i + n
		if end > len(xs) {
			end = len(xs)
		}
		c := make([]int, end-i)
		copy(c, xs[i:end])
		out = append(out, c)
	}
	return out, nil
}
"""}, GOV)

task("rust-median",
 "median() in src/lib.rs gives the wrong answer for lists with an even number of items, and it also changes the caller's data. Fix both: it must take a slice, not modify it, and return the mean of the two middle values for even lengths, or None for an empty slice. Run the tests when done.",
 {"Cargo.toml": '[package]\nname = "stats"\nversion = "0.1.0"\nedition = "2021"\n',
  "src/lib.rs": """pub fn median(values: &mut Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap());
    Some(values[values.len() / 2])
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn odd() {
        let mut v = vec![3.0, 1.0, 2.0];
        assert_eq!(median(&mut v), Some(2.0));
    }
}
"""},
 {"tests/hidden.rs": """use stats::median;

#[test]
fn even_length() {
    assert_eq!(median(&[4.0, 1.0, 3.0, 2.0]), Some(2.5));
}

#[test]
fn empty() {
    assert_eq!(median(&[]), None);
}

#[test]
fn input_unchanged() {
    let v = vec![3.0, 1.0, 2.0];
    let _ = median(&v);
    assert_eq!(v, vec![3.0, 1.0, 2.0]);
}
"""},
 {"src/lib.rs": """pub fn median(values: &[f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let mut v = values.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    if n % 2 == 1 {
        Some(v[n / 2])
    } else {
        Some((v[n / 2 - 1] + v[n / 2]) / 2.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn odd() {
        assert_eq!(median(&[3.0, 1.0, 2.0]), Some(2.0));
    }
}
"""}, RSV)

task("rust-roman",
 "Implement to_roman() in src/lib.rs: convert 1..=3999 to a Roman numeral using subtractive notation (4 = IV, 9 = IX, 40 = XL, 90 = XC, 400 = CD, 900 = CM), and return None for anything outside that range. Run the tests when done.",
 {"Cargo.toml": '[package]\nname = "roman"\nversion = "0.1.0"\nedition = "2021"\n',
  "src/lib.rs": """pub fn to_roman(n: u32) -> Option<String> {
    let _ = n;
    todo!()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn small() {
        assert_eq!(to_roman(3), Some("III".to_string()));
    }
}
"""},
 {"tests/hidden.rs": """use roman::to_roman;

#[test]
fn subtractive() {
    assert_eq!(to_roman(4).unwrap(), "IV");
    assert_eq!(to_roman(1994).unwrap(), "MCMXCIV");
    assert_eq!(to_roman(2024).unwrap(), "MMXXIV");
}

#[test]
fn limits() {
    assert_eq!(to_roman(3999).unwrap(), "MMMCMXCIX");
    assert_eq!(to_roman(0), None);
    assert_eq!(to_roman(4000), None);
}
"""},
 {"src/lib.rs": """pub fn to_roman(n: u32) -> Option<String> {
    if n == 0 || n > 3999 {
        return None;
    }
    let table = [
        (1000, "M"), (900, "CM"), (500, "D"), (400, "CD"), (100, "C"), (90, "XC"),
        (50, "L"), (40, "XL"), (10, "X"), (9, "IX"), (5, "V"), (4, "IV"), (1, "I"),
    ];
    let mut n = n;
    let mut out = String::new();
    for (v, s) in table {
        while n >= v {
            out.push_str(s);
            n -= v;
        }
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn small() {
        assert_eq!(to_roman(3), Some("III".to_string()));
    }
}
"""}, RSV)

task("java-word-count",
 "WordCounter.count() in src/WordCounter.java should count how often each word appears, ignoring upper/lower case and punctuation, and ignoring empty text pieces. It currently gets this wrong. Fix it. Run the tests when done (see tests/ for how they are run: compile everything with javac and run each *Test class).",
 {"src/WordCounter.java": """import java.util.HashMap;
import java.util.Map;

public class WordCounter {
    public static Map<String, Integer> count(String text) {
        Map<String, Integer> m = new HashMap<>();
        for (String w : text.split(" ")) {
            m.put(w, m.getOrDefault(w, 0) + 1);
        }
        return m;
    }
}
""",
  "tests/BasicTest.java": """public class BasicTest {
    public static void main(String[] a) {
        if (WordCounter.count("a b a").get("a") != 2) throw new AssertionError("a should be 2");
    }
}
"""},
 {"tests/HiddenTest.java": """import java.util.Map;

public class HiddenTest {
    static void eq(Object x, Object y) { if (!x.equals(y)) throw new AssertionError(x + " != " + y); }
    public static void main(String[] a) {
        Map<String, Integer> m = WordCounter.count("The cat, the DOG; the end.");
        eq(m.get("the"), 3);
        eq(m.get("dog"), 1);
        eq(m.get("end"), 1);
        eq(WordCounter.count("   ").size(), 0);
        eq(WordCounter.count("a  b").size(), 2);
    }
}
"""},
 {"src/WordCounter.java": """import java.util.HashMap;
import java.util.Map;

public class WordCounter {
    public static Map<String, Integer> count(String text) {
        Map<String, Integer> m = new HashMap<>();
        for (String w : text.toLowerCase().split("[^a-z0-9']+")) {
            if (w.isEmpty()) continue;
            m.put(w, m.getOrDefault(w, 0) + 1);
        }
        return m;
    }
}
"""}, JAV)

task("java-min-stack",
 "Implement the MinStack class in src/MinStack.java as described in its comment: push, pop, peek and min must all run in constant time. Empty-stack operations throw IllegalStateException. Run the tests when done (see tests/: compile everything with javac and run each *Test class).",
 {"src/MinStack.java": """/** A stack of ints. push(x), pop(), peek() and min() are all O(1).
 *  pop(), peek() and min() throw IllegalStateException when the stack is empty.
 *  size() returns the number of items. */
public class MinStack {
    public void push(int x) { throw new UnsupportedOperationException(); }
    public int pop() { throw new UnsupportedOperationException(); }
    public int peek() { throw new UnsupportedOperationException(); }
    public int min() { throw new UnsupportedOperationException(); }
    public int size() { throw new UnsupportedOperationException(); }
}
""",
  "tests/BasicTest.java": """public class BasicTest {
    public static void main(String[] a) {
        MinStack s = new MinStack(); s.push(2);
        if (s.peek() != 2) throw new AssertionError("peek");
    }
}
"""},
 {"tests/HiddenTest.java": """public class HiddenTest {
    static void eq(int x, int y) { if (x != y) throw new AssertionError(x + " != " + y); }
    public static void main(String[] a) {
        MinStack s = new MinStack();
        s.push(5); s.push(2); s.push(7); s.push(2);
        eq(s.min(), 2); eq(s.pop(), 2); eq(s.min(), 2); eq(s.pop(), 7); eq(s.pop(), 2); eq(s.min(), 5); eq(s.size(), 1);
        s.pop();
        try { s.min(); throw new AssertionError("min on empty"); } catch (IllegalStateException ok) { }
        try { s.pop(); throw new AssertionError("pop on empty"); } catch (IllegalStateException ok) { }
        try { s.peek(); throw new AssertionError("peek on empty"); } catch (IllegalStateException ok) { }
    }
}
"""},
 {"src/MinStack.java": """import java.util.ArrayDeque;
import java.util.Deque;

/** A stack of ints. push(x), pop(), peek() and min() are all O(1).
 *  pop(), peek() and min() throw IllegalStateException when the stack is empty.
 *  size() returns the number of items. */
public class MinStack {
    private final Deque<Integer> items = new ArrayDeque<>();
    private final Deque<Integer> mins = new ArrayDeque<>();
    public void push(int x) {
        items.push(x);
        mins.push(mins.isEmpty() ? x : Math.min(x, mins.peek()));
    }
    public int pop() {
        if (items.isEmpty()) throw new IllegalStateException("empty");
        mins.pop();
        return items.pop();
    }
    public int peek() {
        if (items.isEmpty()) throw new IllegalStateException("empty");
        return items.peek();
    }
    public int min() {
        if (mins.isEmpty()) throw new IllegalStateException("empty");
        return mins.peek();
    }
    public int size() { return items.size(); }
}
"""}, JAV)

task("ts-group-by",
 "groupBy() in src/groupBy.ts loses items: each group ends up with only the last item. Fix it so every item is kept, in input order, and keep the types correct. Run the tests when done.",
 {"package.json": '{"name":"groupby","type":"module"}',
  "src/groupBy.ts": """export function groupBy<T, K extends string | number>(items: T[], key: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    out[key(item)] = [item];
  }
  return out;
}
""",
  "src/groupBy.test.ts": """import { test, expect } from "bun:test";
import { groupBy } from "./groupBy";

test("one item", () => {
  expect(groupBy([1], (n) => n % 2)).toEqual({ 1: [1] });
});
"""},
 {"src/hidden.test.ts": """import { test, expect } from "bun:test";
import { groupBy } from "./groupBy";

test("keeps all items in order", () => {
  expect(groupBy(["apple", "avocado", "banana", "blueberry", "cherry"], (s) => s[0]!)).toEqual({
    a: ["apple", "avocado"],
    b: ["banana", "blueberry"],
    c: ["cherry"],
  });
});

test("empty", () => {
  expect(groupBy([], () => "x")).toEqual({});
});

test("does not change the input", () => {
  const xs = [3, 1, 2];
  groupBy(xs, (n) => n % 2);
  expect(xs).toEqual([3, 1, 2]);
});
"""},
 {"src/groupBy.ts": """export function groupBy<T, K extends string | number>(items: T[], key: (item: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const item of items) {
    const k = key(item);
    (out[k] ??= []).push(item);
  }
  return out;
}
"""}, TSV)

task("ts-parse-query",
 "Implement parseQuery() in src/query.ts. It turns a query string like 'a=1&b=hello+world&a=3&c=%C3%A9' into an object: values are decoded (+ means space, %XX escapes), a key that appears more than once becomes an array in order (otherwise it stays a string), a key without '=' gets an empty string, and a leading '?' is ignored. Run the tests when done.",
 {"package.json": '{"name":"query","type":"module"}',
  "src/query.ts": """export function parseQuery(qs: string): Record<string, string | string[]> {
  throw new Error("not implemented");
}
""",
  "src/query.test.ts": """import { test, expect } from "bun:test";
import { parseQuery } from "./query";

test("simple", () => {
  expect(parseQuery("a=1")).toEqual({ a: "1" });
});
"""},
 {"src/hidden.test.ts": """import { test, expect } from "bun:test";
import { parseQuery } from "./query";

test("repeats become arrays", () => {
  expect(parseQuery("a=1&b=2&a=3")).toEqual({ a: ["1", "3"], b: "2" });
});

test("decoding", () => {
  expect(parseQuery("?q=hello+world&c=%C3%A9")).toEqual({ q: "hello world", c: "\\u00e9" });
});

test("no equals and empty", () => {
  expect(parseQuery("flag&x=")).toEqual({ flag: "", x: "" });
  expect(parseQuery("")).toEqual({});
});

test("three of the same key", () => {
  expect(parseQuery("t=a&t=b&t=c")).toEqual({ t: ["a", "b", "c"] });
});
"""},
 {"src/query.ts": """export function parseQuery(qs: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const s = qs.startsWith("?") ? qs.slice(1) : qs;
  for (const part of s.split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    const dec = (x: string) => decodeURIComponent(x.replace(/\\+/g, " "));
    const k = dec(i < 0 ? part : part.slice(0, i));
    const v = i < 0 ? "" : dec(part.slice(i + 1));
    const cur = out[k];
    if (cur === undefined) out[k] = v;
    else if (Array.isArray(cur)) cur.push(v);
    else out[k] = [cur, v];
  }
  return out;
}
"""}, TSV)

here = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tasks")
for id, t in T.items():
    for sub, files in (("files", t["files"]), ("hidden", t["hidden"]), ("solution", t["solution"])):
        for p, c in files.items():
            fp = os.path.join(here, id, sub, p); os.makedirs(os.path.dirname(fp), exist_ok=True)
            with open(fp, "w", encoding="utf-8") as fh: fh.write(c)
    with open(os.path.join(here, id, "task.json"), "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"id": id, "prompt": t["prompt"], "verify": t["verify"]}, indent=2) + "\n")
print(len(T), "tasks written")
