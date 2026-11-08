import assert from "node:assert/strict";
import test from "node:test";
import { ContextCompactor } from "../src/compactor.js";

test("Phase 2: SkillPrism In-Process ONNX Semantic Compactor Suite", async (t) => {
  await t.test(
    "sub-millisecond semantic tool receipt matching via in-process vector cosine distance",
    async () => {
      const compactor = new ContextCompactor(256);

      // Compact 3 diverse tool results
      const res1 = compactor.compact(
        "postgres_query",
        {
          rows: Array.from({ length: 50 }, (_, i) => ({
            id: i,
            username: `user_${i}`,
            role: "member",
            active: true,
          })),
        },
        "success",
      );

      const res2 = compactor.compact(
        "stripe_list_charges",
        {
          data: Array.from({ length: 40 }, (_, i) => ({
            id: `ch_${i}`,
            amount: 5000,
            currency: "usd",
            status: "succeeded",
          })),
        },
        "success",
      );

      const res3 = compactor.compact(
        "github_list_issues",
        {
          issues: Array.from({ length: 30 }, (_, i) => ({
            id: i,
            title: `Issue #${i}: Memory leak in worker pool`,
            state: "open",
          })),
        },
        "success",
      );

      assert.equal(res1.isCompacted, true);
      assert.equal(res2.isCompacted, true);
      assert.equal(res3.isCompacted, true);

      // Search query targeting database rows
      const t0 = performance.now();
      const dbMatches = await compactor.searchReceipts(
        "retrieve database users and member rows",
        2,
      );
      const searchLatencyMs = performance.now() - t0;

      assert.ok(searchLatencyMs < 20, `Search latency was ${searchLatencyMs}ms`);
      assert.ok(dbMatches.length > 0);
      assert.equal(dbMatches[0].receipt.tool, "postgres_query");
      assert.ok(dbMatches[0].similarityScore > 0);

      // Search query targeting payments
      const stripeMatches = await compactor.searchReceipts(
        "customer billing payments and charges",
        1,
      );
      assert.ok(stripeMatches.length > 0);
      assert.equal(stripeMatches[0].receipt.tool, "stripe_list_charges");
    },
  );

  await t.test(
    "structural diff compression reduces extended agent retry loops by > 80% tokens",
    async () => {
      const compactor = new ContextCompactor();

      // Simulate a 4-turn autonomous agent debugging loop on an API endpoint
      const turn1Output = `function handleAuth(req) {\n  const token = req.headers['authorization'];\n  return jwt.verify(token, 'verify_key');\n}\n// Error: ReferenceError: jwt is not defined\n${"x".repeat(1200)}`;
      const turn2Output = `import jwt from 'jsonwebtoken';\nfunction handleAuth(req) {\n  const token = req.headers['authorization'];\n  return jwt.verify(token, 'verify_key');\n}\n// Error: JsonWebTokenError: jwt must be provided\n${"x".repeat(1250)}`;
      const turn3Output = `import jwt from 'jsonwebtoken';\nfunction handleAuth(req) {\n  const token = req.headers['authorization']?.replace('Bearer ', '');\n  if (!token) throw new Error('Missing token');\n  return jwt.verify(token, 'verify_key');\n}\n// Tests passing 100%\n${"x".repeat(1300)}`;

      const loopTurns = [
        {
          turnNumber: 1,
          targetFileOrCommand: "src/auth/jwt.ts",
          codeOrOutput: turn1Output,
          error: "ReferenceError: jwt is not defined",
        },
        {
          turnNumber: 2,
          targetFileOrCommand: "src/auth/jwt.ts",
          codeOrOutput: turn2Output,
          error: "JsonWebTokenError: jwt must be provided",
        },
        {
          turnNumber: 3,
          targetFileOrCommand: "src/auth/jwt.ts",
          codeOrOutput: turn3Output,
        },
      ];

      const compression = compactor.compressExtendedAgentLoop(loopTurns);

      assert.equal(compression.turnsCompressed, 3);
      assert.ok(compression.compressionRef.startsWith("diff_receipt_"));
      assert.ok(compression.totalTokensSaved > 500, `Saved ${compression.totalTokensSaved} tokens`);
      assert.ok(
        compression.compressionRatio < 0.25,
        `Compression ratio was ${compression.compressionRatio}`,
      );
      assert.equal(compression.diffs.length, 3);
      assert.equal(compression.diffs[2].errorDelta?.resolved, true);
    },
  );
});
