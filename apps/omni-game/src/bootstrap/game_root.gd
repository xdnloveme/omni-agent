class_name GameRoot
extends Node

enum OverlayState { NONE, MENU, TASK, CHARACTER_INFO, PERMISSION }

@export var character_presentations: CharacterPresentationCatalog

@onready var _client: AgentHostClient = $AgentHostClient
@onready var _controller: CharacterWorkspaceController = $CharacterWorkspaceController
@onready var _connection_status: Label = %ConnectionStatus
@onready var _connection_badge: Control = %ConnectionBadge
@onready var _selection_layer: Control = %SelectionLayer
@onready var _character_panel: CharacterSelectionPanel = %CharacterSelectionPanel
@onready var _world: WorkshopWorld = %WorkshopWorld
@onready var _partner_hud: Control = %PartnerHud
@onready var _partner_button: TextureButton = %PartnerButton
@onready var _partner_name: Label = %PartnerName
@onready var _partner_role: Label = %PartnerRole
@onready var _context_message: Label = %ContextMessage
@onready var _context_message_timer: Timer = %ContextMessageTimer
@onready var _task_overlay: Control = %TaskOverlay
@onready var _task_panel: TaskPanel = %TaskPanel
@onready var _menu: WorkshopMenu = %WorkshopMenu
@onready var _character_info: CharacterInfoPanel = %CharacterInfoPanel
@onready var _display: GameDisplay = $GameDisplay
@onready var _permission_overlay: Control = %PermissionOverlay
@onready var _permission_panel: PermissionPanel = %PermissionPanel

var _overlay_state := OverlayState.NONE
var _overlay_before_permission := OverlayState.NONE
var _busy := false
var _running := false
var _cancel_pending := false

func _ready() -> void:
	assert(character_presentations != null, "Character presentation catalog is required")
	_character_panel.configure(character_presentations)
	_controller.configure(_client)
	_wire_ui()
	_world.leave_workspace()
	_menu.set_active(false)
	_partner_hud.visible = false
	_task_overlay.visible = false
	_character_info.close_panel()
	_sync_conversation_hud()
	var config_result := HostConnectionConfig.consume_environment()
	if not config_result["ok"]:
		_show_fatal(config_result["error"]["message"])
		return
	var config: HostConnectionConfig = config_result["value"]
	_client.connect_to_host(config.url, config.token)
	config.clear_token()

func _unhandled_input(event: InputEvent) -> void:
	if event.is_action_pressed("inspect_character"):
		if _overlay_state == OverlayState.CHARACTER_INFO and not _busy:
			_set_overlay(OverlayState.NONE)
			get_viewport().set_input_as_handled()
		elif _overlay_state == OverlayState.NONE and _can_open_character_info():
			_open_character_info()
			get_viewport().set_input_as_handled()
		return
	if not event.is_action_pressed("ui_cancel"):
		return
	match _overlay_state:
		OverlayState.TASK:
			_close_task_overlay()
			get_viewport().set_input_as_handled()
		OverlayState.MENU, OverlayState.CHARACTER_INFO:
			if not _busy:
				_set_overlay(OverlayState.NONE)
				get_viewport().set_input_as_handled()
		OverlayState.NONE:
			_open_menu_overlay()
			get_viewport().set_input_as_handled()

func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST and is_instance_valid(_client):
		_request_quit()

func _wire_ui() -> void:
	_client.connection_state_changed.connect(_on_connection_state_changed)
	_client.permission_requested.connect(_on_permission_requested)
	_client.permission_resolved.connect(_on_permission_resolved)
	_client.permission_decision_failed.connect(_permission_panel.reject_decision)
	_permission_panel.decision_selected.connect(_client.resolve_permission)
	_controller.agents_changed.connect(_character_panel.render_agents)
	_controller.workspace_changed.connect(_on_workspace_changed)
	_controller.workspace_closed.connect(_on_workspace_closed)
	_controller.messages_changed.connect(_on_messages_changed)
	_controller.submission_accepted.connect(_task_panel.mark_submitted)
	_controller.run_state_changed.connect(_on_run_state_changed)
	_controller.cancel_state_changed.connect(_on_cancel_state_changed)
	_controller.busy_changed.connect(_on_busy_changed)
	_controller.error_changed.connect(_on_error_changed)
	_character_panel.agent_selected.connect(_controller.select_agent)
	_partner_button.pressed.connect(_open_character_info)
	_world.partner_inspection_requested.connect(_open_character_info)
	_world.work_inspection_requested.connect(func() -> void: _open_task_overlay(false))
	_world.interaction_requested.connect(_on_world_interaction_requested)
	_context_message_timer.timeout.connect(func() -> void: _context_message.visible = false)
	_task_panel.close_requested.connect(_close_task_overlay)
	_task_panel.new_session_requested.connect(_controller.create_new_session)
	_task_panel.run_requested.connect(_controller.submit_task)
	_task_panel.cancel_requested.connect(_controller.cancel_active_run)
	_task_panel.presentation_layout_changed.connect(_on_conversation_layout_changed)
	_menu.open_requested.connect(_open_menu_overlay)
	_menu.close_requested.connect(func() -> void: _set_overlay(OverlayState.NONE))
	_menu.character_info_requested.connect(_open_character_info_from_menu)
	_menu.return_to_characters_requested.connect(_controller.back_to_characters)
	_menu.quit_requested.connect(_request_quit)
	_menu.fullscreen_requested.connect(_display.toggle_fullscreen)
	_display.fullscreen_changed.connect(_menu.set_fullscreen)
	_menu.set_fullscreen(_display.is_fullscreen())
	_character_info.close_requested.connect(func() -> void: _set_overlay(OverlayState.NONE))

