extends Node

const TIMEOUT_SECONDS := 45.0

@onready var _world: WorkshopWorld = $WorkshopWorld
@onready var _actor: PartnerActor = $WorkshopWorld/PartnerActor
@onready var _visual: AnimatedSprite2D = $WorkshopWorld/PartnerActor/CharacterVisual
@onready var _actor_collision: CollisionShape2D = $WorkshopWorld/PartnerActor/CollisionShape2D
@onready var _map: Node2D = $WorkshopWorld/TraversalMap
@onready var _upper: StaticBody2D = $WorkshopWorld/TraversalMap/UpperSurface
@onready var _middle: StaticBody2D = $WorkshopWorld/TraversalMap/MiddleSurface
@onready var _lower: StaticBody2D = $WorkshopWorld/TraversalMap/LowerSurface
@onready var _upper_ladder: LadderRoute2D = $WorkshopWorld/TraversalMap/UpperLadder
@onready var _lower_ladder: LadderRoute2D = $WorkshopWorld/TraversalMap/LowerLadder
@onready var _spawn: Marker2D = $WorkshopWorld/TraversalMap/PartnerSpawn
@onready var _left_blocker: VisibleBlocker2D = $WorkshopWorld/TraversalMap/LowerLeftBlocker
@onready var _right_blocker: VisibleBlocker2D = $WorkshopWorld/TraversalMap/LowerRightBlocker
@onready var _upper_left_blocker: VisibleBlocker2D = $WorkshopWorld/TraversalMap/UpperLeftBlocker
@onready var _upper_right_blocker: VisibleBlocker2D = $WorkshopWorld/TraversalMap/UpperRightBlocker
@onready var _recovery: OutOfBoundsRecovery = $WorkshopWorld/TraversalMap/OutOfBoundsRecovery
@onready var _camera_rig: WorkshopCameraRig = $WorkshopWorld/WorkshopCameraRig
@onready var _environment: Sprite2D = $WorkshopWorld/Visual/Environment
@onready var _upper_foreground: Sprite2D = $WorkshopWorld/Visual/UpperForeground
@onready var _edge_foreground: Sprite2D = $WorkshopWorld/Visual/EdgeFoliageForeground

var _failed := false
var _walk_sample := {}

func _ready() -> void:
	get_tree().create_timer(TIMEOUT_SECONDS).timeout.connect(
		func() -> void: _fail("Timed out verifying Workshop traversal")
	)
	await _verify_world()
	if not _failed:
		get_tree().quit(0)

func _verify_world() -> void:
	if not _verify_route_contract():
		return
	if not _verify_animation_resources():
		return

	var presentation: CharacterPresentation = load("res://resources/characters/coding.tres")
	_world.enter_workspace(presentation)
	_world.set_input_enabled(true)
	await _physics_frames(8)
	if not _world.is_active() or not _world.visible:
		_fail("WorkshopWorld did not enter its active state")
		return

	var capsule := _actor_collision.shape as CapsuleShape2D
	if not is_zero_approx(_actor_collision.position.y + capsule.height * 0.5):
		_fail("PartnerActor origin is not the collision foot baseline")
		return
	if not _spawn.global_position.is_equal_approx(Vector2(860.0, 669.0)):
		_fail("Traversal map spawn is not aligned to the middle surface")
		return
	if (
		not _actor.floor_constant_speed
		or not _actor.floor_stop_on_slope
		or not is_equal_approx(_actor.floor_snap_length, 8.0)
	):
		_fail("PartnerActor slope-following settings are incomplete")
		return

	if not await _wait_until(func() -> bool: return _actor.is_on_floor(), 60):
		_fail("PartnerActor did not settle on the middle surface")
		return
	if absf(_actor.global_position.y - 669.0) > 2.0:
		_fail("PartnerActor feet are not aligned to the middle surface")
		return

	_walk_sample = await _sample_walk_cycle()
	if _walk_sample.is_empty():
		return
	if not await _verify_interaction_points():
		return

	_world.set_input_enabled(false)
	var locked_position := _actor.global_position
	Input.action_press("move_right")
	await _physics_frames(8)
	Input.action_release("move_right")
	if not _actor.global_position.is_equal_approx(locked_position):
		_fail("PartnerActor moved while world input was disabled")
		return
	_world.set_input_enabled(true)

	if not await _verify_jump():
		return
	if not await _verify_airborne_ladder_entry_is_deferred():
		return
	if not await _verify_vertical_ladder_endpoints():
		return
	if not await _verify_upper_ladder_and_bridge():
		return
	if not await _verify_lower_ladder_and_floor():
		return
	if not await _verify_recovery():
		return
	print(
		JSON.stringify(
			{
				"type": "workshop_locomotion_sample",
				"walk": _walk_sample,
				"bridge_sag_pixels": (
					_upper.sample_surface_y(1160.0) - _upper.sample_surface_y(1088.0)
				),
				"lower_surface_y": _lower.sample_surface_y(720.0),
			}
		)
	)

	_world.leave_workspace()
	if _world.is_active() or _world.visible or _actor.ignored_surface_count() != 0:
		_fail("Workspace cleanup left traversal state reachable")

