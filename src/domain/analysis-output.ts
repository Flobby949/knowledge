import { hasNonWhitespace } from "./fragment-text.js";

export interface AnalysisEvidence {
  start: number;
  end: number;
  quote: string;
}

export interface AnalysisKnowledgePoint {
  title: string;
  body: string;
  evidence: AnalysisEvidence[];
  tags?: string[];
}

export interface AnalysisOutput {
  title: string;
  summary: string;
  knowledgePoints: AnalysisKnowledgePoint[];
}

export interface AnalysisValidationError {
  code:
    | "KNOWLEDGE_POINT_COUNT"
    | "FIELD_REQUIRED"
    | "EVIDENCE_REQUIRED"
    | "EVIDENCE_MISMATCH";
  path: string;
  message: string;
}

export type AnalysisOutputValidation =
  | { ok: true; value: AnalysisOutput }
  | { ok: false; errors: AnalysisValidationError[] };

export function validateAnalysisOutput(
  sourceText: string,
  candidate: unknown,
): AnalysisOutputValidation {
  const value = isObject(candidate) ? candidate : {};
  const knowledgePoints = value.knowledgePoints;

  if (
    !Array.isArray(knowledgePoints) ||
    knowledgePoints.length < 1 ||
    knowledgePoints.length > 5
  ) {
    return {
      ok: false,
      errors: [
        {
          code: "KNOWLEDGE_POINT_COUNT",
          path: "knowledgePoints",
          message: "知识点数量必须为 1–5 个。",
        },
      ],
    };
  }

  const errors: AnalysisValidationError[] = [];

  validateRequiredString(value.title, "title", errors);
  validateRequiredString(value.summary, "summary", errors);

  knowledgePoints.forEach((rawPoint, pointIndex) => {
    const point = isObject(rawPoint) ? rawPoint : {};
    const pointPath = `knowledgePoints[${pointIndex}]`;

    validateRequiredString(point.title, `${pointPath}.title`, errors);
    validateRequiredString(point.body, `${pointPath}.body`, errors);

    if (!Array.isArray(point.evidence) || point.evidence.length === 0) {
      errors.push({
        code: "EVIDENCE_REQUIRED",
        path: `${pointPath}.evidence`,
        message: "每个知识点至少需要一个原文证据。",
      });
      return;
    }

    point.evidence.forEach((rawEvidence, evidenceIndex) => {
      const evidence = isObject(rawEvidence) ? rawEvidence : {};
      const start = evidence.start;
      const end = evidence.end;
      const quote = evidence.quote;
      const matches =
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        typeof start === "number" &&
        typeof end === "number" &&
        start >= 0 &&
        end > start &&
        end <= sourceText.length &&
        typeof quote === "string" &&
        sourceText.slice(start, end) === quote;

      if (!matches) {
        errors.push({
          code: "EVIDENCE_MISMATCH",
          path: `${pointPath}.evidence[${evidenceIndex}]`,
          message: "证据位置与原始文本不一致。",
        });
      }
    });
  });

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  return { ok: true, value: candidate as AnalysisOutput };
}

function validateRequiredString(
  value: unknown,
  path: string,
  errors: AnalysisValidationError[],
): void {
  if (typeof value !== "string" || !hasNonWhitespace(value)) {
    errors.push({
      code: "FIELD_REQUIRED",
      path,
      message: "字段不能为空。",
    });
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
