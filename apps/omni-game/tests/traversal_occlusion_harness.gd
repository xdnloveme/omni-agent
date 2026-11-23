extends Node

@onready var _world: WorkshopWorld = $WorkshopWorld
@onready var _environment: Sprite2D = $WorkshopWorld/Visual/Environment
@onready var _upper_foreground: Sprite2D = $WorkshopWorld/Visual/UpperForeground
@onready var _bridge: Sprite2D = $WorkshopWorld/Visual/BridgeDeck
@onready var _decoration: Sprite2D = $WorkshopWorld/Visual/BridgeDecoration
@onready var _edge_foreground: Sprite2D = $WorkshopWorld/Visual/EdgeFoliageForeground
@onready var _upper: WalkSurface2D = $WorkshopWorld/TraversalMap/UpperSurface

func _ready() -> void:
	if not _verify_visual_contract() or not _verify_route_contract():
		get_tree().quit(1)
		return
	print(JSON.stringify({"type": "workshop_occlusion_verified", "version": 1}))
	get_tree().quit(0)

func _verify_visual_contract() -> bool:
	var upper_foreground: Texture2D = load(
		"res://assets/environment/workshop/workshop-rails-stylized.png"
	)
	var approved_background: Texture2D = load(
		"res://assets/environment/workshop/workshop-backplate-stylized.png"
	)
	var edge_foreground: Texture2D = load(
		"res://assets/environment/workshop/workshop-edge-foliage-foreground.png"
	)
	if upper_foreground == null or upper_foreground.get_size() != Vector2(2400.0, 960.0):
		return _fail("Upper foreground does not match the Workshop master")
	if approved_background == null or _environment.texture != approved_background:
		return _fail("Workshop does not use the approved composite background")
	if edge_foreground == null or edge_foreground.get_size() != Vector2(2400.0, 960.0):
		return _fail("Edge foliage foreground does not match the Workshop master")
	if (
		_environment.z_index != -20
		or _decoration.z_index != -18
		or _bridge.z_index != 5
		or _upper_foreground.z_index != 5
		or _edge_foreground.z_index != 10
	):
		return _fail("Workshop semantic z-order is invalid")
	if (
		_environment.position != _upper_foreground.position
		or _environment.rotation != _upper_foreground.rotation
		or _environment.skew != _upper_foreground.skew
		or _environment.offset != _upper_foreground.offset
		or _environment.centered != _upper_foreground.centered
		or _environment.texture_filter != _upper_foreground.texture_filter
	):
		return _fail("Upper foreground is not pixel-registered with the background")
	if _upper_foreground.material != null:
		return _fail("Upper foreground must be a direct RGBA layer")
	if not (_environment.texture.get_size() * _environment.scale).is_equal_approx(Vector2(2400, 960)):
		return _fail("Native-resolution background is not registered to the world canvas")
	if _upper_foreground.texture != upper_foreground or _upper_foreground.scale != Vector2.ONE:
		return _fail("Authored rails changed their registered footprint")
	if (
		_bridge.texture.resource_path != "res://assets/environment/workshop/workshop-bridge-stylized.png"
		or _bridge.position != Vector2(1087, 278)
		or _bridge.scale != Vector2(0.25, 0.25)
		or _bridge.texture.get_size() != Vector2(640, 172)
		or _bridge.centered or _bridge.material != null
		or _bridge.texture_filter != _upper_foreground.texture_filter
	):
		return _fail("Independent bridge sprite lost its approved footprint or alpha rendering")
	if (
		_decoration.texture.resource_path != "res://assets/environment/workshop/workshop-bridge-decoration.png"
		or _decoration.texture.get_size() != Vector2(2400, 960)
		or _decoration.centered or _decoration.position != Vector2.ZERO
		or _decoration.scale != Vector2.ONE
	):
		return _fail("Bridge ropes are not a registered background-only layer")

	var image := upper_foreground.get_image()
	var background_image := _environment.texture.get_image()
	if image == null or image.get_size() != Vector2i(2400, 960):
		return _fail("Upper foreground could not be inspected")
	if background_image == null or background_image.get_size() != Vector2i(1983, 793):
		return _fail("Workshop background could not be compared with its foreground")
	for required_region: Rect2i in [
		Rect2i(110, 235, 160, 70),
		Rect2i(590, 230, 300, 75),
		Rect2i(1280, 230, 400, 75),
	]:
		if not _region_has_alpha(image, required_region, 0.5):
			return _fail("A coherent guardrail or bridge foreground region is missing")
	if _region_alpha_count(image, Rect2i(1087, 278, 147, 43), 0.01) != 0:
		return _fail("Rail layer contains an obsolete duplicate bridge")
	var bridge_image := _bridge.texture.get_image()
	if not _region_has_alpha(bridge_image, Rect2i(240, 80, 160, 92), 0.5):
		return _fail("Separate bridge deck has no opaque center planks")
	if _region_alpha_count(image, Rect2i(442, 218, 127, 82), 0.05) != 0:
		return _fail("Bed lane incorrectly contains a foreground guard rail")
	if _region_alpha_count(image, Rect2i(960, 215, 32, 85), 0.5) > 8:
		return _fail("Upper ladder exit is blocked by the left guardrail endpoint")
	if _region_alpha_count(image, Rect2i(1000, 240, 80, 32), 0.05) != 0:
		return _fail("Bridge hand ropes must remain behind the actor")
	if _region_alpha_count(image, Rect2i(0, 350, 2400, 610), 0.01) != 0:
		return _fail("Upper foreground leaked outside the upper-floor band")

	var visible_samples := 0
	var total_samples := 0
	for y: int in range(0, image.get_height(), 4):
		for x: int in range(0, image.get_width(), 4):
			total_samples += 1
			if image.get_pixel(x, y).a > 0.1:
				visible_samples += 1
	var coverage := float(visible_samples) / float(total_samples)
	if coverage < 0.01 or coverage > 0.08:
		return _fail("Upper foreground coverage indicates a missing or rectangular crop: %s" % coverage)

	var foliage_image := edge_foreground.get_image()
	if foliage_image == null or foliage_image.get_size() != Vector2i(2400, 960):
		return _fail("Edge foliage foreground could not be inspected")
	if foliage_image.get_pixel(0, 850).a < 0.1:
		return _fail("Edge foliage lost its authored screen-edge anchor")
	if (
		foliage_image.get_pixel(160, 850).a > 0.1
		or foliage_image.get_pixel(2240, 850).a > 0.1
		or foliage_image.get_pixel(1200, 900).a > 0.01
	):
		return _fail("Edge foliage retains the obsolete rectangular lower-band cut")
	return true

