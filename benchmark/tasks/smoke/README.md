# Integration fixture

This directory uses Harbor's native task format. The local HTTP model fixture emits a fixed sequence of file_read, file_write and bash calls through the production Provider, Agent loop and ToolCallCoordinator. The verifier checks file effects, cwd and the original task Node 20.20.2. No external model is called; reward is integration evidence, not Agent capability.

The image healthcheck starts the local fixture server before Agent installation. The API credential is the public dummy value `fixture`. Never use a real API key for this task.
