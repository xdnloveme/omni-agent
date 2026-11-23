extends Node

@onready var world: WorkshopWorld = $WorkshopWorld
@onready var actor: PartnerActor = $WorkshopWorld/PartnerActor
@onready var station: WorkshopWorkstation = $WorkshopWorld/Workbench
@onready var sprite: AnimatedSprite2D = $WorkshopWorld/PartnerActor/CharacterVisual
var failed := false

func _ready() -> void:
	get_tree().create_timer(25.0).timeout.connect(func() -> void: _fail("Work lifecycle timed out"))
	get_window().size = Vector2i(1440, 900)
	world.enter_workspace(load("res://resources/characters/coding.tres"))
	world.set_input_enabled(true)
	actor.reset_to_spawn(Vector2(1460, 669))
	await _frames(8)
	if not world.begin_workbench_interaction():
		_fail("Nearby grounded actor could not approach workstation")
		return
	world.set_input_enabled(false)
	world.set_conversation_focus(true, Rect2(700, 80, 716, 790), false)
	await _wait_seated()
	if failed: return
	if absf(actor.global_position.y - station.approach.global_position.y) > 1.0 or not sprite.global_position.is_equal_approx(station.seat.global_position):
		_fail("Seated visual contact or unchanged physical floor contact is incorrect")
		return
	if sprite.animation != &"work" or sprite.is_playing():
		_fail("Drafting state must hold seated pose, not pretend a Run is executing")
		return
	world.set_work_status(&"running")
	await _frames(20)
	var first := sprite.frame
	await _frames(20)
	if sprite.animation != &"work" or not sprite.is_playing() or sprite.frame == first:
		_fail("Running state did not advance independent work frames")
		return
	# Collapsing UI changes composition, not the ongoing seated activity.
	world.set_conversation_focus(false, Rect2(), false)
	world.set_input_enabled(true)
	await _frames(35)
	if actor.activity_phase() != PartnerActor.ActivityPhase.WORK_SEATED:
		_fail("Collapsing conversation abandoned the work station")
		return
	Input.action_press("jump")
	await _frames(2)
	Input.action_release("jump")
	if actor.activity_phase() != PartnerActor.ActivityPhase.NONE or actor.velocity.y >= 0 or not station.is_running():
		_fail("First jump did not leave the seat while preserving projected background work")
		return
	await _frames(80)
	if not actor.is_on_floor() or not world.begin_workbench_interaction():
		_fail("Could not return to the work seat after jumping away")
		return
	await _wait_seated()
	# Direct pose switching must restore the floor immediately, without a tween.
	world.end_workbench_interaction()
	if actor.activity_phase() != PartnerActor.ActivityPhase.NONE or absf(actor.global_position.y - 669.0) > 1.0:
		_fail("Direct seated exit did not immediately restore the walking contact")
		return
	await _frames(4)
	if not world.begin_workbench_interaction():
		_fail("Could not re-enter work after direct exit")
		return
	world.set_input_enabled(false)
	await _wait_seated()
	if failed: return
	world.set_work_status(&"idle")
	world.end_workbench_interaction()
	await _frames(48)
	if actor.activity_phase() != PartnerActor.ActivityPhase.NONE or absf(actor.global_position.y - 669.0) > 1.0:
		_fail("Standing up failed to restore the authored walking surface")
		return
	world.set_input_enabled(true)
	var before_walk := actor.global_position
	Input.action_press("move_right")
	await _frames(12)
	Input.action_release("move_right")
	if actor.global_position.x <= before_walk.x + 2.0:
		_fail("Traversal did not resume after standing up")
		return
	actor.reset_to_spawn(Vector2(1378, 669))
	await _frames(8)
	world.begin_workbench_interaction()
	world.set_input_enabled(false)
	await _wait_seated()
	world.leave_workspace()
	if actor.activity_phase() != PartnerActor.ActivityPhase.NONE or station.is_running() or absf(actor.global_position.y - 669.0) > 1.0:
		_fail("Leaving the world retained a seat contact or work state")
		return
	print("work_activity_verified: approach, rear seat, run-only motion, collapse, direct exit, re-entry, traversal, leave")
	world.enter_workspace(load("res://resources/characters/coding.tres"))
	world.set_input_enabled(true)
	actor.reset_to_spawn(Vector2(470, 669))
	await _frames(8)
	var contact := actor.global_position
	if not world.toggle_rest_interaction(&"bed") or actor.activity_phase() != PartnerActor.ActivityPhase.RESTING or sprite.visible or not actor.global_position.is_equal_approx(contact):
		_fail("Sleep must directly replace the sprite without moving physical contact")
		return
	if world.begin_workbench_interaction():
		_fail("Work and sleep cannot coexist")
		return
	world.toggle_rest_interaction(&"bed")
	if not sprite.visible or not actor.global_position.is_equal_approx(contact):
		_fail("Direct wake did not restore the original contact and sprite")
		return
	world.toggle_rest_interaction(&"bed")
	Input.action_press("move_right")
	await _frames(8)
	Input.action_release("move_right")
	if actor.activity_phase() != PartnerActor.ActivityPhase.NONE or not sprite.visible or actor.global_position.x <= contact.x:
		_fail("Movement did not wake and resume traversal")
		return
	await _frames(16)
	world.toggle_rest_interaction(&"bed")
	world.leave_workspace()
	if actor.activity_phase() != PartnerActor.ActivityPhase.NONE or not sprite.visible or world.get_node("Visual/Bed").is_visible_in_tree():
		_fail("Leaving retained sleeping presentation")
		return
	print("sleep_activity_verified: direct sleep, unchanged contact, exclusive activity, wake, movement, leave")
	world.enter_workspace(load("res://resources/characters/coding.tres"))
	world.set_input_enabled(true)
	for spot_name: String in ["Bed", "UpperBed", "Sofa"]:
		var spot: WorkshopRestSpot = world.get_node("Visual/" + spot_name)
		actor.reset_to_spawn(spot.standing_contact())
		await _frames(8)
		var standing := actor.global_position
		if not world.toggle_rest_interaction(spot.interaction_id) or actor.rest_spot() != spot or not spot.is_resting() or sprite.visible:
			_fail("Furniture did not enter its own resting pose: " + spot_name)
			return
		for other_name: String in ["Bed", "UpperBed", "Sofa"]:
			var other: WorkshopRestSpot = world.get_node("Visual/" + other_name)
			if other != spot and (other.is_resting() or world.toggle_rest_interaction(other.interaction_id)):
				_fail("Multiple furniture rests coexisted")
				return
		world.end_rest()
		if not sprite.visible or spot.is_resting() or not actor.global_position.is_equal_approx(standing):
			_fail("Furniture exit changed physical contact: " + spot_name)
			return
		world.toggle_rest_interaction(spot.interaction_id)
		world.leave_workspace()
		if actor.rest_spot() != null or spot.is_resting():
			_fail("Workspace exit retained furniture occupancy")
			return
		world.enter_workspace(load("res://resources/characters/coding.tres"))
		world.set_input_enabled(true)
	print("rest_spots_verified: three poses, exclusive occupancy, unchanged contacts, exit and re-entry")
	get_tree().quit(0)

func _wait_seated() -> void:
	for index in range(180):
		await get_tree().physics_frame
		if actor.activity_phase() == PartnerActor.ActivityPhase.WORK_SEATED:
			await _frames(2)
			return
	_fail("Approach did not finish in a bounded interval")

func _frames(count: int) -> void:
	for index in range(count): await get_tree().physics_frame

func _fail(message: String) -> void:
	failed = true
	Input.action_release("move_right")
	printerr(message)
	get_tree().quit(1)
