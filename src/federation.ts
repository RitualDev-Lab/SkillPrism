/**
 * Multi-Agent Federated Skill Registry
 *
 * Allows teams with fleets of autonomous AI coding agents to share:
 * 1. Discovered tools and dynamic MCP skills across agents
 * 2. Real-time tool execution latency and success-rate benchmarks
 * 3. Out-of-context semantic receipts across distributed agent nodes
 * Over a shared Redis cluster or local peer-to-peer mesh.
 */

import { EventEmitter } from "node:events";
import type { SemanticReceipt } from "./compactor.js";
import type { SkillDefinition } from "./types.js";

export interface FleetPeerNode {
  nodeId: string;
  agentRole: string;
  host: string;
  registeredAt: string;
  lastHeartbeatMs: number;
  activeSkillsCount: number;
}

export interface ToolTelemetryRecord {
  toolName: string;
  nodeId: string;
  durationMs: number;
  success: boolean;
  tokensSaved: number;
  timestamp: string;
}

export interface ToolBenchmarkAggregate {
  toolName: string;
  totalCalls: number;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  successRate: number;
  totalTokensSaved: number;
}

export interface FederationMessage {
  type: "skill_published" | "benchmark_recorded" | "receipt_shared" | "heartbeat";
  senderNodeId: string;
  timestamp: string;
  payload: any;
}

export interface FederationTransport {
  publish(channel: string, message: FederationMessage): Promise<void>;
  subscribe(channel: string, handler: (message: FederationMessage) => void): Promise<() => void>;
  close(): Promise<void>;
}

/**
 * In-memory local peer event bus transport for multi-agent processes and test suites
 */
export class LocalPeerBusTransport implements FederationTransport {
  private bus = new EventEmitter();

  constructor() {
    this.bus.setMaxListeners(100);
  }

  public async publish(channel: string, message: FederationMessage): Promise<void> {
    this.bus.emit(channel, message);
  }

  public async subscribe(
    channel: string,
    handler: (message: FederationMessage) => void,
  ): Promise<() => void> {
    this.bus.on(channel, handler);
    return () => {
      this.bus.off(channel, handler);
    };
  }

  public async close(): Promise<void> {
    this.bus.removeAllListeners();
  }
}

/**
 * Redis Cluster / Standalone Client Federation Adapter
 * Supports standard Redis commands (PUBLISH, SUBSCRIBE) with automated fallback to local bus.
 */
export class RedisClusterTransport implements FederationTransport {
  private localFallback = new LocalPeerBusTransport();
  private redisClient?: any;
  private isConnected = false;
  private channelName: string;

  constructor(
    redisOptions: { host?: string; port?: number; cluster?: boolean; client?: any } = {},
  ) {
    this.channelName = "skillprism:federation:events";
    if (redisOptions.client) {
      this.redisClient = redisOptions.client;
      this.isConnected = true;
    }
  }

  public async publish(channel: string, message: FederationMessage): Promise<void> {
    if (this.isConnected && this.redisClient && typeof this.redisClient.publish === "function") {
      try {
        await this.redisClient.publish(channel || this.channelName, JSON.stringify(message));
        return;
      } catch {
        // Fall back to local bus on redis network error
      }
    }
    return this.localFallback.publish(channel, message);
  }

  public async subscribe(
    channel: string,
    handler: (message: FederationMessage) => void,
  ): Promise<() => void> {
    if (this.isConnected && this.redisClient && typeof this.redisClient.subscribe === "function") {
      try {
        const sub = await this.redisClient.subscribe(
          channel || this.channelName,
          (msgStr: string) => {
            try {
              const parsed = JSON.parse(msgStr);
              handler(parsed);
            } catch {
              // Ignored
            }
          },
        );
        return () => sub?.unsubscribe?.();
      } catch {
        // Fall back
      }
    }
    return this.localFallback.subscribe(channel, handler);
  }

  public async close(): Promise<void> {
    await this.localFallback.close();
    if (this.redisClient && typeof this.redisClient.quit === "function") {
      try {
        await this.redisClient.quit();
      } catch {
        // Ignored
      }
    }
  }
}

/**
 * Multi-Agent Federated Skill Registry
 */
export class FederatedSkillRegistry {
  private nodeId: string;
  private agentRole: string;
  private transport: FederationTransport;
  private peers: Map<string, FleetPeerNode> = new Map();
  private federatedSkills: Map<string, SkillDefinition> = new Map();
  private telemetryLedger: Map<string, ToolTelemetryRecord[]> = new Map();
  private sharedReceipts: Map<string, SemanticReceipt> = new Map();
  private unsubscribeFn?: () => void;

  constructor(
    nodeId = `agent-${Math.random().toString(36).slice(2, 8)}`,
    agentRole = "autonomous-coding-agent",
    transport: FederationTransport = new LocalPeerBusTransport(),
  ) {
    this.nodeId = nodeId;
    this.agentRole = agentRole;
    this.transport = transport;

    // Self registration
    this.peers.set(this.nodeId, {
      nodeId: this.nodeId,
      agentRole: this.agentRole,
      host: "local",
      registeredAt: new Date().toISOString(),
      lastHeartbeatMs: Date.now(),
      activeSkillsCount: 0,
    });
  }

  public getNodeId(): string {
    return this.nodeId;
  }

  public getAgentRole(): string {
    return this.agentRole;
  }

  /**
   * Initializes federation message listener across the shared transport
   */
  public async initialize(): Promise<void> {
    this.unsubscribeFn = await this.transport.subscribe(
      "skillprism:fleet",
      (msg: FederationMessage) => {
        this.handleIncomingMessage(msg);
      },
    );

    // Broadcast initial joining heartbeat
    await this.broadcastHeartbeat();
  }

