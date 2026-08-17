/**
 * LineScanner provides a clean, sequential cursor over an array of text lines.
 */
export class LineScanner {
  private index = 0
  readonly lines: ReadonlyArray<string>

  constructor(lines: ReadonlyArray<string>) {
    this.lines = lines
  }

  get hasNext(): boolean {
    return this.index < this.lines.length
  }

  get position(): number {
    return this.index
  }

  peek(): string | undefined {
    return this.lines[this.index]
  }

  peekAt(offset: number): string | undefined {
    return this.lines[this.index + offset]
  }

  next(): string | undefined {
    return this.lines[this.index++]
  }

  skipEmpty(): void {
    while (this.hasNext && this.lines[this.index]!.trim() === "") {
      this.index++
    }
  }

  consumeIf(predicate: (line: string) => boolean): string | undefined {
    const current = this.peek()
    if (current !== undefined && predicate(current)) {
      this.index++
      return current
    }
    return undefined
  }
}