func _verify_route_contract() -> bool:
	for surface: StaticBody2D in [_upper, _middle, _lower]:
		var points: PackedVector2Array = surface.surface_points
		if points.size() < 2:
			_fail("WalkSurface2D has no authored route")
			return false
		for index: int in range(1, points.size()):
			if points[index].x <= points[index - 1].x:
				_fail("WalkSurface2D points are not ordered by x")
				return false
		var collision := surface.get_node("CollisionPolygon2D") as CollisionPolygon2D
		if collision.polygon != surface.derived_polygon() or not collision.one_way_collision:
			_fail("WalkSurface2D derived collision diverges from its route points")
			return false

	var upper_points: PackedVector2Array = _upper.surface_points
	var bridge_middle_y: float = _upper.sample_surface_y(1160.0)
	if (
		upper_points[0] != Vector2(96.0, 296.0)
		or upper_points[-1] != Vector2(1778.0, 296.0)
		or bridge_middle_y != 300.0
	):
		_fail("Upper route does not contain the authored bridge sag")
		return false
	if (
		_middle.surface_points != PackedVector2Array([Vector2(0.0, 669.0), Vector2(2400.0, 669.0)])
		or _lower.surface_points != PackedVector2Array([Vector2(110.0, 876.0), Vector2(2290.0, 876.0)])
	):
		_fail("Middle or lower route does not match the authored playable bounds")
		return false
	if (
		not _upper.contains_x(96.0)
		or not _upper.contains_x(1778.0)
		or _upper.contains_x(1778.1)
		or not is_nan(_upper.sample_surface_y(1778.1))
	):
		_fail("WalkSurface2D did not reject an out-of-range sky sample")
		return false
	if (
		_upper_ladder.top_point() != Vector2(1016.0, 296.0)
		or _upper_ladder.bottom_point() != Vector2(1016.0, 669.0)
		or _lower_ladder.top_point() != Vector2(720.0, 669.0)
		or _lower_ladder.bottom_point() != Vector2(720.0, 876.0)
		or absf(_upper_ladder.global_position.x - _lower_ladder.global_position.x) < 200.0
	):
		_fail("Ladder routes are not calibrated")
		return false
	for ladder: LadderRoute2D in [_upper_ladder, _lower_ladder]:
		var ladder_visual := ladder.get_node("LadderVisual") as Sprite2D
		var visual_height := ladder_visual.texture.get_height() * ladder_visual.scale.y
		if (
			absf(ladder_visual.global_position.x - ladder.center_x()) > 3.0
			or absf(visual_height - (ladder.bottom_y - ladder.top_y)) > 3.0
		):
			_fail("Ladder visual and route do not share one coordinate system")
			return false
	if (
		_upper_left_blocker.position != Vector2(96.0, 264.0)
		or _upper_right_blocker.position.x != upper_points[-1].x
		or _upper_right_blocker.position.y != 264.0
		or _upper_left_blocker.blocker_size != Vector2(38.0, 64.0)
		or _upper_right_blocker.blocker_size != Vector2(38.0, 64.0)
		or _left_blocker.position != Vector2(90.0, 910.0)
		or _right_blocker.position != Vector2(2310.0, 910.0)
		or _recovery.position.y <= 960.0
	):
		_fail("Lower-floor blockers or recovery boundary are not visibly bounded")
		return false
	if _actor.collision_layer != 1 or _actor.collision_mask != 3:
		_fail("PartnerActor physics-layer contract changed")
		return false
	var background: Texture2D = load(
		"res://assets/environment/workshop/workshop-backplate-stylized.png"
	)
	var edge_foreground: Texture2D = load(
		"res://assets/environment/workshop/workshop-edge-foliage-foreground.png"
	)
	var upper_foreground: Texture2D = load(
		"res://assets/environment/workshop/workshop-rails-stylized.png"
	)
	var sky_mask: Texture2D = load(
		"res://assets/environment/workshop/workshop-sky-mask.png"
	)
	if (
		background.get_size() != Vector2(1983.0, 793.0)
		or not (background.get_size() * _environment.scale).is_equal_approx(Vector2(2400, 960))
		or edge_foreground.get_size() != Vector2(2400.0, 960.0)
		or upper_foreground.get_size() != Vector2(2400.0, 960.0)
		or sky_mask.get_size() != Vector2(1200.0, 480.0)
	):
		_fail("Workshop visual-layer assets do not match the world contract")
		return false
	if (
		_environment.z_index >= _upper_foreground.z_index
		or _upper_foreground.z_index >= _edge_foreground.z_index
		or _upper_foreground.texture != upper_foreground
		or _edge_foreground.texture != edge_foreground
	):
		_fail("Workshop foreground sprites violate the semantic visual-layer contract")
		return false
	return true

