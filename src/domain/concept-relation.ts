import { createHash } from "node:crypto";

export type ConceptRelationType =
  | "ANALOGY"
  | "APPLIES"
  | "CONTRASTS"
  | "EXTENDS"
  | "PREREQUISITE"
  | "SIMILAR";

export const SYMMETRIC_CONCEPT_RELATION_TYPES = new Set<ConceptRelationType>([
  "ANALOGY",
  "CONTRASTS",
  "SIMILAR",
]);

export function conceptMembershipFingerprint(
  memberships: Array<{ id: string; knowledgePointId: string }>,
): string {
  const stableMemberships = memberships
    .map(({ id, knowledgePointId }) => `${id}:${knowledgePointId}`)
    .sort();

  return createHash("sha256")
    .update(stableMemberships.join("\n"))
    .digest("hex");
}