func _on_permission_requested(permission: Dictionary) -> void:
	if _overlay_state != OverlayState.PERMISSION:
		_overlay_before_permission = _overlay_state
		_set_overlay(OverlayState.PERMISSION)
	_permission_panel.present(permission)

func _on_permission_resolved(permission: Dictionary) -> void:
	_permission_panel.resolve_request(permission["permissionId"])
	if _overlay_state == OverlayState.PERMISSION and not _permission_panel.has_pending_requests():
		var previous := _overlay_before_permission
		_overlay_before_permission = OverlayState.NONE
		_set_overlay(previous if _world.is_active() else OverlayState.NONE)

func _on_connection_state_changed(state: int) -> void:
	match state:
		AgentHostClient.ConnectionState.CONNECTING: _connection_status.text = "正在连接 Agent Host……"
		AgentHostClient.ConnectionState.AUTHENTICATING: _connection_status.text = "正在认证本地连接……"
		AgentHostClient.ConnectionState.READY:
			_connection_status.text = "A D  移动    W S  攀爬    Space  跳跃    E  互动"
		AgentHostClient.ConnectionState.FAILED: _connection_status.text = "Agent Host 连接失败"
		AgentHostClient.ConnectionState.CLOSED: _connection_status.text = "Agent Host 已关闭"
	_character_panel.set_connection(state == AgentHostClient.ConnectionState.READY, _connection_status.text)
	if state in [AgentHostClient.ConnectionState.FAILED, AgentHostClient.ConnectionState.CLOSED]:
		_permission_panel.clear()
		_overlay_before_permission = OverlayState.NONE
		if _overlay_state == OverlayState.PERMISSION:
			_set_overlay(OverlayState.NONE)
	_sync_conversation_hud()

func _on_workspace_changed(agent: Dictionary, session: Dictionary) -> void:
	var entering_world := not _world.is_active()
	var presentation := character_presentations.resolve(agent.get("id", ""))
	_selection_layer.visible = false
	_world.enter_workspace(presentation)
	_menu.set_active(true)
	_task_panel.show_workspace(agent, session, presentation)
	_update_partner_button(agent)
	if entering_world:
		_set_overlay(OverlayState.NONE)
	elif _overlay_state == OverlayState.CHARACTER_INFO:
		_refresh_character_info()
	_sync_world_input()
	_sync_conversation_presentation()

func _on_workspace_closed() -> void:
	_permission_panel.clear()
	_overlay_before_permission = OverlayState.NONE
	_set_overlay(OverlayState.NONE)
	_menu.set_active(false)
	_world.leave_workspace()
	_partner_hud.visible = false
	_context_message.visible = false
	_selection_layer.visible = true
	_sync_conversation_hud()

func _on_run_state_changed(running: bool) -> void:
	_running = running
	if not running and _overlay_state != OverlayState.TASK:
		_world.end_workbench_interaction()
	_task_panel.set_running(running)
	_sync_runtime_state()
	_sync_world_input()

func _on_messages_changed(messages: Array) -> void:
	_task_panel.set_messages(messages)
	_world.set_work_status(_controller.latest_run_status())

func _on_cancel_state_changed(pending: bool) -> void:
	_cancel_pending = pending
	_task_panel.set_cancel_pending(pending)
	_sync_runtime_state()

func _on_busy_changed(busy: bool) -> void:
	_busy = busy
	_character_panel.set_busy(busy)
	_task_panel.set_busy(busy)
	_menu.set_busy(busy)
	_sync_runtime_state()
	_sync_world_input()

func _on_error_changed(message: String) -> void:
	_character_panel.show_error(message)
	_task_panel.show_error(message)
	_menu.show_error(message)

func _on_world_interaction_requested(interaction_id: StringName) -> void:
	if _overlay_state != OverlayState.NONE or _busy:
		return
	match interaction_id:
		&"workbench":
			_open_task_overlay()
		&"bed", &"upper_bed", &"sofa":
			if _running:
				_show_context_message("任务还在进行中，结束后再休息吧。")
			elif not _world.toggle_rest_interaction(interaction_id):
				_show_context_message("请先站稳在家具旁；这位伙伴也需要对应的休息姿态。")
		&"door":
			if _running:
				_show_context_message("任务还在进行中，请先结束任务再离开工坊。")
			else:
				_controller.back_to_characters()