func _sample_walk_cycle() -> Dictionary:
	var animation_set: Resource = load("res://resources/characters/coding-animation-set.tres")
	var target_distance: float = animation_set.walk_stride_pixels * 1.1
	var start_x := _actor.global_position.x
	var previous_x := start_x
	var max_step := 0.0
	var seen_frames := {}
	Input.action_press("move_right")
	for _index: int in range(120):
		await get_tree().physics_frame
		var step := _actor.global_position.x - previous_x
		previous_x = _actor.global_position.x
		max_step = maxf(max_step, step)
		if step < -0.01:
			Input.action_release("move_right")
			_fail("Ground locomotion regressed while moving right")
			return {}
		if _visual.animation == &"walk":
			seen_frames[_visual.frame] = true
		if _actor.global_position.x - start_x >= target_distance:
			break
	Input.action_release("move_right")
	await _physics_frames(12)
	var expected_walk_frames: int = animation_set.frames.get_frame_count(&"walk")
	if (
		_actor.global_position.x - start_x < target_distance
		or seen_frames.size() != expected_walk_frames
	):
		_fail(
			"Distance-phased walk did not traverse one complete cycle: distance=%s frames=%s expected=%s"
			% [
				_actor.global_position.x - start_x,
				seen_frames.keys(),
				expected_walk_frames,
			]
		)
		return {}
	return {
		"distance_pixels": snappedf(_actor.global_position.x - start_x, 0.01),
		"stride_pixels": animation_set.walk_stride_pixels,
		"frames_seen": seen_frames.size(),
		"max_step_pixels": snappedf(max_step, 0.001),
	}

