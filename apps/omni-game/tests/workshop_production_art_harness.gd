extends Node
## Main -> authenticated Host -> character selection -> production world.
## No texture overrides and no preview resource loading.

@onready var _main: GameRoot = $Main
@onready var _controller: CharacterWorkspaceController = $Main/CharacterWorkspaceController
@onready var _world: WorkshopWorld = $Main/WorldRoot/WorkshopWorld
@onready var _actor: PartnerActor = $Main/WorldRoot/WorkshopWorld/PartnerActor
@onready var _rig: WorkshopCameraRig = $Main/WorldRoot/WorkshopWorld/WorkshopCameraRig
var _started := false
var _failed := false
var _presentation: CharacterPresentation

func _ready() -> void:
	get_tree().create_timer(60.0).timeout.connect(func() -> void: _fail("Production artwork verification timed out"))
	_controller.agents_changed.connect(func(agents: Array) -> void:
		if agents.size() != 1 or agents[0]["id"] not in ["coding", "financial-analysis"]:
			_fail("Expected one registered production character fixture")
			return
		_controller.select_agent(agents[0]["id"]))
	_controller.workspace_changed.connect(_inspect_world)
	_controller.error_changed.connect(_fail)

func _inspect_world(_agent: Dictionary, _session: Dictionary) -> void:
	if _started:
		return
	_started = true
	var registered := load("res://resources/characters/%s.tres" % _agent["id"]) as CharacterPresentation
	_presentation = registered
	if _actor.get_node("CharacterVisual").sprite_frames != registered.animation_set.frames:
		_fail("Main did not load the registered character animation resource")
		return
	if not _world.is_active() or $Main/UIRoot/SelectionLayer.visible:
		_fail("Main did not enter the production world through character selection")
		return
	if $Main/WorldRoot/WorkshopWorld/Visual/Environment.texture.resource_path != "res://assets/environment/workshop/workshop-backplate-stylized.png":
		_fail("Normal entry loaded an obsolete background")
		return
	if _world.get_node("Visual/BedroomDetail").texture.resource_path != "res://assets/environment/workshop/workshop-bedroom-detail.png" or _world.get_node("Visual/Bed").empty_texture == null:
		_fail("Normal entry did not load the registered bedroom and fixed empty bed")
		return
	get_window().size = Vector2i(1440, 900)
	for point: Vector2 in [Vector2(520,295), Vector2(1088,289), Vector2(1160,300), Vector2(1244,286), Vector2(1450,295), Vector2(1460,669), Vector2(2040,669), Vector2(1200,876)]:
		_actor.reset_to_spawn(point)
		_rig.snap_to_target()
		await get_tree().create_timer(0.2).timeout
		await _capture("main-%d-%d" % [point.x, point.y])
	_actor.reset_to_spawn(Vector2(1020, 296))
	Input.action_press("move_right")
	for frame: int in range(150):
		await get_tree().physics_frame
		if _actor.global_position.x > 1290:
			break
	Input.action_release("move_right")
	if _actor.global_position.x < 1290:
		_fail("Normal Main input failed to cross the bridge")
		return
	_actor.reset_to_spawn(Vector2(1160,300))
	_rig.snap_to_target()
	get_window().grab_focus()
	$Main/GameDisplay.toggle_fullscreen()
	await get_tree().create_timer(3.0).timeout
	await _capture("main-fullscreen")
	$Main/GameDisplay.toggle_fullscreen()
	get_window().size = Vector2i(1440, 900)
	await _verify_ladder_visuals()
	if _failed: return
	await _verify_work_conversation()
	if _failed: return
	await _verify_sleep()
	if _failed: return
	await _verify_rest_and_exit()
	if _failed: return
	print("production_art_main_verified: native assets, selection, HUD, traversal and fullscreen")
	$Main/AgentHostClient.shutdown()
	get_tree().quit(0)

