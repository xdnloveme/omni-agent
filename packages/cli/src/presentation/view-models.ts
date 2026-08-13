export interface DisclosureViewModel {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly state: "running" | "completed" | "failed" | "cancelled";
  readonly startedAt?: number;
  readonly tone: "neutral" | "success" | "warning" | "error";
  readonly details: () => readonly string[];
  readonly initiallyExpanded: boolean;
}

export interface RunMetricsViewModel {
  readonly full: string;
  readonly compact: string;
  readonly minimal: string;
  readonly usagePercent: number;
}
