import { createHash } from "node:crypto";

import type { FastifyInstance, FastifyReply } from "fastify";
import type { Pool, PoolClient } from "pg";

import {
  SYMMETRIC_CONCEPT_RELATION_TYPES,
  type ConceptRelationType,
} from "./domain/concept-relation.js";

type Database = Pool | PoolClient;
type NodeType = "concept" | "knowledge_point";
type TraversalDirection = "forward" | "reverse" | "undirected";

interface NetworkQuery {
  depth?: string;
  edgeLimit?: string;
  nodeLimit?: string;
  root?: string;
}

interface NeighborQuery {
  edgeLimit?: string;
  nodeLimit?: string;
}

type NodeSearchType = "all" | NodeType;

interface NodeSearchQuery {
  limit?: string;
  q?: string;
  type?: string;
}

interface PathQuery {
  from?: string;
  maxDepth?: string;
  to?: string;
}

interface TypedKey {
  id: string;
  key: string;
  type: NodeType;
}

interface NetworkNode {
  description?: string;
  id: string;
  key: string;
  label: string;
  source:
    | {
        kind: "concept_revision";
        revisionId: string;
        revisionNumber: number;
      }
    | {
        analysisRevisionId: string;
        fragmentRevisionId: string;
        kind: "knowledge_point";
        recordId: string;
        recordTitle: string;
      };
  type: NodeType;
}

interface NetworkEdge {
  confirmation: null | {
    confirmedAt: string;
    id: string;
    relationId: string;
  };
  description: string | null;
  directed: boolean;
  edgeKey: string;
  kind: "concept_membership" | "concept_relation" | "knowledge_relation";
  relationType: string;
  source: string;
  sourceRecord:
    | {
        createdAt: string;
        id: string;
        kind: "concept_membership";
        origin: string;
      }
    | {
        confidence: number;
        confirmedAt: string;
        id: string;
        kind: "concept_relation_confirmation";
        relationId: string;
        reason: string;
      }
    | {
        confidence: number;
        confirmedAt: string;
        id: string;
        kind: "knowledge_relation_confirmation";
        relationId: string;
        reason: string;
      };
  target: string;
}

interface EdgeBatch {
  edges: NetworkEdge[];
  nodes: Map<string, NetworkNode>;
  truncated: boolean;
}

interface GraphLimits {
  depth: number;
  edgeLimit: number;
  nodeLimit: number;
}

interface NetworkNodeSearchRow {
  analysis_revision_id: string | null;
  description: string;
  fragment_revision_id: string | null;
  id: string;
  key: string;
  label: string;
  record_id: string | null;
  record_title: string | null;
  revision_id: string | null;
  revision_number: number | null;
  type: NodeType;
}

const DEFAULT_NODE_LIMIT = 100;
const DEFAULT_EDGE_LIMIT = 200;
const DEFAULT_LOCAL_DEPTH = 1;
const MAX_NODE_LIMIT = 300;
const MAX_EDGE_LIMIT = 600;
const MAX_LOCAL_DEPTH = 2;
const DEFAULT_PATH_DEPTH = 6;
const MAX_PATH_DEPTH = 6;
const MAX_PATH_VISITED = 1_000;
const MAX_PATH_EDGE_SCAN = 10_000;
const DEFAULT_NODE_SEARCH_LIMIT = 20;
const MAX_NODE_SEARCH_LIMIT = 50;

