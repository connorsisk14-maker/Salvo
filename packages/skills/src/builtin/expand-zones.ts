import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Skill, SkillExecutionContext, SkillArtifact, SkillEvent } from "../types";

type ZoneDefinition = {
  id: string;
  name: string;
  priority: number;
  zipCodes: string[];
  description: string;
};

type ZoneStateEntry = {
  completed: boolean;
  lastUpdated: string;
};

const INFOLDER = ".salvo";
const STATE_FILE = "dfw-zones.json";

const DFW_ZONES: ZoneDefinition[] = [
  {
    id: "north-dallas",
    name: "North Dallas",
    priority: 1,
    zipCodes: ["75225", "75229", "75230", "75240", "75254"],
    description: "Technology corridor and high-density mixed-use nodes."
  },
  {
    id: "uptown",
    name: "Uptown and Highland Park",
    priority: 1,
    zipCodes: ["75205", "75206", "75214"],
    description: "Premium residential and office cluster."
  },
  {
    id: "downtown-dfw",
    name: "Downtown and Loop",
    priority: 2,
    zipCodes: ["75201", "75202", "75204", "75210"],
    description: "Core options for big-league corporate and hospitality work."
  },
  {
    id: "irving-airport",
    name: "Irving / Airport Belt",
    priority: 2,
    zipCodes: ["75038", "75060", "75061"],
    description: "Logistics/operations corridor centered around DFW Airport."
  },
  {
    id: "west-fort-worth",
    name: "West Fort Worth",
    priority: 3,
    zipCodes: ["76109", "76116", "76102"],
    description: "High-value residential pockets with adjacent small businesses."
  },
  {
    id: "south-dallas",
    name: "South Dallas",
    priority: 3,
    zipCodes: ["75224", "75228", "75237"],
    description: "Emergent zones focused on professional services expansion."
  }
];

type ExpandZonesInput = {
  markComplete?: string[];
  limit?: number;
};

type ZoneSummary = {
  id: string;
  name: string;
  priority: number;
  zipCodes: string[];
  description: string;
  completed: boolean;
  lastUpdated?: string;
};

type ExpandZonesOutput = {
  metro: "dfw";
  zoneCoverage: ZoneSummary[];
  unscrapedZones: ZoneSummary[];
  artifactPath: string;
};

function computeStatePaths(workspacePath: string) {
  const directory = path.join(workspacePath, INFOLDER);
  const file = path.join(directory, STATE_FILE);
  return { directory, file };
}

async function loadState(workspacePath: string): Promise<Record<string, ZoneStateEntry>> {
  const { file } = computeStatePaths(workspacePath);
  try {
    const raw = await readFile(file, "utf8");
    return JSON.parse(raw) as Record<string, ZoneStateEntry>;
  } catch {
    return {};
  }
}

async function saveState(workspacePath: string, state: Record<string, ZoneStateEntry>): Promise<void> {
  const { directory, file } = computeStatePaths(workspacePath);
  await mkdir(directory, { recursive: true });
  await writeFile(file, JSON.stringify(state, null, 2), "utf8");
}

export const expandZonesSkill: Skill<ExpandZonesInput, ExpandZonesOutput> = {
  name: "expand_zones",
  version: "1.0.0",
  description: "Map DFW zones, record completion status, and return unscraped territories for future runs.",
  inputSchema: {
    type: "object",
    properties: {
      markComplete: {
        type: "array",
        items: {
          type: "string"
        }
      },
      limit: {
        type: "integer",
        minimum: 1
      }
    },
    additionalProperties: false
  },
  async execute(input, context) {
    const markComplete = new Set(input.markComplete ?? []);
    const limit = Number.isFinite(input.limit) && input.limit! > 0 ? Math.floor(input.limit!) : 3;
    const targetLimit = Math.min(limit, DFW_ZONES.length);

    const state = await loadState(context.workspacePath);
    const updatedAt = new Date().toISOString();

    const coverage = DFW_ZONES.map((zone) => {
      const existing = state[zone.id];
      const completed = Boolean(existing?.completed) || markComplete.has(zone.id);
      const lastUpdated = completed ? updatedAt : existing?.lastUpdated;
      state[zone.id] = {
        completed,
        lastUpdated: lastUpdated ?? (completed ? updatedAt : undefined)
      };
      return {
        ...zone,
        completed,
        lastUpdated: state[zone.id].lastUpdated
      };
    });

    const unscrapedZones = coverage.filter((zone) => !zone.completed).slice(0, targetLimit);

    await saveState(context.workspacePath, state);

    const statePath = computeStatePaths(context.workspacePath).file;
    const artifact: SkillArtifact = {
      path: statePath,
      artifactType: "json",
      metadata: {
        zones: coverage.length,
        unscraped: unscrapedZones.length
      }
    };

    const events: SkillEvent[] = [
      {
        type: "zones.persisted",
        level: "info",
        payload: {
          workspace: context.workspacePath,
          updatedAt,
          completedCount: coverage.filter((zone) => zone.completed).length
        }
      }
    ];

    return {
      ok: true,
      output: {
        metro: "dfw",
        zoneCoverage: coverage,
        unscrapedZones,
        artifactPath: statePath
      },
      artifacts: [artifact],
      events
    };
  }
};
