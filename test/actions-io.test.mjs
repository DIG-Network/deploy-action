// Unit tests for src/actions-io.mjs, focused on the heredoc form emitOutput
// writes to $GITHUB_OUTPUT. Every assertion is made on the BYTES in the file,
// not on a helper's return value: the file is what the Actions runner parses,
// and a helper-level assertion cannot see a second write path that still builds
// its own delimiter.

import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitOutput, emitOutputs } from "../src/actions-io.mjs";

const UUID_DELIM = /^__dig_eof_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}__$/;

/** Fresh empty $GITHUB_OUTPUT file; returns a reader for its exact bytes. */
function withOutputFile(t) {
  const file = join(mkdtempSync(join(tmpdir(), "dig-actions-io-")), "out.txt");
  writeFileSync(file, "");
  const prev = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = file;
  t.after(() => {
    if (prev === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = prev;
  });
  return () => readFileSync(file, "utf8");
}

/** Parse an Actions output file into `{ key: value }`, exactly as the runner does. */
function parseOutputs(text) {
  const parsed = {};
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^<=]+)<<(.+)$/.exec(lines[i]);
    if (m) {
      const [, key, delim] = m;
      const body = [];
      while (++i < lines.length && lines[i] !== delim) body.push(lines[i]);
      parsed[key] = body.join("\n");
      continue;
    }
    const eq = /^([^<=]+)=(.*)$/.exec(lines[i]);
    if (eq) parsed[eq[1]] = eq[2];
  }
  return parsed;
}

test("a value containing the delimiter cannot inject a second output key", (t) => {
  const readOut = withOutputFile(t);
  // Pin the delimiter so the fixture can actually CONTAIN it. Without this the
  // test could not distinguish the fix from the nearest wrong implementation —
  // a UUID delimiter with no guard — which is unguessable but still injectable
  // by any value that happens to carry it.
  const delim = "__dig_eof_00000000-0000-4000-8000-000000000000__";
  t.mock.method(crypto, "randomUUID", () => "00000000-0000-4000-8000-000000000000");

  const hostile = `benign\n${delim}\ninjected=pwned`;
  assert.throws(() => emitOutput("failure-reason", hostile), /delimiter/i);

  const written = readOut();
  assert.equal(written, "", "nothing is written when the value is rejected");
  assert.equal(parseOutputs(written).injected, undefined, "no injected key reaches the runner");
});

test("a key containing the delimiter is rejected too", (t) => {
  const readOut = withOutputFile(t);
  t.mock.method(crypto, "randomUUID", () => "00000000-0000-4000-8000-000000000000");
  const delim = "__dig_eof_00000000-0000-4000-8000-000000000000__";

  assert.throws(() => emitOutput(`k${delim}`, "v"), /delimiter/i);
  assert.equal(readOut(), "");
});

test("the delimiter is always a full-length UUID — never empty, never variable", (t) => {
  const readOut = withOutputFile(t);
  for (let i = 0; i < 200; i++) emitOutput(`k${i}`, "v");

  const delims = readOut()
    .split("\n")
    .filter((l) => l.includes("<<"))
    .map((l) => l.slice(l.indexOf("<<") + 2));

  assert.equal(delims.length, 200);
  for (const d of delims) assert.match(d, UUID_DELIM);
  assert.equal(new Set(delims).size, 200, "a fresh delimiter per call");
});

test("an honest multiline value round-trips through the runner's own parse", (t) => {
  const readOut = withOutputFile(t);
  const value = JSON.stringify({ outcome: "success", note: "line1\nline2" });
  emitOutputs({ json: value, outcome: "success" });

  const parsed = parseOutputs(readOut());
  assert.equal(parsed.json, value);
  assert.equal(parsed.outcome, "success");
});

test("no-op when $GITHUB_OUTPUT is unset (running locally)", (t) => {
  const prev = process.env.GITHUB_OUTPUT;
  delete process.env.GITHUB_OUTPUT;
  t.after(() => {
    if (prev !== undefined) process.env.GITHUB_OUTPUT = prev;
  });
  assert.doesNotThrow(() => emitOutput("k", "v"));
});
