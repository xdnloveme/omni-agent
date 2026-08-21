import type { ToolBundleDescriptor } from "@omni-agent/app";

// Bundles are explicit ordered conveniences, not discovery rules. Adding a Tool
// to the Catalog never changes a Bundle until this definition is intentionally updated.
export const codingToolBundleDescriptors: readonly ToolBundleDescriptor[] = [
  {
    id: "coding.workspace",
    displayName: "Workspace coding tools",
    description: "Shell, filesystem editing, file discovery and repository search tools.",
    tools: [
      "coding.bash",
      "coding.file-read",
      "coding.file-edit",
      "coding.file-write",
      "coding.glob",
      "coding.grep",
    ],
  },
  {
    id: "research.web",
    displayName: "Web research tools",
    description: "Fetches web resources and searches the public web.",
    tools: ["research.web-fetch", "research.web-search"],
  },
];
