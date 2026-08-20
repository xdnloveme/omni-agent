import { captureHealth, selectedRun } from "./view-model.js";

const state = {
  sessionId: null,
  runId: null,
  run: null,
  replay: [],
  replayCursor: 0,
  spans: [],
  spanCursor: 0,
  spanSequence: 0,
  view: "replay",
  live: null,
};
let renderPending = false;
const byId = (id) => document.getElementById(id);
const json = (value) => JSON.stringify(value, null, 2);
const time = (value) => new Date(value).toLocaleString();

async function request(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error((await response.json()).error || response.statusText);
  return response.json();
}

async function boot() {
  const agent = await request("/api/agent");
  byId("agent").textContent = `${agent.agentId} · ${formatBytes(agent.diskUsage)}`;
  await refreshSessions();
  const discovery = new EventSource("/api/live");
  discovery.onmessage = () => refreshSessions();
}

async function refreshSessions() {
  const sessions = await request("/api/sessions");
  renderList(
    "sessions",
    sessions,
    "sessionId",
    state.sessionId,
    async (session) => {
      state.sessionId = session.sessionId;
      state.runId = null;
      await refreshSessions();
      await refreshRuns();
    },
    (session) => `${session.runs} runs · ${time(session.latestStartedAt)}`,
  );
  if (state.sessionId) await refreshRuns();
}

async function refreshRuns() {
  const runs = await request(`/api/sessions/${state.sessionId}/runs`);
  if (state.runId) {
    const refreshed = selectedRun(state.runId, runs);
    if (refreshed) state.run = refreshed;
  }
  renderList(
    "runs",
    runs,
    "runId",
    state.runId,
    selectRun,
    (run) => `${captureHealth(run) ? "⚠ incomplete · " : ""}${run.status} · ${time(run.startedAt)}`,
  );
  if (state.runId) render();
}

async function selectRun(run) {
  state.runId = run.runId;
  state.run = run;
  const replayPage = await request(
    `/api/runs/${run.runId}/replay?sessionId=${state.sessionId}&limit=1000`,
  );
  state.replay = replayPage.entries.map((entry) => entry.value);
  state.replayCursor = replayPage.cursor;
  const spanSnapshot = await request(`/api/runs/${run.runId}/spans?sessionId=${state.sessionId}`);
  state.spans = spanSnapshot.spans;
  state.spanCursor = spanSnapshot.cursor;
  state.spanSequence = 0;
  state.live?.close();
  state.live = new EventSource(
    `/api/runs/${run.runId}/live?sessionId=${state.sessionId}&cursor=${state.replayCursor}&spanCursor=${state.spanCursor}`,
  );
  state.live.addEventListener("replay", (event) => {
    const record = JSON.parse(event.data);
    if (!state.replay.some((entry) => entry.seq === record.seq)) state.replay.push(record);
    updateLiveCursors(event.lastEventId);
    scheduleRender();
  });
  state.live.addEventListener("span", (event) => {
    const update = JSON.parse(event.data);
    updateLiveCursors(event.lastEventId);
    if (update.record.seq <= state.spanSequence) return;
    state.spanSequence = update.record.seq;
    applySpanRecord(update.record);
    scheduleRender();
  });
  await refreshRuns();
  render();
}

function updateLiveCursors(lastEventId) {
  const [replay, spans] = lastEventId.split(":").map(Number);
  if (Number.isSafeInteger(replay)) state.replayCursor = replay;
  if (Number.isSafeInteger(spans)) state.spanCursor = spans;
}

function applySpanRecord(record) {
  if (record.kind === "span.started") {
    if (state.spans.some((span) => span.spanId === record.identity.spanId)) return;
    state.spans.push({
      spanId: record.identity.spanId,
      ...(record.identity.parentSpanId ? { parentSpanId: record.identity.parentSpanId } : {}),
      name: record.name,
      startedAt: record.timestamp,
      status: "running",
      attributes: { ...record.attributes },
      events: [],
    });
    return;
  }
  const span = state.spans.find((candidate) => candidate.spanId === record.spanId);
  if (!span) return;
  if (record.kind === "span.updated") {
    span.attributes[record.attribute.key] = record.attribute.value;
  } else if (record.kind === "span.event") {
    span.events.push({
      timestamp: record.timestamp,
      name: record.name,
      attributes: record.attributes,
    });
  } else {
    span.completedAt = record.completedAt;
    span.status = record.status;
    if (record.error) span.error = record.error;
  }
}