export function registerNetworkRoutes(
  app: FastifyInstance,
  options: { pool: Pool },
): void {
  const { pool } = options;

  app.get<{ Querystring: NetworkQuery }>(
    "/api/v1/network/subgraph",
    async (request, reply) => {
      const limits = parseGraphLimits(request.query, reply);

      if (!limits) {
        return;
      }

      if (request.query.root === undefined) {
        try {
          const graph = await withNetworkSnapshot(pool, (client) =>
            readConceptFirstGraph(client, limits),
          );

          return { root: null, ...graph };
        } catch (error) {
          if (isStatementTimeout(error)) {
            return graphBudgetExceeded(reply);
          }

          throw error;
        }
      }

      const root = parseTypedKey(request.query.root);

      if (!root) {
        return invalidQuery(reply, "网络根节点必须使用 concept:<uuid> 或 knowledge_point:<uuid>。");
      }

      let graph;

      try {
        graph = await withNetworkSnapshot(pool, (client) =>
          readLocalGraph(client, root, limits),
        );
      } catch (error) {
        if (isStatementTimeout(error)) {
          return graphBudgetExceeded(reply);
        }

        throw error;
      }

      if (!graph) {
        return nodeNotFound(reply);
      }

      return { root: root.key, ...graph };
    },
  );

  app.get<{ Querystring: NodeSearchQuery }>(
    "/api/v1/network/nodes/search",
    async (request, reply) => {
      const query = request.query.q?.trim() ?? "";
      const type = request.query.type ?? "all";
      const limit = parseInteger(
        request.query.limit,
        DEFAULT_NODE_SEARCH_LIMIT,
        1,
        MAX_NODE_SEARCH_LIMIT,
      );

      if (
        query.length < 1 ||
        query.length > 200 ||
        (type !== "all" && type !== "concept" && type !== "knowledge_point") ||
        limit === null
      ) {
        return invalidQuery(
          reply,
          "q 去除首尾空白后必须为 1 到 200 个字符，type 必须是 all、concept 或 knowledge_point，limit 必须是 1 到 50 的整数。",
        );
      }

      try {
        return await withNetworkSnapshot(pool, (client) =>
          searchNetworkNodes(client, query, type, limit),
        );
      } catch (error) {
        if (isStatementTimeout(error)) {
          return graphBudgetExceeded(reply);
        }

        throw error;
      }
    },
  );

  app.get<{ Params: { typedKey: string }; Querystring: NeighborQuery }>(
    "/api/v1/network/nodes/:typedKey/neighbors",
    async (request, reply) => {
      const root = parseTypedKey(request.params.typedKey);
      const limits = parseGraphLimits(
        { ...request.query, depth: "1" },
        reply,
      );

      if (!root) {
        return invalidQuery(reply, "网络节点必须使用 concept:<uuid> 或 knowledge_point:<uuid>。");
      }

      if (!limits) {
        return;
      }

      let graph;

      try {
        graph = await withNetworkSnapshot(pool, (client) =>
          readLocalGraph(client, root, limits),
        );
      } catch (error) {
        if (isStatementTimeout(error)) {
          return graphBudgetExceeded(reply);
        }

        throw error;
      }

      if (!graph) {
        return nodeNotFound(reply);
      }

      return { root: root.key, ...graph };
    },
  );

  app.get<{ Querystring: PathQuery }>(
    "/api/v1/network/path",
    async (request, reply) => {
      const source = parseTypedKey(request.query.from);
      const target = parseTypedKey(request.query.to);
      const maxDepth = parseInteger(
        request.query.maxDepth,
        DEFAULT_PATH_DEPTH,
        0,
        MAX_PATH_DEPTH,
      );

      if (!source || !target || maxDepth === null) {
        return invalidQuery(
          reply,
          "路径端点必须使用 typed key，maxDepth 必须是 0 到 6 的整数。",
        );
      }

      try {
        const result = await readPath(pool, source, target, maxDepth);

        if (result === "node_not_found") {
          return nodeNotFound(reply);
        }

        return result;
      } catch (error) {
        if (error instanceof PathBudgetExceeded || isStatementTimeout(error)) {
          return reply.code(422).send({
            error: {
              code: "NETWORK_PATH_BUDGET_EXCEEDED",
              message:
                "路径探索超过 1000 个节点、查询边预算或 2 秒数据库预算，请缩短路径深度。",
            },
          });
        }

        throw error;
      }
    },
  );
}