  private handleIncomingMessage(msg: FederationMessage): void {
    if (!msg || typeof msg !== "object") return;
    if (msg.senderNodeId === this.nodeId) return;

    // Update peer heartbeat
    const existing = this.peers.get(msg.senderNodeId);
    if (existing) {
      existing.lastHeartbeatMs = Date.now();
    } else {
      this.peers.set(msg.senderNodeId, {
        nodeId: msg.senderNodeId,
        agentRole: msg.payload?.agentRole || "peer-agent",
        host: msg.payload?.host || "remote",
        registeredAt: msg.timestamp || new Date().toISOString(),
        lastHeartbeatMs: Date.now(),
        activeSkillsCount: msg.payload?.activeSkillsCount || 0,
      });
    }

    if (msg.type === "skill_published" && msg.payload?.skill) {
      const skill: SkillDefinition = msg.payload.skill;
      this.federatedSkills.set(skill.id, skill);
    } else if (msg.type === "benchmark_recorded" && msg.payload?.record) {
      const rec: ToolTelemetryRecord = msg.payload.record;
      const records = this.telemetryLedger.get(rec.toolName) || [];
      records.push(rec);
      if (records.length > 100) records.shift();
      this.telemetryLedger.set(rec.toolName, records);
    } else if (msg.type === "receipt_shared" && msg.payload?.receipt) {
      const r: SemanticReceipt = msg.payload.receipt;
      this.sharedReceipts.set(r.ref, r);
    }
  }

  /**
   * Publishes a newly discovered skill to all connected agents in the fleet
   */
  public async publishSkill(skill: SkillDefinition): Promise<void> {
    this.federatedSkills.set(skill.id, skill);
    await this.transport.publish("skillprism:fleet", {
      type: "skill_published",
      senderNodeId: this.nodeId,
      timestamp: new Date().toISOString(),
      payload: { skill, agentRole: this.agentRole },
    });
  }

  /**
   * Records and broadcasts tool execution telemetry (latency, success rate, token savings)
   */
  public async recordBenchmark(
    toolName: string,
    durationMs: number,
    success: boolean,
    tokensSaved = 0,
  ): Promise<void> {
    const record: ToolTelemetryRecord = {
      toolName,
      nodeId: this.nodeId,
      durationMs,
      success,
      tokensSaved,
      timestamp: new Date().toISOString(),
    };

    const records = this.telemetryLedger.get(toolName) || [];
    records.push(record);
    if (records.length > 100) records.shift();
    this.telemetryLedger.set(toolName, records);

    await this.transport.publish("skillprism:fleet", {
      type: "benchmark_recorded",
      senderNodeId: this.nodeId,
      timestamp: new Date().toISOString(),
      payload: { record },
    });
  }

  /**
   * Shares a compacted semantic receipt with other fleet agents
   */
  public async shareReceipt(receipt: SemanticReceipt): Promise<void> {
    this.sharedReceipts.set(receipt.ref, receipt);
    await this.transport.publish("skillprism:fleet", {
      type: "receipt_shared",
      senderNodeId: this.nodeId,
      timestamp: new Date().toISOString(),
      payload: { receipt },
    });
  }

  /**
   * Retrieves a shared receipt from any agent in the fleet
   */
  public getSharedReceipt(ref: string): SemanticReceipt | undefined {
    return this.sharedReceipts.get(ref);
  }

  /**
   * Computes aggregate benchmark stats for a specific tool across the fleet
   */
  public getToolBenchmark(toolName: string): ToolBenchmarkAggregate | null {
    const records = this.telemetryLedger.get(toolName);
    if (!records || records.length === 0) return null;

    let totalDuration = 0;
    let minDuration = Number.POSITIVE_INFINITY;
    let maxDuration = 0;
    let successCount = 0;
    let totalTokensSaved = 0;

    for (const r of records) {
      totalDuration += r.durationMs;
      if (r.durationMs < minDuration) minDuration = r.durationMs;
      if (r.durationMs > maxDuration) maxDuration = r.durationMs;
      if (r.success) successCount++;
      totalTokensSaved += r.tokensSaved;
    }

    return {
      toolName,
      totalCalls: records.length,
      avgLatencyMs: Math.round((totalDuration / records.length) * 10) / 10,
      minLatencyMs: minDuration,
      maxLatencyMs: maxDuration,
      successRate: Math.round((successCount / records.length) * 100) / 100,
      totalTokensSaved,
    };
  }

  public getActivePeers(): FleetPeerNode[] {
    const now = Date.now();
    // Prune nodes that haven't sent heartbeat in 60 seconds
    const active: FleetPeerNode[] = [];
    for (const peer of this.peers.values()) {
      if (now - peer.lastHeartbeatMs < 60000 || peer.nodeId === this.nodeId) {
        active.push(peer);
      }
    }
    return active;
  }

  public getFederatedSkills(): SkillDefinition[] {
    return Array.from(this.federatedSkills.values());
  }

  public async broadcastHeartbeat(): Promise<void> {
    await this.transport.publish("skillprism:fleet", {
      type: "heartbeat",
      senderNodeId: this.nodeId,
      timestamp: new Date().toISOString(),
      payload: {
        agentRole: this.agentRole,
        activeSkillsCount: this.federatedSkills.size,
      },
    });
  }

  public async close(): Promise<void> {
    if (this.unsubscribeFn) {
      this.unsubscribeFn();
    }
    await this.transport.close();
  }
}
