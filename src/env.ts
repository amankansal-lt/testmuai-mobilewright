/**
 * TestMu.Ai-branded environment variables, falling back to the LT_ names the
 * platform's existing docs, samples and CI jobs already use. Both are supported
 * indefinitely: the fallback is not a deprecation, it is what most existing
 * pipelines are configured with.
 */
export function envValue(name: 'USERNAME' | 'ACCESS_KEY' | 'APP' | 'BUILD' | 'ENV'): string | undefined {
  return process.env[`TESTMU_${name}`] || process.env[`LT_${name}`] || undefined;
}

/** Both spellings of a variable, for error messages that have to name them. */
export function envNames(name: string): string {
  return `TESTMU_${name} (or LT_${name})`;
}
