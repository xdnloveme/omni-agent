# Native isolation fixture

Run with Harbor's Oracle agent. This tests native separate verification, declared artifact transfer, absence of an undeclared private marker, and a verifier with only loopback networking. It does not invoke Omni or a model and does not establish model-host allowlist safety.

From the repository root:

```bash
PYTHONPATH="$PWD" uv run --project benchmark harbor run -p benchmark/tasks/isolation-probe -a oracle
```

Expected: reward 1 and verifier_environment_mode separate. A failed assertion is a fixture failure, not a SWE score.
