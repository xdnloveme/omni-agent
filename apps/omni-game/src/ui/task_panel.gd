class_name TaskPanel
extends PanelContainer

signal close_requested()
signal new_session_requested()
signal run_requested(text: String)
signal cancel_requested()
signal presentation_layout_changed(panel_rect: Rect2, expanded: bool)

@onready var _agent_name: Label = %AgentName
@onready var _role_title: Label = %RoleTitle
@onready var _portrait: TextureRect = %Portrait
@onready var _session_label: Label = %SessionLabel
@onready var _run_state: Label = %RunState
@onready var _message_scroll: ScrollContainer = %MessageScroll
@onready var _message_list: VBoxContainer = %MessageList
@onready var _empty_state: VBoxContainer = %EmptyState
@onready var _new_content: Button = %NewContent
@onready var _task_input: TextEdit = %TaskInput
@onready var _run_button: Button = %RunButton
@onready var _cancel_button: Button = %CancelButton
@onready var _new_session_button: Button = %NewSessionButton
@onready var _close_button: Button = %CloseButton
@onready var _expand_button: Button = %ExpandButton
@onready var _status_label: Label = %StatusLabel

var _running := false
var _busy := false
var _cancel_pending := false
var _expanded := false
var _session_id := ""
var _display_name := "伙伴"
# Presentation nodes only: the controller owns message text and run lifecycle.
var _rows: Dictionary = {}
var _follow_tail := true
var _layout_pending := false
var _reading_anchor := ""
var _reading_offset := 0.0
var _user_scroll_intent := false
var _error_message := ""
var _last_message_status := ""

func _ready() -> void:
	_close_button.pressed.connect(func() -> void: close_requested.emit())
	_expand_button.pressed.connect(func() -> void: set_expanded(not _expanded))
	_new_session_button.pressed.connect(func() -> void: new_session_requested.emit())
	_run_button.pressed.connect(_submit)
	_cancel_button.pressed.connect(func() -> void: cancel_requested.emit())
	_new_content.pressed.connect(_jump_to_latest)
	_task_input.text_changed.connect(_sync_controls)
	_task_input.gui_input.connect(_on_composer_input)
	_message_scroll.get_v_scroll_bar().value_changed.connect(_on_scroll_changed)
	_message_scroll.gui_input.connect(_on_reading_input)
	_message_scroll.get_v_scroll_bar().gui_input.connect(_on_reading_input)
	get_viewport().size_changed.connect(_layout_panel)
	%AnalyzeButton.pressed.connect(func() -> void:
		_apply_prompt_template("请分析当前项目，并总结关键问题和改进建议。"))
	%OrganizeButton.pressed.connect(func() -> void:
		_apply_prompt_template("请整理当前项目的文档结构，并指出缺失或重复的内容。"))
	%AnswerButton.pressed.connect(func() -> void:
		_apply_prompt_template("请回答下面的问题：\n"))
	_layout_panel()
	_sync_controls()

func show_workspace(agent: Dictionary, session: Dictionary, presentation: CharacterPresentation) -> void:
	_display_name = presentation.display_name
	if _display_name.is_empty():
		_display_name = agent.get("displayName", "伙伴")
	_agent_name.text = _display_name
	_role_title.text = presentation.role_title
	_portrait.texture = presentation.portrait
	var session_id := str(session.get("sessionId", ""))
	if session_id != _session_id:
		_session_id = session_id
		_task_input.clear()
		_follow_tail = true
		_reading_anchor = ""
		_new_content.hide()
		_error_message = ""
	_session_label.text = "当前任务 · %s" % (session_id.left(10) if not session_id.is_empty() else "待创建")
	_session_label.tooltip_text = "会话 ID：%s" % session_id
	_sync_controls()

func focus_input() -> void:
	_task_input.call_deferred("grab_focus")

func mark_submitted() -> void:
	_error_message = ""
	_task_input.clear()
	_jump_to_latest()
	_sync_controls()

