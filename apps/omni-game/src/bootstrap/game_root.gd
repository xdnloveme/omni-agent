class_name GameRoot
extends Node

@onready var _client: AgentHostClient = $AgentHostClient
@onready var _controller: CharacterWorkspaceController = $CharacterWorkspaceController
@onready var _connection_status: Label = %ConnectionStatus
@onready var _character_panel: CharacterSelectionPanel = %CharacterSelectionPanel
@onready var _task_panel: TaskPanel = %TaskPanel

func _ready() -> void:
	_controller.configure(_client)
	_wire_ui()
	var config_result := HostConnectionConfig.consume_environment()
	if not config_result["ok"]:
		_show_fatal(config_result["error"]["message"])
		return
	var config: HostConnectionConfig = config_result["value"]
	_client.connect_to_host(config.url, config.token)
	config.clear_token()

func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST and is_instance_valid(_client):
		_client.shutdown()
		get_tree().quit()

func _wire_ui() -> void:
	_client.connection_state_changed.connect(_on_connection_state_changed)
	_controller.agents_changed.connect(_character_panel.render_agents)
	_controller.workspace_changed.connect(_on_workspace_changed)
	_controller.workspace_closed.connect(_on_workspace_closed)
	_controller.transcript_changed.connect(_task_panel.set_transcript)
	_controller.run_state_changed.connect(_task_panel.set_running)
	_controller.busy_changed.connect(_on_busy_changed)
	_controller.error_changed.connect(_on_error_changed)
	_character_panel.agent_selected.connect(_controller.select_agent)
	_task_panel.back_requested.connect(_controller.back_to_characters)
	_task_panel.new_session_requested.connect(_controller.create_new_session)
	_task_panel.run_requested.connect(_controller.submit_task)
	_task_panel.cancel_requested.connect(_controller.cancel_active_run)

func _on_connection_state_changed(state: int) -> void:
	match state:
		AgentHostClient.ConnectionState.CONNECTING:
			_connection_status.text = "正在连接 Agent Host……"
		AgentHostClient.ConnectionState.AUTHENTICATING:
			_connection_status.text = "正在认证本地连接……"
		AgentHostClient.ConnectionState.READY:
			_connection_status.text = "本地 Agent Host 已连接"
		AgentHostClient.ConnectionState.FAILED:
			_connection_status.text = "Agent Host 连接失败"
		AgentHostClient.ConnectionState.CLOSED:
			_connection_status.text = "Agent Host 已关闭"

func _on_workspace_changed(agent: Dictionary, session: Dictionary) -> void:
	_character_panel.visible = false
	_task_panel.visible = true
	_task_panel.show_workspace(agent, session)

func _on_workspace_closed() -> void:
	_task_panel.visible = false
	_character_panel.visible = true

func _on_busy_changed(busy: bool) -> void:
	_character_panel.set_busy(busy)
	_task_panel.set_busy(busy)

func _on_error_changed(message: String) -> void:
	_character_panel.show_error(message)
	_task_panel.show_error(message)

func _show_fatal(message: String) -> void:
	_connection_status.text = message
	_character_panel.show_error(message)
