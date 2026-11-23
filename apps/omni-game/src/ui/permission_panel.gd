class_name PermissionPanel
extends PanelContainer

signal decision_selected(permission_id: String, decision: String)

var _requests: Array[Dictionary] = []
var _decision_pending := false

func present(permission: Dictionary) -> void:
	_requests.append(permission.duplicate(true))
	if _requests.size() == 1:
		_show_current_request()

func has_pending_requests() -> bool:
	return not _requests.is_empty()

func reject_decision(permission_id: String, failure: Dictionary) -> void:
	# A settled request may already have left the queue before its reply arrives.
	if _requests.is_empty() or _requests[0]["permissionId"] != permission_id:
		return
	_show_current_request()
	%PermissionResources.text += "\n\n" + str(failure["message"])

func resolve_request(permission_id: String) -> void:
	for index in range(_requests.size()):
		if _requests[index]["permissionId"] != permission_id:
			continue
		_requests.remove_at(index)
		if index == 0:
			if _requests.is_empty(): clear()
			else: _show_current_request()
		return

func _show_current_request() -> void:
	_decision_pending = false
	$Content/Actions/Approve.disabled = false
	$Content/Actions/Deny.disabled = false
	var presentation: Dictionary = _requests[0]["presentation"]
	%PermissionResources.text = presentation.get("title", "权限请求") + "\n\n" + "\n".join(PackedStringArray(presentation.get("resources", [])))
	%PermissionResources.scroll_to_line(0)
	visible = true

func clear() -> void:
	_requests.clear()
	_decision_pending = false
	visible = false

func _on_approve_pressed() -> void:
	_submit("approve")

func _on_deny_pressed() -> void:
	_submit("deny")

func _submit(decision: String) -> void:
	if _requests.is_empty() or _decision_pending:
		return
	_decision_pending = true
	$Content/Actions/Approve.disabled = true
	$Content/Actions/Deny.disabled = true
	decision_selected.emit(_requests[0]["permissionId"], decision)
