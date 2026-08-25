class_name TaskPanel
extends PanelContainer

signal back_requested()
signal new_session_requested()
signal run_requested(text: String)
signal cancel_requested()

@onready var _agent_name: Label = %AgentName
@onready var _session_label: Label = %SessionLabel
@onready var _transcript: RichTextLabel = %Transcript
@onready var _task_input: TextEdit = %TaskInput
@onready var _run_button: Button = %RunButton
@onready var _cancel_button: Button = %CancelButton
@onready var _new_session_button: Button = %NewSessionButton
@onready var _back_button: Button = %BackButton
@onready var _status_label: Label = %StatusLabel

func _ready() -> void:
	_back_button.pressed.connect(func() -> void: back_requested.emit())
	_new_session_button.pressed.connect(func() -> void: new_session_requested.emit())
	_run_button.pressed.connect(func() -> void: run_requested.emit(_task_input.text))
	_cancel_button.pressed.connect(func() -> void: cancel_requested.emit())

func show_workspace(agent: Dictionary, session: Dictionary) -> void:
	_agent_name.text = agent.get("displayName", "伙伴")
	_session_label.text = "任务存档：%s" % session.get("sessionId", "-")
	_status_label.text = "伙伴已经准备好了。"
	_task_input.grab_focus()

func set_transcript(text: String) -> void:
	_transcript.text = text

func set_running(running: bool) -> void:
	_run_button.disabled = running
	_cancel_button.disabled = not running
	_task_input.editable = not running
	_new_session_button.disabled = running
	_back_button.disabled = running
	_status_label.text = "伙伴正在做事情……" if running else "伙伴已经准备好了。"

func set_busy(busy: bool) -> void:
	if _cancel_button.disabled:
		_run_button.disabled = busy
	_task_input.editable = not busy and _cancel_button.disabled
	_new_session_button.disabled = busy
	_back_button.disabled = busy
	if busy:
		_status_label.text = "正在切换任务存档……"

func show_error(message: String) -> void:
	_status_label.text = message
