# Rate limits

Every API key gets 600 requests a minute, and `/search` has a limit of its own: 60 a minute per key.

Over a limit, a request gets a `429` with a `Retry-After` header, in seconds, on every response in a burst.

![Rate limit headers, before and after](img/rate-limit-headers.png)
