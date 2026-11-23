class_name WorkshopMenu
extends Control

signal open_requested()
signal close_requested()
signal character_info_requested()
signal return_to_characters_requested()
signal quit_requested()
signal fullscreen_requested()

@onready var _open_button: Button = %OpenButton
@onready var _panel: PanelContainer = %MenuPanel
@onready var _continue_button: Button = %ContinueButton
@onready var _character_info_button: Button = %CharacterInfoButton
@onready var _return_button: Button = %ReturnButton
@onready var _help_button: Button = %HelpButton
@onready var _quit_button: Button = %QuitButton
@onready var _fullscreen_button: Button = %FullscreenButton
@onready var _help_text: Label = %HelpText
@onready var _status_label: Label = %MenuStatus

var _active := false
var _interaction_enabled := false
var _busy := false

func _ready() -> void:
	_open_button.pressed.connect(func() -> void: open_requested.emit())
	_continue_button.pressed.connect(func() -> void: close_requested.emit())
	_character_info_button.pressed.connect(func() -> void: character_info_requested.emit())
	_return_button.pressed.connect(func() -> void: return_to_characters_requested.emit())
	_help_button.pressed.connect(_toggle_help)
	_quit_button.pressed.connect(func() -> void: quit_requested.emit())
	_fullscreen_button.pressed.connect(func() -> void: fullscreen_requested.emit())
	_panel.visible = false
	_help_text.visible = false

func set_active(active: bool) -> void:
	_active = active
	visible = active
	if not active:
		close_menu()
	_sync_controls()

func set_interaction_enabled(enabled: bool) -> void:
	_interaction_enabled = enabled
	_sync_controls()

func open_menu() -> void:
	if not _active or not _interaction_enabled or _busy or _panel.visible:
		return
	_panel.visible = true
	_open_button.visible = false
	_continue_button.grab_focus()

func close_menu() -> void:
	if not _panel.visible:
		return
	_panel.visible = false
	_help_text.visible = false
	_open_button.visible = _active
	_status_label.text = ""
	if _active:
		_open_button.grab_focus()

func is_open() -> bool:
	return _panel.visible

func set_busy(busy: bool) -> void:
	_busy = busy
	_sync_controls()
	if busy:
		_status_label.text = "正在关闭伙伴任务……"
	else:
		_status_label.text = ""

func show_error(message: String) -> void:
	if _panel.visible:
		_status_label.text = message

func set_fullscreen(fullscreen: bool) -> void:
	_fullscreen_button.text = "窗口模式                         F11" if fullscreen else "全屏显示                         F11"

func _toggle_help() -> void:
	_help_text.visible = not _help_text.visible

func _sync_controls() -> void:
	_open_button.disabled = not _interaction_enabled or _busy
	_return_button.disabled = _busy
	_continue_button.disabled = _busy
	_character_info_button.disabled = _busy
	_help_button.disabled = _busy
	_quit_button.disabled = _busy
	_fullscreen_button.disabled = _busy
