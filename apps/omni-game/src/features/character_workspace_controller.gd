class_name CharacterWorkspaceController
extends Node

signal agents_changed(agents: Array)
signal workspace_changed(agent: Dictionary, session: Dictionary)
signal workspace_closed()
signal transcript_changed(text: String)
signal run_state_changed(running: bool)
signal busy_changed(busy: bool)
signal error_changed(message: String)

const ACTION_LIST := "list"
const ACTION_OPEN := "open"
const ACTION_CREATE := "create"
const ACTION_CLOSE_SWITCH := "close_switch"
const ACTION_CLOSE_CREATE := "close_create"
const ACTION_CLOSE_BACK := "close_back"

var _client: AgentHostClient
var _agents: Array = []
var _selected_agent: Dictionary = {}
var _current_session: Dictionary = {}
var _active_run_id := ""
var _transcript := ""
var _pending_actions: Dictionary = {}
var _busy := false

func configure(client: AgentHostClient) -> void:
	if _client != null:
		return
	_client = client
	_client.connection_state_changed.connect(_on_connection_state_changed)
	_client.agents_received.connect(_on_agents_received)
	_client.session_received.connect(_on_session_received)
	_client.session_closed.connect(_on_session_closed)
	_client.run_event_received.connect(_on_run_event_received)
	_client.request_failed.connect(_on_request_failed)
	_client.transport_failed.connect(_on_transport_failed)

func select_agent(agent_id: String) -> void:
	if _busy or not _active_run_id.is_empty():
		return
	var agent := _find_agent(agent_id)
	if agent.is_empty():
		_set_error("选择的伙伴不可用。")
		return
	if not _current_session.is_empty():
		if _selected_agent.get("id") == agent_id:
			workspace_changed.emit(_selected_agent, _current_session)
			return
		_begin_close(ACTION_CLOSE_SWITCH, agent_id)
		return
	_open_agent(agent)

func create_new_session() -> void:
	if _busy or not _active_run_id.is_empty() or _selected_agent.is_empty():
		return
	if not _current_session.is_empty():
		_begin_close(ACTION_CLOSE_CREATE, _selected_agent["id"])
		return
	_create_session(_selected_agent["id"])

func back_to_characters() -> void:
	if _busy or not _active_run_id.is_empty():
		return
	if _current_session.is_empty():
		workspace_closed.emit()
		return
	_begin_close(ACTION_CLOSE_BACK, "")

func submit_task(text: String) -> void:
	var task := text.strip_edges()
	if _busy or not _active_run_id.is_empty() or _current_session.is_empty():
		return
	if task.is_empty():
		_set_error("请输入要交给伙伴的事情。")
		return
	_transcript = ""
	transcript_changed.emit(_transcript)
	var request_id := _client.run(
		_selected_agent["id"], _current_session["sessionId"], task
	)
	if request_id.is_empty():
		return
	_active_run_id = request_id
	run_state_changed.emit(true)

func cancel_active_run() -> void:
	if _active_run_id.is_empty():
		return
	_client.cancel_run(_active_run_id)

func selected_agent() -> Dictionary:
	return _selected_agent.duplicate(true)

func current_session() -> Dictionary:
	return _current_session.duplicate(true)

func _on_connection_state_changed(state: int) -> void:
	if state != AgentHostClient.ConnectionState.READY:
		return
	var request_id := _client.list_agents()
	if request_id.is_empty():
		return
	_pending_actions[request_id] = {"kind": ACTION_LIST}
	_set_busy(true)

func _on_agents_received(request_id: String, agents: Array) -> void:
	var action := _take_action(request_id)
	if action.get("kind") != ACTION_LIST:
		_set_error("伙伴列表响应与当前操作不匹配。")
		return
	_agents = agents.duplicate(true)
	_set_busy(false)
	agents_changed.emit(_agents)

