extends Node

const TIMEOUT_SECONDS := 20.0

@onready var _main: GameRoot = $Main
@onready var _client: AgentHostClient = $Main/AgentHostClient
@onready var _controller: CharacterWorkspaceController = $Main/CharacterWorkspaceController
@onready var _world: WorkshopWorld = $Main/WorldRoot/WorkshopWorld
@onready var _actor: PartnerActor = $Main/WorldRoot/WorkshopWorld/PartnerActor
@onready var _selection_layer: Control = $Main/UIRoot/SelectionLayer
@onready var _task_overlay: Control = $Main/UIRoot/TaskOverlay
@onready var _task_panel: TaskPanel = $Main/UIRoot/TaskOverlay/TaskPanel
@onready var _menu: WorkshopMenu = $Main/UIRoot/WorkshopMenu
@onready var _rig: WorkshopCameraRig = $Main/WorldRoot/WorkshopWorld/WorkshopCameraRig
@onready var _camera: Camera2D = $Main/WorldRoot/WorkshopWorld/WorkshopCameraRig/Camera2D

var _phase := "listing"
var _first_session_id := ""

func _ready() -> void:
	# Give the headless display the same aspect ratio as the authored baseline.
	get_window().size = Vector2i(1440, 900)
	var timer := get_tree().create_timer(TIMEOUT_SECONDS)
	timer.timeout.connect(func() -> void: _fail("Timed out verifying Workshop flow"))
	_controller.agents_changed.connect(_on_agents_changed)
	_controller.workspace_changed.connect(_on_workspace_changed)
	_controller.workspace_closed.connect(_on_workspace_closed)
	_controller.error_changed.connect(func(message: String) -> void: _fail(message))

func _on_agents_changed(agents: Array) -> void:
	if _phase != "listing" or agents.size() != 1:
		_fail("Workshop flow received an unexpected Agent list")
		return
	_phase = "opening"
	_controller.select_agent(agents[0]["id"])

