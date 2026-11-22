import unittest, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
from tagger import add_tag
class T(unittest.TestCase):
    def test_independent(self):
        self.assertEqual(add_tag('a'), ['a'])
        self.assertEqual(add_tag('b'), ['b'])
    def test_extend_given(self):
        base = ['x']
        self.assertEqual(add_tag('y', base), ['x', 'y'])
