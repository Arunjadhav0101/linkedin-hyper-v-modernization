import time
from typing import Dict, Any


class CircuitBreaker:
    """
    Circuit breaker for external LinkedIn Voyager integration.
    States:
      - CLOSED: Normal operation
      - OPEN: Tripped due to consecutive server/network failures (5xx/timeouts)
      - HALF_OPEN: Testing remote availability after cooldown
    """
    def __init__(self, failure_threshold: int = 5, recovery_time_sec: float = 30.0):
        self.failure_threshold = failure_threshold
        self.recovery_time_sec = recovery_time_sec
        self.failure_count = 0
        self.state = "CLOSED"
        self.last_failure_time = 0.0
        self.next_attempt_time = 0.0

    def is_available(self) -> bool:
        now = time.time()
        if self.state == "OPEN":
            if now >= self.next_attempt_time:
                self.state = "HALF_OPEN"
                return True
            return False
        return True

    def record_success(self):
        self.failure_count = 0
        self.state = "CLOSED"
        self.next_attempt_time = 0.0

    def record_failure(self, exc: Exception):
        """
        Records failure. IMPORTANT: Only 5xx server errors and network/connection errors
        count toward tripping the circuit breaker.
        Client errors (401, 403, 422, validation) NEVER increment failure count.
        """
        # Determine if exc is a client error
        from .voyager import VoyagerApiError, MissingIntegrationError, ValidationError
        if isinstance(exc, (MissingIntegrationError, ValidationError)):
            return

        if isinstance(exc, VoyagerApiError):
            if exc.status_code in (400, 401, 403, 404, 422):
                return

        # It's a server/network error
        self.failure_count += 1
        self.last_failure_time = time.time()

        if self.failure_count >= self.failure_threshold:
            self.state = "OPEN"
            self.next_attempt_time = self.last_failure_time + self.recovery_time_sec

    def to_dict(self) -> Dict[str, Any]:
        return {
            "state": self.state,
            "failureCount": self.failure_count,
            "nextAttemptTime": int(self.next_attempt_time),
        }


# Global circuit breaker instance
circuit_breaker = CircuitBreaker()
