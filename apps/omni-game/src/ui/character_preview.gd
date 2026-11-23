class_name CharacterPreview
extends Control

@onready var sprite: AnimatedSprite2D = $Sprite
@onready var _alcove: TextureRect = $Alcove

# The reference places the character's feet at 82% of the visible stage.
# The empty alcove artwork places its plinth at 76%; overscan the artwork
# vertically so both authored contact points coincide without moving the character
# independently of its supporting surface.
const STAGE_FOOT_RATIO := 0.82
const ALCOVE_FOOT_RATIO := 0.76

var _animation_set: CharacterAnimationSet

func _ready() -> void:
	resized.connect(_layout_sprite)
	visibility_changed.connect(_update_playback)

func configure(animation_set: CharacterAnimationSet) -> void:
	assert(animation_set != null and animation_set.frames != null)
	assert(animation_set.frames.has_animation(animation_set.inspection_animation))
	_animation_set = animation_set
	sprite.sprite_frames = animation_set.frames
	sprite.centered = false
	sprite.offset = -animation_set.foot_anchor
	sprite.animation = animation_set.inspection_animation
	sprite.set_frame_and_progress(0, 0.0)
	_layout_sprite()
	_update_playback()

func _layout_sprite() -> void:
	if _animation_set == null:
		return
	# One uniform scale preserves the original head/body proportions. The authored
	# foot anchor stays on the display plinth throughout the idle cycle.
	var canvas := Vector2(_animation_set.source_size)
	var factor := minf(size.x * 0.94 / canvas.x, size.y * 0.85 / canvas.y)
	sprite.scale = Vector2.ONE * factor
	sprite.position = Vector2(size.x * 0.5, size.y * STAGE_FOOT_RATIO)
	_alcove.size = Vector2(size.x, size.y * STAGE_FOOT_RATIO / ALCOVE_FOOT_RATIO)

func _update_playback() -> void:
	if _animation_set == null:
		return
	if is_visible_in_tree():
		sprite.play()
	else:
		sprite.pause()
