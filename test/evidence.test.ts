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