function scheduleRender() {
  if (renderPending) return;
  renderPending = true;
  requestAnimationFrame(() => {
    renderPending = false;
    render();
  });
}

function renderList(id, entries, key, selected, select, subtitle) {
  const root = byId(id);
  root.replaceChildren(
    ...entries.map((entry) => {
      const button = document.createElement("button");
      button.className = `item ${entry[key] === selected ? "active" : ""}`;
      button.textContent = entry[key];
      const small = document.createElement("small");
      small.textContent = subtitle(entry);
      button.append(small);
      button.onclick = () => select(entry);
      return button;
    }),
  );
}

function render() {
  const health = captureHealth(state.run);
  byId("summary").textContent = state.run
    ? `${state.run.status} · ${state.run.runId} · ${duration(state.run)}`
    : "Select a Session and Run.";
  const warning = byId("capture-warning");
  warning.hidden = !health;
  warning.textContent = health?.message ?? "";
  const content = byId("content");
  if (state.view === "waterfall") return renderWaterfall(content);
  const records =
    state.view === "requests"
      ? state.replay.filter((event) => event.kind === "model.request.captured")
      : state.replay;
  content.replaceChildren(...records.map((record) => eventNode(record, state.view === "raw")));
}

function eventNode(record, raw) {
  const node = document.createElement("div");
  node.className = "event";
  const title = document.createElement("strong");
  title.textContent = record.kind;
  const meta = document.createElement("span");
  meta.className = "meta";
  meta.textContent = `#${record.seq} · ${new Date(record.timestamp).toLocaleTimeString()}`;
  const pre = document.createElement("pre");
  pre.textContent = json(raw ? record : (record.payload ?? record.payloadRef ?? {}));
  if (!raw && record.payloadRef) {
    const ref = record.payloadRef;
    request(
      `/api/runs/${state.runId}/payloads/${ref.payloadId}?sessionId=${state.sessionId}&parts=${ref.parts}`,
    )
      .then((payload) => {
        pre.textContent = json(payload);
      })
      .catch((error) => {
        pre.textContent = `Payload unavailable: ${error.message}`;
      });
  }
  node.append(title, meta, pre);
  return node;
}

function renderWaterfall(root) {
  const start = Math.min(...state.spans.map((span) => span.startedAt), Date.now());
  const finish = Math.max(...state.spans.map((span) => span.completedAt || Date.now()), start + 1);
  root.replaceChildren(
    ...state.spans.map((span) => {
      const node = document.createElement("div");
      node.className = "span";
      const title = document.createElement("strong");
      title.className =
        span.status === "running"
          ? "running"
          : ["error", "denied", "timed_out", "cancelled"].includes(span.status)
            ? "error"
            : "";
      title.textContent = `${"  ".repeat(depth(span))}${span.name}`;
      const meta = document.createElement("span");
      meta.className = "meta";
      meta.textContent =
        span.status === "running" ? "running" : `${span.completedAt - span.startedAt} ms`;
      const bar = document.createElement("div");
      bar.className = "bar";
      bar.style.marginLeft = `${((span.startedAt - start) / (finish - start)) * 70}%`;
      bar.style.width = `${Math.max(1, (((span.completedAt || Date.now()) - span.startedAt) / (finish - start)) * 70)}%`;
      const pre = document.createElement("pre");
      pre.textContent = json(span.attributes);
      node.append(title, meta, bar, pre);
      return node;
    }),
  );
}

function depth(span) {
  let count = 0;
  let current = span;
  while (current.parentSpanId && count < 20) {
    current = state.spans.find((candidate) => candidate.spanId === current.parentSpanId) || {};
    count++;
  }
  return count;
}

function duration(run) {
  return run.completedAt ? `${run.completedAt - run.startedAt} ms` : "active";
}
function formatBytes(bytes) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KiB`;
}

document.querySelectorAll("nav button").forEach((button) => {
  button.onclick = () => {
    document.querySelectorAll("nav button").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    state.view = button.dataset.view;
    render();
  };
});

boot().catch((error) => {
  byId("content").textContent = error.message;
});
