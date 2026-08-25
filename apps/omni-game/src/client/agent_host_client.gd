class_name AgentHostClient
extends Node

signal connection_state_changed(state: ConnectionState)
signal agents_received(request_id: String, agents: Array)
signal session_received(request_id: String, session: Dictionary)
signal session_closed(request_id: String)
signal run_event_received(request_id: String, event: Dictionary)
signal request_failed(request_id: String, failure: Dictionary)
signal transport_failed(failure: Dictionary)

enum ConnectionState { IDLE, CONNECTING, AUTHENTICATING, READY, CLOSING, CLOSED, FAILED }

const AUTHENTICATION_TIMEOUT_MS := 5000
const CONNECTION_TIMEOUT_MS := 5000
const CLOSE_TIMEOUT_MS := 5000
const INBOUND_BUFFER_BYTES := 1024 * 1024
const MAX_QUEUED_PACKETS := 256

var _state := ConnectionState.IDLE
var _socket: WebSocketPeer
var _token := ""
var _connection_deadline := 0
var _authentication_deadline := 0
var _close_deadline := 0
var _request_sequence := 0
var _pending: Dictionary = {}

func connect_to_host(url: String, token: String) -> void:
	if _state != ConnectionState.IDLE:
		_emit_transport_failure("client_invalid_state", "Agent Host Client 已经启动。")
		return
	_socket = WebSocketPeer.new()
	_socket.inbound_buffer_size = INBOUND_BUFFER_BYTES
	_socket.max_queued_packets = MAX_QUEUED_PACKETS
	_token = token
	var result := _socket.connect_to_url(url)
	if result != OK:
		_token = ""
		_fail_transport("connection_failed", "无法连接 Agent Host。")
		return
	_connection_deadline = Time.get_ticks_msec() + CONNECTION_TIMEOUT_MS
	_set_state(ConnectionState.CONNECTING)
	set_process(true)

func list_agents() -> String:
	return _submit("list_agents", {}, "request")

func open_session(agent_id: String, session_id: String = "") -> String:
	var fields := {"agentId": agent_id}
	if not session_id.is_empty():
		fields["sessionId"] = session_id
	return _submit("open_session", fields, "request")

func create_session(agent_id: String) -> String:
	return _submit("create_session", {"agentId": agent_id}, "request")

func close_session(agent_id: String, session_id: String) -> String:
	return _submit(
		"close_session", {"agentId": agent_id, "sessionId": session_id}, "request"
	)

func run(agent_id: String, session_id: String, text: String) -> String:
	return _submit(
		"run", {"agentId": agent_id, "sessionId": session_id, "text": text}, "run"
	)

func cancel_run(run_request_id: String) -> String:
	return _submit("cancel", {"requestId": run_request_id}, "cancel")

func shutdown() -> void:
	if _state in [ConnectionState.CLOSING, ConnectionState.CLOSED]:
		return
	_pending.clear()
	_token = ""
	_begin_close(1000, "Game closing")

func state() -> ConnectionState:
	return _state

func _ready() -> void:
	set_process(false)

func _process(_delta: float) -> void:
	if _socket == null:
		return
	_socket.poll()
	var socket_state := _socket.get_ready_state()
	if _state == ConnectionState.CLOSING:
		if socket_state == WebSocketPeer.STATE_CLOSED:
			_finish_close()
		elif Time.get_ticks_msec() > _close_deadline:
			_socket = null
			_finish_close()
		return

	if _state == ConnectionState.CONNECTING and socket_state == WebSocketPeer.STATE_OPEN:
		_set_state(ConnectionState.AUTHENTICATING)
		_authentication_deadline = Time.get_ticks_msec() + AUTHENTICATION_TIMEOUT_MS
		if _socket.send_text(AgentHostProtocol.encode_hello(_token)) != OK:
			_token = ""
			_fail_transport("authentication_send_failed", "无法发送 Agent Host 认证信息。")
			return
		_token = ""
	elif (
		_state == ConnectionState.CONNECTING
		and Time.get_ticks_msec() > _connection_deadline
	):
		_fail_transport("connection_timeout", "连接 Agent Host 超时，请重新启动游戏。")
		return

	if socket_state == WebSocketPeer.STATE_OPEN:
		_drain_messages()
	elif socket_state == WebSocketPeer.STATE_CLOSED and _state not in [
		ConnectionState.CLOSED, ConnectionState.CLOSING, ConnectionState.FAILED
	]:
		_fail_transport("connection_closed", "Agent Host 连接已关闭，请重新启动游戏。")
		return

	if (
		_state == ConnectionState.AUTHENTICATING
		and Time.get_ticks_msec() > _authentication_deadline
	):
		_fail_transport("authentication_timeout", "Agent Host 认证超时，请重新启动游戏。")

