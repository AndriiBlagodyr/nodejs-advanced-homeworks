/** What a keyless client process could have used instead of its URL. Expected: nothing. */
export function sensitiveEnvKeys(): number {
  return Object.keys(process.env).filter((k) => /STORAGE|AWS|JWT|DATABASE|SECRET|TOKEN/.test(k))
    .length;
}
