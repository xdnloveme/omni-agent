class_name PermissionPanel
extends PanelContainer

signal decision_selected(permission_id: String, decision: String)

var _permission_id := ""

func present(permission: Dictionary) -> void:
	_permission_id = permission.get("permissionId", "")
	var presentation: Dictionary = permission.get("presentation", {})
	%PermissionResources.text = presentation.get("title", "权限请求") + "\n\n" + "\n".join(PackedStringArray(presentation.get("resources", [])))
	%PermissionResources.scroll_to_line(0)
	visible = true

func clear() -> void:
	_permission_id = ""
	visible = false

func _on_approve_pressed() -> void:
	_submit("approve")

func _on_deny_pressed() -> void:
	_submit("deny")

func _submit(decision: String) -> void:
	if _permission_id.is_empty():
		return
	var current := _permission_id
	_permission_id = ""
	decision_selected.emit(current, decision)
