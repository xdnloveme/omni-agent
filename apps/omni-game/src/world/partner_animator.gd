class_name PartnerAnimator
extends Node

enum VisualState {
	IDLE,
	WALK,
	AIRBORNE,
	CLIMB,
}

const IDLE_ANIMATION := &"idle"
const WALK_ANIMATION := &"walk"
const JUMP_ANIMATION := &"jump"
const CLIMB_ANIMATION := &"climb"
const CLIMB_FINISH_ANIMATION := &"climb_finish"
const CLIMB_TOP_ANIMATION := &"climb_top"
const CLIMB_STAND_ANIMATION := &"climb_top_stand"

@export_node_path("AnimatedSprite2D") var sprite_path: NodePath

@onready var sprite: AnimatedSprite2D = get_node(sprite_path) as AnimatedSprite2D

var _animation_set: Resource
var _state := VisualState.IDLE
var _walk_distance := 0.0
var _climb_distance := 0.0
var _climb_top_distance := INF
var _ascending := false
var _standing_up := false
var _conversation_focus := false
var _motion_facing := 1.0
var _presenting_work := false
var _landing_remaining := 0.0
var _jump_preparation := -1.0
var _jump_speed := 0.0
var _back_equipment: Sprite2D

func configure(animation_set: Resource, jump_speed: float) -> void:
	assert(animation_set != null, "PartnerAnimator requires an animation set")
	assert(animation_set.frames != null, "CharacterAnimationSet requires SpriteFrames")
	assert(animation_set.frames.has_animation(animation_set.inspection_animation), "CharacterAnimationSet requires its inspection animation")
	_animation_set = animation_set
	assert(jump_speed < 0.0)
	_jump_speed = -jump_speed
	if animation_set.climb_top_entry_frame >= 0:
		assert(animation_set.climb_top_entry_frame < animation_set.frames.get_frame_count(CLIMB_ANIMATION))
		assert(not animation_set.climb_top_hand_heights.is_empty())
	if not animation_set.climb_top_hand_heights.is_empty():
		assert(animation_set.frames.get_frame_count(CLIMB_TOP_ANIMATION) == animation_set.climb_top_hand_heights.size())
		assert(animation_set.frames.has_animation(CLIMB_STAND_ANIMATION))
		if animation_set.back_equipment != null:
			assert(animation_set.climb_top_equipment_poses.size() == animation_set.climb_top_hand_heights.size())
			assert(animation_set.climb_stand_equipment_poses.size() == animation_set.frames.get_frame_count(CLIMB_STAND_ANIMATION))
	if not sprite.animation_finished.is_connected(_on_animation_finished):
		sprite.animation_finished.connect(_on_animation_finished)
		sprite.frame_changed.connect(_sync_equipment)
	if animation_set.climb_finish_height > 0.0:
		assert(animation_set.frames.has_animation(CLIMB_FINISH_ANIMATION), "Ladder finish height requires authored finish poses")
	var jump_count: int = animation_set.frames.get_frame_count(JUMP_ANIMATION)
	assert(animation_set.jump_equipment_poses.is_empty() or animation_set.jump_equipment_poses.size() == jump_count,
		"Jump equipment track must cover every authored jump and landing frame")
	for index in [animation_set.airborne_phase_frames.x, animation_set.airborne_phase_frames.y,
		animation_set.airborne_phase_frames.z, animation_set.landing_frame]:
		assert(index >= 0 and index < jump_count, "Jump phase must reference an authored frame")
	assert(animation_set.airborne_phase_frames.x <= animation_set.airborne_phase_frames.y
		and animation_set.airborne_phase_frames.y <= animation_set.airborne_phase_frames.z
		and animation_set.airborne_phase_frames.z <= animation_set.landing_frame)
	_presenting_work = false
	_conversation_focus = false
	sprite.sprite_frames = animation_set.frames
	sprite.centered = false
	sprite.offset = -animation_set.foot_anchor
	sprite.scale = animation_set.visual_scale
	if _back_equipment == null:
		_back_equipment = Sprite2D.new()
		_back_equipment.centered = false
		_back_equipment.z_index = -1
		sprite.add_child(_back_equipment)
	_back_equipment.texture = animation_set.back_equipment
	_back_equipment.offset = -animation_set.back_equipment_anchor
	reset()

func _process(delta: float) -> void:
	if _landing_remaining <= 0.0:
		return
	_landing_remaining = maxf(0.0, _landing_remaining - delta)
	if _landing_remaining == 0.0:
		_apply_state()
	else:
		_apply_landing_phase()
	_sync_equipment()

