extends Node

@onready var _panel: TaskPanel = $CanvasLayer/TaskPanel
@onready var _world: WorkshopWorld = $WorkshopWorld
@onready var _actor: PartnerActor = $WorkshopWorld/PartnerActor
@onready var _rig: WorkshopCameraRig = $WorkshopWorld/WorkshopCameraRig
@onready var _camera: Camera2D = $WorkshopWorld/WorkshopCameraRig/Camera2D
var _failed := false

func _ready() -> void:
	var presentation: CharacterPresentation = load("res://resources/characters/coding.tres")
	_world.enter_workspace(presentation)
	_world.set_input_enabled(false)
	# Place the actual actor at the workbench's authored walking surface.
	# Production focus only moves the camera; this placement belongs to the fixture.
	var traversal: WorkshopTraversalMap = $WorkshopWorld/TraversalMap
	var surface := traversal.middle_surface
	var workbench: Node2D = $WorkshopWorld/InteractionPoints/WorkbenchInteraction
	var local_x := surface.to_local(workbench.global_position).x
	_actor.reset_to_spawn(surface.to_global(Vector2(local_x, surface.sample_surface_y(local_x))))
	for _index in 5:
		await get_tree().physics_frame
	_rig.snap_to_target()
	_panel.presentation_layout_changed.connect(_on_panel_layout_changed)
	_panel.visibility_changed.connect(func() -> void:
		_on_panel_layout_changed(_panel.get_global_rect(), _panel.is_expanded()))
	_on_panel_layout_changed(_panel.get_global_rect(), _panel.is_expanded())
	_panel.show_workspace({}, {"sessionId": "visual-test-not-real-session"}, presentation)
	var messages: Array = [
		{"id": "one:user", "role": "user", "text": "帮我检查人物面板的布局。", "status": "completed"},
		{"id": "one", "role": "assistant", "text": "## 布局检查完成\n建议统一标题间距，并优化详情区的阅读体验。", "status": "completed"},
		{"id": "two:user", "role": "user", "text": "保留角色形象，只调整界面。", "status": "completed"},
		{"id": "two", "role": "assistant", "text": "好的，角色比例和待机动画保持不变。", "status": "completed"},
	]
	_panel.set_messages(messages)
	await _settle()
	await _settle_camera()
	var sprite: AnimatedSprite2D = _actor.get_node("CharacterVisual")
	_expect(sprite.animation == presentation.animation_set.inspection_animation and sprite.is_playing(), "Focused partner did not play its existing inspection idle")
	_check_bounds()
	var input: TextEdit = _panel.get_node("%TaskInput")
	input.text = "这是一条尚未发送的草稿。"
	input.text_changed.emit()
	_panel.set_expanded(true)
	await _settle()
	_check_bounds()
	_expect(input.text == "这是一条尚未发送的草稿。", "Expanding consumed the draft")
	messages.back()["text"] += "\n\n```gdscript\nfunc open_conversation():\n    panel.show()\n```"
	_panel.set_messages(messages)
	await _settle()
	_panel.hide()
	await _settle_camera()
	_expect(sprite.animation == &"idle", "Closing conversation did not restore exploration idle")
	_panel.show_workspace({}, {"sessionId": "visual-test-not-real-session"}, presentation)
	_panel.show()
	_expect(input.text == "这是一条尚未发送的草稿。" and _panel.is_expanded(), "Reopening reset draft or expansion")
	_panel.set_expanded(false)
	_panel.set_running(true)
	messages.back()["status"] = "running"
	_panel.set_messages(messages)
	await _settle()
	_expect(input.editable and not _panel.get_node("%CloseButton").disabled, "Run incorrectly blocked draft editing or minimize")
	_check_bounds()
	_panel.set_running(false)
	messages.back()["status"] = "failed"
	messages.back()["error"] = "验证示例：连接中断，请检查后重试。"
	_panel.set_messages(messages)
	await _settle()
	_check_bounds()
	# Multiple long turns exercise anchoring across reflow and incoming text.
	for index in 8:
		messages.append({"id": "long-%d" % index, "role": "assistant", "text": ("可阅读的长回复，滚动后应保持当前阅读位置。\n").repeat(8), "status": "completed"})
	_panel.set_messages(messages)
	await _settle()
	var scroll: ScrollContainer = _panel.get_node("%MessageScroll")
	# Input must win even while incoming deltas have a pending container reflow.
	var tail_y := scroll.scroll_vertical
	messages.back()["text"] += "正在流式更新。"
	_panel.set_messages(messages)
	var wheel := InputEventMouseButton.new()
	wheel.position = scroll.get_global_rect().get_center()
	wheel.global_position = wheel.position
	wheel.button_index = MOUSE_BUTTON_WHEEL_UP
	wheel.pressed = true
	get_viewport().push_input(wheel, true)
	await _settle()
	_expect(scroll.scroll_vertical < tail_y, "Scrolling up during pending streamed layout was pulled back to the tail")
	scroll.scroll_vertical = 320
	await _settle()
	var reading_y := scroll.scroll_vertical
	messages.back()["text"] += "新收到的文本，不应抢走阅读位置。"
	_panel.set_messages(messages)
	await _settle()
	_expect(absi(scroll.scroll_vertical - reading_y) <= 2, "Incoming output moved the reader away from an earlier turn")
	_expect(_panel.get_node("%NewContent").visible, "New output while reading history had no indicator")
	_panel.set_expanded(true)
	await _settle()
	_panel.set_expanded(false)
	await _settle()
	_check_bounds()
	_expect(absi(scroll.scroll_vertical - reading_y) <= 2, "Expand/restore lost the anchored reading position")
	await _verify_window_sizes()
	_panel.mark_submitted()
	_expect(input.text.is_empty(), "Accepted submission did not clear the sent draft")
	_panel.show_error("验证示例：任务未能发送")
	input.text = "保留失败后的草稿"
	input.text_changed.emit()
	_expect(_panel.get_node("%StatusLabel").text == "验证示例：任务未能发送", "Editing the draft erased an actionable error")
	input.text = "旧任务草稿"
	_panel.set_messages([])
	_panel.show_workspace({}, {"sessionId": "another-session"}, presentation)
	await _settle()
	_expect(input.text.is_empty(), "New Session inherited the old draft")
	if not _failed:
		print("task_panel_verified")
	get_tree().quit(1 if _failed else 0)

