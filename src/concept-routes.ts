import { randomUUID } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";

import { normalizeConceptName } from "./domain/concept-name.js";

type Timestamp = Date | string;

interface ConceptRow {
  active_membership_count: number;
  archived_at: Timestamp | null;
  created_at: Timestamp;
  description: string;
  display_name: string;
  id: string;
  review_membership_count: number;
  revision_number: number;
  updated_at: Timestamp;
}

interface ConceptRevisionRow {
  created_at: Timestamp;
  description: string;
  display_name: string;
  id: string;
  revision_number: number;
}

interface ConceptMembershipRow {
  body: string;
  created_at: Timestamp;
  current: boolean;
  id: string;
  knowledge_point_id: string;
  origin: "USER";
  record_id: string;
  record_source: string;
  record_title: string | null;
  removed_at: Timestamp | null;
  title: string;
}

interface ConceptActivityRow {
  kind:
    | "ARCHIVED"
    | "CREATED"
    | "MEMBER_ADDED"
    | "MEMBER_REMOVED"
    | "MEMBER_RESTORED"
    | "RESTORED"
    | "UPDATED";
  membership_id: string | null;
  occurred_at: Timestamp;
  revision_id: string | null;
  sequence_number: number;
}

interface LockedConceptRow {
  archived_at: Timestamp | null;
  description: string;
  display_name: string;
  normalized_name: string;
  revision_number: number;
}

interface LockedConceptLifecycleRow {
  archived_at: Timestamp | null;
  id: string;
}

interface LockedMembershipRow {
  id: string;
  knowledge_point_id: string;
  removed_at: Timestamp | null;
}

interface ConceptSourceRow {
  body: string;
  id: string;
  record_id: string;
  record_source: string;
  record_title: string | null;
  title: string;
}