func present_motion(
	state: int,
	actual_velocity: Vector2,
	actual_displacement: Vector2,
	facing: float,
	grounded: bool,
	ground_visual_offset: float,
	ladder_top_distance: float,
	jump_preparation: float = -1.0,
) -> void:
	if _animation_set == null:
		return
	if _presenting_work:
		_presenting_work = false
		sprite.z_index = 0
		sprite.sprite_frames = _animation_set.frames
		_apply_state()
	_motion_facing = facing
	var preparation_changed := (_jump_preparation >= 0.0) != (jump_preparation >= 0.0)
	_jump_preparation = jump_preparation
	var entered_climb := state == VisualState.CLIMB and state != _state
	_climb_top_distance = ladder_top_distance
	if state == VisualState.CLIMB and absf(actual_velocity.y) > 0.01:
		_ascending = actual_velocity.y < 0.0
	if state != _state:
		_standing_up = _state == VisualState.CLIMB and _ascending and grounded and state == VisualState.IDLE and sprite.animation == CLIMB_TOP_ANIMATION
	sprite.flip_h = false if _conversation_focus and state == VisualState.IDLE else facing < 0.0
	sprite.position.y = ground_visual_offset if grounded else move_toward(sprite.position.y, 0.0, 1.0)
	if state != _state:
		var landed := _state == VisualState.AIRBORNE and state == VisualState.IDLE and grounded
		_landing_remaining = _animation_set.landing_duration if landed else 0.0
		_state = state
		_apply_state()
	elif preparation_changed:
		_apply_state()
	if _jump_preparation >= 0.0:
		_landing_remaining = 0.0
		sprite.animation = JUMP_ANIMATION
		sprite.stop()
		_apply_jump_range(0, _animation_set.airborne_phase_frames.x, _jump_preparation)
		_sync_equipment()
		return
	match _state:
		VisualState.WALK:
			# Gait follows actual physical travel, never an automatic exit tween.
			_walk_distance = fmod(
				_walk_distance + actual_displacement.length(),
				_animation_set.walk_stride_pixels,
			)
			_apply_walk_phase()
		VisualState.CLIMB:
			if entered_climb and _animation_set.climb_top_entry_frame >= 0:
				# Align the cycle at the real top-contact boundary, independent of
				# ladder length or where the actor entered. Do this only on entry:
				# pause/reverse must continue the same signed distance clock.
				var stride: float = _animation_set.climb_stride_pixels
				var count := sprite.sprite_frames.get_frame_count(CLIMB_ANIMATION)
				var entry_phase: float = (float(_animation_set.climb_top_entry_frame) + 0.5) / count
				var approach: float = _climb_top_distance - _animation_set.climb_top_start_height * _animation_set.visual_scale.y
				_climb_distance = fposmod(entry_phase * stride - approach, stride)
			elif absf(actual_velocity.y) > 0.01:
				_climb_distance = fposmod(
					_climb_distance - actual_displacement.y,
					_animation_set.climb_stride_pixels,
				)
			_apply_climb_phase()
		VisualState.AIRBORNE:
			var phases: Vector3i = _animation_set.airborne_phase_frames
			var apex: float = _animation_set.apex_vertical_speed
			if actual_velocity.y < -apex:
				_apply_jump_range(phases.x, phases.y, inverse_lerp(-_jump_speed, -apex, actual_velocity.y))
			elif actual_velocity.y > apex:
				_apply_jump_range(phases.z, _animation_set.landing_frame, inverse_lerp(apex, _jump_speed, actual_velocity.y))
			else:
				_apply_jump_range(phases.y, phases.z, inverse_lerp(-apex, apex, actual_velocity.y))
	_sync_equipment()

func set_conversation_focus(active: bool) -> void:
	if active == _conversation_focus:
		return
	_conversation_focus = active
	if _state == VisualState.IDLE and not _presenting_work:
		sprite.flip_h = false if active else _motion_facing < 0.0
		_apply_state()
		_sync_equipment()

func reset() -> void:
	sprite.visible = true
	_presenting_work = false
	sprite.z_index = 0
	if _animation_set != null:
		sprite.sprite_frames = _animation_set.frames
	_walk_distance = 0.0
	_climb_distance = 0.0
	_climb_top_distance = INF
	_ascending = false
	_standing_up = false
	_landing_remaining = 0.0
	_jump_preparation = -1.0
	_state = VisualState.IDLE
	sprite.position = Vector2.ZERO
	_apply_state()
	_sync_equipment()

func _sync_equipment() -> void:
	if _back_equipment == null or _animation_set == null:
		return
	_back_equipment.visible = _back_equipment.texture != null and not _presenting_work
	if _back_equipment.texture == null:
		return
	var facing := -1.0 if sprite.flip_h else 1.0
	var climbing := _state == VisualState.CLIMB or _standing_up
	var mount: Vector2 = _animation_set.climb_equipment_mount if climbing else _animation_set.back_equipment_mount
	var angle: float = _animation_set.climb_equipment_angle if climbing else _animation_set.back_equipment_angle
	var pose := Vector3(mount.x, mount.y, angle)
	if sprite.animation == CLIMB_TOP_ANIMATION:
		pose = _animation_set.climb_top_equipment_poses[sprite.frame]
	elif sprite.animation == CLIMB_STAND_ANIMATION:
		pose = _animation_set.climb_stand_equipment_poses[sprite.frame]
	elif sprite.animation == JUMP_ANIMATION and not _animation_set.jump_equipment_poses.is_empty():
		pose = _animation_set.jump_equipment_poses[sprite.frame]
	mount = Vector2(pose.x, pose.y)
	angle = pose.z
	_back_equipment.position = (mount - _animation_set.foot_anchor) * Vector2(facing, 1)
	_back_equipment.rotation = deg_to_rad(angle * facing)
	_back_equipment.scale = Vector2(facing, 1) * _animation_set.back_equipment_scale

