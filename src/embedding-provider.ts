export interface EmbedTextInput {
  text: string;
  purpose: "document" | "query";
  baseUrl: string;
  model: string;
  apiKey: string;
  configurationVersion: number;
}

export type EmbedText = (input: EmbedTextInput) => Promise<number[]>;

export const EMBEDDING_REQUEST_TIMEOUT_MS = 120_000;

export const embedOpenAICompatibleText: EmbedText = async (input) => {
  const response = await fetch(
    new URL("embeddings", ensureTrailingSlash(input.baseUrl)),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: input.model, input: input.text }),
      signal: AbortSignal.timeout(EMBEDDING_REQUEST_TIMEOUT_MS),
    },
  );

  if (!response.ok) {
    throw new Error(`Embedding request failed with status ${response.status}`);
  }

  const body = (await response.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  const embedding = body.data?.[0]?.embedding;

  if (!embedding?.length || embedding.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding response did not contain a finite vector");
  }

  return embedding;
};

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
