class_name WorkshopInteractionPoint
extends Area2D

signal availability_changed(point: WorkshopInteractionPoint, available: bool)
signal interaction_requested(interaction_id: StringName)

@export var interaction_id: StringName
@export var prompt_text := "互动"
@export var prompt_offset := Vector2(0.0, -150.0)

@onready var _prompt: PanelContainer = %Prompt
@onready var _prompt_label: Label = %PromptLabel
@onready var _marker: Label = %Marker

var _available := false
var _interaction_enabled := false
var _hint_dismissed := false

func _ready() -> void:
	body_entered.connect(_on_body_entered)
	body_exited.connect(_on_body_exited)
	_prompt.position = prompt_offset - _prompt.size * 0.5
	_prompt_label.text = "E  %s" % prompt_text
	_prompt.mouse_filter = Control.MOUSE_FILTER_STOP
	_prompt.gui_input.connect(_on_prompt_input)
	_marker.gui_input.connect(_on_prompt_input)
	_update_presentation()

func set_prompt_text(text: String) -> void:
	prompt_text = text
	_prompt_label.text = "E  %s" % text
	_marker.tooltip_text = "E  %s · 点击互动" % text

func request_interaction() -> void:
	if not is_available(): return
	dismiss_hint()
	interaction_requested.emit(interaction_id)

func dismiss_hint() -> void:
	_hint_dismissed = true
	_update_presentation()

func reset_hint() -> void:
	_hint_dismissed = false
	_update_presentation()

func _on_prompt_input(event: InputEvent) -> void:
	if is_available() and event is InputEventMouseButton and event.pressed and event.button_index == MOUSE_BUTTON_LEFT:
		get_viewport().set_input_as_handled()
		request_interaction()

func is_available() -> bool:
	return _available and _interaction_enabled

func set_interaction_enabled(enabled: bool) -> void:
	if _interaction_enabled == enabled:
		return
	_interaction_enabled = enabled
	_update_presentation()

func distance_squared_to(body: Node2D) -> float:
	return global_position.distance_squared_to(body.global_position)

func _on_body_entered(body: Node2D) -> void:
	if body is PartnerActor:
		_set_available(true)

func _on_body_exited(body: Node2D) -> void:
	if body is PartnerActor:
		_set_available(false)

func _set_available(value: bool) -> void:
	if _available == value:
		return
	_available = value
	if not value:
		_hint_dismissed = false
	_update_presentation()
	availability_changed.emit(self, _available)

func _update_presentation() -> void:
	if not is_node_ready():
		return
	_prompt.visible = is_available() and not _hint_dismissed
	_marker.text = ("E" if _hint_dismissed else "◆") if is_available() else "◇"
	_marker.add_theme_font_size_override("font_size", 14 if _hint_dismissed else 24)
	_marker.add_theme_constant_override("outline_size", 2 if _hint_dismissed else 5)
	_marker.mouse_filter = Control.MOUSE_FILTER_STOP if is_available() else Control.MOUSE_FILTER_IGNORE
	_marker.mouse_default_cursor_shape = Control.CURSOR_POINTING_HAND if is_available() else Control.CURSOR_ARROW
	_marker.tooltip_text = "E  %s · 点击互动" % prompt_text
	_marker.modulate = (
		Color(1.0, 0.72, 0.24, 1.0) if is_available() else Color(1.0, 0.9, 0.66, 0.48)
	)
	_marker.position = prompt_offset + Vector2(-12.0, 0.0 if _hint_dismissed else 30.0)
