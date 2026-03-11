import type { SetupStatus } from "@salvo/core";

export type AdapterHealth = {
  status: SetupStatus;
  detail?: string;
};

export type AdapterRunRequest = {
  runId: string;
  payload: Record<string, unknown>;
};

export type AdapterRunResult = {
  ok: boolean;
  detail: string;
  output?: unknown;
};

export interface Adapter {
  readonly key: string;
  health(): Promise<AdapterHealth>;
  run(request: AdapterRunRequest): Promise<AdapterRunResult>;
}