func _verify_animation_resources() -> bool:
	for resource_path: String in [
		"res://resources/characters/coding.tres",
		"res://resources/characters/financial-analysis.tres",
		"res://resources/characters/fallback.tres",
	]:
		var presentation: CharacterPresentation = load(resource_path)
		var animation_set: Resource = presentation.animation_set
		if (
			animation_set == null
			or animation_set.frames == null
			or animation_set.source_size.x <= 0
			or animation_set.source_size.y <= 0
			or animation_set.foot_anchor.x <= 0.0
			or animation_set.foot_anchor.y <= 0.0
			or animation_set.foot_anchor.x >= animation_set.source_size.x
			or animation_set.foot_anchor.y >= animation_set.source_size.y
			or animation_set.walk_stride_pixels <= 0.0
			or animation_set.climb_stride_pixels <= 0.0
		):
			_fail("CharacterAnimationSet contract is incomplete: %s" % resource_path)
			return false
		var frames: SpriteFrames = animation_set.frames
		var frame_contracts: Array = (
			[[&"idle", 32 if presentation.agent_id == "financial-analysis" else 8], [&"walk", 24 if presentation.agent_id == "financial-analysis" else 4], [&"jump", 33 if presentation.agent_id == "financial-analysis" else 4], [&"climb", 47 if presentation.agent_id == "financial-analysis" else 4]]
		)
		for contract: Array in frame_contracts:
			if frames.get_frame_count(contract[0]) != contract[1]:
				_fail("Animation frame count mismatch: %s:%s" % [resource_path, contract[0]])
				return false
		if presentation.agent_id == "financial-analysis":
			var idle_pixels := frames.get_frame_texture(&"idle", 0).get_image().get_data()
			for index in [0, 28, 29, 30, 31, 32]:
				if frames.get_frame_texture(&"jump", index).get_image().get_data() != idle_pixels:
					_fail("Jump start/settled hold differs from formal idle: %d" % index)
					return false
		var walk_hashes := {}
		var walk_frame_count := frames.get_frame_count(&"walk")
		# Approved walk silhouette snapshot, not a ground-contact measurement.
		# Rolling/angled shoes need not put their lowest pixel on the support line.
		var rose_walk_bottoms := [463, 466, 467, 469, 471, 470, 469, 470, 469, 467, 466, 465,
			465, 465, 465, 464, 464, 463, 463, 463, 463, 462, 462, 462]
		for frame_index: int in range(walk_frame_count):
			var texture := frames.get_frame_texture(&"walk", frame_index)
			if texture == null:
				_fail("Missing walk texture: %s:%s" % [resource_path, frame_index])
				return false
			walk_hashes[hash(texture.get_image().get_data())] = true
			var aligned: bool = (_lowest_foot_pixel(texture.get_image(), animation_set.foot_anchor.y) == rose_walk_bottoms[frame_index]
				if presentation.agent_id == "financial-analysis"
				else _frame_uses_foot_baseline(texture.get_image(), animation_set.foot_anchor.y))
			if not aligned:
				_fail("Walk frame changed its approved foot silhouette: %s:%s" % [resource_path, frame_index])
				return false
		if walk_hashes.size() != walk_frame_count:
			_fail("Walk animation contains duplicated regions or frame content: %s" % resource_path)
			return false
		for frame_index in range(frames.get_frame_count(&"idle")):
			var idle_texture := frames.get_frame_texture(&"idle", frame_index)
			if idle_texture == null or not _frame_uses_foot_baseline(idle_texture.get_image(), animation_set.foot_anchor.y):
				_fail("Idle lost its authored foot baseline: %s" % resource_path)
				return false
	return true

func _frame_uses_foot_baseline(image: Image, foot_anchor_y: float) -> bool:
	var lowest_opaque_y := _lowest_foot_pixel(image, foot_anchor_y)
	return lowest_opaque_y >= floori(foot_anchor_y) - 2 and lowest_opaque_y <= ceili(foot_anchor_y)

func _lowest_foot_pixel(image: Image, foot_anchor_y: float) -> int:
	var lowest_opaque_y := -1
	var scan_start := maxi(floori(foot_anchor_y) - 16, 0)
	for y: int in range(scan_start, image.get_height()):
		for x: int in range(image.get_width()):
			if image.get_pixel(x, y).a > 0.05:
				lowest_opaque_y = maxi(lowest_opaque_y, y)
	return lowest_opaque_y

func _verify_jump() -> bool:
	_actor.reset_to_spawn(_spawn.global_position)
	await _physics_frames(4)
	if not await _wait_until(func() -> bool: return _actor.is_on_floor(), 60):
		_fail("PartnerActor did not settle before jumping")
		return false
	var ground_y := _actor.global_position.y
	Input.action_press("jump")
	await _physics_frames(4)
	Input.action_release("jump")
	if _actor.global_position.y >= ground_y - 8.0:
		_fail("PartnerActor did not jump")
		return false
	if not await _wait_until(func() -> bool: return _actor.is_on_floor(), 120):
		_fail("PartnerActor did not land")
		return false
	return absf(_actor.global_position.y - ground_y) <= 2.0

func _verify_airborne_ladder_entry_is_deferred() -> bool:
	for attempt: Dictionary in [
		{
			"position": Vector2(
				_upper_ladder.center_x(),
				_upper.sample_surface_y(_upper_ladder.center_x()),
			),
			"climb_action": "climb_down",
		},
		{
			"position": Vector2(
				_lower_ladder.center_x(),
				_lower.sample_surface_y(_lower_ladder.center_x()),
			),
			"climb_action": "climb_up",
		},
	]:
		_actor.reset_to_spawn(attempt["position"])
		await _physics_frames(8)
		if not _actor.is_on_floor():
			_fail("PartnerActor did not settle before the airborne ladder-entry check")
			return false
		var climb_action: String = attempt["climb_action"]
		Input.action_press("jump")
		Input.action_press(climb_action)
		await _physics_frames(1)
		Input.action_release("jump")
		var saw_airborne := false
		for _frame: int in range(8):
			await get_tree().physics_frame
			saw_airborne = saw_airborne or not _actor.is_on_floor()
			if _actor.is_climbing():
				Input.action_release(climb_action)
				_fail("Airborne jump entered a ladder before reaching its endpoint")
				return false
		Input.action_release(climb_action)
		if not saw_airborne:
			_fail("Airborne ladder-entry check did not leave the floor")
			return false
		if not await _wait_until(func() -> bool: return _actor.is_on_floor(), 120):
			_fail("PartnerActor did not land after the airborne ladder-entry check")
			return false
	return true

