/**
 * Utility per la sanitizzazione dell'input
 * Previene SQL Injection, XSS e altri attacchi
 */

/**
 * Sanitizza una stringa rimuovendo caratteri potenzialmente pericolosi
 * @param input - Stringa da sanitizzare
 * @returns Stringa sanitizzata
 */
export function sanitizeString(input: string): string {
  return input
    .trim()
    .replace(/[;'"\\]/g, "") // Rimuove caratteri problematici
    .substring(0, 255); // Limita la lunghezza
}

/**
 * Sanitizza un email verificando il formato
 * @param email - Email da sanitizzare
 * @returns Email sanitizzato
 */
export function sanitizeEmail(email: string): string {
  return email
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9@._-]/g, "") // Permette solo caratteri validi per email
    .substring(0, 255);
}

/**
 * Verifica se una stringa contiene pattern di SQL injection
 * @param input - Stringa da verificare
 * @returns true se contiene pattern sospetti
 */
export function containsSQLInjectionPattern(input: string): boolean {
  const sqlKeywords = [
    /(\b(UNION|SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE|SCRIPT|JAVA|JAVASCRIPT)\b)/i,
    /(--|\/\*|\*\/|;|\||&&|\|\|)/,
    /(\x00|\n|\r)/,
  ];

  return sqlKeywords.some((pattern) => pattern.test(input));
}

/**
 * Verifica se una stringa contiene pattern di XSS
 * @param input - Stringa da verificare
 * @returns true se contiene pattern sospetti
 */
export function containsXSSPattern(input: string): boolean {
  const xssPatterns = [
    /<script[^>]*>[\s\S]*?<\/script>/gi,
    /<iframe[^>]*>[\s\S]*?<\/iframe>/gi,
    /javascript:/gi,
    /onerror\s*=/gi,
    /onclick\s*=/gi,
    /onload\s*=/gi,
  ];

  return xssPatterns.some((pattern) => pattern.test(input));
}

/**
 * Sanitizza un oggetto ricorsivamente
 * @param obj - Oggetto da sanitizzare
 * @returns Oggetto sanitizzato
 */
export function sanitizeObject(obj: any): any {
  if (typeof obj === "string") {
    return sanitizeString(obj);
  }

  if (typeof obj === "object" && obj !== null) {
    if (Array.isArray(obj)) {
      return obj.map((item) => sanitizeObject(item));
    }

    const sanitized: any = {};
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        sanitized[key] = sanitizeObject(obj[key]);
      }
    }
    return sanitized;
  }

  return obj;
}

/**
 * Valida un email format
 * @param email - Email da validare
 * @returns true se l'email ha un formato valido
 */
export function isValidEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 255;
}

/**
 * Valida una password secondo i criteri di sicurezza
 * @param password - Password da validare
 * @returns Oggetto con validazione e dettagli degli errori
 */
export function validatePasswordStrength(password: string): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (password.length < 8) {
    errors.push("Password deve avere almeno 8 caratteri");
  }

  if (!/[A-Z]/.test(password)) {
    errors.push("Password deve contenere almeno una maiuscola");
  }

  if (!/[a-z]/.test(password)) {
    errors.push("Password deve contenere almeno una minuscola");
  }

  if (!/[0-9]/.test(password)) {
    errors.push("Password deve contenere almeno un numero");
  }

  if (/^(.)\1+$/.test(password)) {
    errors.push("Password non deve contenere caratteri ripetuti");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Limita la lunghezza di una stringa
 * @param str - Stringa
 * @param maxLength - Lunghezza massima
 * @returns Stringa limitata
 */
export function limitStringLength(str: string, maxLength: number): string {
  return str.substring(0, maxLength);
}
