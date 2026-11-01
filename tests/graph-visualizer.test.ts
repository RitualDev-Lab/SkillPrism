import assert from "node:assert";
import { describe, it } from "node:test";
import {
  buildVisualGraphData,
  exportGraphVisualizerFile,
  generateGraphVisualizerHtml,
} from "../src/graph-visualizer.js";
import type { SkillDefinition } from "../src/types.js";
import { existsSync, unlinkSync } from "node:fs";

describe("SkillPrism Interactive D3 Visual Graph Explorer Suite", () => {
  const sampleSkills: SkillDefinition[] = [
    {
      id: "postgres_query",
      name: "PostgreSQL Query",
      summary: "Query relational database",
      description: "Postgres read operations",
      category: "database",
      tags: ["sql", "postgres"],
      parameters: [],
    },
    {
      id: "redis_cache_get",
      name: "Redis Cache Get",
      summary: "Fetch key from in-memory cache",
      description: "Redis fast get",
      category: "database",
      tags: ["redis", "cache"],
      parameters: [],
    },
    {
      id: "aws_s3_upload",
      name: "S3 Object Upload",
      summary: "Upload binary object to bucket",
      description: "AWS cloud storage",
      category: "cloud",
      tags: ["aws", "s3"],
      parameters: [],
    },
  ];

  const trajectory = [
    { tool: "postgres_query", nextTool: "redis_cache_get", latencyMs: 30, tokensSaved: 400 },
  ];

  it("builds structured VisualGraphData with semantic clusters and call dependencies", () => {
    const graphData = buildVisualGraphData(sampleSkills, trajectory);

    assert.strictEqual(graphData.nodes.length, 3);
    assert.strictEqual(graphData.categories.length, 2); // database, cloud
    assert.strictEqual(graphData.metrics.totalTools, 3);
    assert.ok(graphData.links.length >= 2);

    const depLink = graphData.links.find((l) => l.type === "call_dependency");
    assert.ok(depLink);
    assert.strictEqual(depLink?.source, "postgres_query");
    assert.strictEqual(depLink?.target, "redis_cache_get");
  });

  it("generates a self-contained D3.js interactive HTML explorer", () => {
    const graphData = buildVisualGraphData(sampleSkills, trajectory);
    const html = generateGraphVisualizerHtml(graphData);

    assert.ok(html.includes("<!DOCTYPE html>"));
    assert.ok(html.includes("d3.forceSimulation"));
    assert.ok(html.includes("SkillPrism Explorer"));
    assert.ok(html.includes("postgres_query"));
    assert.ok(html.includes("aws_s3_upload"));
    assert.ok(html.includes("Category View"));
    assert.ok(html.includes("Heatmap"));
  });

  it("exports graph explorer HTML file to disk successfully", () => {
    const testFile = "test-skillprism-graph.html";
    try {
      if (existsSync(testFile)) unlinkSync(testFile);
      const graphData = buildVisualGraphData(sampleSkills, trajectory);
      const res = exportGraphVisualizerFile(graphData, testFile);

      assert.strictEqual(res, testFile);
      assert.strictEqual(existsSync(testFile), true);
    } finally {
      if (existsSync(testFile)) unlinkSync(testFile);
    }
  });
});