func _verify_ladder_visuals() -> void:
	_actor.reset_to_spawn(Vector2(996, 669))
	await get_tree().create_timer(0.2).timeout
	_rig.snap_to_target()
	Input.action_press("climb_up")
	Input.action_press("move_right")
	var seen := {}
	for frame: int in range(240):
		await get_tree().physics_frame
		var state := _actor.movement_state()
		if state == PartnerActor.MovementState.LADDER_CLIMB and not seen.has(state):
			seen[state] = true
			Input.action_release("move_right")
			await _capture("ladder-climb")
		if _actor.is_on_floor() and _actor.global_position.y < 310 and not _actor.is_climbing(): break
	Input.action_release("climb_up")
	Input.action_release("move_right")
	await get_tree().create_timer(0.4).timeout
	await _capture("ladder-endpoint")
	if seen.is_empty() or not _actor.is_on_floor() or absf(_actor.global_position.x - 1016.0) > 0.1:
		_fail("Main ladder did not stop vertically at its endpoint")
		return

func _verify_work_conversation() -> void:
	var panel: TaskPanel = $Main/UIRoot/TaskOverlay/TaskPanel
	var sprite: AnimatedSprite2D = _actor.get_node("CharacterVisual")
	_actor.reset_to_spawn(Vector2(1460, 669))
	await get_tree().create_timer(0.2).timeout
	_world.interaction_requested.emit(&"workbench")
	await get_tree().create_timer(2.0).timeout
	if _actor.activity_phase() != PartnerActor.ActivityPhase.WORK_SEATED or sprite.is_playing():
		_fail("Main draft did not reach a resting seated pose")
		return
	await _capture("work-draft")
	panel.run_requested.emit("wait")
	await get_tree().create_timer(0.6).timeout
	if _controller.messages().back()["status"] != "running" or sprite.animation != &"work" or not sprite.is_playing():
		_fail("Real Host Run did not project into the work animation")
		return
	await _capture("work-active")
	panel.close_requested.emit()
	await get_tree().create_timer(0.7).timeout
	if _controller.messages().back()["status"] != "running" or _actor.activity_phase() != PartnerActor.ActivityPhase.WORK_SEATED:
		_fail("Collapsing Main conversation cancelled the task or seated activity")
		return
	await _capture("work-collapsed")
	var running_id: String = _controller.messages().back()["id"]
	var walk_start := _actor.global_position
	Input.action_press("move_right")
	for frame: int in range(40): await get_tree().physics_frame
	Input.action_release("move_right")
	await get_tree().create_timer(0.3).timeout
	var station: WorkshopWorkstation = _world.get_node("Workbench")
	var inspect_area: Button = station.get_node("InspectArea")
	if _actor.activity_phase() != PartnerActor.ActivityPhase.NONE or _actor.global_position.x < walk_start.x + 50 or not station.is_running() or not inspect_area.visible or _controller.messages().back()["id"] != running_id or _controller.messages().back()["status"] != "running":
		_fail("Walking away did not preserve the same running task and visible workstation status")
		return
	await _capture("work-background-away")
	RenderingServer.force_draw()
	var animation_region := Rect2i(inspect_area.get_global_transform_with_canvas() * Rect2(Vector2.ZERO, inspect_area.size))
	var before_status := get_viewport().get_texture().get_image().get_region(animation_region)
	await get_tree().create_timer(0.25).timeout
	RenderingServer.force_draw()
	if before_status.get_data() == get_viewport().get_texture().get_image().get_region(animation_region).get_data():
		_fail("Background work indicator did not animate")
		return
	await _capture("work-background-motion")
	_world.interaction_requested.emit(&"bed")
	if _actor.activity_phase() == PartnerActor.ActivityPhase.RESTING or _controller.messages().back()["status"] != "running":
		_fail("Sleep interaction interrupted an active Run")
		return
	var away_contact := _actor.global_position
	await _click_prompt(inspect_area)
	await get_tree().create_timer(0.2).timeout
	if _actor.activity_phase() != PartnerActor.ActivityPhase.NONE or not _actor.global_position.is_equal_approx(away_contact) or _controller.messages().back()["id"] != running_id:
		_fail("Status inspection moved the character or replaced the active Run")
		return
	await _capture("work-background-inspected")
	panel.cancel_requested.emit()
	while _controller.messages().back()["status"] == "running": await get_tree().process_frame
	panel.close_requested.emit()
	await get_tree().create_timer(1.0).timeout
	if _actor.activity_phase() != PartnerActor.ActivityPhase.NONE or absf(_actor.global_position.y - 669.0) > 1.0:
		_fail("Main Stop and close did not restore the walking surface")
		return
	await _capture("work-finished")
	if station.is_running() or station.result_status() != &"cancelled" or not inspect_area.visible or station.is_processing():
		_fail("Cancelled task did not retain a distinct stopped result")
		return
	# Inspect the stopped result, then complete a real Host Run. Success is not
	# inferred from the same boolean that also becomes false on cancellation.
	await _click_prompt(inspect_area)
	panel.run_requested.emit("complete")
	while _controller.messages().back()["status"] == "running": await get_tree().process_frame
	await get_tree().create_timer(0.5).timeout
	await _capture("work-done-focused")
	panel.close_requested.emit()
	await get_tree().create_timer(0.7).timeout
	var completed_id: String = _controller.messages().back()["id"]
	if station.result_status() != &"completed" or not inspect_area.visible or station.is_processing():
		_fail("Successful Run did not retain a settled Done marker")
		return
	await _capture("work-done")
	var done_contact := _actor.global_position
	await _click_prompt(inspect_area)
	await get_tree().create_timer(0.5).timeout
	if inspect_area.visible or not _actor.global_position.is_equal_approx(done_contact) or _controller.messages().back()["id"] != completed_id:
		_fail("Reading Done did not acknowledge the result without moving or resubmitting")
		return
	await _capture("work-done-inspected")
	panel.new_session_requested.emit()
	while _controller.current_session().get("sessionId", "") != "fixture-session-new": await get_tree().process_frame
	panel.close_requested.emit()
	await get_tree().create_timer(0.3).timeout
	if station.result_status() != &"idle" or inspect_area.visible:
		_fail("A new Session inherited the previous Done marker")
		return
	print("work_result_verified: distinct cancelled and completed, retained Done, read acknowledgement, same result, no teleport, new Session clears")
	print("background_work_verified: leave by movement, same Run, animated status, click inspection, no teleport, terminal cleanup")
	print("work_conversation_verified: Main, Host Run, seated motion, collapse, Stop, walking contact")

