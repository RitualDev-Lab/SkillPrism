import assert from "node:assert";
import { describe, it } from "node:test";
import {
  enrichToolWithFewShotExamples,
  generateSyntheticFewShotExamples,
  synthesizeObjectFromSchema,
  validateInvocationAgainstSchema,
} from "../src/few-shot-synthesizer.js";
import type { MetaToolDefinition } from "../src/harness.js";

describe("SkillPrism Synthetic Tool Few-Shot Synthesizer Suite", () => {
  const complexSchema = {
    type: "object",
    required: ["tableName", "filter"],
    properties: {
      tableName: { type: "string", description: "Database table name" },
      limit: { type: "integer", default: 25, minimum: 1, maximum: 100 },
      filter: {
        type: "object",
        required: ["status"],
        properties: {
          status: { type: "string", enum: ["active", "pending", "archived"] },
          userId: { type: "string", format: "uuid" },
          amountThreshold: { type: "number" },
        },
      },
      tags: {
        type: "array",
        items: { type: "string" },
      },
    },
  };

  it("synthesizes valid object matching required and optional properties", () => {
    const minimal = synthesizeObjectFromSchema(complexSchema, 0, 4, true);
    assert.strictEqual(typeof minimal.tableName, "string");
    assert.ok(minimal.filter);
    assert.strictEqual(minimal.filter.status, "active");
    // Optional properties should be omitted in minimal mode
    assert.strictEqual(minimal.limit, undefined);

    const comprehensive = synthesizeObjectFromSchema(complexSchema, 0, 4, false);
    assert.strictEqual(typeof comprehensive.tableName, "string");
    assert.strictEqual(typeof comprehensive.limit, "number");
    assert.ok(comprehensive.filter);
    assert.strictEqual(comprehensive.filter.status, "active");
    assert.ok(Array.isArray(comprehensive.tags));
  });

  it("generates synthetic few-shot invocation examples", () => {
    const examples = generateSyntheticFewShotExamples(complexSchema);
    assert.ok(examples.length >= 2);
    assert.strictEqual(examples[0].title, "Minimal Required Invocation");
    assert.strictEqual(examples[1].title, "Standard Parameterized Invocation");

    const validCheck = validateInvocationAgainstSchema(examples[0].arguments, complexSchema);
    assert.strictEqual(validCheck.isValid, true);
    assert.strictEqual(validCheck.missingRequired.length, 0);
  });

  it("enriches MetaToolDefinition with structured examples and Markdown documentation", () => {
    const tool: MetaToolDefinition = {
      name: "query_database",
      description: "Queries enterprise SQL cluster.",
      parameters: complexSchema,
    };

    const enriched = enrichToolWithFewShotExamples(tool);
    assert.ok((enriched as any).examples);
    assert.ok(Array.isArray((enriched as any).examples));
    assert.ok(enriched.description.includes("### Few-Shot Invocation Examples:"));
    assert.ok(enriched.description.includes("Minimal Required Invocation"));
  });

  it("handles oneOf / anyOf branch resolution gracefully", () => {
    const oneOfSchema = {
      type: "object",
      required: ["action"],
      properties: {
        action: {
          oneOf: [
            {
              type: "object",
              required: ["createId"],
              properties: { createId: { type: "string" } },
            },
            {
              type: "object",
              required: ["deleteId"],
              properties: { deleteId: { type: "string" } },
            },
          ],
        },
      },
    };

    const result = synthesizeObjectFromSchema(oneOfSchema, 0, 4, false);
    assert.ok(result.action);
    assert.strictEqual(typeof result.action.createId, "string");
  });
});
