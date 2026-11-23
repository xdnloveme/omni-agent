extends SceneTree

# Exercise the real actor lifecycle: a female profile must not leak into the
# next male avatar or mutate the shared default resource.
func _initialize() -> void:
	call_deferred("_run")

func _run() -> void:
	var world: WorkshopWorld = load("res://scenes/WorkshopWorld.tscn").instantiate()
	root.add_child(world)
	await process_frame
	var actor: PartnerActor = world.get_node("PartnerActor")
	var shared: PartnerLocomotionConfig = load("res://resources/movement/partner-locomotion-config.tres")
	var max_speeds: Array = []
	for id in ["coding", "financial-analysis", "coding"]:
		var presentation: CharacterPresentation = load("res://resources/characters/%s.tres" % id)
		var expected := 128.0 if id == "financial-analysis" else 165.0
		world.enter_workspace(presentation)
		world.set_input_enabled(true)
		var surface = world.get_node("TraversalMap/MiddleSurface")
		actor.reset_to_spawn(Vector2(860.0, surface.sample_surface_y(860.0)))
		assert(actor.locomotion_config == presentation.locomotion_config)
		assert(actor.floor_snap_length == presentation.locomotion_config.floor_snap_distance)
		Input.action_press("move_right")
		var maximum := 0.0
		for frame in range(60):
			await physics_frame
			maximum = maxf(maximum, absf(actor.velocity.x))
		Input.action_release("move_right")
		assert(is_equal_approx(maximum, expected), "Wrong avatar's physical speed")
		for frame in range(24):
			await physics_frame
		assert(is_zero_approx(actor.velocity.x))
		assert(shared.walk_speed == 165.0, "Shared movement resource was mutated")
		var station: WorkshopWorkstation = world.get_node("Workbench")
		actor.reset_to_spawn(station.approach.global_position - Vector2(120, 0))
		for frame in range(4):
			await physics_frame
		assert(actor.begin_work(station))
		var approach_maximum := 0.0
		for frame in range(90):
			await physics_frame
			approach_maximum = maxf(approach_maximum, absf(actor.velocity.x))
		assert(is_equal_approx(approach_maximum, 128.0 if id == "financial-analysis" else 160.0))
		actor.end_work()
		max_speeds.append(maximum)
		world.leave_workspace()
	await _verify_jump_preparation(world, actor)
	world.queue_free()
	print("CHARACTER_LOCOMOTION_PASS ", max_speeds)
	quit()

func _verify_jump_preparation(world: WorkshopWorld, actor: PartnerActor) -> void:
	# Synthetic phase slots test the real input lifecycle, not animation art.
	# No test depends on unshipped video files or the candidate directory.
	var presentation: CharacterPresentation = load("res://resources/characters/coding.tres").duplicate()
	presentation.locomotion_config = presentation.locomotion_config.duplicate()
	presentation.locomotion_config.jump_preparation_duration = 0.12
	presentation.animation_set = presentation.animation_set.duplicate()
	var frames: SpriteFrames = presentation.animation_set.frames.duplicate()
	var textures: Array[Texture2D] = []
	for index in [0, 0, 0, 1, 2, 3]:
		textures.append(frames.get_frame_texture(&"jump", index))
	frames.clear(&"jump")
	for texture in textures: frames.add_frame(&"jump", texture)
	presentation.animation_set.frames = frames
	presentation.animation_set.airborne_phase_frames = Vector3i(2, 3, 4)
	presentation.animation_set.landing_frame = 5
	presentation.animation_set.jump_equipment_poses = PackedVector3Array()
	world.enter_workspace(presentation)
	world.set_input_enabled(true)
	var surface = world.get_node("TraversalMap/MiddleSurface")
	var visual: AnimatedSprite2D = actor.get_node("CharacterVisual")
	# Releasing on any anticipation tick cuts the impulse once, including the
	# boundary tick. Full hold keeps the existing trajectory unchanged.
	var heights: Array = []
	for release_tick in [1, 2, 3, 4, 5, 6, 7, 8, 90]:
		actor.reset_to_spawn(Vector2(1160, surface.sample_surface_y(1160)))
		for tick in range(12): await physics_frame
		var ground := actor.position.y
		var height := 0.0
		Input.action_press("jump")
		for tick in range(95):
			if tick == release_tick: Input.action_release("jump")
			await physics_frame
			await process_frame
			height = maxf(height, ground - actor.position.y)
			if tick < 5: assert(actor.is_on_floor(), "Anticipation left the floor too soon")
		Input.action_release("jump")
		assert(actor.is_on_floor() and visual.animation == &"idle")
		assert(height > 10.0, "Release at preparation boundary cut the jump twice")
		assert(height < 30.0 if release_tick < 9 else absf(height - 91.9) < 1.0)
		heights.append(height)
	# Disable/reset may happen while crouching. Neither can leave a deferred jump.
	for cancel in ["disable", "reset"]:
		Input.action_press("jump")
		for tick in range(2): await physics_frame
		if cancel == "disable": actor.set_input_enabled(false)
		else: actor.reset_to_spawn(Vector2(1160, surface.sample_surface_y(1160)))
		Input.action_release("jump")
		for tick in range(15): await physics_frame
		actor.set_input_enabled(true)
		for tick in range(15): await physics_frame
		assert(actor.is_on_floor(), "Cancelled anticipation launched later")
	world.leave_workspace()
	print("JUMP_PREPARATION_PASS ", heights)
