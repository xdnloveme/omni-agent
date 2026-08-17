export interface DisclosureViewModel {
  readonly id: string;
  readonly title: string;
  readonly summary?: string;
  readonly state: "waiting" | "running" | "completed" | "failed" | "cancelled";
  readonly startedAt?: number;
  readonly tone: "neutral" | "success" | "warning" | "error";
  readonly details: () => readonly string[];
  readonly initiallyExpanded: boolean;
  readonly collapseOnComplete?: boolean;
  readonly children?: readonly DisclosureViewModel[];
}

export interface RunMetricsViewModel {
  readonly full: string;
  readonly compact: string;
  readonly minimal: string;
  readonly usagePercent: number;
}

export type ConversationHistoryEntryViewModel =
  | { readonly type: "user"; readonly text: string }
  | { readonly type: "assistant"; readonly markdown: string }
  | { readonly type: "disclosure"; readonly disclosure: DisclosureViewModel };

export interface SessionHistoryViewModel {
  readonly header?: {
    readonly title: string;
    readonly subtitle: string;
  };
  readonly entries: readonly ConversationHistoryEntryViewModel[];
  readonly hiddenTurnCount: number;
  readonly loadEarlierLabel?: string;
  readonly resumedDivider: string;
}
