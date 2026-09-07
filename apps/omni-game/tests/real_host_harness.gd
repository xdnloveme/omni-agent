extends Node

const TIMEOUT_SECONDS := 20.0

@onready var _client: AgentHostClient = $AgentHostClient

var _phase := "connecting"
var _agent_id := ""
var _session: Dictionary = {}

func _ready() -> void:
	var timer := get_tree().create_timer(TIMEOUT_SECONDS)
	timer.timeout.connect(func() -> void: _fail("Timed out verifying Agent Host Client"))
	_client.connection_state_changed.connect(_on_connection_state_changed)
	_client.agents_received.connect(_on_agents_received)
	_client.session_received.connect(_on_session_received)
	_client.session_closed.connect(_on_session_closed)
	_client.request_failed.connect(
		func(_request_id: String, failure: Dictionary) -> void:
			_fail("Agent Host request failed: %s: %s" % [failure.get("code", "unknown"), failure.get("message", "")])
	)
	_client.transport_failed.connect(
		func(failure: Dictionary) -> void:
			_fail("Agent Host transport failed: %s" % failure.get("code", "unknown"))
	)
	var config_result := HostConnectionConfig.consume_environment()
	if not config_result["ok"]:
		_fail(config_result["error"]["message"])
		return
	var config: HostConnectionConfig = config_result["value"]
	_client.connect_to_host(config.url, config.token)
	config.clear_token()

func _on_connection_state_changed(state: int) -> void:
	if state == AgentHostClient.ConnectionState.READY:
		_phase = "listing"
		_client.list_agents()

func _on_agents_received(_request_id: String, agents: Array) -> void:
	if _phase != "listing" or agents.size() != 2:
		_fail("Agent Host did not return exactly two built-in Agents")
		return
	var ids: Array[String] = []
	for agent: Dictionary in agents:
		ids.append(agent["id"])
	if not ids.has("coding") or not ids.has("financial-analysis"):
		_fail("Agent Host returned unexpected built-in Agents")
		return
	_agent_id = agents[0]["id"]
	_phase = "opening"
	_client.open_session(_agent_id)

func _on_session_received(_request_id: String, session: Dictionary) -> void:
	_session = session
	if _phase == "opening":
		_phase = "closing_opened"
		_client.close_session(_agent_id, _session["sessionId"])
	elif _phase == "creating":
		_phase = "closing_created"
		_client.close_session(_agent_id, _session["sessionId"])
	else:
		_fail("Received a Session in an unexpected verification phase")

func _on_session_closed(_request_id: String) -> void:
	if _phase == "closing_opened":
		_phase = "creating"
		_client.create_session(_agent_id)
	elif _phase == "closing_created":
		_client.shutdown()
		get_tree().quit(0)
	else:
		_fail("Session closed in an unexpected verification phase")

func _fail(message: String) -> void:
	printerr(message)
	_client.shutdown()
	get_tree().quit(1)