func _verify_sleep() -> void:
	_actor.reset_to_spawn(Vector2(470, 669))
	await get_tree().create_timer(0.3).timeout
	_rig.snap_to_target()
	await _capture("bed-awake")
	var contact := _actor.global_position
	var prompt: Control = _world.get_node("InteractionPoints/BedInteraction/Prompt")
	# Hold composition for two rendered states so the bed's fixed supports can
	# be compared pixel-for-pixel without camera resampling or actor overlap.
	_rig.set_process(false)
	var frame_regions := _bed_frame_regions()
	RenderingServer.force_draw()
	var awake_frame := get_viewport().get_texture().get_image()
	await _click_prompt(prompt)
	RenderingServer.force_draw()
	var sleeping_frame := get_viewport().get_texture().get_image()
	_rig.set_process(true)
	for region: Rect2i in frame_regions:
		if awake_frame.get_region(region).get_data() != sleeping_frame.get_region(region).get_data():
			awake_frame.save_png("res://tests/evidence/workshop-production-style/bed-fixed-before.png")
			sleeping_frame.save_png("res://tests/evidence/workshop-production-style/bed-fixed-after.png")
			_fail("Sleeping changed the fixed bed frame pixels at %s" % region)
			return
	print("bed_frame_verified: three fixed supports are pixel-identical across sleep transition")
	if _actor.activity_phase() != PartnerActor.ActivityPhase.RESTING or not _actor.global_position.is_equal_approx(contact):
		_fail("Production sleep click did not directly enter the bed state")
		return
	if prompt.visible:
		_fail("Sleep interaction retained its large prompt")
		return
	await get_tree().create_timer(1.0).timeout
	await _capture("bed-sleep-focused")
	await get_tree().create_timer(0.8).timeout
	await _capture("bed-sleep-bubble")
	get_window().size = Vector2i(1920, 1080)
	await get_tree().create_timer(0.7).timeout
	await _capture("bed-sleep-1080p")
	$Main/GameDisplay.toggle_fullscreen()
	await get_tree().create_timer(1.5).timeout
	await _capture("bed-sleep-fullscreen")
	$Main/GameDisplay.toggle_fullscreen()
	get_window().size = Vector2i(1440, 900)
	await get_tree().process_frame
	await get_tree().process_frame
	await _click_prompt(_world.get_node("InteractionPoints/BedInteraction/Marker"))
	await get_tree().create_timer(0.7).timeout
	if _actor.activity_phase() != PartnerActor.ActivityPhase.NONE or not _actor.global_position.is_equal_approx(contact) or not _actor.get_node("CharacterVisual").visible:
		_fail("Production wake click failed to restore the actor")
		return
	await _capture("bed-wake-restored")
	print("sleep_main_verified: clickable sleep/wake, direct pose, focus, fullscreen, original contact")

