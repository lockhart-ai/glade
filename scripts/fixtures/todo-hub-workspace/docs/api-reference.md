# API reference

Every endpoint takes an API key in the `Authorization` header and answers in JSON.

- `GET /items/` lists items, 50 to a page.
- `GET /search?q=` searches them. It has its own rate limit: see [Rate limits](rate-limits.md).