func _verify_interaction_points() -> bool:
	var expected := {
		&"bed": Vector2(470.0, 669.0),
		&"sofa": Vector2(800.0, 669.0),
		&"upper_bed": Vector2(520.0, 295.0),
		&"workbench": Vector2(1460.0, 669.0),
		&"door": Vector2(2040.0, 669.0),
	}
	for interaction_id: StringName in expected:
		_actor.reset_to_spawn(expected[interaction_id])
		await _physics_frames(8)
		if _world.current_interaction_id() != interaction_id:
			_fail("Workshop interaction point is not spatially available: %s" % interaction_id)
			return false
	_actor.reset_to_spawn(_spawn.global_position)
	await _physics_frames(8)
	return true

func _verify_vertical_ladder_endpoints() -> bool:
	for route: LadderRoute2D in [_upper_ladder, _lower_ladder]:
		for from_top: bool in [false, true]:
			var start := route.top_point() if from_top else route.bottom_point()
			var target := route.bottom_point() if from_top else route.top_point()
			var action := "climb_down" if from_top else "climb_up"
			# Broad discovery must not pull a stationary player into the ladder.
			_actor.reset_to_spawn(start + Vector2(12, 0))
			await _physics_frames(12)
			var off_center := _actor.global_position
			Input.action_press(action)
			await _physics_frames(12)
			Input.action_release(action)
			if _actor.is_climbing() or absf(_actor.global_position.x - off_center.x) > 0.1:
				_fail("Ladder pulled an off-center grounded actor sideways")
				return false
			# Reset is a teleport, not walking through an Area2D boundary. Leave
			# discovery first so the next fixture placement emits body_entered.
			_actor.reset_to_spawn(start + Vector2(-200, 0))
			await _physics_frames(4)
			_actor.reset_to_spawn(start)
			await _physics_frames(12)
			Input.action_press(action)
			var climbed := false
			var arrived := false
			var previous := _actor.global_position
			var max_step := 0.0
			for frame: int in range(240):
				await get_tree().physics_frame
				max_step = maxf(max_step, _actor.global_position.distance_to(previous))
				previous = _actor.global_position
				if max_step > _actor.locomotion_config.climb_speed / 60.0 + 1.0:
					_fail("Ladder entry/exit teleported: route=%s down=%s step=%s" % [route.name, from_top, max_step])
					return false
				climbed = climbed or _actor.is_climbing()
				if absf(_actor.global_position.x - route.center_x()) > 0.1:
					_fail("Vertical traversal changed x: %s" % _actor.global_position)
					return false
				if climbed and not _actor.is_climbing() and _actor.is_on_floor():
					arrived = true
					break
			# Keep the same vertical input held: the endpoint must neither slide
			# horizontally nor re-enter the route on the next physics frame.
			await _physics_frames(24)
			Input.action_release(action)
			if not arrived or _actor.is_climbing() or _actor.ignored_surface_count() != 0 or _actor.global_position.distance_to(target) > 3.0:
				_fail("Ladder endpoint did not remain grounded: position=%s target=%s climbed=%s arrived=%s state=%s" % [_actor.global_position, target, climbed, arrived, _actor.movement_state()])
				return false
			print("ladder_continuity_verified: route=%s down=%s max_step=%s" % [route.name, from_top, max_step])
	print("ladder_vertical_verified: both ladders, both directions, continuous entry/exit, no entry pull, no endpoint drift, collision cleanup")
	return true

