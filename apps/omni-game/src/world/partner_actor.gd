class_name PartnerActor
extends CharacterBody2D

signal inspection_requested()
signal activity_changed()

enum ActivityPhase { NONE, WORK_APPROACH, WORK_SEATED, RESTING }

enum MovementState {
	GROUNDED,
	AIRBORNE,
	LADDER_CLIMB,
}

const PartnerAnimatorScript = preload("res://src/world/partner_animator.gd")
const MAX_GROUND_VISUAL_OFFSET := 8.0

var locomotion_config: PartnerLocomotionConfig

@onready var _animator: Node = %PartnerAnimator
@onready var _ground_visual_probe: RayCast2D = %GroundVisualProbe

var _input_enabled := false
var _movement_state := MovementState.GROUNDED
var _ladder_candidates: Array[Node] = []
# Zero blocks both directions after jumping off; an endpoint blocks only the
# completed direction so immediate deliberate reversal never needs a dead frame.
var _blocked_ladders: Dictionary[Node, float] = {}
var _active_ladder: Node
var _ignored_surfaces: Array[CollisionObject2D] = []
var _coyote_remaining := 0.0
var _jump_buffer_remaining := 0.0
var _jump_preparation_remaining := -1.0
var _prepared_jump_released := false
var _facing := 1.0
var _debug_visible := false
var _activity_phase := ActivityPhase.NONE
var _workstation: WorkshopWorkstation
var _rest_spot: WorkshopRestSpot
var _work_running := false
var _presentation: CharacterPresentation

func _ready() -> void:
	input_pickable = true
	motion_mode = CharacterBody2D.MOTION_MODE_GROUNDED
	floor_constant_speed = true
	floor_stop_on_slope = true
	queue_redraw()

func _draw() -> void:
	if not _debug_visible:
		return
	draw_line(Vector2(-34.0, 0.0), Vector2(34.0, 0.0), Color(1.0, 0.25, 0.75), 3.0)
	draw_circle(Vector2.ZERO, 4.0, Color(1.0, 0.25, 0.75))

func _exit_tree() -> void:
	_cleanup_traversal(MovementState.AIRBORNE, false)

func _input_event(_viewport: Node, event: InputEvent, _shape_index: int) -> void:
	if (
		event is InputEventMouseButton
		and event.button_index == MOUSE_BUTTON_LEFT
		and event.pressed
	):
		inspection_requested.emit()

func _physics_process(delta: float) -> void:
	if _presentation == null:
		return
	# Leaving furniture is local movement, not task cancellation. Consume the
	# same input in free movement this frame so a first jump is not swallowed.
	if _activity_phase != ActivityPhase.NONE and _input_enabled and (
		not is_zero_approx(Input.get_axis("move_left", "move_right"))
		or not is_zero_approx(Input.get_axis("climb_up", "climb_down"))
		or Input.is_action_just_pressed("jump")
	):
		_clear_activity()
	if _activity_phase == ActivityPhase.RESTING:
		return
	if _activity_phase != ActivityPhase.NONE:
		_process_work_activity(delta)
		return
	if not _input_enabled:
		velocity = Vector2.ZERO
		_animator.present_motion(
			_visual_state_for_movement(),
			Vector2.ZERO,
			Vector2.ZERO,
			_facing,
			is_on_floor(),
			_ground_visual_offset(),
			_ladder_top_distance(),
		)
		return

	var horizontal := Input.get_axis("move_left", "move_right")
	var vertical := Input.get_axis("climb_up", "climb_down")
	var jump_pressed := Input.is_action_just_pressed("jump")
	var jump_released := Input.is_action_just_released("jump")
	if jump_released and _jump_preparation_remaining >= 0.0:
		_prepared_jump_released = true
	_update_jump_windows(delta, jump_pressed)
	if is_zero_approx(vertical):
		_blocked_ladders.clear()

	if (
		_movement_state in [MovementState.GROUNDED, MovementState.AIRBORNE]
		and not is_zero_approx(vertical)
		and not jump_pressed
	):
		var candidate := _select_ladder(vertical)
		if candidate != null:
			_begin_ladder_climb(candidate)

	match _movement_state:
		MovementState.GROUNDED, MovementState.AIRBORNE:
			_process_free_movement(delta, horizontal)
		MovementState.LADDER_CLIMB:
			_process_ladder_climb(delta, horizontal, vertical, jump_pressed)

	if jump_released and _movement_state == MovementState.AIRBORNE and velocity.y < 0.0:
		velocity.y *= locomotion_config.jump_cut_multiplier

	var previous_position := global_position
	move_and_slide()
	_finalize_state(vertical)
	var actual_displacement := global_position - previous_position
	_update_facing_from_motion()
	_animator.present_motion(
		_visual_state_for_movement(),
		velocity,
		actual_displacement,
		_facing,
		is_on_floor(),
		_ground_visual_offset(),
		_ladder_top_distance(),
		_jump_preparation_progress(),
	)