export function registerConceptRoutes(
  app: FastifyInstance,
  options: { pool: Pool },
): void {
  const { pool } = options;

  app.get<{ Querystring: { q?: string } }>(
    "/api/v1/concept-sources",
    async (request) => {
      const query = request.query.q?.trim() ?? "";
      const result = await pool.query<ConceptSourceRow>(
        `SELECT point.id,
                point.record_id,
                COALESCE(correction.title, point.ai_title) AS title,
                COALESCE(correction.body, point.ai_body) AS body,
                COALESCE(overview.title, analysis.title) AS record_title,
                revision.content AS record_source
           FROM knowledge_points AS point
           INNER JOIN ai_analysis_revisions AS analysis
             ON analysis.id = point.analysis_revision_id
            AND analysis.status = 'ACTIVE'
           INNER JOIN records AS record
             ON record.id = point.record_id
            AND record.current_analysis_revision_id = analysis.id
            AND record.archived_at IS NULL
           INNER JOIN fragment_revisions AS revision
             ON revision.id = record.current_fragment_revision_id
           LEFT JOIN knowledge_point_corrections AS correction
             ON correction.knowledge_point_id = point.id
           LEFT JOIN record_overview_corrections AS overview
             ON overview.record_id = record.id
            AND overview.analysis_revision_id = analysis.id
          WHERE point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
            AND point.usage_status = 'INCLUDED'
            AND (
              $1 = ''
              OR COALESCE(correction.title, point.ai_title) ILIKE '%' || $1 || '%'
              OR COALESCE(correction.body, point.ai_body) ILIKE '%' || $1 || '%'
              OR COALESCE(overview.title, analysis.title) ILIKE '%' || $1 || '%'
              OR revision.content ILIKE '%' || $1 || '%'
            )
          ORDER BY record.updated_at DESC, point.position, point.id
          LIMIT 100`,
        [query],
      );

      return {
        items: result.rows.map((source) => ({
          id: source.id,
          recordId: source.record_id,
          recordTitle:
            source.record_title ?? firstNonEmptyLine(source.record_source),
          title: source.title,
          body: source.body,
        })),
      };
    },
  );

  app.get<{
    Querystring: { archive?: string; q?: string };
  }>("/api/v1/concepts", async (request, reply) => {
    const archive = request.query.archive ?? "active";

    if (!new Set(["active", "all", "archived"]).has(archive)) {
      return reply.code(422).send({
        error: {
          code: "CONCEPT_QUERY_INVALID",
          message: "Concept 列表筛选无效。",
        },
      });
    }

    const result = await pool.query<ConceptRow>(
      `${CONCEPT_SELECT}
        WHERE (
          ($1 = 'all')
          OR ($1 = 'active' AND concept.archived_at IS NULL)
          OR ($1 = 'archived' AND concept.archived_at IS NOT NULL)
        )
          AND ($2 = '' OR revision.display_name ILIKE '%' || $2 || '%'
               OR revision.description ILIKE '%' || $2 || '%')
        ${CONCEPT_GROUP_BY}
        ORDER BY concept.updated_at DESC, concept.id DESC`,
      [archive, request.query.q?.trim() ?? ""],
    );

    return { items: result.rows.map(publicConceptSummary) };
  });

  app.post<{ Body: unknown }>("/api/v1/concepts", async (request, reply) => {
    if (!isCreateConceptBody(request.body)) {
      return invalidConcept(reply);
    }

    const displayName = request.body.name.trim();
    const normalizedName = normalizeConceptName(displayName);
    const description = request.body.description.trim();
    const knowledgePointIds = [...new Set(request.body.knowledgePointIds)];

    if (!normalizedName || !description || knowledgePointIds.length < 2) {
      return invalidConcept(reply);
    }

    const existing = await readConceptByNormalizedName(pool, normalizedName);

    if (existing) {
      return conceptNameConflict(reply, existing);
    }

    const client = await pool.connect();
    const conceptId = randomUUID();
    const revisionId = randomUUID();

    try {
      await client.query("BEGIN");
      const activePoints = await lockCurrentKnowledgePoints(
        client,
        knowledgePointIds,
      );

      if (activePoints.size !== knowledgePointIds.length) {
        await client.query("ROLLBACK");
        return reply.code(409).send({
          error: {
            code: "CONCEPT_POINTS_NOT_CURRENT",
            message: "只能使用当前生效且未排除的知识点创建 Concept。",
          },
        });
      }

      await client.query(
        `INSERT INTO concepts
           (id, current_revision_id, normalized_name)
         VALUES ($1, $2, $3)`,
        [conceptId, revisionId, normalizedName],
      );
      await client.query(
        `INSERT INTO concept_revisions
           (id, concept_id, revision_number, display_name, normalized_name,
            description)
         VALUES ($1, $2, 1, $3, $4, $5)`,
        [
          revisionId,
          conceptId,
          displayName,
          normalizedName,
          description,
        ],
      );
      await client.query(
        `INSERT INTO concept_activity
           (concept_id, sequence_number, kind, revision_id)
         VALUES ($1, 1, 'CREATED', $2)`,
        [conceptId, revisionId],
      );

      let sequenceNumber = 2;

      for (const knowledgePointId of knowledgePointIds) {
        const membershipId = randomUUID();

        await client.query(
          `INSERT INTO concept_memberships
             (id, concept_id, knowledge_point_id)
           VALUES ($1, $2, $3)`,
          [membershipId, conceptId, knowledgePointId],
        );
        await client.query(
          `INSERT INTO concept_activity
             (concept_id, sequence_number, kind, membership_id)
           VALUES ($1, $2, 'MEMBER_ADDED', $3)`,
          [conceptId, sequenceNumber, membershipId],
        );
        sequenceNumber += 1;
      }

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");

      if (isConceptNameUniqueViolation(error)) {
        const conflict = await readConceptByNormalizedName(pool, normalizedName);

        if (conflict) {
          return conceptNameConflict(reply, conflict);
        }
      }

      throw error;
    } finally {
      client.release();
    }

    const detail = await readConceptDetail(pool, conceptId);

    if (!detail) {
      throw new Error("Created Concept could not be read");
    }

    return reply
      .code(201)
      .header("location", `/api/v1/concepts/${conceptId}`)
      .send({ detail });
  });

  app.get<{ Params: { id: string } }>(
    "/api/v1/concepts/:id",
    async (request, reply) => {
      if (!isUuid(request.params.id)) {
        return conceptNotFound(reply);
      }

      const detail = await readConceptDetail(pool, request.params.id);

      if (!detail) {
        return reply.code(404).send({
          error: {
            code: "CONCEPT_NOT_FOUND",
            message: "没有找到这个 Concept。",
          },
        });
      }

      return { detail };
    },
  );

  app.patch<{ Body: unknown; Params: { id: string } }>(
    "/api/v1/concepts/:id",
    async (request, reply) => {
      if (!isUuid(request.params.id)) {
        return conceptNotFound(reply);
      }

      if (!isUpdateConceptBody(request.body)) {
        return invalidConceptUpdate(reply);
      }

      const client = await pool.connect();
      let normalizedName = "";

      try {
        await client.query("BEGIN");
        const locked = await client.query<LockedConceptRow>(
          `SELECT concept.normalized_name,
                  concept.archived_at,
                  revision.display_name,
                  revision.description,
                  revision.revision_number
             FROM concepts AS concept
             INNER JOIN concept_revisions AS revision
               ON revision.id = concept.current_revision_id
            WHERE concept.id = $1
            FOR UPDATE OF concept`,
          [request.params.id],
        );
        const current = locked.rows[0];

        if (!current) {
          await client.query("ROLLBACK");
          return conceptNotFound(reply);
        }

        if (current.archived_at) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: {
              code: "CONCEPT_ARCHIVED",
              message: "请先恢复 Concept，再修改名称或描述。",
            },
          });
        }

        const name = (request.body.name ?? current.display_name).trim();
        const description = (
          request.body.description ?? current.description
        ).trim();

        normalizedName = normalizeConceptName(name);

        if (!normalizedName || !description) {
          await client.query("ROLLBACK");
          return invalidConceptUpdate(reply);
        }

        const conflict = await readConceptByNormalizedName(
          client,
          normalizedName,
        );

        if (conflict && conflict.id !== request.params.id) {
          await client.query("ROLLBACK");
          return conceptNameConflict(reply, conflict);
        }

        if (
          name === current.display_name &&
          description === current.description
        ) {
          await client.query("ROLLBACK");
          const detail = await readConceptDetail(pool, request.params.id);

          return { detail };
        }

        const revisionId = randomUUID();
        const sequenceNumber = await nextActivitySequence(
          client,
          request.params.id,
        );

        await client.query(
          `INSERT INTO concept_revisions
             (id, concept_id, revision_number, display_name, normalized_name,
              description)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            revisionId,
            request.params.id,
            current.revision_number + 1,
            name,
            normalizedName,
            description,
          ],
        );
        await client.query(
          `UPDATE concepts
              SET current_revision_id = $2,
                  normalized_name = $3,
                  updated_at = clock_timestamp()
            WHERE id = $1`,
          [request.params.id, revisionId, normalizedName],
        );
        await client.query(
          `INSERT INTO concept_activity
             (concept_id, sequence_number, kind, revision_id)
           VALUES ($1, $2, 'UPDATED', $3)`,
          [request.params.id, sequenceNumber, revisionId],
        );
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");

        if (normalizedName && isConceptNameUniqueViolation(error)) {
          const conflict = await readConceptByNormalizedName(
            pool,
            normalizedName,
          );

          if (conflict) {
            return conceptNameConflict(reply, conflict);
          }
        }

        throw error;
      } finally {
        client.release();
      }

      const detail = await readConceptDetail(pool, request.params.id);

      if (!detail) {
        throw new Error("Updated Concept could not be read");
      }

      return { detail };
    },
  );

  app.post<{ Body: unknown; Params: { id: string } }>(
    "/api/v1/concepts/:id/memberships",
    async (request, reply) => {
      if (!isUuid(request.params.id)) {
        return conceptNotFound(reply);
      }

      if (!isAddMembershipBody(request.body)) {
        return invalidMembership(reply);
      }

      const client = await pool.connect();
      let membershipId = "";

      try {
        await client.query("BEGIN");
        const concept = await lockConcept(client, request.params.id);

        if (!concept) {
          await client.query("ROLLBACK");
          return conceptNotFound(reply);
        }

        if (concept.archived_at) {
          await client.query("ROLLBACK");
          return archivedConceptMembership(reply);
        }

        const activePoints = await lockCurrentKnowledgePoints(client, [
          request.body.knowledgePointId,
        ]);

        if (!activePoints.has(request.body.knowledgePointId)) {
          await client.query("ROLLBACK");
          return inactiveMembershipPoint(reply);
        }

        const existing = await client.query<LockedMembershipRow>(
          `SELECT id, knowledge_point_id, removed_at
             FROM concept_memberships
            WHERE concept_id = $1
              AND knowledge_point_id = $2
            FOR UPDATE`,
          [request.params.id, request.body.knowledgePointId],
        );

        if (existing.rows[0]) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: {
              code: existing.rows[0].removed_at
                ? "CONCEPT_MEMBERSHIP_REMOVED"
                : "CONCEPT_MEMBERSHIP_EXISTS",
              message: existing.rows[0].removed_at
                ? "这个知识点曾属于该 Concept，请恢复原 Membership。"
                : "这个知识点已经属于该 Concept。",
              details: { membershipId: existing.rows[0].id },
            },
          });
        }

        membershipId = randomUUID();
        const sequenceNumber = await nextActivitySequence(
          client,
          request.params.id,
        );

        await client.query(
          `INSERT INTO concept_memberships
             (id, concept_id, knowledge_point_id)
           VALUES ($1, $2, $3)`,
          [membershipId, request.params.id, request.body.knowledgePointId],
        );
        await client.query(
          `INSERT INTO concept_activity
             (concept_id, sequence_number, kind, membership_id)
           VALUES ($1, $2, 'MEMBER_ADDED', $3)`,
          [request.params.id, sequenceNumber, membershipId],
        );
        await touchConcept(client, request.params.id);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      const detail = await requiredConceptDetail(pool, request.params.id);

      return reply
        .code(201)
        .header(
          "location",
          `/api/v1/concepts/${request.params.id}/memberships/${membershipId}`,
        )
        .send({ detail });
    },
  );

  app.delete<{ Params: { id: string; membershipId: string } }>(
    "/api/v1/concepts/:id/memberships/:membershipId",
    async (request, reply) => {
      if (!isUuid(request.params.id)) {
        return conceptNotFound(reply);
      }

      if (!isUuid(request.params.membershipId)) {
        return membershipNotFound(reply);
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const concept = await lockConcept(client, request.params.id);

        if (!concept) {
          await client.query("ROLLBACK");
          return conceptNotFound(reply);
        }

        if (concept.archived_at) {
          await client.query("ROLLBACK");
          return archivedConceptMembership(reply);
        }

        const membership = await lockMembership(
          client,
          request.params.id,
          request.params.membershipId,
        );

        if (!membership) {
          await client.query("ROLLBACK");
          return membershipNotFound(reply);
        }

        if (membership.removed_at) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: {
              code: "CONCEPT_MEMBERSHIP_ALREADY_REMOVED",
              message: "这个 Membership 已经移除。",
            },
          });
        }

        const sequenceNumber = await nextActivitySequence(
          client,
          request.params.id,
        );

        await client.query(
          `UPDATE concept_memberships
              SET removed_at = clock_timestamp()
            WHERE id = $1`,
          [membership.id],
        );
        await client.query(
          `INSERT INTO concept_activity
             (concept_id, sequence_number, kind, membership_id)
           VALUES ($1, $2, 'MEMBER_REMOVED', $3)`,
          [request.params.id, sequenceNumber, membership.id],
        );
        await touchConcept(client, request.params.id);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      return { detail: await requiredConceptDetail(pool, request.params.id) };
    },
  );

  app.post<{ Params: { id: string; membershipId: string } }>(
    "/api/v1/concepts/:id/memberships/:membershipId/restore",
    async (request, reply) => {
      if (!isUuid(request.params.id)) {
        return conceptNotFound(reply);
      }

      if (!isUuid(request.params.membershipId)) {
        return membershipNotFound(reply);
      }

      const client = await pool.connect();

      try {
        await client.query("BEGIN");
        const concept = await lockConcept(client, request.params.id);

        if (!concept) {
          await client.query("ROLLBACK");
          return conceptNotFound(reply);
        }

        if (concept.archived_at) {
          await client.query("ROLLBACK");
          return archivedConceptMembership(reply);
        }

        const membership = await lockMembership(
          client,
          request.params.id,
          request.params.membershipId,
        );

        if (!membership) {
          await client.query("ROLLBACK");
          return membershipNotFound(reply);
        }

        if (!membership.removed_at) {
          await client.query("ROLLBACK");
          return reply.code(409).send({
            error: {
              code: "CONCEPT_MEMBERSHIP_ACTIVE",
              message: "这个 Membership 当前已经生效。",
            },
          });
        }

        const activePoints = await lockCurrentKnowledgePoints(client, [
          membership.knowledge_point_id,
        ]);

        if (!activePoints.has(membership.knowledge_point_id)) {
          await client.query("ROLLBACK");
          return inactiveMembershipPoint(reply);
        }

        const sequenceNumber = await nextActivitySequence(
          client,
          request.params.id,
        );

        await client.query(
          "UPDATE concept_memberships SET removed_at = NULL WHERE id = $1",
          [membership.id],
        );
        await client.query(
          `INSERT INTO concept_activity
             (concept_id, sequence_number, kind, membership_id)
           VALUES ($1, $2, 'MEMBER_RESTORED', $3)`,
          [request.params.id, sequenceNumber, membership.id],
        );
        await touchConcept(client, request.params.id);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }

      return { detail: await requiredConceptDetail(pool, request.params.id) };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/concepts/:id/archive",
    async (request, reply) => {
      if (!isUuid(request.params.id)) {
        return conceptNotFound(reply);
      }

      const result = await setConceptArchiveState(pool, request.params.id, true);

      if (result === "not_found") {
        return conceptNotFound(reply);
      }

      if (result === "unchanged") {
        return reply.code(409).send({
          error: {
            code: "CONCEPT_ALREADY_ARCHIVED",
            message: "这个 Concept 已经归档。",
          },
        });
      }

      return { detail: await requiredConceptDetail(pool, request.params.id) };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/concepts/:id/restore",
    async (request, reply) => {
      if (!isUuid(request.params.id)) {
        return conceptNotFound(reply);
      }

      const result = await setConceptArchiveState(pool, request.params.id, false);

      if (result === "not_found") {
        return conceptNotFound(reply);
      }

      if (result === "unchanged") {
        return reply.code(409).send({
          error: {
            code: "CONCEPT_ALREADY_ACTIVE",
            message: "这个 Concept 当前未归档。",
          },
        });
      }

      return { detail: await requiredConceptDetail(pool, request.params.id) };
    },
  );
}

async function setConceptArchiveState(
  pool: Pool,
  conceptId: string,
  archive: boolean,
): Promise<"changed" | "not_found" | "unchanged"> {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const concept = await lockConcept(client, conceptId);

    if (!concept) {
      await client.query("ROLLBACK");
      return "not_found";
    }

    if (Boolean(concept.archived_at) === archive) {
      await client.query("ROLLBACK");
      return "unchanged";
    }

    const sequenceNumber = await nextActivitySequence(client, conceptId);

    await client.query(
      `UPDATE concepts
          SET archived_at = CASE WHEN $2 THEN clock_timestamp() ELSE NULL END,
              updated_at = clock_timestamp()
        WHERE id = $1`,
      [conceptId, archive],
    );
    await client.query(
      `INSERT INTO concept_activity
         (concept_id, sequence_number, kind)
       VALUES ($1, $2, $3)`,
      [conceptId, sequenceNumber, archive ? "ARCHIVED" : "RESTORED"],
    );
    await client.query("COMMIT");
    return "changed";
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function lockConcept(
  client: PoolClient,
  conceptId: string,
): Promise<LockedConceptLifecycleRow | null> {
  const result = await client.query<LockedConceptLifecycleRow>(
    "SELECT id, archived_at FROM concepts WHERE id = $1 FOR UPDATE",
    [conceptId],
  );

  return result.rows[0] ?? null;
}

async function lockMembership(
  client: PoolClient,
  conceptId: string,
  membershipId: string,
): Promise<LockedMembershipRow | null> {
  const result = await client.query<LockedMembershipRow>(
    `SELECT id, knowledge_point_id, removed_at
       FROM concept_memberships
      WHERE id = $1 AND concept_id = $2
      FOR UPDATE`,
    [membershipId, conceptId],
  );

  return result.rows[0] ?? null;
}

async function touchConcept(client: PoolClient, conceptId: string): Promise<void> {
  await client.query(
    "UPDATE concepts SET updated_at = clock_timestamp() WHERE id = $1",
    [conceptId],
  );
}

async function nextActivitySequence(
  client: PoolClient,
  conceptId: string,
): Promise<number> {
  const result = await client.query<{ sequence_number: number }>(
    `SELECT COALESCE(MAX(sequence_number), 0)::integer + 1 AS sequence_number
       FROM concept_activity
      WHERE concept_id = $1`,
    [conceptId],
  );

  return result.rows[0]?.sequence_number ?? 1;
}

async function lockCurrentKnowledgePoints(
  client: PoolClient,
  knowledgePointIds: string[],
): Promise<Set<string>> {
  const result = await client.query<{ id: string }>(
    `SELECT point.id
       FROM knowledge_points AS point
       INNER JOIN ai_analysis_revisions AS analysis
         ON analysis.id = point.analysis_revision_id
        AND analysis.status = 'ACTIVE'
       INNER JOIN records AS record
         ON record.id = point.record_id
        AND record.current_analysis_revision_id = analysis.id
        AND record.archived_at IS NULL
      WHERE point.id = ANY($1::uuid[])
        AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
        AND point.usage_status = 'INCLUDED'
      FOR SHARE OF point, analysis, record`,
    [knowledgePointIds],
  );

  return new Set(result.rows.map(({ id }) => id));
}

async function readConceptByNormalizedName(
  pool: Pool | PoolClient,
  normalizedName: string,
): Promise<{ id: string; name: string } | null> {
  const result = await pool.query<{ display_name: string; id: string }>(
    `SELECT concept.id, revision.display_name
       FROM concepts AS concept
       INNER JOIN concept_revisions AS revision
         ON revision.id = concept.current_revision_id
      WHERE concept.normalized_name = $1`,
    [normalizedName],
  );
  const row = result.rows[0];

  return row ? { id: row.id, name: row.display_name } : null;
}

export async function readConceptDetail(pool: Pool, conceptId: string) {
  const [conceptResult, revisionResult, membershipResult, activityResult] =
    await Promise.all([
      pool.query<ConceptRow>(
        `${CONCEPT_SELECT} WHERE concept.id = $1 ${CONCEPT_GROUP_BY}`,
        [conceptId],
      ),
      pool.query<ConceptRevisionRow>(
        `SELECT id, revision_number, display_name, description, created_at
           FROM concept_revisions
          WHERE concept_id = $1
          ORDER BY revision_number`,
        [conceptId],
      ),
      pool.query<ConceptMembershipRow>(
        `SELECT membership.id,
                membership.knowledge_point_id,
                membership.origin,
                membership.created_at,
                membership.removed_at,
                point.record_id,
                COALESCE(correction.title, point.ai_title) AS title,
                COALESCE(correction.body, point.ai_body) AS body,
                COALESCE(overview.title, active.title) AS record_title,
                current_revision.content AS record_source,
                record.archived_at IS NULL
                  AND record.current_analysis_revision_id = point.analysis_revision_id
                  AND active.id IS NOT NULL
                  AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
                  AND point.usage_status = 'INCLUDED' AS current
           FROM concept_memberships AS membership
           INNER JOIN knowledge_points AS point
             ON point.id = membership.knowledge_point_id
           LEFT JOIN concept_activity AS added_activity
             ON added_activity.membership_id = membership.id
            AND added_activity.kind = 'MEMBER_ADDED'
           INNER JOIN records AS record ON record.id = point.record_id
           INNER JOIN fragment_revisions AS current_revision
             ON current_revision.id = record.current_fragment_revision_id
           LEFT JOIN ai_analysis_revisions AS active
             ON active.id = point.analysis_revision_id
            AND active.status = 'ACTIVE'
           LEFT JOIN knowledge_point_corrections AS correction
             ON correction.knowledge_point_id = point.id
           LEFT JOIN record_overview_corrections AS overview
             ON overview.record_id = record.id
            AND overview.analysis_revision_id = record.current_analysis_revision_id
          WHERE membership.concept_id = $1
          ORDER BY added_activity.sequence_number NULLS LAST,
                   membership.created_at,
                   membership.id`,
        [conceptId],
      ),
      pool.query<ConceptActivityRow>(
        `SELECT sequence_number, kind, revision_id, membership_id, occurred_at
           FROM concept_activity
          WHERE concept_id = $1
          ORDER BY sequence_number`,
        [conceptId],
      ),
    ]);
  const concept = conceptResult.rows[0];

  if (!concept) {
    return null;
  }

  return {
    concept: publicConcept(concept),
    revisions: revisionResult.rows.map((revision) => ({
      id: revision.id,
      revisionNumber: revision.revision_number,
      name: revision.display_name,
      description: revision.description,
      createdAt: asIsoString(revision.created_at),
    })),
    memberships: membershipResult.rows.map((membership) => ({
      id: membership.id,
      origin: "user" as const,
      status: membership.removed_at ? ("removed" as const) : ("active" as const),
      createdAt: asIsoString(membership.created_at),
      removedAt: nullableIsoString(membership.removed_at),
      needsReview: !membership.current,
      point: {
        id: membership.knowledge_point_id,
        recordId: membership.record_id,
        recordTitle:
          membership.record_title ?? firstNonEmptyLine(membership.record_source),
        title: membership.title,
        body: membership.body,
        current: membership.current,
      },
    })),
    activity: activityResult.rows.map((activity) => ({
      sequenceNumber: activity.sequence_number,
      kind: publicActivityKind(activity.kind),
      revisionId: activity.revision_id,
      membershipId: activity.membership_id,
      occurredAt: asIsoString(activity.occurred_at),
    })),
  };
}

async function requiredConceptDetail(pool: Pool, conceptId: string) {
  const detail = await readConceptDetail(pool, conceptId);

  if (!detail) {
    throw new Error("Concept could not be read after mutation");
  }

  return detail;
}

function publicConceptSummary(row: ConceptRow) {
  return {
    ...publicConcept(row),
    activeMembershipCount: row.active_membership_count,
    reviewMembershipCount: row.review_membership_count,
  };
}

function publicConcept(row: ConceptRow) {
  return {
    id: row.id,
    name: row.display_name,
    description: row.description,
    revisionNumber: row.revision_number,
    lifecycle: row.archived_at ? ("archived" as const) : ("active" as const),
    archivedAt: nullableIsoString(row.archived_at),
    createdAt: asIsoString(row.created_at),
    updatedAt: asIsoString(row.updated_at),
  };
}

function isCreateConceptBody(
  value: unknown,
): value is {
  description: string;
  knowledgePointIds: string[];
  name: string;
} {
  return (
    isObject(value) &&
    typeof value.name === "string" &&
    typeof value.description === "string" &&
    Array.isArray(value.knowledgePointIds) &&
    value.knowledgePointIds.every(isUuid)
  );
}

function isUpdateConceptBody(
  value: unknown,
): value is { description?: string; name?: string } {
  return (
    isObject(value) &&
    (typeof value.name === "string" || typeof value.description === "string") &&
    (value.name === undefined || typeof value.name === "string") &&
    (value.description === undefined || typeof value.description === "string")
  );
}

function isAddMembershipBody(
  value: unknown,
): value is { knowledgePointId: string } {
  return isObject(value) && isUuid(value.knowledgePointId);
}

function invalidConcept(reply: FastifyReply) {
  return reply.code(422).send({
    error: {
      code: "CONCEPT_CREATE_INVALID",
      message: "请填写 Concept 名称和描述，并选择至少两个知识点。",
    },
  });
}

function invalidConceptUpdate(reply: FastifyReply) {
  return reply.code(422).send({
    error: {
      code: "CONCEPT_UPDATE_INVALID",
      message: "Concept 名称和描述不能为空。",
    },
  });
}

function invalidMembership(reply: FastifyReply) {
  return reply.code(422).send({
    error: {
      code: "CONCEPT_MEMBERSHIP_INVALID",
      message: "请选择一个有效知识点。",
    },
  });
}

function inactiveMembershipPoint(reply: FastifyReply) {
  return reply.code(409).send({
    error: {
      code: "CONCEPT_MEMBERSHIP_POINT_NOT_CURRENT",
      message: "只能关联当前生效且未排除的知识点。",
    },
  });
}

function archivedConceptMembership(reply: FastifyReply) {
  return reply.code(409).send({
    error: {
      code: "CONCEPT_ARCHIVED",
      message: "请先恢复 Concept，再管理 Membership。",
    },
  });
}

function membershipNotFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: {
      code: "CONCEPT_MEMBERSHIP_NOT_FOUND",
      message: "没有找到这个 Membership。",
    },
  });
}

function conceptNotFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: {
      code: "CONCEPT_NOT_FOUND",
      message: "没有找到这个 Concept。",
    },
  });
}

function conceptNameConflict(
  reply: FastifyReply,
  existing: { id: string; name: string },
) {
  return reply.code(409).send({
    error: {
      code: "CONCEPT_NAME_CONFLICT",
      message: "已存在同名 Concept，请使用现有 Concept 或换一个名称。",
      details: { existingConcept: existing },
    },
  });
}

function isConceptNameUniqueViolation(error: unknown): boolean {
  return (
    isObject(error) &&
    error.code === "23505" &&
    error.constraint === "concepts_normalized_name_unique"
  );
}

function publicActivityKind(kind: ConceptActivityRow["kind"]) {
  return kind.toLowerCase() as Lowercase<ConceptActivityRow["kind"]>;
}

function asIsoString(value: Timestamp): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function nullableIsoString(value: Timestamp | null): string | null {
  return value === null ? null : asIsoString(value);
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find(Boolean) ?? "未命名记录"
  );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      value,
    )
  );
}

const CONCEPT_SELECT = `SELECT concept.id,
       revision.display_name,
       revision.description,
       revision.revision_number,
       concept.archived_at,
       concept.created_at,
       concept.updated_at,
       COUNT(membership.id) FILTER (
         WHERE membership.removed_at IS NULL
       )::integer AS active_membership_count,
       COUNT(membership.id) FILTER (
         WHERE membership.removed_at IS NULL
           AND NOT (
             record.archived_at IS NULL
             AND record.current_analysis_revision_id = point.analysis_revision_id
             AND active.id IS NOT NULL
             AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
             AND point.usage_status = 'INCLUDED'
           )
       )::integer AS review_membership_count
  FROM concepts AS concept
  INNER JOIN concept_revisions AS revision
    ON revision.id = concept.current_revision_id
  LEFT JOIN concept_memberships AS membership
    ON membership.concept_id = concept.id
  LEFT JOIN knowledge_points AS point ON point.id = membership.knowledge_point_id
  LEFT JOIN records AS record ON record.id = point.record_id
  LEFT JOIN ai_analysis_revisions AS active
    ON active.id = point.analysis_revision_id
   AND active.status = 'ACTIVE'`;

const CONCEPT_GROUP_BY = `GROUP BY concept.id,
       revision.display_name,
       revision.description,
       revision.revision_number`;
