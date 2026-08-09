const graphemeSegmenter = new Intl.Segmenter("und", {
  granularity: "grapheme",
});

export function countGraphemes(value: string): number {
  let count = 0;

  for (const _segment of graphemeSegmenter.segment(value)) {
    count += 1;
  }

  return count;
}

export function hasNonWhitespace(value: string): boolean {
  return /\P{White_Space}/u.test(value);
}
