import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Db, type Case } from "../src/store/db.ts";

test("committed evidence cases are restored on boot without overwriting live ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-"));
  const evidence = join(dir, "cases.json");
  const kept = { id: "real-1", service: "quote", via: "x402", input: "[redacted]" } as unknown as Case;
  const clash = { id: "live-1", service: "quote", via: "x402", input: "[redacted]" } as unknown as Case;
  writeFileSync(evidence, JSON.stringify([kept, clash]));

  const db = new Db(":memory:", evidence);
  assert.equal(db.getCase("real-1")?.service, "quote");

  const live = { id: "live-1", service: "invoice" } as unknown as Case;
  writeFileSync(join(dir, "db.json"), JSON.stringify({ cases: { "live-1": live } }));
  const withData = new Db(join(dir, "db.json"), evidence);
  assert.equal(withData.getCase("live-1")?.service, "invoice");
  assert.equal(withData.getCase("real-1")?.service, "quote");
});

test("a missing evidence file is fine", () => {
  const db = new Db(":memory:", join(tmpdir(), "does-not-exist.json"));
  assert.equal(db.allCases().length, 0);
});

test("GitHub backup merges with what is already stored and never drops a case", async () => {
  const { gitHubEvidence } = await import("../src/kit/evidence.ts");
  let stored: { sha: string; content: string } | null = {
    sha: "s1",
    content: Buffer.from(JSON.stringify([{ id: "old", createdAt: 1 }])).toString("base64"),
  };
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (url.includes("/git/ref/heads/evidence")) return new Response("{}", { status: 200 });
    if (init?.method === "PUT") {
      const body = JSON.parse(String(init.body));
      assert.equal(body.sha, "s1");
      assert.equal(body.branch, "evidence");
      stored = { sha: "s2", content: body.content };
      return new Response("{}", { status: 200 });
    }
    if (url.includes("/contents/")) return stored ? Response.json(stored) : new Response("", { status: 404 });
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;
  try {
    const store = gitHubEvidence({ token: "t", repo: "o/r", branch: "evidence", path: "evidence/cases.json" });
    const total = await store.save([{ id: "new", createdAt: 2 } as unknown as Case]);
    assert.equal(total, 2);
    assert.deepEqual((await store.load()).map((c) => c.id), ["old", "new"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});