func set_messages(messages: Array) -> void:
	_remember_reading_position()
	_last_message_status = ""
	var live_ids: Dictionary = {}
	for index in messages.size():
		var message: Dictionary = messages[index]
		if message["role"] == "assistant":
			_last_message_status = str(message.get("status", "completed"))
		var message_id := str(message["id"])
		live_ids[message_id] = true
		if not _rows.has(message_id):
			_rows[message_id] = _make_message_row(message)
		var row: HBoxContainer = _rows[message_id]
		_message_list.move_child(row, index + 1)
		_update_message_row(row, message)
	for message_id in _rows.keys():
		if not live_ids.has(message_id):
			var obsolete: Control = _rows[message_id]
			_message_list.remove_child(obsolete)
			obsolete.queue_free()
			_rows.erase(message_id)
	_empty_state.visible = messages.is_empty()
	if not _follow_tail and not messages.is_empty():
		_new_content.show()
	_schedule_reading_restore()
	_sync_controls()

func set_running(running: bool) -> void:
	_running = running
	if not running:
		_cancel_pending = false
	_sync_controls()

func set_cancel_pending(pending: bool) -> void:
	_cancel_pending = pending
	_sync_controls()

func set_busy(busy: bool) -> void:
	_busy = busy
	_sync_controls()

func show_error(message: String) -> void:
	_error_message = message
	_sync_controls()

func set_expanded(expanded: bool) -> void:
	_remember_reading_position()
	_expanded = expanded
	_expand_button.text = "还原" if expanded else "展开"
	_expand_button.tooltip_text = "恢复右侧对话窗" if expanded else "展开阅读，不切换场景"
	_layout_panel()

func is_expanded() -> bool:
	return _expanded

func _layout_panel() -> void:
	_remember_reading_position()
	var viewport_size := get_viewport_rect().size
	var panel_width := minf(1160.0 if _expanded else 650.0, viewport_size.x - 48.0)
	var panel_height := minf(776.0, viewport_size.y - 96.0)
	set_anchors_preset(Control.PRESET_TOP_LEFT)
	size = Vector2(panel_width, panel_height)
	position = Vector2((viewport_size.x - panel_width) * 0.5 if _expanded else viewport_size.x - panel_width - 28.0,
		(viewport_size.y - panel_height) * 0.5)
	_schedule_reading_restore()
	presentation_layout_changed.emit(get_global_rect(), _expanded)

func _make_message_row(message: Dictionary) -> HBoxContainer:
	var row := HBoxContainer.new()
	var is_user: bool = message["role"] == "user"
	row.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	row.add_theme_constant_override("separation", 10 if not is_user else 0)
	# Allocate the user bubble with container stretch ratios, never a width-based
	# minimum size: child minima must not lock an expanded window at its old width.
	if is_user:
		var gutter := Control.new()
		gutter.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		gutter.size_flags_stretch_ratio = 4.0
		row.add_child(gutter)
	else:
		var avatar_frame := PanelContainer.new()
		avatar_frame.name = "PortraitFrame"
		avatar_frame.theme_type_variation = "TaskPortraitFrame"
		avatar_frame.custom_minimum_size = Vector2(36, 36)
		avatar_frame.size_flags_vertical = Control.SIZE_SHRINK_BEGIN
		var avatar := TextureRect.new()
		avatar.name = "Portrait"
		avatar.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		avatar.stretch_mode = TextureRect.STRETCH_KEEP_ASPECT_CENTERED
		avatar_frame.add_child(avatar)
		row.add_child(avatar_frame)
	var card := PanelContainer.new()
	card.name = "MessageCard"
	card.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	card.size_flags_stretch_ratio = 5.0 if is_user else 1.0
	card.add_theme_stylebox_override("panel", get_theme_stylebox("user_message" if is_user else "assistant_message", "TaskPanel"))
	row.add_child(card)
	var content := VBoxContainer.new()
	content.name = "Content"
	content.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	content.add_theme_constant_override("separation", 4)
	card.add_child(content)
	var speaker := Label.new()
	speaker.name = "Speaker"
	speaker.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	speaker.horizontal_alignment = HORIZONTAL_ALIGNMENT_LEFT
	speaker.text_overrun_behavior = TextServer.OVERRUN_TRIM_ELLIPSIS
	speaker.add_theme_font_size_override("font_size", 18)
	speaker.add_theme_color_override("font_color", Color("#493422"))
	speaker.add_theme_font_override("font", get_theme_font("bold_font", "RichTextLabel"))
	content.add_child(speaker)
	var body := RichTextLabel.new()
	body.name = "Body"
	body.bbcode_enabled = false
	body.fit_content = true
	body.scroll_active = false
	body.selection_enabled = true
	body.gui_input.connect(_on_reading_input)
	body.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	body.add_theme_font_size_override("normal_font_size", 18)
	body.add_theme_constant_override("line_separation", 4)
	content.add_child(body)
	var result := Label.new()
	result.name = "Result"
	result.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	result.add_theme_font_size_override("font_size", 15)
	content.add_child(result)
	_message_list.add_child(row)
	return row

