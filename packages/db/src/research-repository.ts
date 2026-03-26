import type { Pool } from "pg";
import { SalvoRepository } from "./repository";
import type { DbResearchReviewStatus, ResearchIngestionCandidate } from "./types";

export class ResearchRepository {
  private readonly repo: SalvoRepository;

  constructor(pool: Pool) {
    this.repo = new SalvoRepository(pool);
  }

  async close(): Promise<void> {
    await this.repo.close();
  }

  async upsertDaemonHeartbeat(
    daemonId: string,
    metadataJson?: Record<string, unknown>
  ) {
    return this.repo.upsertDaemonHeartbeat("research", daemonId, metadataJson);
  }

  async listResearchIngestionCandidates(limit = 50): Promise<ResearchIngestionCandidate[]> {
    return this.repo.listResearchIngestionCandidates(limit);
  }

  async recordResearchIngestion(candidate: ResearchIngestionCandidate): Promise<void> {
    await this.repo.recordResearchIngestion(candidate);
  }

  async listPendingExperimentFamilies(minSampleSize: number, limit = 20) {
    return this.repo.listPendingExperimentFamilies(minSampleSize, limit);
  }

  async listPendingFamilyIngestions(
    workspaceId: string,
    familyKey: string,
    category: string,
    subcategory: string | null,
    limit = 500
  ) {
    return this.repo.listPendingFamilyIngestions(
      workspaceId,
      familyKey,
      category,
      subcategory,
      limit
    );
  }

  async createResearchExperiment(input: {
    workspaceId: string;
    familyKey: string;
    category: string;
    subcategory: string | null;
    sampleSize: number;
    sourceDigest: string;
    sourceRunIds: string[];
    metricsJson: Record<string, unknown>;
    bodyMarkdown: string;
    confidence: number;
    reviewStatus: DbResearchReviewStatus;
  }) {
    return this.repo.createResearchExperiment(input);
  }

  async attachIngestionsToExperiment(experimentId: string, runIds: string[]): Promise<void> {
    await this.repo.attachIngestionsToExperiment(experimentId, runIds);
  }

  async createResearchFinding(input: {
    experimentId: string;
    workspaceId: string;
    findingType: string;
    title: string;
    bodyMarkdown: string;
    confidence: number;
    metadataJson?: Record<string, unknown>;
  }): Promise<void> {
    await this.repo.createResearchFinding(input);
  }

  async listAcceptedUnpublishedResearchExperiments(limit = 50) {
    return this.repo.listAcceptedUnpublishedResearchExperiments(limit);
  }

  async publishAcceptedResearchExperiment(
    experimentId: string,
    memoryOverride?: {
      title: string;
      summary: string;
      bodyMarkdown: string;
      tags: string[];
      confidence: number;
    }
  ): Promise<boolean> {
    return this.repo.publishAcceptedResearchExperiment(experimentId, memoryOverride);
  }

  async listIntegrationConfigs(): Promise<
    Array<{
      integration_key: string;
      config_json: Record<string, unknown>;
    }>
  > {
    return this.repo.listIntegrationConfigs();
  }

  async listResearchContext(
    workspaceId: string,
    limit = 5
  ): Promise<
    Array<{
      id: string;
      source_run_ids: string[];
      confidence: number;
      review_status: "unreviewed" | "accepted" | "rejected";
    }>
  > {
    return this.repo.listResearchContext(workspaceId, limit);
  }

  async listMemoryContext(
    workspaceId: string,
    limit = 5
  ): Promise<
    Array<{
      id: string;
      confidence: number;
      review_status: "unreviewed" | "accepted" | "rejected";
    }>
  > {
    return this.repo.listMemoryContext(workspaceId, limit);
  }
}
