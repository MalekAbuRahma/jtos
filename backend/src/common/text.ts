/**
 * Hides phone numbers and links in free text (T-010 security point 16, T-017 chat).
 * "call 0791234567" → "call [hidden]"
 */
export function maskContacts(text: string): string {
  return text
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, '[hidden]')
    .replace(/\b[\w.-]+\.(?:com|net|org|jo|sy|me|io|ly|app)(?:\/\S*)?\b/gi, '[hidden]')
    .replace(/(?:\+|00)?\d[\d\s\-().]{6,}\d/g, '[hidden]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[hidden]');
}
