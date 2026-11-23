extends Node
## Actual Main and authenticated Host; UI selection must not create a Session.
@onready var _main: GameRoot = $Main
@onready var _controller: CharacterWorkspaceController = $Main/CharacterWorkspaceController
@onready var _panel: CharacterSelectionPanel = $Main/UIRoot/SelectionLayer/CharacterSelectionPanel
var _failed := false
var _entered := 0
const EVIDENCE := "res://tests/evidence/character-selection/"

func _ready() -> void:
	get_tree().create_timer(60).timeout.connect(func() -> void: _fail("Selection verification timed out"))
	_controller.agents_changed.connect(_verify, CONNECT_ONE_SHOT)
	_controller.error_changed.connect(_fail)
	_controller.workspace_changed.connect(func(_agent: Dictionary, _session: Dictionary) -> void: _entered += 1)

func _verify(agents: Array) -> void:
	if agents.size() != 2: return _fail("Expected two real presentation IDs from fixture Host")
	get_window().size = Vector2i(1440, 900)
	await get_tree().create_timer(0.5).timeout
	var stage: Control = _panel.get_node("Stage")
	if _panel.selected_agent_id() != "coding" or not _controller.current_session().is_empty():
		return _fail("Default highlight must not open a Session")
	await _capture("selection-windowed")
	var before := await _frame()
	await get_tree().create_timer(2).timeout
	var after := await _frame()
	var sky := Rect2i(stage.get_global_transform_with_canvas() * Vector2(1250, 140), Vector2(260, 200) * stage.scale)
	if before.get_region(sky).get_data() == after.get_region(sky).get_data():
		return _fail("Cloud sky region did not change between real frames")
	# The workshop window is a real sky opening, not opaque wood. Sample the trunk.
	var wood := Rect2i(stage.get_global_transform_with_canvas() * Vector2(750, 215), Vector2(70, 80) * stage.scale)
	if before.get_region(wood).get_data() != after.get_region(wood).get_data():
		return _fail("Cloud animation leaked over opaque workshop wood")
	await _capture("selection-clouds-later")
	# A native pointer move may arrive on the next frame. The test click must
	# submit its complete gesture before yielding to unrelated desktop input.
	var outside_motion := InputEventMouseMotion.new()
	outside_motion.position = Vector2(2, 2)
	get_tree().process_frame.connect(func() -> void: get_viewport().push_input(outside_motion, true), CONNECT_ONE_SHOT)
	await _click(stage.get_node("Partner1"))
	if _panel.selected_agent_id() != "financial-analysis" or not _controller.current_session().is_empty():
		return _fail("Single-click selection opened a Session or chose wrong ID")
	await _capture("selection-second-partner")
	await _key(KEY_LEFT)
	if _panel.selected_agent_id() != "coding": return _fail("Left selection failed while button focused")
	await _key(KEY_RIGHT)
	if _panel.selected_agent_id() != "financial-analysis": return _fail("Right selection failed")
	get_window().size = Vector2i(2560, 1440)
	await get_tree().create_timer(0.5).timeout
	var large_frame := await _frame()
	if large_frame.get_width() < 2560: return _fail("Large-canvas capture did not reach requested pixel width")
	await _capture("selection-2560")
	# Fill the artwork without cropping production controls at different aspect ratios.
	for size in [Vector2i(1152, 720), Vector2i(1600, 1200), Vector2i(2560, 1080)]:
		get_window().size = size
		await get_tree().create_timer(0.25).timeout
		await _capture("selection-%dx%d" % [size.x, size.y])
		for slot in [0, 1]:
			await _click(stage.get_node("Partner%d" % slot))
			if _panel.selected_agent_id() != ["coding", "financial-analysis"][slot] or not _controller.current_session().is_empty():
				return _fail("Selection click failed after viewport resize: %s" % size)
	get_window().grab_focus()
	_main.get_node("GameDisplay").toggle_fullscreen()
	await get_tree().create_timer(2.5).timeout
	if not _main.get_node("GameDisplay").is_fullscreen(): return _fail("Fullscreen mode was not entered")
	print("selection_fullscreen: mode=", get_window().mode, " window=", get_window().size, " screen=", DisplayServer.screen_get_size())
	await _capture("selection-fullscreen")
	_main.get_node("GameDisplay").toggle_fullscreen()
	await get_tree().create_timer(2.0).timeout
	await _key(KEY_ENTER)
	while _controller.current_session().is_empty(): await get_tree().process_frame
	if _controller.selected_agent()["id"] != "financial-analysis" or _entered != 1:
		return _fail("Enter did not open exactly the selected partner")
	if _panel.is_processing() or stage.get_node("Companion0").is_playing():
		return _fail("Hidden selection continues animation")
	var drift: float = _panel.get("_drift")
	await get_tree().create_timer(0.2).timeout
	if drift != _panel.get("_drift"): return _fail("Hidden clouds keep advancing")
	_controller.back_to_characters()
	while not _controller.current_session().is_empty(): await get_tree().process_frame
	await get_tree().create_timer(0.25).timeout
	if not _panel.is_visible_in_tree() or not _panel.is_processing(): return _fail("Return failed to resume selection")
	await _capture("selection-returned")
	# A newly registered Agent must remain selectable without new art/catalog code.
	_panel.render_agents(agents + [{"id": "new-fixture", "displayName": "新伙伴", "description": "Catalog extension"}])
	await _key(KEY_RIGHT)
	if _panel.selected_agent_id() != "new-fixture": return _fail("Presentation catalog became an Agent allowlist")
	_panel.set_busy(true)
	await _key(KEY_ENTER)
	await get_tree().create_timer(0.1).timeout
	if _entered != 1: return _fail("Busy selection allowed a second entry")
	_panel.set_busy(false)
	_panel.render_agents(agents)
	await _key(KEY_LEFT)
	# Double-clicking the character is the same entry path as Enter/CTA.
	await _click(stage.get_node("ActorHit0"), true)
	while _controller.current_session().is_empty(): await get_tree().process_frame
	if _entered != 2 or _controller.selected_agent()["id"] != "coding": return _fail("Double-click selected wrong partner")
	_controller.back_to_characters()
	while not _controller.current_session().is_empty(): await get_tree().process_frame
	await get_tree().create_timer(0.25).timeout
	await _click(stage.get_node("EnterWorkshop"))
	while _controller.current_session().is_empty(): await get_tree().process_frame
	if _entered != 3 or _controller.selected_agent()["id"] != "coding": return _fail("CTA did not enter the selected partner")
	print("selection_verified: select without Session, keyboard, Enter, double-click, CTA, return, dynamic catalog, busy guard, hidden pause")
	print("selection_clouds_verified: two real frames differ in sky and match over opaque wood")
	_main.get_node("AgentHostClient").shutdown()
	get_tree().quit(1 if _failed else 0)

