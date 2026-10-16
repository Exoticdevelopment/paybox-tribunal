import { readFileSync } from "node:fs";

/**
 * The public showcase page (src/kit/page.html): pitch, promise compiler, "break my guarantee"
 * challenges and the live verdict feed. Plain HTML + JS against the JSON endpoints, no build step.
 */
const PAGE = readFileSync(new URL("./page.html", import.meta.url), "utf8");

const CASE_PAGE = readFileSync(new URL("./case.html", import.meta.url), "utf8");

/** Per-case Promise / Evidence / Payment page. Fetches its data from the JSON endpoints. */
export function caseHtml(): string {
  return CASE_PAGE;
}

export function dashboardHtml(): string {
  return PAGE;
}
