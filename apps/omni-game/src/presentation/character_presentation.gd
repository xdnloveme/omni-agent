class_name CharacterPresentation
extends Resource

@export var agent_id := ""
@export var display_name := ""
@export var role_title := "伙伴"
@export_multiline var selection_description := ""
# Logical source-frame height in the selection screen; independent of world scale.
@export_range(160.0, 400.0, 0.01) var selection_frame_height := 280.0
@export var portrait: Texture2D
@export var animation_set: Resource
# Avatar movement data; PartnerActor alone applies it to physical motion.
@export var locomotion_config: PartnerLocomotionConfig = preload("res://resources/movement/partner-locomotion-config.tres")
@export var rest_appearances: Dictionary[StringName, CharacterRestAppearance] = {}
@export var accent_color := Color("#a86f3e")
