class_name CharacterSelectionPanel
extends Control

signal agent_selected(agent_id: String)

const DESIGN_SIZE := Vector2(1600, 900)
# Authored terrace contact points: shared by the idle sprites and selection ring.
const CONTACTS := [Vector2(457, 534), Vector2(800, 534)]
const FRAME := preload("res://assets/ui/character-info/dossier-frame.png")
const HEADING := preload("res://resources/selection-heading-font.tres")
const INK := Color(0.23, 0.14, 0.075)
const CREAM := Color(1.0, 0.95, 0.81)

var _catalog: CharacterPresentationCatalog
var _agents: Array = []
var _selected := -1
var _busy := false
var _connected := false
var _error := ""
var _stage: Control
var _clouds: ShaderMaterial
var _drift := 0.0
var _sprites: Array[AnimatedSprite2D] = []
var _slots: Array[Button] = []
var _slot_names: Array[Label] = []
var _slot_roles: Array[Label] = []
var _ring: Line2D
var _count: Label
var _detail_name: Label
var _description: Label
var _portrait: TextureRect
var _status: Label
var _enter: Button
var _previous: Button
var _next: Button

func _ready() -> void:
	_build_view()
	resized.connect(_layout)
	visibility_changed.connect(_sync_playback)
	_layout()
	_refresh()

func configure(catalog: CharacterPresentationCatalog) -> void:
	assert(catalog != null)
	_catalog = catalog
	_refresh()

func render_agents(agents: Array) -> void:
	var previous_id := selected_agent_id()
	_agents = agents.duplicate(true)
	_selected = -1 if _agents.is_empty() else 0
	for index in range(_agents.size()):
		if _agents[index]["id"] == previous_id: _selected = index
	_error = ""
	_refresh()

func selected_agent_id() -> String:
	return "" if _selected < 0 else str(_agents[_selected]["id"])

func set_busy(busy: bool) -> void:
	_busy = busy
	_refresh_controls()

func set_connection(ready: bool, message: String) -> void:
	_connected = ready
	_error = "" if ready else message
	_refresh_controls()

func show_error(message: String) -> void:
	_error = message
	_refresh_controls()

func _input(event: InputEvent) -> void:
	if not is_visible_in_tree() or _busy or not _connected or _agents.is_empty(): return
	if event.is_echo(): return
	if event.is_action_pressed("ui_left"):
		_select(posmod(_selected - 1, _agents.size()))
	elif event.is_action_pressed("ui_right"):
		_select(posmod(_selected + 1, _agents.size()))
	elif event.is_action_pressed("ui_accept"):
		_enter_selected()
	else: return
	get_viewport().set_input_as_handled()

func _select(index: int) -> void:
	if _busy or not _connected or index < 0 or index >= _agents.size(): return
	_selected = index
	_error = ""
	_refresh()

func _enter_selected() -> void:
	if _busy or not _connected or _selected < 0: return
	agent_selected.emit(selected_agent_id())

