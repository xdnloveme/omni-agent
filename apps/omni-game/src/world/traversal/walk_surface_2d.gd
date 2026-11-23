@tool
class_name WalkSurface2D
extends StaticBody2D

@export var surface_points := PackedVector2Array():
	set(value):
		surface_points = value
		_sync_derived_geometry()
@export_range(1.0, 128.0, 1.0) var collision_depth := 24.0:
	set(value):
		collision_depth = value
		_sync_derived_geometry()
@export var one_way := true:
	set(value):
		one_way = value
		_sync_derived_geometry()
@export var debug_visible := false:
	set(value):
		debug_visible = value
		queue_redraw()

func _ready() -> void:
	_sync_derived_geometry()

func _draw() -> void:
	if not debug_visible or surface_points.size() < 2:
		return
	draw_polyline(surface_points, Color(0.2, 0.95, 0.65, 0.95), 3.0, true)
	for point: Vector2 in surface_points:
		draw_circle(point, 4.0, Color(1.0, 0.78, 0.2, 1.0))

func sample_surface_y(local_x: float) -> float:
	if not contains_x(local_x):
		return NAN
	if is_equal_approx(local_x, surface_points[0].x):
		return surface_points[0].y
	for index: int in range(1, surface_points.size()):
		var left := surface_points[index - 1]
		var right := surface_points[index]
		if local_x <= right.x:
			var width := right.x - left.x
			if is_zero_approx(width):
				return right.y
			return lerpf(left.y, right.y, (local_x - left.x) / width)
	return NAN

func contains_x(local_x: float) -> bool:
	return (
		surface_points.size() >= 2
		and local_x >= surface_points[0].x
		and local_x <= surface_points[-1].x
	)

func derived_polygon() -> PackedVector2Array:
	var polygon := PackedVector2Array(surface_points)
	for index: int in range(surface_points.size() - 1, -1, -1):
		polygon.append(surface_points[index] + Vector2.DOWN * collision_depth)
	return polygon

func _sync_derived_geometry() -> void:
	queue_redraw()
	if not is_inside_tree():
		return
	var collision := get_node_or_null("CollisionPolygon2D") as CollisionPolygon2D
	if collision == null:
		return
	if surface_points.size() < 2:
		collision.polygon = PackedVector2Array()
		return
	assert(_points_are_ordered(), "WalkSurface2D points must be ordered by x")
	collision.polygon = derived_polygon()
	collision.one_way_collision = one_way
	collision.one_way_collision_margin = 8.0

func _points_are_ordered() -> bool:
	for index: int in range(1, surface_points.size()):
		if surface_points[index].x <= surface_points[index - 1].x:
			return false
	return true
