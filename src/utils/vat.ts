/** Valida una P.IVA italiana (11 cifre) con l'algoritmo ufficiale di Luhn modificato. */
export function isValidItalianVat(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false;

  let sum = 0;
  for (let i = 0; i < 10; i++) {
    let digit = Number(value[i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }

  const check = (10 - (sum % 10)) % 10;
  return check === Number(value[10]);
}
