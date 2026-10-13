export const highlightColors = [
  "yellow",
  "green",
  "blue",
  "pink",
  "purple",
] as const;
export type HighlightColor = (typeof highlightColors)[number];
export interface TextHighlight {
  start: number;
  end: number;
  color: HighlightColor;
}

// Offsets use UTF-16, matching browser Range and JavaScript string slicing.
export function paintHighlights(
  highlights: TextHighlight[],
  start: number,
  end: number,
  color: HighlightColor | null,
): TextHighlight[] {
  const next = highlights.flatMap((highlight) => {
    if (highlight.end <= start || highlight.start >= end) return [highlight];
    return [
      ...(highlight.start < start ? [{ ...highlight, end: start }] : []),
      ...(highlight.end > end ? [{ ...highlight, start: end }] : []),
    ];
  });
  if (color) next.push({ start, end, color });
  next.sort((a, b) => a.start - b.start);
  return next.reduce<TextHighlight[]>((merged, highlight) => {
    const previous = merged.at(-1);
    if (
      previous?.end === highlight.start &&
      previous.color === highlight.color
    ) {
      previous.end = highlight.end;
    } else {
      merged.push({ ...highlight });
    }
    return merged;
  }, []);
}

// Preserve only the unchanged prefix/suffix. Ambiguous edited text loses its mark.
export function rebaseHighlights(
  highlights: TextHighlight[],
  previous: string,
  current: string,
): TextHighlight[] {
  if (previous === current) return highlights;
  let prefix = 0;
  while (
    prefix < Math.min(previous.length, current.length) &&
    previous[prefix] === current[prefix]
  )
    prefix++;
  let suffix = 0;
  while (
    suffix < Math.min(previous.length, current.length) - prefix &&
    previous[previous.length - suffix - 1] ===
      current[current.length - suffix - 1]
  )
    suffix++;
  return highlights.flatMap((highlight) => {
    if (highlight.end <= prefix) return [highlight];
    if (highlight.start >= previous.length - suffix) {
      const shift = current.length - previous.length;
      return [
        {
          ...highlight,
          start: highlight.start + shift,
          end: highlight.end + shift,
        },
      ];
    }
    return [];
  });
}