function parseGraphLimits(
  query: NetworkQuery | NeighborQuery,
  reply: FastifyReply,
): GraphLimits | null {
  const depth = parseInteger(
    "depth" in query ? query.depth : undefined,
    DEFAULT_LOCAL_DEPTH,
    0,
    MAX_LOCAL_DEPTH,
  );
  const nodeLimit = parseInteger(
    query.nodeLimit,
    DEFAULT_NODE_LIMIT,
    1,
    MAX_NODE_LIMIT,
  );
  const edgeLimit = parseInteger(
    query.edgeLimit,
    DEFAULT_EDGE_LIMIT,
    1,
    MAX_EDGE_LIMIT,
  );

  if (depth === null || nodeLimit === null || edgeLimit === null) {
    invalidQuery(
      reply,
      "depth 必须是 0 到 2，nodeLimit 必须是 1 到 300，edgeLimit 必须是 1 到 600。",
    );
    return null;
  }

  return { depth, edgeLimit, nodeLimit };
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number | null {
  if (value === undefined) {
    return fallback;
  }

  if (!/^\d+$/u.test(value)) {
    return null;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function parseTypedKey(value: string | undefined): TypedKey | null {
  const match = value?.match(
    /^(concept|knowledge_point):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu,
  );

  if (!match?.[1] || !match[2]) {
    return null;
  }

  const type = match[1].toLowerCase() as NodeType;
  const id = match[2].toLowerCase();

  return { id, key: `${type}:${id}`, type };
}

function invalidQuery(reply: FastifyReply, message: string) {
  return reply.code(422).send({
    error: { code: "NETWORK_QUERY_INVALID", message },
  });
}

function nodeNotFound(reply: FastifyReply) {
  return reply.code(404).send({
    error: {
      code: "NETWORK_NODE_NOT_FOUND",
      message: "网络节点不存在或已退出当前有效知识网络。",
    },
  });
}

function graphBudgetExceeded(reply: FastifyReply) {
  return reply.code(422).send({
    error: {
      code: "NETWORK_GRAPH_BUDGET_EXCEEDED",
      message: "网络读取超过 2 秒数据库预算，请缩小图范围。",
    },
  });
}

async function searchNetworkNodes(
  database: Database,
  query: string,
  type: NodeSearchType,
  limit: number,
) {
  const result = await database.query<NetworkNodeSearchRow>(
    `WITH current_nodes AS (
       SELECT 'concept'::text AS type,
              concept.id,
              'concept:' || concept.id::text AS key,
              revision.display_name AS label,
              revision.description,
              revision.id AS revision_id,
              revision.revision_number,
              NULL::uuid AS record_id,
              NULL::text AS record_title,
              NULL::uuid AS fragment_revision_id,
              NULL::uuid AS analysis_revision_id
         FROM concepts AS concept
         INNER JOIN concept_revisions AS revision
           ON revision.id = concept.current_revision_id
        WHERE $2::text IN ('all', 'concept')
          AND concept.archived_at IS NULL

       UNION ALL

       SELECT 'knowledge_point'::text AS type,
              point.id,
              'knowledge_point:' || point.id::text AS key,
              COALESCE(correction.title, point.ai_title) AS label,
              COALESCE(correction.body, point.ai_body) AS description,
              NULL::uuid AS revision_id,
              NULL::integer AS revision_number,
              point.record_id,
              COALESCE(overview.title, analysis.title) AS record_title,
              point.fragment_revision_id,
              point.analysis_revision_id
         FROM knowledge_points AS point
         INNER JOIN ai_analysis_revisions AS analysis
           ON analysis.id = point.analysis_revision_id
          AND analysis.status = 'ACTIVE'
         INNER JOIN records AS record
           ON record.id = point.record_id
          AND record.current_analysis_revision_id = analysis.id
          AND record.archived_at IS NULL
         LEFT JOIN knowledge_point_corrections AS correction
           ON correction.knowledge_point_id = point.id
         LEFT JOIN record_overview_corrections AS overview
           ON overview.record_id = record.id
          AND overview.analysis_revision_id = analysis.id
        WHERE $2::text IN ('all', 'knowledge_point')
          AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
          AND point.usage_status = 'INCLUDED'
     )
     SELECT type,
            id,
            key,
            label,
            description,
            revision_id,
            revision_number,
            record_id,
            record_title,
            fragment_revision_id,
            analysis_revision_id
       FROM current_nodes
      WHERE strpos(lower(label), lower($1)) > 0
         OR strpos(lower(description), lower($1)) > 0
      ORDER BY starts_with(lower(label), lower($1)) DESC,
               GREATEST(
                 similarity(lower(label), lower($1)),
                 similarity(lower(description), lower($1))
               ) DESC,
               key
      LIMIT $3`,
    [query, type, limit + 1],
  );
  const items = result.rows.slice(0, limit).map(publicSearchNode);

  return { items, limit, truncated: result.rows.length > limit };
}

function publicSearchNode(row: NetworkNodeSearchRow): NetworkNode {
  if (row.type === "concept") {
    return publicConceptNode({
      id: row.id,
      title: row.label,
      description: row.description,
      revision_id: row.revision_id!,
      revision_number: row.revision_number!,
    });
  }

  return publicKnowledgePointNode({
    id: row.id,
    title: row.label,
    body: row.description,
    record_id: row.record_id!,
    record_title: row.record_title!,
    fragment_revision_id: row.fragment_revision_id!,
    analysis_revision_id: row.analysis_revision_id!,
  });
}

async function readConceptFirstGraph(database: Database, limits: GraphLimits) {
  const concepts = await readConceptFirstNodes(database, limits.nodeLimit + 1);
  const nodesTruncated = concepts.length > limits.nodeLimit;
  const nodes = concepts.slice(0, limits.nodeLimit);
  const conceptIds = nodes.map(({ id }) => id);
  const relationBatch = await readConceptRelationEdges(
    database,
    conceptIds,
    limits.edgeLimit,
    true,
  );

  return graphResponse(
    nodes,
    relationBatch.edges,
    limits,
    nodesTruncated,
    relationBatch.truncated,
  );
}

async function readLocalGraph(
  database: Database,
  root: TypedKey,
  limits: GraphLimits,
) {
  const rootNode = (await readNodes(database, [root])).get(root.key);

  if (!rootNode) {
    return null;
  }

  const nodes = new Map([[root.key, rootNode]]);
  const edges = new Map<string, NetworkEdge>();
  let frontier = [root.key];
  let nodesTruncated = false;
  let edgesTruncated = false;

  for (let level = 0; level < limits.depth && frontier.length > 0; level += 1) {
    const edgeCapacity = limits.edgeLimit - edges.size;

    if (edgeCapacity === 0) {
      edgesTruncated = true;
      break;
    }

    const batch = await readIncidentEdges(database, frontier, edgeCapacity);
    const nextFrontier = new Set<string>();

    edgesTruncated ||= batch.truncated;

    for (const edge of batch.edges) {
      if (edges.has(edge.edgeKey)) {
        continue;
      }

      const missingKeys = [edge.source, edge.target].filter(
        (key) => !nodes.has(key),
      );

      if (nodes.size + missingKeys.length > limits.nodeLimit) {
        nodesTruncated = true;
        continue;
      }

      const missingNodes = missingKeys.map((key) => batch.nodes.get(key));

      if (missingNodes.some((node) => node === undefined)) {
        continue;
      }

      for (const node of missingNodes as NetworkNode[]) {
        nodes.set(node.key, node);
        nextFrontier.add(node.key);
      }

      edges.set(edge.edgeKey, edge);
    }

    frontier = [...nextFrontier].sort();
  }

  return graphResponse(
    [...nodes.values()],
    [...edges.values()],
    limits,
    nodesTruncated,
    edgesTruncated,
  );
}

function graphResponse(
  nodes: NetworkNode[],
  edges: NetworkEdge[],
  limits: GraphLimits,
  nodesTruncated: boolean,
  edgesTruncated: boolean,
) {
  return {
    nodes,
    edges,
    limits,
    truncated: nodesTruncated || edgesTruncated,
    truncation: { nodes: nodesTruncated, edges: edgesTruncated },
  };
}

async function readPath(
  pool: Pool,
  source: TypedKey,
  target: TypedKey,
  maxDepth: number,
) {
  return withNetworkSnapshot(pool, async (client) => {
    const endpoints = await readNodes(client, [source, target]);

    if (!endpoints.has(source.key) || !endpoints.has(target.key)) {
      return "node_not_found" as const;
    }

    if (source.key === target.key) {
      return {
        path: {
          nodes: [endpoints.get(source.key)],
          edges: [],
          steps: [],
        },
        maxDepth,
        truncated: false,
        visited: 1,
      };
    }

    const visited = new Set([source.key]);
    const nodeByKey = new Map(endpoints);
    const predecessor = new Map<
      string,
      { edge: NetworkEdge; previous: string }
    >();
    let frontier = [source.key];
    let found = false;

    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
      const batch = await readIncidentEdges(
        client,
        frontier,
        MAX_PATH_EDGE_SCAN,
      );

      if (batch.truncated) {
        throw new PathBudgetExceeded();
      }

      for (const [key, node] of batch.nodes) {
        nodeByKey.set(key, node);
      }

      const adjacency = buildAdjacency(batch.edges);
      const nextFrontier: string[] = [];

      for (const current of [...frontier].sort()) {
        for (const edge of adjacency.get(current) ?? []) {
          const neighbor = edge.source === current ? edge.target : edge.source;

          if (visited.has(neighbor) || !nodeByKey.has(neighbor)) {
            continue;
          }

          if (visited.size >= MAX_PATH_VISITED) {
            throw new PathBudgetExceeded();
          }

          visited.add(neighbor);
          predecessor.set(neighbor, { edge, previous: current });
          nextFrontier.push(neighbor);

          if (neighbor === target.key) {
            found = true;
            break;
          }
        }

        if (found) {
          break;
        }
      }

      frontier = nextFrontier;

      if (found) {
        break;
      }
    }

    const response = found
      ? {
          path: buildPath(source.key, target.key, predecessor, nodeByKey),
          maxDepth,
          truncated: false,
          visited: visited.size,
        }
      : {
          path: null,
          maxDepth,
          truncated: frontier.length > 0,
          visited: visited.size,
        };

    return response;
  });
}

async function withNetworkSnapshot<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();

  try {
    await client.query(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    await client.query("SET LOCAL statement_timeout = '2000ms'");
    const result = await operation(client);

    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function buildAdjacency(edges: NetworkEdge[]) {
  const adjacency = new Map<string, NetworkEdge[]>();

  for (const edge of edges) {
    for (const key of [edge.source, edge.target]) {
      const current = adjacency.get(key) ?? [];

      current.push(edge);
      adjacency.set(key, current);
    }
  }

  for (const current of adjacency.values()) {
    current.sort((left, right) => left.edgeKey.localeCompare(right.edgeKey));
  }

  return adjacency;
}

function buildPath(
  source: string,
  target: string,
  predecessor: Map<string, { edge: NetworkEdge; previous: string }>,
  nodeByKey: Map<string, NetworkNode>,
) {
  const nodeKeys = [target];
  const steps: Array<NetworkEdge & { traversalDirection: TraversalDirection }> =
    [];
  let current = target;

  while (current !== source) {
    const entry = predecessor.get(current);

    if (!entry) {
      throw new Error("Network path predecessor chain is incomplete");
    }

    steps.unshift({
      ...entry.edge,
      traversalDirection: traversalDirection(
        entry.edge,
        entry.previous,
        current,
      ),
    });
    current = entry.previous;
    nodeKeys.unshift(current);
  }

  return {
    nodes: nodeKeys.map((key) => nodeByKey.get(key)),
    edges: steps.map(({ traversalDirection: _direction, ...edge }) => edge),
    steps,
  };
}

function traversalDirection(
  edge: NetworkEdge,
  from: string,
  to: string,
): TraversalDirection {
  if (!edge.directed) {
    return "undirected";
  }

  return edge.source === from && edge.target === to ? "forward" : "reverse";
}

class PathBudgetExceeded extends Error {}

function isStatementTimeout(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "57014"
  );
}

async function readConceptFirstNodes(database: Database, limit: number) {
  const result = await database.query<{
    description: string;
    id: string;
    revision_id: string;
    revision_number: number;
    title: string;
  }>(
    `SELECT concept.id,
            revision.id AS revision_id,
            revision.revision_number,
            revision.display_name AS title,
            revision.description
       FROM concepts AS concept
       INNER JOIN concept_revisions AS revision
         ON revision.id = concept.current_revision_id
      WHERE concept.archived_at IS NULL
      ORDER BY concept.updated_at DESC, concept.id
      LIMIT $1`,
    [limit],
  );

  return result.rows.map(publicConceptNode);
}

async function readNodes(
  database: Database,
  typedKeys: TypedKey[],
): Promise<Map<string, NetworkNode>> {
  const conceptIds = typedKeys
    .filter(({ type }) => type === "concept")
    .map(({ id }) => id);
  const pointIds = typedKeys
    .filter(({ type }) => type === "knowledge_point")
    .map(({ id }) => id);
  const nodes = new Map<string, NetworkNode>();

  if (conceptIds.length > 0) {
    const result = await database.query<{
      description: string;
      id: string;
      revision_id: string;
      revision_number: number;
      title: string;
    }>(
      `SELECT concept.id,
              revision.id AS revision_id,
              revision.revision_number,
              revision.display_name AS title,
              revision.description
         FROM concepts AS concept
         INNER JOIN concept_revisions AS revision
           ON revision.id = concept.current_revision_id
        WHERE concept.archived_at IS NULL
          AND concept.id = ANY($1::uuid[])
        ORDER BY concept.id`,
      [conceptIds],
    );

    for (const row of result.rows) {
      const node = publicConceptNode(row);

      nodes.set(node.key, node);
    }
  }

  if (pointIds.length > 0) {
    const result = await database.query<{
      analysis_revision_id: string;
      body: string;
      fragment_revision_id: string;
      id: string;
      record_id: string;
      record_title: string;
      title: string;
    }>(
      `SELECT point.id,
              point.record_id,
              point.fragment_revision_id,
              point.analysis_revision_id,
              COALESCE(correction.title, point.ai_title) AS title,
              COALESCE(correction.body, point.ai_body) AS body,
              COALESCE(overview.title, analysis.title) AS record_title
         FROM knowledge_points AS point
         INNER JOIN ai_analysis_revisions AS analysis
           ON analysis.id = point.analysis_revision_id
          AND analysis.status = 'ACTIVE'
         INNER JOIN records AS record
           ON record.id = point.record_id
          AND record.current_analysis_revision_id = analysis.id
          AND record.archived_at IS NULL
         LEFT JOIN knowledge_point_corrections AS correction
           ON correction.knowledge_point_id = point.id
         LEFT JOIN record_overview_corrections AS overview
           ON overview.record_id = record.id
          AND overview.analysis_revision_id = analysis.id
        WHERE point.id = ANY($1::uuid[])
          AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
          AND point.usage_status = 'INCLUDED'
        ORDER BY point.id`,
      [pointIds],
    );

    for (const row of result.rows) {
      const node = publicKnowledgePointNode(row);

      nodes.set(node.key, node);
    }
  }

  return nodes;
}

function publicConceptNode(row: {
  description: string;
  id: string;
  revision_id: string;
  revision_number: number;
  title: string;
}): NetworkNode {
  return {
    key: `concept:${row.id}`,
    type: "concept",
    id: row.id,
    label: row.title,
    description: row.description,
    source: {
      kind: "concept_revision",
      revisionId: row.revision_id,
      revisionNumber: row.revision_number,
    },
  };
}

function publicKnowledgePointNode(row: {
  analysis_revision_id: string;
  body: string;
  fragment_revision_id: string;
  id: string;
  record_id: string;
  record_title: string;
  title: string;
}): NetworkNode {
  return {
    key: `knowledge_point:${row.id}`,
    type: "knowledge_point",
    id: row.id,
    label: row.title,
    description: row.body,
    source: {
      kind: "knowledge_point",
      recordId: row.record_id,
      recordTitle: row.record_title,
      fragmentRevisionId: row.fragment_revision_id,
      analysisRevisionId: row.analysis_revision_id,
    },
  };
}

async function readIncidentEdges(
  database: Database,
  frontier: string[],
  limit: number,
): Promise<EdgeBatch> {
  const keys = frontier.map(parseTypedKey).filter(isTypedKey);
  const conceptIds = keys
    .filter(({ type }) => type === "concept")
    .map(({ id }) => id);
  const pointIds = keys
    .filter(({ type }) => type === "knowledge_point")
    .map(({ id }) => id);
  const membershipBatch = await readMembershipEdges(
    database,
    conceptIds,
    pointIds,
    limit,
  );
  const knowledgeRelationBatch = await readKnowledgeRelationEdges(
    database,
    pointIds,
    limit,
  );
  const conceptRelationBatch = await readConceptRelationEdges(
    database,
    conceptIds,
    limit,
    false,
  );
  const candidates = [
    ...membershipBatch.edges,
    ...knowledgeRelationBatch.edges,
    ...conceptRelationBatch.edges,
  ].sort((left, right) => left.edgeKey.localeCompare(right.edgeKey));
  const truncated =
    membershipBatch.truncated ||
    knowledgeRelationBatch.truncated ||
    conceptRelationBatch.truncated ||
    candidates.length > limit;
  const edges = candidates.slice(0, limit);
  const endpointKeys = [...new Set(edges.flatMap(({ source, target }) => [source, target]))]
    .map(parseTypedKey)
    .filter(isTypedKey);
  const nodes = await readNodes(database, endpointKeys);
  const validEdges = edges.filter(
    ({ source, target }) => nodes.has(source) && nodes.has(target),
  );

  return { edges: validEdges, nodes, truncated };
}

function isTypedKey(value: TypedKey | null): value is TypedKey {
  return value !== null;
}

async function readMembershipEdges(
  database: Database,
  conceptIds: string[],
  pointIds: string[],
  limit: number,
): Promise<{ edges: NetworkEdge[]; truncated: boolean }> {
  if (conceptIds.length === 0 && pointIds.length === 0) {
    return { edges: [], truncated: false };
  }

  const result = await database.query<{
    concept_id: string;
    created_at: Date | string;
    id: string;
    knowledge_point_id: string;
    origin: string;
  }>(
    `SELECT membership.id,
            membership.concept_id,
            membership.knowledge_point_id,
            membership.origin,
            membership.created_at
       FROM concept_memberships AS membership
       INNER JOIN concepts AS concept
         ON concept.id = membership.concept_id
        AND concept.archived_at IS NULL
       INNER JOIN knowledge_points AS point
         ON point.id = membership.knowledge_point_id
        AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
        AND point.usage_status = 'INCLUDED'
       INNER JOIN ai_analysis_revisions AS analysis
         ON analysis.id = point.analysis_revision_id
        AND analysis.status = 'ACTIVE'
       INNER JOIN records AS record
         ON record.id = point.record_id
        AND record.current_analysis_revision_id = analysis.id
        AND record.archived_at IS NULL
      WHERE membership.removed_at IS NULL
        AND (membership.concept_id = ANY($1::uuid[])
          OR membership.knowledge_point_id = ANY($2::uuid[]))
      ORDER BY membership.id
      LIMIT $3`,
    [conceptIds, pointIds, limit + 1],
  );

  const edges: NetworkEdge[] = result.rows.slice(0, limit).map((row) => ({
    edgeKey: `concept_membership:${row.id}`,
    kind: "concept_membership",
    relationType: "membership",
    source: `concept:${row.concept_id}`,
    target: `knowledge_point:${row.knowledge_point_id}`,
    directed: false,
    description: null,
    confirmation: null,
    sourceRecord: {
      kind: "concept_membership",
      id: row.id,
      origin: row.origin.toLowerCase(),
      createdAt: isoDate(row.created_at),
    },
  }));

  return { edges, truncated: result.rows.length > limit };
}

async function readKnowledgeRelationEdges(
  database: Database,
  pointIds: string[],
  limit: number,
): Promise<{ edges: NetworkEdge[]; truncated: boolean }> {
  if (pointIds.length === 0) {
    return { edges: [], truncated: false };
  }

  const result = await database.query<{
    confidence: number;
    confirmed_at: Date | string;
    description: string;
    id: string;
    reason: string;
    relation_type: ConceptRelationType;
    source_body: string;
    source_content_fingerprint: string;
    source_id: string;
    source_title: string;
    suggestion_id: string;
    target_body: string;
    target_content_fingerprint: string;
    target_id: string;
    target_title: string;
  }>(
    `SELECT relation.id,
            relation.suggestion_id,
            relation.source_knowledge_point_id AS source_id,
            relation.target_knowledge_point_id AS target_id,
            relation.relation_type,
            relation.description,
            relation.confirmed_at,
            suggestion.reason,
            suggestion.confidence,
            suggestion.source_content_fingerprint,
            suggestion.target_content_fingerprint,
            COALESCE(source_correction.title, source_point.ai_title)
              AS source_title,
            COALESCE(source_correction.body, source_point.ai_body)
              AS source_body,
            COALESCE(target_correction.title, target_point.ai_title)
              AS target_title,
            COALESCE(target_correction.body, target_point.ai_body)
              AS target_body
       FROM knowledge_relations AS relation
       INNER JOIN relation_suggestions AS suggestion
         ON suggestion.id = relation.suggestion_id
        AND suggestion.status = 'CONFIRMED'
       INNER JOIN knowledge_points AS source_point
         ON source_point.id = relation.source_knowledge_point_id
        AND source_point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
        AND source_point.usage_status = 'INCLUDED'
       INNER JOIN ai_analysis_revisions AS source_analysis
         ON source_analysis.id = source_point.analysis_revision_id
        AND source_analysis.status = 'ACTIVE'
       INNER JOIN records AS source_record
         ON source_record.id = source_point.record_id
        AND source_record.current_analysis_revision_id = source_analysis.id
        AND source_record.archived_at IS NULL
       INNER JOIN knowledge_points AS target_point
         ON target_point.id = relation.target_knowledge_point_id
        AND target_point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
        AND target_point.usage_status = 'INCLUDED'
       INNER JOIN ai_analysis_revisions AS target_analysis
         ON target_analysis.id = target_point.analysis_revision_id
        AND target_analysis.status = 'ACTIVE'
       INNER JOIN records AS target_record
         ON target_record.id = target_point.record_id
        AND target_record.current_analysis_revision_id = target_analysis.id
        AND target_record.archived_at IS NULL
       LEFT JOIN knowledge_point_corrections AS source_correction
         ON source_correction.knowledge_point_id = source_point.id
       LEFT JOIN knowledge_point_corrections AS target_correction
         ON target_correction.knowledge_point_id = target_point.id
      WHERE relation.removed_at IS NULL
        AND (relation.source_knowledge_point_id = ANY($1::uuid[])
          OR relation.target_knowledge_point_id = ANY($1::uuid[]))
      ORDER BY relation.id
      LIMIT $2`,
    [pointIds, limit + 1],
  );

  const edges = result.rows
    .slice(0, limit)
    .filter(
      (row) =>
        pointFingerprint(row.source_title, row.source_body) ===
          row.source_content_fingerprint &&
        pointFingerprint(row.target_title, row.target_body) ===
          row.target_content_fingerprint,
    )
    .map((row) => relationEdge("knowledge_relation", row));

  return { edges, truncated: result.rows.length > limit };
}

async function readConceptRelationEdges(
  database: Database,
  conceptIds: string[],
  limit: number,
  internalOnly: boolean,
): Promise<{ edges: NetworkEdge[]; truncated: boolean }> {
  if (conceptIds.length === 0) {
    return { edges: [], truncated: false };
  }

  const result = await database.query<{
    confidence: number;
    confirmed_at: Date | string;
    description: string;
    id: string;
    reason: string;
    relation_type: ConceptRelationType;
    source_id: string;
    source_revision_id: string;
    source_snapshot_concept_id: string;
    source_snapshot_membership_fingerprint: string;
    source_snapshot_revision_id: string;
    suggestion_id: string;
    target_id: string;
    target_revision_id: string;
    target_snapshot_concept_id: string;
    target_snapshot_membership_fingerprint: string;
    target_snapshot_revision_id: string;
  }>(
    `SELECT relation.id,
            relation.suggestion_id,
            relation.source_concept_id AS source_id,
            relation.target_concept_id AS target_id,
            relation.relation_type,
            relation.description,
            relation.confirmed_at,
            suggestion.reason,
            suggestion.confidence,
            suggestion.source_concept_id AS source_snapshot_concept_id,
            suggestion.target_concept_id AS target_snapshot_concept_id,
            suggestion.source_concept_revision_id
              AS source_snapshot_revision_id,
            suggestion.target_concept_revision_id
              AS target_snapshot_revision_id,
            suggestion.source_membership_fingerprint
              AS source_snapshot_membership_fingerprint,
            suggestion.target_membership_fingerprint
              AS target_snapshot_membership_fingerprint,
            source_concept.current_revision_id AS source_revision_id,
            target_concept.current_revision_id AS target_revision_id
       FROM concept_relations AS relation
       INNER JOIN concept_relation_suggestions AS suggestion
         ON suggestion.id = relation.suggestion_id
        AND suggestion.status = 'CONFIRMED'
       INNER JOIN concepts AS source_concept
         ON source_concept.id = relation.source_concept_id
        AND source_concept.archived_at IS NULL
       INNER JOIN concepts AS target_concept
         ON target_concept.id = relation.target_concept_id
        AND target_concept.archived_at IS NULL
      WHERE relation.removed_at IS NULL
        AND (($3::boolean
              AND relation.source_concept_id = ANY($1::uuid[])
              AND relation.target_concept_id = ANY($1::uuid[]))
          OR (NOT $3::boolean
              AND (relation.source_concept_id = ANY($1::uuid[])
                OR relation.target_concept_id = ANY($1::uuid[]))))
      ORDER BY relation.id
      LIMIT $2`,
    [conceptIds, limit + 1, internalOnly],
  );
  const rawTruncated = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const fingerprintByConcept = await readMembershipFingerprints(
    database,
    [...new Set(rows.flatMap((row) => [row.source_id, row.target_id]))],
  );
  const edges = rows
    .filter((row) => conceptRelationIsCurrent(row, fingerprintByConcept))
    .map((row) => relationEdge("concept_relation", row));

  return { edges, truncated: rawTruncated };
}

function conceptRelationIsCurrent(
  row: {
    source_id: string;
    source_revision_id: string;
    source_snapshot_concept_id: string;
    source_snapshot_membership_fingerprint: string;
    source_snapshot_revision_id: string;
    target_id: string;
    target_revision_id: string;
    target_snapshot_concept_id: string;
    target_snapshot_membership_fingerprint: string;
    target_snapshot_revision_id: string;
  },
  fingerprintByConcept: Map<string, string>,
): boolean {
  const snapshots = new Map([
    [
      row.source_snapshot_concept_id,
      {
        membershipFingerprint: row.source_snapshot_membership_fingerprint,
        revisionId: row.source_snapshot_revision_id,
      },
    ],
    [
      row.target_snapshot_concept_id,
      {
        membershipFingerprint: row.target_snapshot_membership_fingerprint,
        revisionId: row.target_snapshot_revision_id,
      },
    ],
  ]);
  const sourceSnapshot = snapshots.get(row.source_id);
  const targetSnapshot = snapshots.get(row.target_id);

  return Boolean(
    sourceSnapshot &&
      targetSnapshot &&
      row.source_revision_id === sourceSnapshot.revisionId &&
      row.target_revision_id === targetSnapshot.revisionId &&
      fingerprintByConcept.get(row.source_id) ===
        sourceSnapshot.membershipFingerprint &&
      fingerprintByConcept.get(row.target_id) ===
        targetSnapshot.membershipFingerprint,
  );
}

async function readMembershipFingerprints(
  database: Database,
  conceptIds: string[],
): Promise<Map<string, string>> {
  if (conceptIds.length === 0) {
    return new Map();
  }

  const result = await database.query<{
    concept_id: string;
    membership_fingerprint: string;
  }>(
    `WITH requested_concepts AS (
       SELECT unnest($1::uuid[]) AS concept_id
     ),
     effective_memberships AS (
       SELECT membership.id,
              membership.concept_id,
              membership.knowledge_point_id
         FROM concept_memberships AS membership
         INNER JOIN knowledge_points AS point
           ON point.id = membership.knowledge_point_id
          AND point.publication_status IN ('AUTO_PUBLISHED', 'CONFIRMED')
          AND point.usage_status = 'INCLUDED'
         INNER JOIN ai_analysis_revisions AS analysis
           ON analysis.id = point.analysis_revision_id
          AND analysis.status = 'ACTIVE'
         INNER JOIN records AS record
           ON record.id = point.record_id
          AND record.current_analysis_revision_id = analysis.id
          AND record.archived_at IS NULL
        WHERE membership.removed_at IS NULL
          AND membership.concept_id = ANY($1::uuid[])
     )
     SELECT requested.concept_id,
            encode(
              sha256(
                convert_to(
                  COALESCE(
                    string_agg(
                      effective.id::text || ':' ||
                        effective.knowledge_point_id::text,
                      E'\n'
                      ORDER BY (
                        effective.id::text || ':' ||
                          effective.knowledge_point_id::text
                      ) COLLATE "C"
                    ) FILTER (WHERE effective.id IS NOT NULL),
                    ''
                  ),
                  'UTF8'
                )
              ),
              'hex'
            ) AS membership_fingerprint
       FROM requested_concepts AS requested
       LEFT JOIN effective_memberships AS effective
         ON effective.concept_id = requested.concept_id
      GROUP BY requested.concept_id
      ORDER BY requested.concept_id`,
    [conceptIds],
  );

  return new Map(
    result.rows.map((row) => [row.concept_id, row.membership_fingerprint]),
  );
}

function relationEdge(
  kind: "concept_relation" | "knowledge_relation",
  row: {
    confidence: number;
    confirmed_at: Date | string;
    description: string;
    id: string;
    reason: string;
    relation_type: ConceptRelationType;
    source_id: string;
    suggestion_id: string;
    target_id: string;
  },
): NetworkEdge {
  const confirmedAt = isoDate(row.confirmed_at);
  const nodeType = kind === "concept_relation" ? "concept" : "knowledge_point";

  return {
    edgeKey: `${kind}:${row.id}`,
    kind,
    relationType: row.relation_type.toLowerCase(),
    source: `${nodeType}:${row.source_id}`,
    target: `${nodeType}:${row.target_id}`,
    directed: !SYMMETRIC_CONCEPT_RELATION_TYPES.has(row.relation_type),
    description: row.description,
    confirmation: {
      id: row.suggestion_id,
      relationId: row.id,
      confirmedAt,
    },
    sourceRecord: {
      kind:
        kind === "concept_relation"
          ? "concept_relation_confirmation"
          : "knowledge_relation_confirmation",
      id: row.suggestion_id,
      relationId: row.id,
      confirmedAt,
      reason: row.reason,
      confidence: row.confidence,
    },
  };
}

function pointFingerprint(title: string, body: string): string {
  return createHash("sha256")
    .update(`${title.trim()}\n${body.trim()}`.normalize("NFKC"))
    .digest("hex");
}

function isoDate(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}