func _verify_rest_and_exit() -> void:
	for spot_name: String in ["Sofa", "UpperBed"]:
		var spot: WorkshopRestSpot = _world.get_node("Visual/" + spot_name)
		_actor.reset_to_spawn(spot.standing_contact())
		await get_tree().create_timer(0.3).timeout
		_rig.snap_to_target()
		await _capture(spot_name + "-awake")
		var prompt: Control = _world.get_node("InteractionPoints/" + spot_name + "Interaction/Prompt")
		var contact := _actor.global_position
		await _click_prompt(prompt)
		await get_tree().create_timer(1.0).timeout
		if _actor.rest_spot() != spot or not _actor.global_position.is_equal_approx(contact):
			_fail("Main furniture click/contact failed: " + spot_name)
			return
		if prompt.visible:
			_fail("Furniture interaction retained its large prompt: " + spot_name)
			return
		await _capture(spot_name + "-rest-focused")
		$Main/GameDisplay.toggle_fullscreen()
		await get_tree().create_timer(1.0).timeout
		await _capture(spot_name + "-rest-fullscreen")
		$Main/GameDisplay.toggle_fullscreen()
		get_window().size = Vector2i(1440, 900)
		await get_tree().process_frame
		await get_tree().process_frame
		await _click_prompt(_world.get_node("InteractionPoints/" + spot_name + "Interaction/Marker"))
		await get_tree().create_timer(0.4).timeout
		if _actor.rest_spot() != null or not _actor.get_node("CharacterVisual").visible:
			_fail("Main furniture wake failed: " + spot_name)
			return
	var menu: WorkshopMenu = $Main/UIRoot/WorkshopMenu
	await _click_prompt(menu.get_node("OpenButton"))
	await get_tree().process_frame
	if not menu.is_open() or not menu.get_node("MenuPanel/Margin/Content/ContinueButton").has_focus():
		_fail("Menu did not open with keyboard focus")
		return
	await _capture("menu-reviewed")
	await _click_prompt(menu.get_node("MenuPanel/Margin/Content/ReturnButton"))
	await _wait_for_selection()
	if _failed: return
	await _capture("menu-return-selection")
	_controller.select_agent(_presentation.agent_id)
	while not _world.is_active(): await get_tree().process_frame
	_actor.reset_to_spawn(Vector2(2040, 669))
	await get_tree().create_timer(0.3).timeout
	_rig.snap_to_target()
	await _click_prompt(_world.get_node("InteractionPoints/DoorInteraction/Prompt"))
	await _wait_for_selection()
	if _failed: return
	await _capture("door-return-selection")
	print("rest_main_verified: sofa and upper bed clicks, contact, fullscreen, wake")
	print("workspace_return_verified: menu and door close Session and return to character selection")

