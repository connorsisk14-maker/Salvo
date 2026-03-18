export type LeadPipelineTab = {
  name: string;
  description: string;
  columns: string[];
};

export const LEAD_PIPELINE_TABS: LeadPipelineTab[] = [
  {
    name: "Raw Leads",
    description:
      "Initial intake with contact details, assigned agent, priority, and next steps so the automation can know which leads to push into the pipeline.",
    columns: ["Timestamp", "Run ID", "Source", "Company", "Contact Name", "Contact Email", "Service", "Lead Priority", "Assigned Agent", "Status", "Next Steps"]
  },
  {
    name: "Enriched Leads",
    description:
      "Normalized data produced by enrichment skills; use the firmographic tags, revenue band, and guidance fields to help the strategist understand each lead.",
    columns: ["Run ID", "Company", "Industry Tags", "Revenue Band", "Qualifications", "Notes / Action", "Last Updated"]
  },
  {
    name: "Zone Tracking",
    description:
      "Per-zone progress tracker so the fleet can stay ahead of high-priority neighborhoods and avoid duplication.",
    columns: ["Zone Name", "Priority (1=highest)", "Target Zip Codes", "Progress (%)", "Scrapes This Week", "Last Update", "Assigned Strategist"]
  },
  {
    name: "Run History",
    description:
      "Append-only log for strategist and scraper runs; capture artifacts, evaluations, status, and durations for post-mortems.",
    columns: ["Run ID", "Agent Profile", "Contract Family", "Status", "Duration", "Artifacts", "Notes"]
  }
];

export type LeadPipelineZone = {
  name: string;
  priority: number;
  zipCodes: string[];
  focus: string;
};

export const DFW_LEAD_ZONE_CONFIG: LeadPipelineZone[] = [
  { name: "Dallas CBD", priority: 1, zipCodes: ["75201", "75202", "75204"], focus: "High-rise professional services" },
  { name: "Uptown / Turtle Creek", priority: 1, zipCodes: ["75205", "75208"], focus: "Finance + hospitality" },
  { name: "Deep Ellum / Downtown East", priority: 2, zipCodes: ["75226", "75202"], focus: "Boutique consultancies" },
  { name: "Oak Lawn / Victory Park", priority: 2, zipCodes: ["75219", "75202"], focus: "Entertainment / healthcare" },
  { name: "Oak Cliff", priority: 3, zipCodes: ["75203", "75208", "75224"], focus: "Growing small-business corridor" },
  { name: "East Dallas", priority: 3, zipCodes: ["75214", "75218"], focus: "Light manufacturing + services" },
  { name: "North Dallas", priority: 3, zipCodes: ["75225", "75240", "75287"], focus: "Corporate campuses" },
  { name: "Far North Dallas", priority: 4, zipCodes: ["75098", "75243", "75022"], focus: "Suburban retail/service clusters" },
  { name: "Plano", priority: 4, zipCodes: ["75093", "75024", "75025"], focus: "Tech + professional services" },
  { name: "Richardson", priority: 4, zipCodes: ["75080", "75081", "75082"], focus: "Communications + engineering" },
  { name: "Irving", priority: 4, zipCodes: ["75060", "75061", "75039"], focus: "Transportation + logistics" },
  { name: "Las Colinas", priority: 4, zipCodes: ["75039", "75038"], focus: "Corporate campuses" },
  { name: "Garland", priority: 5, zipCodes: ["75040", "75041", "75042"], focus: "Manufacturing" },
  { name: "Carrollton / Addison", priority: 5, zipCodes: ["75006", "75034", "75007"], focus: "Technology + light industrial" },
  { name: "Frisco", priority: 5, zipCodes: ["75033", "75035", "75036"], focus: "Fast-growing residential/office mix" },
  { name: "McKinney", priority: 5, zipCodes: ["75069", "75070", "75071"], focus: "Residential + market resi contractors" },
  { name: "Arlington", priority: 6, zipCodes: ["76010", "76011", "76018"], focus: "Entertainment + healthcare clusters" },
  { name: "Fort Worth East", priority: 6, zipCodes: ["76102", "76112", "76120"], focus: "Aviation + distribution centers" }
];

export type LeadPipelineRangeMap = Record<"rawLeads" | "enrichedLeads" | "zoneTracking" | "runHistory", string>;

export const LEAD_PIPELINE_RANGE_MAP: LeadPipelineRangeMap = {
  rawLeads: "Raw Leads!A1:L",
  enrichedLeads: "Enriched Leads!A1:G",
  zoneTracking: "Zone Tracking!A1:G",
  runHistory: "Run History!A1:G"
};

export const SALVO_LEAD_PIPELINE_SHEET_ID = process.env.SALVO_LEAD_PIPELINE_SHEET_ID ?? "";
