const boundaryWhitespace =
  /^\p{White_Space}+|\p{White_Space}+$/gu;
const internalWhitespace = /\p{White_Space}+/gu;
const latinRun = /\p{Script=Latin}+/gu;

export function normalizeTagName(value: string): string {
  return value
    .normalize("NFKC")
    .replace(boundaryWhitespace, "")
    .replace(internalWhitespace, " ")
    .replace(latinRun, (segment) => segment.toLocaleLowerCase("und"));
}
