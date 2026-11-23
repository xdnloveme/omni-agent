class_name WorkshopWorld
extends Node2D

signal interaction_requested(interaction_id: StringName)
signal partner_inspection_requested()
signal work_inspection_requested()

@onready var _actor: PartnerActor = %PartnerActor
@onready var _traversal_map: WorkshopTraversalMap = %TraversalMap
@onready var _interaction_points: Array[Node] = [
	%BedInteraction,
	%UpperBedInteraction,
	%SofaInteraction,
	%WorkbenchInteraction,
	%DoorInteraction,
]
@onready var _camera_rig: WorkshopCameraRig = %WorkshopCameraRig
@onready var _cloud_layer: CanvasItem = %CloudLayer
@onready var _visual: CanvasItem = $Visual
@onready var _workbench: WorkshopWorkstation = %Workbench
@onready var _rest_spots: Array[WorkshopRestSpot] = [%Bed, %UpperBed, %Sofa]

var _active := false
var _input_enabled := false
var _debug_visible := false
var _available_interactions: Array[Node] = []
var _visual_base_modulate := Color.WHITE
var _traversal_base_modulate := Color.WHITE

func _ready() -> void:
	_visual_base_modulate = _visual.modulate
	_traversal_base_modulate = _traversal_map.modulate
	_camera_rig.focus_blend_changed.connect(_on_focus_blend_changed)
	for ladder: Node in _traversal_map.ladders:
		ladder.body_availability_changed.connect(_on_ladder_availability_changed)
	_traversal_map.recovery.recovery_requested.connect(_on_recovery_requested)
	for point: Node in _interaction_points:
		point.availability_changed.connect(_on_interaction_availability_changed)
		point.interaction_requested.connect(func(id: StringName) -> void: interaction_requested.emit(id))
	_actor.inspection_requested.connect(func() -> void: partner_inspection_requested.emit())
	_camera_rig.set_target(_actor)
	_actor.activity_changed.connect(_sync_activity_composition)
	_workbench.inspect_requested.connect(func() -> void:
		%WorkbenchInteraction.dismiss_hint()
		work_inspection_requested.emit())
	set_process_unhandled_input(false)

func _unhandled_input(event: InputEvent) -> void:
	if not _active:
		return
	if (
		OS.is_debug_build()
		and event is InputEventKey
		and event.pressed
		and not event.echo
		and event.keycode == KEY_F8
	):
		_set_debug_visible(not _debug_visible)
		get_viewport().set_input_as_handled()
		return
	if not _input_enabled:
		return
	var interaction: Node = _current_interaction()
	if event.is_action_pressed("interact") and interaction != null:
		interaction.request_interaction()
		get_viewport().set_input_as_handled()

func enter_workspace(presentation: CharacterPresentation) -> void:
	var was_active := _active
	_active = true
	visible = true
	_actor.set_presentation(presentation)
	for spot in _rest_spots:
		spot.configure(presentation.rest_appearances.get(spot.interaction_id))
	if not was_active:
		for point in _interaction_points:
			point.reset_hint()
		_actor.reset_to_spawn(_traversal_map.partner_spawn.global_position)
		_camera_rig.snap_to_target()
	_camera_rig.set_tracking_enabled(true)
	_cloud_layer.visible = true
	set_process_unhandled_input(true)

func leave_workspace() -> void:
	_active = false
	_set_debug_visible(false)
	_actor.set_conversation_focus(false)
	_actor.leave_workspace()
	_workbench.set_status(&"idle")
	_camera_rig.set_tracking_enabled(false)
	_cloud_layer.visible = false
	set_input_enabled(false)
	set_process_unhandled_input(false)
	_sync_interaction_points()
	visible = false

func set_input_enabled(enabled: bool) -> void:
	_input_enabled = enabled and _active
	_actor.set_input_enabled(_input_enabled)
	_workbench.set_interaction_enabled(_input_enabled)
	_sync_interaction_points()

func set_conversation_focus(active: bool, panel_rect: Rect2, expanded: bool) -> void:
	_camera_rig.set_conversation_focus(active and _active, panel_rect, expanded)
	_actor.set_conversation_focus(active and _active)

func begin_workbench_interaction() -> bool:
	%WorkbenchInteraction.dismiss_hint()
	return _active and _actor.begin_work(_workbench)

func end_workbench_interaction() -> void:
	_actor.end_work()

func set_work_status(status: StringName) -> void:
	_actor.set_work_running(status == &"running")
	_workbench.set_status(status)

func acknowledge_work_result() -> void:
	_workbench.acknowledge_result()

func toggle_rest_interaction(interaction_id: StringName) -> bool:
	if not _active: return false
	for spot in _rest_spots:
		if spot.interaction_id != interaction_id: continue
		if _actor.rest_spot() == spot:
			_actor.end_rest()
			return true
		return _actor.begin_rest(spot)
	return false

func end_rest() -> void:
	_actor.end_rest()

func _sync_activity_composition() -> void:
	var station := _actor.work_station()
	var occupied := _actor.rest_spot()
	for spot in _rest_spots:
		spot.set_resting(spot == occupied)
		for point in _interaction_points:
			if point.interaction_id == spot.interaction_id:
				point.set_prompt_text(spot.resting_prompt if spot == occupied else spot.idle_prompt)
	_camera_rig.set_activity_bounds(occupied.global_focus_bounds() if occupied != null else (station.global_focus_bounds() if station != null else Rect2()), occupied != null)

func _on_focus_blend_changed(blend: float) -> void:
	var brightness := lerpf(1.0, 0.80, blend)
	var tone := Color(brightness, brightness, brightness, 1.0)
	# The actor is a sibling, so its original colors and all foreground ordering
	# remain intact. The camera owns the sole transition clock for this emphasis.
	_visual.modulate = _visual_base_modulate * tone
	_traversal_map.modulate = _traversal_base_modulate * tone

func is_active() -> bool:
	return _active

func current_interaction_id() -> StringName:
	var interaction: Node = _current_interaction()
	return interaction.interaction_id if interaction != null else &""

func _on_ladder_availability_changed(
	body: Node2D,
	ladder: Node,
	available: bool,
) -> void:
	if body is PartnerActor:
		body.set_ladder_candidate(ladder, available)

func _on_interaction_availability_changed(
	point: Node,
	available: bool,
) -> void:
	if available:
		if not _available_interactions.has(point):
			_available_interactions.append(point)
	else:
		_available_interactions.erase(point)
	_sync_interaction_points()

func _current_interaction() -> Node:
	if not _input_enabled:
		return null
	var selected: Node
	var selected_distance := INF
	for point: Node in _available_interactions:
		if not is_instance_valid(point):
			continue
		var distance: float = point.distance_squared_to(_actor)
		if distance < selected_distance:
			selected = point
			selected_distance = distance
	return selected

func _sync_interaction_points() -> void:
	var selected: Node = _current_interaction()
	for point: Node in _interaction_points:
		point.set_interaction_enabled(point == selected)

func _on_recovery_requested(actor: PartnerActor) -> void:
	if actor != _actor or not _active:
		return
	_actor.reset_to_spawn(_traversal_map.partner_spawn.global_position)
	_camera_rig.snap_to_target()
	if OS.is_debug_build():
		push_warning("PartnerActor left the Workshop traversal bounds and was recovered")

func _set_debug_visible(visible: bool) -> void:
	_debug_visible = visible
	_traversal_map.set_debug_visible(visible)
	_actor.set_debug_visible(visible)
	_camera_rig.set_debug_visible(visible)
