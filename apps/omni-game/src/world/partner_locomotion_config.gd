class_name PartnerLocomotionConfig
extends Resource

@export var walk_speed := 165.0
@export var work_approach_speed := 160.0
@export var ground_acceleration := 720.0
@export var ground_deceleration := 900.0
@export var turn_deceleration := 1100.0
@export var gravity := 1800.0
@export var maximum_fall_speed := 720.0
@export var jump_speed := -560.0
# Grounded anticipation only; coyote and ladder jumps remain immediate.
@export_range(0.0, 0.15, 0.01) var jump_preparation_duration := 0.0
@export var ladder_jump_horizontal_speed := 180.0
@export var coyote_time := 0.1
@export var jump_buffer_time := 0.12
@export var jump_cut_multiplier := 0.45
@export var climb_speed := 145.0
@export var traversal_epsilon := 2.0
@export var floor_snap_distance := 8.0
@export var facing_deadzone := 12.0