func _build_view() -> void:
	var surround := ColorRect.new()
	surround.color = Color(0.10, 0.18, 0.20)
	surround.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(surround)
	_stage = Control.new()
	_stage.name = "Stage"
	_stage.size = DESIGN_SIZE
	_stage.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_stage)
	_picture("Sky", preload("res://assets/ui/selection/sky-islands.png"), Rect2(Vector2.ZERO, DESIGN_SIZE))
	var clouds := ColorRect.new()
	clouds.name = "Clouds"
	clouds.position = Vector2(0, 70)
	clouds.size = Vector2(1600, 540)
	clouds.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_clouds = ShaderMaterial.new()
	_clouds.shader = preload("res://src/ui/selection_clouds.gdshader")
	_clouds.set_shader_parameter("cloud_texture", preload("res://assets/environment/workshop/workshop-clouds.png"))
	clouds.material = _clouds
	_stage.add_child(clouds)
	var terrace := _picture("Terrace", preload("res://assets/ui/selection/terrace-chroma.png"), Rect2(Vector2.ZERO, DESIGN_SIZE))
	var key := ShaderMaterial.new()
	key.shader = preload("res://src/ui/selection_terrace.gdshader")
	terrace.material = key
	var atmosphere := ColorRect.new()
	atmosphere.name = "Atmosphere"
	atmosphere.size = DESIGN_SIZE
	atmosphere.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var atmosphere_material := ShaderMaterial.new()
	atmosphere_material.shader = preload("res://src/ui/selection_atmosphere.gdshader")
	atmosphere.material = atmosphere_material
	_stage.add_child(atmosphere)
	_ring = Line2D.new()
	_ring.name = "SelectionRing"
	_ring.width = 4.5
	_ring.default_color = Color(1.0, 0.82, 0.39, 1.0)
	_ring.antialiased = true
	for point in range(65):
		var angle := float(point) / 64.0 * TAU
		_ring.add_point(Vector2(cos(angle) * 111, sin(angle) * 19))
	_stage.add_child(_ring)
	for slot in range(2):
		var actor := AnimatedSprite2D.new()
		actor.name = "Companion%d" % slot
		actor.centered = false
		actor.position = CONTACTS[slot]
		_stage.add_child(actor)
		_sprites.append(actor)
		var button := _button("Partner%d" % slot, "", Rect2(CONTACTS[slot].x - 127, 557, 254, 84))
		button.add_theme_font_size_override("font_size", 23)
		button.pressed.connect(func() -> void: _select((_selected / 2) * 2 + slot))
		_slots.append(button)
		var name_label := _label("", Rect2(button.position + Vector2(14, 5), Vector2(226, 39)), 30)
		name_label.add_theme_font_override("font", HEADING)
		name_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		_slot_names.append(name_label)
		var role_label := _label("", Rect2(button.position + Vector2(14, 48), Vector2(226, 27)), 19)
		role_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		_slot_roles.append(role_label)
		var hit := Button.new()
		hit.name = "ActorHit%d" % slot
		hit.position = CONTACTS[slot] - Vector2(120, 280)
		hit.size = Vector2(240, 280)
		hit.focus_mode = Control.FOCUS_NONE
		for state in ["normal", "hover", "pressed", "focus"]:
			hit.add_theme_stylebox_override(state, StyleBoxEmpty.new())
		hit.gui_input.connect(func(event: InputEvent) -> void:
			if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT and event.pressed:
				if _busy or not _slots[slot].visible: return
				_select((_selected / 2) * 2 + slot)
				if event.double_click: _enter_selected())
		_stage.add_child(hit)
	_plate(Rect2(32, 24, 438, 122))
	var title := _label("选择你的伙伴", Rect2(57, 36, 388, 64), 45)
	title.add_theme_font_override("font", HEADING)
	_label("选择一位伙伴，进入工坊", Rect2(60, 101, 375, 28), 18)
	_plate(Rect2(1372, 28, 197, 52))
	_count = _label("正在读取伙伴", Rect2(1388, 35, 165, 36), 20)
	_count.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_plate(Rect2(1060, 557, 250, 84))
	var plus := _label("＋", Rect2(1122, 396, 124, 100), 70, Color(0.86, 0.73, 0.49))
	plus.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	plus.add_theme_color_override("font_outline_color", Color(0.24, 0.16, 0.08))
	plus.add_theme_constant_override("outline_size", 4)
	var creation := _label("创建新伙伴\n功能规划中", Rect2(1080, 569, 210, 62), 21)
	creation.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_plate(Rect2(38, 704, 670, 159))
	_portrait = _picture("Portrait", null, Rect2(62, 728, 96, 110))
	_portrait.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
	_detail_name = _label("选择伙伴", Rect2(178, 722, 500, 40), 30)
	_detail_name.add_theme_font_override("font", HEADING)
	_description = _label("", Rect2(178, 771, 500, 67), 19)
	_description.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_enter = _button("EnterWorkshop", "进入工坊  →", Rect2(1210, 758, 352, 86), true)
	_enter.pressed.connect(_enter_selected)
	_previous = _button("Previous", "‹", Rect2(751, 794, 45, 44), false, true)
	_previous.pressed.connect(func() -> void: _select(posmod(_selected - 1, _agents.size())))
	_next = _button("Next", "›", Rect2(806, 794, 45, 44), false, true)
	_next.pressed.connect(func() -> void: _select(posmod(_selected + 1, _agents.size())))
	_status = _label("正在连接本地服务……", Rect2(751, 709, 425, 69), 18, CREAM)
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_status.add_theme_color_override("font_outline_color", Color(0.12, 0.09, 0.05))
	_status.add_theme_constant_override("outline_size", 4)
	_label("← → 选择伙伴   ·   Enter 进入", Rect2(1199, 851, 370, 33), 17, CREAM)