func _update_message_row(row: HBoxContainer, message: Dictionary) -> void:
	var heading: Label = row.get_node("MessageCard/Content/Speaker")
	var body: RichTextLabel = row.get_node("MessageCard/Content/Body")
	var result: Label = row.get_node("MessageCard/Content/Result")
	var assistant: bool = message["role"] == "assistant"
	heading.text = _display_name if assistant else "你"
	if assistant:
		row.get_node("PortraitFrame/Portrait").texture = _portrait.texture
	var content := str(message["text"])
	if not row.has_meta("rendered_text") or row.get_meta("rendered_text") != content:
		row.set_meta("rendered_text", content)
		_render_message(body, content, assistant)
	var status := str(message.get("status", "completed"))
	result.visible = assistant and status != "completed"
	result.add_theme_color_override("font_color", Color("#954b31") if status == "failed" else Color("#667344"))
	match status:
		"running": result.text = "正在回复……"
		"cancelled": result.text = "已停止 · 保留以上内容"
		"failed": result.text = "未完成 · %s" % str(message.get("error", "请稍后重试"))
		_: result.text = ""

func _render_message(body: RichTextLabel, content: String, format_markdown: bool) -> void:
	body.clear()
	if not format_markdown:
		body.add_text(content)
		return
	# A deliberately small presentation grammar. Agent text never becomes BBCode.
	var in_code := false
	var code_lines: PackedStringArray = []
	var lines := content.split("\n")
	for index in lines.size():
		var line: String = lines[index]
		if line.begins_with("```"):
			if in_code:
				_render_code_block(body, "\n".join(code_lines))
				code_lines.clear()
			in_code = not in_code
			continue
		if in_code:
			code_lines.append(line)
		elif line.begins_with("#") and line.find(" ") > 0 and line.find(" ") <= 6:
			var heading_end := line.find(" ")
			if line.left(heading_end).replace("#", "").is_empty():
				body.push_bold()
				body.add_text(line.substr(heading_end + 1))
				body.pop()
			else:
				body.add_text(line)
			body.add_text("\n")
		else:
			_render_inline(body, "• " + line.substr(2) if line.begins_with("- ") else line)
			if index < lines.size() - 1:
				body.add_text("\n")
	if in_code:
		_render_code_block(body, "\n".join(code_lines))

func _render_inline(body: RichTextLabel, text: String) -> void:
	var cursor := 0
	while cursor < text.length():
		var bold_at := text.find("**", cursor)
		var code_at := text.find("`", cursor)
		var is_bold := bold_at >= 0 and (code_at < 0 or bold_at < code_at)
		var opening := bold_at if is_bold else code_at
		if opening < 0:
			body.add_text(text.substr(cursor))
			return
		var delimiter := "**" if is_bold else "`"
		var closing := text.find(delimiter, opening + delimiter.length())
		if closing < 0:
			# Streaming can leave a delimiter unfinished; never drop its text.
			body.add_text(text.substr(cursor))
			return
		body.add_text(text.substr(cursor, opening - cursor))
		if is_bold:
			body.push_bold()
		else:
			body.push_bgcolor(Color("#e4d9c4"))
		body.add_text(text.substr(opening + delimiter.length(), closing - opening - delimiter.length()))
		body.pop()
		cursor = closing + delimiter.length()

func _render_code_block(body: RichTextLabel, code: String) -> void:
	body.push_table(1)
	body.set_table_column_expand(0, true)
	body.push_cell()
	body.set_cell_row_background_color(Color("#e4d9c4"), Color("#e4d9c4"))
	body.set_cell_padding(Rect2(12, 10, 12, 10))
	body.push_font_size(17)
	body.add_text(code)
	body.pop()
	body.pop()
	body.pop()
	body.add_text("\n")

