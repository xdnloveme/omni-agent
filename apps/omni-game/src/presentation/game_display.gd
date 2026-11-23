class_name GameDisplay
extends Node

signal fullscreen_changed(fullscreen: bool)

var _windowed_rect := Rect2i()
var _restore_mode := Window.MODE_WINDOWED

func _ready() -> void:
	get_window().size_changed.connect(_sync_mode)

func _input(event: InputEvent) -> void:
	# This display shortcut also works while a TextEdit or modal owns focus.
	if event.is_action_pressed("toggle_fullscreen") and not event.is_echo():
		toggle_fullscreen()
		get_viewport().set_input_as_handled()

func is_fullscreen() -> bool:
	return get_window().mode in [Window.MODE_FULLSCREEN, Window.MODE_EXCLUSIVE_FULLSCREEN]

func toggle_fullscreen() -> void:
	var window := get_window()
	if is_fullscreen():
		window.mode = _restore_mode
		if _restore_mode == Window.MODE_WINDOWED and _windowed_rect.has_area():
			window.size = _windowed_rect.size
			window.position = _windowed_rect.position
	else:
		_restore_mode = Window.MODE_MAXIMIZED if window.mode == Window.MODE_MAXIMIZED else Window.MODE_WINDOWED
		_windowed_rect = Rect2i(window.position, window.size)
		window.mode = Window.MODE_FULLSCREEN
	_sync_mode()

func _sync_mode() -> void:
	fullscreen_changed.emit(is_fullscreen())
