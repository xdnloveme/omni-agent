export function renderLarkCard(text: string, title = "Omni Agent"): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: title } },
    elements: [{ tag: "markdown", content: text || "处理中…" }],
  });
}