func _remember_reading_position(force := false) -> void:
	if not is_node_ready() or (_layout_pending and not force) or _follow_tail:
		return
	_reading_anchor = ""
	for message_id in _rows:
		var row: Control = _rows[message_id]
		if row.position.y + row.size.y > _message_scroll.scroll_vertical:
			_reading_anchor = message_id
			_reading_offset = _message_scroll.scroll_vertical - row.position.y
			break

func _schedule_reading_restore() -> void:
	if _layout_pending:
		return
	_layout_pending = true
	_restore_reading_position.call_deferred()

func _restore_reading_position() -> void:
	# Container and RichTextLabel minimum sizes settle across two layout frames.
	await get_tree().process_frame
	await get_tree().process_frame
	if _follow_tail:
		_message_scroll.scroll_vertical = int(_message_scroll.get_v_scroll_bar().max_value)
	elif _rows.has(_reading_anchor):
		var row: Control = _rows[_reading_anchor]
		_message_scroll.scroll_vertical = int(row.position.y + _reading_offset)
	_layout_pending = false
	_user_scroll_intent = false

func _on_scroll_changed(_value: float) -> void:
	if _layout_pending and not _user_scroll_intent:
		return
	var bar := _message_scroll.get_v_scroll_bar()
	_follow_tail = bar.value >= bar.max_value - bar.page - 12.0
	if _follow_tail:
		_new_content.hide()
	_remember_reading_position(true)

func _on_reading_input(event: InputEvent) -> void:
	var wheel: bool = event is InputEventMouseButton and event.pressed and event.button_index in [MOUSE_BUTTON_WHEEL_UP, MOUSE_BUTTON_WHEEL_DOWN]
	var drag: bool = event is InputEventMouseMotion and (event.button_mask & MOUSE_BUTTON_MASK_LEFT) != 0
	var press: bool = event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT
	if wheel or drag or press or event is InputEventPanGesture:
		# User intent wins even while new deltas are scheduling container layout.
		_user_scroll_intent = true
		_follow_tail = false
		_remember_reading_position(true)

func _jump_to_latest() -> void:
	_follow_tail = true
	_new_content.hide()
	_schedule_reading_restore()

func _submit() -> void:
	if not _busy and not _running and not _task_input.text.strip_edges().is_empty():
		run_requested.emit(_task_input.text)

func _on_composer_input(event: InputEvent) -> void:
	if event is InputEventKey and event.pressed and not event.echo and event.keycode == KEY_ENTER and (event.ctrl_pressed or event.meta_pressed):
		_submit()
		_task_input.accept_event()

func _apply_prompt_template(template: String) -> void:
	_task_input.text = template
	focus_input()
	_task_input.set_caret_line(_task_input.get_line_count() - 1)
	_task_input.set_caret_column(_task_input.get_line(_task_input.get_line_count() - 1).length())
	_sync_controls()

func _sync_controls() -> void:
	_run_button.disabled = _busy or _running or _task_input.text.strip_edges().is_empty()
	_run_button.visible = not _running
	_cancel_button.visible = _running
	_cancel_button.disabled = _cancel_pending
	_task_input.editable = true
	_new_session_button.disabled = _busy or _running
	_close_button.disabled = false
	_sync_run_state()
	_status_label.tooltip_text = _error_message
	if not _error_message.is_empty():
		_status_label.text = _error_message
	elif _busy:
		_status_label.text = "正在准备任务……"
	elif _cancel_pending:
		_status_label.text = "正在停止……"
	elif _running:
		_status_label.text = "回复中 · 可先编辑下一条草稿"
	else:
		_status_label.text = "Ctrl / ⌘ + Enter 发送 · Enter 换行"

func _sync_run_state() -> void:
	var state := "已准备好"
	var state_color := Color("#596c3b")
	if _busy:
		state = "准备中"
	elif _cancel_pending:
		state = "停止中"
	elif _running:
		state = "回复中"
	elif not _error_message.is_empty() or _last_message_status == "failed":
		state = "未完成"
		state_color = Color("#954b31")
	elif _last_message_status == "cancelled":
		state = "已停止"
		state_color = Color("#7c684b")
	elif _last_message_status == "completed":
		state = "已完成"
	_run_state.text = "●  " + state
	_run_state.add_theme_color_override("font_color", state_color)
