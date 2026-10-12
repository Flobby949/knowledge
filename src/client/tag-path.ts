import type { TagChip } from "./api.js";

export const TAG_PATH_SEPARATOR = " › ";

/**
 * Full display path such as "编程 › 前端 › React". The path is derived from the
 * hierarchy for display only; Tag names are never split on any separator.
 */
export function tagPathLabel(tag: { ancestors?: TagChip[]; name: string }): string {
  return [...(tag.ancestors ?? []).map(({ name }) => name), tag.name].join(
    TAG_PATH_SEPARATOR,
  );
}

export function tagAncestorLabel(tag: { ancestors?: TagChip[] }): string {
  return (tag.ancestors ?? []).map(({ name }) => name).join(TAG_PATH_SEPARATOR);
}

/**
 * Keeps the server's order for siblings but places every Tag directly after
 * its parent, so flat vocabularies keep their original order.
 */
export function hierarchicalOrder<T extends { id: string; parentId: string | null }>(
  tags: T[],
): Array<{ depth: number; tag: T }> {
  const ids = new Set(tags.map(({ id }) => id));
  const childrenByParent = new Map<string, T[]>();
  const roots: T[] = [];

  for (const tag of tags) {
    if (tag.parentId && ids.has(tag.parentId)) {
      const siblings = childrenByParent.get(tag.parentId) ?? [];

      siblings.push(tag);
      childrenByParent.set(tag.parentId, siblings);
    } else {
      roots.push(tag);
    }
  }

  const ordered: Array<{ depth: number; tag: T }> = [];
  const visit = (tag: T, depth: number) => {
    ordered.push({ depth, tag });

    for (const child of childrenByParent.get(tag.id) ?? []) {
      visit(child, depth + 1);
    }
  };

  roots.forEach((root) => visit(root, 0));

  return ordered;
}
