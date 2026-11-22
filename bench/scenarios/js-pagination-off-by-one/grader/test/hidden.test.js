const test = require('node:test'); const assert = require('node:assert');
const { paginate } = require('../lib/paginate');
test('last partial page', () => assert.deepStrictEqual(paginate([1,2,3,4,5], 3, 2), [5]));
test('second page', () => assert.deepStrictEqual(paginate([1,2,3,4,5], 2, 2), [3,4]));
test('beyond end', () => assert.deepStrictEqual(paginate([1,2,3], 9, 2), []));
test('page 0 treated as 1', () => assert.deepStrictEqual(paginate([1,2,3], 0, 2), [1,2]));