func _open_task_overlay(seat_at_workbench := true) -> void:
	if _busy or not _world.is_active() or _overlay_state != OverlayState.NONE:
		return
	var agent := _controller.selected_agent()
	if seat_at_workbench:
		_world.end_rest()
		_world.begin_workbench_interaction()
	var presentation := character_presentations.resolve(agent.get("id", ""))
	_task_panel.show_workspace(agent, _controller.current_session(), presentation)
	_set_overlay(OverlayState.TASK)
	_world.acknowledge_work_result()
	_task_panel.focus_input()

func _close_task_overlay() -> void:
	if _overlay_state != OverlayState.TASK:
		return
	_set_overlay(OverlayState.NONE)

func _open_menu_overlay() -> void:
	if _busy or _running or not _world.is_active() or _overlay_state != OverlayState.NONE:
		return
	_set_overlay(OverlayState.MENU)

func _open_character_info() -> void:
	if not _can_open_character_info():
		return
	_set_overlay(OverlayState.CHARACTER_INFO)

func _open_character_info_from_menu() -> void:
	if _overlay_state != OverlayState.MENU or _busy or _running:
		return
	_set_overlay(OverlayState.NONE)
	_open_character_info()

func _can_open_character_info() -> bool:
	return (
		_world.is_active()
		and _overlay_state == OverlayState.NONE
		and not _busy
		and not _running
		and not _controller.selected_agent().is_empty()
		and not _controller.current_session().is_empty()
	)

func _refresh_character_info() -> void:
	var agent := _controller.selected_agent()
	var session := _controller.current_session()
	if agent.is_empty() or session.is_empty():
		_set_overlay(OverlayState.NONE)
		return
	var presentation := character_presentations.resolve(agent.get("id", ""))
	_character_info.show_character(agent, session, presentation)
	_sync_runtime_state()

func _set_overlay(next: OverlayState) -> void:
	if _overlay_state == next:
		return
	match _overlay_state:
		OverlayState.MENU: _menu.close_menu()
		OverlayState.TASK: _task_overlay.visible = false
		OverlayState.CHARACTER_INFO: _character_info.close_panel()
		OverlayState.PERMISSION: _permission_overlay.hide()
	_overlay_state = next
	match _overlay_state:
		OverlayState.MENU: _menu.open_menu()
		OverlayState.TASK: _task_overlay.visible = true
		OverlayState.CHARACTER_INFO: _refresh_character_info()
		OverlayState.PERMISSION: _permission_overlay.show()
	_sync_world_input()
	_sync_conversation_presentation()

func _update_partner_button(agent: Dictionary) -> void:
	var presentation := character_presentations.resolve(agent.get("id", ""))
	_partner_button.texture_normal = presentation.portrait
	_partner_name.text = presentation.display_name if not presentation.display_name.is_empty() else agent.get("displayName", "伙伴")
	_partner_role.text = "%s · P 人物信息" % presentation.role_title
	_partner_hud.visible = true

func _on_conversation_layout_changed(panel_rect: Rect2, expanded: bool) -> void:
	if _overlay_state == OverlayState.TASK:
		_world.set_conversation_focus(true, panel_rect, expanded)

func _conversation_focused() -> bool:
	return _overlay_state == OverlayState.TASK or (_overlay_state == OverlayState.PERMISSION and _overlay_before_permission == OverlayState.TASK)

func _sync_conversation_presentation() -> void:
	var focused := _conversation_focused()
	if not focused and not _running:
		_world.end_workbench_interaction()
	_world.set_conversation_focus(focused, _task_panel.get_global_rect(), _task_panel.is_expanded())
	if focused:
		_context_message.hide()
		_context_message_timer.stop()
	_sync_conversation_hud()

func _sync_conversation_hud() -> void:
	var focused := _conversation_focused() or _overlay_state == OverlayState.PERMISSION
	_partner_hud.visible = _world.is_active() and not focused
	_menu.visible = _world.is_active() and not focused
	# Ordinary key hints disappear during conversation; transport problems remain visible.
	_connection_badge.visible = _world.is_active() and (not focused or _client.state() != AgentHostClient.ConnectionState.READY)

func _sync_runtime_state() -> void:
	_character_info.set_runtime_state(_busy, _running, _cancel_pending)

func _sync_world_input() -> void:
	var enabled := (
		_world.is_active()
		and _overlay_state == OverlayState.NONE
		and not _busy
	)
	_world.set_input_enabled(enabled)
	# Moving and reopening the conversation are safe while a Run is active.
	# Session-changing menus and character inspection retain their existing guards.
	_menu.set_interaction_enabled(enabled and not _running)
	_partner_button.disabled = not enabled or _running

func _show_context_message(message: String) -> void:
	_context_message.text = message
	_context_message.visible = true
	_context_message_timer.start()

func _request_quit() -> void:
	_client.shutdown()
	get_tree().quit()

func _show_fatal(message: String) -> void:
	_connection_status.text = message
	_character_panel.show_error(message)
