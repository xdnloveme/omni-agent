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

export type RunPresentationNode =
  | {
      readonly id: string;
      readonly kind: "text";
      readonly modelCallId: string;
      readonly textSegmentId: string;
      readonly markdown: string;
    }
  | {
      readonly id: string;
      readonly kind: "disclosure";
      readonly disclosure: DisclosureViewModel;
    }
  | {
      readonly id: string;
      readonly kind: "plain";
      readonly text: string;
    }
  | {
      readonly id: string;
      readonly kind: "spacer";
    };

export interface RunPresentationViewModel {
  readonly id: string;
  readonly processNodes: readonly RunPresentationNode[];
  readonly finalNode?: Extract<RunPresentationNode, { kind: "text" }>;
  readonly metrics?: RunMetricsViewModel;
  readonly state: "running" | "completed" | "failed" | "cancelled";
  readonly startedAt: number;
  readonly completedAt?: number;
}

export type SessionHistoryEntryViewModel =
  | { readonly type: "user"; readonly text: string }
  | { readonly type: "run"; readonly run: RunPresentationViewModel };

export interface SessionHistoryViewModel {
  readonly header?: {
    readonly title: string;
    readonly subtitle: string;
  };
  readonly entries: readonly SessionHistoryEntryViewModel[];
  readonly hiddenTurnCount: number;
  readonly loadEarlierLabel?: string;
  readonly resumedDivider: string;
}
