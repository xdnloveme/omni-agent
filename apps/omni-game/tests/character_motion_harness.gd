extends Node

# Production animation regressions run through real Input, physics and animator.
@export var presentation: CharacterPresentation = preload("res://resources/characters/coding.tres")
var _animation_set: CharacterAnimationSet
@onready var _world: WorkshopWorld = $WorkshopWorld
@onready var _actor: PartnerActor = $WorkshopWorld/PartnerActor
@onready var _visual: AnimatedSprite2D = $WorkshopWorld/PartnerActor/CharacterVisual
@onready var _map: WorkshopTraversalMap = $WorkshopWorld/TraversalMap
@onready var _camera: WorkshopCameraRig = $WorkshopWorld/WorkshopCameraRig
var _focused := false
var _failed := false
var _max_route_error := 0.0

func _ready() -> void:
	for argument in OS.get_cmdline_user_args():
		if argument.begins_with("--presentation="):
			presentation = load(argument.trim_prefix("--presentation=")) as CharacterPresentation
	assert(presentation != null)
	_animation_set = presentation.animation_set as CharacterAnimationSet
	_world.enter_workspace(presentation)
	_world.set_input_enabled(true)
	await _verify_jump()
	await _verify_traversal()
	await _verify_ladder_handoff()
	await _verify_idle_transitions()
	_release_movement()
	_world.leave_workspace()
	get_tree().quit(1 if _failed else 0)

func _apply_focus() -> void:
	# Exercise the real composition owner, without changing actor scale.
	_camera.set_conversation_focus(
		_focused, Rect2(Vector2(get_viewport().get_visible_rect().size.x, 0), Vector2.ZERO), false)

func _spawn_at(surface_name: StringName, x: float) -> void:
	var surface := _map.get_node(NodePath(surface_name)) as WalkSurface2D
	_actor.reset_to_spawn(Vector2(x, surface.sample_surface_y(x)))
	_camera.snap_to_target()

func _physics_frames(count: int) -> void:
	for index in range(count):
		await get_tree().physics_frame

func _release_movement() -> void:
	for action in ["move_left", "move_right", "climb_up", "climb_down", "jump"]:
		Input.action_release(action)

func _fail(message: String) -> void:
	_failed = true
	push_error(message)

func _uses_registered_art() -> bool:
	var registered := load("res://resources/characters/%s.tres" % presentation.agent_id) as CharacterPresentation
	return registered != null and registered.animation_set == _animation_set

func _check_fixed_body() -> void:
	if not _visual.scale.is_equal_approx(_animation_set.visual_scale) or _visual.offset != -_animation_set.foot_anchor:
		_fail("Traversal changed the character scale or foot anchor")
	# Check the complete world basis too: a parent tween/shear can deform the
	# character even if AnimatedSprite2D.scale itself never changes. Camera zoom
	# is outside this basis and must enlarge the scene, not the actor alone.
	var basis := _visual.global_transform
	if not basis.x.is_equal_approx(Vector2(_animation_set.visual_scale.x, 0.0)) or not basis.y.is_equal_approx(Vector2(0.0, _animation_set.visual_scale.y)):
		_fail("Traversal scaled, rotated or sheared the character through its parent transform")
	var texture := _visual.sprite_frames.get_frame_texture(_visual.animation, _visual.frame)
	if texture == null or texture.get_size() != Vector2(_animation_set.source_size):
		_fail("Animation frame changed the registered source canvas")

