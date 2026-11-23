extends SceneTree

# Exercise the real animator through top contact, stand-up and interruption.
# A character without back equipment must not fabricate attachment tracks.
const BASELINE = preload("res://resources/characters/coding-animation-set.tres")
const ANIMATOR = preload("res://src/world/partner_animator.gd")

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	for equipped in [true, false]:
		var holder := Node2D.new()
		var visual := AnimatedSprite2D.new()
		visual.name = "Visual"
		holder.add_child(visual)
		var animator := ANIMATOR.new()
		animator.sprite_path = NodePath("../Visual")
		holder.add_child(animator)
		root.add_child(holder)
		await process_frame
		var config: Resource = BASELINE.duplicate()
		if not equipped:
			config.back_equipment = null
			config.climb_top_equipment_poses = PackedVector3Array()
			config.climb_stand_equipment_poses = PackedVector3Array()
		animator.configure(config, -560.0)
		for index in range(config.climb_top_hand_heights.size()):
			var remaining: float = config.climb_top_hand_heights[index] * config.visual_scale.y
			animator.present_motion(3, Vector2(0, -145), Vector2(0, -1), 1, false, 0, remaining)
			assert(visual.animation == &"climb_top" and visual.frame == index)
			assert(visual.scale == config.visual_scale)
			assert(holder.position == Vector2.ZERO)
		animator.present_motion(0, Vector2.ZERO, Vector2.ZERO, 1, true, 0, 0)
		assert(visual.animation == &"climb_top_stand")
		animator.present_motion(1, Vector2(165, 0), Vector2(2, 0), 1, true, 0, INF)
		assert(visual.animation == &"walk", "Walking must interrupt top stand-up")
		var equipment: Sprite2D = visual.get_child(0)
		assert(equipment.visible == equipped)
		holder.queue_free()
		await process_frame
	assert(BASELINE.back_equipment != null and not BASELINE.climb_top_equipment_poses.is_empty())
	print(JSON.stringify({"type": "unequipped_ladder_harness", "passed": true, "cases": 2}))
	quit(0)
