# In-world Agent conversation

## Approved scope

The conversation stays in the existing Workshop. A single TaskPanel has a right-side normal
layout and a centered expanded layout; it never loads another world or changes the actor's
physical position, sprite scale or character identity. The camera now brings the real partner
closer in the normal conversation view, with a restrained reading-first composition when expanded.
The visual treatment follows the approved V2 proposal: thin wood, quiet ivory paper, dark brown
type, restrained olive status and an orange send action. The frozen character dossier is unchanged.

## Ownership and lifecycle

- CharacterWorkspaceController owns the current open Session's ordered messages. Accepted Run
  requests append one user message and one assistant response. Deltas update that response;
  final_response replaces only its streaming text. Completion, cancellation and failure remain
  attached to the response, including partial text and safe failure messages.
- This is an in-memory view of turns received while the Session is open, not a persistent
  history or replay service. Protocol v2 does not return historical messages, tools, file changes,
  screenshots or project metadata. Do not invent the proposal's illustrative tool/file controls.
- TaskPanel owns only presentation: draft, expansion, focus and reading position. Accepted
  submission clears the sent draft; rejected input never does. While a Run executes the next
  draft is editable, but there is no implicit queue or interrupting send.
- GameRoot owns overlay exclusivity and world input. Opening blocks movement. Closing or
  minimizing hides the conversation and restores movement, without cancelling the Run or
  closing its Session. Reopening uses the same panel and same state. Explicit Stop is the only
  conversation control that requests Run cancellation. Changing Session remains unavailable
  until the current Run ends.
- Leaving the work seat after minimizing is a local actor transition, not a Run transition.
  A projected, animated workbench badge stays visible during background execution. Clicking
  it reopens the same TaskPanel without initiating furniture approach or moving the actor.
  The normal nearby workbench interaction still supports sitting down. Large interaction
  prompts dismiss on activation; toggling overlay visibility alone must not resurrect them.
- TaskPanel emits its viewport-space rectangle and expansion state as presentation intent only.
  GameRoot combines this with its authoritative overlay state and calls WorkshopWorld's
  conversation-focus API. WorkshopCameraRig owns the cancellable zoom/pan transition and focus
  blend; WorkshopWorld uses that blend for restrained world-only tone. UI never accesses a camera
  or moves the actor. Closing restores exploration composition, including when an earlier camera
  transition was interrupted by rapid opening, expansion or resizing.
- PartnerAnimator selects the existing inspection idle while the focused actor is idle, on the
  same world sprite. Closing restores exploration idle. This does not replace the character,
  change the sprite's authored scale or foot anchor, or give the animator authority over physics.
- Ordinary partner HUD, movement hints and menu controls are hidden while the conversation is
  open and restored when it closes. Connection failures remain visible. This visual focus has no
  authority over Agent requests, Sessions or Runs.
- Replacing the Session clears its messages and UI draft. A failed request to close the existing
  Session must not discard its conversation. Transport/session loss follows the existing
  fail-closed lifecycle, with no invented reconnect/replay path.

## Layout and reading

Normal width is approximately 650 logical pixels; expanded width uses more of the viewport.
Both keep safe margins and a visible bottom composer. The central scroll area receives remaining
height, not the composer. Message headers distinguish users and assistants, and each assistant
turn groups its response and status. Long content wraps inside the message area.

The V2 visual alignment uses compact right-aligned sand cards for user messages, with the
speaker name inside the card. HBox stretch ratios allocate roughly 55–60% of the reading width;
no width-derived minimum sizes may feed back into the window's minimum width. Assistant names
and body text share an inset beside a 36-pixel framed existing portrait. The header reuses the
same portrait at 64 pixels. Body text is 18 pixels, names 18 and section headings 20.

Session identity and actual Run status share a quiet bordered information strip. The status
is projected only from controller-supplied run flags and the latest assistant message outcome.
The input and its hint/send/stop row belong to one paper composer card, not two detached
regions. Scroll tracks use thin warm lines within a wider interactive area. These refinements
do not change the scene, character identity, frozen dossier assets or lifecycle ownership.

The three quick actions only insert editable prompt templates into the composer; they never start
a Run, synthesize progress, or bypass the Controller.

The viewport follows new output only while the reader is at the end. Scrolling upward preserves
the reading position and exposes a new-content affordance. Resizing uses a visible-message anchor
so line wrapping does not jump to a different conversation turn. Hiding/reopening preserves
the draft, expansion mode and reading context. State indicators include words, not color alone.

For multiline tasks and Chinese IME safety, the implementation uses Ctrl/Command + Enter to
send; plain Enter inserts a newline. This intentionally differs from the illustrative proposal's
Enter-to-send caption and is shown in the actual composer. Supported assistant text formatting
is headings, fenced/inline code, bold and simple lists, not a complete Markdown browser.
Untrusted content is inserted as text rather than parsed as Godot BBCode.

## Acceptance

1. Two accepted Runs retain both user questions and both responses in order.
2. Final output replaces streamed text without duplicating or losing preceding turns.
3. Minimize during a Run restores world movement and does not send cancellation.
4. Reopen and resize retain the same Session, draft and reading context.
5. Explicit Stop cancels once and retains partial output; failure is visibly distinguished.
6. Creating a new Session does not inherit the preceding Session's messages or draft.
7. Keyboard input remains in the conversation while open; a hidden panel cannot capture it.
8. Ordinary and expanded layouts remain inside the viewport, with input and stop controls visible.
9. Normal focus enlarges the existing actor in the unobstructed area left of the panel without
   changing its physical position; closing returns camera zoom to exploration scale.
10. Interrupted opening/closing/expansion transitions converge to the latest overlay state.

Behavioral acceptance uses the existing Controller, TaskPanel, and WorkshopFlow harnesses.
For commands, graphical Main capture, and verification limits, see
[the workshop verification guide](godot-workshop-environment.md#verification).
