"""Linear-time multi-pattern matching for keyword observation ingestion."""
from __future__ import annotations

from collections import deque
from typing import Hashable, Iterable


class MultiPatternMatcher:
    """Small dependency-free Aho-Corasick matcher."""

    def __init__(self, patterns: Iterable[tuple[str, Hashable]]):
        self.next: list[dict[str, int]] = [{}]
        self.fail: list[int] = [0]
        self.output: list[set[Hashable]] = [set()]
        for pattern, value in patterns:
            if not pattern:
                continue
            state = 0
            for char in pattern:
                child = self.next[state].get(char)
                if child is None:
                    child = self._new_state()
                    self.next[state][char] = child
                state = child
            self.output[state].add(value)
        self._build_failures()

    def _new_state(self) -> int:
        index = len(self.next)
        self.next.append({})
        self.fail.append(0)
        self.output.append(set())
        return index

    def _build_failures(self) -> None:
        queue: deque[int] = deque()
        for state in self.next[0].values():
            queue.append(state)
        while queue:
            state = queue.popleft()
            for char, child in self.next[state].items():
                queue.append(child)
                fallback = self.fail[state]
                while fallback and char not in self.next[fallback]:
                    fallback = self.fail[fallback]
                self.fail[child] = self.next[fallback].get(char, 0)
                self.output[child].update(self.output[self.fail[child]])

    def find(self, text: str) -> set[Hashable]:
        found: set[Hashable] = set()
        state = 0
        for char in text:
            while state and char not in self.next[state]:
                state = self.fail[state]
            state = self.next[state].get(char, 0)
            found.update(self.output[state])
        return found
