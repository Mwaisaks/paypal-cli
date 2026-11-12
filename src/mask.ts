/** Secrets registered at runtime (client secret, access token) are masked in every string we print. */
const secrets = new Set<string>();

export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 6) secrets.add(value);
}

/** Shows the first 6 characters of an ID, so users can tell credentials apart without leaking them. */
export function maskId(value: string, keep = 6): string {
  if (!value) return '(not set)';
  if (value.length <= keep) return '*'.repeat(value.length);
  return `${value.slice(0, keep)}…(${value.length} chars)`;
}

export function maskString(input: string): string {
  let out = input;
  for (const s of secrets) out = out.split(s).join('****');
  return out
    .replace(/(Bearer\s+)[A-Za-z0-9._\-~+/=]+/gi, '$1****')
    .replace(/(Basic\s+)[A-Za-z0-9+/=]+/gi, '$1****')
    .replace(/("access_token"\s*:\s*")[^"]+(")/g, '$1****$2')
    .replace(/("client_secret"\s*:\s*")[^"]+(")/g, '$1****$2');
}

/** Deep-masks an object by masking its JSON form. */
export function maskValue<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(maskString(JSON.stringify(value))) as T;
}

/** For tests only. */
export function clearSecrets(): void {
  secrets.clear();
}
