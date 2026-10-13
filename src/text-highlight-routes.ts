import type { FastifyInstance } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";

import {
  highlightColors,
  paintHighlights,
  rebaseHighlights,
  type TextHighlight,
} from "./domain/text-highlights.js";

const paramsSchema = z.object({
  id: z.uuid(),
  target: z
    .string()
    .regex(/^(source:[1-9][0-9]{0,8}|knowledge:[0-9a-f-]{36})$/),
});
const paintSchema = z.object({
  content: z.string(),
  revision: z.number().int().min(0),
  start: z.number().int().min(0),
  end: z.number().int().min(1),
  color: z.enum(highlightColors).nullable(),
});

interface StoredHighlights {
  content: string;
  highlights: TextHighlight[];
  revision: number;
}

async function readContent(
  pool: Pool | PoolClient,
  id: string,
  target: string,
) {
  const [kind, value] = target.split(":");
  if (kind === "source") {
    const result = await pool.query<{ content: string }>(
      "SELECT content FROM fragment_revisions WHERE record_id = $1 AND revision_number = $2",
      [id, value],
    );
    return result.rows[0]?.content;
  }
  if (!z.uuid().safeParse(value).success) return undefined;
  const result = await pool.query<{ content: string }>(
    `SELECT COALESCE(correction.body, point.ai_body) AS content
       FROM knowledge_points AS point
       LEFT JOIN knowledge_point_corrections AS correction ON correction.knowledge_point_id = point.id
      WHERE point.record_id = $1 AND point.id = $2`,
    [id, value],
  );
  return result.rows[0]?.content;
}

export function registerTextHighlightRoutes(
  app: FastifyInstance,
  { pool }: { pool: Pool },
) {
  app.get("/api/v1/records/:id/highlights/:target", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    if (!params.success)
      return reply.code(422).send({ error: "标记位置无效。" });
    const { id, target } = params.data;
    const content = await readContent(pool, id, target);
    if (content === undefined)
      return reply.code(404).send({ error: "内容不存在。" });
    const result = await pool.query<StoredHighlights>(
      "SELECT content, highlights, revision FROM text_highlights WHERE record_id = $1 AND target = $2",
      [id, target],
    );
    const stored = result.rows[0];
    return {
      content,
      highlights: stored
        ? rebaseHighlights(stored.highlights, stored.content, content)
        : [],
      revision: stored?.revision ?? 0,
    };
  });

  app.put("/api/v1/records/:id/highlights/:target", async (request, reply) => {
    const params = paramsSchema.safeParse(request.params);
    const body = paintSchema.safeParse(request.body);
    if (
      !params.success ||
      !body.success ||
      body.data.start >= body.data.end ||
      body.data.end > body.data.content.length ||
      !body.data.content.slice(body.data.start, body.data.end).trim()
    ) {
      return reply.code(422).send({ error: "请选择有效文字和标记颜色。" });
    }
    const { id, target } = params.data;
    const { content, revision, start, end, color } = body.data;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize with source edits and knowledge corrections, as well as other markers.
      await client.query("SELECT id FROM records WHERE id = $1 FOR UPDATE", [
        id,
      ]);
      const current = await readContent(client, id, target);
      if (current === undefined) {
        await client.query("ROLLBACK");
        return reply.code(404).send({ error: "内容不存在。" });
      }
      const result = await client.query<StoredHighlights>(
        "SELECT content, highlights, revision FROM text_highlights WHERE record_id = $1 AND target = $2",
        [id, target],
      );
      const stored = result.rows[0];
      if (content !== current || revision !== (stored?.revision ?? 0)) {
        await client.query("ROLLBACK");
        return reply
          .code(409)
          .send({ error: "内容或标记已更新，请刷新后重新选择。" });
      }
      const highlights = paintHighlights(
        stored
          ? rebaseHighlights(stored.highlights, stored.content, content)
          : [],
        start,
        end,
        color,
      );
      await client.query(
        `INSERT INTO text_highlights (record_id, target, content, highlights, revision)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (record_id, target) DO UPDATE
           SET content = EXCLUDED.content, highlights = EXCLUDED.highlights, revision = EXCLUDED.revision`,
        [id, target, content, JSON.stringify(highlights), revision + 1],
      );
      await client.query("COMMIT");
      return { content, highlights, revision: revision + 1 };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
