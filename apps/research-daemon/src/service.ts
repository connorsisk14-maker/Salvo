import { createHash } from "node:crypto";
import { ResearchRepository } from "@salvo/db";
import {
  buildExperimentMarkdown,
  deriveExperimentConfidence,
  deriveExperimentMetrics,
  normalizeExperimentSamples
} from "./analysis";

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
      const sourceRunIds = sorted.map((item) => item.run_id);
      const sourceDigest = this.buildSourceDigest(sourceRunIds);
      const markdown = buildExperimentMarkdown({
        familyKey: family.contract_family_key,
        category: family.contract_category,
        subcategory: family.contract_subcategory,
        metrics
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
      const didPublish = await this.repo.publishAcceptedResearchExperiment(experiment.id);
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
}