func _wait_for_selection() -> void:
	for frame: int in range(180):
		await get_tree().process_frame
		if not _world.is_active() and $Main/UIRoot/SelectionLayer.visible:
			return
	_fail("Leaving did not return to Agent selection")

func _bed_frame_regions() -> Array[Rect2i]:
	var bed: Node2D = _world.get_node("Visual/Bed")
	var regions: Array[Rect2i] = []
	for local_rect: Rect2 in [Rect2(147, 108, 12, 38), Rect2(233, 57, 7, 70), Rect2(133, 57, 6, 17)]:
		regions.append(Rect2i(bed.get_global_transform_with_canvas() * local_rect))
	return regions

func _click_prompt(prompt: Control) -> void:
	var position := prompt.get_global_transform_with_canvas() * (prompt.size * 0.5)
	# Canvas coordinates are viewport-local. Submit the complete synthetic
	# gesture before yielding, so native pointer motion cannot cancel it.
	for pressed in [true, false]:
		var click := InputEventMouseButton.new()
		click.button_index = MOUSE_BUTTON_LEFT
		click.position = position
		click.pressed = pressed
		click.button_mask = MOUSE_BUTTON_MASK_LEFT if pressed else 0
		get_viewport().push_input(click, true)
	await get_tree().process_frame

func _capture(label: String) -> void:
	await get_tree().process_frame
	_verify_character_presentation()
	if _failed: return
	RenderingServer.force_draw()
	var output := "res://tests/evidence/workshop-production-style/" + _presentation.agent_id
	DirAccess.make_dir_recursive_absolute(ProjectSettings.globalize_path(output))
	var frame := get_viewport().get_texture().get_image()
	if frame.save_png(output.path_join(label + ".png")) != OK:
		_fail("Failed to capture " + label)
	print("Captured production %s: %s pixels, camera zoom %.3f" % [label, frame.get_size(), _rig.get_node("Camera2D").zoom.x])

func _verify_character_presentation() -> void:
	if not _world.is_active(): return
	var sprite: AnimatedSprite2D = _actor.get_node("CharacterVisual")
	var equipment := sprite.get_child(0) as Sprite2D
	var animation_set: CharacterAnimationSet = _presentation.animation_set
	if not sprite.scale.is_equal_approx(animation_set.visual_scale) or equipment == null or equipment.texture != animation_set.back_equipment:
		_fail("Main character scale or back-carried staff differs from the approved production resource")
		return
	if _actor.activity_phase() == PartnerActor.ActivityPhase.WORK_SEATED:
		if sprite.sprite_frames != animation_set.work_frames or equipment.is_visible_in_tree():
			_fail("Seated work did not use production frames with hidden back equipment")
	elif _actor.activity_phase() == PartnerActor.ActivityPhase.RESTING:
		if sprite.is_visible_in_tree() or equipment.is_visible_in_tree():
			_fail("Resting furniture retained the walking body or floating staff")
	else:
		if sprite.sprite_frames != animation_set.frames or equipment.is_visible_in_tree() != (animation_set.back_equipment != null):
			_fail("Leaving activity did not restore the production mage and back equipment")

func _fail(message: String) -> void:
	_failed = true
	printerr(message)
	Input.action_release("move_right")
	Input.action_release("climb_up")
	$Main/AgentHostClient.shutdown()
	get_tree().quit(1)
