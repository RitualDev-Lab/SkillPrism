import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { BM25Engine } from "../src/bm25.js";
import { SkillIndex } from "../src/index-store.js";
import type { SkillDefinition } from "../src/types.js";

describe("Phase 1: Out-of-Context Skill Index & BM25 Catalog Suite", () => {
  test("BM25Engine tokenizes and ranks query relevance accurately", () => {
    const engine = new BM25Engine();
    engine.addDocument("doc1", "PostgreSQL database relational query executor");
    engine.addDocument("doc2", "AWS S3 cloud file storage and bucket management");
    engine.addDocument("doc3", "Kubernetes container cluster orchestration and pod monitoring");

    const sqlScores = engine.search("postgres database");
    assert.ok((sqlScores.get("doc1") || 0) > (sqlScores.get("doc2") || 0));
    assert.ok((sqlScores.get("doc1") || 0) > (sqlScores.get("doc3") || 0));

    const s3Scores = engine.search("s3 bucket storage");
    assert.ok((s3Scores.get("doc2") || 0) > (s3Scores.get("doc1") || 0));
  });

  test("SkillIndex registers skills and estimates token footprint savings", () => {
    const index = new SkillIndex();
    const skill: SkillDefinition = {
      id: "bigquery_analytics",
      name: "Google Cloud BigQuery",
      summary: "Runs federated analytical SQL queries over multi-terabyte datasets",
      description: "Integrates with Google Cloud BigQuery using service account credentials.",
      category: "database",
      tags: ["sql", "bigquery", "gcp", "analytics"],
      parameters: [
        { name: "query", type: "string", description: "Standard SQL query", required: true },
        { name: "location", type: "string", description: "Dataset region" },
      ],
    };

    index.register(skill);
    const retrieved = index.get("bigquery_analytics");
    assert.ok(retrieved);
    assert.equal(retrieved.id, "bigquery_analytics");
    assert.ok((retrieved.tokenCostEstimate || 0) > 50);

    const stats = index.getStats();
    assert.equal(stats.totalSkills, 1);
    assert.equal(stats.categories.database, 1);
  });

  test("SkillIndex returns lightweight disclosure snippets during search", () => {
    const index = new SkillIndex();
    index.register({
      id: "slack_post_message",
      name: "Slack Notifier",
      summary: "Posts formatted messages and alerts to Slack channels",
      description: "Sends notifications to Slack webhooks.",
      category: "api",
      tags: ["slack", "chat", "message", "notification"],
      parameters: [{ name: "channel", type: "string", description: "Channel name", required: true }],
    });

    index.register({
      id: "docker_build_image",
      name: "Docker Image Builder",
      summary: "Builds and tags container images from a local Dockerfile",
      description: "Invokes docker daemon to build container images.",
      category: "devops",
      tags: ["docker", "container", "build"],
      parameters: [{ name: "tag", type: "string", description: "Image tag", required: true }],
    });

    const results = index.search("send alert to slack channel", 2);
    assert.ok(results.length >= 1);
    assert.equal(results[0].skill.id, "slack_post_message");
    assert.ok(results[0].score > 0);
    assert.equal(results[0].disclosureSnippet.id, "slack_post_message");
  });

  test("SkillIndex imports tools directly from MCP tools/list format", () => {
    const index = new SkillIndex();
    const importedCount = index.importFromMcp([
      {
        name: "search_repositories",
        description: "Searches GitHub repositories by query and stars",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            limit: { type: "number", description: "Max results" },
          },
          required: ["query"],
        },
      },
    ]);

    assert.equal(importedCount, 1);
    const skill = index.get("search_repositories");
    assert.ok(skill);
    assert.equal(skill.parameters.length, 2);
    assert.equal(skill.parameters[0].name, "query");
    assert.equal(skill.parameters[0].required, true);
  });
});