func _refresh() -> void:
	if _stage == null: return
	_count.text = "已有伙伴  %d" % _agents.size()
	var page := maxi(0, _selected) / 2
	for slot in range(2):
		var index := page * 2 + slot
		var available := index < _agents.size() and _catalog != null
		_slots[slot].visible = available
		_slot_names[slot].visible = available
		_slot_roles[slot].visible = available
		_sprites[slot].visible = available
		_stage.get_node("ActorHit%d" % slot).visible = available
		if not available: continue
		var agent: Dictionary = _agents[index]
		var presentation := _catalog.resolve(agent["id"])
		var animations: CharacterAnimationSet = presentation.animation_set
		var sprite := _sprites[slot]
		if sprite.sprite_frames != animations.frames:
			sprite.sprite_frames = animations.frames
			sprite.animation = animations.inspection_animation
			sprite.offset = -animations.foot_anchor
		# Selection sizing belongs to the character art, independent of world scale.
		sprite.scale = Vector2.ONE * (presentation.selection_frame_height / animations.source_size.y)
		var partner_name: String = presentation.display_name if presentation != _catalog.fallback else str(agent["displayName"])
		_slot_names[slot].text = ("✓ " if index == _selected else "") + partner_name
		_slot_names[slot].add_theme_color_override("font_color", Color(0.26, 0.34, 0.13) if index == _selected else INK)
		_slot_roles[slot].text = presentation.role_title
		_slots[slot].accessibility_name = partner_name + "，" + presentation.role_title + ("，已选中" if index == _selected else "")
		_slots[slot].set_meta("selected", index == _selected)
	_ring.visible = _selected >= 0
	if _selected >= 0 and _catalog != null:
		_ring.position = CONTACTS[_selected % 2]
		var agent: Dictionary = _agents[_selected]
		var presentation := _catalog.resolve(agent["id"])
		_detail_name.text = "%s · %s" % [presentation.display_name if presentation != _catalog.fallback else agent["displayName"], presentation.role_title]
		_description.text = presentation.selection_description if not presentation.selection_description.is_empty() else str(agent["description"])
		_portrait.texture = presentation.portrait
	else:
		_detail_name.text = "暂无可用伙伴"
		_description.text = "连接后会显示当前可用的伙伴。"
		_portrait.texture = null
	_sync_playback()
	_refresh_controls()

func _refresh_controls() -> void:
	if _enter == null: return
	var blocked := _busy or not _connected or _selected < 0
	_enter.disabled = blocked
	_enter.text = "正在进入……" if _busy else "进入工坊  →"
	for slot in _slots:
		slot.disabled = blocked
		_update_button_frame(slot, false)
	_update_button_frame(_enter, true)
	_previous.disabled = blocked or _agents.size() < 2
	_next.disabled = blocked or _agents.size() < 2
	_status.text = _error if not _error.is_empty() else ("正在准备伙伴……" if _busy else ("● 本地连接正常" if _connected else "正在连接本地服务……"))

func _layout() -> void:
	if _stage == null: return
	var factor := minf(size.x / DESIGN_SIZE.x, size.y / DESIGN_SIZE.y)
	_stage.scale = Vector2.ONE * factor
	_stage.position = (size - DESIGN_SIZE * factor) * 0.5

func _sync_playback() -> void:
	var active := is_visible_in_tree()
	set_process(active)
	for sprite in _sprites:
		if sprite.sprite_frames == null: continue
		# Parent visibility_changed precedes descendant visibility propagation.
		if active and sprite.visible: sprite.play()
		else: sprite.pause()

