@tool
class_name LadderRoute2D
extends Area2D

signal body_availability_changed(body: Node2D, route: Node, available: bool)

@export var top_y := 0.0:
	set(value):
		top_y = value
		_sync_derived_geometry()
@export var bottom_y := 200.0:
	set(value):
		bottom_y = value
		_sync_derived_geometry()
@export_range(16.0, 160.0, 1.0) var interaction_width := 90.0:
	set(value):
		interaction_width = value
		_sync_derived_geometry()
@export_range(0.0, 96.0, 1.0) var endpoint_detection_padding := 36.0:
	set(value):
		endpoint_detection_padding = value
		_sync_derived_geometry()
@export_node_path("StaticBody2D") var top_surface_path: NodePath
@export_node_path("StaticBody2D") var bottom_surface_path: NodePath
@export var visual_texture: Texture2D:
	set(value):
		visual_texture = value
		_sync_visual()
@export var debug_visible := false:
	set(value):
		debug_visible = value
		queue_redraw()

var _top_surface: StaticBody2D
var _bottom_surface: StaticBody2D

func _ready() -> void:
	_top_surface = get_node(top_surface_path) as StaticBody2D
	_bottom_surface = get_node(bottom_surface_path) as StaticBody2D
	body_entered.connect(_on_body_entered)
	body_exited.connect(_on_body_exited)
	_sync_derived_geometry()

func _draw() -> void:
	if not debug_visible:
		return
	draw_line(Vector2(0.0, top_y), Vector2(0.0, bottom_y), Color(0.3, 0.75, 1.0), 4.0)
	for point: Vector2 in [Vector2(0.0, top_y), Vector2(0.0, bottom_y)]:
		draw_circle(point, 5.0, Color(1.0, 0.45, 0.2))
	var visual := get_node_or_null("LadderVisual") as Sprite2D
	if visual != null and visual.texture != null:
		var image := visual.texture.get_image()
		if image != null:
			var used_rect := image.get_used_rect()
			if used_rect.has_area():
				var texture_size := visual.texture.get_size()
				var visible_position := (
					visual.position
					+ (Vector2(used_rect.position) - texture_size * 0.5) * visual.scale
				)
				var visible_size := Vector2(used_rect.size) * visual.scale
				draw_rect(
					Rect2(visible_position, visible_size),
					Color(0.95, 0.85, 0.25),
					false,
					2.0,
				)

func top_point() -> Vector2:
	return global_position + Vector2(0.0, top_y)

func center_x() -> float:
	return global_position.x

func bottom_point() -> Vector2:
	return global_position + Vector2(0.0, bottom_y)

func connected_surfaces() -> Array[StaticBody2D]:
	return [_top_surface, _bottom_surface]

func _sync_derived_geometry() -> void:
	queue_redraw()
	_sync_visual()
	if not is_inside_tree():
		return
	var collision := get_node_or_null("CollisionShape2D") as CollisionShape2D
	if collision == null:
		return
	var rectangle := collision.shape as RectangleShape2D
	if rectangle == null:
		return
	# Detection extends beyond the authored endpoints so a grounded body whose feet
	# merely touch a floor still overlaps the ladder. Route endpoints remain exact.
	var height := maxf(bottom_y - top_y, 1.0) + endpoint_detection_padding * 2.0
	rectangle.size = Vector2(interaction_width, height)
	collision.position = Vector2(0.0, (top_y + bottom_y) * 0.5)

func _sync_visual() -> void:
	if not is_inside_tree():
		return
	var visual := get_node_or_null("LadderVisual") as Sprite2D
	if visual == null:
		return
	visual.texture = visual_texture
	visual.position = Vector2(0.0, (top_y + bottom_y) * 0.5)
	if visual_texture == null or visual_texture.get_height() <= 0:
		visual.scale = Vector2.ONE
		return
	visual.scale = Vector2(1.0, (bottom_y - top_y) / visual_texture.get_height())

func _on_body_entered(body: Node2D) -> void:
	body_availability_changed.emit(body, self, true)

func _on_body_exited(body: Node2D) -> void:
	body_availability_changed.emit(body, self, false)
