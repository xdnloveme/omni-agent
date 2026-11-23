class_name CharacterInfoPanel
extends PanelContainer

signal close_requested()

@export var ready_icon: Texture2D
@export var working_icon: Texture2D

const SAFE_MARGIN := 16.0
const ENTER_DURATION := 0.12
const ENTER_OFFSET := 12.0

@onready var _title_bar: Control = %TitleBar
@onready var _title_portrait: TextureRect = %TitlePortrait
@onready var _display_name: Label = %DisplayName
@onready var _plaque_name: Label = %PlaqueName
@onready var _role_title: Label = %RoleTitle
@onready var _close_button: Button = %CloseButton
@onready var _status_icon: TextureRect = %StatusIcon
@onready var _status_summary: Label = %StatusSummary
@onready var _profile_tab: Button = %ProfileTab
@onready var _status_tab: Button = %StatusTab
@onready var _profile_content: Control = %ProfileContent
@onready var _status_content: Control = %StatusContent
@onready var _description: Label = %Description
@onready var _package_name: Label = %PackageName
@onready var _package_version: Label = %PackageVersion
@onready var _session_id: Label = %SessionId
@onready var _runtime_status: Label = %RuntimeStatus
@onready var _profile_runtime_status: Label = %ProfileRuntimeStatus
@onready var _preview: CharacterPreview = %CharacterPreview
@onready var _technical_toggle: Button = %TechnicalToggle
@onready var _technical_details: Control = %TechnicalDetails
@onready var _technical_arrow: Label = %TechnicalArrow
@onready var _state_summary: Control = %StateSummary

var _dragging := false
var _runtime_busy := false
var _runtime_running := false
var _cancel_pending := false
var _open_tween: Tween
var _animation_target := Vector2.ZERO

func _ready() -> void:
	_title_bar.gui_input.connect(_on_title_bar_input)
	_close_button.pressed.connect(func() -> void: close_requested.emit())
	_profile_tab.pressed.connect(func() -> void: _select_tab(true))
	_status_tab.pressed.connect(func() -> void: _select_tab(false))
	_technical_toggle.toggled.connect(_set_technical_expanded)
	visibility_changed.connect(_on_visibility_changed)
	_select_tab(true)
	visible = false

func show_character(
	agent: Dictionary,
	session: Dictionary,
	presentation: CharacterPresentation,
) -> void:
	_title_portrait.texture = presentation.portrait
	_preview.configure(presentation.animation_set as CharacterAnimationSet)
	_display_name.text = presentation.display_name if not presentation.display_name.is_empty() else agent.get("displayName", "伙伴")
	_role_title.text = presentation.role_title
	_plaque_name.text = _display_name.text
	_description.text = agent.get("description", "暂无角色说明。")
	_package_name.text = "Package · %s" % agent.get("packageName", "未知")
	_package_version.text = "Version · %s" % agent.get("packageVersion", "未知")
	_session_id.text = session.get("sessionId", "未打开")
	_technical_toggle.set_pressed_no_signal(false)
	_set_technical_expanded(false)
	_select_tab(true)
	_update_runtime_status()
	visible = true
	_play_enter_animation()
	_profile_tab.grab_focus()

func set_runtime_state(busy: bool, running: bool, cancel_pending: bool) -> void:
	_runtime_busy = busy
	_runtime_running = running
	_cancel_pending = cancel_pending
	_update_runtime_status()

func close_panel() -> void:
	_dragging = false
	if _open_tween != null:
		_open_tween.kill()
		position = _animation_target
		_open_tween = null
	modulate.a = 1.0
	visible = false

func is_open() -> bool:
	return visible

func _select_tab(profile_selected: bool) -> void:
	_profile_content.visible = profile_selected
	_status_content.visible = not profile_selected
	_profile_tab.button_pressed = profile_selected
	_status_tab.button_pressed = not profile_selected

func _set_technical_expanded(expanded: bool) -> void:
	_state_summary.visible = not expanded
	_technical_details.visible = expanded
	_technical_toggle.text = "返回当前状态" if expanded else "技术信息"
	_technical_arrow.text = "‹" if expanded else "›"

func _update_runtime_status() -> void:
	if not is_node_ready():
		return
	if _cancel_pending:
		_status_icon.texture = working_icon
		_status_summary.text = "正在取消"
		_runtime_status.text = "正在取消当前工作"
	elif _runtime_running:
		_status_icon.texture = working_icon
		_status_summary.text = "工作中"
		_runtime_status.text = "伙伴正在处理当前任务"
	elif _runtime_busy:
		_status_icon.texture = working_icon
		_status_summary.text = "准备中"
		_runtime_status.text = "正在准备 Session"
	else:
		_status_icon.texture = ready_icon
		_status_summary.text = "已准备好"
		_runtime_status.text = "可以开始新的工作"
	_profile_runtime_status.text = _status_summary.text

func _on_title_bar_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.button_index == MOUSE_BUTTON_LEFT:
		if event.pressed and _open_tween != null:
			_open_tween.kill()
			_open_tween = null
			position = _animation_target
			modulate.a = 1.0
		_dragging = event.pressed
		accept_event()
	elif event is InputEventMouseMotion and _dragging:
		position += event.relative
		_clamp_to_viewport()
		accept_event()

func _clamp_to_viewport() -> void:
	var viewport_size := get_viewport_rect().size
	var maximum := Vector2(
		maxf(SAFE_MARGIN, viewport_size.x - size.x - SAFE_MARGIN),
		maxf(SAFE_MARGIN, viewport_size.y - size.y - SAFE_MARGIN),
	)
	position = position.clamp(Vector2(SAFE_MARGIN, SAFE_MARGIN), maximum)

func _play_enter_animation() -> void:
	if _open_tween != null:
		_open_tween.kill()
	_animation_target = position
	position.x = maxf(SAFE_MARGIN, _animation_target.x - ENTER_OFFSET)
	modulate.a = 0.0
	_open_tween = create_tween().set_parallel(true)
	_open_tween.set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT)
	_open_tween.tween_property(self, "position", _animation_target, ENTER_DURATION)
	_open_tween.tween_property(self, "modulate:a", 1.0, ENTER_DURATION)

func _on_visibility_changed() -> void:
	if visible:
		call_deferred("_clamp_to_viewport")