func _on_workspace_changed(_agent: Dictionary, session: Dictionary) -> void:
	if _phase == "opening":
		if not _world.is_active() or _selection_layer.visible or _task_overlay.visible:
			_fail("Opening a Session did not enter the world with the task overlay closed")
			return
		_first_session_id = session["sessionId"]
		var traversal: WorkshopTraversalMap = _world.get_node("TraversalMap")
		var workbench: Node2D = _world.get_node("InteractionPoints/WorkbenchInteraction")
		var surface := traversal.middle_surface
		var local_x := surface.to_local(workbench.global_position).x
		_actor.reset_to_spawn(surface.to_global(Vector2(local_x, surface.sample_surface_y(local_x))))
		await _physics_frames(8)
		var sprite: AnimatedSprite2D = _actor.get_node("CharacterVisual")
		var before_left_walk := _actor.global_position
		Input.action_press("move_left")
		await _physics_frames(8)
		Input.action_release("move_left")
		await _physics_frames(12)
		if _actor.global_position.x >= before_left_walk.x - 2.0 or not sprite.flip_h:
			_fail("Facing fixture did not establish left-facing through real movement")
			return
		_rig.snap_to_target()
		# Inspect conversation without starting the separately tested seat approach.
		var unfocused_position := _actor.global_position
		_world.work_inspection_requested.emit()
		if not _task_overlay.visible:
			_fail("Work inspection did not open the task overlay")
			return
		await _settle_camera(true)
		if sprite.flip_h:
			_fail("Conversation idle did not face the same world sprite toward the panel")
			return
		var texture := sprite.sprite_frames.get_frame_texture(sprite.animation, sprite.frame)
		var sprite_rect := sprite.get_global_transform_with_canvas() * Rect2(sprite.offset, texture.get_size())
		if not _actor.global_position.is_equal_approx(unfocused_position) or _camera.zoom.x <= 1.5:
			_fail("Conversation focus moved actor physics or failed to enlarge the real actor")
			return
		if sprite_rect.position.x < 0.0 or sprite_rect.end.x >= _task_panel.get_global_rect().position.x:
			_fail("Focused actor escaped the unobstructed area left of the conversation")
			return
		if _main.get_node("%PartnerHud").visible or _main.get_node("%ConnectionBadge").visible or _menu.visible:
			_fail("Conversation focus kept ordinary Workshop HUD visible")
			return
		_menu.open_requested.emit()
		if _menu.is_open():
			_fail("Workshop menu opened on top of the task overlay")
			return
		var locked_position := _actor.global_position
		Input.action_press("move_right")
		Input.action_press("jump")
		Input.action_press("climb_up")
		await _physics_frames(8)
		_release_inputs()
		if not _actor.global_position.is_equal_approx(locked_position):
			_fail("Task overlay did not lock world movement")
			return
		_task_panel.close_requested.emit()
		if _task_overlay.visible or _controller.current_session()["sessionId"] != _first_session_id:
			_fail("Closing the task overlay changed or closed the active Session")
			return
		await _settle_camera(false)
		if not sprite.flip_h or not _actor.global_position.is_equal_approx(unfocused_position):
			_fail("Closing focus did not restore left-facing without moving the actor")
			return
		if not _camera.zoom.is_equal_approx(Vector2.ONE) or not _main.get_node("%PartnerHud").visible or not _menu.visible:
			_fail("Closing focus did not restore exploration camera and HUD")
			return
		# Interrupt both directions of the camera transition without a stale completion.
		_world.work_inspection_requested.emit()
		_task_panel.set_expanded(true)
		_task_panel.close_requested.emit()
		_world.work_inspection_requested.emit()
		_task_panel.set_expanded(false)
		_task_panel.close_requested.emit()
		await _settle_camera(false)
		if _task_overlay.visible or not _camera.zoom.is_equal_approx(Vector2.ONE) or not _actor.global_position.is_equal_approx(unfocused_position):
			_fail("Rapid focus toggles left stale camera state or changed actor physics")
			return
		var restored_position := _actor.global_position
		Input.action_press("move_right")
		await _physics_frames(8)
		Input.action_release("move_right")
		if _actor.global_position.x <= restored_position.x + 2.0:
			_fail("World movement did not resume after closing the task overlay")
			return
		_world.work_inspection_requested.emit()
		_task_panel.run_requested.emit("wait")
		if _controller.messages().size() != 2 or _controller.messages().back()["status"] != "running":
			_fail("Submitting a task did not create a conversation turn")
			return
		var draft: TextEdit = _task_panel.get_node("%TaskInput")
		draft.text = "next-turn draft"
		_task_panel.set_expanded(true)
		await get_tree().process_frame
		_task_panel.close_requested.emit()
		if _task_overlay.visible or _controller.messages().back()["status"] != "running":
			_fail("Minimizing cancelled the active Run or kept the overlay open")
			return
		var running_position := _actor.global_position
		Input.action_press("move_right")
		await _physics_frames(8)
		Input.action_release("move_right")
		if _actor.global_position.x <= running_position.x + 2.0:
			_fail("Background Run blocked world movement after minimizing")
			return
		_world.work_inspection_requested.emit()
		if not _task_overlay.visible or draft.text != "next-turn draft" or not _task_panel.is_expanded():
			_fail("Reopening a running conversation lost draft, expansion or visibility")
			return
		_task_panel.set_expanded(false)
		_task_panel.cancel_requested.emit()
		while _controller.messages().back()["status"] == "running":
			await get_tree().process_frame
		if _controller.messages().back()["status"] != "cancelled" or _controller.current_session()["sessionId"] != _first_session_id:
			_fail("Explicit Stop did not cancel only the active Run")
			return
		_phase = "creating"
		_task_panel.new_session_requested.emit()
	elif _phase == "creating":
		if session["sessionId"] == _first_session_id:
			_fail("Creating a new task did not replace the Session")
			return
		if not _task_overlay.visible or not _world.is_active():
			_fail("Creating a new Session did not preserve the world and task overlay")
			return
		_phase = "returning"
		_menu.return_to_characters_requested.emit()
	else:
		_fail("Workshop flow received a Session in an unexpected phase")

func _on_workspace_closed() -> void:
	if _phase != "returning":
		_fail("Workshop closed in an unexpected phase")
		return
	if _world.is_active() or not _selection_layer.visible or _task_overlay.visible:
		_fail("Returning to character selection did not fully leave the world")
		return
	_client.shutdown()
	get_tree().quit(0)

func _fail(message: String) -> void:
	printerr(message)
	_release_inputs()
	_client.shutdown()
	get_tree().quit(1)

func _physics_frames(count: int) -> void:
	for _index in range(count):
		await get_tree().physics_frame

func _release_inputs() -> void:
	for action: String in ["move_left", "move_right", "climb_up", "climb_down", "jump"]:
		Input.action_release(action)

func _settle_camera(focused: bool) -> void:
	var previous_position := _rig.global_position
	var previous_zoom := _camera.zoom
	var stable_samples := 0
	for _index in 60:
		await get_tree().create_timer(0.025).timeout
		if _rig.global_position.distance_to(previous_position) < 0.05 and _camera.zoom.distance_to(previous_zoom) < 0.001:
			stable_samples += 1
		else:
			stable_samples = 0
		previous_position = _rig.global_position
		previous_zoom = _camera.zoom
		if stable_samples >= 3 and is_equal_approx(_rig.get_focus_blend(), 1.0 if focused else 0.0):
			return
	_fail("Conversation camera transition did not converge")