func _verify_jump() -> void:
	# Real input/physics exercise the registered phase ranges, contact, interrupts,
	# equipment track and idle handoff. No test-owned animation clock or pose swap.
	var cases := 0
	var phases := _animation_set.airborne_phase_frames
	var variants := ["settle", "walk_after", "tap_repeat", "moving", "bridge", "platform_edge"]
	for focused in [false, true]:
		_focused = focused
		_apply_focus()
		for direction in [-1, 1]:
			for variant in variants:
				_release_movement()
				# Clear floor between interaction prompts keeps the whole jump visible.
				if variant == "platform_edge":
					_spawn_at(&"UpperSurface", 145.0 if direction < 0 else 1730.0)
				elif variant == "bridge":
					_spawn_at(&"UpperSurface", 1190.0 if direction < 0 else 1090.0)
				else:
					_spawn_at(&"MiddleSurface", 1120.0)
				var move_action := &"move_left" if direction < 0 else &"move_right"
				Input.action_press(move_action)
				await _physics_frames(3)
				Input.action_release(move_action)
				await _physics_frames(15)
				await _physics_frames(12)
				if variant in ["moving", "bridge", "platform_edge"]: Input.action_press(move_action)
				var started_at := _actor.global_position
				var airborne := false
				var landed := false
				var height := 0.0
				Input.action_press("jump")
				for tick in range(120):
					await _physics_frames(1)
					_check_fixed_body()
					_check_equipment_mount()
					if variant == "tap_repeat" and tick == 3: Input.action_release("jump")
					height = maxf(height, started_at.y - _actor.global_position.y)
					if not _actor.is_on_floor():
						airborne = true
						if _visual.animation != &"jump": _fail("Airborne character did not show jump art")
						var range_start := phases.y
						var range_end := phases.z
						if _actor.velocity.y < -_animation_set.apex_vertical_speed:
							range_start = phases.x
							range_end = phases.y
						elif _actor.velocity.y > _animation_set.apex_vertical_speed:
							range_start = phases.z
							range_end = _animation_set.landing_frame
						if _visual.frame < range_start or _visual.frame >= maxi(range_start + 1, range_end):
							_fail("Jump art escaped the range for its actual physical phase")
					elif airborne:
						landed = true
						if variant not in ["moving", "bridge", "platform_edge"] and (_visual.animation != &"jump" or _visual.frame < _animation_set.landing_frame):
							_fail("Ground contact did not start landing art")
						break
				if not airborne or not landed or height < 10.0: _fail("Jump did not complete a physical flight and landing")
				if variant == "platform_edge":
					# Authored edge blockers have solid tops: landing there is valid.
					# Continue off that support to exercise the real drop to the next floor.
					var dropped := false
					for tick in range(180):
						await _physics_frames(1)
						_check_fixed_body()
						_check_equipment_mount()
						dropped = dropped or not _actor.is_on_floor()
						if dropped and _actor.is_on_floor() and _actor.position.y > 650.0: break
					if not dropped or not _actor.is_on_floor() or _actor.position.y < 650.0:
						_fail("Edge traversal did not finish on the middle floor")
				if variant == "bridge" and absf(_actor.global_position.y - started_at.y) > 15.0:
					_fail("Bridge jump did not return to the upper route")
				_release_movement()
				if variant == "walk_after":
					Input.action_press(move_action)
					await _physics_frames(3)
					if _visual.animation != &"walk": _fail("Landing animation blocked immediate walking")
				elif variant == "tap_repeat":
					await _physics_frames(1)
					Input.action_press("jump")
					# physics_frame is emitted before the actor updates; observe the
					# next completed input/physics/presentation cycle, not stale art.
					await _physics_frames(1)
					await get_tree().process_frame
					if _visual.animation != &"jump" or _visual.frame >= _animation_set.landing_frame:
						_fail("Landing animation blocked repeat jump preparation")
					await _physics_frames(10)
					if _actor.is_on_floor(): _fail("Repeat jump failed to take off after preparation")
					Input.action_release("jump")
					await _physics_frames(90)
				_release_movement()
				await _physics_frames(40)
				_check_fixed_body()
				_check_equipment_mount()
				if not _actor.is_on_floor() or _visual.animation != &"idle" or not _visual.is_playing():
					_fail("Jump failed to restore normal animated idle")
				cases += 1
	print("jump_integration_verified: %s" % JSON.stringify({"passed": not _failed, "presentation": presentation.resource_path, "cases": cases}))

