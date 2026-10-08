extends Node

const TIMEOUT_SECONDS := 20.0

@onready var _client: AgentHostClient = $AgentHostClient

var _phase := "connecting"
var _complete_events: Array[String] = []

func _ready() -> void:
	var timer := get_tree().create_timer(TIMEOUT_SECONDS)
	timer.timeout.connect(func() -> void: _fail("Timed out verifying AgentHostClient lifecycle"))
	_client.connection_state_changed.connect(_on_connection_state_changed)
	_client.run_event_received.connect(_on_run_event_received)
	_client.request_failed.connect(
		func(_request_id: String, failure: Dictionary) -> void:
			_fail("AgentHostClient request failed: %s" % failure.get("code", "unknown"))
	)
	_client.transport_failed.connect(
		func(failure: Dictionary) -> void:
			_fail("AgentHostClient transport failed: %s" % failure.get("code", "unknown"))
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
		_phase = "complete_run"
		_client.run("fixture", "fixture-session", "complete")
	elif state == AgentHostClient.ConnectionState.CLOSED and _phase == "closing":
		get_tree().quit(0)

func _on_run_event_received(request_id: String, event: Dictionary) -> void:
	if _phase == "complete_run":
		_complete_events.append(event["type"])
		if event["type"] == "completed":
			if _complete_events != ["started", "text_delta", "final_response", "completed"]:
				_fail("Completed Run events were not delivered in Protocol order")
				return
			_phase = "cancel_run"
			_client.run("fixture", "fixture-session", "cancel")
	elif _phase == "cancel_run":
		if event["type"] == "started":
			_client.cancel_run(request_id)
		elif event["type"] == "cancelled":
			_phase = "closing"
			_client.shutdown()
		elif event["type"] in ["completed", "failed"]:
			_fail("Cancelled Run produced the wrong terminal event")

func _fail(message: String) -> void:
	printerr(message)
	_client.shutdown()
	get_tree().quit(1)