func _click(control: Control, double_click := false) -> void:
	var position := control.get_global_rect().get_center()
	for pressed in [true, false]:
		var event := InputEventMouseButton.new()
		event.position = position
		event.button_index = MOUSE_BUTTON_LEFT
		event.pressed = pressed
		event.double_click = double_click
		event.button_mask = MOUSE_BUTTON_MASK_LEFT if pressed else 0
		get_viewport().push_input(event, true)
	# Keep synthetic press/release ordered as one gesture. Yielding between
	# them lets native mouse motion cancel the button press nondeterministically.
	await get_tree().process_frame

func _key(code: Key) -> void:
	for pressed in [true, false]:
		var event := InputEventKey.new()
		event.keycode = code
		event.pressed = pressed
		get_viewport().push_input(event, true)
		await get_tree().process_frame

func _frame() -> Image:
	await RenderingServer.frame_post_draw
	return get_viewport().get_texture().get_image()

func _capture(name: String) -> void:
	var directory := OS.get_environment("HARNESS_ARTIFACT_DIR")
	if directory.is_empty(): directory = ProjectSettings.globalize_path(EVIDENCE)
	DirAccess.make_dir_recursive_absolute(directory)
	var image := await _frame()
	image.save_png(directory.path_join(name + ".png"))
	for node_name in ["Partner0", "Partner1", "EnterWorkshop", "Previous", "Next"]:
		var control: Control = _panel.get_node("Stage/" + node_name)
		if control.visible and not _panel.get_global_rect().encloses(control.get_global_rect()):
			return _fail("Selection control clipped: " + node_name + " at " + str(image.get_size()))
	print("selection_capture: ", name, " ", image.get_size())

func _fail(message: String) -> void:
	_failed = true
	push_error(message)
	get_tree().quit(1)
