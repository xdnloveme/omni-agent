extends Node

class FakeAgentHostClient:
	extends AgentHostClient

	var cancel_calls := 0
	var shutdown_calls := 0
	var last_request_id := ""
	var last_run_id := ""
	var last_cancel_id := ""
	var _sequence := 0

	func _ready() -> void:
		set_process(false)

	func list_agents() -> String:
		last_request_id = _next_id("list")
		return last_request_id

	func open_session(_agent_id: String, _session_id: String = "") -> String:
		last_request_id = _next_id("open")
		return last_request_id

	func create_session(_agent_id: String) -> String:
		last_request_id = _next_id("create")
		return last_request_id

	func close_session(_agent_id: String, _session_id: String) -> String:
		last_request_id = _next_id("close")
		return last_request_id

	func run(_agent_id: String, _session_id: String, _text: String) -> String:
		last_run_id = _next_id("run")
		return last_run_id

	func cancel_run(_run_request_id: String) -> String:
		cancel_calls += 1
		last_cancel_id = _next_id("cancel")
		return last_cancel_id

	func shutdown() -> void:
		shutdown_calls += 1

	func _next_id(prefix: String) -> String:
		_sequence += 1
		return "%s-%d" % [prefix, _sequence]

const FIXTURE_AGENT := {
	"id": "fixture",
	"displayName": "Fixture Agent",
	"description": "Controller lifecycle fixture",
	"packageName": "@omni-agent/fixture",
	"packageVersion": "1.0.0",
}

var _client := FakeAgentHostClient.new()
var _controller := CharacterWorkspaceController.new()
var _workspace_closed_count := 0
var _last_busy := false
var _last_running := false
var _last_cancel_pending := false
var _last_error := ""
var _failed := false
var _accepted_count := 0

func _ready() -> void:
	add_child(_client)
	add_child(_controller)
	_controller.workspace_closed.connect(func() -> void: _workspace_closed_count += 1)
	_controller.busy_changed.connect(func(value: bool) -> void: _last_busy = value)
	_controller.run_state_changed.connect(func(value: bool) -> void: _last_running = value)
	_controller.cancel_state_changed.connect(
		func(value: bool) -> void: _last_cancel_pending = value
	)
	_controller.error_changed.connect(func(value: String) -> void: _last_error = value)
	_controller.configure(_client)
	_controller.submission_accepted.connect(func() -> void: _accepted_count += 1)
	_verify_session_replacement_failure()
	if _failed:
		return
	_verify_cancel_deduplication()
	if _failed:
		return
	_verify_conversation_lifecycle()
	if _failed:
		return
	_verify_mismatched_session_fails_closed()
	if not _failed:
		get_tree().quit(0)

func _verify_session_replacement_failure() -> void:
	_connect_and_list_agents()
	_open_fixture_session("session-1")
	_controller.create_new_session()
	var close_request := _client.last_request_id
	_client.session_closed.emit(close_request)
	var create_request := _client.last_request_id
	_client.request_failed.emit(
		create_request,
		{"code": "create_failed", "message": "Create failed", "retryable": true},
	)
	_expect(_controller.current_session().is_empty(), "Failed replacement kept a Session")
	_expect(_controller.selected_agent().is_empty(), "Failed replacement kept a selected Agent")
	_expect(_workspace_closed_count == 1, "Failed replacement did not leave the workspace")
	_expect(not _last_busy, "Failed replacement left the Controller busy")
	_expect(_last_error == "Create failed", "Failed replacement did not expose its error")

func _verify_cancel_deduplication() -> void:
	_open_fixture_session("session-2")
	_controller.submit_task("wait")
	_expect(_last_running, "Run did not enter the running state")
	_client.run_event_received.emit(_client.last_run_id, {"type": "text_delta", "text": "partial before stopping"})
	_controller.cancel_active_run()
	_controller.cancel_active_run()
	_expect(_client.cancel_calls == 1, "Repeated Cancel submitted more than one request")
	_expect(_last_cancel_pending, "Cancel did not enter the pending state")
	_client.cancel_acknowledged.emit(_client.last_cancel_id, _client.last_run_id)
	_controller.cancel_active_run()
	_expect(_client.cancel_calls == 1, "Acknowledged Cancel allowed a duplicate request")
	_client.run_event_received.emit(_client.last_run_id, {"type": "cancelled"})
	_expect(not _last_running, "Cancelled Run remained active")
	_expect(not _last_cancel_pending, "Cancelled Run kept the pending state")
	_expect(_controller.messages().back()["text"] == "partial before stopping", "Cancellation discarded partial output")

