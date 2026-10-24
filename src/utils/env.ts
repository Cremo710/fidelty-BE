export function requireSecret(name: string): string {
  const value = process.env[name];
  if (!value || value.length < 32) {
    throw new Error(`${name} mancante o troppo corto (minimo 32 caratteri)`);
  }
  return value;
}
