# Rate limits

Every request to the public API counts against the key that made it.
Requests without a key are counted per IP address.

| Endpoint        | Limit          |
|-----------------|----------------|
| /search         | 60 per minute  |
| Everything else | 120 per minute |

## When you hit the limit

The API responds with `429 Too Many Requests` and a
`Retry-After` header: the number of seconds to wait.

```http
HTTP/1.1 429 Too Many Requests
Retry-After: 17
```
