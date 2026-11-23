class_name CharacterAnimationSet
extends Resource

@export var frames: SpriteFrames
@export var work_frames: SpriteFrames
@export var back_equipment: Texture2D
@export var back_equipment_anchor := Vector2(256, 325)
@export var back_equipment_mount := Vector2(220, 351)
@export var climb_equipment_mount := Vector2(252, 347)
@export var back_equipment_scale := 0.78
@export var back_equipment_angle := -25.0
@export var climb_equipment_angle := -28.0
@export var inspection_animation: StringName = &"idle"
@export var source_size := Vector2i(512, 512)
@export var foot_anchor := Vector2(256.0, 464.0)
@export var visual_scale := Vector2(0.28, 0.28)
@export_range(32.0, 320.0, 1.0) var walk_stride_pixels := 136.0
@export_range(16.0, 192.0, 1.0) var climb_stride_pixels := 48.0
# Optional non-looping top-contact poses. This is a visual interval only;
# the actor still travels continuously to the route's physical endpoint.
@export_range(0.0, 180.0, 1.0) var climb_finish_height := 0.0
# Ascending only: authored palm heights above the common foot anchor, in source
# pixels, descending in the same order as climb_top frames. No physical offsets.
@export var climb_top_hand_heights := PackedFloat32Array()
# Raised-hand reach of the normal climb pose, in source pixels.
@export var climb_top_start_height := 0.0
# Optional authored cycle pose immediately before the top-contact sequence.
# Anchors phase once on ladder entry; displacement still owns cadence/reversal.
@export var climb_top_entry_frame := -1
# Back attachment x/y and angle (degrees) in each authored source-space pose.
@export var climb_top_equipment_poses := PackedVector3Array()
@export var climb_stand_equipment_poses := PackedVector3Array()
# Jump art with moving shoulders may author a complete equipment track, including
# touchdown. An empty track intentionally uses the character's fixed back mount.
@export var jump_equipment_poses := PackedVector3Array()
# Start indices of rising, apex, falling ranges. Landing starts at landing_frame;
# each range ends before the next start (equal starts share one pose). Frames
# before rising are grounded anticipation. Landing ends at the animation end.
# Single-pose and four-pose art use exactly the same range sampler.
@export var airborne_phase_frames := Vector3i.ZERO
@export_range(1.0, 200.0, 1.0) var apex_vertical_speed := 70.0
@export var landing_frame := 0
@export_range(0.0, 0.3, 0.01) var landing_duration := 0.0
@export var foot_contact_region := Rect2(160.0, 432.0, 192.0, 32.0)
