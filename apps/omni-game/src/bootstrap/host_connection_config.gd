class_name HostConnectionConfig
extends RefCounted

const URL_ENV := "OMNI_AGENT_HOST_URL"
const TOKEN_ENV := "OMNI_AGENT_HOST_TOKEN"

var url: String
var token: String

func _init(connection_url: String, connection_token: String) -> void:
	url = connection_url
	token = connection_token

static func consume_environment() -> Dictionary:
	var connection_url := OS.get_environment(URL_ENV) if OS.has_environment(URL_ENV) else ""
	var connection_token := OS.get_environment(TOKEN_ENV) if OS.has_environment(TOKEN_ENV) else ""
	OS.unset_environment(URL_ENV)
	OS.unset_environment(TOKEN_ENV)

	if not _valid_loopback_url(connection_url):
		return _failure("invalid_host_url", "Agent Host 地址无效，请通过 pnpm game 启动。")
	if not _valid_token(connection_token):
		return _failure("invalid_host_token", "Agent Host 凭证无效，请重新启动游戏。")
	return {"ok": true, "value": HostConnectionConfig.new(connection_url, connection_token)}

func clear_token() -> void:
	token = ""

static func _valid_loopback_url(value: String) -> bool:
	var expression := RegEx.new()
	if expression.compile("^ws://127\\.0\\.0\\.1:([0-9]{1,5})/$") != OK:
		return false
	var matched := expression.search(value)
	if matched == null:
		return false
	var port := matched.get_string(1).to_int()
	return port >= 1 and port <= 65535

static func _valid_token(value: String) -> bool:
	var expression := RegEx.new()
	if expression.compile("^[A-Za-z0-9_-]{43}$") != OK:
		return false
	return expression.search(value) != null

static func _failure(code: String, message: String) -> Dictionary:
	return {"ok": false, "error": {"code": code, "message": message, "retryable": false}}
