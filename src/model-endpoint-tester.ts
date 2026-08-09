export interface ModelEndpointTestInput {
  kind: "text" | "embedding";
  baseUrl: string;
  model: string;
  apiKey: string;
}

export type ModelEndpointTester = (
  input: ModelEndpointTestInput,
) => Promise<{ status: "passed" }>;

export const testOpenAICompatibleEndpoint: ModelEndpointTester = async (
  input,
) => {
  const resource = input.kind === "text" ? "chat/completions" : "embeddings";
  const url = new URL(resource, ensureTrailingSlash(input.baseUrl));
  const body =
    input.kind === "text"
      ? {
          model: input.model,
          messages: [{ role: "user", content: "Reply with OK." }],
          max_tokens: 2,
          stream: false,
        }
      : {
          model: input.model,
          input: "connection test",
        };
  const response = await fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${input.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Model endpoint test failed with status ${response.status}`);
  }

  return { status: "passed" };
};

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}
