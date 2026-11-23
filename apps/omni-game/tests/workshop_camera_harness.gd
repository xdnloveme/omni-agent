extends Node

@onready var _target: Node2D = $Target
@onready var _rig: WorkshopCameraRig = $WorkshopCameraRig

func _ready() -> void:
	# The headless display starts with a square dummy window. Establish the
	# authored 16:10 reference before asserting exact camera coordinates.
	get_window().size = Vector2i(1440, 900)
	_rig.set_target(_target)
	await get_tree().process_frame
	if _rig.target_position_for(Vector2(-100.0, 669.0)) != Vector2(720.0, 450.0):
		_fail("Camera did not clamp the left world edge: viewport=%s target=%s" % [get_viewport().get_visible_rect().size, _rig.target_position_for(Vector2(-100.0,669.0))])
		return
	if _rig.target_position_for(Vector2(2600.0, 669.0)) != Vector2(1680.0, 450.0):
		_fail("Camera did not clamp the right world edge")
		return
	if _rig.target_position_for(Vector2(1200.0, 872.0)) != Vector2(1200.0, 510.0):
		_fail("Camera did not compose the lower floor with the reserved margin")
		return
	var transition := _rig.target_position_for(Vector2(1200.0, 755.0)).y
	if transition <= 450.0 or transition >= 510.0:
		_fail("Camera floor transition is not smoothly interpolated")
		return
	_target.global_position = Vector2(1400.0, 872.0)
	_rig.snap_to_target()
	if _rig.global_position.distance_to(Vector2(1400.0, 510.0)) > 1.0:
		_fail("Camera snap did not converge to the exact target")
		return
	get_window().size = Vector2i(1920, 1080)
	await get_tree().process_frame
	if get_viewport().get_visible_rect().size != Vector2(1600,900):
		_fail("Widescreen must expand horizontally without stretching character proportions")
		return
	if _rig.target_position_for(Vector2(2600,669)) != Vector2(1600,450):
		_fail("Widescreen camera did not clamp its actual visible right edge")
		return
	get_tree().quit(0)

func _fail(message: String) -> void:
	printerr(message)
	get_tree().quit(1)
