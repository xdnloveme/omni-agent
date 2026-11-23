class_name WorkshopCameraRig
extends Node2D

signal focus_blend_changed(blend: float)

@export var upper_middle_center_y := 450.0
@export var lower_center_y := 510.0
@export var vertical_transition_start := 690.0
@export var vertical_transition_end := 820.0
@export var smoothing_speed := 6.0
@export var conversation_zoom := 2.15
@export var expanded_conversation_zoom := 1.1
@export var conversation_transition_seconds := 0.48

@onready var _camera: Camera2D = $Camera2D

var _target: Node2D
var _tracking_enabled := true
var _debug_visible := false
var _last_desired_position := Vector2(720.0, 450.0)
var _conversation_active := false
var _conversation_expanded := false
var _conversation_panel_rect := Rect2()
var _focus_blend := 0.0
var _transition_progress := 1.0
var _transition_from_position := Vector2.ZERO
var _transition_from_zoom := 1.0
var _transition_from_blend := 0.0
var _activity_bounds := Rect2()
var _activity_focus := false

func _ready() -> void:
	set_process(true)

func _process(delta: float) -> void:
	if not _tracking_enabled or not is_instance_valid(_target):
		return
	var desired_zoom := _desired_zoom()
	_last_desired_position = _desired_position(desired_zoom)
	if _transition_progress < 1.0:
		_transition_progress = minf(1.0, _transition_progress + delta / conversation_transition_seconds)
		var progress := smoothstep(0.0, 1.0, _transition_progress)
		var zoom_value := lerpf(_transition_from_zoom, desired_zoom, progress)
		_camera.zoom = Vector2.ONE * zoom_value
		global_position = _clamp_to_world(_transition_from_position.lerp(_last_desired_position, progress), zoom_value)
		_set_focus_blend(lerpf(_transition_from_blend, 1.0 if _conversation_active else 0.0, progress))
	else:
		var weight := 1.0 - exp(-smoothing_speed * delta)
		global_position = _clamp_to_world(global_position.lerp(_last_desired_position, weight), desired_zoom)
		_camera.zoom = Vector2.ONE * desired_zoom
		if global_position.distance_to(_last_desired_position) <= 1.0:
			global_position = _last_desired_position
	queue_redraw()

func set_target(target: Node2D) -> void:
	_target = target

func set_tracking_enabled(enabled: bool) -> void:
	_tracking_enabled = enabled
	if not enabled:
		# Leaving the world must not preserve an unfinished focus transition.
		_conversation_active = false
		_conversation_expanded = false
		_conversation_panel_rect = Rect2()
		_activity_bounds = Rect2()
		_activity_focus = false
		_transition_progress = 1.0
		_camera.zoom = Vector2.ONE
		_set_focus_blend(0.0)
		_camera.reset_smoothing()

func set_conversation_focus(active: bool, panel_rect: Rect2, expanded: bool) -> void:
	active = active and _tracking_enabled
	if (
		active == _conversation_active
		and (not active or (expanded == _conversation_expanded and panel_rect == _conversation_panel_rect))
	):
		return
	_conversation_active = active
	_conversation_expanded = expanded
	_conversation_panel_rect = panel_rect
	# One interruptible transition owns the entire pose and visual emphasis.
	# New intent starts at the currently rendered pose, not an old tween endpoint.
	_transition_from_position = global_position
	_transition_from_zoom = _camera.zoom.x
	_transition_from_blend = _focus_blend
	_transition_progress = 0.0

func set_activity_bounds(bounds: Rect2, focused: bool = false) -> void:
	if _activity_bounds == bounds and _activity_focus == focused:
		return
	_activity_bounds = bounds
	_activity_focus = focused
	_transition_from_position = global_position
	_transition_from_zoom = _camera.zoom.x
	_transition_from_blend = _focus_blend
	_transition_progress = 0.0

func _conversation_clear_rect() -> Rect2:
	var viewport_size := get_viewport_rect().size
	return Rect2(Vector2(28.0, 70.0), Vector2(maxf(120.0, _conversation_panel_rect.position.x - 56.0), maxf(120.0, viewport_size.y - 140.0)))