func _verify_upper_ladder_and_bridge() -> bool:
	_actor.reset_to_spawn(_spawn.global_position)
	await _physics_frames(8)
	# Hold the traversal intent while walking through the actual centerline;
	# stopping near it is no longer an instruction to auto-align sideways.
	Input.action_press("climb_up")
	Input.action_press("move_right")
	var reached_upper := false
	var climbed := false
	var previous := _actor.global_position
	var max_step := 0.0
	for frame: int in range(240):
		var was_climbing := _actor.is_climbing()
		await get_tree().physics_frame
		if was_climbing and not _actor.is_climbing():
			if absf(previous.x - _actor.global_position.x) > 0.1 or absf(previous.y - _upper_ladder.top_point().y) > 3.0:
				_fail("Top exit changed x or finished before the feet reached the platform")
				return false
		max_step = maxf(max_step, _actor.global_position.distance_to(previous))
		previous = _actor.global_position
		climbed = climbed or _actor.is_climbing()
		if not _actor.is_climbing() and _actor.is_on_floor() and absf(_actor.global_position.y - _upper.sample_surface_y(_actor.global_position.x)) <= 3.0:
			reached_upper = true
			break
	Input.action_release("climb_up")
	Input.action_release("move_right")
	if not climbed or max_step > 6.0:
		_fail("Ladder approach failed or physical contact jumped: max_step=%s" % max_step)
		return false
	print("ladder_transition_verified: player-controlled approach and vertical contact, max_step=%s" % max_step)
	if not reached_upper or _actor.ignored_surface_count() != 0:
		_fail("Upper ladder did not exit through the unified cleanup path")
		return false

	if not await _walk_to_x(1244.0, 8.0, 180):
		_fail("PartnerActor could not reach the right bridge entrance")
		return false
	var max_y := _actor.global_position.y
	var start_y := _actor.global_position.y
	var max_visual_contact_error := 0.0
	var max_visual_ground_offset := 0.0
	Input.action_press("move_left")
	for _index: int in range(150):
		await get_tree().physics_frame
		max_y = maxf(max_y, _actor.global_position.y)
		if _upper.contains_x(_actor.global_position.x):
			var expected_surface_y: float = _upper.sample_surface_y(_actor.global_position.x)
			var visual_foot_y: float = _actor.global_position.y + _visual.position.y
			max_visual_contact_error = maxf(
				max_visual_contact_error,
				absf(visual_foot_y - expected_surface_y),
			)
			max_visual_ground_offset = maxf(max_visual_ground_offset, _visual.position.y)
		if _actor.global_position.x <= 1080.0:
			break
	Input.action_release("move_left")
	if (
		_actor.global_position.x > 1080.0
		or max_y < start_y + 10.0
		or not _actor.is_on_floor()
		or max_visual_contact_error > 1.5
		or max_visual_ground_offset < 0.5
	):
		_fail(
			"PartnerActor did not visually follow the authored bridge surface: error=%s offset=%s"
			% [max_visual_contact_error, max_visual_ground_offset]
		)
		return false
	Input.action_press("move_right")
	await _physics_frames(180)
	Input.action_release("move_right")
	if (
		_actor.global_position.x > 1755.0
		or not _actor.is_on_floor()
		or absf(_actor.global_position.y - _upper.sample_surface_y(_actor.global_position.x)) > 3.0
	):
		_fail("Visible upper railing did not bound the authored upper route")
		return false
	if not await _verify_upper_railing_is_jumpable():
		return false
	return true

func _verify_upper_railing_is_jumpable() -> bool:
	for attempt: Dictionary in [
		{
			"start_x": 1580.0,
			"jump_x": 1695.0,
			"move_action": "move_right",
			"crossed": func() -> bool: return _actor.global_position.x > 1810.0,
			"edge": "right",
		},
		{
			"start_x": 300.0,
			"jump_x": 180.0,
			"move_action": "move_left",
			"crossed": func() -> bool: return _actor.global_position.x < 65.0,
			"edge": "left",
		},
	]:
		var start_x: float = attempt["start_x"]
		_actor.reset_to_spawn(Vector2(start_x, _upper.sample_surface_y(start_x)))
		await _physics_frames(8)
		Input.action_press(attempt["move_action"])
		var reached_takeoff := await _wait_until(
			func() -> bool:
				return (
					_actor.global_position.x >= attempt["jump_x"]
					if attempt["move_action"] == "move_right"
					else _actor.global_position.x <= attempt["jump_x"]
				),
			90,
		)
		if not reached_takeoff:
			Input.action_release(attempt["move_action"])
			_fail("PartnerActor could not reach the upper %s railing takeoff" % attempt["edge"])
			return false
		Input.action_press("jump")
		await _physics_frames(10)
		Input.action_release("jump")
		var crossed := await _wait_until(attempt["crossed"], 100)
		Input.action_release(attempt["move_action"])
		if not crossed:
			_fail(
				"Upper %s railing blocker is taller than its visible, jumpable geometry"
				% attempt["edge"]
			)
			return false
	return true

