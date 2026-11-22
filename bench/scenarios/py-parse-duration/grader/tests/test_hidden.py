import unittest, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from duration import parse_duration
class T(unittest.TestCase):
    def test_mixed(self):
        self.assertEqual(parse_duration('1h30m'), 5400)
        self.assertEqual(parse_duration('1d2h3m4s'), 93784)
    def test_days(self):
        self.assertEqual(parse_duration('2d'), 172800)
    def test_bad(self):
        for bad in ['', 'abc', '5x', '10']:
            with self.assertRaises(ValueError):
                parse_duration(bad)
