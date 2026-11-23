class_name WorkshopTraversalMap
extends Node2D

@onready var upper_surface: WalkSurface2D = %UpperSurface
@onready var middle_surface: WalkSurface2D = %MiddleSurface
@onready var lower_surface: WalkSurface2D = %LowerSurface
@onready var partner_spawn: Marker2D = %PartnerSpawn
@onready var walk_surfaces: Array[WalkSurface2D] = [upper_surface, middle_surface, lower_surface]
@onready var ladders: Array[LadderRoute2D] = [%UpperLadder, %LowerLadder]
@onready var blockers: Array[VisibleBlocker2D] = [
	%UpperLeftBlocker,
	%UpperRightBlocker,
	%LowerLeftBlocker,
	%LowerRightBlocker,
]
@onready var recovery: OutOfBoundsRecovery = %OutOfBoundsRecovery

func set_debug_visible(visible: bool) -> void:
	for surface: WalkSurface2D in walk_surfaces:
		surface.debug_visible = visible
	for ladder: LadderRoute2D in ladders:
		ladder.debug_visible = visible
	for blocker: VisibleBlocker2D in blockers:
		blocker.debug_visible = visible
