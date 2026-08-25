extends SceneTree

const Protocol := preload("res://src/client/agent_host_protocol.gd")

func _init() -> void:
	var failures: Array[String] = []
	_check_encoding(failures)
	_check_ready(failures)
	_check_results(failures)
	_check_events(failures)
	_check_errors(failures)
	_check_strictness(failures)
	if not failures.is_empty():
		for failure: String in failures:
			printerr(failure)
		quit(1)
		return
	quit(0)

func _check_encoding(failures: Array[String]) -> void:
	var hello: Variant = JSON.parse_string(Protocol.encode_hello("token"))
	if (
		typeof(hello) != TYPE_DICTIONARY
		or hello.get("v") != 1
		or hello.get("type") != "hello"
		or hello.get("token") != "token"
		or hello.size() != 3
	):
		failures.append("hello encoding must preserve Protocol v1 fields")
	var requests := [
		["list_agents", {}],
		["open_session", {"agentId": "coding", "sessionId": "session-1"}],
		["create_session", {"agentId": "coding"}],
		["close_session", {"agentId": "coding", "sessionId": "session-1"}],
		["run", {"agentId": "coding", "sessionId": "session-1", "text": "hello"}],
		["cancel", {"requestId": "run-1"}],
	]
	for index: int in requests.size():
		var request_type: String = requests[index][0]
		var fields: Dictionary = requests[index][1]
		var encoded: Variant = JSON.parse_string(
			Protocol.encode_request("request-%d" % index, request_type, fields)
		)
		if typeof(encoded) != TYPE_DICTIONARY:
			failures.append("%s request encoding must produce an object" % request_type)
			continue
		if encoded.get("v") != 1 or encoded.get("type") != request_type:
			failures.append("%s request encoding must preserve Protocol fields" % request_type)

func _check_ready(failures: Array[String]) -> void:
	_expect_ok(
		Protocol.parse_server_message(
			JSON.stringify({"v": 1, "type": "ready", "connectionId": "connection-1"})
		),
		"ready should parse",
		failures,
	)

func _check_results(failures: Array[String]) -> void:
	_expect_ok(
		Protocol.parse_server_message(
			JSON.stringify(
				{
					"v": 1,
					"type": "result",
					"id": "request-1",
					"result": {
						"kind": "agents",
						"agents": [
							{
								"id": "coding",
								"displayName": "Coding Agent",
								"description": "Codes",
								"packageName": "@omni-agent/agent-coding",
								"packageVersion": "0.0.1",
							}
						],
					},
				}
			)
		),
		"agents result should parse",
		failures,
	)
	_expect_ok(
		Protocol.parse_server_message(
			JSON.stringify(
				{
					"v": 1,
					"type": "result",
					"id": "request-2",
					"result": {
						"kind": "session",
						"session": {"agentId": "coding", "sessionId": "session-1"},
					},
				}
			)
		),
		"session result should parse",
		failures,
	)

func _check_events(failures: Array[String]) -> void:
	for event: Dictionary in [
		{"type": "started", "requestId": "run-1", "sessionId": "session-1"},
		{"type": "text_delta", "text": "hello"},
		{"type": "final_response", "text": "hello"},
		{"type": "completed"},
		{"type": "cancelled"},
		{"type": "failed", "code": "failure", "message": "failed", "retryable": false},
	]:
		_expect_ok(
			Protocol.parse_server_message(
				JSON.stringify({"v": 1, "type": "event", "requestId": "run-1", "event": event})
			),
			"%s event should parse" % event["type"],
			failures,
		)

func _check_errors(failures: Array[String]) -> void:
	_expect_ok(
		Protocol.parse_server_message(
			JSON.stringify(
				{
					"v": 1,
					"type": "error",
					"id": "request-3",
					"error": {
						"code": "agent_model_not_configured",
						"message": "Model is not configured for this Agent",
						"retryable": false,
					},
				}
			)
		),
		"safe service error should parse",
		failures,
	)

func _check_strictness(failures: Array[String]) -> void:
	_expect_failure(
		Protocol.parse_server_message("not-json"),
		"invalid JSON must fail",
		failures,
	)
	_expect_failure(
		Protocol.parse_server_message(
			JSON.stringify(
				{"v": 1, "type": "ready", "connectionId": "connection-1", "extra": true}
			)
		),
		"extra fields must fail",
		failures,
	)
	_expect_failure(
		Protocol.parse_server_message(JSON.stringify({"v": 2, "type": "ready"})),
		"unsupported versions must fail",
		failures,
	)
	_expect_failure(
		Protocol.parse_server_message(
			JSON.stringify(
				{
					"v": 1,
					"type": "error",
					"id": "request-1",
					"error": {
						"code": "failure",
						"message": "failed",
						"retryable": false,
						"stack": "must not cross the boundary",
					},
				}
			)
		),
		"extra failure fields must fail",
		failures,
	)

func _expect_ok(result: Dictionary, message: String, failures: Array[String]) -> void:
	if not result.get("ok", false):
		failures.append(message)

func _expect_failure(result: Dictionary, message: String, failures: Array[String]) -> void:
	if result.get("ok", false):
		failures.append(message)
