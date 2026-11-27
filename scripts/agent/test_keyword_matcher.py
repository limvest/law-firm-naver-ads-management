#!/usr/bin/env python3
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))

from keyword_matcher import MultiPatternMatcher  # noqa: E402


class MultiPatternMatcherTest(unittest.TestCase):
    def test_matches_overlapping_patterns_and_deduplicates_payloads(self):
        matcher = MultiPatternMatcher([
            ("알파", "alpha"),
            ("알파마켓", "alpha-market"),
            ("마켓", "market"),
            ("알파", "alpha"),
        ])
        self.assertEqual(matcher.find("신규알파마켓피해"), {"alpha", "alpha-market", "market"})

    def test_large_pattern_set_finds_only_present_values(self):
        patterns = [(f"업체{i}", i) for i in range(10_000)]
        matcher = MultiPatternMatcher(patterns)
        found = matcher.find("업체9999및업체42피해")
        self.assertIn(9999, found)
        self.assertIn(42, found)
        self.assertNotIn(7, found)


if __name__ == "__main__":
    unittest.main()
