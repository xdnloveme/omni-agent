extends Node

const TIMEOUT_SECONDS := 20.0

@onready var _main: GameRoot = $Main
@onready var _client: AgentHostClient = $Main/AgentHostClient
@onready var _controller: CharacterWorkspaceController = $Main/CharacterWorkspaceController
@onready var _world: WorkshopWorld = $Main/WorldRoot/WorkshopWorld
@onready var _actor: PartnerActor = $Main/WorldRoot/WorkshopWorld/PartnerActor
@onready var _task_overlay: Control = $Main/UIRoot/TaskOverlay
@onready var _menu: WorkshopMenu = $Main/UIRoot/WorkshopMenu
@onready var _partner_hud: Control = $Main/UIRoot/PartnerHud
@onready var _partner_button: TextureButton = $Main/UIRoot/PartnerHud/Margin/Row/PartnerButton
@onready var _info: CharacterInfoPanel = $Main/UIRoot/CharacterInfoPanel
@onready var _role_title: Label = _info.get_node("%RoleTitle")
@onready var _status_summary: Label = _info.get_node("%StatusSummary")
@onready var _preview: CharacterPreview = _info.get_node("%CharacterPreview")

var _phase := "listing"

func _ready() -> void:
	var timer := get_tree().create_timer(TIMEOUT_SECONDS)
	timer.timeout.connect(func() -> void: _fail("Timed out verifying character information"))
	_controller.agents_changed.connect(_on_agents_changed)
	_controller.workspace_changed.connect(_on_workspace_changed)
	_controller.error_changed.connect(func(message: String) -> void: _fail(message))

func _on_agents_changed(agents: Array) -> void:
	if _phase != "listing" or agents.size() != 1:
		_fail("Character information received an unexpected Agent list")
		return
	_phase = "opening"
	_controller.select_agent(agents[0]["id"])