func _verify_route_contract() -> bool:
	var expected := PackedVector2Array([
		Vector2(96.0, 296.0), Vector2(180.0, 295.0), Vector2(320.0, 295.0),
		Vector2(500.0, 295.0), Vector2(700.0, 295.0), Vector2(900.0, 295.0),
		Vector2(998.0, 296.0), Vector2(1016.0, 296.0), Vector2(1040.0, 294.0),
		Vector2(1064.0, 292.0), Vector2(1088.0, 289.0), Vector2(1100.0, 291.0),
		Vector2(1112.0, 293.0), Vector2(1124.0, 295.0), Vector2(1136.0, 297.0),
		Vector2(1148.0, 299.0), Vector2(1160.0, 300.0), Vector2(1172.0, 299.0),
		Vector2(1184.0, 297.0), Vector2(1196.0, 294.0), Vector2(1208.0, 291.0),
		Vector2(1220.0, 288.0), Vector2(1232.0, 285.0), Vector2(1244.0, 286.0),
		Vector2(1260.0, 290.0), Vector2(1300.0, 293.0), Vector2(1400.0, 295.0),
		Vector2(1580.0, 295.0), Vector2(1778.0, 296.0),
	])
	if _upper.surface_points != expected:
		return _fail("Upper route diverges from the calibrated bridge contact surface")
	if _upper.sample_surface_y(1160.0) != 300.0:
		return _fail("Bridge center does not follow the visible sag")
	if (
		_upper.sample_surface_y(1088.0) != 289.0
		or _upper.sample_surface_y(1244.0) != 286.0
	):
		return _fail("Bridge route does not join both platform surfaces without a step")
	var points := _upper.surface_points
	for index: int in range(1, points.size()):
		if absf(points[index].y - points[index - 1].y) > 7.0:
			return _fail("Bridge route contains an abrupt vertical seam")
	if not is_nan(_upper.sample_surface_y(1778.1)):
		return _fail("Upper route extends into open sky")
	return true

func _fail(message: String) -> bool:
	push_error(message)
	return false

func _region_has_alpha(image: Image, region: Rect2i, threshold: float) -> bool:
	return _region_alpha_count(image, region, threshold) > 0

func _region_alpha_count(image: Image, region: Rect2i, threshold: float) -> int:
	var count := 0
	for y: int in range(region.position.y, region.end.y):
		for x: int in range(region.position.x, region.end.x):
			if image.get_pixel(x, y).a > threshold:
				count += 1
	return count