func _verify_traversal() -> void:
	var climb_seen: Dictionary = {}
	var top_entry_frames: Array[int] = []
	var finish_seen: Dictionary = {}
	var ascent_seen: Dictionary = {}
	for focused in [false, true]:
		_focused = focused
		_apply_focus()
		for route_name in ["LowerLadder", "UpperLadder"]:
			var route := _map.get_node(route_name) as LadderRoute2D
			_actor.reset_to_spawn(route.bottom_point())
			_camera.snap_to_target()
			await _physics_frames(12)
			Input.action_press("climb_up")
			await _physics_frames(20)
			Input.action_release("climb_up")
			await _physics_frames(2)
			var paused_at := _actor.position
			var paused_frame := _visual.frame
			await _physics_frames(18)
			if not _actor.is_climbing() or _actor.position.distance_to(paused_at) > 0.01 or _visual.frame != paused_frame:
				_fail("Climb pause drifted or continued cycling")
			Input.action_press("climb_down")
			await _physics_frames(12)
			Input.action_release("climb_down")
			if _actor.position.y <= paused_at.y:
				_fail("Climb reversal did not move downward")
			Input.action_press("climb_up")
			var previous := _actor.position
			var finish_pause_checked := false
			for tick in range(240):
				var previous_animation := _visual.animation
				var previous_frame := _visual.frame
				var previous_remaining := _actor.position.y - route.top_point().y
				await _physics_frames(1)
				_check_fixed_body()
				if _actor.position.distance_to(previous) > _actor.locomotion_config.climb_speed / 60.0 + 1.0:
					_fail("Upward ladder motion jumped at the endpoint")
				previous = _actor.position
				if absf(_actor.position.x - route.center_x()) > 0.01:
					_fail("Climb or exit moved sideways")
				if _visual.animation == &"climb":
					climb_seen[_visual.frame] = true
					if _actor.position.y - route.top_point().y < _animation_set.climb_top_start_height * _animation_set.visual_scale.y - 0.01:
						_fail("Raised-hand cycle continued inside the ladder finishing interval")
				elif _visual.animation == &"climb_top":
					if previous_animation == &"climb" and previous_remaining > _animation_set.climb_top_start_height * _animation_set.visual_scale.y and _animation_set.climb_top_entry_frame >= 0:
						top_entry_frames.append(previous_frame)
						if absi(previous_frame - _animation_set.climb_top_entry_frame) > 1:
							_fail("Top contact did not follow its authored cycle support pose")
						var entry_mount := _animation_set.climb_top_equipment_poses[0]
						if Vector2(entry_mount.x, entry_mount.y).distance_to(_animation_set.climb_equipment_mount) > 1.0:
							_fail("Staff mount jumped at the cycle/top contact boundary")
					ascent_seen[_visual.frame] = true
					var remaining_height: float = _actor.position.y - route.top_point().y
					var palm_height: float = _animation_set.climb_top_hand_heights[_visual.frame] * _animation_set.visual_scale.y
					if palm_height - remaining_height > 3.5:
						_fail("Ascent support hands rose above the ledge beyond the final planted pose")
					if _visual.frame == 4 and not finish_pause_checked:
						finish_pause_checked = true
						Input.action_release("climb_up")
						await _physics_frames(1)
						var held_position := _actor.position
						var held_frame := _visual.frame
						await _physics_frames(12)
						if not _actor.is_climbing() or _actor.position.distance_to(held_position) > 0.01 or _visual.animation != &"climb_top" or _visual.frame != held_frame:
							_fail("Ladder top pose/motion continued after releasing input")
						Input.action_press("climb_down")
						await _physics_frames(6)
						Input.action_release("climb_down")
						if _actor.position.y <= held_position.y:
							_fail("Ladder top gesture did not reverse with real downward travel")
						var reverse_distance: float = _actor.position.y - route.top_point().y
						if reverse_distance >= _animation_set.climb_finish_height:
							if _visual.animation != &"climb":
								_fail("Descending away from the platform did not resume the climb cycle")
						elif _visual.animation != &"climb_finish":
							_fail("Descending did not retain its approved finishing poses")
						Input.action_press("climb_up")
						previous = _actor.position
				if not _actor.is_climbing():
					if _visual.animation != &"climb_top_stand" or not _actor.is_on_floor():
						_fail("Ascent must settle only after real platform contact")
					break
			_release_movement()
			var arrived_at := _actor.position
			await _physics_frames(20)
			if _actor.position.distance_to(arrived_at) > 0.01 or _visual.animation != &"idle":
				_fail("Standing after ascent moved the physical root or failed to return to idle")
			if _actor.is_climbing() or _actor.position.distance_to(route.top_point()) > 2.0 or _actor.ignored_surface_count() != 0:
				_fail("Top exit failed to restore exact route contact/collisions: %s target=%s climbing=%s ignored=%s" % [_actor.position, route.top_point(), _actor.is_climbing(), _actor.ignored_surface_count()])
			Input.action_press("climb_down")
			previous = _actor.position
			for tick in range(240):
				await _physics_frames(1)
				_check_fixed_body()
				if _actor.position.distance_to(previous) > _actor.locomotion_config.climb_speed / 60.0 + 1.0:
					_fail("Downward ladder motion jumped at entry/exit")
				previous = _actor.position
				if absf(_actor.position.x - route.center_x()) > 0.01:
					_fail("Downward climb moved sideways")
				if _actor.is_climbing():
					var distance_to_top: float = _actor.position.y - route.top_point().y
					if distance_to_top < _animation_set.climb_finish_height:
						var expected := mini(int((1.0 - distance_to_top / _animation_set.climb_finish_height) * 3), 2)
						finish_seen[_visual.frame] = true
						if _visual.animation != &"climb_finish" or _visual.frame != expected:
							_fail("Descending changed from the approved 18px/three-pose transition")
					elif _visual.animation != &"climb":
						_fail("Descending must use the original climb cycle")
				if tick > 0 and not _actor.is_climbing():
					break
			_release_movement()
			await _physics_frames(12)
			if _actor.position.distance_to(route.bottom_point()) > 2.0 or _actor.ignored_surface_count() != 0:
				_fail("Bottom exit failed to restore exact route contact/collisions")
		# A jump off a ladder must clear route exceptions immediately.
		_spawn_at(&"MiddleSurface", 1016.0)
		await _physics_frames(12)
		Input.action_press("climb_up")
		await _physics_frames(28)
		Input.action_press("jump")
		await _physics_frames(3)
		if _actor.is_climbing() or _actor.ignored_surface_count() != 0 or _visual.animation != &"jump":
			_fail("Ladder jump retained climb state or route collision exceptions")
		_release_movement()
		await _physics_frames(80)
	if climb_seen.size() != _visual.sprite_frames.get_frame_count(&"climb") or finish_seen.size() != 3 or ascent_seen.size() != 9:
		_fail("Runtime did not visit every climb/finish phase")
	if _animation_set.climb_top_entry_frame >= 0 and top_entry_frames.size() != 4:
		_fail("Top-contact phase alignment was not checked on both ladders in both views")
	print(JSON.stringify({"type": "mage_traversal", "passed": not _failed,
		"top_entry_frames": top_entry_frames,
		"climb_frames": climb_seen.keys(), "climb_finish_frames": finish_seen.keys(),
		"ascent_frames": ascent_seen.keys(), "descent_unchanged": true,
		"climb_cycle_seconds": _animation_set.climb_stride_pixels / _actor.locomotion_config.climb_speed,
		"scale": str(_visual.scale), "production_replaced": _uses_registered_art()}))

