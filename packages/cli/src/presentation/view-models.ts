export interface DisclosureViewModel {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly state: "waiting" | "running" | "completed" | "failed" | "cancelled";
  readonly startedAt?: number;
  readonly tone: "neutral" | "success" | "warning" | "error";
  readonly details: () => readonly string[];
  readonly initiallyExpanded: boolean;
  readonly children?: readonly DisclosureViewModel[];
}

export interface RunMetricsViewModel {
  readonly full: string;
  readonly compact: string;
  readonly minimal: string;
  readonly usagePercent: number;
}
