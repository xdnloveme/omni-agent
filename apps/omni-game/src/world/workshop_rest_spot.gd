class_name WorkshopRestSpot
extends Node2D
## Furniture-local presentation and contact geometry. The actor owns occupancy;
## no physical body, task or Session is moved or created here.
@export var interaction_id: StringName
@export var resting_prompt := "醒来"
@export var idle_prompt := "睡觉"
@export_node_path("Marker2D") var standing_contact_path: NodePath
@export var source_size := Vector2(260, 185)
@export var fixed_outline: PackedVector2Array
@export var empty_texture: Texture2D
@export var focus_bounds := Rect2(22, 10, 245, 160)
@export var snore_enabled := true

var _occupied_surface: Polygon2D
var _resting := false
var _elapsed := 0.0
var _snore_origin := Vector2.ZERO

func _ready() -> void:
	assert(not interaction_id.is_empty() and source_size.x > 0.0 and source_size.y > 0.0)
	assert(get_node(standing_contact_path) is Marker2D)
	if empty_texture != null:
		assert(fixed_outline.size() >= 3)
		_set_texture(_create_surface(fixed_outline), empty_texture)
	_occupied_surface = _create_surface(PackedVector2Array())
	_occupied_surface.visible = false
	set_process(false)

func _create_surface(outline: PackedVector2Array) -> Polygon2D:
	var surface := Polygon2D.new()
	surface.polygon = outline
	surface.antialiased = true
	# Both pieces render before this node's animated snore bubble strokes.
	surface.show_behind_parent = true
	surface.texture_filter = CanvasItem.TEXTURE_FILTER_LINEAR
	add_child(surface)
	return surface

func _set_texture(surface: Polygon2D, texture: Texture2D) -> void:
	surface.texture = texture
	var coordinates := PackedVector2Array()
	if texture != null:
		for point in surface.polygon:
			coordinates.append(point * texture.get_size() / source_size)
	surface.uv = coordinates

func configure(appearance: CharacterRestAppearance) -> void:
	if appearance == null:
		_occupied_surface.polygon = PackedVector2Array()
		_set_texture(_occupied_surface, null)
		_snore_origin = Vector2.ZERO
		return
	assert(appearance.texture != null and appearance.occupied_outline.size() >= 3)
	_occupied_surface.polygon = appearance.occupied_outline
	_set_texture(_occupied_surface, appearance.texture)
	_snore_origin = appearance.snore_origin

func has_rest_art() -> bool:
	return _occupied_surface.texture != null

func standing_contact() -> Vector2:
	return get_node(standing_contact_path).global_position

func is_resting() -> bool:
	return _resting

func set_resting(resting: bool) -> void:
	if _resting == resting: return
	_resting = resting
	_elapsed = 0.0
	_occupied_surface.visible = resting
	set_process(resting and snore_enabled)
	queue_redraw()

func global_focus_bounds() -> Rect2:
	return global_transform * focus_bounds

func _process(delta: float) -> void:
	_elapsed = fmod(_elapsed + delta, 3.4)
	queue_redraw()

func _draw() -> void:
	if not _resting or not snore_enabled: return
	var progress := _elapsed / 3.4
	var opacity := sin(progress * PI) * 0.85
	var center := _snore_origin + Vector2(12, -20) * progress
	var radius := lerpf(1.5, 8.0, progress)
	draw_circle(center, radius, Color(0.8, 0.92, 0.91, opacity * 0.3))
	draw_arc(center, radius + 0.45, 0.0, TAU, 32, Color(0.25, 0.32, 0.27, opacity * 0.65), 1.0, true)
	draw_arc(center, radius, 0.0, TAU, 32, Color(0.95, 0.98, 0.87, opacity), 0.7, true)
	draw_arc(center, radius * 0.62, PI * 1.1, PI * 1.55, 12, Color(1.0, 1.0, 0.95, opacity), 0.7, true)