func set_input_enabled(enabled: bool) -> void:
	_input_enabled = enabled
	if not enabled:
		velocity = Vector2.ZERO
		_cancel_jump_preparation()
		_jump_buffer_remaining = 0.0

func set_conversation_focus(active: bool) -> void:
	_animator.set_conversation_focus(active)

func set_ladder_candidate(route: Node, available: bool) -> void:
	if available:
		if not _ladder_candidates.has(route):
			_ladder_candidates.append(route)
	else:
		_ladder_candidates.erase(route)
		_blocked_ladders.erase(route)

func set_presentation(presentation: CharacterPresentation) -> void:
	assert(presentation.animation_set != null, "Character presentation requires an animation set")
	assert(presentation.locomotion_config != null, "Character requires a locomotion config")
	if _presentation == presentation:
		return
	_clear_activity()
	_cleanup_traversal(MovementState.AIRBORNE, true)
	_presentation = presentation
	locomotion_config = presentation.locomotion_config
	floor_snap_length = locomotion_config.floor_snap_distance
	assert(locomotion_config.jump_preparation_duration == 0.0 or presentation.animation_set.airborne_phase_frames.x > 0,
		"Jump preparation requires authored grounded poses")
	_animator.configure(presentation.animation_set, locomotion_config.jump_speed)

func reset_to_spawn(spawn_position: Vector2) -> void:
	_clear_activity()
	_cleanup_traversal(MovementState.GROUNDED, false)
	global_position = spawn_position
	velocity = Vector2.ZERO
	# Area enter/exit events own proximity. A reset can remain inside the same
	# ladder area, so clearing its record here would lose it until re-entry.
	# Entry still validates the actual grounded endpoint in _select_ladder.
	_blocked_ladders.clear()
	_coyote_remaining = 0.0
	_jump_buffer_remaining = 0.0
	_animator.reset()

func set_debug_visible(visible: bool) -> void:
	_debug_visible = visible
	queue_redraw()

func leave_workspace() -> void:
	_clear_activity()
	_work_running = false
	_cleanup_traversal(MovementState.AIRBORNE, false)
	_ladder_candidates.clear()
	_blocked_ladders.clear()
	velocity = Vector2.ZERO

func is_climbing() -> bool:
	return _movement_state == MovementState.LADDER_CLIMB

func movement_state() -> int:
	return _movement_state

func active_ladder() -> Node:
	return _active_ladder

func ignored_surface_count() -> int:
	return _ignored_surfaces.size()

func activity_phase() -> int:
	return _activity_phase

func work_station() -> WorkshopWorkstation:
	return _workstation

func rest_spot() -> WorkshopRestSpot:
	return _rest_spot