func _settle() -> void:
	for _index in 5:
		await get_tree().process_frame

func _check_bounds() -> void:
	var bounds := get_viewport().get_visible_rect()
	_expect(bounds.encloses(_panel.get_global_rect()), "Conversation panel escaped viewport")
	_expect(_panel.get_global_rect().encloses(_panel.get_node("%TaskInput").get_global_rect()), "Composer escaped panel")
	for control_name in ["RunButton", "CancelButton", "CloseButton"]:
		var control: Control = _panel.get_node("%%%s" % control_name)
		if control.is_visible_in_tree():
			_expect(_panel.get_global_rect().encloses(control.get_global_rect()), "%s escaped conversation panel" % control_name)

func _verify_window_sizes() -> void:
	var window := get_window()
	var initial_size := window.size
	var initial_expanded := _panel.is_expanded()
	for requested_size in [Vector2i(1152, 720), Vector2i(1920, 1080)]:
		window.size = requested_size
		await _settle()
		_expect(window.size == requested_size, "Window resize was not applied: requested %s, actual %s" % [requested_size, window.size])
		# canvas_items can retain a logical viewport distinct from physical pixels.
		# Verify the actual window size and inspect controls in that live viewport,
		# rather than pretending the requested physical size is a logical layout.
		print("conversation_resize window=%s logical_viewport=%s" % [window.size, get_viewport().get_visible_rect().size])
		for expanded in [false, true]:
			_panel.set_expanded(expanded)
			for running in [false, true]:
				_panel.set_running(running)
				await _settle()
				_expect(_panel.get_node("%CancelButton").is_visible_in_tree() == running, "Resize lost the active Run control")
				_expect(_panel.get_node("%RunButton").is_visible_in_tree() != running, "Resize lost the send control")
				_expect(_panel.get_node("%CloseButton").is_visible_in_tree(), "Resize hid minimize")
				_check_bounds()
	_panel.set_running(false)
	_panel.set_expanded(initial_expanded)
	window.size = initial_size
	await _settle()
	_expect(window.size == initial_size, "Resize check did not restore initial window size")
	_check_bounds()

func _expect(value: bool, message: String) -> void:
	if not value:
		_failed = true
		printerr(message)

func _on_panel_layout_changed(panel_rect: Rect2, expanded: bool) -> void:
	_world.set_conversation_focus(_panel.is_visible_in_tree(), panel_rect, expanded)

func _settle_camera() -> void:
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
		if stable_samples >= 3 and is_equal_approx(_rig.get_focus_blend(), 1.0 if _panel.is_visible_in_tree() else 0.0):
			return
	_expect(false, "Conversation camera did not settle during layout verification")