func get_focus_blend() -> float:
	return _focus_blend

func snap_to_target() -> void:
	if not is_instance_valid(_target):
		return
	var zoom_value := _desired_zoom()
	_last_desired_position = _desired_position(zoom_value)
	global_position = _last_desired_position
	_camera.zoom = Vector2.ONE * zoom_value
	_transition_progress = 1.0
	_set_focus_blend(1.0 if _conversation_active else 0.0)
	_camera.reset_smoothing()
	queue_redraw()

func target_position_for(actor_position: Vector2) -> Vector2:
	var progress := smoothstep(
		vertical_transition_start,
		vertical_transition_end,
		actor_position.y,
	)
	return _clamp_to_world(Vector2(actor_position.x, lerpf(upper_middle_center_y, lower_center_y, progress)), _desired_zoom())

func _desired_zoom() -> float:
	var requested := 1.0
	if _activity_focus:
		var available := get_viewport_rect().size - Vector2(100, 180)
		requested = minf(conversation_zoom, minf(available.x / _activity_bounds.size.x, available.y / _activity_bounds.size.y))
	if _conversation_active:
		requested = expanded_conversation_zoom if _conversation_expanded else conversation_zoom
		if not _conversation_expanded and _activity_bounds.has_area():
			var available := _conversation_clear_rect().size
			requested = minf(requested, minf(available.x / _activity_bounds.size.x, available.y / _activity_bounds.size.y))
	# Expanded aspect ratios must not reveal space beyond the authored map.
	# Only composition changes; actor scale and traversal geometry stay untouched.
	var world_size := Vector2(_camera.limit_right - _camera.limit_left, _camera.limit_bottom - _camera.limit_top)
	var viewport_size := get_viewport_rect().size
	return maxf(requested, maxf(viewport_size.x / world_size.x, viewport_size.y / world_size.y))

func _desired_position(zoom_value: float) -> Vector2:
	var actor_position := _target.global_position
	var desired := target_position_for(actor_position)
	if _activity_focus:
		desired = _activity_bounds.get_center()
	if _conversation_active and not _conversation_expanded:
		var viewport_size := get_viewport_rect().size
		if _activity_bounds.has_area():
			desired = _activity_bounds.get_center() - (_conversation_clear_rect().get_center() - viewport_size * 0.5) / zoom_value
		else:
			var screen_foot := Vector2(_conversation_panel_rect.position.x * 0.47, viewport_size.y * 0.85)
			desired = actor_position - (screen_foot - viewport_size * 0.5) / zoom_value
	return _clamp_to_world(desired, zoom_value)

func _clamp_to_world(camera_position: Vector2, zoom_value: float) -> Vector2:
	var half_view := get_viewport_rect().size * 0.5 / zoom_value
	var world_min := Vector2(_camera.limit_left, _camera.limit_top)
	var world_max := Vector2(_camera.limit_right, _camera.limit_bottom)
	var minimum := world_min + half_view
	var maximum := world_max - half_view
	return Vector2(
		clampf(camera_position.x, minimum.x, maximum.x) if minimum.x <= maximum.x else (world_min.x + world_max.x) * 0.5,
		clampf(camera_position.y, minimum.y, maximum.y) if minimum.y <= maximum.y else (world_min.y + world_max.y) * 0.5,
	)

func _set_focus_blend(blend: float) -> void:
	if is_equal_approx(_focus_blend, blend):
		return
	_focus_blend = blend
	focus_blend_changed.emit(blend)

func set_debug_visible(visible: bool) -> void:
	_debug_visible = visible
	queue_redraw()

func _draw() -> void:
	if not _debug_visible:
		return
	var viewport_size := get_viewport_rect().size / _camera.zoom
	draw_rect(
		Rect2(-viewport_size * 0.5, viewport_size),
		Color(0.3, 0.7, 1.0, 0.8),
		false,
		3.0,
	)
	draw_circle(to_local(_last_desired_position), 7.0, Color(0.3, 0.85, 1.0))
