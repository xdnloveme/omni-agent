class_name CharacterPresentationCatalog
extends Resource

@export var entries: Array[CharacterPresentation] = []
@export var fallback: CharacterPresentation

func resolve(agent_id: String) -> CharacterPresentation:
	for presentation in entries:
		if presentation != null and presentation.agent_id == agent_id:
			return presentation
	assert(fallback != null, "Character presentation fallback must be configured")
	return fallback
