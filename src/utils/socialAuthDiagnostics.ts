export type SocialAuthFieldSummary = {
  path: string;
  type: string;
  length?: number;
};

function getValueType(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (Array.isArray(value) || typeof value === "object") return "object";
  return typeof value;
}

export function summarizeBody(body: unknown): SocialAuthFieldSummary[] {
  const fields: SocialAuthFieldSummary[] = [];

  function visit(value: unknown, path: string): void {
    const type = getValueType(value);
    const summary: SocialAuthFieldSummary = { path, type };
    if (typeof value === "string") summary.length = value.length;
    fields.push(summary);

    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
    } else if (typeof value === "object" && value !== null) {
      for (const [key, nestedValue] of Object.entries(value)) {
        visit(nestedValue, path ? `${path}.${key}` : key);
      }
    }
  }

  if (typeof body === "object" && body !== null && !Array.isArray(body)) {
    for (const [key, value] of Object.entries(body)) visit(value, key);
  } else {
    visit(body, "body");
  }

  return fields;
}
