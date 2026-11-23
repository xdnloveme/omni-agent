extends SceneTree

func _initialize() -> void:
	_run.call_deferred()

func _run() -> void:
	var spot := WorkshopRestSpot.new()
	spot.interaction_id = &"bed"
	spot.source_size = Vector2(260, 185)
	var contact := Marker2D.new()
	contact.name = "Contact"
	contact.position = Vector2(50, 100)
	spot.add_child(contact)
	spot.standing_contact_path = NodePath("Contact")
	root.add_child(spot)
	await process_frame
	var male: CharacterRestAppearance = load("res://resources/characters/coding-rest-bed.tres")
	var other := CharacterRestAppearance.new()
	other.texture = male.texture
	other.occupied_outline = PackedVector2Array([Vector2(100, 20), Vector2(220, 20), Vector2(180, 90)])
	other.snore_origin = Vector2(170, 75)
	var position_before := spot.standing_contact()
	var original_outline := male.occupied_outline.duplicate()
	for appearance in [male, other, male]:
		spot.configure(appearance)
		assert(spot.has_rest_art())
		spot.set_resting(true)
		assert(spot.is_resting())
		var surface: Polygon2D = spot.get_child(1)
		assert(surface.visible and surface.texture == appearance.texture)
		assert(surface.polygon == appearance.occupied_outline)
		for i in surface.polygon.size():
			assert(surface.uv[i].is_equal_approx(surface.polygon[i] * surface.texture.get_size() / spot.source_size))
		assert(spot.standing_contact() == position_before)
		spot.set_resting(false)
		assert(not surface.visible)
	spot.configure(null)
	assert(not spot.has_rest_art())
	assert((spot.get_child(1) as Polygon2D).polygon.is_empty())
	assert(male.occupied_outline == original_outline)
	print(JSON.stringify({"type": "rest_appearance_harness", "passed": true, "switches": 4}))
	quit(0)
