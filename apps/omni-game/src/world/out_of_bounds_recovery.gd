class_name OutOfBoundsRecovery
extends Area2D

signal recovery_requested(actor: PartnerActor)

func _ready() -> void:
	body_entered.connect(_on_body_entered)

func _on_body_entered(body: Node2D) -> void:
	if body is PartnerActor:
		recovery_requested.emit(body)
