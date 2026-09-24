from rest_framework.throttling import SimpleRateThrottle


class KeyRateThrottle(SimpleRateThrottle):
    """Counts each request against the API key that made it, or the client's IP without one."""

    scope = "key"

    def get_cache_key(self, request, view):
        key = request.auth.key if request.auth else self.get_ident(request)
        return self.cache_format % {"scope": self.scope, "ident": key}


class SearchRateThrottle(KeyRateThrottle):
    scope = "search"
