class_name AgentHostProtocol
extends RefCounted

const VERSION := 1
const REQUEST_ID_PATTERN := "^[A-Za-z0-9._:-]{1,128}$"

static func encode_hello(token: String) -> String:
	return JSON.stringify({"v": VERSION, "type": "hello", "token": token})

static func encode_request(request_id: String, request_type: String, fields: Dictionary = {}) -> String:
	var message := {"v": VERSION, "id": request_id, "type": request_type}
	for key: Variant in fields:
		message[key] = fields[key]
	return JSON.stringify(message)

static func parse_server_message(raw: String) -> Dictionary:
	var parser := JSON.new()
	if parser.parse(raw) != OK:
		return _failure("Server returned invalid JSON")
	var message: Variant = parser.data
	if typeof(message) != TYPE_DICTIONARY:
		return _failure("Server message must be an object")
	var object: Dictionary = message
	if object.get("v") != VERSION or typeof(object.get("type")) != TYPE_STRING:
		return _failure("Server message has an unsupported version or type")

	match object["type"]:
		"ready":
			return _parse_ready(object)
		"result":
			return _parse_result(object)
		"event":
			return _parse_event(object)
		"error":
			return _parse_error(object)
		_:
			return _failure("Server message type is unknown")

static func valid_request_id(value: String) -> bool:
	var expression := RegEx.new()
	if expression.compile(REQUEST_ID_PATTERN) != OK:
		return false
	return expression.search(value) != null

static func _parse_ready(object: Dictionary) -> Dictionary:
	if not _exact_keys(object, ["v", "type", "connectionId"]):
		return _failure("ready message has unexpected fields")
	if not _nonempty_string(object.get("connectionId")):
		return _failure("ready connectionId is invalid")
	return _success(object)

static func _parse_result(object: Dictionary) -> Dictionary:
	if not _exact_keys(object, ["v", "type", "id", "result"]):
		return _failure("result message has unexpected fields")
	if not _request_id(object.get("id")) or typeof(object.get("result")) != TYPE_DICTIONARY:
		return _failure("result correlation is invalid")
	var result: Dictionary = object["result"]
	match result.get("kind"):
		"agents":
			if not _exact_keys(result, ["kind", "agents"]) or typeof(result.get("agents")) != TYPE_ARRAY:
				return _failure("agents result is invalid")
			for agent: Variant in result["agents"]:
				if not _valid_agent(agent):
					return _failure("Agent descriptor is invalid")
		"session":
			if not _exact_keys(result, ["kind", "session"]) or not _valid_session(result.get("session")):
				return _failure("session result is invalid")
		"closed":
			if not _exact_keys(result, ["kind"]):
				return _failure("closed result is invalid")
		"cancel_requested":
			if not _exact_keys(result, ["kind", "requestId"]) or not _request_id(result.get("requestId")):
				return _failure("cancel result is invalid")
		_:
			return _failure("result kind is unknown")
	return _success(object)

static func _parse_event(object: Dictionary) -> Dictionary:
	if not _exact_keys(object, ["v", "type", "requestId", "event"]):
		return _failure("event message has unexpected fields")
	if not _request_id(object.get("requestId")) or typeof(object.get("event")) != TYPE_DICTIONARY:
		return _failure("event correlation is invalid")
	var event: Dictionary = object["event"]
	match event.get("type"):
		"started":
			if not _exact_keys(event, ["type", "requestId", "sessionId"]):
				return _failure("started event is invalid")
			if not _request_id(event.get("requestId")) or not _nonempty_string(event.get("sessionId")):
				return _failure("started event fields are invalid")
		"text_delta", "final_response":
			if not _exact_keys(event, ["type", "text"]) or typeof(event.get("text")) != TYPE_STRING:
				return _failure("text event is invalid")
		"completed", "cancelled":
			if not _exact_keys(event, ["type"]):
				return _failure("terminal event is invalid")
		"failed":
			if not _exact_keys(event, ["type", "code", "message", "retryable"]):
				return _failure("failed event is invalid")
			if not _valid_failure(event):
				return _failure("failed event fields are invalid")
		_:
			return _failure("event type is unknown")
	return _success(object)

static func _parse_error(object: Dictionary) -> Dictionary:
	var allowed := ["v", "type", "error"] if not object.has("id") else ["v", "type", "id", "error"]
	if not _exact_keys(object, allowed):
		return _failure("error message has unexpected fields")
	if object.has("id") and not _request_id(object.get("id")):
		return _failure("error correlation is invalid")
	if (
		typeof(object.get("error")) != TYPE_DICTIONARY
		or not _exact_keys(object["error"], ["code", "message", "retryable"])
		or not _valid_failure(object["error"])
	):
		return _failure("error payload is invalid")
	return _success(object)

static func _valid_agent(value: Variant) -> bool:
	if typeof(value) != TYPE_DICTIONARY:
		return false
	var agent: Dictionary = value
	if not _exact_keys(agent, ["id", "displayName", "description", "packageName", "packageVersion"]):
		return false
	return (
		_nonempty_string(agent.get("id"))
		and _nonempty_string(agent.get("displayName"))
		and typeof(agent.get("description")) == TYPE_STRING
		and _nonempty_string(agent.get("packageName"))
		and _nonempty_string(agent.get("packageVersion"))
	)

static func _valid_session(value: Variant) -> bool:
	if typeof(value) != TYPE_DICTIONARY:
		return false
	var session: Dictionary = value
	return (
		_exact_keys(session, ["agentId", "sessionId"])
		and _nonempty_string(session.get("agentId"))
		and _nonempty_string(session.get("sessionId"))
	)

static func _valid_failure(value: Dictionary) -> bool:
	return (
		_nonempty_string(value.get("code"))
		and typeof(value.get("message")) == TYPE_STRING
		and typeof(value.get("retryable")) == TYPE_BOOL
	)

static func _request_id(value: Variant) -> bool:
	return typeof(value) == TYPE_STRING and valid_request_id(value)

static func _nonempty_string(value: Variant) -> bool:
	return typeof(value) == TYPE_STRING and not value.is_empty()

static func _exact_keys(object: Dictionary, expected: Array) -> bool:
	if object.size() != expected.size():
		return false
	for key: Variant in expected:
		if not object.has(key):
			return false
	return true

static func _success(value: Dictionary) -> Dictionary:
	return {"ok": true, "value": value}

static func _failure(message: String) -> Dictionary:
	return {
		"ok": false,
		"error": {"code": "invalid_server_message", "message": message, "retryable": false}
	}