func begin_rest(spot: WorkshopRestSpot) -> bool:
	if _jump_preparation_remaining >= 0.0: return false
	if not spot.has_rest_art(): return false
	if _activity_phase != ActivityPhase.NONE or not is_on_floor() or _movement_state != MovementState.GROUNDED:
		return false
	var standing_contact := spot.standing_contact()
	if absf(global_position.y - standing_contact.y) > 3.0 or absf(global_position.x - standing_contact.x) > 120.0:
		return false
	# Furniture projects the resting pose. Physical position stays on the existing
	# walk surface so direct wake-up restores the same valid contact.
	_rest_spot = spot
	_activity_phase = ActivityPhase.RESTING
	velocity = Vector2.ZERO
	_jump_buffer_remaining = 0.0
	_coyote_remaining = 0.0
	_animator.present_rest()
	activity_changed.emit()
	return true

func end_rest() -> void:
	if _activity_phase == ActivityPhase.RESTING:
		_clear_activity()

func begin_work(station: WorkshopWorkstation) -> bool:
	if _jump_preparation_remaining >= 0.0: return false
	if not _animator.has_work_animation():
		return false
	if _workstation == station:
		return true
	if _activity_phase != ActivityPhase.NONE or not is_on_floor() or _movement_state != MovementState.GROUNDED:
		return false
	# Only a nearby, same-floor interaction can initiate the furniture approach.
	# This is not a teleport or a second map-wide navigation implementation.
	if absf(global_position.y - station.approach.global_position.y) > 3.0 or absf(global_position.x - station.approach.global_position.x) > 220.0:
		return false
	_workstation = station
	_activity_phase = ActivityPhase.WORK_APPROACH
	_jump_buffer_remaining = 0.0
	_coyote_remaining = 0.0
	activity_changed.emit()
	return true

func set_work_running(running: bool) -> void:
	_work_running = running

func end_work() -> void:
	if _activity_phase in [ActivityPhase.WORK_APPROACH, ActivityPhase.WORK_SEATED]:
		_clear_activity()

func _process_work_activity(delta: float) -> void:
	if not is_instance_valid(_workstation):
		_clear_activity()
		return
	if _activity_phase == ActivityPhase.WORK_APPROACH:
		var distance := _workstation.approach.global_position.x - global_position.x
		if absf(distance) <= 0.5:
			_activity_phase = ActivityPhase.WORK_SEATED
			_facing = 1.0
			velocity = Vector2.ZERO
		else:
			var approach_speed := locomotion_config.work_approach_speed
			velocity = Vector2(clampf(distance / delta, -approach_speed, approach_speed), 0.0)
			_facing = signf(distance)
			var previous := global_position
			move_and_slide()
			_animator.present_motion(PartnerAnimatorScript.VisualState.WALK, velocity, global_position - previous, _facing, is_on_floor(), _ground_visual_offset(), INF)
			return
	velocity = Vector2.ZERO
	# Physical contact stays on the walking surface. Furniture owns the seated
	# visual origin; pose switching must not teleport the collision body.
	_animator.present_work(_work_running, to_local(_workstation.seat.global_position))

func _clear_activity() -> void:
	if _activity_phase == ActivityPhase.NONE:
		return
	_activity_phase = ActivityPhase.NONE
	_workstation = null
	_rest_spot = null
	velocity = Vector2.ZERO
	_animator.reset()
	activity_changed.emit()

func _update_jump_windows(delta: float, jump_pressed: bool) -> void:
	if _movement_state == MovementState.GROUNDED and is_on_floor():
		_coyote_remaining = locomotion_config.coyote_time
	else:
		_coyote_remaining = maxf(_coyote_remaining - delta, 0.0)
	if jump_pressed and _movement_state in [MovementState.GROUNDED, MovementState.AIRBORNE]:
		_jump_buffer_remaining = locomotion_config.jump_buffer_time
	else:
		_jump_buffer_remaining = maxf(_jump_buffer_remaining - delta, 0.0)

