import { createHash } from "node:crypto";
import { ResearchRepository } from "@salvo/db";
import type { LlmConfig } from "@salvo/llm";
import { resolveLlmProviderAndModel } from "@salvo/shared";
import {
  buildExperimentMarkdown,
  deriveExperimentConfidence,
  deriveExperimentInsights,
  deriveExperimentMetrics,
  normalizeExperimentSamples
} from "./analysis";
import {
  buildFallbackResearchMemoryDraft,
  synthesizeResearchMemory,
  type ResearchMemoryDraft
} from "./synthesis";

export type ResearchCycleStats = {
  ingested: number;
  experiments: number;
  published: number;
};

export class ResearchAnalysisService {
  constructor(
    private readonly repo: ResearchRepository,
    private readonly minSampleSize: number
  ) {}

  private buildSourceDigest(runIds: string[]): string {
    const normalized = [...runIds].sort().join("|");
    return createHash("sha256").update(normalized).digest("hex");
  }

  async ingestLoop(): Promise<number> {
    const candidates = await this.repo.listResearchIngestionCandidates(100);
    let ingested = 0;

    for (const candidate of candidates) {
      await this.repo.recordResearchIngestion(candidate);
      ingested += 1;
    }

    return ingested;
  }

  async experimentLoop(): Promise<number> {
    const families = await this.repo.listPendingExperimentFamilies(this.minSampleSize, 20);
    let created = 0;

    for (const family of families) {
      const ingestions = await this.repo.listPendingFamilyIngestions(
        family.workspace_id,
        family.contract_family_key,
        family.contract_category,
        family.contract_subcategory,
        500
      );
      if (ingestions.length < this.minSampleSize) {
        continue;
      }

      const sorted = normalizeExperimentSamples(ingestions);
      const metrics = deriveExperimentMetrics(sorted);
      const confidence = deriveExperimentConfidence(metrics);
      const insights = deriveExperimentInsights(sorted, metrics);
      const sourceRunIds = sorted.map((item) => item.run_id);
      const sourceDigest = this.buildSourceDigest(sourceRunIds);
      const markdown = buildExperimentMarkdown({
        familyKey: family.contract_family_key,
        category: family.contract_category,
        subcategory: family.contract_subcategory,
        metrics,
        insights
      });

      const createResult = await this.repo.createResearchExperiment({
        workspaceId: family.workspace_id,
        familyKey: family.contract_family_key,
        category: family.contract_category,
        subcategory: family.contract_subcategory,
        sampleSize: metrics.sample_size,
        sourceDigest,
        sourceRunIds,
        metricsJson: metrics,
        bodyMarkdown: markdown,
        confidence,
        reviewStatus: "unreviewed"
      });

      if (createResult.created) {
        await this.repo.createResearchFinding({
          experimentId: createResult.experiment.id,
          workspaceId: family.workspace_id,
          findingType: "experiment_summary",
          title: `Finding for ${family.contract_category}${
            family.contract_subcategory ? `/${family.contract_subcategory}` : ""
          }`,
          bodyMarkdown: markdown,
          confidence,
          metadataJson: {
            source_run_count: metrics.sample_size
          }
        });
        created += 1;
      }

      await this.repo.attachIngestionsToExperiment(
        createResult.experiment.id,
        sourceRunIds
      );
    }

    return created;
  }

  async publishLoop(): Promise<number> {
    const accepted = await this.repo.listAcceptedUnpublishedResearchExperiments(50);
    let published = 0;

    for (const experiment of accepted) {
      const synthesizedMemory = await this.buildResearchMemoryDraft(experiment);
      const didPublish = await this.repo.publishAcceptedResearchExperiment(
        experiment.id,
        synthesizedMemory ?? undefined
      );
      if (didPublish) {
        published += 1;
      }
    }

    return published;
  }

  async runCycle(): Promise<ResearchCycleStats> {
    const ingested = await this.ingestLoop();
    const experiments = await this.experimentLoop();
    const published = await this.publishLoop();
    return {
      ingested,
      experiments,
      published
    };
  }

  private readString(config: Record<string, unknown>, key: string, fallback = ""): string {
    const value = config[key];
    return typeof value === "string" ? value : fallback;
  }

  private async resolveLlmConfig(): Promise<LlmConfig | null> {
    const integrationConfigs = await this.repo.listIntegrationConfigs();
    const llmConfig =
      integrationConfigs.find((row) => row.integration_key === "llm_api")?.config_json ?? {};
    const providerModel = resolveLlmProviderAndModel({
      llmConfig,
      env: process.env,
      agentProfile: "researcher"
    });
    const apiKey =
      this.readString(llmConfig, "apiKey", process.env.SALVO_LLM_API_KEY) ||
      this.readString(llmConfig, "authToken", process.env.SALVO_CLAUDE_AUTH_TOKEN);
    const baseUrl = this.readString(llmConfig, "baseUrl", process.env.SALVO_LLM_BASE_URL);

    if (!apiKey || !baseUrl) {
      return null;
    }

    return {
      provider: providerModel.provider,
      apiKey,
      baseUrl,
      model: providerModel.model,
      maxTokens: 900,
      temperature: 0.1
    };
  }

  private async buildResearchMemoryDraft(
    experiment: Awaited<ReturnType<ResearchRepository["listAcceptedUnpublishedResearchExperiments"]>>[number]
  ): Promise<ResearchMemoryDraft | null> {
    const llmConfig = await this.resolveLlmConfig();
    if (!llmConfig) {
      return buildFallbackResearchMemoryDraft(experiment);
    }

    const researchContext = await this.repo.listResearchContext(experiment.workspace_id, 5);
    const memoryContext = await this.repo.listMemoryContext(experiment.workspace_id, 5);

    try {
      const synthesized = await synthesizeResearchMemory({
        experiment,
        researchContext,
        memoryContext,
        llmConfig
      });
      return synthesized ?? buildFallbackResearchMemoryDraft(experiment);
    } catch {
      return buildFallbackResearchMemoryDraft(experiment);
    }
  }
}
