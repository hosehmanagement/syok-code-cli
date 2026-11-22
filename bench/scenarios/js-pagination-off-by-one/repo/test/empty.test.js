const test = require('node:test'); const assert = require('node:assert');
const { paginate } = require('../lib/paginate');
test('empty list gives an empty page', () => assert.deepStrictEqual(paginate([], 1, 2), []));