func _process_free_movement(delta: float, horizontal: float) -> void:
	var target_speed: float = horizontal * locomotion_config.walk_speed
	var acceleration: float = locomotion_config.ground_deceleration
	if not is_zero_approx(horizontal):
		if not is_zero_approx(velocity.x) and signf(horizontal) != signf(velocity.x):
			acceleration = locomotion_config.turn_deceleration
		else:
			acceleration = locomotion_config.ground_acceleration
	velocity.x = move_toward(velocity.x, target_speed, acceleration * delta)
	if _jump_preparation_remaining >= 0.0 and not is_on_floor():
		# Walking over the edge during anticipation must not swallow an accepted
		# jump. Commit within the same existing coyote window, without extra grace.
		if _coyote_remaining > 0.0:
			_jump_preparation_remaining = 0.0
		else:
			_cancel_jump_preparation()
	if _jump_buffer_remaining > 0.0 and _coyote_remaining > 0.0 and _jump_preparation_remaining < 0.0:
		if is_on_floor() and locomotion_config.jump_preparation_duration > 0.0:
			_jump_preparation_remaining = locomotion_config.jump_preparation_duration
			_prepared_jump_released = not Input.is_action_pressed("jump")
			_jump_buffer_remaining = 0.0
	var prepared := false
	if _jump_preparation_remaining >= 0.0:
		_jump_preparation_remaining = maxf(0.0, _jump_preparation_remaining - delta)
		prepared = is_zero_approx(_jump_preparation_remaining)
	if prepared or (_jump_preparation_remaining < 0.0 and _jump_buffer_remaining > 0.0 and _coyote_remaining > 0.0):
		velocity.y = locomotion_config.jump_speed
		if prepared and _prepared_jump_released and not Input.is_action_just_released("jump"):
			velocity.y *= locomotion_config.jump_cut_multiplier
		_cancel_jump_preparation()
		_jump_buffer_remaining = 0.0
		_coyote_remaining = 0.0
		_movement_state = MovementState.AIRBORNE
	else:
		velocity.y = minf(
			velocity.y + locomotion_config.gravity * delta,
			locomotion_config.maximum_fall_speed,
		)

func _jump_preparation_progress() -> float:
	if _jump_preparation_remaining < 0.0:
		return -1.0
	return 1.0 - _jump_preparation_remaining / locomotion_config.jump_preparation_duration

func _cancel_jump_preparation() -> void:
	_jump_preparation_remaining = -1.0
	_prepared_jump_released = false

func _process_ladder_climb(
	delta: float,
	horizontal: float,
	vertical: float,
	jump_pressed: bool,
) -> void:
	if jump_pressed:
		_jump_from_ladder(horizontal)
		return
	if not _has_active_ladder():
		_cleanup_traversal(MovementState.AIRBORNE, true)
		return
	velocity.x = 0.0
	velocity.y = vertical * locomotion_config.climb_speed
	if velocity.y < 0.0:
		velocity.y = maxf(
			velocity.y,
			(_active_ladder.top_point().y - global_position.y) / maxf(delta, 0.0001),
		)
	elif velocity.y > 0.0:
		velocity.y = minf(
			velocity.y,
			(_active_ladder.bottom_point().y - global_position.y) / maxf(delta, 0.0001),
		)

func _finalize_state(vertical: float) -> void:
	if _movement_state == MovementState.LADDER_CLIMB and _has_active_ladder():
		if (
			vertical < 0.0
			and global_position.y
			<= _active_ladder.top_point().y + 0.01
		):
			# Climb velocity is clamped to the endpoint before move_and_slide.
			# Art reach never advances the physical body to the platform.
			_finish_ladder_climb(vertical)
		elif (
			vertical > 0.0
			and global_position.y
			>= _active_ladder.bottom_point().y - 0.01
		):
			_finish_ladder_climb(vertical)
	elif _movement_state in [MovementState.GROUNDED, MovementState.AIRBORNE]:
		_movement_state = MovementState.GROUNDED if is_on_floor() else MovementState.AIRBORNE

