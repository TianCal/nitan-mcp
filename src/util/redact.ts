export function redactSecrets(input: string): string {
  return input.replace(/(Api-Key|User-Api-Key|Authorization):\s*([^\s]+)/gi, "$1: <redacted>");
}

export function redactObject<T>(obj: T): T {
  const json = JSON.stringify(obj, (key, value) => {
    // Redact sensitive fields
    if (key === 'password' || key === 'api_key' || key === 'user_api_key' || key === 'second_factor_token') {
      return '<redacted>';
    }
    return value;
  });
  const redacted = redactSecrets(json);
  try {
    return JSON.parse(redacted);
  } catch {
    return obj;
  }
}

const SENSITIVE_HEADERS = new Set([
  "api-key",
  "user-api-key",
  "authorization",
  "cookie",
  "set-cookie",
  "x-csrf-token",
]);

// Copy of an HTTP header map that is safe to write to logs.
export function redactHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? "<redacted>" : value;
  }
  return out;
}