func _verify_mismatched_session_fails_closed() -> void:
	_controller.back_to_characters()
	_client.session_closed.emit(_client.last_request_id)
	_controller.select_agent("fixture")
	_client.session_received.emit(
		_client.last_request_id,
		{"agentId": "wrong-agent", "sessionId": "wrong-session"},
	)
	_expect(_client.shutdown_calls == 1, "Mismatched Session did not close the Client")
	_expect(_controller.current_session().is_empty(), "Mismatched Session became active")
	_expect(_controller.selected_agent().is_empty(), "Mismatched Session kept an Agent")
	_expect(not _last_busy, "Mismatched Session left the Controller busy")

func _verify_conversation_lifecycle() -> void:
	# A cancelled partial reply is still a real turn, never silently discarded.
	var previous := _controller.messages()
	_expect(previous.size() == 2 and previous[1]["status"] == "cancelled", "Cancelled turn was not retained")
	var accepted_before := _accepted_count
	_controller.submit_task("   ")
	_expect(_accepted_count == accepted_before and _controller.messages() == previous, "Rejected empty input altered conversation or consumed a draft")
	_controller.submit_task("second question")
	var run_id := _client.last_run_id
	_controller.submit_task("do not queue a hidden third question")
	_expect(_accepted_count == accepted_before + 1, "Busy submission consumed another draft")
	_client.run_event_received.emit(run_id, {"type": "text_delta", "text": "draft response"})
	_client.run_event_received.emit(run_id, {"type": "final_response", "text": "final response"})
	_client.run_event_received.emit(run_id, {"type": "completed"})
	_expect(_controller.latest_run_status() == &"completed", "Completion status projection was lost")
	var history := _controller.messages()
	_expect(history.size() == 4 and history[0] == previous[0] and history[1] == previous[1], "New Run replaced an earlier turn")
	_expect(history[2]["text"] == "second question" and history[3]["text"] == "final response" and history[3]["status"] == "completed", "Final response duplicated or failed to replace streaming text")
	history[3]["text"] = "consumer mutation"
	_expect(_controller.messages()[3]["text"] == "final response", "Consumer mutated controller-owned conversation")
	_controller.submit_task("third question")
	_client.run_event_received.emit(_client.last_run_id, {"type": "text_delta", "text": "partial retained"})
	_client.run_event_received.emit(_client.last_run_id, {"type": "failed", "code": "fixture_error", "message": "Readable failure", "retryable": false})
	_expect(_controller.latest_run_status() == &"failed", "Failure was projected as successful completion")
	var failed_reply: Dictionary = _controller.messages().back()
	_expect(failed_reply["status"] == "failed" and failed_reply["text"] == "partial retained" and failed_reply["error"] == "Readable failure", "Failed Run lost partial output or failure context")
	var retained_session := _controller.current_session()
	var retained_messages := _controller.messages()
	_controller.create_new_session()
	_client.request_failed.emit(_client.last_request_id, {"code": "close_failed", "message": "Close refused", "retryable": true})
	_expect(_controller.current_session() == retained_session and _controller.messages() == retained_messages and not _last_busy, "Failed close discarded the live Session's conversation")
	_controller.create_new_session()
	_client.session_closed.emit(_client.last_request_id)
	_client.session_received.emit(_client.last_request_id, {"agentId": "fixture", "sessionId": "session-3"})
	_expect(_controller.messages().is_empty(), "New Session inherited another Session's conversation")

func _connect_and_list_agents() -> void:
	_client.connection_state_changed.emit(AgentHostClient.ConnectionState.READY)
	_client.agents_received.emit(_client.last_request_id, [FIXTURE_AGENT])
	_expect(not _last_busy, "Agent listing left the Controller busy")

func _open_fixture_session(session_id: String) -> void:
	_controller.select_agent("fixture")
	_client.session_received.emit(
		_client.last_request_id,
		{"agentId": "fixture", "sessionId": session_id},
	)
	_expect(_controller.current_session().get("sessionId") == session_id, "Session did not open")

func _expect(condition: bool, message: String) -> void:
	if condition or _failed:
		return
	_failed = true
	printerr(message)
	get_tree().quit(1)