func _on_session_received(request_id: String, session: Dictionary) -> void:
	var action := _take_action(request_id)
	if action.get("kind") not in [ACTION_OPEN, ACTION_CREATE]:
		_set_error("Session 响应与当前操作不匹配。")
		return
	var agent := _find_agent(session.get("agentId", ""))
	if agent.is_empty():
		_set_error("Session 对应的伙伴不在可用列表中。")
		return
	_selected_agent = agent
	_current_session = session.duplicate(true)
	_transcript = ""
	_set_busy(false)
	transcript_changed.emit(_transcript)
	workspace_changed.emit(_selected_agent, _current_session)

func _on_session_closed(request_id: String) -> void:
	var action := _take_action(request_id)
	_current_session = {}
	match action.get("kind"):
		ACTION_CLOSE_SWITCH:
			var agent := _find_agent(action.get("agent_id", ""))
			if agent.is_empty():
				_set_error("目标伙伴不可用。")
				return
			_open_agent(agent)
		ACTION_CLOSE_CREATE:
			_create_session(action.get("agent_id", ""))
		ACTION_CLOSE_BACK:
			_selected_agent = {}
			_set_busy(false)
			workspace_closed.emit()
		_:
			_set_error("Session 关闭响应与当前操作不匹配。")

func _on_run_event_received(request_id: String, event: Dictionary) -> void:
	if request_id != _active_run_id:
		return
	match event["type"]:
		"text_delta":
			_transcript += event["text"]
			transcript_changed.emit(_transcript)
		"final_response":
			_transcript = event["text"]
			transcript_changed.emit(_transcript)
		"failed":
			_set_error(_failure_message(event))
			_finish_run()
		"completed", "cancelled":
			_finish_run()

func _on_request_failed(request_id: String, failure: Dictionary) -> void:
	_take_action(request_id)
	if request_id == _active_run_id:
		_finish_run()
	_set_busy(false)
	_set_error(_failure_message(failure))

func _on_transport_failed(failure: Dictionary) -> void:
	_pending_actions.clear()
	if not _active_run_id.is_empty():
		_finish_run()
	_set_busy(false)
	_set_error(failure.get("message", "Agent Host 连接失败。"))

func _open_agent(agent: Dictionary) -> void:
	_selected_agent = agent.duplicate(true)
	var request_id := _client.open_session(agent["id"])
	if request_id.is_empty():
		return
	_pending_actions[request_id] = {"kind": ACTION_OPEN, "agent_id": agent["id"]}
	_set_busy(true)

func _create_session(agent_id: String) -> void:
	var request_id := _client.create_session(agent_id)
	if request_id.is_empty():
		return
	_pending_actions[request_id] = {"kind": ACTION_CREATE, "agent_id": agent_id}
	_set_busy(true)

func _begin_close(action_kind: String, target_agent_id: String) -> void:
	var request_id := _client.close_session(
		_selected_agent["id"], _current_session["sessionId"]
	)
	if request_id.is_empty():
		return
	_pending_actions[request_id] = {
		"kind": action_kind,
		"agent_id": target_agent_id,
	}
	_set_busy(true)

func _find_agent(agent_id: String) -> Dictionary:
	for value: Variant in _agents:
		if typeof(value) == TYPE_DICTIONARY and value.get("id") == agent_id:
			return value.duplicate(true)
	return {}

func _take_action(request_id: String) -> Dictionary:
	var action: Dictionary = _pending_actions.get(request_id, {})
	_pending_actions.erase(request_id)
	return action

func _finish_run() -> void:
	_active_run_id = ""
	run_state_changed.emit(false)

func _set_busy(value: bool) -> void:
	if _busy == value:
		return
	_busy = value
	busy_changed.emit(_busy)

func _set_error(message: String) -> void:
	error_changed.emit(message)

func _failure_message(failure: Dictionary) -> String:
	match failure.get("code"):
		"agent_model_not_configured":
			return "请先通过 CLI 为这个伙伴配置模型。"
		"interaction_unavailable":
			return "当前游戏客户端暂不支持这个交互。"
		_:
			return failure.get("message", "操作失败，请重试。")