func _verify_ladder_handoff() -> void:
	# Exercise actual endpoint arrival, then interrupt the short visual settle.
	var cases := 0
	var stand_seen: Dictionary = {}
	for focused in [false, true]:
		_focused = focused
		_apply_focus()
		for route_name in ["LowerLadder", "UpperLadder"]:
			var route: LadderRoute2D = _map.get_node(route_name)
			for follow_up in ["settle", "walk", "jump", "down", "focus", "reset"]:
				_actor.set_conversation_focus(false)
				_actor.reset_to_spawn(route.bottom_point())
				_camera.snap_to_target()
				await _physics_frames(12)
				Input.action_press("climb_up")
				var entered := false
				for tick in range(240):
					await _physics_frames(1)
					_check_fixed_body()
					_check_equipment_mount()
					entered = entered or _actor.is_climbing()
					if entered and not _actor.is_climbing(): break
				_release_movement()
				if _visual.animation != &"climb_top_stand" or not _actor.is_on_floor():
					_fail("Handoff did not start from a real landed ascent: route=%s follow=%s entered=%s position=%s animation=%s grounded=%s" % [route_name, follow_up, entered, _actor.position, _visual.animation, _actor.is_on_floor()])
				var arrived := _actor.position
				match follow_up:
					"walk": Input.action_press("move_right")
					"jump": Input.action_press("jump")
					"down": Input.action_press("climb_down")
					"focus": _actor.set_conversation_focus(true)
					"reset": _actor.reset_to_spawn(route.bottom_point())
				for tick in range(3):
					await _physics_frames(1)
					_check_equipment_mount()
					if _visual.animation == &"climb_top_stand": stand_seen[_visual.frame] = true
				match follow_up:
					"walk":
						if _visual.animation != &"walk" or _actor.position.x <= arrived.x:
							_fail("Standing up blocked immediate walking")
					"jump":
						if _visual.animation != &"jump":
							_fail("Jump input did not interrupt standing immediately")
						# Rose has an authored crouch before takeoff; Coding takes off immediately.
						await _physics_frames(ceili(_actor.locomotion_config.jump_preparation_duration * Engine.physics_ticks_per_second))
						if _visual.animation != &"jump" or _actor.is_on_floor() or _actor.velocity.y >= 0:
							_fail("Standing up blocked takeoff after the configured preparation")
					"down":
						if not _actor.is_climbing() or _visual.animation not in [&"climb", &"climb_finish"]:
							_fail("Standing up blocked the unchanged downward path")
					"reset":
						if _visual.animation != &"idle" or _actor.ignored_surface_count() != 0:
							_fail("Reset retained an unfinished ascent")
				for tick in range(20):
					await _physics_frames(1)
					_check_fixed_body()
					_check_equipment_mount()
					if _visual.animation == &"climb_top_stand": stand_seen[_visual.frame] = true
					if follow_up in ["settle", "focus"] and _actor.position.distance_to(arrived) > 0.01:
						_fail("Visual settle or focus change moved the physical root")
				if follow_up in ["settle", "focus"] and _visual.animation != &"idle":
					_fail("Uninterrupted ascent did not resume animated idle")
				_release_movement()
				cases += 1
	if stand_seen.size() != 4:
		_fail("Handoff checks did not cover all authored standing frames")
	print(JSON.stringify({"type": "mage_ladder_handoff", "passed": not _failed,
		"cases": cases, "standing_frames": stand_seen.keys(), "equipment_frame_sync": true}))

