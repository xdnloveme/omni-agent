extends Node

@onready var _world: WorkshopWorld = $WorkshopWorld
@onready var _actor: PartnerActor = $WorkshopWorld/PartnerActor
@onready var _rig: WorkshopCameraRig = $WorkshopWorld/WorkshopCameraRig
@onready var _display: GameDisplay = $GameDisplay
@onready var _panel: TaskPanel = $CanvasLayer/TaskPanel
@onready var _menu: WorkshopMenu = $CanvasLayer/WorkshopMenu
var _failed := false

func _ready() -> void:
	var presentation: CharacterPresentation = load("res://resources/characters/coding.tres")
	_world.enter_workspace(presentation)
	_world.set_input_enabled(false)
	_actor.reset_to_spawn(Vector2(1460, 669))
	_panel.show_workspace({}, {"sessionId":"display-fixture"}, presentation)
	_panel.set_messages([{"id":"review", "role":"assistant", "text":"显示验收示例：切换全屏不会更换伙伴、移动角色或清除对话草稿。", "status":"completed"}])
	_panel.presentation_layout_changed.connect(func(rect: Rect2, expanded: bool) -> void:
		_world.set_conversation_focus(_panel.visible, rect, expanded))
	_menu.set_active(true)
	_menu.set_interaction_enabled(true)
	_menu.fullscreen_requested.connect(_display.toggle_fullscreen)
	_display.fullscreen_changed.connect(_menu.set_fullscreen)
	_menu.set_fullscreen(_display.is_fullscreen())
	await _settle()
	_rig.snap_to_target()
	var original_rect := Rect2i(get_window().position, get_window().size)
	for dimensions in [Vector2i(1440,900), Vector2i(1920,1080), Vector2i(1280,800)]:
		get_window().size = dimensions
		await _settle()
		_panel.hide()
		_world.set_conversation_focus(false, Rect2(), false)
		await _settle()
		_check_world_bounds()
		_log_sample("explore-%dx%d" % [dimensions.x, dimensions.y])
		_panel.show()
		_world.set_conversation_focus(true, _panel.get_global_rect(), false)
		await _settle()
		_expect(get_viewport().get_visible_rect().encloses(_panel.get_global_rect()), "Dialog escaped expanded viewport")
		_check_world_bounds()
		_log_sample("focus-%dx%d" % [dimensions.x, dimensions.y])
	get_window().size = original_rect.size
	get_window().position = original_rect.position
	await _settle()
	if DisplayServer.get_name() != "headless":
		await _verify_fullscreen()
	else:
		print("fullscreen_not_exercised: headless display")
	if not _failed:
		print("display_layout_verified")
	get_tree().quit(1 if _failed else 0)

func _verify_fullscreen() -> void:
	var window := get_window()
	var initial := Rect2i(window.position, window.size)
	var foot := _actor.global_position
	var input: TextEdit = _panel.get_node("%TaskInput")
	input.text = "全屏切换保留草稿"
	input.grab_focus()
	var shortcut := InputEventKey.new()
	shortcut.physical_keycode = KEY_F11
	shortcut.pressed = true
	get_viewport().push_input(shortcut, true)
	await _settle()
	_expect(_display.is_fullscreen(), "F11 failed while composer held keyboard focus")
	shortcut.echo = true
	get_viewport().push_input(shortcut, true)
	await _settle()
	_expect(_display.is_fullscreen(), "Repeated key unexpectedly exited fullscreen")
	_expect(_actor.global_position.distance_to(foot) < 0.1, "Display mode moved physical actor")
	_expect(input.text == "全屏切换保留草稿", "Display mode lost the draft")
	_check_world_bounds()
	_log_sample("fullscreen-focus")
	_panel.hide()
	_world.set_conversation_focus(false, Rect2(), false)
	await _settle()
	_log_sample("fullscreen-world")
	_menu.open_menu()
	await _settle()
	_expect(get_viewport().get_visible_rect().encloses(_menu.get_node("%MenuPanel").get_global_rect()), "Fullscreen menu escaped viewport")
	_log_sample("fullscreen-menu")
	_menu.get_node("%FullscreenButton").pressed.emit()
	await _settle()
	_expect(not _display.is_fullscreen(), "Menu failed to exit fullscreen")
	_expect(window.size == initial.size and window.position == initial.position, "Window geometry was not restored")
	print("fullscreen_roundtrip_verified")

func _check_world_bounds() -> void:
	var camera: Camera2D = _rig.get_node("Camera2D")
	var half_view := get_viewport().get_visible_rect().size * 0.5 / camera.zoom
	var view := Rect2(_rig.global_position - half_view, half_view * 2)
	_expect(Rect2(0, 0, 2400, 960).grow(0.1).encloses(view), "Camera exposed unpainted world space")

func _settle() -> void:
	await get_tree().create_timer(0.7).timeout

func _log_sample(label: String) -> void:
	print(JSON.stringify({"sample":label, "window":str(get_window().size), "logical":str(get_viewport().get_visible_rect().size), "mode":get_window().mode}))

func _expect(condition: bool, message: String) -> void:
	if not condition:
		_failed = true
		printerr(message)
