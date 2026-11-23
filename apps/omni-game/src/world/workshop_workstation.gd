class_name WorkshopWorkstation
extends Node2D

signal inspect_requested()

## Furniture contacts and projected Run status; never owns a task or actor.
@export var focus_bounds := Rect2(-100, -170, 350, 220)
@onready var approach: Marker2D = $Approach
@onready var seat: Marker2D = $Seat
@onready var _inspect_area: Button = $InspectArea
@onready var _inspect_hint: Label = $InspectHint
@onready var _state_caption: Label = $StateCaption

var _status: StringName = &"idle"
var _result_acknowledged := false
var _interaction_enabled := false
var _phase := 0.0
var _intensity := 0.0
var _result_age := 0.0

func _ready() -> void:
	_inspect_area.pressed.connect(func() -> void: inspect_requested.emit())
	_inspect_area.mouse_entered.connect(_sync_hint)
	_inspect_area.mouse_exited.connect(_sync_hint)
	_inspect_area.focus_entered.connect(_sync_hint)
	_inspect_area.focus_exited.connect(_sync_hint)
	_sync_status()
	set_process(false)

func set_status(status: StringName) -> void:
	assert(status in [&"idle", &"running", &"completed", &"failed", &"cancelled"])
	if status == _status: return
	_status = status
	_result_acknowledged = false
	_result_age = 0.0
	set_process(true)
	_sync_status()

func acknowledge_result() -> void:
	if _status in [&"idle", &"running"]: return
	_result_acknowledged = true
	set_process(true)
	_sync_status()

func set_interaction_enabled(enabled: bool) -> void:
	_interaction_enabled = enabled
	_sync_status()

func is_running() -> bool:
	return _status == &"running"

func result_status() -> StringName:
	return _status

func _has_marker() -> bool:
	return _status != &"idle" and not _result_acknowledged

func _sync_status() -> void:
	_inspect_area.visible = _has_marker() and _interaction_enabled
	match _status:
		&"completed":
			_state_caption.text = ""
			_inspect_hint.text = "已完成 · 查看结果"
		&"failed":
			_state_caption.text = "失败"
			_inspect_hint.text = "执行失败 · 查看详情"
		&"cancelled":
			_state_caption.text = "停止"
			_inspect_hint.text = "已停止 · 查看记录"
		_:
			_state_caption.text = ""
			_inspect_hint.text = "查看任务"
	_inspect_area.accessibility_name = _inspect_hint.text
	_state_caption.visible = _has_marker() and not _state_caption.text.is_empty()
	_state_caption.modulate.a = _intensity
	_sync_hint()
	queue_redraw()

func _sync_hint() -> void:
	_inspect_hint.visible = _inspect_area.visible and (_inspect_area.is_hovered() or _inspect_area.has_focus())

func _process(delta: float) -> void:
	# The Controller's Run lifetime includes streaming gaps and tool execution.
	# Neither token arrival cadence nor this loop is a progress estimate.
	_intensity = move_toward(_intensity, 1.0 if _has_marker() else 0.0, delta * 5.0)
	if is_running(): _phase = fmod(_phase + delta * 1.8, TAU)
	_result_age = minf(_result_age + delta, 0.45)
	_state_caption.modulate.a = _intensity
	# Terminal badges stay readable without an endless completion loop.
	if not is_running() and _result_age >= 0.45 and (is_zero_approx(_intensity) or is_equal_approx(_intensity, 1.0)):
		set_process(false)
	queue_redraw()

func _draw() -> void:
	if _intensity <= 0.0: return
	# One fixed world-space marker above the workstation, not new furniture.
	var center := _inspect_area.position + _inspect_area.size * 0.5
	var rim := Color(0.73, 0.53, 0.27, _intensity)
	var fill := Color(0.16, 0.105, 0.055, 0.94 * _intensity)
	draw_circle(center + Vector2(0, 2), 22, Color(0.035, 0.025, 0.015, 0.35 * _intensity))
	draw_circle(center, 21, fill)
	draw_arc(center, 21, 0, TAU, 48, rim, 1.5, true)
	draw_arc(center + Vector2(0, 0.5), 19, PI * 1.1, PI * 1.9, 24, Color(0.95, 0.79, 0.47, 0.45 * _intensity), 0.8, true)
	var tail := PackedVector2Array([center + Vector2(-4, 20), center + Vector2(0, 26), center + Vector2(4, 20)])
	draw_colored_polygon(tail, fill)
	draw_polyline(tail, rim, 1.3, true)
	if not is_running():
		_draw_result(center, rim)
		return
	_draw_gear(center + Vector2(0, -4))
	for dot: int in range(3):
		var beat := maxf(0.0, sin(_phase * 2.0 - dot * 0.8))
		var point := center + Vector2((dot - 1) * 7, 11 - beat * 2.5)
		draw_circle(point, 1.6 + beat * 0.25, Color(0.96, 0.79, 0.43, (0.42 + beat * 0.58) * _intensity))

func _draw_result(center: Vector2, color: Color) -> void:
	match _status:
		&"completed":
			# Approved warm-brass imprint: tapered edges and quiet relief, sharing
			# the running bubble's brown face instead of a green success panel.
			var reveal := clampf(_result_age / 0.28, 0.0, 1.0)
			var stamp_scale := 0.88 + 0.12 * sin(reveal * PI * 0.5)
			var stamp := PackedVector2Array([Vector2(-10, -1), Vector2(-8, -3), Vector2(-2, 3), Vector2(9, -9), Vector2(12, -10), Vector2(11, -7), Vector2(-1, 8), Vector2(-3, 8)])
			var shadow := PackedVector2Array()
			for vertex: int in range(stamp.size()):
				stamp[vertex] = center + stamp[vertex] * stamp_scale
				shadow.append(stamp[vertex] + Vector2(0.25, 0.65))
			draw_colored_polygon(shadow, Color(0.07, 0.04, 0.015, 0.6 * reveal * _intensity))
			draw_colored_polygon(stamp, Color(0.84, 0.62, 0.3, reveal * _intensity))
			draw_polyline(PackedVector2Array([stamp[0], stamp[1], stamp[2], stamp[3], stamp[4]]), Color(0.98, 0.8, 0.45, 0.6 * reveal * _intensity), 0.6, true)
		&"failed":
			draw_line(center + Vector2(0, -14), center + Vector2(0, -4), color, 3.0, true)
			draw_circle(center + Vector2(0, 1), 1.8, color)
		&"cancelled":
			draw_rect(Rect2(center + Vector2(-6, -13), Vector2(12, 12)), color)

func _draw_gear(center: Vector2) -> void:
	var outline := PackedVector2Array()
	for vertex: int in range(32):
		var radius := 10.0 if vertex % 4 in [1, 2] else 7.6
		outline.append(center + Vector2.from_angle(_phase + vertex * TAU / 32) * radius)
	draw_colored_polygon(outline, Color(0.79, 0.59, 0.29, _intensity))
	outline.append(outline[0])
	draw_polyline(outline, Color(0.96, 0.8, 0.46, 0.75 * _intensity), 0.8, true)
	draw_circle(center, 5.2, Color(0.24, 0.16, 0.08, _intensity))
	for spoke: int in range(3):
		var direction := Vector2.from_angle(_phase + spoke * TAU / 3)
		draw_line(center + direction * 1.8, center + direction * 5.8, Color(0.86, 0.67, 0.34, _intensity), 1.3, true)
	draw_circle(center, 1.7, Color(0.99, 0.87, 0.6, _intensity))

func global_focus_bounds() -> Rect2:
	return global_transform * focus_bounds
