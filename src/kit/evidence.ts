import type { Case, Db, PublicRecord } from "../store/db.ts";

/**
 * The public record of real paid cases, kept outside the server so it survives restarts on hosts
 * with an ephemeral disk. The buyer's input and the delivered output are redacted: their hashes
 * stay in the signed certificate, so every signature still verifies.
 */
export function evidenceCases(db: Db): Case[] {
  return db
    .allCases()
    .filter((x) => x.via === "x402")
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((x) => ({
      ...x,
      input: "[redacted]",
      output: "[redacted]",
      response: x.response ? { status: x.response.status, body: "[redacted]" } : undefined,
      idempotencyKey: null,
    }));
}

type GitHubOptions = { token: string; repo: string; branch: string; path: string };

/** Merges two public records: nothing already backed up is ever dropped. */
export function mergeRecords(a: Partial<PublicRecord>, b: Partial<PublicRecord>): PublicRecord {
  const challenges = new Map([...(a.challenges ?? []), ...(b.challenges ?? [])].map((c) => [c.id, c]));
  const proxies = new Map([...(a.proxies ?? []), ...(b.proxies ?? [])].map((p) => [p.id, p]));
  const promiseSets: PublicRecord["promiseSets"] = {};
  for (const src of [a.promiseSets ?? {}, b.promiseSets ?? {}]) {
    for (const [service, sets] of Object.entries(src)) {
      const list = (promiseSets[service] ??= []);
      for (const s of sets) if (!list.some((x) => x.version === s.version)) list.push(s);
      list.sort((x, y) => x.publishedAt - y.publishedAt);
    }
  }
  return { challenges: [...challenges.values()].sort((x, y) => x.at - y.at), proxies: [...proxies.values()], promiseSets };
}

/**
 * Stores the evidence file on its own branch of the repository. A separate branch means a backup
 * never triggers a redeploy of the service itself.
 */
export function gitHubEvidence({ token, repo, branch, path }: GitHubOptions) {
  const api = `https://api.github.com/repos/${repo}`;
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "paybox-tribunal",
  };
  const call = (url: string, init: RequestInit = {}) =>
    fetch(url, { ...init, headers: { ...headers, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15_000) });

  /** A file's sha and parsed content, or null when the branch or file doesn't exist yet. */
  async function readFile<T>(file: string): Promise<{ sha: string; data: T } | null> {
    const res = await call(`${api}/contents/${file}?ref=${encodeURIComponent(branch)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub read failed: ${res.status}`);
    const body = (await res.json()) as { sha: string; content: string };
    return { sha: body.sha, data: JSON.parse(Buffer.from(body.content, "base64").toString("utf8")) as T };
  }
  const read = async () => {
    const f = await readFile<Case[]>(path);
    return f ? { sha: f.sha, cases: f.data } : null;
  };
  const recordPath = path.replace(/[^/]+$/, "record.json");

  async function writeFile(file: string, data: unknown, sha: string | undefined, message: string) {
    const res = await call(`${api}/contents/${file}`, {
      method: "PUT",
      body: JSON.stringify({ message, content: Buffer.from(JSON.stringify(data, null, 2)).toString("base64"), branch, ...(sha ? { sha } : {}) }),
    });
    if (!res.ok) throw new Error(`GitHub write failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }

  async function ensureBranch() {
    const exists = await call(`${api}/git/ref/heads/${encodeURIComponent(branch)}`);
    if (exists.ok) return;
    const repoInfo = (await (await call(api)).json()) as { default_branch: string };
    const base = (await (await call(`${api}/git/ref/heads/${repoInfo.default_branch}`)).json()) as { object: { sha: string } };
    const created = await call(`${api}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }) });
    if (!created.ok && created.status !== 422) throw new Error(`GitHub branch create failed: ${created.status}`);
  }

  return {
    async load(): Promise<Case[]> {
      return (await read())?.cases ?? [];
    },
    async save(cases: Case[]) {
      await ensureBranch();
      const current = await read();
      // Never lose a case recorded before a restart: keep anything already backed up.
      const merged = new Map((current?.cases ?? []).map((c) => [c.id, c]));
      for (const c of cases) merged.set(c.id, c);
      const all = [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
      await writeFile(path, all, current?.sha, `Evidence: ${all.length} real case(s)`);
      return all.length;
    },
    async loadRecord(): Promise<Partial<PublicRecord>> {
      return (await readFile<PublicRecord>(recordPath))?.data ?? {};
    },
    async saveRecord(record: PublicRecord) {
      await ensureBranch();
      const current = await readFile<PublicRecord>(recordPath);
      const merged = mergeRecords(current?.data ?? {}, record);
      await writeFile(recordPath, merged, current?.sha, `Public record: ${merged.challenges.length} challenge(s), ${merged.proxies.length} guaranteed API(s)`);
      return merged;
    },
  };
}
