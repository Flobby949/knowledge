export type DefaultAiHandling = "automatic" | "review";

export interface InstancePreferences {
  defaultAiHandling: DefaultAiHandling;
}

export async function getPreferences(): Promise<InstancePreferences> {
  const response = await fetch("/api/v1/preferences");

  return readPreferences(response);
}

export async function updatePreferences(
  defaultAiHandling: DefaultAiHandling,
): Promise<InstancePreferences> {
  const response = await fetch("/api/v1/preferences", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ defaultAiHandling }),
  });

  return readPreferences(response);
}

async function readPreferences(response: Response): Promise<InstancePreferences> {
  if (!response.ok) {
    throw new Error(`请求失败（${response.status}）`);
  }

  const body = (await response.json()) as { preferences: InstancePreferences };

  return body.preferences;
}
