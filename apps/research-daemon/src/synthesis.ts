import { createHash } from "node:crypto";
import { createLogger, resolveLlmProviderAndModel } from "@salvo/shared";
import { LlmClient, type LlmConfig } from "@salvo/llm";
import type { DbResearchExperiment } from "@salvo/db";

type ReviewStatus = "unreviewed" | "accepted" | "rejected";

export type ResearchContextItem = {
  id: string;
  source_run_ids: string[];
  confidence: number;
  review_status: ReviewStatus;
};

export type MemoryContextItem = {
  id: string;
  confidence: number;
  review_status: ReviewStatus;
};

export type ResearchMemoryDraft = {
  title: string;
  summary: string;
  bodyMarkdown: string;
  tags: string[];
  confidence: number;
};

const logger = createLogger({
  component: "research-daemon",
  scope: "memory-synthesis"
});

function buildFallbackDraft(experiment: DbResearchExperiment): ResearchMemoryDraft {
  const familyLabel = `${experiment.contract_category}${
    experiment.contract_subcategory ? `/${experiment.contract_subcategory}` : ""
  }`;

  return {
    title: `Research memory: ${familyLabel}`,
    summary: `Synthesized from ${experiment.sample_size} runs for ${experiment.contract_family_key}.`,
    bodyMarkdown: [
      `# Research Memory: ${familyLabel}`,
      "",
      experiment.body_markdown,
      "",
      "## Tags",
      `- family:${experiment.contract_family_key}`,
      `- category:${experiment.contract_category}`,
      `- experiment:${experiment.id}`,
      "",
      "## Confidence",
      experiment.confidence.toFixed(2)
    ].join("\n"),
    tags: [
      "research",
      "memory",
      `experiment:${experiment.id}`,
      `family:${experiment.contract_family_key}`,
      `category:${experiment.contract_category}`
    ],
    confidence: experiment.confidence
  };
}

function cleanJsonText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith("```")) {
    const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/```$/, "");
    return withoutFence.trim();
  }

  return trimmed;
}

function parseDraft(raw: string): ResearchMemoryDraft | null {
  try {
    const parsed = JSON.parse(cleanJsonText(raw)) as Record<string, unknown>;
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    const bodyMarkdown =
      typeof parsed.body_markdown === "string"
        ? parsed.body_markdown.trim()
        : typeof parsed.bodyMarkdown === "string"
          ? parsed.bodyMarkdown.trim()
          : "";
    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean)
      : [];
    const confidence = Number(parsed.confidence ?? NaN);

    if (!title || !summary || !bodyMarkdown || tags.length === 0 || !Number.isFinite(confidence)) {
      return null;
    }

    return {
      title,
      summary,
      bodyMarkdown,
      tags,
      confidence: Math.max(0, Math.min(1, confidence))
    };
  } catch {
    return null;
  }
}

function buildExperimentDigest(experiment: DbResearchExperiment): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        id: experiment.id,
        family: experiment.contract_family_key,
        category: experiment.contract_category,
        subcategory: experiment.contract_subcategory,
        sample_size: experiment.sample_size,
        source_run_ids: experiment.source_run_ids,
        confidence: experiment.confidence
      })
    )
    .digest("hex");
}

export async function synthesizeResearchMemory(input: {
  experiment: DbResearchExperiment;
  researchContext: ResearchContextItem[];
  memoryContext: MemoryContextItem[];
  llmConfig: LlmConfig;
}): Promise<ResearchMemoryDraft | null> {
  const { provider, model } = resolveLlmProviderAndModel({
    llmConfig: input.llmConfig,
    env: process.env,
    agentProfile: "researcher"
  });
  const client = new LlmClient({
    ...input.llmConfig,
    provider,
    model,
    temperature: 0.1,
    maxTokens: 900
  });

  const experimentDigest = buildExperimentDigest(input.experiment);
  const response = await client.createMessage(
    [
      "You synthesize durable research memories for the Salvo memory loop.",
      "Return a strict JSON object with keys: title, summary, body_markdown, tags, confidence.",
      "Use concise, durable language. Do not wrap the JSON in markdown fences.",
      "Set confidence to a number from 0 to 1."
    ].join("\n"),
    [
      {
        role: "user",
        content: JSON.stringify(
          {
            experiment: {
              id: input.experiment.id,
              family_key: input.experiment.contract_family_key,
              category: input.experiment.contract_category,
              subcategory: input.experiment.contract_subcategory,
              sample_size: input.experiment.sample_size,
              confidence: input.experiment.confidence,
              digest: experimentDigest,
              body_markdown: input.experiment.body_markdown
            },
            research_context: input.researchContext,
            memory_context: input.memoryContext
          },
          null,
          2
        )
      }
    ]
  );

  const text = response.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();
  const parsed = parseDraft(text);
  if (parsed) {
    return parsed;
  }

  logger.warn("research synthesis returned malformed payload", {
    experiment_id: input.experiment.id,
    provider,
    model
  });
  return null;
}

export function buildFallbackResearchMemoryDraft(experiment: DbResearchExperiment): ResearchMemoryDraft {
  return buildFallbackDraft(experiment);
}
