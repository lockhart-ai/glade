REST_FRAMEWORK = {
    "DEFAULT_THROTTLE_CLASSES": ["api.throttles.KeyRateThrottle"],
    "DEFAULT_THROTTLE_RATES": {"key": "120/min", "search": "60/min"},
}