func _process(delta: float) -> void:
	# Local phase pauses when hidden; global shader TIME would keep advancing.
	# 20 base cycles are also 29 near-layer cycles (1.45x), so both wrap together.
	_drift = fmod(_drift + delta * 0.002, 20.0)
	_clouds.set_shader_parameter("drift", _drift)

func _picture(node_name: String, texture: Texture2D, rect: Rect2) -> TextureRect:
	var picture := TextureRect.new()
	picture.name = node_name
	picture.texture = texture
	picture.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	picture.position = rect.position
	picture.size = rect.size
	picture.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_stage.add_child(picture)
	return picture

func _frame(parent: Control, rect: Rect2, primary := false) -> NinePatchRect:
	var frame := NinePatchRect.new()
	frame.name = "Frame"
	frame.texture = FRAME
	frame.position = rect.position
	# Render the complete 40-source-pixel corner at 20 logical pixels; no cropped seam.
	frame.size = rect.size * 2.0
	frame.scale = Vector2.ONE * 0.5
	frame.mouse_filter = Control.MOUSE_FILTER_IGNORE
	for edge in [SIDE_LEFT, SIDE_TOP, SIDE_RIGHT, SIDE_BOTTOM]: frame.set_patch_margin(edge, 40)
	var material := ShaderMaterial.new()
	material.shader = preload("res://src/ui/selection_frame.gdshader")
	material.set_shader_parameter("primary", primary)
	frame.material = material
	parent.add_child(frame)
	return frame

func _plate(rect: Rect2) -> void:
	_frame(_stage, rect)

func _label(text: String, rect: Rect2, font_size: int, color := INK) -> Label:
	var label := Label.new()
	label.text = text
	label.position = rect.position
	label.size = rect.size
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", color)
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	_stage.add_child(label)
	return label

func _button(node_name: String, text: String, rect: Rect2, primary := false, compact := false) -> Button:
	var button := Button.new()
	button.name = node_name
	button.text = text
	button.position = rect.position
	button.size = rect.size
	button.add_theme_font_size_override("font_size", 36 if primary else 22)
	if primary: button.add_theme_font_override("font", HEADING)
	for state in ["font_color", "font_hover_color", "font_pressed_color"]:
		button.add_theme_color_override(state, CREAM if primary else INK)
	for state in ["normal", "hover", "pressed", "hover_pressed", "disabled"]:
		button.add_theme_stylebox_override(state, StyleBoxEmpty.new())
	_stage.add_child(button)
	if compact:
		_compact_button(button)
	else:
		var frame := _frame(button, Rect2(Vector2.ZERO, rect.size), primary)
		frame.show_behind_parent = true
		for change in [button.mouse_entered, button.mouse_exited, button.button_down, button.button_up, button.focus_entered, button.focus_exited]:
			change.connect(func() -> void: _update_button_frame(button, primary))
		_update_button_frame(button, primary)
	return button

func _update_button_frame(button: Button, primary: bool) -> void:
	var frame := button.get_node_or_null("Frame") as NinePatchRect
	if frame == null: return
	var active := button.is_hovered() or button.has_focus()
	var selected: bool = button.get_meta("selected", false)
	var tint := Color(0.37, 0.46, 0.18) if primary else Color.WHITE
	if primary and active: tint = Color(0.43, 0.53, 0.22)
	if not primary and (active or selected): tint = Color(1.0, 0.94, 0.72)
	if button.button_pressed: tint = tint.darkened(0.08)
	if button.disabled: tint = Color(0.57, 0.57, 0.43) if primary else Color(0.92, 0.90, 0.84)
	(frame.material as ShaderMaterial).set_shader_parameter("paper_tint", tint)

func _compact_button(button: Button) -> void:
	# Small navigation controls cannot accommodate the large painted frame corners.
	for state in ["normal", "hover", "pressed", "disabled"]:
		var style := StyleBoxFlat.new()
		style.bg_color = Color(0.91, 0.82, 0.62) if state != "hover" else Color(1, 0.92, 0.72)
		style.border_color = Color(0.45, 0.32, 0.17)
		style.set_border_width_all(2)
		style.set_corner_radius_all(7)
		button.add_theme_stylebox_override(state, style)
