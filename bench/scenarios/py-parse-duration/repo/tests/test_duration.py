import unittest, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from duration import parse_duration
class T(unittest.TestCase):
    def test_seconds(self):
        self.assertEqual(parse_duration('45s'), 45)