func _check_equipment_mount() -> void:
	var equipment := _visual.get_child(0) as Sprite2D
	if _animation_set.back_equipment == null:
		if equipment.visible or equipment.texture != null:
			_fail("Unequipped character retained another character's staff")
		return
	var expected: Vector2 = _animation_set.back_equipment_mount
	var expected_angle: float = _animation_set.back_equipment_angle
	if _actor.is_climbing(): expected = _animation_set.climb_equipment_mount
	if _actor.is_climbing(): expected_angle = _animation_set.climb_equipment_angle
	var pose := Vector3(expected.x, expected.y, expected_angle)
	if _visual.animation == &"climb_top":
		pose = _animation_set.climb_top_equipment_poses[_visual.frame]
	elif _visual.animation == &"climb_top_stand":
		pose = _animation_set.climb_stand_equipment_poses[_visual.frame]
	elif _visual.animation == &"jump" and not _animation_set.jump_equipment_poses.is_empty():
		pose = _animation_set.jump_equipment_poses[_visual.frame]
	expected = Vector2(pose.x, pose.y)
	var mirrored := Vector2(-1.0 if _visual.flip_h else 1.0, 1.0)
	if not equipment.position.is_equal_approx((expected - _animation_set.foot_anchor) * mirrored):
		_fail("Staff attachment lagged the currently visible body pose")
	if not is_equal_approx(equipment.rotation, deg_to_rad(pose.z * mirrored.x)):
		_fail("Staff angle lagged the currently visible torso pose")
	if _visual.animation in [&"climb_top", &"climb_top_stand"]:
		# Authored staff's bottom end, measured in its source texture. Test the
		# actual scene transform, including facing and the unchanged visual scale.
		var tip := equipment.to_global(Vector2(256, 464) + equipment.offset)
		if tip.y > _actor.global_position.y + 2.0:
			_fail("Back-carried staff tip penetrated below the planted-foot baseline")

