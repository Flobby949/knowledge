import type { Pool } from "pg";

import { cosineSimilarity } from "./semantic-search.js";

const CONCEPT_RECALL_THRESHOLD = 0.65;
const MAX_CONCEPT_INPUTS = 12;

interface RecallRow {
  embedding: number[];
  id: string;
}

export interface ConceptRecallResult {
  embeddingReady: boolean;
  knowledgePointIds: string[];
}

export async function recallConceptKnowledgePoints(options: {
  configurationVersion: number;
  pool: Pool;
  seedKnowledgePointIds: string[];
}): Promise<ConceptRecallResult> {
  const { configurationVersion, pool, seedKnowledgePointIds } = options;
  const rows = await readCurrentKnowledgePointEmbeddings(
    pool,
    configurationVersion,
  );
  const byId = new Map(rows.map((row) => [row.id, row.embedding]));
  const seedIds = [...new Set(seedKnowledgePointIds)].slice(
    0,
    MAX_CONCEPT_INPUTS,
  );
  const seedVectors = seedIds.flatMap((id) => {
    const embedding = byId.get(id);

    return embedding ? [embedding] : [];
  });

  if (seedVectors.length !== seedIds.length) {
    return { embeddingReady: false, knowledgePointIds: seedIds };
  }

  const seedSet = new Set(seedIds);
  const recalled = rows
    .flatMap((row) => {
      if (seedSet.has(row.id)) {
        return [];
      }

      const score = Math.max(
        ...seedVectors.map((embedding) =>
          cosineSimilarity(embedding, row.embedding),
        ),
      );

      return score >= CONCEPT_RECALL_THRESHOLD ? [{ id: row.id, score }] : [];
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.id.localeCompare(right.id),
    )
    .slice(0, Math.max(0, MAX_CONCEPT_INPUTS - seedIds.length));

  return {
    embeddingReady: true,
    knowledgePointIds: [...seedIds, ...recalled.map(({ id }) => id)],
  };
}

async function readCurrentKnowledgePointEmbeddings(
  pool: Pool,
  configurationVersion: number,
): Promise<RecallRow[]> {
  const result = await pool.query<RecallRow>(
    `SELECT point.id, embedding.embedding
       FROM knowledge_points AS point
       INNER JOIN records AS record
         ON record.id = point.record_id
        AND record.current_analysis_revision_id = point.analysis_revision_id
        AND record.archived_at IS NULL
       INNER JOIN ai_analysis_revisions AS analysis
         ON analysis.id = point.analysis_revision_id
        AND analysis.status = 'ACTIVE'
       INNER JOIN semantic_document_states AS state
         ON state.configuration_version = $1
        AND state.source_type = 'KNOWLEDGE_POINT'
        AND state.source_id = point.id
        AND state.status = 'READY'
       INNER JOIN semantic_embeddings AS embedding
         ON embedding.configuration_version = state.configuration_version
        AND embedding.source_type = state.source_type
        AND embedding.source_id = state.source_id
        AND embedding.text_content = state.text_content
      WHERE point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
        AND point.usage_status = 'INCLUDED'
      ORDER BY point.id`,
    [configurationVersion],
  );

  return result.rows;
}
