extends Node
## Real Host protocol and consent broker; Main owns modal and world input state.
@onready var main: GameRoot = $Main
@onready var client: AgentHostClient = $Main/AgentHostClient
@onready var controller: CharacterWorkspaceController = $Main/CharacterWorkspaceController
@onready var world: WorkshopWorld = $Main/WorldRoot/WorkshopWorld
@onready var actor: PartnerActor = $Main/WorldRoot/WorkshopWorld/PartnerActor
@onready var permission: PermissionPanel = $Main/UIRoot/PermissionOverlay/PermissionPanel
@onready var overlay: Control = $Main/UIRoot/PermissionOverlay
@onready var task: Control = $Main/UIRoot/TaskOverlay

var _decision_failures: Array[Dictionary] = []

func _ready() -> void:
	get_window().size = Vector2i(1440, 900)
	get_tree().create_timer(20).timeout.connect(func() -> void: _fail("Permission flow timed out"))
	controller.error_changed.connect(_fail)
	controller.agents_changed.connect(_verify, CONNECT_ONE_SHOT)
	client.permission_decision_failed.connect(func(id: String, failure: Dictionary) -> void:
		_decision_failures.append({"id": id, "code": failure["code"]}))

func _verify(agents: Array) -> void:
	controller.select_agent(agents[0]["id"])
	await controller.workspace_changed
	await _frames(8)
	var session: String = controller.current_session()["sessionId"]
	for from_task in [true, false]:
		if from_task: world.interaction_requested.emit(&"workbench")
		controller.submit_task("permissions")
		await _wait_permissions()
		var position := actor.global_position
		Input.action_press("move_right")
		Input.action_press("jump")
		await _frames(8)
		Input.action_release("move_right")
		Input.action_release("jump")
		_check(overlay.visible and not task.visible, "Permission must exclusively own the overlay")
		_check(actor.global_position.is_equal_approx(position), "Permission must lock physical input")
		_check(permission.get_node("%PermissionResources").text.contains("/fixture/first"), "Concurrent permission order changed")
		await _press(permission.get_node("Content/Actions/Approve"))
		while not permission.get_node("%PermissionResources").text.contains("/fixture/second"):
			await get_tree().process_frame
		_check(overlay.visible and not task.visible, "Resolving one request closed another pending permission")
		await _press(permission.get_node("Content/Actions/Deny"))
		while controller.latest_run_status() == &"running": await get_tree().process_frame
		_check(not overlay.visible and task.visible == from_task, "Permission did not restore the previous overlay")
		_check(controller.current_session()["sessionId"] == session, "Permission changed Session")
		_check(controller.messages().back()["text"] == "approve,deny", "Consent decisions lost correlation")
		if from_task: main.get_node("%TaskPanel").close_requested.emit()
	# Cancellation settles every queued permission without retaining a modal.
	controller.submit_task("permissions")
	await _wait_permissions()
	controller.cancel_active_run()
	while controller.latest_run_status() == &"running" or overlay.visible: await get_tree().process_frame
	_check(not permission.has_pending_requests(), "Cancelled Run retained permission UI")
	# The real broker settles while the decision is in flight. Its error belongs
	# to the permission, not the Controller's Session/Run request lifecycle.
	controller.submit_task("permission-race")
	var requested: Dictionary = await client.permission_requested
	await _wait_permissions()
	var permission_id: String = requested["permissionId"]
	await _press(permission.get_node("Content/Actions/Approve"))
	while _decision_failures.is_empty() or controller.latest_run_status() == &"running":
		await get_tree().process_frame
	_check(_decision_failures == [{"id": permission_id, "code": "request_not_active"}], "Late decision error lost permission correlation")
	_check(client.state() == AgentHostClient.ConnectionState.READY, "Late decision disconnected Host")
	_check(controller.current_session().get("sessionId") == session, "Late decision discarded Session")
	_check(not overlay.visible and not permission.has_pending_requests(), "Late decision retained permission UI")
	controller.submit_task("complete")
	while controller.latest_run_status() == &"running": await get_tree().process_frame
	_check(controller.messages().back()["text"] == "complete", "Session could not run after late decision")
	# Transport shutdown must clear the same queue and unlock the UI owner.
	controller.submit_task("permissions")
	await _wait_permissions()
	client.shutdown()
	while client.state() != AgentHostClient.ConnectionState.CLOSED: await get_tree().process_frame
	_check(not overlay.visible and not permission.has_pending_requests(), "Disconnect retained permission UI")
	print("permission_flow_verified: correlated approve/deny, queue, overlay restore, input lock, cancel, late decision preserves Session, subsequent Run, disconnect")
	get_tree().quit(0)

func _wait_permissions() -> void:
	while not overlay.visible: await get_tree().process_frame
	await _frames(3)

func _press(button: Button) -> void:
	button.grab_focus()
	for pressed in [true, false]:
		var event := InputEventAction.new()
		event.action = &"ui_accept"
		event.pressed = pressed
		get_viewport().push_input(event, true)
	await _frames(2)

func _frames(count: int) -> void:
	for index in range(count): await get_tree().physics_frame

func _check(condition: bool, message: String) -> void:
	if not condition: _fail(message)

func _fail(message: String) -> void:
	push_error(message)
	get_tree().quit(1)
