# Decisions

- Keep the v1 endpoint until subscriptions move over.
- Verify signatures with the v2 secret only.
- Replay failed events with `scripts/replay_webhooks.py`, never by hand.
