/** Dependency-free Aho-Corasick matcher used only against changed source rows. */
export class KeywordMatcher<T> {
  private readonly next: Array<Map<string, number>> = [new Map()]
  private readonly fail: number[] = [0]
  private readonly output: Array<Set<T>> = [new Set()]

  constructor(patterns: Iterable<readonly [string, T]>) {
    for (const [pattern, value] of patterns) {
      if (!pattern) continue
      let state = 0
      for (const character of pattern) {
        let child = this.next[state].get(character)
        if (child === undefined) {
          child = this.next.length
          this.next[state].set(character, child)
          this.next.push(new Map())
          this.fail.push(0)
          this.output.push(new Set())
        }
        state = child
      }
      this.output[state].add(value)
    }
    this.buildFailures()
  }

  private buildFailures(): void {
    const queue = [...this.next[0].values()]
    for (let offset = 0; offset < queue.length; offset += 1) {
      const state = queue[offset]
      for (const [character, child] of this.next[state]) {
        queue.push(child)
        let fallback = this.fail[state]
        while (fallback && !this.next[fallback].has(character)) fallback = this.fail[fallback]
        this.fail[child] = this.next[fallback].get(character) ?? 0
        for (const value of this.output[this.fail[child]]) this.output[child].add(value)
      }
    }
  }

  find(text: string): Set<T> {
    const found = new Set<T>()
    let state = 0
    for (const character of text) {
      while (state && !this.next[state].has(character)) state = this.fail[state]
      state = this.next[state].get(character) ?? 0
      for (const value of this.output[state]) found.add(value)
    }
    return found
  }
}
