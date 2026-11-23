class_name CharacterRestAppearance
extends Resource
## Character-specific artwork in the rest spot's furniture-local coordinates.
## Furniture geometry, standing contacts and interaction behavior stay in world.
@export var texture: Texture2D
@export var occupied_outline: PackedVector2Array
@export var snore_origin := Vector2.ZERO