func _verify_lower_ladder_and_floor() -> bool:
	_actor.reset_to_spawn(_lower_ladder.top_point())
	await _physics_frames(8)
	Input.action_press("climb_down")
	var climb_frames := {}
	# Starting at the platform first reverses the authored top-contact gesture.
	# Pause inside that interval; full-cycle coverage belongs to traversal review.
	for _index: int in range(20):
		await get_tree().physics_frame
		if _visual.animation in [&"climb", &"climb_finish"]:
			climb_frames["%s:%s" % [_visual.animation, _visual.frame]] = true
	Input.action_release("climb_down")
	var paused_position := _actor.global_position
	var paused_frame := _visual.frame
	await _physics_frames(12)
	if (
		climb_frames.size() < 2
		or not _actor.is_climbing()
		or not _actor.global_position.is_equal_approx(paused_position)
		or _visual.frame != paused_frame
	):
		_fail(
			"Climb animation is not driven exclusively by physical travel: frames=%s position=%s->%s"
			% [climb_frames.keys(), paused_position, _actor.global_position]
		)
		return false
	Input.action_press("climb_down")
	var reached_lower := await _wait_until(
		func() -> bool:
			return not _actor.is_climbing() and _actor.is_on_floor() and absf(_actor.global_position.y - 876.0) <= 3.0,
		180,
	)
	Input.action_release("climb_down")
	if not reached_lower:
		_fail(
			"Lower ladder did not reach the lower surface: position=%s state=%s active=%s ignored=%s"
			% [
				_actor.global_position,
				_actor.movement_state(),
				_actor.active_ladder(),
				_actor.ignored_surface_count(),
			]
		)
		return false
	Input.action_press("move_left")
	var left_start := _actor.global_position.x
	await _physics_frames(90)
	Input.action_release("move_left")
	if _actor.global_position.x >= left_start - 180.0 or not _actor.is_on_floor():
		_fail("Lower surface contains an unexpected blocker")
		return false
	var right_start := _actor.global_position.x
	Input.action_press("move_right")
	await _physics_frames(150)
	Input.action_release("move_right")
	if _actor.global_position.x <= right_start + 260.0 or not _actor.is_on_floor():
		_fail("Lower surface is not traversable in both directions")
		return false
	return true

func _verify_recovery() -> bool:
	_actor.global_position = Vector2(1200.0, 1010.0)
	_actor.velocity = Vector2.ZERO
	var recovered := await _wait_until(
		func() -> bool:
			return _actor.global_position.distance_to(_spawn.global_position) <= 2.0,
		30,
	)
	if not recovered or _actor.ignored_surface_count() != 0:
		_fail("Out-of-bounds recovery did not restore the authoritative spawn state")
		return false
	if _camera_rig.global_position.distance_to(
		_camera_rig.target_position_for(_spawn.global_position)
	) > 1.0:
		_fail("Out-of-bounds recovery did not synchronize the world camera")
		return false
	return true

func _walk_to_x(target_x: float, tolerance: float, max_frames: int) -> bool:
	var action := "move_right" if target_x > _actor.global_position.x else "move_left"
	Input.action_press(action)
	for _index: int in range(max_frames):
		await get_tree().physics_frame
		if absf(_actor.global_position.x - target_x) <= tolerance:
			Input.action_release(action)
			await _physics_frames(12)
			return true
	Input.action_release(action)
	return false

func _physics_frames(count: int) -> void:
	for _index: int in range(count):
		await get_tree().physics_frame

func _wait_until(predicate: Callable, max_frames: int) -> bool:
	for _index: int in range(max_frames):
		if predicate.call():
			return true
		await get_tree().physics_frame
	return predicate.call()

func _fail(message: String) -> void:
	if _failed:
		return
	_failed = true
	printerr(message)
	_release_inputs()
	get_tree().quit(1)

func _release_inputs() -> void:
	for action: String in ["move_left", "move_right", "climb_up", "climb_down", "jump"]:
		Input.action_release(action)