func _verify_idle_transitions() -> void:
	# Exercise the native AnimatedSprite2D clock, not a test-owned frame timer.
	var idle_frames := _animation_set.frames.get_frame_count(&"idle")
	var idle_seen: Dictionary = {}
	var transitions := 0
	var loop_seconds := 0.0
	for index in range(idle_frames):
		loop_seconds += _animation_set.frames.get_frame_duration(&"idle", index) / _animation_set.frames.get_animation_speed(&"idle")
	var expected_frames := 32 if presentation.agent_id == "financial-analysis" else 8
	var blink_frame := 24 if presentation.agent_id == "financial-analysis" else 5
	if idle_frames != expected_frames or not is_equal_approx(loop_seconds, 4.0):
		_fail("Idle must match its authored frame count and four-second cycle")
	if not is_equal_approx(_animation_set.frames.get_frame_duration(&"idle", blink_frame) / _animation_set.frames.get_animation_speed(&"idle"), 0.12):
		_fail("Idle blink must remain brief")
	for focused in [false, true]:
		_focused = focused
		_apply_focus()
		_spawn_at(&"MiddleSurface", 860.0)
		await _physics_frames(12)
		var surface := _map.get_node("MiddleSurface") as WalkSurface2D
		var stopped := _actor.position
		var steady_zoom: Vector2 = _camera.get_node("Camera2D").zoom
		var loop_wraps := 0
		var last_frame := _visual.frame
		# Two complete loops: catches frozen idle, a stuck blink and the loop seam.
		for index in range(500):
			await _physics_frames(1)
			_check_ground_motion(surface)
			if _visual.animation != &"idle" or not _visual.is_playing():
				_fail("Stationary actor did not keep playing idle")
			if _actor.position.distance_to(stopped) > 0.1:
				_fail("Cape or blink playback moved the physical actor")
			if not _camera.get_node("Camera2D").zoom.is_equal_approx(steady_zoom):
				_fail("Idle changed the camera magnification")
			idle_seen[_visual.frame] = true
			if _visual.frame < last_frame:
				loop_wraps += 1
			last_frame = _visual.frame
		if loop_wraps < 2:
			_fail("Idle did not wrap twice on the native animation clock")
		# Stop at different gait phases, in both directions; do not wait for the
		# walk animation to finish, tween the root or resize the idle pose.
		for travel_frames in [18, 31, 44, 57]:
			var action := "move_left" if transitions % 2 == 0 else "move_right"
			Input.action_press(action)
			await _physics_frames(3)
			if _visual.animation != &"walk":
				_fail("Movement waited for an idle animation to finish")
			await _physics_frames(travel_frames)
			Input.action_release(action)
			await _physics_frames(20)
			_check_ground_motion(surface)
			if _visual.animation != &"idle" or not _visual.is_playing() or not is_zero_approx(_actor.velocity.x):
				_fail("Walk release failed to resume animated, stationary idle")
			if _visual.flip_h != (action == "move_left"):
				_fail("Stopping unexpectedly changed the character facing")
			if not _camera.get_node("Camera2D").zoom.is_equal_approx(steady_zoom):
				_fail("Walk to idle changed the camera magnification")
			transitions += 1
		# Movement during the closed-eye frame must interrupt immediately too.
		var blink_found := false
		for index in range(250):
			await _physics_frames(1)
			if _visual.frame == blink_frame:
				blink_found = true
				break
		if not blink_found:
			_fail("Idle never reached its authored blink")
		Input.action_press("move_right")
		await _physics_frames(3)
		if _visual.animation != &"walk":
			_fail("Blink blocked movement")
		_release_movement()
		await _physics_frames(20)
	if idle_seen.size() != idle_frames:
		_fail("Native playback did not visit every cape/blink frame")
	print(JSON.stringify({"type": "mage_idle_transitions", "passed": not _failed,
		"idle_frames_seen": idle_seen.keys(), "walk_stop_transitions": transitions,
		"idle_cycle_seconds": loop_seconds, "blink_seconds": 0.12,
		"max_route_error": _max_route_error, "visual_scale": str(_visual.scale),
		"production_replaced": _uses_registered_art()}))

func _check_ground_motion(surface: WalkSurface2D) -> void:
	_check_fixed_body()
	var route_y := surface.sample_surface_y(_actor.position.x)
	var error := absf(_actor.position.y + _visual.position.y - route_y)
	_max_route_error = maxf(_max_route_error, error)
	if error > 2.0 or not _actor.is_on_floor():
		_fail("Character lost ground contact: %.3f px" % error)
