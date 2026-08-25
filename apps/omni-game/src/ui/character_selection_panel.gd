class_name CharacterSelectionPanel
extends PanelContainer

signal agent_selected(agent_id: String)

@onready var _agent_list: VBoxContainer = %AgentList
@onready var _status_label: Label = %StatusLabel

func render_agents(agents: Array) -> void:
	for child: Node in _agent_list.get_children():
		child.queue_free()
	for agent: Variant in agents:
		if typeof(agent) != TYPE_DICTIONARY:
			continue
		var button := Button.new()
		button.custom_minimum_size = Vector2(0, 92)
		button.text = "%s\n%s" % [agent["displayName"], agent["description"]]
		button.alignment = HORIZONTAL_ALIGNMENT_LEFT
		button.pressed.connect(func() -> void: agent_selected.emit(agent["id"]))
		_agent_list.add_child(button)
	_status_label.text = "选择一位伙伴进入工作间。"

func set_busy(busy: bool) -> void:
	for child: Node in _agent_list.get_children():
		if child is Button:
			child.disabled = busy
	_status_label.text = "正在准备伙伴……" if busy else "选择一位伙伴进入工作间。"

func show_error(message: String) -> void:
	_status_label.text = message