func _on_workspace_changed(_agent: Dictionary, _session: Dictionary) -> void:
	if _phase != "opening":
		_fail("Character information received a Session in an unexpected phase")
		return
	_phase = "verifying"
	await get_tree().process_frame
	var original_session := _controller.current_session().duplicate(true)
	var original_position := _actor.global_position
	if not _partner_hud.size.is_equal_approx(Vector2(342, 108)):
		_fail("Partner HUD exceeded its fixed visual budget: %s" % _partner_hud.size)
		return
	if not _partner_button.size.is_equal_approx(Vector2(72, 72)):
		_fail("Partner portrait changed the compact HUD layout: %s" % _partner_button.size)
		return

	_send_action("inspect_character")
	# Measure the composed window after its entrance/layout, not the temporary
	# minimum propagated while Godot is still wrapping newly assigned text.
	await get_tree().create_timer(CharacterInfoPanel.ENTER_DURATION).timeout
	if not _info.is_open() or _task_overlay.visible or _menu.is_open():
		_fail("P did not open character information as the only overlay")
		return
	if not _info.size.is_equal_approx(Vector2(750, 690)):
		_fail("Character information did not keep its 750x690 design size: %s" % _info.size)
		return
	if _role_title.text != "伙伴":
		_fail("Unknown Agent did not use the presentation fallback")
		return
	var coding_set: CharacterAnimationSet = load("res://resources/characters/coding-animation-set.tres")
	if _info.get_node("%DisplayName").text != _controller.selected_agent()["displayName"]:
		_fail("Shared mage artwork replaced the unknown Agent's identity")
		return
	if _preview.sprite.sprite_frames != coding_set.frames:
		_fail("Character preview does not reuse the existing character animation resource")
		return
	if coding_set.frames.get_frame_count(&"idle") != 8 or coding_set.inspection_animation != &"idle":
		_fail("Inspection must reuse the production mage's eight-frame idle")
		return
	await get_tree().process_frame
	var foot_position := _preview.sprite.position
	var observed_frames: Array[int] = []
	var observe_frame := func() -> void: observed_frames.append(_preview.sprite.frame)
	_preview.sprite.frame_changed.connect(observe_frame)
	await get_tree().create_timer(3.6).timeout
	_preview.sprite.frame_changed.disconnect(observe_frame)
	if not observed_frames.has(5) or not _preview.sprite.is_playing():
		_fail("Character inspection idle did not reach its authored blink frame")
		return
	if _preview.sprite.position != foot_position or not is_equal_approx(_preview.sprite.scale.x, _preview.sprite.scale.y):
		_fail("Character preview distorted proportions or moved its foot anchor")
		return
	var technical_toggle: Button = _info.get_node("%TechnicalToggle")
	var preview_rect := _preview.get_global_rect()
	technical_toggle.button_pressed = true
	await get_tree().process_frame
	await get_tree().process_frame
	if _preview.get_global_rect() != preview_rect or not _info.size.is_equal_approx(Vector2(750, 690)):
		_fail("Technical disclosure moved the character stage or resized the authored panel")
		return
	if not _info.get_node("%TechnicalDetails").visible or _info.get_node("%StateSummary").visible or not _info.get_node("%BuildTab").disabled:
		_fail("Technical disclosure or unopened Build boundary is invalid")
		return
	_info.set_runtime_state(false, true, false)
	if _status_summary.text != "工作中":
		_fail("Running state did not map to visible text")
		return
	_info.set_runtime_state(false, true, true)
	if _status_summary.text != "正在取消":
		_fail("Cancelling state did not take priority over running")
		return
	technical_toggle.button_pressed = false
	if _info.get_node("%TechnicalDetails").visible or not _info.get_node("%StateSummary").visible or _info.get_node("%ProfileRuntimeStatus").text != "正在取消":
		_fail("Returning from technical details did not restore the live state summary")
		return
	_info.set_runtime_state(false, false, false)

	_info.position = Vector2(3000, 2000)
	_info._clamp_to_viewport()
	var viewport_size := get_viewport().get_visible_rect().size
	if (
		_info.position.x > viewport_size.x - _info.size.x - 15.9
		or _info.position.y > viewport_size.y - _info.size.y - 15.9
	):
		_fail("Character information could be dragged outside the safe viewport")
		return

	_send_action("inspect_character")
	if _info.is_open():
		_fail("P did not close character information")
		return
	if _preview.sprite.is_playing():
		_fail("Hidden character preview kept its animation running")
		return
	var click := InputEventMouseButton.new()
	click.button_index = MOUSE_BUTTON_LEFT
	click.pressed = true
	_actor._input_event(get_viewport(), click, 0)
	if not _info.is_open():
		_fail("Clicking the partner did not open character information")
		return
	_info.close_requested.emit()
	_partner_button.pressed.emit()
	if not _info.is_open():
		_fail("Clicking the HUD portrait did not open character information")
		return
	_info.close_requested.emit()

	_world.interaction_requested.emit(&"workbench")
	_send_action("inspect_character")
	if not _task_overlay.visible or _info.is_open():
		_fail("Character information opened on top of the task overlay")
		return
	_send_action("ui_cancel")
	_menu.open_requested.emit()
	if not _menu.is_open() or _info.is_open() or _task_overlay.visible:
		_fail("Menu was not the only active overlay")
		return
	_send_action("ui_cancel")

	if _controller.current_session() != original_session:
		_fail("Opening character information changed the active Session")
		return
	if not _actor.global_position.is_equal_approx(original_position):
		_fail("Opening character information changed the partner position")
		return
	_client.shutdown()
	get_tree().quit(0)

func _send_action(action: String) -> void:
	var event := InputEventAction.new()
	event.action = action
	event.pressed = true
	_main._unhandled_input(event)

func _fail(message: String) -> void:
	printerr(message)
	_client.shutdown()
	get_tree().quit(1)