func has_work_animation() -> bool:
	return _animation_set != null and _animation_set.work_frames != null

func present_rest() -> void:
	_standing_up = false
	_landing_remaining = 0.0
	_jump_preparation = -1.0
	sprite.stop()
	sprite.visible = false

func present_work(working: bool, visual_origin: Vector2) -> void:
	_standing_up = false
	_landing_remaining = 0.0
	_jump_preparation = -1.0
	assert(has_work_animation(), "Work presentation needs authored work frames")
	if not _presenting_work:
		_presenting_work = true
		_sync_equipment()
		sprite.sprite_frames = _animation_set.work_frames
		# Seated behind the authored chair back; exploration stays in front.
		sprite.z_index = -1
	sprite.flip_h = false
	sprite.position = visual_origin
	if working:
		if sprite.animation != &"work" or not sprite.is_playing():
			sprite.play(&"work")
	else:
		sprite.animation = &"work"
		sprite.stop()
		sprite.frame = 0

func _apply_state() -> void:
	if sprite.sprite_frames == null:
		return
	sprite.speed_scale = 1.0
	if _standing_up:
		sprite.play(CLIMB_STAND_ANIMATION)
		return
	if _landing_remaining > 0.0:
		sprite.animation = JUMP_ANIMATION
		sprite.stop()
		_apply_landing_phase()
		return
	match _state:
		VisualState.IDLE:
			sprite.play(_animation_set.inspection_animation if _conversation_focus else IDLE_ANIMATION)
		VisualState.WALK:
			sprite.animation = WALK_ANIMATION
			sprite.stop()
			_apply_walk_phase()
		VisualState.AIRBORNE:
			sprite.animation = JUMP_ANIMATION
			sprite.stop()
			sprite.frame = 0
		VisualState.CLIMB:
			sprite.animation = CLIMB_ANIMATION
			sprite.stop()
			_apply_climb_phase()

func _apply_walk_phase() -> void:
	_apply_distance_phase(
		WALK_ANIMATION,
		_walk_distance,
		_animation_set.walk_stride_pixels,
	)

func _apply_jump_range(start: int, end: int, progress: float) -> void:
	var count := maxi(1, end - start)
	var index := mini(int(clampf(progress, 0.0, 1.0) * count), count - 1)
	sprite.set_frame_and_progress(start + index, 0.0)

func _apply_landing_phase() -> void:
	_apply_jump_range(_animation_set.landing_frame,
		sprite.sprite_frames.get_frame_count(JUMP_ANIMATION),
		1.0 - _landing_remaining / _animation_set.landing_duration)

func _apply_climb_phase() -> void:
	var contacts: PackedFloat32Array = _animation_set.climb_top_hand_heights
	if _ascending and not contacts.is_empty():
		# Hands leave the overhead cycle before passing the ladder top. Pick the
		# next lower support pose before a hand would pass the real ledge.
		var source_distance: float = _climb_top_distance / _animation_set.visual_scale.y
		if source_distance <= _animation_set.climb_top_start_height:
			var supported := contacts.size() - 1
			for index in range(contacts.size()):
				if contacts[index] <= source_distance:
					supported = index
					break
			sprite.animation = CLIMB_TOP_ANIMATION
			sprite.set_frame_and_progress(supported, 0.0)
			return
	var finish_height: float = _animation_set.climb_finish_height
	if finish_height > 0.0 and _climb_top_distance < finish_height:
		# Spatial progress works in both directions and freezes when input stops.
		# Never advance physics, stretch the body, or cross-fade two silhouettes.
		sprite.animation = CLIMB_FINISH_ANIMATION
		var count := sprite.sprite_frames.get_frame_count(CLIMB_FINISH_ANIMATION)
		var progress := clampf(1.0 - _climb_top_distance / finish_height, 0.0, 1.0)
		sprite.set_frame_and_progress(mini(int(progress * count), count - 1), 0.0)
		return
	sprite.animation = CLIMB_ANIMATION
	_apply_distance_phase(
		CLIMB_ANIMATION,
		_climb_distance,
		_animation_set.climb_stride_pixels,
	)

func _on_animation_finished() -> void:
	if _standing_up and sprite.animation == CLIMB_STAND_ANIMATION:
		_standing_up = false
		_apply_state()
		_sync_equipment()

func _apply_distance_phase(animation: StringName, distance: float, stride: float) -> void:
	assert(stride > 0.0, "Animation stride must be positive")
	var frame_count := sprite.sprite_frames.get_frame_count(animation)
	if frame_count <= 0:
		return
	var phase: float = distance / stride
	var frame_position: float = phase * float(frame_count)
	var frame_index := mini(floori(frame_position), frame_count - 1)
	sprite.set_frame_and_progress(frame_index, frame_position - float(frame_index))