func _drain_messages() -> void:
	while _socket.get_available_packet_count() > 0:
		var packet := _socket.get_packet()
		if not _socket.was_string_packet():
			_fail_transport("binary_message", "Agent Host 返回了不支持的二进制消息。")
			return
		var raw := packet.get_string_from_utf8()
		var parsed := AgentHostProtocol.parse_server_message(raw)
		if not parsed["ok"]:
			_fail_transport(parsed["error"]["code"], parsed["error"]["message"])
			return
		_handle_message(parsed["value"])
		if _state in [ConnectionState.CLOSING, ConnectionState.CLOSED]:
			return

func _handle_message(message: Dictionary) -> void:
	match message["type"]:
		"ready":
			if _state != ConnectionState.AUTHENTICATING:
				_fail_transport("unexpected_ready", "Agent Host 在错误的连接阶段返回 ready。")
				return
			_set_state(ConnectionState.READY)
		"result":
			_handle_result(message)
		"event":
			_handle_event(message)
		"error":
			_handle_error(message)

func _handle_result(message: Dictionary) -> void:
	var request_id: String = message["id"]
	if not _pending.has(request_id):
		_fail_transport("unknown_request", "Agent Host 返回了未知请求结果。")
		return
	var request_type: String = _pending[request_id]
	var result: Dictionary = message["result"]
	if not _result_matches_request(request_type, result["kind"]):
		_fail_transport("mismatched_result", "Agent Host 返回了不匹配的请求结果。")
		return
	_pending.erase(request_id)
	match result["kind"]:
		"agents":
			agents_received.emit(request_id, result["agents"])
		"session":
			session_received.emit(request_id, result["session"])
		"closed":
			session_closed.emit(request_id)
		"cancel_requested":
			pass

func _handle_event(message: Dictionary) -> void:
	var request_id: String = message["requestId"]
	if _pending.get(request_id) != "run":
		_fail_transport("unknown_run", "Agent Host 返回了未知 Run 事件。")
		return
	var event: Dictionary = message["event"]
	run_event_received.emit(request_id, event)
	if event["type"] in ["completed", "failed", "cancelled"]:
		_pending.erase(request_id)

func _handle_error(message: Dictionary) -> void:
	if not message.has("id"):
		_fail_transport(message["error"]["code"], message["error"]["message"])
		return
	var request_id: String = message["id"]
	if not _pending.has(request_id):
		_fail_transport("unknown_request", "Agent Host 返回了未知请求错误。")
		return
	_pending.erase(request_id)
	request_failed.emit(request_id, message["error"])

func _submit(request_type: String, fields: Dictionary, prefix: String) -> String:
	if _state != ConnectionState.READY:
		_emit_transport_failure("client_not_ready", "Agent Host Client 尚未就绪。")
		return ""
	_request_sequence += 1
	var request_id := "%s-%d" % [prefix, _request_sequence]
	if not AgentHostProtocol.valid_request_id(request_id):
		_emit_transport_failure("invalid_request_id", "Client 生成了无效请求 ID。")
		return ""
	_pending[request_id] = request_type
	var send_result := _socket.send_text(
		AgentHostProtocol.encode_request(request_id, request_type, fields)
	)
	if send_result != OK:
		_pending.erase(request_id)
		_emit_transport_failure("request_send_failed", "无法向 Agent Host 发送请求。")
		return ""
	return request_id

func _result_matches_request(request_type: String, result_kind: String) -> bool:
	match request_type:
		"list_agents":
			return result_kind == "agents"
		"open_session", "create_session":
			return result_kind == "session"
		"close_session":
			return result_kind == "closed"
		"cancel":
			return result_kind == "cancel_requested"
		_:
			return false

func _fail_transport(code: String, message: String) -> void:
	if _state in [ConnectionState.FAILED, ConnectionState.CLOSING, ConnectionState.CLOSED]:
		return
	_pending.clear()
	_token = ""
	_set_state(ConnectionState.FAILED)
	_emit_transport_failure(code, message)
	_begin_close(1002, "Client protocol failure")

func _begin_close(code: int, reason: String) -> void:
	_set_state(ConnectionState.CLOSING)
	_close_deadline = Time.get_ticks_msec() + CLOSE_TIMEOUT_MS
	if _socket == null or _socket.get_ready_state() == WebSocketPeer.STATE_CLOSED:
		_finish_close()
		return
	_socket.close(code, reason)
	set_process(true)

func _finish_close() -> void:
	_socket = null
	_set_state(ConnectionState.CLOSED)
	set_process(false)

func _emit_transport_failure(code: String, message: String) -> void:
	transport_failed.emit({"code": code, "message": message, "retryable": false})

func _set_state(next_state: ConnectionState) -> void:
	if _state == next_state:
		return
	_state = next_state
	connection_state_changed.emit(_state)