func _select_ladder(vertical: float) -> Node:
	# Ladder entry is a grounded transition. Entering from the air would zero the
	# actor's vertical velocity and make a jump hover beside the
	# route before the feet have reached either endpoint.
	if not is_on_floor():
		return null
	var selected: Node
	var selected_distance := INF
	for route in _ladder_candidates:
		if not is_instance_valid(route):
			continue
		if _blocked_ladders.has(route):
			var blocked_direction: float = _blocked_ladders[route]
			if is_zero_approx(blocked_direction) or is_equal_approx(blocked_direction, signf(vertical)):
				continue
		var entry: Vector2 = route.top_point() if vertical > 0.0 else route.bottom_point()
		# The player walks to the center under normal movement control. The broad
		# Area2D is discovery only, never authority to pull a nearby body sideways.
		if absf(global_position.x - entry.x) > locomotion_config.traversal_epsilon:
			continue
		if absf(global_position.y - entry.y) > locomotion_config.floor_snap_distance:
			continue
		var distance: float = global_position.distance_squared_to(entry)
		if distance < selected_distance:
			selected = route
			selected_distance = distance
	return selected

func _begin_ladder_climb(route: Node) -> void:
	_cancel_jump_preparation()
	_active_ladder = route
	_movement_state = MovementState.LADDER_CLIMB
	# At most traversal_epsilon (2 authored pixels), not an approach/exit tween.
	global_position.x = route.center_x()
	velocity = Vector2.ZERO
	_coyote_remaining = 0.0
	_jump_buffer_remaining = 0.0
	_add_connected_surface_exceptions(route)

func _ladder_top_distance() -> float:
	return maxf(0.0, global_position.y - _active_ladder.top_point().y) if _has_active_ladder() else INF

func _finish_ladder_climb(direction: float) -> void:
	_block_active_ladder(signf(direction))
	_cleanup_traversal(MovementState.GROUNDED, true)
	velocity = Vector2.ZERO
	apply_floor_snap()

func _jump_from_ladder(horizontal: float) -> void:
	var jump_direction := signf(horizontal) if not is_zero_approx(horizontal) else _facing
	_block_active_ladder()
	_cleanup_traversal(MovementState.AIRBORNE, true)
	velocity = Vector2(
		jump_direction * locomotion_config.ladder_jump_horizontal_speed,
		locomotion_config.jump_speed,
	)

func _block_active_ladder(direction: float = 0.0) -> void:
	if _has_active_ladder():
		_blocked_ladders[_active_ladder] = direction

func _has_active_ladder() -> bool:
	return _active_ladder != null and is_instance_valid(_active_ladder)

func _add_connected_surface_exceptions(route: Node) -> void:
	for surface in route.connected_surfaces():
		if surface == null or _ignored_surfaces.has(surface):
			continue
		add_collision_exception_with(surface)
		_ignored_surfaces.append(surface)

func _cleanup_traversal(next_state: int, snap_to_floor: bool) -> void:
	_cancel_jump_preparation()
	for surface in _ignored_surfaces:
		if is_instance_valid(surface):
			remove_collision_exception_with(surface)
	_ignored_surfaces.clear()
	_active_ladder = null
	_movement_state = next_state
	if snap_to_floor and is_inside_tree():
		apply_floor_snap()

func _update_facing_from_motion() -> void:
	if absf(velocity.x) >= locomotion_config.facing_deadzone:
		_facing = signf(velocity.x)

func _ground_visual_offset() -> float:
	if not is_on_floor() or _movement_state != MovementState.GROUNDED:
		return 0.0
	_ground_visual_probe.force_raycast_update()
	if not _ground_visual_probe.is_colliding():
		return 0.0
	return clampf(
		_ground_visual_probe.get_collision_point().y - global_position.y,
		0.0,
		MAX_GROUND_VISUAL_OFFSET,
	)

func _visual_state_for_movement() -> int:
	match _movement_state:
		MovementState.LADDER_CLIMB:
			return PartnerAnimatorScript.VisualState.CLIMB
		MovementState.AIRBORNE:
			return PartnerAnimatorScript.VisualState.AIRBORNE
		_:
			return (
				PartnerAnimatorScript.VisualState.WALK
				if absf(velocity.x) >= locomotion_config.facing_deadzone
				else PartnerAnimatorScript.VisualState.IDLE
			)
