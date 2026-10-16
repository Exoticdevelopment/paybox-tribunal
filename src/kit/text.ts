/** Lowercase, strip accents, collapse whitespace: "Panadería  La" → "panaderia la". */
export function normalize(text: string): string {
  return text
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** True when `value` appears in `document`, ignoring case, accents and spacing. */
export function appearsIn(document: string, value: string): boolean {
  return normalize(document).includes(normalize(value));
}

/**
 * Every number written in the text, reduced to its digits so formatting doesn't matter:
 * "50.456", "50,456" and "50456" all become "50456"; "47%" becomes "47".
 */
export function numberTokens(text: string): Set<string> {
  return new Set((text.match(/\d[\d.,]*\d|\d/g) ?? []).map((t) => t.replace(/\D/g, "")));
}

/** True when an amount appears in the document in any common money format. */
export function amountAppearsIn(document: string, amount: number): boolean {
  const tokens = numberTokens(document);
  const cents = amount.toFixed(2).replace(".", "");
  return tokens.has(cents) || (Number.isInteger(amount) && tokens.has(String(amount)));
}

export function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}
