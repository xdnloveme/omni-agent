@tool
class_name VisibleBlocker2D
extends StaticBody2D

@export var blocker_size := Vector2(40.0, 120.0):
	set(value):
		blocker_size = value
		_sync_geometry()
@export var debug_visible := false:
	set(value):
		debug_visible = value
		queue_redraw()

func _ready() -> void:
	_sync_geometry()

func _draw() -> void:
	if not debug_visible:
		return
	draw_rect(Rect2(-blocker_size * 0.5, blocker_size), Color(1.0, 0.25, 0.2, 0.22), true)
	draw_rect(Rect2(-blocker_size * 0.5, blocker_size), Color(1.0, 0.35, 0.2), false, 3.0)

func _sync_geometry() -> void:
	queue_redraw()
	if not is_inside_tree():
		return
	var collision := get_node_or_null("CollisionShape2D") as CollisionShape2D
	if collision == null:
		return
	var rectangle := collision.shape as RectangleShape2D
	if rectangle != null:
		rectangle.size = blocker_size
